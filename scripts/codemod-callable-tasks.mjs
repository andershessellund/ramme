// ---------------------------------------------------------------------------
// The codemod of D44 (decisions 1, 3 and 4): callable tasks. Dev-only; it
// uses the `typescript` package already installed, and nothing it does is part
// of the published package. Modelled on codemod-generator-bodies.mjs.
//
//   node scripts/codemod-callable-tasks.mjs [--dry] [files…]
//
// Run it on a tree that still has the free `call` and the `Task` methods: it
// type-checks the project with tsconfig.tests.json and reads, for every call,
// the declaration it resolves to. With no files it rewrites src/*.test.ts and
// src/test/*.ts, less src/stage6-pin.test.ts (written in the new form). In each
// file:
//
// - the free `call(t, …args)` (`call` imported, or `ns.call` on a namespace
//   import) becomes `t(…args)` when `t` is a task, and `task(body)(…args)`
//   when it is a body (an inline function, or a reference to one);
// - a task's `t.call(…args)` becomes `t(…args)`, `t.attempt(…args)`
//   `attempt(t(…args))`, and `t.fork(…args)` `fork(t(…args))`;
// - a task's `t.bind(…args)` becomes `t(…args)`, and `t.bind()` `t`, where its result is an element
//   of the array `all`, `race` or `settle` takes (free or as a method), or the
//   argument of `fork`, `attempt` or a pool's `fork`;
// - `typeof t.call` in a type becomes `typeof t`;
// - the file's import of `call` is dropped, and `task`, `fork` and `attempt` are
//   added where a rewrite uses them and the file does not import them.
//
// A `Context`'s own `call`, `fork` and `attempt` (`app.call(t, …)`,
// `pool.fork(t, …)`) are left alone: they stay. What it cannot classify is
// reported, file and line, for a hand fix: `call` or a task method read as a
// value, a `bind` in any other position, a `typeof` of another task method,
// and a rewrite made outside a generator function (a task's call reads the
// slot when it is made, so outside a body it needs a current node).
// ---------------------------------------------------------------------------

import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const named = args.filter((a) => !a.startsWith('--')).map((f) => path.resolve(f));
const SKIP = new Set([path.join(root, 'src', 'stage6-pin.test.ts')]);
const files =
  named.length > 0
    ? named
    : [
        ...readdirSync(path.join(root, 'src'))
          .filter((f) => f.endsWith('.test.ts'))
          .map((f) => path.join(root, 'src', f)),
        ...readdirSync(path.join(root, 'src', 'test'))
          .filter((f) => f.endsWith('.ts'))
          .map((f) => path.join(root, 'src', 'test', f)),
      ].filter((f) => !SKIP.has(f));

const configPath = path.join(root, 'tsconfig.tests.json');
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();

/** ramme's own sources: src/, less the tests and the test helpers. */
function isRammeFile(fileName) {
  const f = path.resolve(fileName);
  return f.startsWith(path.join(root, 'src') + path.sep) && !f.endsWith('.test.ts') && !f.includes(`${path.sep}src${path.sep}test${path.sep}`);
}

function declName(decl) {
  return decl.name !== undefined && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
}

/** The interface or class a method declaration belongs to. */
function containerName(decl) {
  const p = decl.parent;
  return p !== undefined && (ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p)) && p.name !== undefined ? p.name.text : undefined;
}

/** The declaration a call resolves to, if it is ramme's. */
function rammeDeclarationOf(callExpr) {
  const sig = checker.getResolvedSignature(callExpr);
  const decl = sig?.declaration;
  if (decl === undefined || !isRammeFile(decl.getSourceFile().fileName)) return undefined;
  return decl;
}

/** `'free-call'` (ambient.ts `call`), `'task-<m>'` (a `Task`'s `call`/`attempt`/`fork`/`bind`), `'group'` (`all`/`race`/`settle`), `'forker'` (`fork`/`attempt`/a pool's `fork`), or undefined. */
function classify(callExpr) {
  const decl = rammeDeclarationOf(callExpr);
  if (decl === undefined) return undefined;
  const name = declName(decl);
  const container = containerName(decl);
  const file = path.basename(decl.getSourceFile().fileName);
  if (container === 'Task' || container === 'TaskImpl') return ['call', 'attempt', 'fork', 'bind'].includes(name) ? `task-${name}` : undefined;
  if (file === 'ambient.ts' && name === 'call' && ts.isFunctionDeclaration(decl)) return 'free-call';
  if (['all', 'race', 'settle'].includes(name)) return 'group';
  if (name === 'fork' || (name === 'attempt' && file === 'ambient.ts')) return 'forker';
  return undefined;
}

/** Whether a type is a task: it has the `call` of the `Task` interface or of `TaskImpl` (a function's `call` is lib's). */
function isTaskType(type) {
  const types = type.isUnion() ? type.types : [type];
  return types.every((t) => {
    const p = t.getProperty('call');
    return p?.declarations?.some((d) => ['Task', 'TaskImpl'].includes(containerName(d) ?? '')) === true;
  });
}

