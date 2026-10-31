// browser-smoke.test.ts — the browser is a target (D41, decisions 18 and 19; D43): the core and `ramme/platform`
// run through their public entries on what a browser has. `pnpm test` runs this file under Node, and
// `pnpm test:browser` (vitest.browser.config.ts) runs it unchanged in headless Chromium, as CI does; so it imports
// nothing from Node and reads no `process`. The static half, that the build output needs nothing a browser lacks, is
// browser-static.test.ts, which reads files and so runs under Node only.
//
// - A body runs the core's verbs together (`task`, `call`, `fork`, `join`, `sleep`, `wait`, `own`, DI with a declared
//   scope, a halt whose `finally` waits): nothing of it needs an adapter, a registration or a Node API.
// - README's search box ("The platform"), trimmed to a 20 ms debounce, runs on an `EventTarget`
//   and a stubbed `fetch` (the test's server, in either runtime): `listen` re-enters the bodiless box, a keystroke
//   halts the previous search at its `sleep` or aborts its `fetch`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context, Fiber } from '../index.js';
import { RequestScope, createRootContext, fork, join, lookup, own, result, sleep, task, wait } from '../index.js';
import { fetch, listen } from '../platform.js';
import { trace, within } from './util.js';

const roots: Context[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
  vi.unstubAllGlobals();
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

describe('the browser is a target: the core and ramme/platform through their public entries', () => {
  it('a body runs task, call, fork, join, sleep, wait and own, with a request-scoped service, and a halt runs a finally that waits', async () => {
    const t = trace();
    let sessions = 0;
    class Session {
      static readonly scope = RequestScope; // stored on the request's node, released with it
      readonly id = ++sessions;
      constructor() {
        own(t.at(`session ${this.id} released`));
      }
    }
    const double = task(function* (n: number) {
      yield* sleep(1);
      return n * 2;
    });
    const handle = task(
      function* (n: number) {
        const session = lookup(Session);
        own(t.at(`request ${n} released`));
        const a = yield* double(n);
        const f = fork(double, n + 1);
        const b = yield* wait(Promise.resolve(10));
        const c = yield* join(f);
        return { session: session.id, sum: a + b + c, shared: lookup(Session) === session };
      },
      { scopes: [RequestScope] },
    );
    const slow = task(function* () {
      try {
        yield* sleep(10_000);
        t.push('after the sleep');
      } finally {
        t.push('finally');
        yield* wait(new Promise((resolve) => setTimeout(resolve, 2))); // release work: the halt lets it finish
        t.push('finally waited');
      }
    });
    const root = app();
    const seen = await within(
      root.call(function* () {
        const first = yield* handle(1);
        const second = yield* handle(2);
        const f = fork(slow);
        yield* sleep(1);
        f.abort();
        const halted = yield* result(f);
        return { first, second, halted: halted.status };
      }),
    );
    expect({ seen, log: t.log }).toEqual({
      seen: {
        first: { session: 1, sum: 2 + 10 + 4, shared: true },
        second: { session: 2, sum: 4 + 10 + 6, shared: true },
        halted: 'aborted',
      },
      log: ['request 1 released', 'session 1 released', 'request 2 released', 'session 2 released', 'finally', 'finally waited'],
    });
  });

  it("README's search box: listen re-enters the bodiless box, a keystroke halts the previous search at its debounce or aborts its fetch", async () => {
    const requests: { url: string; signal: AbortSignal; respond: (body: unknown) => void }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit): Promise<Response> => {
      const { promise, resolve, reject } = Promise.withResolvers<Response>();
      const signal = init!.signal!;
      requests.push({ url, signal, respond: (body) => resolve(new Response(JSON.stringify(body))) });
      signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
      return promise;
    });
    const shown: unknown[] = [];
    const errors: unknown[] = [];
    const search = task(function* search(q: string) {
      yield* sleep(20); // debounce: a newer keystroke halts this run here
      const res = yield* fetch(`/search?q=${encodeURIComponent(q)}`); // a halt aborts the request
      shown.push(yield* wait(res.json()));
    });
    const input = Object.assign(new EventTarget(), { value: '' });
    const type = (value: string): void => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    const root = app();
    const box = root.child({ name: 'search-box' });
    let latest: Fiber<void> | undefined;
    box.run(() =>
      listen(input, 'input', () => {
        latest?.abort(); // the previous run stops at its sleep or its fetch
        latest = fork(search.with({ onFailure: (e) => void errors.push(e) })(input.value)); // box is bodiless: a handler
      }),
    );
    type('a');
    type('ab'); // halts 'a' at its debounce: 'a' is never fetched
    while (requests.length < 1) await new Promise((r) => setTimeout(r, 1));
    type('abc'); // aborts the fetch of 'ab'
    while (requests.length < 2) await new Promise((r) => setTimeout(r, 1));
    requests[1]!.respond({ q: 'abc', hits: 3 });
    while (shown.length < 1) await new Promise((r) => setTimeout(r, 1));
    await within(box.close());
    expect({
      urls: requests.map((r) => r.url),
      aborted: requests.map((r) => r.signal.aborted),
      shown,
      errors,
      boxOutcome: box.outcome?.status,
    }).toEqual({
      urls: ['/search?q=ab', '/search?q=abc'],
      aborted: [true, false],
      shown: [{ q: 'abc', hits: 3 }],
      errors: [],
      boxOutcome: 'success',
    });
  });
});
