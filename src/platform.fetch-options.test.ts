// Tests for platform / fetch options.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fork, join, never, result, sleep } from './ambient.js';
import type { Context } from './context.js';
import { createInjectionKey } from './context-key.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { fetch, listen, nextFrame } from './platform.js';
import { trace, within } from '../tests/support/util.js';
import type { Trace } from '../tests/support/util.js';
import { showError as show } from '../tests/support/observations.js';

const roots: Context[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** One call of the fake `globalThis.fetch`: pending until `respond`; rejected with an `AbortError` when its signal fires. */
interface FetchCall {
  readonly input: unknown;
  readonly init: RequestInit | undefined;
  readonly signal: AbortSignal | undefined;
  readonly respond: (r: Response) => void;
}

function installFetch(t: Trace): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit): Promise<Response> => {
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const s = init?.signal ?? undefined;
    calls.push({ input, init, signal: s, respond: resolve });
    const onAbort = (): void => {
      t.push('fetch aborted');
      reject(new DOMException('This operation was aborted', 'AbortError'));
    };
    if (s?.aborted) onAbort();
    else s?.addEventListener('abort', onAbort, { once: true });
    return promise;
  });
  return calls;
}

// --- fetch -------------------------------------------------------------------------------------------------------

describe('platform: fetch', () => {
  it("in a halted finally fetch is handed the unwind fiber's release deadline, not the fired signal(): a cleanup request runs to its end", async () => {
    const t = trace();
    const calls = installFetch(t);
    const stop = new Error('stop');
    const root = app();
    const seen = await within(
      root.call(function* () {
        const f = fork(
          task(function* () {
            try {
              yield* never();
            } finally {
              const res = yield* fetch('/cleanup', { method: 'DELETE' });
              t.push(`cleanup ${res.status}`);
            }
          }),
        );
        yield* sleep(1);
        f.abort(stop);
        while (calls.length === 0) yield* sleep(1);
        const handedAborted = calls[0]!.signal?.aborted;
        calls[0]!.respond(new Response(null, { status: 204 }));
        return { outcome: show(yield* result(f), { stop }), handedAborted };
      }),
    );
    expect({ ...seen, log: t.log }).toEqual({ outcome: 'aborted(stop)', handedAborted: false, log: ['cleanup 204'] });
  });

  it("a Request input keeps its own signal, referrer and referrer policy: the init fetch passes on would replace them (the Fetch standard's Request(input, init)), so it carries them", async () => {
    const t = trace();
    const calls = installFetch(t);
    const user = new AbortController();
    const root = app();
    const seen = await within(
      root.call(function* () {
        const req = new Request('http://example.test/slow', { signal: user.signal, referrer: '', referrerPolicy: 'no-referrer' });
        const f = fork(
          task(function* () {
            try {
              yield* fetch(req);
              return 'fetched';
            } catch (e) {
              return (e as Error).name;
            }
          }),
        );
        while (calls.length === 0) yield* sleep(1);
        // What the global builds from the call: the Request with the init laid over it.
        const built = new Request(calls[0]!.input as Request, calls[0]!.init);
        user.abort(); // the Request's own signal
        return {
          caught: yield* join(f),
          handedAborted: calls[0]!.signal?.aborted,
          referrer: built.referrer,
          referrerPolicy: built.referrerPolicy,
        };
      }),
    );
    expect(seen).toEqual({ caught: 'AbortError', handedAborted: true, referrer: '', referrerPolicy: 'no-referrer' });
  });
});

// --- the guards ----------------------------------------------------------------------------------------------------

describe('platform: the guards name the primitive', () => {
  it('fetch(), nextFrame() and listen() outside a node, and fetch() and nextFrame() during a creation, throw the core’s errors naming themselves, not the verb they are built on', () => {
    const head = (f: () => unknown): string => {
      try {
        f();
        return 'returned';
      } catch (e) {
        return e instanceof Error ? `${e.constructor.name}: ${e.message.split(' ').slice(0, 2).join(' ')}` : String(e);
      }
    };
    const inCreation: Record<string, string> = {};
    const SERVICE = createInjectionKey<object>('SERVICE', {
      factory: () => {
        inCreation.fetch = head(() => fetch('http://example.test/'));
        inCreation.nextFrame = head(() => nextFrame());
        return {};
      },
    });
    app().get(SERVICE);
    expect({
      outside: {
        fetch: head(() => fetch('http://example.test/')),
        nextFrame: head(() => nextFrame()),
        listen: head(() => listen(new EventTarget(), 'ping', () => {})),
      },
      inCreation,
    }).toEqual({
      outside: {
        fetch: 'NoCurrentNodeError: fetch() called',
        nextFrame: 'NoCurrentNodeError: nextFrame() called',
        listen: 'NoCurrentNodeError: listen() called',
      },
      inCreation: { fetch: 'CreationViolationError: fetch() during', nextFrame: 'CreationViolationError: nextFrame() during' },
    });
  });
});
