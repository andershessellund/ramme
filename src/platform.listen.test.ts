// Tests for platform / listen.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { current, fork, join, lookup, own, sleep } from './ambient.js';
import type { Context, Fiber } from './context.js';
import { createInjectionKey } from './context-key.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { listen } from './platform.js';
import { valueProvider } from './provider-util.js';
import { NoCurrentNodeError } from './resource.js';
import { tick, trace, within } from '../tests/support/util.js';
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

// --- listen ------------------------------------------------------------------------------------------------------

describe('listen', () => {
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
