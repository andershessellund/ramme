import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noUnusedOutcome } from './no-unused-outcome.js';

ruleTester.run('no-unused-outcome', noUnusedOutcome, {
  assertionOptions,
  valid: [
    { name: 'the outcome in a variable', code: 'function* b() { const r = yield* attempt(fetchPrices, sku); }' },
    { name: 'the outcome awaited into a variable', code: 'const r = await attempt(fetchPrices, sku);' },
    { name: 'the outcome returned', code: 'function* b() { return yield* attempt(t); }' },
    { name: 'the outcome tested at once', code: "function* b() { if ((yield* attempt(t)).status === 'failure') throw new Error('x'); }" },
    {
      name: 'the four-way outcome branched on',
      code: "function* b() { const r = yield* attempt(t); if (r.status === 'defect') throw r.error; if (r.status === 'failure') yield* fail(r.error); }",
    },
    { name: 'settle destructured', code: 'function* b() { const [a, c] = yield* settle([x(1), y]); }' },
    { name: 'the outcome passed on', code: 'function* b() { use(yield* attempt(t(1))); }' },
    { name: 'the op kept', code: 'const p = ctx.settle([a]);' },
    { name: 'the outcome read in then', code: 'await attempt(t).then(check);' },
    { name: 'a call, all and join propagate instead', code: 'function* b() { yield* t(1); yield* all([a(1)]); yield* join(f); }' },
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
      code: 'const t = task(function* () {\n  yield* settle([a(1), b(2)]);\n});',
      errors: [{ messageId: 'discarded', data: { name: 'settle' }, line: 2, column: 10 }],
    },
    { name: 'yield* result(f)', code: 'function* b() { yield* result(f); }', errors: [{ messageId: 'discarded', data: { name: 'result' } }] },
    {
      name: 'yield* attempt(…) of a body that fails: its four-way outcome, failure or defect, discarded',
      code: 'const t = task(function* () {\n  yield* attempt(function* () { yield* fail(new NotFound()); });\n});',
      errors: [{ messageId: 'discarded', data: { name: 'attempt' }, line: 2, column: 10 }],
    },
    { name: 'attempt of a task’s call (D44)', code: 'function* b() { yield* attempt(fetchPrices(sku)); }', errors: [{ messageId: 'discarded', data: { name: 'attempt' } }] },
    { name: 'a context’s settle method', code: 'await ctx.settle([a]);', errors: [{ messageId: 'discarded', data: { name: 'settle' } }] },
  ],
});
