// ---------------------------------------------------------------------------
// The codemod of D41 (decision 5): async bodies to generator bodies.
// Dev-only; it uses the `typescript` package already installed, and nothing
// it does is part of the published package.
//
//   node scripts/codemod-generator-bodies.mjs [--dry] [files…]
//
// With no files it rewrites src/*.test.ts. It type-checks the project with
// tsconfig.tests.json and, in each file:
//
// - rewrites an `async` function in a body position to a `function*`: the
//   first argument of `task`, `fork`, `call`, `attempt`, `shield`, `unshield`
//   and `promised`, free or as a method of a node or a pool (a Task's own
//   `call`/`attempt`/`fork`, whose arguments are the task's, are left alone),
//   inline or by a reference to a function declared in the same file, and the
//   matching argument of a helper declared in the file that hands one of its
//   parameters on to a body position (`const request = (body) => task(body, …)`);
// - rewrites an `async` release (`own(x, async …)`, `own(async …)`) and an
//   `async` failure handler (`onFailure: async …`) the same way when it uses
//   ramme (an `async` one that only waits for foreign promises stays a bare
//   wait, which a release or handler may be);
// - inside each rewritten function, `await x` becomes `yield* x` when `x` is a
//   ramme op or a generator, and `yield* wait(x)` for any other value (a
//   foreign promise), parenthesised where `yield*`'s precedence needs it; an
//   expression-bodied arrow gets a block with a `return`; and a returned
//   thenable, which an async function's return adopted and a generator's
//   return would hand on as a value, is yielded the same way
//   (`return call(t)` → `return yield* call(t)`);
// - a synchronous arrow in a body position whose expression is a foreign
//   promise (`() => gate.promise`), which is no body either, becomes
//   `function* () { return yield* wait(gate.promise); }`;
// - `managed(p)` and `ctx.managed(p)` become `wait(p, { abandon: true })`;
// - `wait` is added to the file's ramme import when it is used and missing,
//   and `managed` is dropped from it.
//
// What it cannot do is reported, file and line, for a hand fix: `this` or
// `arguments` in a rewritten arrow, `for await`, `await using`, `Promise`
// combinators and `.catch`/`.finally` on an op inside a rewritten body, and an
// `async` function in a body position it could not resolve.
// ---------------------------------------------------------------------------

import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const named = args.filter((a) => !a.startsWith('--')).map((f) => path.resolve(f));
const files =
  named.length > 0
    ? named
    : readdirSync(path.join(root, 'src'))
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => path.join(root, 'src', f));

const configPath = path.join(root, 'tsconfig.tests.json');
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();

/** The verbs whose first argument is a body. */
const BODY_VERBS = new Set(['task', 'fork', 'call', 'attempt', 'shield', 'unshield', 'promised']);
/** ramme's own sources: src/, less the tests and the test helpers. */
function isRammeFile(fileName) {
  const f = path.resolve(fileName);
  return f.startsWith(path.join(root, 'src') + path.sep) && !f.endsWith('.test.ts') && !f.includes(`${path.sep}src${path.sep}test${path.sep}`);
}

/** The declaration a call resolves to, if it is ramme's. */
function rammeDeclarationOf(callExpr) {
  const sig = checker.getResolvedSignature(callExpr);
  const decl = sig?.declaration;
  if (decl === undefined || !isRammeFile(decl.getSourceFile().fileName)) return undefined;
  return decl;
}

function declName(decl) {
  return decl.name !== undefined && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
}

/** The interface or class a method declaration belongs to. */
function containerName(decl) {
  const p = decl.parent;
  return p !== undefined && (ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p)) && p.name !== undefined ? p.name.text : undefined;
}

/** A body-taking verb: not a Task's own `call`/`attempt`/`fork`, whose arguments are the task's. */
function isBodyVerb(decl) {
  const name = declName(decl);
  if (name === undefined || !BODY_VERBS.has(name)) return false;
  const c = containerName(decl);
  return c !== 'Task' && c !== 'TaskImpl';
}

function isFunctionLike(n) {
  return n !== undefined && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n));
}

