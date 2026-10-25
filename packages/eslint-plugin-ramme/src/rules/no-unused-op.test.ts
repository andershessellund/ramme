import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noUnusedOp } from './no-unused-op.js';

ruleTester.run('no-unused-op', noUnusedOp, {
  assertionOptions,
  valid: [
    { name: 'yield*', code: 'function* body() { yield* call(t); yield* sleep(1); yield* wait(p); }' },
    { name: 'await from plain async code', code: 'async function main() { await app.call(t); }' },
    { name: 'returned', code: 'function op() { return call(t); }' },
    { name: 'stored, to yield later', code: 'function* body() { const op = call(t); yield* op; }' },
    { name: 'an argument', code: 'function* body() { yield* wait(Promise.all([app.call(a), app.call(b)])); }' },
    { name: 'fork is eager and returns a fiber', code: 'function* body() { fork(t); current().fork(t); }' },
    { name: 'the lifecycle verbs are eager', code: 'function f() { void release(x); releaseAll(); void app.close(); }' },
    { name: 'a free op at module level: no node is current there, so it throws when made', code: 'call(t);' },
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
      name: 'a call statement in a body',
      code: 'const t = task(function* () {\n  call(sendEmail, user);\n});',
      errors: [{ messageId: 'unused', data: { name: 'call' }, line: 2, column: 3, endColumn: 24 }],
    },
    { name: 'void-ed', code: 'function* body() { void sleep(1); }', errors: [{ messageId: 'unused', data: { name: 'sleep' } }] },
    {
      name: 'an imported task’s call method',
      code: "import { charge } from './tasks';\nfunction* body() { charge.call(order); }",
      errors: [{ messageId: 'unused', data: { name: 'call' } }],
    },
    { name: 'a task’s attempt method', code: 'function* body() { charge.attempt(order); }', errors: [{ messageId: 'unused', data: { name: 'attempt' } }] },
    {
      name: 'a task this file makes',
      code: 'const t = task(function* (n: number) {});\nfunction* body() { t.call(1); }',
      errors: [{ messageId: 'unused', data: { name: 'call' } }],
    },
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
  ],
});
