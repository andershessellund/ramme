// ---------------------------------------------------------------------------
// The documents check, half two: every TypeScript block of README.md and
// DESIGN.md type-checks against the build output. Run by `pnpm check:docs`,
// after `pnpm build`. Dev-only.
//
// Each ```ts (or ```typescript) block becomes one module of a consumer outside
// the package, as scripts/check-surface.mjs builds one: a temporary directory
// whose node_modules/ramme links to this repository, so `ramme`,
// `ramme/result` and `ramme/platform` resolve through package.json "exports"
// to dist/. The consumer's compiler options are check-surface's (ES2022,
// NodeNext, the DOM library, strict). The directory is removed afterwards
// (`--keep` keeps it and prints its path).
//
// A document's examples assume the reader's own code, so a name a block uses
// and nobody declares (a `db`, a `server`, a class an earlier block defined)
// is declared for it: from `ENVIRONMENT` when that has it, else as `any`, both
// as a value and as a type. A stand-in `any` has no types to give, so a
// callback passed to it has untyped parameters, which are not reported; and
// ramme's generics infer `unknown` from it (`yield* wait(db.query())`,
// `lookup(Config)`), so a block whose example needs the value typed needs an
// `ENVIRONMENT` entry. Never declared: a name the three entry points export,
// the names D36, D41 and D42 retired (`RETIRED`), and a misspelling of a ramme
// name the block has, which stay errors. A
// block with no import at all is a fragment: the ramme names it uses are
// imported for it, before a global of the same name (`fetch`). A block that
// imports anything is complete, and must import every ramme name it uses. A
// block that yields or returns at its top level is a body fragment, checked
// as the body of a generator function. Nothing else is rewritten: an elided
// `{ … }` is a syntax error; write `{ /* … */ }`.
//
// Exits 1 with each failing block and its errors, at their lines in the
// document. `--verbose` also lists what each block was given.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const keep = process.argv.includes('--keep');
const verbose = process.argv.includes('--verbose');

/** The documents whose TypeScript blocks are checked. */
const DOCUMENTS = ['README.md', 'DESIGN.md'];
/** The package's entry points, in the order an unimported name is looked up. */
const ENTRIES = ['ramme', 'ramme/platform', 'ramme/result'];
/** Names ramme exported once and no longer does: never declared for a block. */
const RETIRED = new Map([
  ['managed', 'retired by D41: `yield* wait(p)`'],
  ['InterruptedError', 'retired by D41: an interruption halts the body'],
  ['UnawaitedCallError', 'retired by D41: work ops are lazy'],
  ['registerContextStorage', 'retired by D41: ramme has no async context'],
  ['ContextStorage', 'retired by D41: ramme has no async context'],
  ['Frame', 'retired by D41: ramme has no async context'],
  ['gen', 'retired by D42: `yield* fail(e)`, and `$` from ramme/result'],
  ['ProviderOptions', 'retired by D36'],
]);
/**
 * The reader's own code that an example needs typed: name → its declaration, used in place of a stand-in `any`. A
 * declaration may name other undeclared names, which are declared in turn. One declaration per name serves every
 * block, so the examples share one database (`db`) and its types.
 */