function isAsync(fn) {
  return (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async) !== 0 || fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

/** Resolve an identifier argument to a function declared in this file. */
function functionOfIdentifier(id, sf) {
  let sym = checker.getSymbolAtLocation(id);
  if (sym === undefined) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  for (const d of sym.declarations ?? []) {
    if (d.getSourceFile() !== sf) continue;
    if (ts.isFunctionDeclaration(d)) return d;
    if (ts.isVariableDeclaration(d) && d.initializer !== undefined && isFunctionLike(d.initializer)) return d.initializer;
  }
  return undefined;
}

/** A type that is a ramme op (`Op<T>`, a managed promise) or a generator: what `yield*` runs. */
function isYieldable(type) {
  const types = type.isUnion() ? type.types : [type];
  return types.every((t) => {
    const name = t.aliasSymbol?.name ?? t.symbol?.name;
    return name === 'Op' || name === 'ManagedPromise' || name === 'Generator' || name === 'Operation';
  });
}

/** Whether `fn`'s own code (not nested functions) calls ramme or awaits a ramme op. */
function usesRamme(fn) {
  let uses = false;
  const visit = (n) => {
    if (uses) return;
    if (n !== fn && isFunctionLike(n)) return;
    if (ts.isCallExpression(n) && rammeDeclarationOf(n) !== undefined) {
      uses = true;
      return;
    }
    if (ts.isAwaitExpression(n) && isYieldable(checker.getTypeAtLocation(n.expression))) {
      uses = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return uses;
}

/** A synchronous arrow whose expression body is a foreign promise (not a ramme op): a body that is a type error now. */
function returnsForeignPromise(fn) {
  if (!ts.isArrowFunction(fn) || isAsync(fn) || ts.isBlock(fn.body)) return false;
  const t = checker.getTypeAtLocation(fn.body);
  const name = t.aliasSymbol?.name ?? t.symbol?.name;
  return name === 'Promise';
}

/** Parents under which `yield* x` may replace `await x` without parentheses. */
function safeForYield(awaitNode) {
  const p = awaitNode.parent;
  switch (p.kind) {
    case ts.SyntaxKind.ExpressionStatement:
    case ts.SyntaxKind.ReturnStatement:
    case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.TemplateSpan:
    case ts.SyntaxKind.SpreadElement:
      return true;
    case ts.SyntaxKind.VariableDeclaration:
      return p.initializer === awaitNode;
    case ts.SyntaxKind.CallExpression:
    case ts.SyntaxKind.NewExpression:
      return p.arguments?.includes(awaitNode) === true;
    case ts.SyntaxKind.BinaryExpression:
      return p.right === awaitNode && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    case ts.SyntaxKind.ConditionalExpression:
      return p.whenTrue === awaitNode || p.whenFalse === awaitNode;
    case ts.SyntaxKind.ArrowFunction:
      return false; // an expression body becomes a block with a return, where it is safe; handled by the caller
    default:
      return false;
  }
}

const report = [];
let changedFiles = 0;

for (const file of files) {
  const sf = program.getSourceFile(file);
  if (sf === undefined) {
    console.error(`codemod: ${path.relative(root, file)} is not in the program`);
    continue;
  }
  const text = sf.getFullText();
  /** { pos, end, text, depth } edits, applied from the end. */
  const edits = [];
  const toConvert = new Map(); // fn → 'body' | 'release' | 'handler'
  const promiseArrows = new Set(); // () => p in a body position
  const where = (n) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return `${path.relative(root, file)}:${line + 1}`;
  };
  const note = (n, what) => report.push(`${where(n)}: ${what}`);
  const depthOf = (n) => {
    let d = 0;
    for (let c = n; c !== undefined; c = c.parent) d++;
    return d;
  };

  // 0. Helpers of this file that hand a parameter on to a body position: symbol → the parameter indexes, to a fixpoint.
  const forwards = new Map();
  const paramIndexOf = (fnNode, arg) => {
    if (!ts.isIdentifier(arg)) return -1;
    const sym = checker.getSymbolAtLocation(arg);
    return fnNode.parameters.findIndex((p) => ts.isIdentifier(p.name) && checker.getSymbolAtLocation(p.name) === sym);
  };
  const helperSymbolOf = (fnNode) => {
    const nameNode = ts.isFunctionDeclaration(fnNode) ? fnNode.name : ts.isVariableDeclaration(fnNode.parent) ? fnNode.parent.name : undefined;
    return nameNode !== undefined && ts.isIdentifier(nameNode) ? checker.getSymbolAtLocation(nameNode) : undefined;
  };
  const bodyArgIndex = (call) => {
    const decl = rammeDeclarationOf(call);
    if (decl !== undefined) return isBodyVerb(decl) ? [0] : [];
    let sym = ts.isIdentifier(call.expression) ? checker.getSymbolAtLocation(call.expression) : undefined;
    if (sym !== undefined && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym !== undefined ? [...(forwards.get(sym) ?? [])] : [];
  };
  for (let changed = true; changed; ) {
    changed = false;
    const scanHelpers = (n) => {
      if (isFunctionLike(n) && n.parameters.length > 0) {
        const sym = helperSymbolOf(n);
        if (sym !== undefined) {
          const visit = (m) => {
            if (m !== n && isFunctionLike(m)) return;
            if (ts.isCallExpression(m))
              for (const i of bodyArgIndex(m)) {
                const pi = paramIndexOf(n, m.arguments[i]);
                if (pi < 0) continue;
                const set = forwards.get(sym) ?? new Set();
                if (!set.has(pi)) {
                  set.add(pi);
                  forwards.set(sym, set);
                  changed = true;
                }
              }
            ts.forEachChild(m, visit);
          };
          if (n.body !== undefined) visit(n.body);
        }
      }
      ts.forEachChild(n, scanHelpers);
    };
    scanHelpers(sf);
  }

  // 1. Find the functions to rewrite.
  const findTargets = (n) => {
    if (ts.isCallExpression(n) && rammeDeclarationOf(n) === undefined)
      for (const i of bodyArgIndex(n)) {
        const a = n.arguments[i];
        if (isFunctionLike(a) && isAsync(a) && !a.asteriskToken) toConvert.set(a, 'body');
        else if (isFunctionLike(a) && returnsForeignPromise(a)) promiseArrows.add(a);
      }
    if (ts.isCallExpression(n)) {
      const decl = rammeDeclarationOf(n);
      if (decl !== undefined) {
        const name = declName(decl);
        if (isBodyVerb(decl) && n.arguments.length > 0) {
          const a = n.arguments[0];
          const fn = isFunctionLike(a) ? a : ts.isIdentifier(a) ? functionOfIdentifier(a, sf) : undefined;
          if (fn !== undefined && isAsync(fn) && !fn.asteriskToken) toConvert.set(fn, 'body');
          else if (fn !== undefined && returnsForeignPromise(fn)) promiseArrows.add(fn);
          else if (fn === undefined && ts.isIdentifier(a)) {
            const t = checker.getTypeAtLocation(a);
            const sigs = t.getCallSignatures();
            if (sigs.some((s) => (checker.typeToString(s.getReturnType()) ?? '').startsWith('Promise<')))
              note(a, `an async function by reference in a body position (${a.text}): rewrite it by hand`);
          }
        }
        if (name === 'own') {
          const fn = n.arguments.length === 2 ? n.arguments[1] : n.arguments[0];
          if (isFunctionLike(fn) && isAsync(fn) && !fn.asteriskToken && usesRamme(fn)) toConvert.set(fn, 'release');
        }
        if (name === 'managed') {
          // managed(p) → wait(p, { abandon: true }); ctx.managed(p) → ctx.wait(p, { abandon: true })
          const callee = n.expression;
          const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
          edits.push({ pos: nameNode.getStart(sf), end: nameNode.getEnd(), text: 'wait', depth: depthOf(n) });
          const last = n.arguments[n.arguments.length - 1];
          if (last !== undefined) edits.push({ pos: last.getEnd(), end: last.getEnd(), text: ', { abandon: true }', depth: depthOf(n), close: true });
        }
      }
    }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'onFailure') {
      const fn = n.initializer;
      if (isFunctionLike(fn) && isAsync(fn) && !fn.asteriskToken && usesRamme(fn)) toConvert.set(fn, 'handler');
    }
    ts.forEachChild(n, findTargets);
  };
  findTargets(sf);

  // 2. Rewrite each function and its awaits.
  let usesWait = false;
  for (const fn of promiseArrows) {
    // () => p  →  function* () { return yield* wait(p); }
    const tp = fn.typeParameters ? `<${fn.typeParameters.map((p) => p.getText(sf)).join(', ')}>` : '';
    const params = fn.parameters.map((p) => p.getText(sf)).join(', ');
    edits.push({ pos: fn.getStart(sf), end: fn.body.getStart(sf), text: `function* ${tp}(${params}) { return yield* wait(`, depth: depthOf(fn) });
    edits.push({ pos: fn.body.getEnd(), end: fn.body.getEnd(), text: '); }', depth: depthOf(fn), close: true });
    usesWait = true;
  }
  for (const fn of toConvert.keys()) {
    const asyncMod = fn.modifiers?.find((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const d = depthOf(fn);
    if (ts.isArrowFunction(fn)) {
      // async <T>(a): R => body  →  function* <T>(a) body
      const tp = fn.typeParameters ? `<${fn.typeParameters.map((p) => p.getText(sf)).join(', ')}>` : '';
      const params = fn.parameters.map((p) => p.getText(sf)).join(', ');
      const head = `function* ${tp}(${params}) `;
      const bodyStart = fn.body.getStart(sf);
      edits.push({ pos: fn.getStart(sf), end: bodyStart, text: head, depth: d });
      if (!ts.isBlock(fn.body)) {
        edits.push({ pos: bodyStart, end: bodyStart, text: '{ return ', depth: d });
        edits.push({ pos: fn.body.getEnd(), end: fn.body.getEnd(), text: '; }', depth: d, close: true });
      }
      // `this` and `arguments` bind differently in a function*
      const scan = (n) => {
        if (n !== fn && isFunctionLike(n) && !ts.isArrowFunction(n)) return;
        if (n.kind === ts.SyntaxKind.ThisKeyword) note(n, '`this` in an arrow rewritten as function*: use a generator method or .bind(this)');
        if (ts.isIdentifier(n) && n.text === 'arguments') note(n, '`arguments` in an arrow rewritten as function*');
        ts.forEachChild(n, scan);
      };
      scan(fn.body);
    } else {
      // async function name(…): R { … }  →  function* name(…) { … }
      const fnKeyword = fn.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
      edits.push({ pos: asyncMod.getStart(sf), end: fnKeyword.getEnd(), text: 'function*', depth: d });
      if (fn.type !== undefined) {
        const close = fn.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.CloseParenToken);
        edits.push({ pos: close.getEnd(), end: fn.type.getEnd(), text: '', depth: d });
      }
    }
    if (ts.isArrowFunction(fn) && fn.type !== undefined) {
      // the return type annotation goes with the head (it lies between the parameters and `=>`)
    }
    const visit = (n) => {
      if (n !== fn && isFunctionLike(n)) return; // nested functions are their own targets, or stay as they are
      if (ts.isForOfStatement(n) && n.awaitModifier !== undefined) note(n, '`for await` in a rewritten body: rewrite it by hand');
      if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing)
        note(n, '`await using` in a rewritten body: use own(…)');
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const obj = n.expression.expression;
        const m = n.expression.name.text;
        if (ts.isIdentifier(obj) && obj.text === 'Promise' && ['all', 'race', 'allSettled', 'any'].includes(m))
          note(n, `Promise.${m} in a rewritten body: use all/race/settle, or wait(Promise.${m}(…)) of foreign promises`);
        if ((m === 'catch' || m === 'finally') && isYieldable(checker.getTypeAtLocation(obj)))
          note(n, `.${m} on an op in a rewritten body: use try/catch around yield*, or attempt`);
      }
      const returned = ts.isReturnStatement(n) ? n.expression : n === fn.body && !ts.isBlock(n) ? n : undefined;
      if (returned !== undefined && !ts.isAwaitExpression(returned)) {
        const t = checker.getTypeAtLocation(returned);
        const yieldable = isYieldable(t);
        const promise = (t.isUnion() ? t.types : [t]).some((x) => (x.aliasSymbol?.name ?? x.symbol?.name) === 'Promise');
        if (yieldable || promise) {
          if (!yieldable) usesWait = true;
          edits.push({ pos: returned.getStart(sf), end: returned.getStart(sf), text: yieldable ? 'yield* ' : 'yield* wait(', depth: depthOf(returned) + 1 });
          if (!yieldable) edits.push({ pos: returned.getEnd(), end: returned.getEnd(), text: ')', depth: depthOf(returned) + 1, close: true });
        }
      }
      if (ts.isAwaitExpression(n)) {
        const operand = n.expression;
        const yieldable = isYieldable(checker.getTypeAtLocation(operand));
        const paren = !safeForYield(n) && !(ts.isArrowFunction(n.parent) && n.parent.body === n);
        const open = `${paren ? '(' : ''}yield* ${yieldable ? '' : 'wait('}`;
        if (!yieldable) usesWait = true;
        edits.push({ pos: n.getStart(sf), end: operand.getStart(sf), text: open, depth: depthOf(n) });
        const close = `${yieldable ? '' : ')'}${paren ? ')' : ''}`;
        if (close !== '') edits.push({ pos: n.getEnd(), end: n.getEnd(), text: close, depth: depthOf(n), close: true });
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
  }

  // 3. Imports: add `wait` where it is now used, drop `managed`.
  const managedCalls = edits.some((e) => e.text === 'wait');
  if (usesWait || managedCalls) {
    const imports = sf.statements.filter(
      (s) =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        ['./ambient.js', './index.js'].includes(s.moduleSpecifier.text) &&
        s.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(s.importClause.namedBindings) &&
        !s.importClause.isTypeOnly,
    );
    const has = imports.some((s) => s.importClause.namedBindings.elements.some((e) => e.name.text === 'wait'));
    const target = imports[0];
    if (!has) {
      if (target !== undefined) {
        // in name order, on a line of its own when the list is one name per line
        const els = [...target.importClause.namedBindings.elements];
        const multiline = text.slice(els[0].getStart(sf), els[els.length - 1].getEnd()).includes('\n');
        const before = els.find((e) => e.name.text.localeCompare('wait') > 0);
        if (before !== undefined) {
          const at = before.getStart(sf);
          edits.push({ pos: at, end: at, text: multiline ? 'wait,\n  ' : 'wait, ', depth: 0 });
        } else {
          const last = els[els.length - 1];
          edits.push({ pos: last.getEnd(), end: last.getEnd(), text: multiline ? ',\n  wait' : ', wait', depth: 0 });
        }
      } else {
        const lastImport = sf.statements.filter((s) => ts.isImportDeclaration(s)).at(-1);
        const at = lastImport !== undefined ? lastImport.getEnd() : 0;
        edits.push({ pos: at, end: at, text: lastImport !== undefined ? "\nimport { wait } from './ambient.js';" : "import { wait } from './ambient.js';\n", depth: 0 });
      }
    }
  }
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || s.importClause?.namedBindings === undefined || !ts.isNamedImports(s.importClause.namedBindings)) continue;
    for (const e of s.importClause.namedBindings.elements) {
      if (e.name.text !== 'managed' || !managedCalls) continue;
      // drop `managed` and its separator
      const end = text.slice(e.getEnd()).match(/^\s*,\s*/)?.[0].length ?? 0;
      edits.push({ pos: e.getStart(sf), end: e.getEnd() + end, text: '', depth: 0 });
    }
  }

  if (edits.length === 0) continue;
  // Apply from the end; an edit applied later at the same position lands in front of one applied earlier. At one
  // position: replacements first (an insertion lands in front of one); then openers, inner first, so the outer one's
  // text comes first (`{ return yield* …`); then closers, outer first, so the inner one's comes first (`wait(x)` then
  // `; }`), and every closer in front of every opener.
  const rank = (e) => (e.end > e.pos ? 0 : e.close ? 2 : 1);
  edits.sort(
    (a, b) => b.pos - a.pos || rank(a) - rank(b) || (rank(a) === 1 ? b.depth - a.depth : a.depth - b.depth),
  );
  let out = text;
  let lastPos = Infinity;
  for (const e of edits) {
    if (e.end > lastPos) {
      note({ getStart: () => e.pos }, `overlapping edits at ${e.pos}: check by hand`);
    }
    out = out.slice(0, e.pos) + e.text + out.slice(e.end);
    lastPos = e.pos;
  }
  if (out !== text) {
    changedFiles++;
    if (!dry) writeFileSync(file, out);
    console.log(`codemod: ${path.relative(root, file)}: ${toConvert.size} function(s) rewritten`);
  }
}

if (report.length > 0) {
  console.log(`\ncodemod: ${report.length} case(s) to fix by hand:`);
  for (const r of report) console.log(`  ${r}`);
}
console.log(`\ncodemod: ${changedFiles} file(s) ${dry ? 'would change' : 'changed'}`);
