import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noPromiseCombinators } from './no-promise-combinators.js';

ruleTester.run('no-promise-combinators', noPromiseCombinators, {
  assertionOptions,
  valid: [
    { name: "ramme's all, race and settle", code: 'await all([a.bind(1), b.bind(2)]); await race([c.bind()]); await settle([d.bind()]);' },
    { name: 'other Promise statics', code: 'Promise.resolve(1); Promise.reject(e); Promise.withResolvers(); new Promise((r) => r());' },
    { name: 'a Promise declared here', code: "import Promise from 'bluebird'; await Promise.all(xs);" },
    { name: 'a method named all on another object', code: 'await group.all(xs); await registry.race(ys);' },
    { name: 'a type query', code: 'type All = ReturnType<typeof Promise.all>;' },
  ],
  invalid: [
    {
      name: 'Promise.race',
      code: 'await Promise.race([a, b]);',
      errors: [{ messageId: 'combinator', data: { name: 'race' }, line: 1, column: 7, endColumn: 19 }],
    },
    {
      name: 'Promise.any',
      code: 'const first = await Promise.any(ps);',
      errors: [{ messageId: 'combinator', data: { name: 'any' } }],
    },
    {
      name: 'Promise.allSettled',
      code: 'const t = task(async () => { await Promise.allSettled([call(a), call(b)]); });',
      errors: [{ messageId: 'combinator', data: { name: 'allSettled' } }],
    },
    {
      name: 'Promise.all, the fulfilling shape DESIGN §4.2 supports included',
      code: 'const t = task(async (f, g) => { await Promise.all([join(f), join(g)]); });',
      errors: [{ messageId: 'combinator', data: { name: 'all' } }],
    },
    {
      name: 'a top-level Promise.all over results',
      code: 'for (const o of await Promise.all(fibers.map((f) => root.result(f)))) log(o);',
      errors: [{ messageId: 'combinator', data: { name: 'all' } }],
    },
    {
      name: 'a reference without a call, and a computed name',
      code: "const all = Promise.all.bind(Promise); Promise['race'](xs);",
      errors: [
        { messageId: 'combinator', data: { name: 'all' } },
        { messageId: 'combinator', data: { name: 'race' } },
      ],
    },
    {
      name: 'under a TypeScript cast',
      code: 'await (Promise as PromiseConstructor).all(xs);',
      errors: [{ messageId: 'combinator', data: { name: 'all' } }],
    },
  ],
});
