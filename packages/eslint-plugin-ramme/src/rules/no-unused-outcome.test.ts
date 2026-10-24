import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noUnusedOutcome } from './no-unused-outcome.js';

ruleTester.run('no-unused-outcome', noUnusedOutcome, {
  assertionOptions,
  valid: [
    { name: 'the outcome in a variable', code: 'const r = await attempt(fetchPrices, sku);' },
    { name: 'the outcome returned', code: 'async function f() { return attempt(t); }' },
    { name: 'the outcome tested at once', code: "if ((await attempt(t)).status === 'failure') throw new Error('x');" },
    { name: 'settle destructured', code: 'const [a, b] = await settle([x.bind(), y.bind()]);' },
    { name: 'the outcome passed on', code: 'use(await t.attempt(1));' },
    { name: 'the promise kept', code: 'const p = ctx.settle([a.bind()]);' },
    { name: 'the outcome read in then', code: 'await attempt(t).then(check);' },
    { name: 'call and all throw instead', code: 'await call(t); await all([a.bind()]);' },
  ],
  invalid: [
    {
      name: 'await attempt(…)',
      code: 'await attempt(t);',
      errors: [{ messageId: 'discarded', data: { name: 'attempt' }, line: 1, column: 7, endColumn: 17 }],
    },
    { name: 'attempt(…) alone', code: 'attempt(t);', errors: [{ messageId: 'discarded', data: { name: 'attempt' } }] },
    { name: 'void attempt(…)', code: 'void attempt(t);', errors: [{ messageId: 'discarded', data: { name: 'attempt' } }] },
    { name: 'void await attempt(…)', code: 'void (await attempt(t));', errors: [{ messageId: 'discarded', data: { name: 'attempt' } }] },
    {
      name: 'await settle(…) in a body',
      code: 'const t = task(async () => {\n  await settle([a.bind(), b.bind()]);\n});',
      errors: [{ messageId: 'discarded', data: { name: 'settle' }, line: 2, column: 9 }],
    },
    { name: 'a task’s attempt method', code: 'await fetchPrices.attempt(sku);', errors: [{ messageId: 'discarded', data: { name: 'attempt' } }] },
    { name: 'a context’s settle method', code: 'await ctx.settle([a.bind()]);', errors: [{ messageId: 'discarded', data: { name: 'settle' } }] },
  ],
});
