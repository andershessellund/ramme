import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noOwnedProvider } from './no-owned-provider.js';

ruleTester.run('no-owned-provider', noOwnedProvider, {
  assertionOptions,
  valid: [
    {
      name: 'providers: binds on a new node',
      code: 'const t = task(function* () { const uow = own(begin()); return yield* call(work.with({ providers: [ valueProvider(K, uow) ] })); });',
    },
    { name: 'providers: on a child, with own inline', code: 'const c = child({ providers: [valueProvider(K, own(x))] });' },
    { name: 'a value nobody owns', code: 'const x = makeX(); ctx.addProvider(valueProvider(K, x));' },
    { name: 'a literal value', code: 'current().addProvider(valueProvider(K, { retries: 3 }));' },
    {
      name: 'owned by the enclosing body, provided on a fork of its own',
      code: 'const t = task(function* () { const tx = own(yield* wait(db.begin())); fork(function* () { current().addProvider(valueProvider(Tx, tx)); }); });',
    },
    { name: 'a factory provider whose factory owns what it builds', code: 'ctx.addProvider(factoryProvider(K, () => own(x)));' },
    {
      name: 'a factory provider whose factory is an owned function: what it provides is what the factory builds',
      code: 'ctx.addProvider(factoryProvider(K, own(build)));',
    },
    { name: 'ramme has no free addProvider', code: 'addProvider(valueProvider(K, own(x)));' },
    { name: 'a private method named own', code: 'class S { m() { ctx.addProvider(valueProvider(K, this.#own(x))); } #own(x) { return x; } }' },
  ],
  invalid: [
    {
      name: 'an owned transaction provided on the current node',
      code: ['const t = task(function* () {', '  const tx = own(yield* wait(db.begin()));', '  current().addProvider(valueProvider(Tx, tx));', '});'].join('\n'),
      errors: [{ messageId: 'owned', line: 3, column: 43, endColumn: 45 }],
    },
    {
      name: 'ctx.own inline, on a named node',
      code: 'ctx.addProvider(valueProvider(K, ctx.own(x)));',
      errors: [{ messageId: 'owned', line: 1, column: 34 }],
    },
    { name: 'own with a release, inline', code: 'current().addProvider(valueProvider(K, own(x, (v) => v.close())));', errors: [{ messageId: 'owned' }] },
    {
      name: 'a variable initialized with ctx.own at module level',
      code: 'const lease = ctx.own(pool.acquire()); ctx.addProvider(valueProvider(Lease, lease));',
      errors: [{ messageId: 'owned' }],
    },
    { name: 'under a TypeScript cast', code: 'node.addProvider(valueProvider(K, own(x) as X));', errors: [{ messageId: 'owned' }] },
  ],
});
