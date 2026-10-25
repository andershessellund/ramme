import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { typedFile, typedRuleTester } from '../test/typed-rule-tester.js';
import { noUnusedOp } from './no-unused-op.js';

ruleTester.run('no-unused-op', noUnusedOp, {
  assertionOptions,
  valid: [
    { name: 'yield*', code: 'function* body() { yield* t(1); yield* sleep(1); yield* wait(p); }' },
    { name: 'await from plain async code', code: 'async function main() { await app.call(t); }' },
    { name: 'returned', code: 'function op() { return attempt(t); }' },
    { name: 'stored, to yield later', code: 'function* body() { const op = t(1); yield* op; }' },
    { name: 'an argument', code: 'function* body() { yield* wait(Promise.all([app.call(a), app.call(b)])); }' },
    { name: 'fork is eager and returns a fiber', code: 'function* body() { fork(t); fork(t(1)); current().fork(t); }' },
    { name: 'the lifecycle verbs are eager', code: 'function f() { void release(x); releaseAll(); void app.close(); }' },
    { name: 'a free op at module level: no node is current there, so it throws when made', code: 'attempt(t);' },
    { name: 'there is no free call: a function of that name is not ramme’s (D44)', code: 'function* body() { call(t); }' },
    {
      name: 'a task’s call without type information: the syntax cannot tell it from any other call',
      code: 'const t = task(function* (n: number) {});\nfunction* body() { t(1); }',
    },
    {
      name: 'a task’s call through Function.prototype.call at module level: no node is current there, so it throws when made',
      code: 'const t = task(function* (n: number) {});\nt.call(null, 1);',
    },
    {
      name: 'call and apply on a name bound to something other than task(…)',
      code: 'const t = make(function* (n: number) {});\nfunction* body(self) { t.call(self, 1); t.apply(null, [1]); }',
    },
    { name: 'a then chain', code: 'function f() { void app.sleep(1).then(done); }' },
    { name: 'another function with a verb-like name', code: 'function f() { fn.apply(null, args); run(t); }' },
    { name: 'Function.prototype.call with a this-argument', code: 'function f(self, x) { fn.call(self, x); }' },
    { name: 'Function.prototype.call through a prototype', code: 'function f(nodes, g) { Array.prototype.forEach.call(nodes, g); }' },
    { name: 'a prototype chain, whatever the arguments', code: 'function g() {}\nfunction f(ctx) { Function.prototype.call.call(g, ctx); }' },
    {
      name: 'browser and event-emitter code',
      code: 'export function wire(nodes, handler, self, e) {\n  Array.prototype.forEach.call(nodes, (n) => n.remove());\n  handler.call(self, e);\n}',
    },
    {
      name: 'the global fetch, lodash’s each and a nextFrame of its own: only ramme/platform’s are ops',
      code: "import { each } from 'lodash';\nfunction f(xs) { fetch('/beacon'); each(xs, log); const nextFrame = () => 0; nextFrame(); }",
    },
    {
      name: 'a platform op at module level: no node is current there, so it throws when made',
      code: "import { fetch } from 'ramme/platform';\nfetch('/x');",
    },
    {
      name: 'ramme/platform’s ops yielded',
      code: "import { each, fetch, nextFrame } from 'ramme/platform';\nfunction* b(s) { yield* fetch('/a'); yield* nextFrame(); for (const x of yield* each(s)) { use(x); yield* each.next(); } }",
    },
    {
      name: 'a this-argument of this, null, undefined or void, even on an import',
      code: "import { handler } from './handlers';\nfunction f(e) { this.handler.call(this, e); handler.call(this, e); handler.call(null, e); handler.call(undefined); handler.call(void 0, e); }",
    },
    {
      name: 'a receiver this file declares as a function',
      code: "import { owner } from './owner';\nfunction f() { const fn = function () {}; fn.call(owner, 1); function g() {} g.call(owner); }",
    },
    { name: 'a parameter typed as a function', code: "import { self } from './self';\nfunction f(cb: (n: number) => void) { cb.call(self, 1); }" },
    { name: 'the platform’s Promise.all, Promise.race and Atomics.wait', code: 'async function f() { Promise.all([a(), b()]); Promise.race([a()]); Atomics.wait(i32, 0, 0, 1); }' },
  ],
  invalid: [
    {
      name: 'a work verb as a statement in a body',
      code: 'const t = task(function* () {\n  attempt(sendEmail, user);\n});',
      errors: [{ messageId: 'unused', data: { name: 'attempt' }, line: 2, column: 3, endColumn: 27 }],
    },
    { name: 'void-ed', code: 'function* body() { void sleep(1); }', errors: [{ messageId: 'unused', data: { name: 'sleep' } }] },
    {
      name: 'an imported node’s call method',
      code: "import { app } from './app';\nfunction* body() { app.call(order); }",
      errors: [{ messageId: 'unused', data: { name: 'call' } }],
    },
    { name: 'a node’s attempt method', code: 'function* body(ctx: Context) { ctx.attempt(order); }', errors: [{ messageId: 'unused', data: { name: 'attempt' } }] },
    { name: 'a context’s method, with a body', code: 'async function main() { app.call(main); }', errors: [{ messageId: 'unused', data: { name: 'call' } }] },
    {
      name: 'a parameter typed Context',
      code: 'function* body(ctx: Context) { ctx.call(job); }',
      errors: [{ messageId: 'unused', data: { name: 'call' } }],
    },
    {
      name: 'an explicit receiver at module level runs nothing either',
      code: 'const app = createRootContext();\napp.call(main);\napp.sleep(5);',
      errors: [
        { messageId: 'unused', data: { name: 'call' }, line: 2 },
        { messageId: 'unused', data: { name: 'sleep' }, line: 3 },
      ],
    },
    {
      name: 'an inline body through any receiver',
      code: 'function* body() { this.app.call(function* () {}); }',
      errors: [{ messageId: 'unused', data: { name: 'call' } }],
    },
    {
      name: 'a Promise this file declares is not the platform’s',
      code: 'function* body(Promise) { Promise.all([t]); }',
      errors: [{ messageId: 'unused', data: { name: 'all' } }],
    },
    {
      name: 'every work verb',
      code: 'function* b() { attempt(t); all([t]); race([t]); settle([t]); shield(t); unshield(t); join(f); result(f); interrupted(); never(); wait(p); }',
      errors: ['attempt', 'all', 'race', 'settle', 'shield', 'unshield', 'join', 'result', 'interrupted', 'never', 'wait'].map((name) => ({
        messageId: 'unused',
        data: { name },
      })),
    },
    {
      name: 'a task’s call through Function.prototype’s call and apply, on a name this file binds to task(…): it is the task’s call (D44)',
      code: 'const t = task(function* (n: number) {});\nfunction* body(self) { t.call(self, 1); void t.apply(null, [1]); }',
      errors: [
        { messageId: 'unused', data: { name: 't' }, column: 24 },
        { messageId: 'unused', data: { name: 't' }, column: 46 },
      ],
    },
    {
      name: 'ramme/platform’s ops dropped, aliased too: a dropped fetch(…) sends nothing',
      code: "import { each, fetch as get, nextFrame } from 'ramme/platform';\nfunction* b(s) { get('/beacon', { method: 'POST' }); void nextFrame(); each(s); each.next(); }",
      errors: ['fetch', 'nextFrame', 'each', 'each.next'].map((name) => ({ messageId: 'unused', data: { name } })),
    },
  ],
});