const ENVIRONMENT = new Map([
  // README's services: a configuration class.
  ['Config', 'declare class Config { readonly apiUrl: string; }'],
  // The examples' database: a connection to own, a transaction to commit or roll back, a driver's transaction
  // callback, and the rows of the expected-failure examples.
  [
    'db',
    'declare const db: { connect(): Promise<Connection>; begin(): Promise<Transaction>; ' +
      'transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>; ' +
      'findUser(id: string): Promise<User | undefined>; findOrder(user: User): Promise<Order | undefined> };',
  ],
  ['Connection', 'interface Connection { query(sql: string, signal?: AbortSignal): Promise<unknown>; release(): void; }'],
  ['Transaction', 'interface Transaction { commit(): Promise<void>; rollback(): Promise<void>; }'],
  // The unit of work's pool (README; DESIGN.md §2.6), which hands out a lease synchronously, and README's request's
  // pool, which hands one out asynchronously.
  ['DbPool', 'declare class DbPool { acquire(owner?: unknown): { readonly conn: Connection }; }'],
  ['Connections', 'declare class Connections { acquire(): Promise<AsyncDisposable & { readonly conn: Connection }>; }'],
  // README's `$`: a gateway whose authorization is a `Result`, written out (a ramme name is never declared here).
  [
    'gateway',
    "declare const gateway: { authorize(card: Card, amount: number): Promise<{ status: 'success'; value: Auth } | " +
      "{ status: 'failure'; error: Declined }>; capture(auth: Auth): Promise<Receipt> };",
  ],
  // README's driver adapter: node-postgres's pool and client, and the reader's own transaction helper.
  [
    'pg',
    'declare namespace pg { interface PoolClient { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>; ' +
      'release(): void; } class Pool { constructor(config?: unknown); query(sql: string, params?: unknown[]): ' +
      'Promise<{ rows: unknown[] }>; connect(): Promise<PoolClient>; end(): Promise<void>; } }',
  ],
  ['withTx', 'declare function withTx<T>(client: pg.PoolClient, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T>;'],
]);
/** The diagnostics that name an identifier nothing declares. */
const UNRESOLVED = new Set([2304, 2552, 2580, 2581, 2582, 2583, 2584, 2591, 2592, 2593]);
/** The function a body fragment is checked inside, opened on the block's first line so lines keep their numbers. */
const WRAPPER = 'function* __docBlock() { ';

if (!existsSync(join(root, 'dist', 'index.d.ts'))) {
  console.error('check-doc-blocks: dist/index.d.ts is missing; run `pnpm build` first');
  process.exit(1);
}

// --- the blocks -------------------------------------------------------------

