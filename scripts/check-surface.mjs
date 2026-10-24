// ---------------------------------------------------------------------------
// The surface check over the build output. Run by `pnpm check:surface`,
// after `pnpm build`.
//
// Parses every export clause of dist/index.d.ts and requires the exported
// names to be exactly this file's `expected` map, each in its space (value or
// type) and from its module: every core name (the node and the free functions,
// task options, tasks, fibers, results and outcomes, pools, the error classes)
// is there, `Fiber` only as a type, `runSync` only as the ambient function, and
// no name removed by the redesign or since (`ProviderOptions`, D36) or internal
// to ramme. Then requires dist/result.d.ts, the `ramme/result` subpath, to export
// exactly the `resultExpected` functions and nothing else, and dist/result.js to
// import nothing: the subpath is a leaf that imports only types (DESIGN.md §7). Also
// requires that stripInternal left no `@internal` declaration in any
// dist/*.d.ts. The type-level half is src/test/surface.check.ts.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);

/** The expected surface, with context.ts's types listed by name as index.ts lists them: name → [space, module]. */
const expected = new Map([
  ...[
    'NodeState',
    'InterruptMode',
    'NodeOptions',
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
    'pool',
    'child',
    'join',
    'result',
    'interrupted',
    'never',
    'sleep',
    'managed',
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
    'UnawaitedCallError',
    'FiberNotAwaitableError',
    'FiberAbortedError',
    'InterruptedError',
    'PoolClosedError',
    'PoolFullError',
    'CreationViolationError',
    'FactoryReturnedUndefinedError',
    'AsyncRunError',
    'PlacementError',
    'OwnerInterrupt',
  ].map((n) => [n, ['value', './resource.js']]),
  ['registerContextStorage', ['value', './context-storage.js']],
  ['ContextStorage', ['type', './context-storage.js']],
  ['Frame', ['type', './context-storage.js']],
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
  'current', 'signal', 'lookup', 'own', 'release', 'fork', 'call', 'attempt', 'all', 'race', 'settle', 'shield', 'pool',
  'child', 'join', 'result', 'interrupted', 'never', 'sleep', 'managed',
  // task options
  'FailureDestination', 'TaskOptions',
  // tasks, fibers, results, outcomes
  'Fiber', 'Task', 'task', 'AllResult', 'SettleResult', 'Result', 'Success', 'Failure', 'Outcome', 'ContextKey',
  // pools
  'PoolOptions', 'Pool',
  // errors
  'NoCurrentNodeError', 'NodeCompletedError', 'PendingNodeError', 'NotOwnedError', 'AlreadyOwnedError',
  'UnawaitedCallError', 'FiberNotAwaitableError', 'FiberAbortedError', 'InterruptedError', 'PoolClosedError',
  'CreationViolationError', 'AsyncRunError', 'PlacementError',
];

/** The exact export list of dist/result.d.ts, the `ramme/result` subpath (DESIGN.md §4.13): functions only. */
const resultExpected = [
  'success', 'failure', 'isSuccess', 'isFailure', 'map', 'mapFailure', 'andThen', 'orElse',
  'unwrap', 'unwrapOr', 'fromThrowing', 'collect', 'gen', '$',
];

/** Names removed by the redesign or since, and names internal to ramme. */
const absent = [
  'createContext', 'withAbortSignal', 'linkAbortSignal', 'createFiberSet', 'RegisterResource', 'ContextRefKey',
  'create', 'registerResource', 'addProvider', 'createRefCountedKey', 'refCountedProvider', 'Drain', 'Flush',
  'Dispose', 'Abort', 'resourceProvider', 'ContextTopic', 'FiberTopic',
  'FiberType', 'FiberOptions', 'ForkOptions', 'FiberResult', 'FiberSet', 'FiberSetOptions', 'FiberSetSpawnOptions',
  'RefCountedKeyOptions', 'ContextRef', 'ManagedResource', 'ResourceHandle', 'RegisterResourceFunction',
  'ContextEvent', 'FiberEvent', 'Created', 'ContextStatus', 'RunSyncOptions', 'CreateContextOptions',
  'ProviderOptions', // removed with the provider `scope` option (D36)
  'requireCurrent', 'captureAutoScoped', 'NodeImpl', 'NO_NODE', 'runInFrame', 'currentFrame',
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

for (const file of readdirSync(dist).filter((f) => f.endsWith('.d.ts'))) {
  if (readFileSync(new URL(file, dist), 'utf8').includes('@internal'))
    problems.push(`dist/${file} keeps an @internal declaration: is stripInternal off?`);
}

if (problems.length > 0) {
  console.error(`check-surface: the build output does not match the expected surface:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `check-surface: dist/index.d.ts exports exactly the ${expected.size} expected names, ` +
    `and dist/result.d.ts exactly the ${resultExpected.length} ramme/result functions`,
);
