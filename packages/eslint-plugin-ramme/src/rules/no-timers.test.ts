import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noTimers } from './no-timers.js';

ruleTester.run('no-timers', noTimers, {
  assertionOptions,
  valid: [
    { name: "ramme's sleep", code: 'const t = task(async () => { await sleep(20); });' },
    { name: 'ctx.sleep where no node is current', code: 'await app.sleep(10);' },
    { name: 'queueMicrotask is allowed', code: 'queueMicrotask(() => tick());' },
    { name: 'clearing a timer is allowed', code: 'clearTimeout(t); clearInterval(i); clearImmediate(m);' },
    { name: 'a function of its own named setTimeout', code: 'function setTimeout(f) { f(); } setTimeout(run);' },
    { name: 'a local variable named setInterval', code: 'const setInterval = fake(); setInterval(tick, 1);' },
    { name: 'a method named setTimeout on another object', code: 'scheduler.setTimeout(f, 10); this.setImmediate(g);' },
    { name: 'a timer name imported from another module', code: "import { setTimeout as delay } from 'my-timers'; await delay(10);" },
    { name: 'other names from the timers modules', code: "import { clearTimeout } from 'node:timers'; import { scheduler } from 'node:timers/promises';" },
    { name: 'a globalThis that is declared here', code: 'const globalThis = sandbox(); globalThis.setTimeout(f, 1);' },
  ],
  invalid: [
    {
      name: 'setTimeout',
      code: 'setTimeout(() => done(), 100);',
      errors: [{ messageId: 'call', data: { name: 'setTimeout' }, line: 1, column: 1, endColumn: 11 }],
    },
    {
      name: 'setInterval',
      code: 'const id = setInterval(tick, 1000);',
      errors: [{ messageId: 'call', data: { name: 'setInterval' } }],
    },
    {
      name: 'setImmediate',
      code: 'setImmediate(run);',
      errors: [{ messageId: 'call', data: { name: 'setImmediate' } }],
    },
    {
      name: 'a timer promise in a body',
      code: 'const t = task(async () => {\n  await new Promise((r) => setTimeout(r, 20));\n});',
      errors: [{ messageId: 'call', data: { name: 'setTimeout' }, line: 2, column: 28 }],
    },
    {
      name: 'through globalThis, window and global',
      code: "globalThis.setTimeout(f, 1); window.setInterval(f, 1); global.setImmediate(f); globalThis['setTimeout'](f, 1);",
      errors: [
        { messageId: 'call', data: { name: 'setTimeout' } },
        { messageId: 'call', data: { name: 'setInterval' } },
        { messageId: 'call', data: { name: 'setImmediate' } },
        { messageId: 'call', data: { name: 'setTimeout' } },
      ],
    },
    {
      name: 'an import from node:timers/promises, reported once, at the import',
      code: "import { setTimeout } from 'node:timers/promises';\nawait setTimeout(20);",
      errors: [{ messageId: 'import', data: { name: 'setTimeout', module: 'node:timers/promises' }, line: 1, column: 10 }],
    },
    {
      name: 'aliased and plain imports from timers/promises',
      code: "import { setTimeout as delay, setInterval } from 'timers/promises';",
      errors: [
        { messageId: 'import', data: { name: 'setTimeout', module: 'timers/promises' } },
        { messageId: 'import', data: { name: 'setInterval', module: 'timers/promises' } },
      ],
    },
    {
      name: 'imports from timers and node:timers',
      code: "import { setTimeout } from 'timers'; import { setImmediate } from 'node:timers';",
      errors: [
        { messageId: 'import', data: { name: 'setTimeout', module: 'timers' } },
        { messageId: 'import', data: { name: 'setImmediate', module: 'node:timers' } },
      ],
    },
  ],
});