/** The TypeScript blocks of a Markdown document: { doc, line (of the block's first code line), code }. */
function extract(doc) {
  const out = [];
  let open = null;
  for (const [n, raw] of readFileSync(join(root, doc), 'utf8').split('\n').entries()) {
    if (open === null) {
      const f = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(raw);
      if (f !== null) open = { fence: f[1], lang: f[2].toLowerCase(), line: n + 2, lines: [] };
    } else if (raw.trim().startsWith(open.fence) && raw.trim().replace(/[`~]/g, '') === '') {
      if (['ts', 'typescript', 'mts', 'cts'].includes(open.lang)) out.push({ doc, line: open.line, code: open.lines.join('\n') });
      open = null;
    } else open.lines.push(raw);
  }
  return out;
}

const blocks = DOCUMENTS.flatMap(extract).map((b, i) => {
  const sf = ts.createSourceFile('block.ts', b.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = sf.statements.filter((s) => ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s));
  // The block with its imports blanked (newlines kept), parsed inside a generator to find a top-level yield or return.
  let blanked = b.code;
  for (const s of imports) {
    const [a, z] = [s.getStart(sf), s.getEnd()];
    blanked = blanked.slice(0, a) + blanked.slice(a, z).replace(/[^\n]/g, ' ') + blanked.slice(z);
  }
  const wrapped = ts.createSourceFile('wrapped.ts', `${WRAPPER}${blanked}\n}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wrapper = wrapped.statements[0];
  let body = false;
  const visit = (node) => {
    if (ts.isYieldExpression(node) || ts.isReturnStatement(node)) {
      let p = node.parent;
      while (p !== undefined && !ts.isFunctionLike(p)) p = p.parent;
      if (p === wrapper) body = true;
    }
    if (!body) ts.forEachChild(node, visit);
  };
  visit(wrapper);
  return {
    ...b,
    file: `${b.doc.replace(/\W/g, '-')}-${b.line}.ts`,
    index: i,
    fragment: imports.length === 0,
    body,
    blanked,
    importText: imports.map((s) => s.getText(sf)),
    // The names the block itself imports from the package.
    imported: new Set(
      imports.flatMap((s) =>
        ts.isImportDeclaration(s) && ENTRIES.includes(s.moduleSpecifier.text) && s.importClause?.namedBindings !== undefined && ts.isNamedImports(s.importClause.namedBindings)
          ? s.importClause.namedBindings.elements.map((e) => e.name.text)
          : [],
      ),
    ),
    implicit: new Map(),
    typed: new Set(),
    declared: new Set(),
  };
});

/** A block's module: the block (inside the wrapper when it is a body fragment), then what it was given. */
function source(b) {
  const parts = b.body ? [`${WRAPPER}${b.blanked}`, '}', ...b.importText] : [b.code];
  for (const [entry, names] of b.implicit) parts.push(`import { ${[...names].join(', ')} } from '${entry}';`);
  for (const name of b.typed) parts.push(ENVIRONMENT.get(name));
  for (const name of b.declared) parts.push(`declare var ${name}: any; type ${name}<A = any, B = any, C = any, D = any> = any;`);
  parts.push('export {};', '');
  return parts.join('\n');
}

/** Whether an identifier is a reference to a binding, not a property, a member or a declaration's own name. */
function isReference(id) {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) return (p.expression ?? p.left) === id;
  return p.name !== id;
}

/** The identifier a call's callee is rooted at (`server` in `server.on(…)`), or null. */
function calleeRoot(call) {
  let e = call.expression;
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : null;
}

/** Whether a diagnostic is an untyped parameter of a callback passed to a stand-in `any` (`server.on(…, (req) => …)`). */
function untypedByStandIn(d, sf, b) {
  if (d.code !== 7006 && d.code !== 7031) return false;
  let found = null;
  const find = (node) => {
    if (found === null && ts.isParameter(node) && node.name.getStart(sf) === d.start) found = node;
    else if (found === null && node.pos <= d.start && d.start < node.end) ts.forEachChild(node, find);
  };
  find(sf);
  const fn = found?.parent;
  const call = fn?.parent;
  return call !== undefined && ts.isCallExpression(call) && call.arguments.includes(fn) && b.declared.has(calleeRoot(call));
}

// --- the consumer -----------------------------------------------------------

const consumer = mkdtempSync(join(tmpdir(), 'ramme-doc-blocks-'));
const failed = [];
try {
  mkdirSync(join(consumer, 'node_modules'));
  symlinkSync(root, join(consumer, 'node_modules', 'ramme'), 'dir');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'doc-blocks-consumer', private: true, type: 'module' }));
  const config = ts.parseJsonConfigFileContent(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2024', 'ESNext.Disposable', 'DOM'],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      files: [],
    },
    ts.sys,
    consumer,
  );
  const options = config.options;

  // What the entry points export, read from the build through the consumer's own resolution.
  writeFileSync(join(consumer, 'exports.ts'), ENTRIES.map((e, i) => `import * as e${i} from '${e}';`).join('\n') + '\nexport {};\n');
  const probe = ts.createProgram([join(consumer, 'exports.ts')], options);
  const checker = probe.getTypeChecker();
  const exported = new Map();
  for (const st of probe.getSourceFile(join(consumer, 'exports.ts')).statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const entry = st.moduleSpecifier.text;
    const symbol = checker.getSymbolAtLocation(st.moduleSpecifier);
    if (symbol === undefined) throw new Error(`check-doc-blocks: '${entry}' does not resolve from a consumer`);
    for (const e of checker.getExportsOfModule(symbol)) if (!exported.has(e.name)) exported.set(e.name, entry);
  }

  /** Writes every block, compiles them together, and returns the program and each block's diagnostics. */
  const compile = () => {
    for (const b of blocks) writeFileSync(join(consumer, b.file), source(b));
    const program = ts.createProgram(
      blocks.map((b) => join(consumer, b.file)),
      options,
    );
    const global = program.getGlobalDiagnostics().concat(program.getOptionsDiagnostics());
    if (global.length > 0) throw new Error(ts.formatDiagnostics(global, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => consumer, getNewLine: () => '\n' }));
    return {
      program,
      results: blocks.map((b) => {
        const sf = program.getSourceFile(join(consumer, b.file));
        return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => ({ d, sf }));
      }),
    };
  };

  /** Imports `name` from its entry point for a fragment; false when it already was. */
  const give = (b, name) => {
    const entry = exported.get(name);
    if (!b.implicit.has(entry)) b.implicit.set(entry, new Set());
    if (b.implicit.get(entry).has(name)) return false;
    b.implicit.get(entry).add(name);
    return true;
  };

  let { program, results } = compile();
  for (let round = 0; round < 5; round++) {
    let changed = false;
    const checker = program.getTypeChecker();
    for (const [i, diagnostics] of results.entries()) {
      const b = blocks[i];
      for (const { d, sf } of diagnostics) {
        if (!UNRESOLVED.has(d.code) || d.start === undefined) continue;
        const name = sf.text.slice(d.start, d.start + d.length);
        if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name) || RETIRED.has(name) || b.declared.has(name) || b.typed.has(name)) continue;
        // A misspelling of a ramme name the block has (`lookupp` beside an imported `lookup`) stays an error.
        const suggestion = /Did you mean '([^']+)'\?/.exec(ts.flattenDiagnosticMessageText(d.messageText, ' '))?.[1];
        if (suggestion !== undefined && (b.imported.has(suggestion) || [...b.implicit.values()].some((s) => s.has(suggestion)))) continue;
        if (exported.has(name)) {
          if (b.fragment && give(b, name)) changed = true; // a complete block imports what it uses
        } else {
          (ENVIRONMENT.has(name) ? b.typed : b.declared).add(name);
          changed = true;
        }
      }
      // In a fragment, a ramme name that a default library also declares (`fetch`) is ramme's.
      if (!b.fragment) continue;
      const sf = program.getSourceFile(join(consumer, b.file));
      const visit = (node) => {
        if (ts.isIdentifier(node) && exported.has(node.text) && isReference(node)) {
          const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
          if (declarations.length > 0 && declarations.every((x) => program.isSourceFileDefaultLibrary(x.getSourceFile())) && give(b, node.text)) changed = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    if (!changed) break;
    ({ program, results } = compile());
  }

  // --- report ---------------------------------------------------------------

  const blockLines = (b) => b.code.split('\n').length;
  for (const [i, diagnostics] of results.entries()) {
    const b = blocks[i];
    const reported = diagnostics.filter(({ d, sf }) => !untypedByStandIn(d, sf, b));
    const unreported = diagnostics.length - reported.length;
    const errors = reported.map(({ d, sf }) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      if (d.start === undefined) return `${b.doc}:${b.line}: TS${d.code}: ${message}`;
      const { line, character } = sf.getLineAndCharacterOfPosition(d.start);
      const name = sf.text.slice(d.start, d.start + d.length);
      let note = '';
      if (UNRESOLVED.has(d.code) && RETIRED.has(name)) note = ` (${RETIRED.get(name)})`;
      else if (UNRESOLVED.has(d.code) && exported.has(name)) note = ` (exported by '${exported.get(name)}': this block imports, so it must import it too)`;
      if (line >= blockLines(b)) return `${b.doc}:${b.line} (what the check added): TS${d.code}: ${message}${note}`;
      const col = line === 0 && b.body ? character - WRAPPER.length + 1 : character + 1;
      return `${b.doc}:${b.line + line}:${col}: TS${d.code}: ${message}${note}`;
    });
    const given = [
      b.body ? 'checked as a body' : null,
      ...[...b.implicit].map(([entry, names]) => `imported from '${entry}': ${[...names].join(', ')}`),
      b.typed.size > 0 ? `declared from ENVIRONMENT: ${[...b.typed].join(', ')}` : null,
      b.declared.size > 0 ? `declared as any: ${[...b.declared].join(', ')}` : null,
      unreported > 0 ? `${unreported} untyped callback parameter(s) of a stand-in not reported` : null,
    ].filter((x) => x !== null);
    const head = `${b.doc}:${b.line} (block ${b.index + 1}, ${b.fragment ? 'a fragment' : 'complete'})`;
    if (errors.length > 0) failed.push({ b, text: `${head}${given.length > 0 ? `; ${given.join('; ')}` : ''}\n${errors.map((e) => `  ${e}`).join('\n')}`, count: errors.length });
    else if (verbose) console.log(`ok ${head}${given.length > 0 ? `; ${given.join('; ')}` : ''}`);
  }
} finally {
  if (keep) console.log(`check-doc-blocks: kept the consumer at ${consumer}`);
  else rmSync(consumer, { recursive: true, force: true });
}

const per = (list) => DOCUMENTS.map((doc) => `${doc} ${list.filter((b) => b.doc === doc).length}`).join(', ');
const summary = `${blocks.length} TypeScript blocks (${per(blocks)})`;
if (failed.length > 0) {
  console.error(
    `check-doc-blocks: ${summary}; ${failed.length} fail (${per(failed.map((f) => f.b))}), ` +
      `${failed.reduce((n, f) => n + f.count, 0)} errors:\n\n${failed.map((f) => f.text).join('\n\n')}`,
  );
  process.exit(1);
}
console.log(`check-doc-blocks: ${summary} type-check against the build output`);
