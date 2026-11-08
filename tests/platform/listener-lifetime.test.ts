// Tests for platform / listener lifetime.
import { EventEmitter, getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { current, fork, join, lookup, never, releaseAll, result, signal, sleep, wait } from '../../src/ambient.js';
import type { Context, Fiber } from '../../src/context.js';
import { createInjectionKey } from '../../src/context-key.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { listen } from '../../src/platform.js';
import { deferred, events, within } from '../support/util.js';
import { labelError as label, showError as show } from '../support/observations.js';

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

function outcomeOf(f: () => unknown): string {
  try {
    f();
    return 'returned';
  } catch (e) {
    return e instanceof Error ? e.constructor.name : String(e);
  }
}

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
