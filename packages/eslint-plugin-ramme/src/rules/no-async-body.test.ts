import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noAsyncBody } from './no-async-body.js';

ruleTester.run('no-async-body', noAsyncBody, {
  assertionOptions,
  valid: [
    { name: 'a generator body', code: 'const t = task(function* (id) { return yield* call(load, id); });' },
    { name: 'a synchronous arrow', code: 'const t = task(() => 1); call(() => compute());' },
    { name: 'a sync arrow returning an op, driven as the body', code: 'fork(() => call(t));' },
    { name: 'a named generator function', code: 'function* load() { yield* sleep(1); } fork(load);' },
    { name: 'promised over a generator', code: 'db.transaction(promised(function* (tx) { yield* call(insert, tx); }));' },
    { name: 'an async release or handler, a bare wait', code: 'own(x, async (v) => v.close()); task(work, { onFailure: async (e) => log(e) });' },
    { name: 'an async function as a later argument', code: 'call(t, async () => 1);' },
    { name: 'a name declared elsewhere, not visible', code: 'import { handler } from "./h.js"; fork(handler);' },
    { name: 'a let, which may be reassigned', code: 'let body = async () => 1; body = function* () {}; fork(body);' },
    { name: 'another verb', code: 'run(async () => 1); wait(async () => 1);' },
  ],
  invalid: [
    {
      name: 'an inline async arrow',
      code: 'const t = task(async (id) => load(id));',
      errors: [{ messageId: 'asyncBody', data: { verb: 'task' }, line: 1, column: 16, endColumn: 38 }],
    },
    { name: 'an async function expression to call', code: 'yield* call(async function () {});', errors: [{ messageId: 'asyncBody', data: { verb: 'call' } }] },
    { name: 'an async generator', code: 'fork(async function* () {});', errors: [{ messageId: 'asyncBody', data: { verb: 'fork' } }] },
    {
      name: 'a named async function declared in the file',
      code: 'async function handle(req) { await respond(req); }\napp.fork(handle, req);',
      errors: [{ messageId: 'asyncBody', data: { verb: 'fork' }, line: 2 }],
    },
    {
      name: 'a const async arrow declared in the file',
      code: 'const save = async () => {};\nyield* attempt(save);',
      errors: [{ messageId: 'asyncBody', data: { verb: 'attempt' }, line: 2 }],
    },
    { name: 'promised(async …)', code: 'db.transaction(promised(async (tx) => { await tx.query(q); }));', errors: [{ messageId: 'asyncBody', data: { verb: 'promised' } }] },
    { name: 'ctx.promised(async …)', code: 'app.get("/x", root.promised(async () => {}));', errors: [{ messageId: 'asyncBody', data: { verb: 'promised' } }] },
    { name: 'shield and unshield', code: 'shield(async () => {}); unshield(async () => {});', errors: [{ messageId: 'asyncBody', data: { verb: 'shield' } }, { messageId: 'asyncBody', data: { verb: 'unshield' } }] },
    { name: 'pool.fork', code: 'pool.fork(async (job) => job.run());', errors: [{ messageId: 'asyncBody', data: { verb: 'fork' } }] },
    { name: 'bind', code: 'target.on("x", bind(async () => {}));', errors: [{ messageId: 'asyncBody', data: { verb: 'bind' } }] },
    { name: 'through a TypeScript cast', code: 'task((async () => 1) as never);', errors: [{ messageId: 'asyncBody', data: { verb: 'task' } }] },
  ],
});
