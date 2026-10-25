// ---------------------------------------------------------------------------
// The surface check over the build output. Run by `pnpm check:surface`,
// after `pnpm build`.
//
// Parses every export clause of dist/index.d.ts and requires the exported
// names to be exactly this file's `expected` map, each in its space (value or
// type) and from its module: every core name (the node and the free functions,
// task options, tasks, fibers, results and outcomes, pools, the error classes)
// is there, `Fiber` only as a type, `runSync` only as the ambient function, and
// no name removed by the redesign or since (`ProviderOptions`, D36; `managed`,
// `InterruptedError`, `UnawaitedCallError` and the async-context registry, D41)
// or internal to ramme. Then requires dist/result.d.ts, the `ramme/result`
// subpath, to export exactly the `resultExpected` functions and nothing else
// (`gen` retired, D42), and dist/result.js to import nothing: the subpath is a
// leaf that imports only types (DESIGN.md §7). Then requires dist/platform.d.ts,
// the `ramme/platform` subpath (DESIGN.md §4.9, D43), to export exactly the
// `platformExpected` names, and dist/platform.js to import nothing but the
// public core, `./index.js`. Also requires that stripInternal left no `@internal`
// declaration in any dist/*.d.ts, and that the adapters of the async-context
// era (dist/node.js, dist/async-context.js) are not built: package.json exports
// `.`, `./platform` and `./result` only (D41, decision 18). The browser is a target (D41,
// decision 19): dist/index.js and dist/platform.js, and every module they
// import at run time, import nothing from `node:` or a Node builtin such as
// `async_hooks` (src/stage4-pin.test.ts makes the same check), and touch no
// global beyond ES2022's but the host APIs of `browserGlobals`
// (src/test/browser-smoke.test.ts makes the same check). Last, compiles a consumer outside
// the package with `declaration` (`consumerSource`): a library's unannotated
// helpers generic over `E` must emit, and a task's `E` must emit as the plain
// union (D42). Then a Node consumer with no DOM library (`nodeConsumerSource`):
// Node 22+ is a target, so every declaration the three entries reach must
// type-check against @types/node's globals alone, with `skipLibCheck` off (a
// DOM-only name such as `AddEventListenerOptions` is none there). The
// type-level half is src/test/surface.check.ts.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import ts from 'typescript';

const dist = new URL('../dist/', import.meta.url);

/** The expected surface, with context.ts's types listed by name as index.ts lists them: name → [space, module]. */
const expected = new Map([
  ...[
    'NodeState',
    'InterruptMode',
    'NodeOptions',
    'Instruction',
    'Fail',
    'Operation',
    'Op',
    'Body',
    'Release',
    'Provider',
    'Public',
    'LookupOptions',
    'Success',
    'Failure',
    'Result',
    'Outcome',
    'FailureDestination',
    'TaskOptions',
    'Fiber',
    'Task',
    'AllResult',
    'SettleResult',
    'PoolOptions',
    'Pool',
    'Context',
  ].map((n) => [n, ['type', './context.js']]),
  ['createRootContext', ['value', './create-context.js']],
  ['CreateRootContextOptions', ['type', './create-context.js']],
  ['task', ['value', './fiber.js']],
  ...[
    'current',
    'signal',
    'lookup',
    'own',
    'release',
    'releaseAll',
    'fork',
    'call',
    'attempt',
    'all',
    'race',
    'settle',
    'shield',
    'unshield',
    'pool',
    'child',
    'join',
    'result',
    'interrupted',
    'never',
    'sleep',
    'wait',
    'promised',
    'fail',
    'runSync',
  ].map((n) => [n, ['value', './ambient.js']]),
  ['inject', ['value', './inject.js']],
  ['ContextKey', ['value', './inject.js']],
  ...[
    'NoCurrentNodeError',
    'NodeCompletedError',
    'PendingNodeError',
    'NotOwnedError',
    'AlreadyOwnedError',
    'FiberNotAwaitableError',
    'FiberAbortedError',
    'PoolClosedError',
    'PoolFullError',
    'CreationViolationError',
    'FactoryReturnedUndefinedError',
    'AsyncRunError',
    'PlacementError',
    'OwnerInterrupt',
  ].map((n) => [n, ['value', './resource.js']]),
  ...['createInjectionKey', 'setScope', 'setDependencies'].map((n) => [n, ['value', './context-key.js']]),
  ['InjectionKey', ['type', './context-key.js']],
  ['CreateInjectionKeyOptions', ['type', './context-key.js']],
  ...['classProvider', 'factoryProvider', 'valueProvider', 'aliasProvider'].map((n) => [n, ['value', './provider-util.js']]),
  ...['createScope', 'SelfScope', 'RootScope', 'RequestScope'].map((n) => [n, ['value', './scope.js']]),
  ['Scope', ['type', './scope.js']],
  ['createTopic', ['value', './topic.js']],
  ['TopicReceiver', ['type', './topic.js']],
  ['NodeTopic', ['value', './lifecycle-events.js']],
  ['NodeEvent', ['type', './lifecycle-events.js']],
]);

