// The pins of named-task (stage 6a, decision 10; the `style` preset), written before the rule: a node is named after
// its task's body (`body.name`) unless the options give a `name`, and a function expression passed as an argument has
// no name of its own, so `const poll = task(function* () {…})` makes nodes named `anonymous`. Reported: a `task(…)`,
// free or bound (`task(this, …)`), whose body is an anonymous generator or an arrow and whose options carry no `name`.
import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { namedTask } from './named-task.js';

/** The rule's message, as the specification words it; a rule may go on after it (a reference). */
const message = /^name the generator \(function\* name\) or pass \{ name \}: the node is named after it/;

const imports = "import { fork, sleep, task } from 'ramme';\n";

ruleTester.run('named-task', namedTask, {
  assertionOptions,
  valid: [
    { name: 'a named generator', code: `${imports}export const poll = task(function* poll() { yield* sleep(1); });` },
    { name: 'an anonymous generator with a name option', code: `${imports}export const poll = task(function* () { yield* sleep(1); }, { name: 'poll' });` },
    { name: 'a name among other options', code: `${imports}export const poll = task(function* () { yield* sleep(1); }, { timeoutMs: 1000, name: 'poll' });` },
    { name: 'an arrow with a name option', code: `${imports}declare const leaf: () => Generator<never, number>;\nexport const t = task(() => leaf(), { name: 'leaf' });` },
    {
      name: 'a bound task with a named generator',
      code: `${imports}export class Api {\n  readonly get = task(this, function* get(path: string) { yield* sleep(1); return path; });\n}`,
    },
    {
      name: 'a bound task with a name option',
      code: `${imports}export class Api {\n  readonly get = task(this, function* (path: string) { yield* sleep(1); return path; }, { name: 'get' });\n}`,
    },
    { name: 'a body passed by name: it is named', code: `${imports}import { poll } from './poll';\nexport const t = task(poll);` },
    { name: 'an inline fork body is no task(…)', code: `${imports}export const main = task(function* main() { fork(function* () { yield* sleep(1); }); });` },
    // Beyond the pins: options the syntax cannot read may carry a name (the plugin README).
    {
      name: 'options spread or passed by name may carry a name',
      code: `${imports}declare const opts: { name: string };\nexport const a = task(function* () {}, { ...opts });\nexport const b = task(() => 1, opts);`,
    },
    { name: 'a quoted name key', code: `${imports}export const poll = task(function* () { yield* sleep(1); }, { 'name': 'poll' });` },
    {
      name: 'a with(…) chained on the task names it: with takes the name option',
      code: `${imports}export const poll = task(function* () { yield* sleep(1); }).with({ name: 'poll' });\nexport const tick = task(() => 1).with({ timeoutMs: 5 }).with({ name: 'tick' });\ntype Cast = { with(o: object): unknown };\nexport const cast = (task(() => 3) as Cast).with({ name: 'cast' });`,
    },
  ],
  invalid: [
    {
      name: 'an anonymous generator: the variable does not name the node',
      code: `${imports}export const poll = task(function* () {\n  yield* sleep(1);\n});`,
      errors: [{ message, line: 2 }],
    },
    { name: 'an arrow', code: `${imports}declare const leaf: () => Generator<never, number>;\nexport const t = task(() => leaf());`, errors: [{ message, line: 3 }] },
    {
      name: 'options without a name',
      code: `${imports}export const poll = task(function* () { yield* sleep(1); }, { timeoutMs: 1000 });`,
      errors: [{ message, line: 2 }],
    },
    {
      name: 'a bound task with an anonymous generator',
      code: `${imports}export class Api {\n  readonly get = task(this, function* (path: string) { yield* sleep(1); return path; });\n}`,
      errors: [{ message, line: 3 }],
    },
    // Beyond the pins: what does not name it after the call.
    {
      name: 'a with(…) chain that gives no name, a name given to another method, and a with that is not called',
      code: `${imports}export const poll = task(function* () { yield* sleep(1); }).with({ timeoutMs: 5 });\nexport const p = task(() => 1).bind({ name: 'p' });\ndeclare function wrap(f: unknown, o: unknown): unknown;\nexport const w = wrap(task(() => 2).with, { name: 'w' });`,
      errors: [
        { message, line: 2 },
        { message, line: 3 },
        { message, line: 5 },
      ],
    },
  ],
});
