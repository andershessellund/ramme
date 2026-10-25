// sleep.test.ts — `sleep(ms)` and `ctx.sleep(ms)`, ramme's timer (D34 as D41 amends it, DESIGN.md §4.14).
//
// A lazy work op over a timer: making it arms nothing; the timer is armed when the op runs, at its `yield*` (or its
// `then`). A delivered `freeze` or `restore` body waiting on it is halted at once, and the halt clears the timer: no
// rejection, the body is returned. A body already delivered at the `yield*` does not run it, so arms no timer. Where
// nothing halts the waiter (an `observe` body, a release fiber, a failure handler, top level) it runs its full
// duration. Body-shaped like `never`.
//
// Fake timers fake only setTimeout, clearTimeout and Date: `tick()` and ramme's microtasks stay real.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber, Op } from './context.js';
import { currentFrame } from './context-storage.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { RequestScope } from './scope.js';
import { current, fork, never, own, signal, sleep, wait } from './ambient.js';
import { CreationViolationError, NoCurrentNodeError, PendingNodeError } from './resource.js';
import { deferred, impl, start, tick, trace, within } from './test/util.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

/** A handler for forks onto the bodiless root (D14). */
const quiet = { onFailure: () => {} } as const;

describe('sleep resolves after ms (DESIGN.md §4.2)', () => {
  it('in a body, after ms and not before', async () => {
    fakeTimers();
    const app = createRootContext();
    const t = trace();
    const done = start(app.call(function* () {
      t.push('before');
      yield* sleep(100);
      t.push('after');
    }));
    await tick();
    vi.advanceTimersByTime(99);
    await tick();
    expect(t.log).toEqual(['before']);
    vi.advanceTimersByTime(1);
    await done;
    expect(t.log).toEqual(['before', 'after']);
    await app.close();
  });

  it('ctx.sleep at top level is a plain delay', async () => {
    fakeTimers();
    const app = createRootContext();
    let done = false;
    const p = app.sleep(100).then(() => {
      done = true;
    });
    vi.advanceTimersByTime(99);
    await tick();
    expect(done).toBe(false);
    vi.advanceTimersByTime(1);
    await p;
    expect(done).toBe(true);
    await app.close();
  });

  it('its timer is armed outside every frame and is not unref’d: it keeps the process alive like any timer', async () => {
    const armed: { frame: unknown; timer: ReturnType<typeof setTimeout> }[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const timer = real(fn, ms);
      armed.push({ frame: currentFrame(), timer });
      return timer;
    }) as typeof setTimeout);
    const app = createRootContext();
    await app.call(function* () {
      yield* sleep(1); // a target: the body
    });
    await app.sleep(1); // no target: a plain delay, which must keep the process alive until it resolves
    expect(armed).toHaveLength(2);
    expect(armed[0].frame).toBeUndefined(); // DESIGN.md §6: not the body's frame
    for (const a of armed) expect((a.timer as unknown as { hasRef(): boolean }).hasRef()).toBe(true);
    await app.close();
  });
});

