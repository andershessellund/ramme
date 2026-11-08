// platform.test.ts — `ramme/platform` (src/platform.ts; DESIGN.md §4.9, D43) beyond the stage-4 pins
// (stage4-pin.test.ts): what each primitive does at the edges the pins leave open.
//
// - `fetch` in a halted `finally` is handed the unwind fiber's release deadline, so cleanup can still make a request;
//   a `Request` input keeps its own signal, referrer and referrer policy, which the init `fetch` passes on would
//   otherwise replace.
// - `listen`: a handler's throw is routed to the node, never rethrown into the target (decision 21), even when the
//   handler released its own listener first (`close()`, `abort()`, `releaseAll()`, its `opts.signal`); async handlers,
//   non-functions and foreign targets are refused before anything is registered, and a handler that returns an op (a
//   task as the handler) throws a TypeError at the event, since nothing runs the op; the listener is gone from the target
//   at the delivery, before the node's release (decision 22), on a target that ignores `{ signal }` too, and an
//   event that reaches it after the delivery (an emitter's same-`emit` call, an earlier listener of the node's signal
//   dispatching) is dropped; `opts.signal` and `once` remove it early with its entry, and leave no listener on a signal
//   that outlives it; a capturing listener is removed by its capture flag; a delivered node registers nothing; a
//   dispatch during a creation runs no handler and is the dispatcher's error, never the registering node's.
// - The primitives' guards name the primitive: `fetch()`, `nextFrame()` and `listen()`, not the core verb under them.
// - `nextFrame`: an `observe` body, which no halt returns, has its wait rejected with the reason and its frame
//   cancelled; a wait run on a signal already fired requests no frame; Node's timer fallback is cleared at the halt;
//   a frame that fires leaves no listener on the node's signal.
// - `each`: a halt during the first read stops waiting at once and the source is returned; a pass without
//   `each.next()` throws at the loop's head and returns the source there; `each.next()` outside a loop and `each` of
//   no async iterable are `TypeError`s; nested loops advance the innermost; a failed read, an empty source and an
//   exhausted one are never returned; a `return()` that rejects is the node's release failure; a `fail` in the loop
//   returns the source.
import { EventEmitter, getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { current, fail, fork, interrupted, join, lookup, never, releaseAll, result, signal, sleep, wait } from './ambient.js';
import type { Context, Fiber } from './context.js';
import { createInjectionKey } from './context-key.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { each, fetch, listen, nextFrame } from './platform.js';
import { deferred, events, trace, within } from './test/util.js';
import type { Trace } from './test/util.js';

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

type Known = Readonly<Record<string, unknown>>;

function label(x: unknown, known: Known = {}): string {
  for (const [name, v] of Object.entries(known)) if (v === x) return name;
  if (x instanceof Error) return `${x.name}: ${x.message}`;
  return typeof x === 'string' ? JSON.stringify(x) : String(x);
}

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

function outcomeOf(f: () => unknown): string {
  try {
    f();
    return 'returned';
  } catch (e) {
    return e instanceof Error ? e.constructor.name : String(e);
  }
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

/** A fake `requestAnimationFrame`/`cancelAnimationFrame` pair: frames fire only on `flush`. */
function installFrames(): { readonly requested: number[]; readonly cancelled: number[]; flush(time: number): void } {
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
    flush: (time) => {
      const cbs = [...callbacks.values()];
      callbacks.clear();
      for (const cb of cbs) cb(time);
    },
  };
}

/** An async generator over `values` whose `return()` calls are traced (`return()`) and counted; its `finally` traces `source closed`. */
function recordingSource<T>(values: readonly T[], t: Trace): AsyncIterable<T> & { readonly returns: number } {
  async function* items(): AsyncGenerator<T, void, undefined> {
    try {
      for (const v of values) yield v;
    } finally {
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

// --- listen --------------------------------------------------------------------------------------------------------

describe('platform: listen', () => {
  it("a handler's throw is never rethrown into the target: it aborts the registering node with the error, which surfaces from the node's completion as its defect (decision 21)", async () => {
    const boom = new Error('boom');
    const root = app();
    const seen: Record<string, unknown> = {};
    // Bodiless nodes: the throw aborts the node, which completes at once, its listener's entry failing with the error.
    const kinds = {
      EventTarget: () => {
        const target = new EventTarget();
        return { target, fire: () => void target.dispatchEvent(new Event('ping')) };
      },
      emitter: () => {
        const target = new EventEmitter();
        return { target, fire: () => void target.emit('ping') };
      },
    };
    for (const [kind, make] of Object.entries(kinds)) {
      const { target, fire } = make();
      const box = root.child({ name: `box ${kind}` });
      let calls = 0;
      box.run(() =>
        listen(target as EventTarget, 'ping', () => {
          calls++;
          throw boom;
        }),
      );
      const firing = outcomeOf(fire);
      outcomeOf(fire); // removed with the node: no second call
      seen[kind] = { firing, calls, reason: label(box.signal.reason, { boom }), state: box.state, outcome: show(box.outcome, { boom }) };
    }
    // A handler's fork with the default 'join' destination on a bodiless node is refused (D14): routed the same way.
    const work = task(function* () {});
    const box = root.child({ name: 'box' });
    const target = new EventTarget();
    box.run(() => listen(target, 'go', () => void fork(work)));
    target.dispatchEvent(new Event('go'));
    seen.refusedFork = { outcome: box.outcome?.status, error: (box.outcome as { error?: unknown }).error instanceof TypeError };
    // A body: halted at its wait, and its outcome is the defect; its joiner gets the error.
    seen.body = await within(
      root.call(function* () {
        const em = new EventEmitter();
        const f = fork(
          task(function* () {
            listen(em, 'ping', () => {
              throw boom;
            });
            yield* never();
          }),
        );
        yield* sleep(1);
        const emitted = outcomeOf(() => em.emit('ping'));
        let joined = 'nothing';
        try {
          yield* join(f);
        } catch (e) {
          joined = label(e, { boom });
        }
        return { emitted, joined, outcome: show(f.outcome, { boom }) };
      }),
    );
    const routed = { firing: 'returned', calls: 1, reason: 'boom', state: 'complete', outcome: 'defect(boom)' };
    expect(seen).toEqual({
      EventTarget: routed,
      emitter: routed,
      refusedFork: { outcome: 'defect', error: true },
      body: { emitted: 'returned', joined: 'boom', outcome: 'defect(boom)' },
    });
  });

  it("a handler that releases its own listener (close(), abort(), releaseAll(), its opts.signal) and then throws still ends the node defect(e): the release waits for the handler, and fails with its throw", async () => {
    const boom = new Error('boom');
    const peer = new Error('peer closed');
    const root = app();
    const releases: Record<string, (early: AbortController) => void> = {
      'close()': () => void current().close(),
      'abort()': () => current().abort(peer),
      'releaseAll()': () => void releaseAll(),
      'its opts.signal': (early) => early.abort(),
    };
    const kinds = {
      EventTarget: () => {
        const target = new EventTarget();
        return { target, fire: () => void target.dispatchEvent(new Event('close')) };
      },
      emitter: () => {
        const target = new EventEmitter();
        return { target, fire: () => void target.emit('close') };
      },
    };
    const seen: Record<string, unknown> = {};
    for (const [kind, make] of Object.entries(kinds))
      for (const [how, release] of Object.entries(releases)) {
        const { target, fire } = make();
        const early = new AbortController();
        const box = root.child({ name: `${kind}, ${how}` });
        let calls = 0;
        box.run(() =>
          listen(
            target as EventTarget,
            'close',
            () => {
              calls++;
              release(early);
              throw boom;
            },
            { signal: early.signal },
          ),
        );
        const firing = outcomeOf(fire);
        await within(box.close()).catch(() => {});
        seen[`${kind}, ${how}`] = { firing, calls, outcome: show(box.outcome, { boom, peer }) };
      }
    const routed = { firing: 'returned', calls: 1, outcome: 'defect(boom)' };
    expect(seen).toEqual(
      Object.fromEntries(Object.keys(kinds).flatMap((kind) => Object.keys(releases).map((how) => [`${kind}, ${how}`, routed]))),
    );
  });

  it("an event dispatched during a creation runs no handler: node.run's guard refuses the frame (I16), and its error is the dispatcher's, as a bare listener's node.run would throw it, never the registering node's", async () => {
    const em = new EventEmitter();
    // An EventTarget whose dispatch lets a listener's throw through: the platform's would report it to the host.
    const listeners = new Set<(e: Event) => void>();
    const bus = {
      addEventListener: (_type: string, l: (e: Event) => void) => void listeners.add(l),
      removeEventListener: (_type: string, l: (e: Event) => void) => void listeners.delete(l),
      dispatch: () => {
        for (const l of [...listeners]) l(new Event('registered'));
      },
    };
    const PLUGIN = createInjectionKey<{ name: string }>('PLUGIN', {
      factory: () => {
        em.emit('registered', 'plugin');
        return { name: 'plugin' };
      },
    });
    const ADDON = createInjectionKey<{ name: string }>('ADDON', {
      factory: () => {
        bus.dispatch();
        return { name: 'addon' };
      },
    });
    const root = app();
    const box = root.child({ name: 'box' });
    let calls = 0;
    box.run(() => {
      listen(em, 'registered', () => void calls++);
      listen(bus as unknown as EventTarget, 'registered', () => void calls++);
    });
    const name = (o: unknown): string => {
      const e = (o as { status?: string; error?: unknown }).error;
      return `${(o as { status?: string }).status}(${e instanceof Error ? e.name : String(e)})`;
    };
    const plugin = name(await within(root.attempt(function* () { return lookup(PLUGIN).name; })));
    const addon = name(await within(root.attempt(function* () { return lookup(ADDON).name; })));
    const boxSignal = box.signal.aborted;
    em.emit('registered', 'later'); // outside the creation: the handlers run
    bus.dispatch();
    await within(box.close());
    expect({ plugin, addon, boxSignal, calls, box: show(box.outcome) }).toEqual({
      plugin: 'defect(CreationViolationError)',
      addon: 'defect(CreationViolationError)',
      boxSignal: false,
      calls: 2,
      box: 'success(undefined)',
    });
  });

  it('an async handler is refused as a generator one is, and so are a handler that is no function and a target that is neither an EventTarget nor an emitter: a TypeError before anything is registered', () => {
    const log = events();
    roots.push(log.root);
    const box = log.root.child({ name: 'box' });
    const target = new EventTarget();
    const em = new EventEmitter();
    const asAHandler = (x: unknown) => x as (e: Event) => void;
    expect({
      async: outcomeOf(() => box.run(() => listen(target, 'ping', asAHandler(async () => {})))),
      asyncGenerator: outcomeOf(() => box.run(() => listen(em, 'ping', asAHandler(async function* () {})))),
      notAFunction: outcomeOf(() => box.run(() => listen(target, 'ping', asAHandler(42)))),
      notATarget: outcomeOf(() => box.run(() => listen({ on() {} } as unknown as EventTarget, 'ping', () => {}))),
      outsideANode: outcomeOf(() => listen(target, 'ping', () => {})),
      registered: getEventListeners(target, 'ping').length + em.listenerCount('ping'),
      entries: log.of('entry:registered').filter((e) => e.entryName === 'Listener').length,
    }).toEqual({
      async: 'TypeError',
      asyncGenerator: 'TypeError',
      notAFunction: 'TypeError',
      notATarget: 'TypeError',
      outsideANode: 'NoCurrentNodeError',
      registered: 0,
      entries: 0,
    });
  });

  it('a handler that returns an op (a task as the handler, an arrow that returns a task’s call) runs nothing: the event throws a TypeError, which ends the node defect(e), on a target and on an emitter', async () => {
    const ran: string[] = [];
    const onClick = task(function* onClick(e: Event) {
      ran.push(e.type);
      yield* sleep(0);
    });
    const onData = task(function* onData(x: string) {
      ran.push(x);
    });
    const root = app();
    // Each registers on a bodiless node and returns the dispatch (DESIGN.md §4.9): it type-checks, since an op is a value.
    const cases: Record<string, (box: Context) => () => unknown> = {
      task: (box) => {
        const target = new EventTarget();
        box.run(() => listen(target, 'click', onClick));
        return () => target.dispatchEvent(new Event('click'));
      },
      arrow: (box) => {
        const target = new EventTarget();
        box.run(() => listen(target, 'click', (e) => onClick(e)));
        return () => target.dispatchEvent(new Event('click'));
      },
      emitter: (box) => {
        const em = new EventEmitter();
        box.run(() => listen(em, 'data', onData));
        return () => em.emit('data', 'x');
      },
    };
    const seen: Record<string, unknown> = {};
    for (const [name, register] of Object.entries(cases)) {
      const box = root.child({ name });
      const fire = register(box);
      const firing = outcomeOf(fire);
      const error = (box.outcome as { error?: unknown } | undefined)?.error;
      seen[name] = { firing, outcome: box.outcome?.status, saysOp: error instanceof TypeError && /returned an op/.test(error.message) };
    }
    await within(root.call(function* () { yield* sleep(5); })); // time for an op wrongly run to run
    const refused = { firing: 'returned', outcome: 'defect', saysOp: true };
    expect({ ...seen, ran }).toEqual({ task: refused, arrow: refused, emitter: refused, ran: [] });
  });

  it("the listener is gone from the target at the node's delivery, before its release (decision 22): an event while the halted body's finally waits reaches no handler", async () => {
    const target = new EventTarget();
    const em = new EventEmitter();
    let calls = 0;
    const cleanup = deferred();
    const root = app();
    const seen = await within(
      root.call(function* () {
        const f = fork(
          task(function* () {
            listen(target, 'ping', () => void calls++);
            listen(em, 'ping', () => void calls++);
            try {
              yield* never();
            } finally {
              yield* wait(cleanup.promise); // release work: the node's entries are released after it
            }
          }),
        );
        yield* sleep(1);
        const registered = { target: getEventListeners(target, 'ping').length, emitter: em.listenerCount('ping') };
        f.abort();
        yield* sleep(1);
        target.dispatchEvent(new Event('ping'));
        em.emit('ping');
        const inTheFinally = { target: getEventListeners(target, 'ping').length, emitter: em.listenerCount('ping'), calls, state: f.state };
        cleanup.resolve();
        yield* result(f);
        return { registered, inTheFinally };
      }),
    );
    expect(seen).toEqual({
      registered: { target: 1, emitter: 1 },
      inTheFinally: { target: 0, emitter: 0, calls: 0, state: 'running' },
    });
  });

  it('an emitter still calls a listener removed during the same emit: the event is dropped once the node is delivered', async () => {
    const em = new EventEmitter();
    let calls = 0;
    const root = app();
    const outcome = await within(
      root.call(function* () {
        const box: { f?: Fiber<void> } = {};
        em.on('ping', () => box.f!.abort()); // registered first: it delivers f inside the emit that reaches f's listener next
        const f = (box.f = fork(
          task(function* () {
            listen(em, 'ping', () => void calls++);
            yield* never();
          }),
        ));
        yield* sleep(1);
        em.emit('ping');
        return (yield* result(f)).status;
      }),
    );
    expect({ outcome, calls }).toEqual({ outcome: 'aborted', calls: 0 });
  });

  it("no handler runs after the node's delivery: a target that ignores { signal } (ws's WebSocket) is removed at the delivery, and an event an earlier listener of the node's signal dispatches, before the platform removes the listener, is dropped", async () => {
    // ws's addEventListener reads `once` only: `{ signal }` removes nothing.
    const blindListeners = new Set<(e: Event) => void>();
    const blind = {
      addEventListener: (_type: string, l: (e: Event) => void) => void blindListeners.add(l),
      removeEventListener: (_type: string, l: (e: Event) => void) => void blindListeners.delete(l),
      dispatch: () => {
        for (const l of [...blindListeners]) l(new Event('message'));
      },
    };
    const calls: string[] = [];
    const cleanup = deferred();
    const root = app();
    const seen = await within(
      root.call(function* () {
        const f = fork(
          task(function* () {
            listen(blind as unknown as EventTarget, 'message', () => void calls.push(`blind, aborted: ${signal().aborted}`));
            try {
              yield* never();
            } finally {
              yield* wait(cleanup.promise); // release work: the entries are released after it
            }
          }),
        );
        yield* sleep(1);
        blind.dispatch();
        f.abort();
        blind.dispatch();
        const inTheFinally = { registered: blindListeners.size, state: f.state };
        cleanup.resolve();
        yield* result(f);
        return inTheFinally;
      }),
    );
    // The node's signal fires its own listeners before the dependent signal `{ signal }` was handed.
    const target = new EventTarget();
    const box = root.child({ name: 'box' });
    box.signal.addEventListener('abort', () => target.dispatchEvent(new Event('ping')));
    box.run(() => listen(target, 'ping', () => void calls.push(`target, aborted: ${box.signal.aborted}`)));
    box.abort();
    await within(box.close()).catch(() => {});
    expect({ seen, calls, onTarget: getEventListeners(target, 'ping').length }).toEqual({
      seen: { registered: 0, state: 'running' },
      calls: ['blind, aborted: false'],
      onTarget: 0,
    });
  });

  it("opts.signal and once remove the listener early, with its entry, and leave no listener on a signal that outlives it, the node's included", async () => {
    const log = events();
    roots.push(log.root);
    const box = log.root.child({ name: 'box' });
    const target = new EventTarget();
    const em = new EventEmitter();
    const early = { target: new AbortController(), emitter: new AbortController() };
    const kept = new AbortController(); // outlives the box
    let calls = 0;
    const baseline = getEventListeners(box.signal, 'abort').length;
    box.run(() => {
      listen(target, 'ping', () => void calls++, { signal: early.target.signal });
      listen(em, 'ping', () => void calls++, { signal: early.emitter.signal });
      listen(target, 'once', () => void calls++, { once: true });
    });
    const boxEntries = (): number => log.of('entry:released').filter((e) => e.id === box.id && e.entryName === 'Listener').length;
    target.dispatchEvent(new Event('ping'));
    em.emit('ping');
    target.dispatchEvent(new Event('once'));
    target.dispatchEvent(new Event('once'));
    const afterOnce = { calls, released: boxEntries() };
    early.target.abort();
    early.emitter.abort();
    target.dispatchEvent(new Event('ping'));
    em.emit('ping');
    const afterAbort = {
      calls,
      released: boxEntries(),
      onTarget: getEventListeners(target, 'ping').length + getEventListeners(target, 'once').length,
      onEmitter: em.listenerCount('ping'),
      onBoxSignal: getEventListeners(box.signal, 'abort').length - baseline,
    };
    // A registration that ends with its node takes its listener off the signal that outlives it.
    box.run(() => {
      listen(target, 'kept', () => {}, { signal: kept.signal });
      listen(em, 'kept', () => {}, { signal: kept.signal });
    });
    const keptWhileOpen = getEventListeners(kept.signal, 'abort').length;
    await within(box.close());
    expect({ afterOnce, afterAbort, keptWhileOpen, keptAfter: getEventListeners(kept.signal, 'abort').length }).toEqual({
      afterOnce: { calls: 3, released: 1 },
      afterAbort: { calls: 3, released: 3, onTarget: 0, onEmitter: 0, onBoxSignal: 0 },
      keptWhileOpen: 2,
      keptAfter: 0,
    });
  });

  it('a capturing listener is removed by its capture flag when its node closes', async () => {
    const target = new EventTarget();
    const box = app().child({ name: 'box' });
    box.run(() => listen(target, 'ping', () => {}, { capture: true }));
    const registered = getEventListeners(target, 'ping').length;
    await within(box.close()); // no delivery: the entry removes it
    expect({ registered, after: getEventListeners(target, 'ping').length }).toEqual({ registered: 1, after: 0 });
  });

  it('a node already delivered registers nothing: listen in a halted finally, or with an opts.signal already fired', async () => {
    const log = events();
    roots.push(log.root);
    const target = new EventTarget();
    const em = new EventEmitter();
    const seen: { inFinally?: unknown; early?: number } = {};
    await within(
      log.root.call(function* () {
        const f = fork(
          task(function* () {
            try {
              yield* never();
            } finally {
              listen(target, 'ping', () => {});
              listen(em, 'ping', () => {});
              seen.inFinally = { target: getEventListeners(target, 'ping').length, emitter: em.listenerCount('ping') };
            }
          }),
        );
        yield* sleep(1);
        f.abort();
        yield* result(f);
        listen(em, 'early', () => {}, { signal: AbortSignal.abort() });
        seen.early = em.listenerCount('early');
      }),
    );
    expect({ ...seen, entries: log.of('entry:registered').filter((e) => e.entryName === 'Listener').length }).toEqual({
      inFinally: { target: 0, emitter: 0 },
      early: 0,
      entries: 0,
    });
  });

  it('a registration that ends its node another way is removed at once too: one that closes it, whose release ran before there was a listener to remove, and one that aborts a fiber, whose release comes only after its halted finally', async () => {
    // close() during on(): the bodiless box releases its entries at once, before listen attaches the removal.
    const box = app().child({ name: 'box' });
    const closing = new EventEmitter();
    closing.on('newListener', (type: string | symbol) => {
      if (type === 'ping') void box.close();
    });
    box.run(() => listen(closing, 'ping', () => {}));
    const afterClose = { listeners: closing.listenerCount('ping'), state: box.state };
    // abort() of a fiber during on(): its entries are released after its body, whose finally still waits here.
    const aborting = new EventEmitter();
    aborting.on('newListener', (type: string | symbol) => {
      if (type === 'ping') current().abort(new Error('aborted while registering'));
    });
    let inFinally: number | undefined;
    const root = app();
    const f = root.fork(
      task(function* () {
        try {
          listen(aborting, 'ping', () => {});
          yield* never();
        } finally {
          yield* sleep(1); // release work: the fiber's own release has not run yet
          inFinally = aborting.listenerCount('ping');
        }
      }, { onFailure: () => {} }),
    );
    const o = await within(root.result(f));
    expect({ afterClose, inFinally, after: aborting.listenerCount('ping'), fiber: o.status }).toEqual({
      afterClose: { listeners: 0, state: 'complete' },
      inFinally: 0,
      after: 0,
      fiber: 'aborted',
    });
  });

  it('a registration that fires its own opts.signal (an emitter’s newListener, an addEventListener that aborts it) is removed at once, with its entry, as the signal’s abort removes it; the node runs on', async () => {
    const log = events();
    roots.push(log.root);
    const box = log.root.child({ name: 'box' });
    const emitterEarly = new AbortController();
    const em = new EventEmitter();
    em.on('newListener', (type: string | symbol) => {
      if (type === 'ping') emitterEarly.abort();
    });
    const targetEarly = new AbortController();
    class Aborting extends EventTarget {
      override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions): void {
        targetEarly.abort();
        super.addEventListener(type, listener, { once: typeof opts === 'object' ? opts.once : undefined }); // ignores { signal }, as ws does
      }
    }
    const target = new Aborting();
    let calls = 0;
    box.run(() => {
      listen(em, 'ping', () => void calls++, { signal: emitterEarly.signal });
      listen(target, 'ping', () => void calls++, { signal: targetEarly.signal });
    });
    em.emit('ping');
    target.dispatchEvent(new Event('ping'));
    const released = log.of('entry:released').filter((e) => e.id === box.id && e.entryName === 'Listener').length;
    const seen = {
      calls,
      onEmitter: em.listenerCount('ping'),
      onTarget: getEventListeners(target, 'ping').length,
      released,
      state: box.state,
    };
    await within(box.close());
    expect({ ...seen, outcome: box.outcome?.status }).toEqual({
      calls: 0,
      onEmitter: 0,
      onTarget: 0,
      released: 2,
      state: 'running',
      outcome: 'success',
    });
  });
});

// --- nextFrame -----------------------------------------------------------------------------------------------------

describe('platform: nextFrame', () => {
  it("an observe body, which no halt returns, has its frame cancelled at the delivery and the wait rejected with the reason; one that waits after the delivery requests no frame", async () => {
    const frames = installFrames();
    const stop = new Error('stop');
    const root = app();
    const seen = await within(
      root.call(function* () {
        const waiting = fork(
          task(
            function* () {
              try {
                yield* nextFrame();
                return 'framed';
              } catch (e) {
                return `caught ${label(e, { stop })}`;
              }
            },
            { interrupt: 'observe' },
          ),
        );
        const late = fork(
          task(
            function* () {
              yield* interrupted();
              try {
                yield* nextFrame();
                return 'framed';
              } catch (e) {
                return `caught ${label(e, { stop })}`;
              }
            },
            { interrupt: 'observe' },
          ),
        );
        while (frames.requested.length === 0) yield* sleep(1);
        waiting.abort(stop);
        late.abort(stop);
        return { waiting: show(yield* result(waiting)), late: show(yield* result(late)) };
      }),
    );
    expect({ ...seen, requested: frames.requested, cancelled: frames.cancelled }).toEqual({
      waiting: 'success("caught stop")',
      late: 'success("caught stop")',
      requested: [1],
      cancelled: [1],
    });
  });

  it("without requestAnimationFrame, a halt clears the 16 ms timer; a frame that fires leaves no listener on the node's signal", async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const root = app();
    const seen = await within(
      root.call(function* () {
        const before = getEventListeners(signal(), 'abort').length;
        for (let i = 0; i < 3; i++) yield* nextFrame();
        const afterFrames = getEventListeners(signal(), 'abort').length - before;
        const f = fork(
          task(function* () {
            yield* nextFrame();
          }),
        );
        const frameTimers = (): unknown[] => setSpy.mock.calls.flatMap((c, i) => (c[1] === 16 ? [setSpy.mock.results[i]!.value] : []));
        const known = frameTimers().length;
        while (frameTimers().length === known) yield* sleep(1);
        const timer = frameTimers()[known];
        f.abort();
        yield* result(f);
        return { afterFrames, cleared: clearSpy.mock.calls.some((c) => c[0] === timer) };
      }),
    );
    expect(seen).toEqual({ afterFrames: 0, cleared: true });
  });
});

// --- each ----------------------------------------------------------------------------------------------------------

describe('platform: each', () => {
  it('a halt during the first read stops waiting at once, and the source is returned once before the node completes', async () => {
    let reads = 0;
    let returns = 0;
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          reads++;
          return new Promise<IteratorResult<number>>(() => {}); // a read that never settles
        },
        return: () => {
          returns++;
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
    const root = app();
    const outcome = await within(
      root.call(function* () {
        const f = fork(
          task(function* () {
            for (const _ of yield* each(source)) yield* each.next();
          }),
        );
        while (reads === 0) yield* sleep(1);
        f.abort();
        return (yield* result(f)).status;
      }),
    );
    expect({ outcome, reads, returns }).toEqual({ outcome: 'aborted', reads: 1, returns: 1 });
  });

  it('a pass without yield* each.next() throws a TypeError at the loop head, and the source is returned there', async () => {
    const t = trace();
    const source = recordingSource([1, 2, 3], t);
    const root = app();
    const seen = await within(
      root.call(function* () {
        const items: number[] = [];
        try {
          for (const x of yield* each(source)) items.push(x);
        } catch (e) {
          t.push(`caught ${e instanceof TypeError ? 'TypeError' : label(e)}`);
        }
        return items;
      }),
    );
    expect({ seen, returns: source.returns, log: t.log }).toEqual({
      seen: [1],
      returns: 1,
      log: ['return()', 'caught TypeError', 'source closed'],
    });
  });

  it('each.next() outside a loop, after the loop, and each() of no async iterable are TypeErrors', async () => {
    const t = trace();
    const root = app();
    const outside = await within(root.attempt(function* () {
      yield* each.next();
    }));
    const after = await within(
      root.attempt(function* () {
        for (const _ of yield* each(recordingSource([1], t))) yield* each.next();
        yield* each.next();
      }),
    );
    const named = (o: unknown): boolean => {
      const e = (o as { error?: unknown }).error;
      return e instanceof TypeError && e.message.startsWith('each.next() outside');
    };
    expect({
      outside: [outside.status, named(outside)],
      after: [after.status, named(after)],
      made: outcomeOf(() => each([1, 2] as unknown as AsyncIterable<number>)),
    }).toEqual({ outside: ['defect', true], after: ['defect', true], made: 'TypeError' });
  });

  it("releaseAll() inside a loop releases the iteration's entry, returning the source; the loop then ends at its next read", async () => {
    const t = trace();
    const source = recordingSource([1, 2, 3], t);
    const root = app();
    const outcome = await within(
      root.attempt(function* () {
        const items: number[] = [];
        for (const x of yield* each(source)) {
          items.push(x);
          if (x === 1) yield* releaseAll();
          yield* each.next();
        }
        return items.join(',');
      }),
    );
    expect({ outcome: show(outcome), returns: source.returns, log: t.log }).toEqual({
      outcome: 'success("1")',
      returns: 1,
      log: ['return()', 'source closed'],
    });
  });

  it('nested loops: each.next() advances the innermost; exhausted and empty sources are never returned', async () => {
    const t = trace();
    const sources: { returns: number }[] = [];
    const make = <T>(values: readonly T[]) => {
      const s = recordingSource(values, t);
      sources.push(s);
      return s;
    };
    const root = app();
    const seen = await within(
      root.call(function* () {
        const pairs: string[] = [];
        for (const o of yield* each(make(['a', 'b']))) {
          for (const i of yield* each(make([1, 2]))) {
            pairs.push(`${o}${i}`);
            yield* each.next();
          }
          for (const _ of yield* each(make([]))) pairs.push('never');
          yield* each.next();
        }
        return pairs;
      }),
    );
    expect({ seen, returns: sources.map((s) => s.returns), closed: t.log.filter((l) => l === 'source closed').length }).toEqual({
      seen: ['a1', 'a2', 'b1', 'b2'],
      returns: [0, 0, 0, 0, 0],
      closed: 5,
    });
  });

  it("a failed read is thrown at the yield* and the source is never returned; a return() that rejects is the node's release failure", async () => {
    const boom = new Error('boom');
    const closing = new Error('closing');
    let returns = 0;
    const failing: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => {
        let n = 0;
        return {
          next: () => (++n === 1 ? Promise.resolve({ value: 1, done: false }) : Promise.reject(boom)),
          return: () => {
            returns++;
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
    const rejecting: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ value: 1, done: false }),
        return: () => Promise.reject(closing),
      }),
    };
    const root = app();
    const read = await within(
      root.attempt(function* () {
        for (const _ of yield* each(failing)) yield* each.next();
      }),
    );
    // Caught inside the loop: the loop is over, and ends at its head.
    const inside = await within(
      root.attempt(function* () {
        let passes = 0;
        let caught = 'nothing';
        for (const _ of yield* each(failing)) {
          passes++;
          try {
            yield* each.next();
          } catch (e) {
            caught = label(e, { boom });
          }
        }
        return `${passes} ${caught}`;
      }),
    );
    // Caught in an outer loop's pass: the inner loop is over, and the outer one goes on.
    const t = trace();
    const caught = await within(
      root.attempt(function* () {
        const passes: string[] = [];
        for (const o of yield* each(recordingSource(['a', 'b'], t))) {
          try {
            for (const _ of yield* each(failing)) yield* each.next();
          } catch (e) {
            passes.push(`${o} ${label(e, { boom })}`);
          }
          yield* each.next();
        }
        return passes.join(', ');
      }),
    );
    const closed = await within(
      root.attempt(function* () {
        for (const _ of yield* each(rejecting)) break;
        return 'left';
      }),
    );
    expect({
      read: show(read, { boom }),
      inside: show(inside),
      caught: show(caught),
      returns,
      closed: show(closed, { closing }),
    }).toEqual({
      read: 'defect(boom)',
      inside: 'success("1 boom")',
      caught: 'success("a boom, b boom")',
      returns: 0,
      closed: 'defect(closing)',
    });
  });

  it('a fail inside the loop ends the body with its failure and returns the source', async () => {
    const t = trace();
    const source = recordingSource([1, 2, 3], t);
    const nope = new Error('nope');
    const root = app();
    const outcome = await within(
      root.attempt(function* () {
        for (const x of yield* each(source)) {
          if (x === 2) yield* fail(nope);
          yield* each.next();
        }
      }),
    );
    expect({ outcome: show(outcome, { nope }), returns: source.returns, log: t.log }).toEqual({
      outcome: 'failure(nope)',
      returns: 1,
      log: ['return()', 'source closed'],
    });
  });
});
