// The pins of no-generator-helper (stage 6a, decision 5), written before the rule: ramme has no helpers, so a
// generator function is a task body (free or bound, named or inline in `fork`/`attempt`), a `promised` body or an
// `own(value, function* (v) {…})` release entry, and nothing else. Reported: a generator declaration, a generator
// method (class or object literal), and a generator expression assigned to a variable or property or passed to
// anything but `task`, `promised`, `fork`, `attempt` and `own`. Every case imports from ramme, so the cases hold
// whether or not the rule looks at the file's imports.
import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noGeneratorHelper } from './no-generator-helper.js';

/** The rule's message, as the specification words it; a rule may go on after it (a reference). */
const message = /^a generator function is a task body; wrap it in task\(…\) \(ramme has no helpers: the tree is the call tree\)/;

const imports = "import { attempt, fork, own, promised, sleep, task, wait } from 'ramme';\n";

ruleTester.run('no-generator-helper', noGeneratorHelper, {
  assertionOptions,
  valid: [
    {
      name: 'a free task body',
      code: `${imports}export const handle = task(function* handle(req: Request) { yield* sleep(1); return req.url; });`,
    },
    {
      name: 'a free task body with options, and a with chain rooted in task',
      code: `${imports}export const poll = task(function* () { yield* sleep(1); }, { name: 'poll' }).with({ timeoutMs: 1000 });`,
    },
    {
      name: 'a bound task body: task(this, function* …)',
      code: `${imports}export class Api {\n  readonly #base = 'https://api';\n  readonly get = task(this, function* get(path: string) { yield* sleep(1); return this.#base + path; });\n}`,
    },
    {
      name: 'an inline fork body',
      code: `${imports}export const main = task(function* main() { fork(function* () { yield* sleep(1); }); });`,
    },
    {
      name: 'an inline attempt body',
      code: `${imports}export const main = task(function* main() { return yield* attempt(function* () { yield* sleep(1); return 1; }); });`,
    },
    {
      name: 'an own release entry',
      code: `${imports}export const main = task(function* main(tx: { rollback(): Promise<void> }) { own(tx, function* (tx) { yield* wait(tx.rollback()); }); });`,
    },
    {
      name: 'a promised body',
      code: `${imports}declare const db: { transaction(f: (tx: unknown) => Promise<void>): Promise<void> };\nexport const main = task(function* main() { yield* wait(db.transaction(promised(function* (tx) { yield* sleep(1); return void tx; }))); });`,
    },
    {
      name: 'a plain function and an async function are no generators',
      code: `${imports}export function parse(s: string) { return s; }\nexport async function load() { return 1; }\nexport const f = () => 1;`,
    },
    // Beyond the pins: the other body positions, and what the rule leaves alone (the plugin README).
    {
      name: 'an inline shield, unshield or node’s call body, and an onFailure handler',
      code: `${imports}declare const app: { call(b: () => Generator): Promise<unknown> };\nexport const main = task(function* main() { yield* shield(function* () { yield* unshield(function* () { yield* sleep(1); }); }); }, { onFailure: function* (e) { void e; yield* sleep(1); } });\nawait app.call(function* main() { yield* sleep(1); });`,
    },
    {
      name: 'an onFailure handler written as a generator method: the same handler',
      code: `${imports}export const main = task(function* main() { yield* sleep(1); }, { *onFailure(e) { void e; yield* sleep(1); } });`,
    },
    { name: 'an async generator is no ramme generator', code: `${imports}export async function* lines() { yield 'x'; }` },
    {
      name: 'the iterator protocol’s generator methods',
      code: `${imports}export class Bag {\n  *[Symbol.iterator]() { yield 1; }\n  async *[Symbol.asyncIterator]() { yield 1; }\n}\nexport const it = { *[Symbol.iterator]() { yield 2; } };`,
    },
    { name: 'a file that does not import ramme is not checked', code: 'export function* range(n: number) { for (let i = 0; i < n; i++) yield i; }' },
  ],
  invalid: [
    {
      name: 'a top-level generator declaration: a helper',
      code: `${imports}function* parse(req: Request) {\n  yield* sleep(1);\n  return req.url;\n}`,
      errors: [{ message, line: 2 }],
    },
    {
      name: 'an exported generator declaration',
      code: `${imports}export function* load(id: string) {\n  yield* sleep(1);\n  return id;\n}`,
      errors: [{ message, line: 2 }],
    },
    {
      name: 'a generator declaration nested in a task body',
      code: `${imports}export const main = task(function* main() {\n  function* step() { yield* sleep(1); }\n  yield* step();\n});`,
      errors: [{ message, line: 3 }],
    },
    {
      name: 'a generator method of a class',
      code: `${imports}export class Parser {\n  *parse() { yield* sleep(1); }\n}`,
      errors: [{ message, line: 3 }],
    },
    {
      name: 'a generator method of an object literal',
      code: `${imports}export const helpers = {\n  *parse() { yield* sleep(1); },\n};`,
      errors: [{ message, line: 3 }],
    },
    // Beyond the pins: a method named onFailure that is no option of a call.
    {
      name: 'a generator method named onFailure of a class, and a computed one: no failure handler’s option',
      code: `${imports}export class Handlers {\n  *onFailure() { yield* sleep(1); }\n}\nexport const h = {\n  *['onFailure']() { yield* sleep(1); },\n};`,
      errors: [
        { message, line: 3 },
        { message, line: 6 },
      ],
    },
    {
      name: 'a generator expression assigned to a variable',
      code: `${imports}export const parse = function* () { yield* sleep(1); };`,
      errors: [{ message, line: 2 }],
    },
    {
      name: 'a generator expression assigned to a property',
      code: `${imports}declare const helpers: Record<string, unknown>;\nhelpers.parse = function* () { yield* sleep(1); };`,
      errors: [{ message, line: 3 }],
    },
    {
      name: 'a generator expression passed to anything else',
      code: `${imports}declare const steps: unknown[];\nsteps.push(function* () { yield* sleep(1); });`,
      errors: [{ message, line: 3 }],
    },
  ],
});