describe('the halt clears the timer (DESIGN.md §4.14, D34)', () => {
  it('a freeze fiber waiting on sleep is halted at delivery, its timer cleared at once, no catch run, and its node releases after the body unwinds, not after 10 s', async () => {
    fakeTimers();
    const app = createRootContext();
    const t = trace();
    const f = app.fork(
      task(function* () {
        own(t.at('released'));
        try {
          yield* sleep(10_000);
          t.push('resumed');
        } catch (e) {
          t.push(`caught: ${(e as Error).name}`);
          throw e;
        } finally {
          t.push('finally');
        }
      }, quiet),
    );
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    f.abort();
    expect(vi.getTimerCount()).toBe(0); // cleared inside abort(), with the delivery (D34)
    expect(f.state).toBe('running'); // the return is a queued job (DESIGN.md §4.14)
    await tick();
    expect(f.state).toBe('complete');
    expect(f.outcome?.status).toBe('aborted');
    vi.advanceTimersByTime(10_000);
    await tick();
    expect(t.log).toEqual(['finally', 'released']);
    await app.close();
  });

  it('a restore body likewise', async () => {
    fakeTimers();
    const app = createRootContext();
    const t = trace();
    const f = app.fork(
      task(
        function* () {
          own(t.at('released'));
          yield* sleep(10_000);
          t.push('resumed');
        },
        { ...quiet, interrupt: 'restore' },
      ),
    );
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    f.abort();
    expect(vi.getTimerCount()).toBe(0);
    await tick();
    expect(f.state).toBe('complete');
    expect(f.outcome?.status).toBe('aborted');
    expect(t.log).toEqual(['released']);
    await app.close();
  });

  it('a stored, never-yielded sleep arms no timer: a work op runs only when consumed (D41, decision 2)', async () => {
    fakeTimers();
    const app = createRootContext();
    let stored: Op<void> | undefined;
    const f = app.fork(
      task(function* () {
        stored = sleep(10_000); // made, never yielded
        yield* never();
      }, quiet),
    );
    await tick();
    expect(stored).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
    f.abort();
    expect(vi.getTimerCount()).toBe(0);
    expect((await within(app.result(f))).status).toBe('aborted');
    await app.close();
  });

  it('a body already delivered arms no timer: a fork born under a delivered freeze parent, and a body running plain code after its delivery (I8), are returned at yield* sleep(1e6) without running it', async () => {
    fakeTimers();
    const app = createRootContext();
    const t = trace();
    let born!: Fiber<void>;
    const outcome = await app.attempt(function* () {
      current().abort(); // delivered; this body is running plain code (I8)
      born = fork(function* () {
        try {
          yield* sleep(1e6); // born delivered (D12): returned at its first yield* of an op not yet started (decision 9)
          t.push('fork resumed');
        } catch (e) {
          t.push(`fork: ${(e as Error).name}`);
        } finally {
          t.push('fork finally');
        }
      });
      yield* wait(tick(2)); // started before it was yielded: the halt lets it finish; the fork starts and is returned
      t.push(`timers after the fork's sleep: ${vi.getTimerCount()}`);
      yield* sleep(1e6);
      t.push('body resumed');
    });
    expect(outcome.status).toBe('aborted');
    expect(t.log).toEqual(['fork finally', "timers after the fork's sleep: 0"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(born.outcome?.status).toBe('aborted'); // by state (D24)
    await app.close();
  });
});

describe('nothing halts the waiter: the full duration (DESIGN.md §4.14, §4.7)', () => {
  it('an observe body delivered mid-sleep resumes after the full ms', async () => {
    fakeTimers();
    const app = createRootContext();
    const t = trace();
    const f = app.fork(
      task(
        function* () {
          yield* sleep(100);
          t.push(`resumed; signal aborted: ${signal().aborted}`);
          return 'shut down';
        },
        { ...quiet, interrupt: 'observe' },
      ),
    );
    await tick();
    vi.advanceTimersByTime(50);
    f.abort();
    await tick();
    vi.advanceTimersByTime(49);
    await tick();
    expect(t.log).toEqual([]);
    vi.advanceTimersByTime(1);
    await tick();
    expect(t.log).toEqual(['resumed; signal aborted: true']);
    expect(f.outcome).toEqual({ status: 'success', value: 'shut down' });
    await app.close();
  });

  it('a release fiber may sleep, past its own deadline', async () => {
    const app = createRootContext({ releaseTimeoutMs: 5 });
    const N = app.child();
    const t = trace();
    let slept = 0;
    N.own(function* slowRelease() {
      const start = performance.now();
      yield* sleep(30);
      slept = performance.now() - start;
      t.push(`slept; deadline fired: ${signal().aborted}`);
    });
    await within(N.close());
    expect(t.log).toEqual(['slept; deadline fired: true']); // an observe node: the deadline is a signal, never an end (D21)
    expect(slept).toBeGreaterThanOrEqual(29);
    await app.close();
  });

  it("a fork's onFailure handler that does await sleep(20) while its parent is aborted still resumes, and the parent completes", async () => {
    const app = createRootContext();
    const t = trace();
    let P!: Context;
    const parent = start(app.attempt(function* () {
      P = current();
      fork(
        task(
          function* () {
            throw new Error('child failed');
          },
          {
            onFailure: function* () {
              t.push('handler waits');
              yield* sleep(20); // a handler is never halted (DESIGN.md §4.7): the parent's delivery leaves its sleep
              t.push('handler resumed');
            },
          },
        ),
      );
      yield* never();
    }));
    await tick(2);
    expect(t.log).toEqual(['handler waits']);
    P.abort();
    expect((await within(parent)).status).toBe('aborted');
    expect(t.log).toEqual(['handler waits', 'handler resumed']);
    expect(P.state).toBe('complete');
    await app.close();
  });
});

describe("a failure handler yielding a sleep its parent's body made runs it afresh (DESIGN.md §4.7, D34)", () => {
  it("on a timer of its own, armed at the handler's yield*, for the full ms, which the parent's delivery does not clear; the parent completes after it", async () => {
    fakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createRootContext();
    const t = trace();
    let P!: Context;
    const parent = start(
      app.attempt(function* () {
        P = current();
        const backoff = sleep(50); // made by the body, its receiver P; never yielded by the body
        fork(
          task(
            function* () {
              throw new Error('child failed');
            },
            {
              onFailure: function* () {
                t.push('handler waits');
                yield* backoff; // runs it now, for the handler: nothing halts a handler
                t.push('handler resumed');
              },
            },
          ),
        );
        yield* never();
      }),
    );
    await tick(2);
    expect(t.log).toEqual(['handler waits']);
    expect(vi.getTimerCount()).toBe(1); // the handler's: the body never ran its sleep
    P.abort();
    expect(vi.getTimerCount()).toBe(1); // the parent's delivery does not touch the handler's wait
    vi.advanceTimersByTime(49);
    await tick();
    expect(t.log).toEqual(['handler waits']);
    vi.advanceTimersByTime(1);
    await tick();
    expect(t.log).toEqual(['handler waits', 'handler resumed']);
    expect(P.state).toBe('complete'); // the handler's hold ended: the parent is not held open forever
    expect((await parent).status).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('sleep is body-shaped, like never and wait (DESIGN.md §3.3, §3.5, §4.7)', () => {
  it('in creation it throws CreationViolationError, free or through the value’s live node', async () => {
    class Hoisted {
      constructor() {
        void sleep(1);
      }
    }
    class Declared {
      static readonly scope = RequestScope;
      constructor() {
        void current().sleep(1); // declared placement: the node is live, not pending (D27)
      }
    }
    const app = createRootContext();
    expect(() => app.get(Hoisted)).toThrow(CreationViolationError);
    const req = app.child({ scopes: [RequestScope] });
    expect(() => req.get(Declared)).toThrow(CreationViolationError);
    await app.close();
  });

  it('the free function outside any node throws NoCurrentNodeError', () => {
    expect(() => sleep(1)).toThrow(NoCurrentNodeError);
  });

  it('ctx.sleep on a pending node throws PendingNodeError', async () => {
    let refused: unknown;
    const K = createInjectionKey<object>('K', {
      factory: () => {
        const n = current(); // the auto-hoisted value's node: pending until placement
        try {
          void n.sleep(1);
        } catch (e) {
          refused = e;
        }
        return {};
      },
    });
    const app = createRootContext();
    app.get(K);
    expect(refused).toBeInstanceOf(PendingNodeError);
    await app.close();
  });

  it('NaN, negative, ±Infinity, 2 ** 31 and a non-number throw RangeError before a timer is armed; 0 and 2 ** 31 - 1 are accepted', async () => {
    fakeTimers();
    const app = createRootContext();
    const bad: unknown[] = [NaN, -1, Infinity, -Infinity, 2 ** 31, '10', undefined, null, 10n];
    await app.call(function* () {
      for (const ms of bad) expect(() => sleep(ms as number), String(ms)).toThrow(RangeError);
      expect(() => sleep(NaN)).toThrow(/ms must be a number of milliseconds in \[0, 2147483647\] \(got NaN\); for an unbounded wait, use never\(\)/);
      expect(() => sleep('10' as unknown as number)).toThrow(/\(got "10"\)/);
    });
    for (const ms of bad) expect(() => app.sleep(ms as number)).toThrow(RangeError);
    expect(vi.getTimerCount()).toBe(0);
    void start(app.sleep(2 ** 31 - 1)); // armed when run: through its then here
    void start(app.sleep(0));
    expect(vi.getTimerCount()).toBe(2);
    vi.clearAllTimers();
    await app.close();
  });

  it("a body's onApplied holds only its driver's halt hook while it waits, and nothing once it resumed: it does not grow across many completed sleeps", async () => {
    const app = createRootContext();
    const gate = deferred();
    const reached = deferred();
    let me!: ReturnType<typeof impl>;
    const sizes: number[] = [];
    const f = app.fork(
      task(function* () {
        me = impl(current());
        for (let i = 0; i < 50; i++) yield* sleep(0);
        sizes.push(me.onApplied.size); // in a step: nothing is subscribed
        reached.resolve();
        yield* wait(gate.promise);
        sizes.push(me.onApplied.size);
      }, quiet),
    );
    await within(reached.promise);
    sizes.push(me.onApplied.size); // suspended on the wait: its hook
    gate.resolve();
    await within(app.result(f));
    expect(sizes).toEqual([0, 1, 0]);
    await app.close();
  });
});