/** The core names: the node and the free functions, task options, tasks, fibers, results and outcomes, pools, and the error classes. */
const coreNames = [
  // the node and the free functions
  'NodeState', 'InterruptMode', 'NodeOptions', 'Body', 'Release', 'Context',
  'current', 'signal', 'lookup', 'own', 'release', 'fork', 'call', 'attempt', 'all', 'race', 'settle', 'shield',
  'unshield', 'pool', 'child', 'join', 'result', 'interrupted', 'never', 'sleep',
  // generator bodies (DESIGN.md §4.2, D41): the ops, what they yield, and the two verbs for foreign async code
  'Op', 'Operation', 'Instruction', 'wait', 'promised',
  // expected failures (D42): the fourth exit, and the type a helper that fails is named by
  'fail', 'Fail',
  // task options
  'FailureDestination', 'TaskOptions',
  // tasks, fibers, results, outcomes
  'Fiber', 'Task', 'task', 'AllResult', 'SettleResult', 'Result', 'Success', 'Failure', 'Outcome', 'ContextKey',
  // pools
  'PoolOptions', 'Pool',
  // errors
  'NoCurrentNodeError', 'NodeCompletedError', 'PendingNodeError', 'NotOwnedError', 'AlreadyOwnedError',
  'FiberNotAwaitableError', 'FiberAbortedError', 'PoolClosedError', 'CreationViolationError', 'AsyncRunError',
  'PlacementError',
];

/** The exact export list of dist/result.d.ts, the `ramme/result` subpath (DESIGN.md §4.13): functions only, 13. */
const resultExpected = [
  'success', 'failure', 'isSuccess', 'isFailure', 'map', 'mapFailure', 'andThen', 'orElse',
  'unwrap', 'unwrapOr', 'fromThrowing', 'collect', '$',
];

/**
 * The exact export list of dist/platform.d.ts, the `ramme/platform` subpath (DESIGN.md §4.9, D43): name → its
 * declaration form. The four primitives, and the emitter shape `listen`'s second overload names.
 */
const platformExpected = new Map([
  ['fetch', 'function'],
  ['listen', 'function'],
  ['nextFrame', 'function'],
  ['each', 'const'],
  ['EventEmitterLike', 'interface'],
]);

/**
 * The host APIs the browser entries may touch, beyond the ECMAScript 2022 globals (the floor, DESIGN.md §10, A2): the
 * timers and microtasks the core schedules with, the abort machinery, `DOMException` (an abort's default reason) and
 * `console` (development-mode reports), all present in every evergreen browser and in Node 22; ramme/platform adds
 * `performance` (its frame fallback). `process` is never named: development mode reads `globalThis.process?.env`.
 * What ramme/platform calls on the platform (`fetch`, `requestAnimationFrame`) it reads off `globalThis` when it runs.
 */
const browserGlobals = {
  core: ['queueMicrotask', 'setTimeout', 'clearTimeout', 'AbortController', 'AbortSignal', 'DOMException', 'console'],
  platform: ['performance'],
};

