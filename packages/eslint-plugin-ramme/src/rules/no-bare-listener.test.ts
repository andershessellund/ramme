import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noBareListener } from './no-bare-listener.js';

ruleTester.run('no-bare-listener', noBareListener, {
  assertionOptions,
  valid: [
    {
      name: 'listen in a body',
      code: "import { listen } from 'ramme/platform';\nconst t = task(function* () { listen(input, 'input', () => fork(search, input.value)); yield* never(); });",
    },
    {
      name: 'a top-level listener names its node: the README’s server.on',
      code: "server.on('request', (req) => app.fork(handle.with({ onFailure: log }), req));\nwindow.addEventListener('load', boot);",
    },
    { name: 'a plain async function is not ramme code', code: "async function main() { el.addEventListener('click', h); el.onclick = h; }" },
    { name: 'a class that does not use ramme', code: "class Widget { constructor() { this.el.addEventListener('click', () => this.toggle()); } }" },
    { name: 'removing a handler', code: 'function* body() { el.onclick = null; ws.onmessage = undefined; el.removeEventListener("x", h); em.off("x", h); }' },
    { name: 'a camelCase property is no platform handler', code: 'function* body() { this.onReady = done; options.onFailure = log; }' },
    {
      name: 'an on… data property assigned a value that is never a function',
      code: 'class Svc { *run() { this.online = true; opts.once = true; this.one = 1; state.ongoing = !busy; this.onx = `${a}`; el.ontick = n > 0 ? 1 : -1; } }',
    },
    {
      name: 'a common word that names no handler, whatever it is assigned',
      code: "class S { #a = inject(A); constructor() { this.online = navigator.onLine; opts.once = v; this.only = pick(); } }",
    },
    { name: 'an arithmetic compound assignment stores no handler', code: 'function* body() { this.ontime += delta; this.onx -= 1; }' },
    { name: 'an emitter call with one argument', code: 'function* body() { stream.on(handlers); }' },
    { name: 'an async generator is no body', code: "async function* lines(s) { s.on('data', push); }" },
    { name: 'a local function named addEventListener', code: 'function* body() { const addEventListener = (a, b) => [a, b]; addEventListener(1, 2); }' },
  ],
  invalid: [
    {
      name: 'addEventListener in a body',
      code: "const t = task(function* () {\n  el.addEventListener('click', onClick);\n});",
      errors: [{ messageId: 'bare', data: { form: 'addEventListener' }, line: 2, column: 3 }],
    },
    {
      name: 'addEventListener with { signal: signal() } is still a bare listener: the callback runs outside the node',
      code: "function* body() { el.addEventListener('click', () => lookup(Log).info('x'), { signal: signal() }); }",
      errors: [{ messageId: 'bare', data: { form: 'addEventListener' } }],
    },
    {
      name: 'the window’s bare addEventListener, in a nested callback of a body',
      code: "function* body() { items.forEach((i) => addEventListener('resize', () => i.fit())); }",
      errors: [{ messageId: 'bare', data: { form: 'addEventListener' } }],
    },
    {
      name: 'an emitter’s on, once and addListener in a generator method',
      code: "class Reader { *read(s) { s.on('data', push); s.once('end', done); s.addListener('error', fail); } }",
      errors: [
        { messageId: 'bare', data: { form: '.on(…)' } },
        { messageId: 'bare', data: { form: '.once(…)' } },
        { messageId: 'bare', data: { form: '.addListener(…)' } },
      ],
    },
    {
      name: 'an on<event> assignment in a body, a logical one too',
      code: 'function* body() { ws.onmessage = (e) => handle(e); ws.onerror ??= report; }',
      errors: [
        { messageId: 'bare', data: { form: 'onmessage =' } },
        { messageId: 'bare', data: { form: 'onerror ??=' } },
      ],
    },
    {
      name: 'an on<event> assignment of a value that can be a function: a member, a call, a choice with one',
      code: 'function* body() { el.onclick = this.handlers.click; el.onload = make(); el.onerror = ok ? report : null; ws.ononline = sync; }',
      errors: [
        { messageId: 'bare', data: { form: 'onclick =' } },
        { messageId: 'bare', data: { form: 'onload =' } },
        { messageId: 'bare', data: { form: 'onerror =' } },
        { messageId: 'bare', data: { form: 'ononline =' } },
      ],
    },
    {
      name: 'a service constructor: a class that injects is built under a node',
      code: "class Presence {\n  readonly #api = inject(Api);\n  constructor() {\n    window.addEventListener('online', () => this.#api.sync());\n  }\n}",
      errors: [{ messageId: 'bare', data: { form: 'addEventListener' }, line: 4 }],
    },
    {
      name: 'a class with a generator method uses ramme',
      code: "class Feed {\n  constructor(el) { el.onscroll = () => this.more(); }\n  *more() { yield* call(load); }\n}",
      errors: [{ messageId: 'bare', data: { form: 'onscroll =' }, line: 2 }],
    },
  ],
});
