import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noBareFetch } from './no-bare-fetch.js';

ruleTester.run('no-bare-fetch', noBareFetch, {
  assertionOptions,
  valid: [
    {
      name: 'fetch from ramme/platform',
      code: "import { task, wait } from 'ramme';\nimport { fetch } from 'ramme/platform';\nconst t = task(function* (u: string) { const res = yield* fetch(u); return yield* wait(res.json()); });",
    },
    {
      name: 'a file that does not import ramme is not flagged, generator or not',
      code: 'function* g(u) { const p = fetch(u); yield p; }\nasync function main() { await fetch(url); }',
    },
    {
      name: 'fetch in plain async code of a file that uses ramme: the op would need a current node there',
      code: "import { createRootContext } from 'ramme';\nasync function warm() { await fetch('/health'); }\nawait fetch('/boot');",
    },
    {
      name: 'a fetch this file declares',
      code: "import { task } from 'ramme';\nimport fetch from 'node-fetch';\nconst t = task(function* (u) { yield* wait(fetch(u)); });",
    },
    { name: 'a method named fetch on another object', code: "import { task } from 'ramme';\nfunction* body() { yield* wait(cache.fetch(key)); }" },
    { name: 'globalThis.fetch outside a body', code: "import { createRootContext } from 'ramme';\nawait globalThis.fetch('/boot');" },
  ],
  invalid: [
    {
      name: 'a bare fetch in a body: the fix adds the import after the last ramme import',
      code: "import { task, wait } from 'ramme';\nconst t = task(function* (u: string) {\n  const res = yield* wait(fetch(u));\n  return res.status;\n});",
      output:
        "import { task, wait } from 'ramme';\nimport { fetch } from 'ramme/platform';\nconst t = task(function* (u: string) {\n  const res = yield* wait(fetch(u));\n  return res.status;\n});",
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' }, line: 3, column: 27 }],
    },
    {
      name: 'the fix joins an existing ramme/platform import',
      code: "import { wait } from 'ramme';\nimport { listen } from 'ramme/platform';\nfunction* body(u) { return yield* wait(fetch(u)); }",
      output: "import { wait } from 'ramme';\nimport { listen, fetch } from 'ramme/platform';\nfunction* body(u) { return yield* wait(fetch(u)); }",
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' } }],
    },
    {
      name: 'the wait-with-a-signal idiom is reported too, and fixed: the function wait is handed runs in the node',
      code: "import { wait } from 'ramme';\nclass Api { *get(path) { return yield* wait((signal) => fetch(path, { signal })); } }",
      output: "import { wait } from 'ramme';\nimport { fetch } from 'ramme/platform';\nclass Api { *get(path) { return yield* wait((signal) => fetch(path, { signal })); } }",
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' } }],
    },
    {
      name: 'two calls: one fix for the file',
      code: "import type { Op } from 'ramme';\nfunction* body() { const a = yield* wait(fetch('/a')); const b = yield* wait(fetch('/b')); }",
      output:
        "import type { Op } from 'ramme';\nimport { fetch } from 'ramme/platform';\nfunction* body() { const a = yield* wait(fetch('/a')); const b = yield* wait(fetch('/b')); }",
      errors: [
        { messageId: 'bare', data: { form: 'fetch(…)' } },
        { messageId: 'bare', data: { form: 'fetch(…)' } },
      ],
    },
    {
      name: 'no fix when the file also fetches outside a body: the import would shadow that fetch too',
      code: "import { wait } from 'ramme';\nasync function warm() { await fetch('/health'); }\nfunction* body(u) { return yield* wait(fetch(u)); }",
      output: null,
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' }, line: 3 }],
    },
    {
      name: 'no fix for a fetch whose result is dropped: the op would send nothing',
      code: "import { wait } from 'ramme';\nfunction* a() { fetch('/beacon', { method: 'POST' }); }",
      output: null,
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' }, line: 2 }],
    },
    {
      name: 'no fix for one dropped under void, through a cast',
      code: "import { wait } from 'ramme';\nfunction* a() { void (fetch('/beacon') as unknown); }",
      output: null,
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' }, line: 2 }],
    },
    {
      name: 'no fix for one used as a promise: the op is a plain thenable, so .catch would throw',
      code: "import { wait } from 'ramme';\nfunction* body(u) { const r = yield* wait(fetch(u).catch(() => null)); return r; }",
      output: null,
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' }, line: 2 }],
    },
    {
      name: 'no fix for .finally, through a cast',
      code: "import { wait } from 'ramme';\nfunction* body(u: string) { yield* wait((fetch(u) as Promise<Response>).finally(() => {})); }",
      output: null,
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' }, line: 2 }],
    },
    {
      name: 'no fix for .catch down a .then chain: the op’s then is a PromiseLike’s',
      code: "import { wait } from 'ramme';\nfunction* body(u) { return yield* wait(fetch(u).then((r) => r.json()).catch(() => null)); }",
      output: null,
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' }, line: 2 }],
    },
    {
      name: 'no fix for a plain yield: a generator that hands the request to its consumer is no body',
      code: "import { wait } from 'ramme';\nfunction* urls(a, b) { yield fetch(a); yield fetch(b).then((r) => r.status); }",
      output: null,
      errors: [
        { messageId: 'bare', data: { form: 'fetch(…)' } },
        { messageId: 'bare', data: { form: 'fetch(…)' } },
      ],
    },
    {
      name: 'a .then chain is a thenable’s use, and fixed',
      code: "import { wait } from 'ramme';\nfunction* body(u) { return yield* wait(fetch(u).then((r) => r.json()).then((j) => j.items)); }",
      output:
        "import { wait } from 'ramme';\nimport { fetch } from 'ramme/platform';\nfunction* body(u) { return yield* wait(fetch(u).then((r) => r.json()).then((j) => j.items)); }",
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' } }],
    },
    {
      name: 'no fix for one in a later callback, which runs with no current node',
      code: "import { wait } from 'ramme';\nfunction* b(p) { yield* wait(p.then(() => fetch('/next'))); }",
      output: null,
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' }, line: 2 }],
    },
    {
      name: 'with the browser globals configured (globals.browser), fetch is still the global',
      code: "import { wait } from 'ramme';\nfunction* body(u) { return yield* wait(fetch(u)); }",
      languageOptions: { globals: { fetch: 'readonly', window: 'readonly' } },
      output: "import { wait } from 'ramme';\nimport { fetch } from 'ramme/platform';\nfunction* body(u) { return yield* wait(fetch(u)); }",
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' } }],
    },
    {
      name: 'no fix when the global is read as a value',
      code: "import { wait } from 'ramme';\nconst f = fetch;\nfunction* body(u) { return yield* wait(fetch(u)); }",
      output: null,
      errors: [{ messageId: 'bare', data: { form: 'fetch(…)' }, line: 3 }],
    },
    {
      name: 'through globalThis, window and self, never fixed',
      code: "import { wait } from 'ramme';\nfunction* body(u) { yield* wait(globalThis.fetch(u)); yield* wait(window.fetch(u)); yield* wait(self.fetch(u)); }",
      output: null,
      errors: [
        { messageId: 'bare', data: { form: 'globalThis.fetch(…)' } },
        { messageId: 'bare', data: { form: 'window.fetch(…)' } },
        { messageId: 'bare', data: { form: 'self.fetch(…)' } },
      ],
    },
  ],
});
