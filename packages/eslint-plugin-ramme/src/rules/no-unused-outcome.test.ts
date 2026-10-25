import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noUnusedOutcome } from './no-unused-outcome.js';

ruleTester.run('no-unused-outcome', noUnusedOutcome, {
  assertionOptions,
  valid: [
    { name: 'the outcome in a variable', code: 'function* b() { const r = yield* attempt(fetchPrices, sku); }' },
    { name: 'the outcome awaited into a variable', code: 'const r = await attempt(fetchPrices, sku);' },
    { name: 'the outcome returned', code: 'function* b() { return yield* attempt(t); }' },
    { name: 'the outcome tested at once', code: "function* b() { if ((yield* attempt(t)).status === 'failure') throw new Error('x'); }" },
    { name: 'settle destructured', code: 'function* b() { const [a, c] = yield* settle([x.bind(), y.bind()]); }' },
    { name: 'the outcome passed on', code: 'function* b() { use(yield* t.attempt(1)); }' },
    { name: 'the op kept', code: 'const p = ctx.settle([a.bind()]);' },
    { name: 'the outcome read in then', code: 'await attempt(t).then(check);' },
    { name: 'call, all and join throw instead', code: 'function* b() { yield* call(t); yield* all([a.bind()]); yield* join(f); }' },
    { name: 'the op alone runs nothing: no-unused-op reports it', code: 'function* b() { attempt(t); void settle([a]); }' },
    { name: 'yield without the star consumes nothing: the driver throws a TypeError back', code: 'function* b() { yield attempt(t); }' },
  ],
  invalid: [
    {
      name: 'yield* attempt(…)',
      code: 'function* b() { yield* attempt(t); }',
      errors: [{ messageId: 'discarded', data: { name: 'attempt' }, line: 1, column: 24, endColumn: 34 }],
    },
    { name: 'await attempt(…)', code: 'await attempt(t);', errors: [{ messageId: 'discarded', data: { name: 'attempt' } }] },
    { name: 'void await attempt(…)', code: 'void (await attempt(t));', errors: [{ messageId: 'discarded', data: { name: 'attempt' } }] },
    {
      name: 'yield* settle(…) in a body',
      code: 'const t = task(function* () {\n  yield* settle([a.bind(), b.bind()]);\n});',
      errors: [{ messageId: 'discarded', data: { name: 'settle' }, line: 2, column: 10 }],
    },
    { name: 'yield* result(f)', code: 'function* b() { yield* result(f); }', errors: [{ messageId: 'discarded', data: { name: 'result' } }] },
    { name: 'a task’s attempt method', code: 'function* b() { yield* fetchPrices.attempt(sku); }', errors: [{ messageId: 'discarded', data: { name: 'attempt' } }] },
    { name: 'a context’s settle method', code: 'await ctx.settle([a.bind()]);', errors: [{ messageId: 'discarded', data: { name: 'settle' } }] },
  ],
});
