// pool.test.ts — IMPLEMENTATION.md §6.1: pools (§7.7, §4.12, D-16, D-47).
// S1 covers the core scenarios; S2 adds the seven ported fiber-set cases (a
// pool created in a constructor on the pending node) at the end of the file.
import { describe, expect, it, vi } from 'vitest';
import './node.js';
import { createInjectionKey } from './context-key.js';
import type { Fiber, Pool } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { factoryProvider, valueProvider } from './provider-util.js';
import { NodeCompletedError, PoolClosedError, PoolFullError } from './resource.js';
import { createScope } from './scope.js';
import { lookup, own } from './ambient.js';
import { deferred, here, impl, tick, trace } from './test/util.js';

const quiet = { name: 'pool', onFailure: () => {} };

describe('pools (§7.7)', () => {
  it('pool(opts) validates its options', async () => {
    const app = createRootContext();
    expect(() => app.pool({ name: 'p' } as never)).toThrow(TypeError);
    expect(() => app.pool({ name: 'p', onFailure: 'join' } as never)).toThrow(TypeError);
    expect(() => app.pool({ onFailure: () => {} } as never)).toThrow(TypeError);
    expect(() => app.pool({ ...quiet, concurrency: 0 })).toThrow(TypeError);
    expect(() => app.pool({ ...quiet, concurrency: 1.5 })).toThrow(TypeError);
    expect(() => app.pool({ ...quiet, whenFull: 'drop' as never })).toThrow(TypeError);
    await app.close();
  });

  it("a pool's forks are its subscribers; the pool is an unsubscribed entry of its owner; pool.fork lends nothing", async () => {
    const app = createRootContext();
    const pool = app.pool(quiet);
    const gate = deferred();
    const f = pool.fork(async () => {
      await gate.promise;
    });
    const P = impl(pool);
    expect(P.kind).toBe('pool');
    expect(P.subscribed).toBe(false);
    expect(P.subscribers.has(impl(f))).toBe(true);
    expect(impl(f).parent).toBe(P);
    expect(P.lentTo).toBeUndefined();
    gate.resolve();
    await app.close();
  });

  it("the destination is always the pool's onFailure, whatever the task declares", async () => {
    const app = createRootContext();
    const onFailure = vi.fn();
    const pool = app.pool({ name: 'p', onFailure });
    const e1 = new Error('one');
    const e2 = new Error('two');
    const f1 = pool.fork(
      task(
        async () => {
          throw e1;
        },
        { onFailure: 'link' },
      ),
    );
    const f2 = pool.fork(async () => {
      throw e2;
    });
    await tick();
    expect(onFailure.mock.calls).toEqual([
      [e1, f1],
      [e2, f2],
    ]);
    expect(pool.signal.aborted).toBe(false); // not linked
    await expect(app.close()).resolves.toBeUndefined(); // handled
  });

  it("concurrency with whenFull 'wait' queues; running and pending move as fibers complete", async () => {
    const app = createRootContext();
    const pool = app.pool({ ...quiet, concurrency: 2 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const fibers = gates.map((g, i) =>
      pool.fork(async () => {
        started.push(i);
        await g.promise;
      }),
    );
    await tick();
    expect([pool.running, pool.pending]).toEqual([2, 2]);
    expect(started).toEqual([0, 1]);
    gates[0].resolve();
    await tick();
    expect([pool.running, pool.pending]).toEqual([2, 1]);
    expect(started).toEqual([0, 1, 2]);
    gates[1].resolve();
    gates[2].resolve();
    await tick();
    expect([pool.running, pool.pending]).toEqual([1, 0]);
    gates[3].resolve();
    await tick();
    expect([pool.running, pool.pending]).toEqual([0, 0]);
    expect(fibers.every((f) => f.outcome?.status === 'success')).toBe(true);
    await app.close();
  });

  it("concurrency with whenFull 'reject' throws PoolFullError", async () => {
    const app = createRootContext();
    const pool = app.pool({ ...quiet, concurrency: 1, whenFull: 'reject' });
    const gate = deferred();
    pool.fork(() => gate.promise);
    expect(() => pool.fork(async () => {})).toThrow(PoolFullError);
    expect(() => pool.fork(async () => {})).toThrow(/is full \(1\)/);
    gate.resolve();
    await tick();
    expect(() => pool.fork(async () => {})).not.toThrow();
    await app.close();
  });

  it("a concurrency-1 'reject' pool restarts its failed worker from onFailure: the slot is free when the handler runs (D-119)", async () => {
    const t = trace();
    const app = createRootContext();
    let runs = 0;
    const work = task(
      async () => {
        t.push(`run ${++runs}`);
        if (runs === 1) throw new Error('first run');
      },
      { name: 'work' },
    );
    const pool: Pool = app.pool({
      name: 'p',
      concurrency: 1,
      whenFull: 'reject',
      onFailure: (_e, failed) => {
        t.push(`handler: failed ${failed.state}, running ${pool.running}`);
        pool.fork(work); // PoolFullError if the failed fiber still held its slot
      },
    });
    pool.fork(work);
    await tick(3);
    await expect(app.close()).resolves.toBeUndefined();
    expect(t.log).toEqual(['run 1', 'handler: failed complete, running 0', 'run 2']);
  });

  it("with whenFull 'wait', a waiter queued behind the failed fiber takes the freed slot before the handler's restart (D-119)", async () => {
    const t = trace();
    const app = createRootContext();
    const pool: Pool = app.pool({
      name: 'p',
      concurrency: 1,
      onFailure: () => {
        t.push(`handler: running ${pool.running}, pending ${pool.pending}`);
        pool.fork(async () => void t.push('restart'));
      },
    });
    pool.fork(async () => {
      t.push('first');
      throw new Error('first run');
    });
    pool.fork(async () => void t.push('waiter'));
    expect([pool.running, pool.pending]).toEqual([1, 1]);
    await tick(3);
    await expect(app.close()).resolves.toBeUndefined();
    expect(t.log).toEqual(['first', 'handler: running 1, pending 0', 'waiter', 'restart']); // FIFO
  });

  it("a waiting fiber cancelled by the owner's release never runs", async () => {
    const app = createRootContext();
    const pool = app.pool({ ...quiet, concurrency: 1 });
    let ran = false;
    const busy = pool.fork(async () => {
      await here().never();
    });
    const waiter = pool.fork(async () => {
      ran = true;
    });
    await tick();
    expect(pool.pending).toBe(1);
    await app.close();
    expect(ran).toBe(false);
    expect(waiter.outcome?.status).toBe('aborted');
    expect(busy.outcome?.status).toBe('aborted');
    expect([pool.running, pool.pending]).toEqual([0, 0]);
  });

  it('pool.close() drains the queue: waiters start as slots free (Q7, D-47)', async () => {
    const app = createRootContext();
    const pool = app.pool({ ...quiet, concurrency: 1 });
    const t = trace();
    const gates = [deferred(), deferred(), deferred()];
    gates.forEach((g, i) =>
      pool.fork(async () => {
        t.push(`start ${i}`);
        await g.promise;
        t.push(`end ${i}`);
      }),
    );
    await tick();
    const closing = pool.close();
    expect(() => pool.fork(async () => {})).toThrow(PoolClosedError);
    for (const g of gates) {
      g.resolve();
      await tick();
    }
    await closing;
    expect(t.log).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
    expect([pool.running, pool.pending]).toEqual([0, 0]);
    expect(pool.outcome?.status).toBe('success');
    await app.close();
  });

  it('pool.abort() cancels the queue: running fibers freeze, waiters settle aborted without running (D-47)', async () => {
    const app = createRootContext();
    const pool = app.pool({ ...quiet, concurrency: 1 });
    let waiterRan = false;
    const running = pool.fork(async () => {
      await here().never();
    });
    const waiter = pool.fork(async () => {
      waiterRan = true;
    });
    await tick();
    pool.abort();
    expect(() => pool.fork(async () => {})).toThrow(PoolClosedError);
    await pool.close();
    expect(running.outcome?.status).toBe('aborted');
    expect(waiter.outcome?.status).toBe('aborted');
    expect(waiterRan).toBe(false);
    expect([pool.running, pool.pending]).toEqual([0, 0]);
    expect(() => pool.fork(async () => {})).toThrow(NodeCompletedError);
    await app.close();
  });

  it('close() with waiters queued, then abort(): the waiters the close loop already passed settle aborted, and the pool completes (D-11, D-81)', async () => {
    for (const force of ['pool.abort()', "the owner's close()"] as const) {
      const app = createRootContext();
      const pool = app.pool({ ...quiet, concurrency: 1 });
      let ran = 0;
      const busy = pool.fork(async () => {
        await here().never(); // close() does not signal: only the abort ends it
      });
      const w1 = pool.fork(async () => void ran++);
      const w2 = pool.fork(async () => void ran++);
      await tick();
      expect([pool.running, pool.pending]).toEqual([1, 2]);
      const closing = pool.close(); // its loop waits on w2, the top entry
      await tick();
      expect(pool.state).toBe('releasing');
      if (force === 'pool.abort()') pool.abort();
      const appClosed = app.close(); // reaches the unsubscribed pool with an abort (D-11)
      await expect(closing, force).resolves.toBeUndefined();
      await expect(appClosed, force).resolves.toBeUndefined();
      expect([busy.outcome?.status, w1.outcome?.status, w2.outcome?.status], force).toEqual(['aborted', 'aborted', 'aborted']);
      expect(ran, force).toBe(0);
      expect([pool.running, pool.pending], force).toEqual([0, 0]);
    }
  });

  it('a waiter that settles unstarted leaves the queue at once, even while its own release is in flight; running never goes below 0 (D-81)', async () => {
    const app = createRootContext();
    const pool = app.pool({ ...quiet, concurrency: 1 });
    const gate = deferred();
    const release = deferred();
    const f1 = pool.fork(async () => {
      await gate.promise;
    });
    const w = pool.fork(async () => {});
    w.own({ [Symbol.asyncDispose]: () => release.promise });
    await tick();
    w.abort();
    expect(w.state).toBe('releasing'); // settled 'unstarted'; its release is still running
    expect([pool.running, pool.pending]).toEqual([1, 0]);
    gate.resolve();
    await app.join(f1);
    expect([pool.running, pool.pending]).toEqual([0, 0]);
    release.resolve();
    await tick();
    expect(w.state).toBe('complete');
    expect([pool.running, pool.pending]).toEqual([0, 0]);
    const g = deferred();
    let concurrent = 0;
    let peak = 0;
    const body = async (): Promise<void> => {
      peak = Math.max(peak, ++concurrent);
      await g.promise;
      concurrent--;
    };
    const a = pool.fork(body);
    const b = pool.fork(body);
    expect([pool.running, pool.pending]).toEqual([1, 1]);
    await tick();
    g.resolve();
    await app.join(a);
    await app.join(b);
    expect(peak).toBe(1); // the concurrency limit holds
    expect([pool.running, pool.pending]).toEqual([0, 0]);
    await app.close();
  });

  it('a passive pool.own(x) entry and a DI value placed on the pool leave running/pending untouched (D-47)', async () => {
    const V = createInjectionKey<object>('V');
    const app = createRootContext();
    const released: string[] = [];
    const pool = app.pool({
      ...quiet,
      concurrency: 1,
      providers: [factoryProvider(V, () => here().own({}, () => void released.push('value')))],
    });
    pool.get(V);
    pool.own(() => void released.push('passive'));
    const gate = deferred();
    pool.fork(() => gate.promise);
    pool.fork(async () => {});
    await tick();
    expect([pool.running, pool.pending]).toEqual([1, 1]);
    const p = impl(pool);
    // release the passive entry early: a release node under the pool is not a pooled fiber
    const passive = [...p.explicit].find((e) => e.node === undefined)!;
    await pool.release(passive.target);
    expect([pool.running, pool.pending]).toEqual([1, 1]);
    gate.resolve();
    await tick();
    expect([pool.running, pool.pending]).toEqual([0, 0]);
    await pool.close();
    expect(released).toEqual(['passive', 'value']);
    expect([pool.running, pool.pending]).toEqual([0, 0]);
    await app.close();
  });

  it('PoolClosedError after abort() or close(); NodeCompletedError after completion (D-16)', async () => {
    const app = createRootContext();
    const a = app.pool(quiet);
    const c = app.pool(quiet);
    const gate = deferred();
    c.fork(() => gate.promise);
    a.abort();
    const closing = c.close();
    expect(() => a.fork(async () => {})).toThrow(NodeCompletedError); // bodiless and idle: complete at once
    expect(() => c.fork(async () => {})).toThrow(PoolClosedError);
    gate.resolve();
    await closing;
    expect(() => c.fork(async () => {})).toThrow(NodeCompletedError);
    await app.close();
  });

  it("the owner's completion waits for the pool", async () => {
    const app = createRootContext();
    const pool = app.pool(quiet);
    const t = trace();
    pool.fork(
      task(
        async () => {
          await here().interrupted();
          await tick();
          t.push('pool fiber finished');
        },
        { interrupt: 'observe' },
      ),
    );
    await tick();
    await app.close();
    t.push('owner complete');
    expect(t.log).toEqual(['pool fiber finished', 'owner complete']);
  });

  it('the pool hears the signal at its turn, after the explicit entries above it (I4)', async () => {
    const app = createRootContext();
    const pool = app.pool(quiet);
    const fiber: Fiber<unknown> = pool.fork(async () => {
      await here().never();
    });
    const seen: boolean[] = [];
    app.own(() => void seen.push(fiber.signal.aborted)); // above the pool: released first
    await tick();
    app.abort();
    await app.close();
    expect(seen).toEqual([false]);
    expect(fiber.signal.aborted).toBe(true);
  });

  it('a fork with an already-aborted signal settles aborted and is never counted', async () => {
    const app = createRootContext();
    const pool: Pool = app.pool({ ...quiet, concurrency: 1 });
    const ac = new AbortController();
    ac.abort('pre');
    const f = pool.fork(task(async () => 1, { signal: ac.signal }));
    expect(f.outcome).toEqual({ status: 'aborted', reason: 'pre' });
    expect([pool.running, pool.pending]).toEqual([0, 0]);
    const g = pool.fork(async () => 2);
    expect(pool.running).toBe(1);
    await app.join(g);
    expect([pool.running, pool.pending]).toEqual([0, 0]);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// fiber-set.test.ts, ported (§6.2): `createFiberSet` → `pool()` in a
// constructor, on the value's pending node; `onError` → `onFailure`;
// `ctx.dispose()` → `close()`; `fiberSet.context` → the pool node. The old
// `setScope(Worker, RootScope)` is dropped so the pool really is created on a
// pending node: Worker has no dependencies and is auto-hoisted to the root.
//
// One semantic change shapes these ports: a DI value's node is an unsubscribed
// provided entry, so the root's close() *aborts* it at its turn (§5.6, D-11),
// and its pool with it — a fork that has not run by then never runs. The
// first case keeps the old "close waits for the drain" meaning with the
// idiom that says so: an own() entry registered after the pool, released
// before it (LIFO), that closes the pool gracefully. The others let their
// forks run (`tick()`) before closing.
// ---------------------------------------------------------------------------

describe('pools in a constructor (ported fiber-set cases)', () => {
  it("spawns fibers into the pool node; a graceful drain entry makes the owner's close wait for them", async () => {
    const results: number[] = [];

    class Worker {
      readonly pool = here().pool({ name: 'worker-pool', onFailure: () => {} }); // on the pending node
      constructor() {
        own(() => this.pool.close()); // after the pool on the value's stack: released before it, so it drains
      }

      run(n: number): Fiber<void> {
        return this.pool.fork(
          task(
            async () => {
              results.push(n);
            },
            { name: `task-${n}` },
          ),
        );
      }
    }

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    const fibers = [1, 2, 3].map((n) => worker.run(n));
    expect(fibers.every((f) => impl(f).parent === impl(worker.pool))).toBe(true);
    expect(impl(worker.pool).parent?.kind).toBe('value');

    // close waits for the drain (all fibers complete)
    await ctx.close();
    expect(results).toEqual([1, 2, 3]);
  });

  it('should call onFailure when a fiber rejects', async () => {
    const errors: unknown[] = [];

    class Worker {
      readonly pool = here().pool({ name: 'error-pool', onFailure: (err) => void errors.push(err) });

      fail() {
        this.pool.fork(
          task(
            async () => {
              throw new Error('boom');
            },
            { name: 'failing-task' },
          ),
        );
      }
    }

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    worker.fail();
    await tick(); // the fork runs before the value's node is aborted at its turn

    await ctx.close(); // the handler consumed the failure: nothing surfaces

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('should pass the fiber to onFailure', async () => {
    let capturedFiber: Fiber<unknown> | undefined;

    class Worker {
      readonly pool = here().pool({
        name: 'fiber-ref-pool',
        onFailure: (_err, fiber) => {
          capturedFiber = fiber;
        },
      });

      fail() {
        return this.pool.fork(
          task(
            async () => {
              throw new Error('fail');
            },
            { name: 'ref-task' },
          ),
        );
      }
    }

    const ctx = createRootContext();
    const fiber = ctx.get(Worker).fail();
    await tick();
    await ctx.close();

    expect(capturedFiber).toBe(fiber);
    expect(capturedFiber!.id).toBeTypeOf('number');
    expect(capturedFiber!.name).toBe('ref-task');
  });

  it('should abort all fibers when abort() is called', async () => {
    let abortSeen = false;

    class Worker {
      readonly pool = here().pool({ name: 'abort-pool', onFailure: () => {} });

      start() {
        return this.pool.fork(
          task(
            async () => {
              // Long-running work, aborted through signal() (was withAbortSignal)
              const signal = here().signal;
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, 10_000);
                signal.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(timer);
                    reject(new Error('aborted'));
                  },
                  { once: true },
                );
              });
            },
            { name: 'long-task' },
          ),
        );
      }

      stop() {
        this.pool.abort();
        abortSeen = true;
      }
    }

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    const fiber = worker.start();
    await tick(); // let it start and reach its wait
    worker.stop();

    expect(worker.pool.signal.aborted).toBe(true);

    // Should resolve quickly since we aborted
    await ctx.close();
    expect(abortSeen).toBe(true);
    expect(fiber.outcome?.status).toBe('aborted'); // whatever the body threw: the node was delivered (§7.6)
  });

  it('should expose the pool node', async () => {
    class Worker {
      readonly pool = here().pool({ name: 'ctx-pool', onFailure: () => {} });
    }

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    const poolNode = worker.pool;

    expect(poolNode).toBeDefined();
    expect(impl(poolNode).kind).toBe('pool');
    expect(poolNode.state).toBe('running');

    await ctx.close();
    expect(poolNode.state).toBe('complete');
  });

  it('should release the pool when the owner closes', async () => {
    const disposed: string[] = [];

    class Worker {
      readonly pool = here().pool({ name: 'lifecycle-pool', onFailure: () => {} });

      run() {
        this.pool.fork(
          task(
            async () => {
              disposed.push('fiber-done');
            },
            { name: 'lifecycle-task' },
          ),
        );
      }
    }

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    worker.run();

    expect(worker.pool.state).toBe('running');
    await tick();
    await ctx.close();
    expect(worker.pool.state).toBe('complete');
    expect(disposed).toContain('fiber-done');
  });

  it('should forward fork options (providers, scopes)', async () => {
    const TestKey = createInjectionKey<string>('test-key');
    const fiberScope = createScope('fiber');

    class Worker {
      readonly pool = here().pool({ name: 'opts-pool', onFailure: () => {} });

      run(): Fiber<{ value: string; scoped: boolean }> {
        return this.pool.fork(
          task(async () => ({ value: lookup(TestKey), scoped: here().scopes.has(fiberScope) }), {
            name: 'opts-task',
            providers: [valueProvider(TestKey, 'provided-value')],
            scopes: [fiberScope],
          }),
        );
      }
    }

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    const result = await ctx.join(worker.run());

    expect(result).toEqual({ value: 'provided-value', scoped: true });
    await ctx.close();
  });
});
