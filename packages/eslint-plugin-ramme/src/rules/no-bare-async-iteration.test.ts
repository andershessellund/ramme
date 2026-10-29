import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noBareAsyncIteration } from './no-bare-async-iteration.js';

ruleTester.run('no-bare-async-iteration', noBareAsyncIteration, {
  assertionOptions,
  valid: [
    {
      name: 'each in a body',
      code: "import { task } from 'ramme';\nimport { each } from 'ramme/platform';\nconst t = task(function* (s) { for (const x of yield* each(s)) { use(x); yield* each.next(); } });",
    },
    {
      name: 'a file that does not import ramme: an async function and an async generator',
      code: 'async function main(s) { for await (const x of s) use(x); }\nasync function* lines(s) { for await (const c of s) yield* split(c); }',
    },
    { name: 'a synchronous for…of in a file that uses ramme', code: "import { all } from 'ramme';\nfunction* b(xs) { for (const x of xs) use(x); }" },
  ],
  invalid: [
    {
      name: 'for await anywhere in a file that imports ramme, top level included',
      code: "import { createRootContext } from 'ramme';\nfor await (const line of rl) {\n  handle(line);\n}\nasync function drain(s) { for await (const _ of s); }",
      errors: [
        { messageId: 'forAwait', line: 2, column: 1, endLine: 2, endColumn: 28 },
        { messageId: 'forAwait', line: 5 },
      ],
    },
    {
      name: 'for await in an async callback inside a generator body, in a file that does not import ramme',
      code: 'function* body(s) {\n  yield* wait((async () => { for await (const x of s) use(x); })());\n}',
      errors: [{ messageId: 'forAwait', line: 2 }],
    },
  ],
});
