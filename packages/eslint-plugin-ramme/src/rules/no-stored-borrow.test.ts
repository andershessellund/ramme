import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noStoredBorrow } from './no-stored-borrow.js';

const field = { messageId: 'stored', data: { where: 'a class field' } } as const;
const onThis = { messageId: 'stored', data: { where: 'a property of `this`' } } as const;
const moduleVar = { messageId: 'stored', data: { where: 'a module variable' } } as const;

ruleTester.run('no-stored-borrow', noStoredBorrow, {
  assertionOptions,
  valid: [
    { name: 'lookup used locally inside a method', code: 'class S { run() { const db = lookup(Db); return db.query(); } }' },
    { name: 'inject in a field', code: 'class S { readonly #db = inject(Db); readonly url = inject(Config).url; }' },
    { name: 'inject assigned to this in a constructor', code: 'class S { constructor() { this.db = inject(Db); } }' },
    { name: 'lookup in a task body', code: 'const t = task(function* () { const api = lookup(Api); yield* api.get(); });' },
    { name: 'lookup in a function-scope variable', code: 'function f() { const x = lookup(X); return x.y; }' },
    { name: 'a field holding a function that looks up', code: 'class S { readonly db = () => lookup(Db); }' },
    { name: 'the #ctx idiom', code: 'class S { readonly #ctx = current(); get db() { return this.#ctx.get(Db); } }' },
    { name: 'a module variable that is not a borrow', code: 'export const app = createRootContext(); const db = app.get(Db);' },
    { name: 'lookup assigned to a property of another object', code: 'function f(o) { o.db = lookup(Db); }' },
    { name: 'a plain constructor parameter default, not a parameter property', code: 'class S { constructor(db = lookup(Db)) { db.ping(); } }' },
    { name: 'a parameter property with no default', code: 'class S { constructor(private readonly db: Db) {} }' },
    { name: 'an auto-accessor holding inject', code: 'class S { accessor db = inject(Db); }' },
  ],
  invalid: [
    {
      name: 'a private field initializer',
      code: 'class S { readonly #db = lookup(Db); }',
      errors: [{ ...field, line: 1, column: 26, endColumn: 36 }],
    },
    { name: 'a member read on the borrow, in a field', code: 'class S { pool = lookup(Db).pool; }', errors: [field] },
    { name: 'a static field', code: 'class S { static cache = lookup(Cache); }', errors: [field] },
    {
      name: 'an auto-accessor field',
      code: 'class S { accessor db = lookup(Db); }',
      errors: [{ ...field, line: 1, column: 25, endColumn: 35 }],
    },
    { name: 'a static auto-accessor field, from a member chain', code: 'class S { static accessor pool = lookup(Db).pool; }', errors: [field] },
    {
      name: 'a parameter property default',
      code: 'class S { constructor(private readonly db = lookup(Db)) {} }',
      errors: [{ ...onThis, line: 1, column: 45, endColumn: 55 }],
    },
    { name: 'a public parameter property default, from a member chain', code: 'class S { constructor(public pool = lookup(Db).pool) {} }', errors: [onThis] },
    { name: 'under a TypeScript cast, in a field', code: 'class S { readonly db = lookup(Db) as Database; }', errors: [field] },
    { name: 'assigned to this in a constructor', code: 'class S { constructor() { this.db = lookup(Db); } }', errors: [onThis] },
    {
      name: 'assigned to a private member of this, with a non-null assertion',
      code: 'class S { #log; init() { this.#log = lookup(Logger)!; } }',
      errors: [onThis],
    },
    { name: 'a logical assignment to this', code: 'class S { m() { this.x ??= lookup(X); } }', errors: [onThis] },
    { name: 'an exported module variable', code: 'export const db = lookup(Db);', errors: [{ ...moduleVar, line: 1, column: 19 }] },
    { name: 'a module variable from a member chain', code: 'const settings = lookup(Config).app?.settings;', errors: [moduleVar] },
    { name: 'a module let with options', code: 'let api = lookup(Api, { optional: true });', errors: [moduleVar] },
  ],
});
