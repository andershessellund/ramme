import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noSwallowedInterruption } from './no-swallowed-interruption.js';

ruleTester.run('no-swallowed-interruption', noSwallowedInterruption, {
  assertionOptions,
  valid: [
    {
      name: 'an instanceof InterruptedError test that rethrows, then other handling',
      code: 'async function f() { try { await call(t); } catch (e) { if (e instanceof InterruptedError) throw e; log(e); } }',
    },
    {
      name: 'a catch that ends in a throw: translation',
      code: 'async function f() { try { await call(t); } catch (e) { throw translate(e); } }',
    },
    {
      name: 'a catch that only logs and rethrows',
      code: 'const t = task(async () => { try { await call(work); } catch (e) { log(e); throw e; } });',
    },
    {
      name: 'a rethrow of the parameter that is not the last statement',
      code: 'async function f() { try { await x; } catch (err) { if (!(err instanceof NotFound)) { throw err; } return fallback(); } }',
    },
    {
      name: 'the class named through a member',
      code: "import * as ramme from 'ramme'; async function f() { try { await x; } catch (e) { if (e instanceof ramme.InterruptedError) throw e; log(e); } }",
    },
    {
      name: 'the class named through a member passes by (3) alone: no throw anywhere in the block',
      code: "import * as ramme from 'ramme'; async function f() { try { await x; } catch (e) { if (e instanceof ramme.InterruptedError) log('stopped'); return 1; } }",
    },
    {
      name: 'a destructuring parameter whose block ends in a throw',
      code: 'async function f() { try { await x; } catch ({ message }) { throw new Error(message); } }',
    },
    {
      name: 'a catch in a sync function',
      code: 'function f() { try { g(); } catch (e) { log(e); } }',
    },
    {
      name: 'a catch in a sync callback inside an async function',
      code: 'async function f() { items.forEach((i) => { try { use(i); } catch (e) { log(e); } }); await x; }',
    },
    {
      name: 'a catch in a class static block inside an async function',
      code: 'async function f() { class C { static { try { a(); } catch { b(); } } } await x; }',
    },
    {
      name: 'a catch at module level, outside any body',
      code: 'try { await setup(); } catch (e) { log(e); }',
    },
    {
      name: 'a documented false negative: a conditional rethrow of something else passes by (2) and swallows the rest',
      code: 'async function f() { try { await x; } catch (e) { if (e instanceof NotFound) throw e; return fallback(); } }',
    },
    {
      name: 'a documented false negative: an instanceof InterruptedError test that does not rethrow passes by (3)',
      code: 'async function f() { try { await x; } catch (e) { if (e instanceof InterruptedError) log("stopped"); return 1; } }',
    },
  ],
  invalid: [
    {
      name: 'a catch that only logs',
      code: 'async function f() { try { await call(t); } catch (e) { log(e); } }',
      errors: [{ messageId: 'swallowed', line: 1, column: 45, endColumn: 50 }],
    },
    {
      name: 'an empty catch with no parameter',
      code: 'async function f() { try { await call(t); } catch { } }',
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'a catch that returns a fallback',
      code: ['const t = task(async () => {', '  try {', '    return await call(work);', '  } catch (e) {', '    return attemptFallback();', '  }', '});'].join(
        '\n',
      ),
      errors: [{ messageId: 'swallowed', line: 4, column: 5 }],
    },
    {
      name: 'a rethrow inside a nested function does not count',
      code: 'async function f() { try { await x; } catch (e) { queueMicrotask(() => { throw e; }); } }',
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'a destructuring parameter whose block does not end in a throw',
      code: 'async function f() { try { await x; } catch ({ message }) { log(message); } }',
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'a rethrow of another name that is not the last statement (a documented false positive)',
      code: 'async function f() { try { await x; } catch (e) { const err = e; if (err) { throw err; } done(); } }',
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: "a test's capture idiom (a documented false positive)",
      code: "it('rejects', async () => { let caught; try { await p; } catch (e) { caught = e; } expect(caught).toBeDefined(); });",
      errors: [{ messageId: 'swallowed' }],
    },
    {
      name: 'async methods, arrows and generators',
      code: [
        'class S { async run() { try { await x(); } catch (e) { log(e); } } }',
        'const o = { async m() { try { await x; } catch { y(); } } };',
        'const a = async () => { try { await x; } catch (e) { return 0; } };',
        'async function* g() { try { yield await x; } catch (e) { log(e); } }',
      ].join('\n'),
      errors: [{ messageId: 'swallowed', line: 1 }, { messageId: 'swallowed', line: 2 }, { messageId: 'swallowed', line: 3 }, { messageId: 'swallowed', line: 4 }],
    },
    {
      name: 'a try with no await, which no rejection can reach (a documented false positive)',
      code: 'async function f() { try { JSON.parse(s); } catch { return null; } await x; }',
      errors: [{ messageId: 'swallowed' }],
    },
  ],
});
