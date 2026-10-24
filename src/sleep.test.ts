// sleep.test.ts — `sleep(ms)` and `ctx.sleep(ms)`, ramme's timer (D34, DESIGN.md §4.2).
//
// A managed await over a timer whose freeze target is managed.ts `freezeTarget()` when the promise is made: a
// delivered `freeze` or `restore` body awaiting it is frozen, and the target's delivery clears the timer, whether
// the sleep is awaited or only stored. A target already applied arms no timer. Without a target (an `observe` body,
// a release fiber, a failure handler, top level) it runs its full duration. A failure handler that awaits a sleep a
// body made waits on a timer of its own, to that sleep's deadline. Body-shaped like `never`.
//
// Fake timers fake only setTimeout, clearTimeout and Date: `tick()` and ramme's microtasks stay real.
import { afterEach, describe, expect, it, vi } from 'vitest';
import './node.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber } from './context.js';
import { currentFrame } from './context-storage.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { RequestScope } from './scope.js';
import { call, current, fork, managed, never, own, signal, sleep } from './ambient.js';
import { CreationViolationError, NoCurrentNodeError, PendingNodeError, UnawaitedCallError } from './resource.js';
import { deferred, impl, tick, trace, within } from './test/util.js';

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
    const done = app.call(async () => {
      t.push('before');
      await sleep(100);
      t.push('after');
    });
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
    await app.call(async () => {
      await sleep(1); // a target: the body
    });
    await app.sleep(1); // no target: a plain delay, which must keep the process alive until it resolves
    expect(armed).toHaveLength(2);
    expect(armed[0].frame).toBeUndefined(); // DESIGN.md §6: not the body's frame
    for (const a of armed) expect((a.timer as unknown as { hasRef(): boolean }).hasRef()).toBe(true);
    await app.close();
  });
});

describe('interruption clears the timer (DESIGN.md §4.2, D34)', () => {
  it('a freeze fiber awaiting sleep is frozen at delivery and its node releases at once; no timer remains', async () => {
    fakeTimers();
    const app = createRootContext();
    const t = trace();
    const f = app.fork(
      task(async () => {
        own(t.at('released'));
        await sleep(10_000);
        t.push('resumed');
      }, quiet),
    );
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    f.abort();
    expect(f.state).toBe('complete'); // released inside abort(), not after 10 s (DESIGN.md §2.4)
    expect(f.outcome?.status).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    await tick();
    expect(t.log).toEqual(['released']);
    await app.close();
  });

  it('a restore body likewise', async () => {
    fakeTimers();
    const app = createRootContext();
    const t = trace();
    const f = app.fork(
      task(
        async () => {
          own(t.at('released'));
          await sleep(10_000);
          t.push('resumed');
        },
        { ...quiet, interrupt: 'restore' },
      ),
    );
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    f.abort();
    expect(f.state).toBe('complete');
    expect(f.outcome?.status).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
    expect(t.log).toEqual(['released']);
    await app.close();
  });

  it('a stored, not-yet-awaited sleep in a freeze body is cleared at the body’s delivery', async () => {
    fakeTimers();
    const app = createRootContext();
    let stored: Promise<void> | undefined;
    const f = app.fork(
      task(async () => {
        stored = sleep(10_000); // made, never awaited
        await never();
      }, quiet),
    );
    await tick();
    expect(stored).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);
    f.abort();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.state).toBe('complete');
    await app.close();
  });

  it('a target already applied arms no timer: a fork born under a delivered freeze parent, and a body running plain code after its delivery (I8), freeze on await sleep(1e6)', async () => {
    fakeTimers();
    const app = createRootContext();
    const t = trace();
    let born!: Fiber<void>;
    const outcome = await app.attempt(async () => {
      current().abort(); // delivered; this body is running plain code (I8)
      born = fork(async () => {
        await sleep(1e6); // born delivered (D12): its first managed await freezes it (DESIGN.md §4.6)
        t.push('fork resumed');
      });
      await tick(2); // a bare await: the fork starts and reaches its sleep
      t.push(`timers after the fork's sleep: ${vi.getTimerCount()}`);
      await sleep(1e6);
      t.push('body resumed');
    });
    expect(outcome.status).toBe('aborted');
    expect(t.log).toEqual(["timers after the fork's sleep: 0"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(born.outcome?.status).toBe('aborted');
    expect(impl(born).frozen).toBe(true);
    await app.close();
  });
});