// The type-aware half (D44, decision 9): with type information, a dropped call of a task, whose callee's type is a
// `Task` and whose value an `Op`. The fixture program declares `ramme` in ramme's shapes (src/test/fixture).
const tasks = [
  "import { fork, release, sleep, task } from 'ramme';",
  'const load = task(function* load(id: string) { yield* sleep(1); return id; });',
  'declare function save(id: string): Promise<void>;',
  'declare function makeOp(id: string): ReturnType<typeof load>;',
].join('\n');

typedRuleTester.run('no-unused-op (type-aware)', noUnusedOp, {
  assertionOptions,
  valid: [
    { name: 'a task’s call yielded', filename: typedFile, code: `${tasks}\nexport const b = task(function* () { yield* load('a'); });` },
    {
      name: 'a task’s call kept, returned, forked or awaited',
      filename: typedFile,
      code: `${tasks}\nexport const b = task(function* () { const op = load('a'); fork(load('b')); yield* op; return load('c'); });\nexport async function main() { await load('d'); }`,
    },
    { name: 'a promise-returning call is no op', filename: typedFile, code: `${tasks}\nexport const b = task(function* () { save('a'); });` },
    { name: 'an op-returning function is no task', filename: typedFile, code: `${tasks}\nexport const b = task(function* () { makeOp('a'); });` },
    { name: 'a task’s call at module level: no node is current, so it throws when made', filename: typedFile, code: `${tasks}\nload('a');` },
    { name: 'a lifecycle verb is eager', filename: typedFile, code: `${tasks}\nexport const b = task(function* () { void release({}); });` },
    {
      name: 'a callable named Task, with `with`, whose call is no op: the value must be an Op too',
      filename: typedFile,
      code: `${tasks}\ninterface Task { (id: string): Promise<void>; with(o: object): Task }\ndeclare const t: Task;\nexport const b = task(function* () { t('a'); });`,
    },
    {
      name: 'Function.prototype’s bind makes a function, no op',
      filename: typedFile,
      code: `${tasks}\nexport const b = task(function* () { load.bind(null, 'a'); });`,
    },
  ],
  invalid: [
    {
      name: 'a task’s call as a statement in a body',
      filename: typedFile,
      code: `${tasks}\nexport const b = task(function* () {\n  load('a');\n});`,
      errors: [{ messageId: 'unused', data: { name: 'load' }, line: 6, column: 3, endColumn: 12 }],
    },
    { name: 'void-ed', filename: typedFile, code: `${tasks}\nexport const b = task(function* () { void load('a'); });`, errors: [{ messageId: 'unused', data: { name: 'load' } }] },
    {
      name: 'a bound task, through this and through an instance',
      filename: typedFile,
      code: [
        tasks,
        'export class Api {',
        "  readonly #base = 'https://api';",
        '  readonly get = task(this, function* get(path: string) { yield* sleep(1); return this.#base + path; });',
        "  readonly warm = task(this, function* warm() { this.get('/a'); });",
        '}',
        "export function poke(api: Api) { return task(function* () { api.get('/b'); }); }",
      ].join('\n'),
      errors: [
        { messageId: 'unused', data: { name: 'get' }, line: 8 },
        { messageId: 'unused', data: { name: 'get' }, line: 10 },
      ],
    },
    {
      name: 'a task written any way: a private field, through with(…), made inline, and through an optional chain',
      filename: typedFile,
      code: [
        tasks,
        'export class Api {',
        '  readonly #get = task(this, function* get(path: string) { yield* sleep(1); return path; });',
        "  readonly warm = task(this, function* warm() { this.#get('/a'); });",
        '}',
        'declare const maybe: { get: typeof load } | undefined;',
        'export const b = task(function* () {',
        "  load.with({ name: 'y' })('z');",
        '  void task(function* () {})();',
        '  task(function* (n: number) { return n; })(2);',
        "  maybe?.get('/q');",
        '});',
      ].join('\n'),
      errors: [
        { messageId: 'unused', data: { name: '#get' }, line: 7 },
        { messageId: 'unused', data: { name: 'with(…)' }, line: 11 },
        { messageId: 'unused', data: { name: 'task(…)' }, line: 12 },
        { messageId: 'unused', data: { name: 'task(…)' }, line: 13 },
        { messageId: 'unused', data: { name: 'get' }, line: 14 },
      ],
    },
    {
      name: 'a task’s call through Function.prototype’s call and apply, on any receiver typed a Task (D44)',
      filename: typedFile,
      code: `${tasks}\nexport function poke(t: typeof load) { return task(function* () { t.call(undefined, 'a'); load.apply(null, ['b']); }); }`,
      errors: [
        { messageId: 'unused', data: { name: 't' } },
        { messageId: 'unused', data: { name: 'load' } },
      ],
    },
  ],
});
