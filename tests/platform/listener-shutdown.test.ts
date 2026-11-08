// Tests for platform / listener shutdown.
import { EventEmitter, getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { listen } from '../../src/platform.js';
import { tick, within } from '../support/util.js';
import { labelError as label, type Known } from '../support/observations.js';

/** Every `console.warn` of the current test, first argument only; the spy keeps them off the console. */
const warnings: string[] = [];

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

beforeEach(() => {
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** How `p` settled, read from top level: `resolved(…)` or `rejected(…)`; a deadlock rejects after a second. */
async function settledWith(p: PromiseLike<unknown>, known: Known = {}): Promise<string> {
  try {
    return `resolved(${label(await within(p), known)})`;
  } catch (e) {
    return `rejected(${label(e, known)})`;
  }
}

/** What `f()` threw: its class name and whether its message names each of `words`; `'returned'` when it did not throw. */
function thrownBy(f: () => unknown, words: readonly string[] = []): string {
  try {
    f();
    return 'returned';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const named = words.filter((w) => message.includes(w));
    return `${e instanceof Error ? e.constructor.name : typeof e}${named.length > 0 ? ` naming ${named.join(' and ')}` : ''}`;
  }
}

/** The unhandled rejections Node reports while `fn` runs, and one macrotask after it (when Node reports them). */
async function unhandledDuring(fn: () => Promise<void>): Promise<string[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => void seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await fn();
    await tick(2);
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen.map((r) => label(r));
}

describe('listen and a handler that returns a promise', () => {
  it('in development mode and in production, on an EventTarget and on an emitter: a TypeError naming promised and fork at the event, the node ends defect with it, and the rejection is handled', async () => {
    const seen: Record<string, unknown> = {};
    const unhandled = await unhandledDuring(async () => {
      for (const mode of ['development', 'production']) {
        vi.stubEnv('NODE_ENV', mode);
        for (const on of ['EventTarget', 'emitter']) {
          const rejection = new Error(`rejected in ${mode} on the ${on}`);
          const box = app().child({ name: 'box' });
          let calls = 0;
          const handler = (): Promise<never> => {
            calls++;
            return Promise.reject(rejection);
          };
          if (on === 'EventTarget') {
            const target = new EventTarget();
            box.run(() => listen(target, 'ping', handler));
            target.dispatchEvent(new Event('ping'));
          } else {
            const em = new EventEmitter();
            box.run(() => listen(em, 'ping', handler));
            em.emit('ping');
          }
          let closed: string;
          try {
            await within(box.close());
            closed = 'resolved';
          } catch (e) {
            closed = thrownBy(() => {
              throw e;
            }, ['promised', 'fork']);
          }
          seen[`${mode}, ${on}`] = { calls, closed, outcome: box.outcome?.status };
        }
        vi.unstubAllEnvs();
      }
    });
    const refused = { calls: 1, closed: 'TypeError naming promised and fork', outcome: 'defect' };
    expect({ seen, unhandled }).toEqual({
      seen: {
        'development, EventTarget': refused,
        'development, emitter': refused,
        'production, EventTarget': refused,
        'production, emitter': refused,
      },
      unhandled: [],
    });
  });
});

describe('a registration that aborts its own node leaves nothing registered', () => {
  it('an emitter whose newListener aborts the node, and EventTargets whose addEventListener aborts it (one that ignores { signal }, as ws does, and one that honours it): the listener and its opts.signal listener are removed at once', async () => {
    const seen: Record<string, unknown> = {};
    // An emitter: `newListener` is emitted inside on(), before the listener is added.
    {
      const box = app().child({ name: 'box' });
      const em = new EventEmitter();
      em.on('newListener', (type: string | symbol) => {
        if (type === 'ping') box.abort(new Error('aborted while registering'));
      });
      const early = new AbortController();
      let calls = 0;
      box.run(() => listen(em, 'ping', () => void calls++, { signal: early.signal }));
      const closed = await settledWith(box.close());
      em.emit('ping');
      seen.emitter = {
        closed,
        outcome: box.outcome?.status,
        listeners: em.listenerCount('ping'),
        onTheEarlySignal: getEventListeners(early.signal, 'abort').length,
        calls,
      };
    }
    // EventTargets whose addEventListener aborts the registering node, then registers: one reads `once` only (a ws
    // `WebSocket`), so the listener is registered on an aborted node; one honours `{ signal }`, already aborted.
    for (const honoursSignal of [false, true]) {
      const box = app().child({ name: 'box' });
      class Aborting extends EventTarget {
        override addEventListener(
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          opts?: boolean | AddEventListenerOptions,
        ): void {
          box.abort(new Error('aborted while registering'));
          const once = typeof opts === 'object' ? opts.once : undefined;
          super.addEventListener(type, listener, honoursSignal ? opts : { once });
        }
      }
      const target = new Aborting();
      const early = new AbortController();
      let calls = 0;
      box.run(() => listen(target, 'ping', () => void calls++, { signal: early.signal }));
      const closed = await settledWith(box.close());
      target.dispatchEvent(new Event('ping'));
      seen[honoursSignal ? 'EventTarget honouring { signal }' : 'EventTarget ignoring { signal }'] = {
        closed,
        outcome: box.outcome?.status,
        listeners: getEventListeners(target, 'ping').length,
        onTheEarlySignal: getEventListeners(early.signal, 'abort').length,
        calls,
      };
    }
    const clean = { closed: 'resolved(undefined)', outcome: 'aborted', listeners: 0, onTheEarlySignal: 0, calls: 0 };
    expect(seen).toEqual({
      emitter: clean,
      'EventTarget ignoring { signal }': clean,
      'EventTarget honouring { signal }': clean,
    });
  });
});
