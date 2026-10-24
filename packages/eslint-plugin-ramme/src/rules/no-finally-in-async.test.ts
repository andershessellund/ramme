import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noFinallyInAsync } from './no-finally-in-async.js';

ruleTester.run('no-finally-in-async', noFinallyInAsync, {
  assertionOptions,
  valid: [
    {
      name: 'try/catch in an async function',
      code: 'async function f() { try { await g(); } catch (e) { log(e); } }',
    },
    {
      name: 'a finally in a sync function',
      code: 'function f() { try { g(); } finally { h(); } }',
    },
    {
      name: 'a finally in a nested sync function inside an async one',
      code: 'async function f() { function cleanup() { try { a(); } finally { b(); } } cleanup(); await x; }',
    },
    {
      name: 'a finally in a sync callback inside an async task body',
      code: 'const t = task(async () => { items.forEach((i) => { try { use(i); } finally { done(i); } }); });',
    },
    {
      name: 'a finally at module level, outside any body',
      code: 'try { await setup(); } finally { teardown(); }',
    },
    {
      name: 'a finally in a static block inside an async function',
      code: 'async function f() { class C { static { try { a(); } finally { b(); } } } await x; }',
    },
    {
      name: 'a finally in a sync arrow in a class field initializer inside an async function',
      code: 'async function f() { class C { v = (() => { try { return a(); } finally { b(); } })(); } await x; }',
    },
    {
      name: 'a finally in a sync generator',
      code: 'function* g() { try { yield 1; } finally { done(); } }',
    },
  ],
  invalid: [
    {
      name: 'an async function declaration',
      code: 'async function f() { try { await g(); } finally { h(); } }',
      errors: [{ messageId: 'finally', line: 1, column: 41, endColumn: 48 }],
    },
    {
      name: 'an async task body',
      code: ['const t = task(async () => {', '  try {', '    await call(work);', '  } finally {', '    done();', '  }', '});'].join('\n'),
      errors: [{ messageId: 'finally', line: 4, column: 5 }],
    },
    {
      name: 'an async method, with a catch too',
      code: 'class S { async run() { try { await x(); } catch { log(); } finally { y(); } } }',
      errors: [{ messageId: 'finally' }],
    },
    {
      name: 'an async arrow inside a sync function',
      code: 'function outer() { return async () => { try { await a(); } finally { b(); } }; }',
      errors: [{ messageId: 'finally' }],
    },
    {
      name: 'nested in blocks and loops of an async function',
      code: 'async function f() { if (a) { for (const x of xs) { try { await x; } finally { done(); } } } }',
      errors: [{ messageId: 'finally' }],
    },
    {
      name: 'an async generator',
      code: 'async function* g() { try { yield await x; } finally { done(); } }',
      errors: [{ messageId: 'finally' }],
    },
    {
      name: 'an async object method',
      code: 'const o = { async m() { try { await x; } finally { y(); } } };',
      errors: [{ messageId: 'finally' }],
    },
    {
      name: 'two in one body',
      code: 'async function f() { try { await a(); } finally { b(); } try { await c(); } finally { d(); } }',
      errors: [{ messageId: 'finally' }, { messageId: 'finally' }],
    },
  ],
});