/** An expression that can be called as it is written: anything else is parenthesised. */
function callable(e, text) {
  const ok =
    ts.isIdentifier(e) ||
    ts.isPropertyAccessExpression(e) ||
    ts.isElementAccessExpression(e) ||
    ts.isCallExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    e.kind === ts.SyntaxKind.ThisKeyword;
  return ok ? text : `(${text})`;
}

function inGenerator(n) {
  for (let p = n.parent; p !== undefined; p = p.parent)
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) || ts.isMethodDeclaration(p))
      return p.asteriskToken !== undefined;
  return false;
}

const report = [];
let changedFiles = 0;
const counts = {};
const count = (k) => (counts[k] = (counts[k] ?? 0) + 1);

for (const file of files) {
  const sf = program.getSourceFile(file);
  if (sf === undefined) {
    console.error(`codemod: ${path.relative(root, file)} is not in the program`);
    continue;
  }
  const text = sf.getFullText();
  const where = (n) => `${path.relative(root, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const note = (n, what) => report.push(`${where(n)}: ${what}`);
  /** The names a rewrite uses: `task` for a body, `fork` and `attempt` for a task's methods. */
  const needs = new Set();
  let changed = 0;

  /** The names this file binds by a value import, and from which module. */
  const imported = new Map();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || s.importClause === undefined || s.importClause.isTypeOnly) continue;
    const nb = s.importClause.namedBindings;
    if (nb !== undefined && ts.isNamedImports(nb))
      for (const e of nb.elements) if (!e.isTypeOnly) imported.set(e.name.text, { decl: s, element: e, module: s.moduleSpecifier.text });
  }

  const argsText = (list, emit) => list.map((a) => emit(a)).join(', ');

  /** A rewrite of `node`, or undefined: built from the children's own rewrites (`emit`), so nested sites compose. */
  function rewrite(node, emit) {
    if (ts.isTypeQueryNode(node) && ts.isQualifiedName(node.exprName) && node.exprName.right.text === 'call') {
      const left = node.exprName.left;
      if (isTaskType(checker.getTypeAtLocation(left))) {
        changed++;
        count('typeof t.call');
        return `typeof ${left.getText(sf)}`;
      }
      return undefined;
    }
    if (!ts.isCallExpression(node)) {
      // `call` or a task method read as a value, not called.
      if (ts.isIdentifier(node) && node.text === 'call' && !ts.isCallExpression(node.parent) && !ts.isImportSpecifier(node.parent)) {
        const sym = checker.getSymbolAtLocation(node);
        const target = sym !== undefined && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
        if (target?.declarations?.some((d) => ts.isFunctionDeclaration(d) && path.basename(d.getSourceFile().fileName) === 'ambient.ts'))
          note(node, 'the free `call` read as a value: rewrite it by hand');
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ['call', 'attempt', 'fork', 'bind'].includes(node.name.text) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
        isTaskType(checker.getTypeAtLocation(node.expression))
      )
        note(node, `a task's \`${node.name.text}\` read as a value: rewrite it by hand`);
      return undefined;
    }
    const kind = classify(node);
    if (kind === undefined) return undefined;
    const callee = node.expression;
    if (kind === 'free-call') {
      const [t, ...rest] = node.arguments;
      if (t === undefined) {
        note(node, '`call()` with no task: rewrite it by hand');
        return undefined;
      }
      changed++;
      if (!inGenerator(node)) note(node, 'a task call made outside a generator function: check that a node is current where it is made');
      if (isTaskType(checker.getTypeAtLocation(t))) {
        count('call(t, …) → t(…)');
        return `${callable(t, emit(t))}(${argsText(rest, emit)})`;
      }
      count('call(body, …) → task(body)(…)');
      const ns = ts.isPropertyAccessExpression(callee) ? `${callee.expression.getText(sf)}.` : '';
      if (ns === '') needs.add('task');
      return `${ns}task(${emit(t)})(${argsText(rest, emit)})`;
    }
    if (!kind.startsWith('task-') || !ts.isPropertyAccessExpression(callee)) return undefined;
    const receiver = callable(callee.expression, emit(callee.expression));
    const made = `${receiver}(${argsText(node.arguments, emit)})`;
    const outside = () => {
      if (!inGenerator(node)) note(node, `a task's \`${callee.name.text}\` rewritten outside a generator function: check that a node is current where it is made`);
    };
    switch (kind) {
      case 'task-call':
        changed++;
        outside();
        count('t.call(…) → t(…)');
        return made;
      case 'task-attempt':
        changed++;
        outside();
        count('t.attempt(…) → attempt(t(…))');
        needs.add('attempt');
        return `attempt(${made})`;
      case 'task-fork':
        changed++;
        outside();
        count('t.fork(…) → fork(t(…))');
        needs.add('fork');
        return `fork(${made})`;
      case 'task-bind': {
        const p = node.parent;
        const inGroup =
          ts.isArrayLiteralExpression(p) && ts.isCallExpression(p.parent) && p.parent.arguments[0] === p && classify(p.parent) === 'group';
        const forked = ts.isCallExpression(p) && p.arguments[0] === node && classify(p) === 'forker';
        if (!inGroup && !forked) {
          note(node, "a task's `bind` that is no element of all/race/settle and no argument of fork/attempt/pool.fork: rewrite it by hand");
          return undefined;
        }
        changed++;
        if (node.arguments.length === 0) {
          count('t.bind() → t');
          return emit(callee.expression); // a task of no arguments is taken as itself
        }
        outside();
        count('t.bind(…) → t(…)');
        return made;
      }
      default:
        return undefined;
    }
  }

  /** `node`'s text with every site in it rewritten. */
  function emit(node) {
    const r = rewrite(node, emit);
    if (r !== undefined) return r;
    let out = '';
    let cursor = node.getStart(sf);
    ts.forEachChild(node, (child) => {
      const start = child.getStart(sf);
      if (start < cursor) return;
      out += text.slice(cursor, start) + emit(child);
      cursor = child.getEnd();
    });
    return out + text.slice(cursor, node.getEnd());
  }

  let out = text.slice(0, sf.getStart(sf));
  {
    let cursor = sf.getStart(sf);
    for (const s of sf.statements) {
      const start = s.getStart(sf);
      out += text.slice(cursor, start) + emit(s);
      cursor = s.getEnd();
    }
    out += text.slice(cursor);
  }
  if (changed === 0) continue;

  // Imports: drop `call` (no longer exported), add what the rewrites use. Each changed declaration is rebuilt once,
  // its names in their order (a name added in front of the first one after it), on one line or one name per line as
  // it was; no rewrite touches an import, so its text is found as it was.
  const lists = new Map(); // import declaration → its names
  const namesOf = (decl) => lists.get(decl) ?? decl.importClause.namedBindings.elements.map((e) => e.getText(sf));
  const callImport = imported.get('call');
  if (callImport !== undefined && ['./ambient.js', './index.js', '../index.js', '../ambient.js', 'ramme'].includes(callImport.module))
    lists.set(callImport.decl, namesOf(callImport.decl).filter((n) => n !== 'call'));
  const add = [...needs].filter((n) => !imported.has(n));
  const dir = path.relative(path.dirname(file), path.join(root, 'src')) || '.';
  const rel = (m) => `${dir === '.' ? '.' : dir}/${m}`;
  const fresh = [];
  for (const name of add) {
    const module = name === 'task' ? 'fiber.js' : 'ambient.js';
    const target = sf.statements.find(
      (s) =>
        ts.isImportDeclaration(s) &&
        s.importClause !== undefined &&
        !s.importClause.isTypeOnly &&
        s.importClause.namedBindings !== undefined &&
        ts.isNamedImports(s.importClause.namedBindings) &&
        [rel(module), rel('index.js'), 'ramme'].includes(s.moduleSpecifier.text),
    );
    if (target === undefined) {
      fresh.push(`import { ${name} } from '${rel(module)}';`);
      continue;
    }
    const names = [...namesOf(target)];
    const at = names.findIndex((n) => n > name);
    names.splice(at < 0 ? names.length : at, 0, name);
    lists.set(target, names);
  }
  let result = out;
  for (const [decl, names] of lists) {
    const before = decl.getText(sf);
    const multiline = before.includes('\n');
    const rebuilt =
      names.length === 0
        ? ''
        : multiline
          ? `import {\n  ${names.join(',\n  ')},\n} from '${decl.moduleSpecifier.text}';`
          : `import { ${names.join(', ')} } from '${decl.moduleSpecifier.text}';`;
    if (!result.includes(before)) {
      note(decl, 'an import the codemod could not rewrite: fix it by hand');
      continue;
    }
    result = rebuilt === '' ? result.replace(`${before}\n`, '') : result.replace(before, rebuilt);
  }
  if (fresh.length > 0) {
    const lastImport = sf.statements.filter((s) => ts.isImportDeclaration(s)).at(-1);
    if (lastImport === undefined) result = `${fresh.join('\n')}\n${result}`;
    else {
      const t = lists.has(lastImport) ? null : lastImport.getText(sf);
      if (t === null || !result.includes(t)) note(lastImport, `add ${fresh.join(' ')} by hand`);
      else result = result.replace(t, `${t}\n${fresh.join('\n')}`);
    }
  }

  if (result !== text) {
    changedFiles++;
    if (!dry) writeFileSync(file, result);
    console.log(`codemod: ${path.relative(root, file)}: ${changed} site(s) rewritten${add.length > 0 ? `; imports ${add.join(', ')}` : ''}`);
  }
}

console.log(`\ncodemod: rewrites: ${Object.entries(counts).map(([k, v]) => `${k} ×${v}`).join('; ') || 'none'}`);
if (report.length > 0) {
  console.log(`\ncodemod: ${report.length} case(s) to check or fix by hand:`);
  for (const r of report) console.log(`  ${r}`);
}
console.log(`\ncodemod: ${changedFiles} file(s) ${dry ? 'would change' : 'changed'}`);
