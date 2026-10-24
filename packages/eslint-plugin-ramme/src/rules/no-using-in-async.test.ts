import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noUsingInAsync } from './no-using-in-async.js';

ruleTester.run('no-using-in-async', noUsingInAsync, {
  assertionOptions,
  valid: [
    {
      name: '`await using` for the root at module level',
      code: 'await using app = createRootContext();',
    },
    {
      name: '`await using` in a block at module level',
      code: '{ await using app = boot(); await app.call(main); }',
    },
    {
      name: '`using` at module level',
      code: 'using lock = acquire();',
    },
    {
      name: '`using` in a sync function',
      code: 'function f() { using x = res(); return x.v; }',
    },
    {
      name: '`using` in a nested sync function inside an async one',
      code: 'async function f() { const g = () => { using x = res(); return x.v; }; await call(g); }',
    },
    {
      name: '`const` in an async function',
      code: 'async function f() { const x = own(await open()); }',
    },
  ],
  invalid: [
    {
      name: '`await using` in an async function',
      code: 'async function f() { await using app = createRootContext(); }',
      errors: [{ messageId: 'using', data: { kind: 'await using' }, line: 1, column: 22 }],
    },
    {
      name: 'a root in an async test callback',
      code: ["test('boots', async () => {", '  await using app = boot();', '});'].join('\n'),
      errors: [{ messageId: 'using', data: { kind: 'await using' }, line: 2, column: 3 }],
    },
    {
      name: '`using` in an async task body',
      code: 'const t = task(async () => { using lock = mutex.lock(); await work(); });',
      errors: [{ messageId: 'using', data: { kind: 'using' } }],
    },
    {
      name: '`for (await using …)` in an async function',
      code: 'async function f() { for (await using x of xs) { await x.use(); } }',
      errors: [{ messageId: 'using', data: { kind: 'await using' } }],
    },
    {
      name: 'an async method',
      code: 'class S { async run() { if (ok) { using t = tmp(); await t.write(); } } }',
      errors: [{ messageId: 'using', data: { kind: 'using' } }],
    },
  ],
});
