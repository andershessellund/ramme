// stage4-pin.test.ts — the pinning tests of D41's stage 4, the platform layer `ramme/platform` and the browser as a
// target (PROPOSAL.md §5, decisions 19–26; §8 "PR 4"), written first.
//
// Each test asserts a fact of `ramme/platform` (src/platform.ts), which the stage-3 tree does not have:
//
// - `fetch(input, init?)` is a `wait` over `globalThis.fetch`, read when the op runs (so a fake installed after import
//   is the one called), with `init` passed on and a signal that combines `init.signal` with the yielding body's
//   `signal()` (decision 20). A halted body's fetch is aborted through that signal, and the halt meets it as the third
//   row of DESIGN.md §4.2's table: the wait finishes, by the fetch's rejection, and only then is the body returned;
//   the rejection is the halt's echo, never reported.
// - `listen(target, type, handler)` registers on an `EventTarget`, or on an emitter-shaped object with `on`/`off`, and
//   runs the handler synchronously inside the registering node, as `node.run` does (decision 21): `current()`,
//   `lookup`, `own` and `fork` act on that node, and a fork reports by the node's destination rules (a body's default
//   `'join'`, a bodiless node's `onFailure`). The listener is removed when the node ends: at its delivery (`abort()`)
//   and at an end without one (`close()`, a body's natural exit), which a node's signal alone does not reach, hence
//   decision 22's `own` entry beside `{ signal }`. A generator handler is refused with a `TypeError` at registration,
//   and nothing is registered (the specification's choice over decision 21's fork per event).
// - `nextFrame()` is a wait over `requestAnimationFrame`, read when the op runs, resolving with the frame's timestamp;
//   a halt returns the body at once and cancels the frame (`cancelAnimationFrame`), as a halt clears `sleep`'s timer
//   (D34); where `requestAnimationFrame` is absent (Node) it falls back to a 16 ms timer.
// - `each(source)` has decision 24's shape, the one this file decides: `for (const x of yield* each(source)) { …;
//   yield* each.next(); }`. `yield* each(source)` waits for the first item and is a synchronous iterable over the
//   current one; `yield* each.next()` waits for the next. It is chosen from PROPOSAL.md §5.2–§5.3 (decision 24, and
//   §7.4's codemod row for `for await`) over explicit stepping (`const it = each(source); while (true) { const r =
//   yield* it.next(); if (r.done) break; … }`), decision 24's rejected alternative: a `for…of` calls its iterator's
//   `return()` on `break`, `return`, a throw and the halt's `return()`, so `each` sees the body leave the loop, where a
//   `while` loop's `break` tells `it` nothing and the source could be closed only at the node's end. A bare
//   `for (const x of yield* each(source)) { … }` is what is not expressible: a synchronous `for…of` cannot wait for
//   the next item, so `yield* each.next()` does. The source's `return()` is called once when the body leaves the loop
//   early (by the body's next `yield*`) or is halted in it, as release work: the node completes only after the
//   source's own `finally` has run.
// - The browser is a target (decision 19; D41 decision 18): dist/index.js, dist/platform.js and every module they
//   import import nothing from `node:` or a Node builtin such as `async_hooks`. scripts/check-surface.mjs makes the
//   same check over dist/ (`pnpm check:surface`); this test reads src/ as compiled for the run (src/test/build.ts,
//   vitest's global setup), so it needs no `pnpm build` and never reads a stale one.
//
// Fakes are installed with `vi.stubGlobal` (`fetch`, `requestAnimationFrame`, `cancelAnimationFrame`) and removed
// after each test. Everything but `./platform.js` exists on the stage-3 tree, so there this file fails to typecheck
// only for that missing module (TS2307).
//
// Each test first compares one observation object, so that a failure shows the whole of the behaviour in its diff.
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import { current, fork, join, lookup, never, own, result, signal, sleep, wait } from './ambient.js';
import type { Context, Fiber } from './context.js';
import { createInjectionKey } from './context-key.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { each, fetch, listen, nextFrame } from './platform.js';
import { valueProvider } from './provider-util.js';
import { NoCurrentNodeError } from './resource.js';
import { start, tick, trace, within } from './test/util.js';
import type { Trace } from './test/util.js';

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