describe('no target: the full duration (DESIGN.md §4.2, §4.7)', () => {
  it('an observe body delivered mid-sleep resumes after the full ms', async () => {
    fakeTimers();
    const app = createRootContext();
    const t = trace();
    const f = app.fork(
      task(
        async () => {
          await sleep(100);
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
    N.own(async function slowRelease() {
      const start = performance.now();
      await sleep(30);
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
    const parent = app.attempt(async () => {
      P = current();
      fork(
        task(
          async () => {
            throw new Error('child failed');
          },
          {
            onFailure: async () => {
              t.push('handler waits');
              await sleep(20); // a handler's awaits never freeze (DESIGN.md §4.7): the parent's delivery leaves it
              t.push('handler resumed');
            },
          },
        ),
      );
      await never();
    });
    await tick(2);
    expect(t.log).toEqual(['handler waits']);
    P.abort();
    expect((await within(parent)).status).toBe('aborted');
    expect(t.log).toEqual(['handler waits', 'handler resumed']);
    expect(P.state).toBe('complete');
    await app.close();
  });
});

describe("a failure handler awaiting a sleep its parent's body made waits on a timer of its own (DESIGN.md §4.7, D34)", () => {
  /** A fork onto the current body whose failure handler runs `onFailure`. */
  function failingFork(onFailure: () => Promise<void>): void {
    fork(
      task(
        async () => {
          throw new Error('child failed');
        },
        { onFailure },
      ),
    );
  }

  it("already waiting when the parent is delivered: the delivery clears the body's timer, and the handler resumes at the sleep's deadline", async () => {
    fakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createRootContext();
    const t = trace();
    let P!: Context;
    const parent = app.attempt(async () => {
      P = current();
      const backoff = sleep(50); // stored by the body: its target is P
      failingFork(async () => {
        t.push('handler waits');
        await backoff;
        t.push('handler resumed');
      });
      await never();
    });
    await tick(2);
    expect(t.log).toEqual(['handler waits']);
    expect(vi.getTimerCount()).toBe(2); // the body's timer and the handler's own
    P.abort();
    expect(vi.getTimerCount()).toBe(1); // the body's is cleared (D34); the handler's is not the body's
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

  it('first awaited after the delivery froze the body on it: the handler resumes at the sleep’s deadline, for the time left, unwarned', async () => {
    fakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createRootContext();
    const t = trace();
    const gate = deferred();
    const box: { s?: Promise<void> } = {};
    let P!: Context;
    const parent = app.attempt(async () => {
      P = current();
      box.s = sleep(50);
      failingFork(async () => {
        await gate.promise; // bare: the handler reaches the sleep only after the delivery
        t.push('handler waits');
        await box.s;
        t.push('handler resumed');
      });
      await box.s; // the body is suspended on the sleep: the delivery cuts it
    });
    await tick(2);
    vi.advanceTimersByTime(20);
    P.abort();
    expect(impl(P).frozen).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // the body's timer is cleared (D34)
    gate.resolve();
    await tick();
    expect(t.log).toEqual(['handler waits']);
    expect(vi.getTimerCount()).toBe(1); // the handler's own, for the 30 ms left
    vi.advanceTimersByTime(29);
    await tick();
    expect(t.log).toEqual(['handler waits']);
    vi.advanceTimersByTime(1);
    await tick();
    expect(t.log).toEqual(['handler waits', 'handler resumed']);
    expect(P.state).toBe('complete');
    expect((await parent).status).toBe('aborted');
    expect(warn).not.toHaveBeenCalled();
    await app.close();
  });

  it('a wall clock set back does not stretch the handler’s wait past ms', async () => {
    fakeTimers();
    const app = createRootContext();
    const t = trace();
    const gate = deferred();
    const box: { s?: Promise<void> } = {};
    let P!: Context;
    const parent = app.attempt(async () => {
      P = current();
      box.s = sleep(50);
      failingFork(async () => {
        await gate.promise;
        await box.s;
        t.push('handler resumed');
      });
      await never();
    });
    await tick(2);
    P.abort();
    vi.setSystemTime(Date.now() - 10_000); // the deadline now lies 10 050 ms ahead by the clock
    gate.resolve();
    await tick();
    vi.advanceTimersByTime(49);
    await tick();
    expect(t.log).toEqual([]);
    vi.advanceTimersByTime(1);
    await tick();
    expect(t.log).toEqual(['handler resumed']);
    expect((await parent).status).toBe('aborted');
    await app.close();
  });

  it('made by the body after its delivery, where no timer is armed (the applied path): the handler resumes at the sleep’s deadline', async () => {
    fakeTimers();
    const app = createRootContext();
    const t = trace();
    const gate = deferred();
    const box: { s?: Promise<void> } = {};
    let P!: Context;
    const parent = app.attempt(async () => {
      P = current();
      failingFork(async () => {
        await gate.promise;
        await box.s;
        t.push('handler resumed');
      });
      await tick(2); // bare: the fork fails and its handler waits on the gate
      current().abort(); // delivered: this body runs plain code (I8)
      box.s = sleep(50); // a target already applied: no timer (D34)
      t.push(`timers after the body's sleep: ${vi.getTimerCount()}`);
      gate.resolve();
      await never();
    });
    await tick(4);
    expect(t.log).toEqual(["timers after the body's sleep: 0"]);
    expect(vi.getTimerCount()).toBe(1); // the handler's own
    vi.advanceTimersByTime(49);
    await tick();
    expect(P.state).toBe('releasing'); // held open by the handler
    vi.advanceTimersByTime(1);
    await tick();
    expect(t.log).toEqual(["timers after the body's sleep: 0", 'handler resumed']);
    expect(P.state).toBe('complete');
    expect((await parent).status).toBe('aborted');
    await app.close();
  });
});

describe('sleep is body-shaped, like never and managed (DESIGN.md §3.3, §3.5, §4.7, §4.9)', () => {
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

  it('sleep in a body whose node is lent throws UnawaitedCallError, and so does a failure handler through its lent parent', async () => {
    const app = createRootContext();
    let viaHandler: unknown;
    await app.call(async () => {
      const gate = deferred();
      const pending = call(async () => {
        await managed(gate.promise);
      }); // not awaited: this body is lent (DESIGN.md §4.9)
      expect(() => sleep(1)).toThrow(UnawaitedCallError);
      gate.resolve();
      await pending;

      fork(
        task(
          async () => {
            throw new Error('child failed');
          },
          {
            onFailure: () => {
              try {
                void sleep(1); // HANDLER_MAY_WHILE_LENT has no sleep: a handler forks the wait instead
              } catch (e) {
                viaHandler = e;
              }
            },
          },
        ),
      );
      await call(async () => {
        await tick(3); // the fork fails while this body is lent to the call
      });
    });
    expect(viaHandler).toBeInstanceOf(UnawaitedCallError);
    await app.close();
  });

  it('NaN, negative, ±Infinity, 2 ** 31 and a non-number throw RangeError before a timer is armed; 0 and 2 ** 31 - 1 are accepted', async () => {
    fakeTimers();
    const app = createRootContext();
    const bad: unknown[] = [NaN, -1, Infinity, -Infinity, 2 ** 31, '10', undefined, null, 10n];
    await app.call(async () => {
      for (const ms of bad) expect(() => sleep(ms as number), String(ms)).toThrow(RangeError);
      expect(() => sleep(NaN)).toThrow(/ms must be a number of milliseconds in \[0, 2147483647\] \(got NaN\); for an unbounded wait, use never\(\)/);
      expect(() => sleep('10' as unknown as number)).toThrow(/\(got "10"\)/);
    });
    for (const ms of bad) expect(() => app.sleep(ms as number)).toThrow(RangeError);
    expect(vi.getTimerCount()).toBe(0);
    void app.sleep(2 ** 31 - 1);
    void app.sleep(0);
    expect(vi.getTimerCount()).toBe(2);
    vi.clearAllTimers();
    await app.close();
  });

  it("the target's onApplied does not grow across many completed sleeps", async () => {
    const app = createRootContext();
    await app.call(async () => {
      const me = impl(current());
      for (let i = 0; i < 50; i++) await sleep(0);
      expect(me.onApplied.size).toBe(0);
      const s = sleep(1);
      expect(me.onApplied.size).toBe(1); // the clear-only entry, while the timer is armed
      await s;
      expect(me.onApplied.size).toBe(0);
    });
    await app.close();
  });
});
