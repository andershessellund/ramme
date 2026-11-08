// Tests for platform / fetch.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fork, result, signal, sleep, wait } from './ambient.js';
import type { Context } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { fetch } from './platform.js';
import { trace, within } from '../tests/support/util.js';
import type { Trace } from '../tests/support/util.js';
import { labelError as label, showError as show } from '../tests/support/observations.js';

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

afterEach(async () => {
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
  vi.unstubAllGlobals();
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

// --- fakes -------------------------------------------------------------------------------------------------------

/** One call of the fake `globalThis.fetch`. */
interface FetchCall {
  readonly input: unknown;
  readonly init: RequestInit | undefined;
  /** The signal the call was handed. */
  readonly signal: AbortSignal | undefined;
  /** Settle the call with a response. */
  readonly respond: (r: Response) => void;
}

/**
 * A fake `globalThis.fetch` that records each call and stays pending until `respond`; when its signal fires it
 * rejects with an `AbortError`, 5 ms later, as a network stack does (so "the wait finishes" is observable: the body
 * is returned after the rejection, never at the abort). Traces `fetch`, `abort heard` and `fetch rejected`.
 */
function installFetch(t: Trace): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit): Promise<Response> => {
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const signal = init?.signal ?? undefined;
    calls.push({ input, init, signal, respond: resolve });
    t.push('fetch');
    const onAbort = (): void => {
      t.push('abort heard');
      setTimeout(() => {
        t.push('fetch rejected');
        reject(new DOMException('This operation was aborted', 'AbortError'));
      }, 5);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    return promise;
  });
  return calls;
}

// --- fetch -------------------------------------------------------------------------------------------------------

describe('fetch', () => {
  it("fetch is a wait over globalThis.fetch, run when yielded: it passes input and init on, with a signal that combines init.signal with the body's", async () => {
    const t = trace();
    const calls = installFetch(t);
    // The global's signature: whatever globalThis.fetch takes, fetch takes, so the lint can autofix the import.
    const sameParameters: (...args: Parameters<typeof globalThis.fetch>) => PromiseLike<Response> = fetch;
    expect(typeof sameParameters).toBe('function');
    const user = new AbortController();
    const root = app();
    const seen = await within(
      root.call(function* () {
        const op = fetch('/search?q=a', { method: 'POST', headers: { 'x-test': '1' } });
        const callsWhenMade = calls.length; // a work op is lazy (decision 2)
        setTimeout(() => calls[0]?.respond(new Response('ok', { status: 201 })), 1);
        const res = yield* op;
        const text = yield* wait(res.text());
        const second = fetch('/slow', { signal: user.signal });
        setTimeout(() => user.abort(), 1);
        let caught = 'nothing';
        try {
          yield* second;
        } catch (e) {
          caught = (e as Error).name; // init.signal's abort is the fetch's own failure, thrown at the yield*
        }
        return {
          callsWhenMade,
          input: calls[0]!.input,
          method: calls[0]!.init?.method,
          header: new Headers(calls[0]!.init?.headers).get('x-test'),
          status: res.status,
          text,
          handedASignal: calls[0]!.signal instanceof AbortSignal,
          firstAborted: calls[0]!.signal?.aborted,
          secondInput: calls[1]!.input,
          secondAborted: calls[1]!.signal?.aborted,
          caught,
          bodySignalAborted: signal().aborted,
        };
      }),
    );
    expect(seen).toEqual({
      callsWhenMade: 0,
      input: '/search?q=a',
      method: 'POST',
      header: '1',
      status: 201,
      text: 'ok',
      handedASignal: true,
      firstAborted: false,
      secondInput: '/slow',
      secondAborted: true,
      caught: 'AbortError',
      bodySignalAborted: false,
    });
  });

  it("a halted body's fetch is aborted through the signal: the wait finishes by the rejection, then the body is returned (no catch, nothing after, its finally run), aborted, nothing reported", async () => {
    const t = trace();
    const calls = installFetch(t);
    const stop = new Error('stop');
    const root = app();
    const outcome = await within(
      root.call(function* () {
        const f = fork(
          task(
            function* () {
              try {
                yield* fetch('/never');
                t.push('after fetch');
              } catch (e) {
                t.push(`catch ${label(e)}`);
              } finally {
                t.push('finally');
              }
              t.push('after try');
            },
            { name: 'fetching' },
          ),
        );
        while (calls.length === 0) yield* sleep(1);
        f.abort(stop);
        return show(yield* result(f), { stop });
      }),
    );
    expect({ outcome, log: t.log, signalAborted: calls[0]?.signal?.aborted }).toEqual({
      outcome: 'aborted(stop)',
      log: ['fetch', 'abort heard', 'fetch rejected', 'finally'],
      signalAborted: true,
    });
    await within(root.close()); // the AbortError is the halt's echo: nothing surfaces (and the setup guard hears no rejection)
  });
});