/** Names removed by the redesign or since, and names internal to ramme. */
const absent = [
  'createContext', 'withAbortSignal', 'linkAbortSignal', 'createFiberSet', 'RegisterResource', 'ContextRefKey',
  'create', 'registerResource', 'addProvider', 'createRefCountedKey', 'refCountedProvider', 'Drain', 'Flush',
  'Dispose', 'Abort', 'resourceProvider', 'ContextTopic', 'FiberTopic',
  'FiberType', 'FiberOptions', 'ForkOptions', 'FiberResult', 'FiberSet', 'FiberSetOptions', 'FiberSetSpawnOptions',
  'RefCountedKeyOptions', 'ContextRef', 'ManagedResource', 'ResourceHandle', 'RegisterResourceFunction',
  'ContextEvent', 'FiberEvent', 'Created', 'ContextStatus', 'RunSyncOptions', 'CreateContextOptions',
  'ProviderOptions', // removed with the provider `scope` option (D36)
  // removed with async bodies and the async context (D41): the bridge's names and the storage registry
  'managed', 'InterruptedError', 'UnawaitedCallError', 'registerContextStorage', 'ContextStorage', 'Frame',
  'requireCurrent', 'captureAutoScoped', 'NodeImpl', 'NO_NODE', 'runInFrame', 'currentFrame', 'WorkOp', 'LifecycleOp',
  // retired with expected failures as a yielded channel (D42), and its internals
  'gen', 'FailYield', 'Expected', 'failOp',
];

const problems = [];
let text;
try {
  text = readFileSync(new URL('index.d.ts', dist), 'utf8');
} catch {
  console.error('check-surface: dist/index.d.ts is missing; run `pnpm build` first');
  process.exit(1);
}