/** The test's own values, by name: `label` names what it finds among them by identity. */
type Known = Readonly<Record<string, unknown>>;

/** `x` as an observation reads it: a known value by its name; another error by class and message. */
function label(x: unknown, known: Known = {}): string {
  for (const [name, v] of Object.entries(known)) if (v === x) return name;
  if (x instanceof Error) return `${x.name}: ${x.message}`;
  return typeof x === 'string' ? JSON.stringify(x) : String(x);
}

/** An outcome as one string: `success(…)`, `failure(…)`, `defect(…)` or `aborted(…)`; anything else says what it is. */
function show(o: unknown, known: Known = {}): string {
  const x = o as { status?: unknown; value?: unknown; error?: unknown; reason?: unknown } | undefined;
  switch (x?.status) {
    case 'success':
      return `success(${label(x.value, known)})`;
    case 'failure':
      return `failure(${label(x.error, known)})`;
    case 'defect':
      return `defect(${label(x.error, known)})`;
    case 'aborted':
      return `aborted(${label(x.reason, known)})`;
    default:
      return `not an outcome: ${label(o, known)}`;
  }
}

/** What `f()` did: `'returned'`, or the class name of what it threw. */
function outcomeOf(f: () => unknown): string {
  try {
    f();
    return 'returned';
  } catch (e) {
    return e instanceof Error ? e.constructor.name : String(e);
  }
}

const GREETING = createInjectionKey<string>('GREETING');

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

/** A fake `requestAnimationFrame`/`cancelAnimationFrame` pair: frames fire only on `flush`. */
interface Frames {
  /** The ids handed out, in order (from 1). */
  readonly requested: number[];
  /** The ids `cancelAnimationFrame` was called with. */
  readonly cancelled: number[];
  /** Requested, neither fired nor cancelled. */
  pending(): number;
  /** Fire every pending frame with `time`. */
  flush(time: number): void;
}

function installFrames(): Frames {
  const callbacks = new Map<number, FrameRequestCallback>();
  const requested: number[] = [];
  const cancelled: number[] = [];
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    const id = next++;
    requested.push(id);
    callbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    cancelled.push(id);
    callbacks.delete(id);
  });
  return {
    requested,
    cancelled,
    pending: () => callbacks.size,
    flush: (time) => {
      const cbs = [...callbacks.values()];
      callbacks.clear();
      for (const cb of cbs) cb(time);
    },
  };
}

/** An `EventTarget` that records registrations, so a test can tell a removed listener from a dropped event. */
class RecordingTarget extends EventTarget {
  readonly added: { readonly type: string; readonly listener: unknown; readonly signal: AbortSignal | undefined }[] = [];
  readonly removed: { readonly type: string; readonly listener: unknown }[] = [];

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.added.push({ type, listener, signal: typeof options === 'object' ? options.signal : undefined });
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    this.removed.push({ type, listener });
    super.removeEventListener(type, listener, options);
  }

  /** Listeners of `type` still registered: added, and neither removed nor registered with a signal that has fired. */
  live(type: string): number {
    return this.added.filter(
      (a) => a.type === type && a.signal?.aborted !== true && !this.removed.some((r) => r.type === type && r.listener === a.listener),
    ).length;
  }
}

type Listener = (...args: any[]) => void;

/** An emitter-shaped object: `on` and `off` only, as `listen`'s structural overload reads it (no `node:` import). */
class Emitter {
  readonly #listeners = new Map<string | symbol, Set<Listener>>();

  on(type: string | symbol, listener: Listener): this {
    let set = this.#listeners.get(type);
    if (set === undefined) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
    return this;
  }

  off(type: string | symbol, listener: Listener): this {
    this.#listeners.get(type)?.delete(listener);
    return this;
  }