/** name → [space, module] as dist/index.d.ts exports it. */
const actual = new Map();
const clause = /export\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';/g;
for (const [, typeOnly, list, from] of text.matchAll(clause)) {
  for (let spec of list.split(',').map((x) => x.trim()).filter(Boolean)) {
    let space = typeOnly ? 'type' : 'value';
    if (spec.startsWith('type ')) {
      space = 'type';
      spec = spec.slice(5).trim();
    }
    const name = spec.split(/\s+as\s+/).pop().trim();
    if (actual.has(name)) problems.push(`${name} is exported twice`);
    actual.set(name, [space, from]);
  }
}
const rest = text
  .replace(clause, '')
  .replace(/^import '\.\/disposal-symbols\.js';$/m, '') // the floor's guard, a side-effect import (DESIGN.md §1.2)
  .replace(/\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .trim();
if (rest !== '') problems.push(`index.d.ts has an export form the check cannot read (only "export [type] { … } from '…'" is allowed):\n${rest}`);

for (const [name, [space, from]] of expected) {
  const got = actual.get(name);
  if (got === undefined) problems.push(`missing: ${space} ${name} from '${from}'`);
  else if (got[0] !== space || got[1] !== from)
    problems.push(`${name}: expected a ${space} export from '${from}', got a ${got[0]} export from '${got[1]}'`);
}
for (const name of actual.keys()) if (!expected.has(name)) problems.push(`not in the expected surface: ${name}`);
for (const name of coreNames) if (!actual.has(name)) problems.push(`the core name ${name} is not exported`);
for (const name of absent) {
  // An identifier anywhere in an export clause, so `create` does not match './create-context.js'.
  if (new RegExp(`[{,\\s]${name}[\\s,}]`).test(text.replace(/'[^']*'/g, "''")))
    problems.push(`removed or internal name present: ${name}`);
}
// dist/result.d.ts: one `export declare function` per overload, unexported helper types (`type`, `interface`,
// which its signatures name), type-only imports and TypeScript's `export {};`; any other export form is refused.
// The names are not `\w` only: `$` is one of them.
let resultTypes;
let resultJs;
try {
  resultTypes = readFileSync(new URL('result.d.ts', dist), 'utf8');
  resultJs = readFileSync(new URL('result.js', dist), 'utf8');
} catch {
  console.error('check-surface: dist/result.d.ts or dist/result.js is missing; run `pnpm build` first');
  process.exit(1);
}
const resultCode = resultTypes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const resultActual = new Set();
for (const [line] of resultCode.matchAll(/^export\b.*$/gm)) {
  const fn = /^export declare function ([A-Za-z_$][\w$]*)\s*[<(]/.exec(line);
  if (fn !== null) resultActual.add(fn[1]);
  else if (line.trim() !== 'export {};')
    problems.push(`result.d.ts has an export form the check cannot read (only "export declare function …" is allowed): ${line.trim()}`);
}
for (const name of resultExpected) if (!resultActual.has(name)) problems.push(`ramme/result: missing ${name}`);
for (const name of resultActual) if (!resultExpected.includes(name)) problems.push(`ramme/result: not in the expected list: ${name}`);
for (const [line] of resultCode.matchAll(/^import\b.*$/gm))
  if (!/^import type \{[^}]*\} from '\.\/context\.js';$/.test(line.trim()))
    problems.push(`result.d.ts imports something other than types from ./context.js: ${line.trim()}`);
if (/^\s*import\b|\bfrom\s*['"]|\bimport\s*\(/m.test(resultJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')))
  problems.push('dist/result.js imports at runtime: ramme/result is a leaf that imports only types (DESIGN.md §7)');

// dist/platform.d.ts: `export declare function` (one per overload), `export declare const`, `export interface`, type-only
// imports from the public core, and TypeScript's `export {};`; any other export form is refused. dist/platform.js imports
// the public core only: the layer can do nothing a user could not (DESIGN.md §4.9).
let platformTypes;
let platformJs;
try {
  platformTypes = readFileSync(new URL('platform.d.ts', dist), 'utf8');
  platformJs = readFileSync(new URL('platform.js', dist), 'utf8');
} catch {
  console.error('check-surface: dist/platform.d.ts or dist/platform.js is missing; run `pnpm build` first');
  process.exit(1);
}
const platformCode = platformTypes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const platformActual = new Map();
for (const [line] of platformCode.matchAll(/^export\b.*$/gm)) {
  const decl = /^export (?:declare (function|const) |(interface) )([A-Za-z_$][\w$]*)\b/.exec(line);
  if (decl !== null) {
    const form = decl[1] ?? decl[2];
    const seenForm = platformActual.get(decl[3]);
    if (seenForm !== undefined && !(seenForm === 'function' && form === 'function'))
      problems.push(`ramme/platform: ${decl[3]} is declared twice`);
    platformActual.set(decl[3], form);
  } else if (line.trim() !== 'export {};')
    problems.push(`platform.d.ts has an export form the check cannot read: ${line.trim()}`);
}
for (const [name, form] of platformExpected) {
  const got = platformActual.get(name);
  if (got === undefined) problems.push(`ramme/platform: missing ${form} ${name}`);
  else if (got !== form) problems.push(`ramme/platform: ${name} is a ${got}, expected a ${form}`);
}
for (const name of platformActual.keys())
  if (!platformExpected.has(name)) problems.push(`ramme/platform: not in the expected list: ${name}`);
for (const [line] of platformCode.matchAll(/^import\b.*$/gm))
  if (!/^import type \{[^}]*\} from '\.\/index\.js';$/.test(line.trim()))
    problems.push(`platform.d.ts imports something other than types from ./index.js: ${line.trim()}`);
for (const { fileName } of ts.preProcessFile(platformJs, true, true).importedFiles)
  if (fileName !== './index.js')
    problems.push(`dist/platform.js imports ${fileName}: ramme/platform imports the public core (./index.js) only`);

for (const file of readdirSync(dist).filter((f) => f.endsWith('.d.ts'))) {
  if (readFileSync(new URL(file, dist), 'utf8').includes('@internal'))
    problems.push(`dist/${file} keeps an @internal declaration: is stripInternal off?`);
}
// No async context (D41, decision 18): the adapter modules are gone, and package.json exports the core, the platform
// layer and the result subpath only.
for (const gone of ['node.js', 'async-context.js'])
  if (readdirSync(dist).includes(gone)) problems.push(`dist/${gone} exists: the async-context adapters are deleted (D41)`);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const subpaths = Object.keys(pkg.exports ?? {}).sort();
if (JSON.stringify(subpaths) !== JSON.stringify(['.', './platform', './result']))
  problems.push(`package.json exports ${subpaths.join(', ')}; expected exactly ., ./platform and ./result`);

// The browser is a target (decision 19; D41 decision 18): no module the core entry or the platform subpath reaches at
// run time imports a Node module, by the `node:` scheme or a bare builtin name (`async_hooks`). TypeScript's scanner
// reads the imports (static imports and re-exports, `import()`, `require()`), never a comment or a string. Nor does
// one touch a global beyond ES2022's but `browserGlobals`: ESLint's scope analysis, with ES2022's globals declared,
// leaves exactly the names a module reads from the host (`through` the global scope); a property read off
// `globalThis` is no reference.
{
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const name = (u) => `dist/${u.href.slice(dist.href.length)}`;
  const linter = new Linter({ configType: 'flat' });
  const hostReads = {
    create: (context) => ({
      'Program:exit'() {
        for (const ref of context.sourceCode.scopeManager.globalScope.through)
          context.report({ node: ref.identifier, message: ref.identifier.name });
      },
    }),
  };
  const config = [
    {
      plugins: { browser: { rules: { 'host-reads': hostReads } } },
      rules: { 'browser/host-reads': 'error' },
      languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
  ];
  const seen = new Set();
  const visit = (file, importer) => {
    if (seen.has(file.href)) return;
    seen.add(file.href);
    if (!existsSync(file)) {
      problems.push(`${name(file)} is missing (imported by ${importer}): the browser check reads it`);
      return;
    }
    const code = readFileSync(file, 'utf8');
    const allowed = new Set([...browserGlobals.core, ...(name(file) === 'dist/platform.js' ? browserGlobals.platform : [])]);
    for (const m of linter.verify(code, config))
      if (m.ruleId !== 'browser/host-reads') problems.push(`${name(file)} does not parse as ES2022: ${m.message}`);
      else if (!allowed.has(m.message))
        problems.push(`${name(file)} reads the global ${m.message}: the core and ramme/platform must run in a browser`);
    for (const { fileName } of ts.preProcessFile(code, true, true).importedFiles) {
      if (fileName.startsWith('.')) visit(new URL(fileName, file), name(file));
      else if (fileName.startsWith('node:') || builtins.has(fileName))
        problems.push(`${name(file)} imports ${fileName}: the core and ramme/platform must run in a browser`);
    }
  };
  for (const entry of ['index.js', 'platform.js']) visit(new URL(entry, dist), 'the browser entries');
}

/**
 * A library over ramme, compiled with `declaration` (D41, decision 27: annotations are optional). `orFail` and `retry`
 * are generic over `E`, so their emitted types keep `Operation`'s distribution of `E` over `Fail`, which must be
 * written out inline: a name from a module the package's "exports" do not expose fails the emit (TS2883). `charge`
 * both calls a failing task and fails itself; its `E` must emit as the plain union, never wrapped (`NoInfer<…>`).
 */
const consumerSource = `import { call, fail, task } from 'ramme';
import type { Result, Task } from 'ramme';
import { $ } from 'ramme/result';

export function* orFail<T, E>(x: T | undefined, e: E) {
  if (x === undefined) return yield* fail(e);
  return x;
}
export function* retry<T, E>(t: Task<[], T, E>) {
  return yield* call(t);
}
export function* unwrapped<T, E>(r: Result<T, E>) {
  return yield* $(r);
}
class NotFound extends Error {
  readonly name = 'NotFound' as const;
}
class Declined extends Error {
  readonly name = 'Declined' as const;
}
const find = task(function* (id: string) {
  if (id === '') return yield* fail(new NotFound());
  return id.length;
});
export const charge = task(function* (id: string) {
  const n = yield* call(find, id);
  if (n > 3) return yield* fail(new Declined());
  return 'charged';
});
`;

/**
 * A Node program over the three entries, compiled with @types/node and no DOM library, every declaration file checked
 * (`skipLibCheck: false`): what `ramme/platform` names in its signatures (`EventTarget`, `Event`, `AbortSignal`,
 * `Request`, `RequestInit`, `Response`, `URL`) must be a global there too.
 */
const nodeConsumerSource = `import { EventEmitter } from 'node:events';
import { createRootContext, task } from 'ramme';
import { success } from 'ramme/result';
import { each, fetch, listen, nextFrame } from 'ramme/platform';

export const load = task(function* (url: string) {
  const res = yield* fetch(new Request(url), { method: 'GET' });
  yield* nextFrame();
  return success(res.status);
});
export const lines = task(function* (source: AsyncIterable<string>) {
  const seen: string[] = [];
  for (const line of yield* each(source)) {
    seen.push(line);
    yield* each.next();
  }
  return seen;
});
export function wire(target: EventTarget, emitter: EventEmitter): void {
  createRootContext().run(() => {
    listen(target, 'ping', (e) => void e.type, { capture: true, once: true, passive: true, signal: AbortSignal.timeout(10) });
    listen(emitter, 'data', (chunk: unknown) => void chunk, { signal: AbortSignal.timeout(10) });
  });
}
`;

// Outside the package, resolving 'ramme' through node_modules as an installed copy does: inside it, the package's
// self-reference would let the emit name any of its modules by a relative path.
const consumer = mkdtempSync(join(tmpdir(), 'ramme-surface-consumer-'));
try {
  mkdirSync(join(consumer, 'node_modules'));
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), join(consumer, 'node_modules', 'ramme'), 'dir');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'surface-consumer', private: true, type: 'module' }));
  writeFileSync(join(consumer, 'library.ts'), consumerSource);
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2024', 'ESNext.Disposable', 'DOM'],
        types: [],
        strict: true,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: '.',
        outDir: 'out',
        skipLibCheck: true,
      },
      files: ['library.ts'],
    }),
  );
  const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  const run = spawnSync(process.execPath, [tsc, '-p', join(consumer, 'tsconfig.json')], { encoding: 'utf8' });
  if (run.status !== 0)
    problems.push(`a library's declaration emit fails against the build output:\n${`${run.stdout}${run.stderr}`.trim()}`);
  else {
    const emitted = readFileSync(join(consumer, 'out', 'library.d.ts'), 'utf8');
    if (/NoInfer|internal-context/.test(emitted)) problems.push(`a library's emitted declarations name ramme's internals:\n${emitted}`);
    if (!/charge: Task<\[id: string\], string, (NotFound \| Declined|Declined \| NotFound)>/.test(emitted))
      problems.push(`a task's E does not emit as the plain union (charge: Task<[id: string], string, NotFound | Declined>):\n${emitted}`);
  }
  writeFileSync(join(consumer, 'node-consumer.ts'), nodeConsumerSource);
  writeFileSync(
    join(consumer, 'tsconfig.node.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2024', 'ESNext.Disposable'],
        types: ['node'],
        typeRoots: [fileURLToPath(new URL('../node_modules/@types', import.meta.url))],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ['node-consumer.ts'],
    }),
  );
  const node = spawnSync(process.execPath, [tsc, '-p', join(consumer, 'tsconfig.node.json')], { encoding: 'utf8' });
  if (node.status !== 0)
    problems.push(
      `a Node consumer without the DOM library does not type-check against the build output (Node 22+ is a target):\n` +
        `${`${node.stdout}${node.stderr}`.trim()}`,
    );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`check-surface: the build output does not match the expected surface:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `check-surface: dist/index.d.ts exports exactly the ${expected.size} expected names, ` +
    `dist/result.d.ts exactly the ${resultExpected.length} ramme/result functions, and dist/platform.d.ts exactly the ` +
    `${platformExpected.size} ramme/platform names (${[...platformExpected.keys()].join(', ')}); the browser entries ` +
    `import no Node module and read no global but ES2022's and ${[...browserGlobals.core, ...browserGlobals.platform].join(', ')}; ` +
    `a library's declarations emit, and a Node consumer without the DOM library type-checks`,
);