  emit(type: string | symbol, ...args: unknown[]): void {
    for (const l of [...(this.#listeners.get(type) ?? [])]) l(...args);
  }

  count(type: string | symbol): number {
    return this.#listeners.get(type)?.size ?? 0;
  }
}

/** A source over `values` (an async generator), recording `return()` calls; its `finally` waits 5 ms, then traces `source closed`. */
interface RecordingSource<T> extends AsyncIterable<T> {
  /** How many times `return()` was called on an iterator of it. */
  readonly returns: number;
}

function recordingSource<T>(values: readonly T[], t: Trace): RecordingSource<T> {
  async function* items(): AsyncGenerator<T, void, undefined> {
    try {
      for (const v of values) yield v;
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 5));
      t.push('source closed');
    }
  }
  let returns = 0;
  return {
    get returns() {
      return returns;
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const g = items();
      return {
        next: () => g.next(),
        return: (v?: unknown) => {
          returns++;
          t.push('return()');
          return g.return(v as undefined) as Promise<IteratorResult<T>>;
        },
      };
    },
  };
}

// --- fetch -------------------------------------------------------------------------------------------------------

describe('stage 4: fetch', () => {
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

// --- listen ------------------------------------------------------------------------------------------------------

describe('stage 4: listen', () => {
  it('listen on an EventTarget runs the handler synchronously inside the registering node: current(), lookup, own and fork act on it; the dispatch site has no node', async () => {
    const t = trace();
    const root = app();
    const box = root.child({ name: 'box', providers: [valueProvider(GREETING, 'from box')] });
    const target = new RecordingTarget();
    const forks: Fiber<string>[] = [];
    const seen: unknown[] = [];
    const echo = task(
      function* (s: string) {
        yield* sleep(1);
        return `${s} under ${current().parent === box ? 'box' : 'another node'}`;
      },
      { name: 'echo', onFailure: () => {} },
    );
    const event = new Event('ping');
    box.run(() =>
      listen(target, 'ping', (e: Event) => {
        seen.push({ event: e === event, current: current() === box, lookup: lookup(GREETING) });
        own(t.at('owned in the handler, released with box'));
        forks.push(fork(echo, 'echo'));
      }),
    );
    const dispatchSite = (() => {
      try {
        current();
        return 'a current node';
      } catch (e) {
        return e instanceof NoCurrentNodeError ? 'no current node' : label(e);
      }
    })();
    target.dispatchEvent(event);
    const synchronously = seen.length;
    await within(box.close());
    expect({
      dispatchSite,
      synchronously,
      seen,
      forkParent: forks[0]?.parent === box,
      forkOutcome: show(forks[0]?.outcome),
      log: t.log,
    }).toEqual({
      dispatchSite: 'no current node',
      synchronously: 1,
      seen: [{ event: true, current: true, lookup: 'from box' }],
      forkParent: true,
      forkOutcome: 'success("echo under box")',
      log: ['owned in the handler, released with box'],
    });
  });

  it('listen on an emitter-shaped object (on/off) re-enters the registering node the same way, with the emitted arguments', async () => {
    const root = app();
    const box = root.child({ name: 'box', providers: [valueProvider(GREETING, 'from box')] });
    const em = new Emitter();
    const seen: unknown[] = [];
    box.run(() =>
      listen(em, 'data', (...args: unknown[]) => {
        seen.push({ args, current: current() === box, lookup: lookup(GREETING) });
      }),
    );
    const registered = em.count('data');
    em.emit('data', 1, 'two');
    const synchronously = seen.length;
    await within(box.close());
    expect({ registered, synchronously, seen }).toEqual({
      registered: 1,
      synchronously: 1,
      seen: [{ args: [1, 'two'], current: true, lookup: 'from box' }],
    });
  });

  it("the listener is removed when its node ends, for an EventTarget and an emitter: at abort() (the delivery), at close(), and at a body's natural end; a later event calls nothing", async () => {
    const root = app();
    const seen: Record<string, unknown> = {};
    const kinds = {
      EventTarget: () => {
        const target = new RecordingTarget();
        return {
          register: (h: () => void) => listen(target, 'ping', () => h()),
          fire: () => void target.dispatchEvent(new Event('ping')),
          live: () => target.live('ping'),
        };
      },
      emitter: () => {
        const em = new Emitter();
        return {
          register: (h: () => void) => listen(em, 'ping', () => h()),
          fire: () => em.emit('ping'),
          live: () => em.count('ping'),
        };
      },
    };
    for (const [kind, make] of Object.entries(kinds)) {
      for (const ending of ['abort()', 'close()'] as const) {
        const k = make();
        let calls = 0;
        const box = root.child({ name: `${kind} ${ending}` });
        box.run(() => k.register(() => void calls++));
        k.fire();
        const before = { live: k.live(), calls };
        if (ending === 'abort()') box.abort();
        else await within(box.close());
        await tick();
        const liveAfter = k.live();
        k.fire();
        seen[`${kind}, ${ending}`] = { before, after: { live: liveAfter, calls } };
      }
      const k = make();
      let calls = 0;
      let before: unknown;
      await within(
        root.call(function* () {
          k.register(() => void calls++);
          k.fire();
          before = { live: k.live(), calls };
          yield* sleep(1);
        }),
      );
      const liveAfter = k.live();
      k.fire();
      seen[`${kind}, a body's natural end`] = { before, after: { live: liveAfter, calls } };
    }
    const removed = { before: { live: 1, calls: 1 }, after: { live: 0, calls: 1 } };
    expect(seen).toEqual({
      'EventTarget, abort()': removed,
      'EventTarget, close()': removed,
      "EventTarget, a body's natural end": removed,
      'emitter, abort()': removed,
      'emitter, close()': removed,
      "emitter, a body's natural end": removed,
    });
  });

  it("a handler's fork runs under the registering node and reports by its destination rules: a body's default 'join' fork is the body's to join, a bodiless node's goes to its onFailure", async () => {
    const boom = new Error('boom');
    const where = task(function* (expected: Context) {
      yield* sleep(1);
      return current().parent === expected ? 'under the registering node' : 'under another node';
    });
    const failing = task(function* () {
      yield* sleep(1);
      throw boom;
    });
    const root = app();
    // A body registers; the events come from a timer, outside every node.
    const target = new RecordingTarget();
    const body = await within(
      root.call(function* () {
        const me = current();
        const forked: { ok?: Fiber<string>; bad?: Fiber<never> } = {};
        listen(target, 'ok', () => {
          forked.ok = fork(where, me);
        });
        listen(target, 'bad', () => {
          forked.bad = fork(failing);
        });
        setTimeout(() => {
          target.dispatchEvent(new Event('ok'));
          target.dispatchEvent(new Event('bad'));
        }, 1);
        while (forked.ok === undefined || forked.bad === undefined) yield* sleep(1);
        const joined = yield* join(forked.ok);
        let caught = 'nothing';
        try {
          yield* join(forked.bad);
        } catch (e) {
          caught = label(e, { boom });
        }
        return { joined, caught };
      }),
    );
    // A bodiless node registers: its forks name a handler (D14), which gets the failure.
    const box = root.child({ name: 'box' });
    const boxTarget = new RecordingTarget();
    const reported: unknown[] = [];
    const forks: Fiber<unknown>[] = [];
    box.run(() =>
      listen(boxTarget, 'go', () => {
        forks.push(fork(where.with({ onFailure: () => {} }), box));
        forks.push(
          fork(
            failing.with({
              onFailure: (e, f) => void reported.push({ error: label(e, { boom }), parent: f.parent === box }),
            }),
          ),
        );
      }),
    );
    boxTarget.dispatchEvent(new Event('go'));
    await within(box.close());
    expect({ body, bodiless: { outcomes: forks.map((f) => show(f.outcome, { boom })), reported } }).toEqual({
      body: { joined: 'under the registering node', caught: 'boom' },
      bodiless: {
        outcomes: ['success("under the registering node")', 'defect(boom)'],
        reported: [{ error: 'boom', parent: true }],
      },
    });
  });

  it('a generator handler is refused with a TypeError at registration, and nothing is registered', () => {
    const root = app();
    const box = root.child({ name: 'box' });
    const target = new RecordingTarget();
    const em = new Emitter();
    // Typed as plain handlers: the refusal is a run-time check, whatever the overloads say.
    const onTarget = function* () {} as unknown as (e: Event) => void;
    const onEmitter = function* () {} as unknown as (...args: unknown[]) => void;
    expect({
      target: outcomeOf(() => box.run(() => listen(target, 'ping', onTarget))),
      targetRegistrations: target.added.length,
      emitter: outcomeOf(() => box.run(() => listen(em, 'ping', onEmitter))),
      emitterRegistrations: em.count('ping'),
    }).toEqual({ target: 'TypeError', targetRegistrations: 0, emitter: 'TypeError', emitterRegistrations: 0 });
  });
});

// --- nextFrame ---------------------------------------------------------------------------------------------------

describe('stage 4: nextFrame', () => {
  it("nextFrame is a wait over requestAnimationFrame, run when yielded, resolving with the frame's timestamp", async () => {
    const frames = installFrames();
    const root = app();
    const p = start(
      root.call(function* () {
        const op = nextFrame();
        const requestedWhenMade = frames.requested.length; // a work op is lazy (decision 2)
        const time = yield* op;
        return { requestedWhenMade, time };
      }),
    );
    await tick();
    const requested = [...frames.requested];
    frames.flush(1234.5);
    expect({ ...(await within(p)), requested, cancelled: frames.cancelled }).toEqual({
      requestedWhenMade: 0,
      time: 1234.5,
      requested: [1],
      cancelled: [],
    });
  });

  it('a halted body waiting on nextFrame is returned at once (its finally run, nothing after) and its frame is cancelled; no frame ever fires into it', async () => {
    const frames = installFrames();
    const t = trace();
    const stop = new Error('stop');
    const root = app();
    const outcome = await within(
      root.call(function* () {
        const f = fork(
          task(
            function* () {
              try {
                yield* nextFrame();
                t.push('after nextFrame');
              } finally {
                t.push('finally');
              }
            },
            { name: 'animating' },
          ),
        );
        while (frames.requested.length === 0) yield* sleep(1);
        f.abort(stop);
        return show(yield* result(f), { stop }); // at once: no frame fires before the flush below
      }),
    );
    const pendingAfterHalt = frames.pending();
    frames.flush(1);
    await tick();
    expect({ outcome, log: t.log, requested: frames.requested, cancelled: frames.cancelled, pendingAfterHalt }).toEqual({
      outcome: 'aborted(stop)',
      log: ['finally'],
      requested: [1],
      cancelled: [1],
      pendingAfterHalt: 0,
    });
  });

  it('where requestAnimationFrame is absent (Node), nextFrame falls back to a 16 ms timer and resolves with a number', async () => {
    const root = app();
    const absent = typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    const seen = await within(
      root.call(function* () {
        const t0 = performance.now();
        const time = yield* nextFrame();
        return { type: typeof time, waitedAFrame: performance.now() - t0 >= 10 };
      }),
    );
    expect({ absent, ...seen }).toEqual({ absent: 'undefined', type: 'number', waitedAFrame: true });
  });
});

// --- each --------------------------------------------------------------------------------------------------------

describe("stage 4: each, decision 24's shape", () => {
  it('for (const x of yield* each(source)) { …; yield* each.next(); } visits every item in order', async () => {
    const t = trace();
    const source = recordingSource([1, 2, 3], t);
    const root = app();
    const seen = await within(
      root.call(function* () {
        const items: number[] = [];
        for (const x of yield* each(source)) {
          items.push(x);
          yield* each.next();
        }
        return items;
      }),
    );
    expect({ seen, log: t.log }).toEqual({ seen: [1, 2, 3], log: ['source closed'] });
  });

  it("each closes its source when the body leaves the loop early, by break, return or a throw: return() is called once, by the body's next yield*, and the source's finally runs before the node completes", async () => {
    const boom = new Error('boom');
    const root = app();
    const seen: Record<string, unknown> = {};

    const tb = trace();
    const sb = recordingSource([1, 2, 3], tb);
    const broke = await within(
      root.call(function* () {
        const items: number[] = [];
        for (const x of yield* each(sb)) {
          items.push(x);
          if (x === 2) break;
          yield* each.next();
        }
        yield* sleep(0);
        return { items, returnsAtNextYield: sb.returns };
      }),
    );
    seen.break = { ...broke, returns: sb.returns, log: tb.log };

    const tr = trace();
    const sr = recordingSource([1, 2, 3], tr);
    const returned = await within(
      root.call(function* () {
        for (const x of yield* each(sr)) {
          if (x === 2) return x;
          yield* each.next();
        }
        return 0;
      }),
    );
    seen.return = { returned, returns: sr.returns, log: tr.log };

    const tt = trace();
    const st = recordingSource([1, 2, 3], tt);
    const thrown = await within(
      root.attempt(function* () {
        for (const x of yield* each(st)) {
          if (x === 2) throw boom;
          yield* each.next();
        }
      }),
    );
    seen.throw = { outcome: show(thrown, { boom }), returns: st.returns, log: tt.log };

    expect(seen).toEqual({
      break: { items: [1, 2], returnsAtNextYield: 1, returns: 1, log: ['return()', 'source closed'] },
      return: { returned: 2, returns: 1, log: ['return()', 'source closed'] },
      throw: { outcome: 'defect(boom)', returns: 1, log: ['return()', 'source closed'] },
    });
  });

  it("each closes its source when the body is halted inside the loop: return() is called once as release work, the source's finally runs before the node completes, and the outcome is aborted", async () => {
    const t = trace();
    const source = recordingSource([1, 2, 3], t);
    const stop = new Error('stop');
    const root = app();
    const outcome = await within(
      root.call(function* () {
        const f = fork(
          task(
            function* () {
              for (const x of yield* each(source)) {
                t.push(`item ${x}`);
                yield* never();
                yield* each.next();
              }
              t.push('after the loop');
            },
            { name: 'consuming' },
          ),
        );
        while (t.log.length === 0) yield* sleep(1);
        f.abort(stop);
        return show(yield* result(f), { stop }); // result waits for f's completion, which waits for the close
      }),
    );
    expect({ outcome, returns: source.returns, log: t.log }).toEqual({
      outcome: 'aborted(stop)',
      returns: 1,
      log: ['item 1', 'return()', 'source closed'],
    });
  });

  it('each closes its source when the body is halted waiting in each.next(): return() is called once and the halt completes', async () => {
    let nextCalls = 0;
    let returns = 0;
    // Its second read is in flight for 30 ms: whether the halt waits for it or not, the source is returned once.
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const n = ++nextCalls;
          if (n === 1) return Promise.resolve({ value: 1, done: false });
          return new Promise<IteratorResult<number>>((resolve) => setTimeout(() => resolve({ value: n, done: false }), 30));
        },
        return: () => {
          returns++;
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
    const stop = new Error('stop');
    const root = app();
    const outcome = await within(
      root.call(function* () {
        const f = fork(
          task(
            function* () {
              for (const _ of yield* each(source)) yield* each.next();
            },
            { name: 'reading' },
          ),
        );
        while (nextCalls < 2) yield* sleep(1);
        f.abort(stop);
        return show(yield* result(f), { stop });
      }),
    );
    expect({ outcome, returns }).toEqual({ outcome: 'aborted(stop)', returns: 1 });
  });
});

// --- the browser is a target ---------------------------------------------------------------------------------------

describe('stage 4: the browser is a target', () => {
  it('dist/index.js and dist/platform.js, and every module they import, import nothing from node: or a Node builtin such as async_hooks', () => {
    // src/ compiled for this run (src/test/build.ts), laid out as dist/ is: never a missing or stale `pnpm build`.
    const dist = pathToFileURL(`${inject('builtDist')}/`);
    const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
    const name = (u: URL): string => `dist/${u.href.slice(dist.href.length)}`;
    const reached: string[] = [];
    const problems: string[] = [];
    const seenFiles = new Set<string>();
    const visit = (file: URL, importer: string): void => {
      if (seenFiles.has(file.href)) return;
      seenFiles.add(file.href);
      if (!existsSync(file)) {
        problems.push(`${name(file)} is missing (imported by ${importer}): the compile for the run did not emit it`);
        return;
      }
      reached.push(name(file));
      // TypeScript's own scanner: static imports and re-exports, `import()` and `require()`, never a comment or string.
      for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
        if (fileName.startsWith('.')) visit(new URL(fileName, file), name(file));
        else if (fileName.startsWith('node:') || builtins.has(fileName)) problems.push(`${name(file)} imports ${fileName}`);
      }
    };
    for (const entry of ['index.js', 'platform.js']) visit(new URL(entry, dist), 'the browser entries');
    expect({ problems, reachesBoth: ['dist/index.js', 'dist/platform.js'].every((f) => reached.includes(f)) }).toEqual({
      problems: [],
      reachesBoth: true,
    });
  });
});
