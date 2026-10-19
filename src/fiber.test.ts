// fiber.test.ts — IMPLEMENTATION.md §6.1 (rewritten) and the ports of the
// previous fiber suite (§6.2): tasks (§7.2, §7.10, I27), start semantics
// (§7.3, I20), failure destinations (§7.4, Q6), join/result, the `then` trap
// (D-29, D-49), all/race (§7.5, D-14, D-51), interruption from a body (§4),
// the top-level call (§4.3) and the managed-promise guarantees the free
// functions inherit (D-38).
//
// Everything here uses the free functions of ambient.ts (law 2); the method
// form appears only where a node that is not current is named on purpose
// (top level, a platform callback).
import { getEventListeners } from 'node:events';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import './node.js';
import {
  all,
  call,
  current,
  fork,
  interrupted,
  join,
  lookup,
  managed,
  never,
  own,
  race,
  result,
  signal,
} from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber, Outcome, Task } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { factoryProvider, valueProvider } from './provider-util.js';
import { FiberAbortedError, FiberNotAwaitableError, NoCurrentNodeError, OwnerInterrupt, UnawaitedCallError } from './resource.js';
import { createScope } from './scope.js';
import { deferred, impl, tick, trace, within } from './test/util.js';

const link = { onFailure: 'link' } as const;

/** The rejection of `p`; throws if `p` fulfils. Awaits `p` directly, so a managed `p` is awaited by its own body (D-64). */
async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

/** Resolves after `ms`, or as soon as `s` aborts (the timer is cleared then). */
function sleep(ms: number, s?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    s?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

describe('task() (§7.2, §7.10, I27)', () => {
  it('a task is an object, not a function: calling it is a TypeError at compile time and at runtime', () => {
    const t = task(async (n: number) => n);
    expect(typeof t).toBe('object');
    // @ts-expect-error a Task has no call signature
    expect(() => t(1)).toThrow(TypeError);
    const w = t.with({ name: 'w' });
    // @ts-expect-error neither has a task made by with()
    expect(() => w(1)).toThrow(TypeError);
    const b = t.bind(1);
    // @ts-expect-error nor one made by bind()
    expect(() => b()).toThrow(TypeError);
  });

  it('task(body) refuses something that is not a function', () => {
    expect(() => task(42 as unknown as () => number)).toThrow(TypeError);
  });

  it("the name defaults to opts.name, else the body's name, else 'anonymous'; the fiber carries it", async () => {
    async function handle(): Promise<string | undefined> {
      return current().name;
    }
    const named = async (): Promise<string | undefined> => current().name;
    expect(task(handle).name).toBe('handle');
    expect(task(named).name).toBe('named');
    expect(task(handle, { name: 'h' }).name).toBe('h');
    expect(task(async () => 1).name).toBe('anonymous');

    const root = createRootContext();
    expect(await root.call(task(handle))).toBe('handle');
    expect(await root.call(task(handle, { name: 'h' }))).toBe('h');
    expect(await root.call(task(handle).with({ name: 'w' }))).toBe('w');
    await root.close();
  });

  it("with() merges its options over the definition's and overrides the name; the definition is unchanged", async () => {
    const shape = (): { name: string | undefined; mode: string; childrenOnExit: string } => {
      const n = impl(current());
      return { name: n.name, mode: n.mode, childrenOnExit: n.childrenOnExit };
    };
    const base = task(shape, { name: 'base', interrupt: 'observe' });
    const over = base.with({ name: 'over', childrenOnExit: 'await' });
    const keep = base.with({ childrenOnExit: 'await' });
    expect(base.name).toBe('base');
    expect(over.name).toBe('over');
    expect(keep.name).toBe('base');

    const root = createRootContext();
    expect(await root.call(base)).toEqual({ name: 'base', mode: 'observe', childrenOnExit: 'interrupt' });
    expect(await root.call(over)).toEqual({ name: 'over', mode: 'observe', childrenOnExit: 'await' });
    expect(await root.call(keep)).toEqual({ name: 'base', mode: 'observe', childrenOnExit: 'await' });
    expect(await root.call(base)).toEqual({ name: 'base', mode: 'observe', childrenOnExit: 'interrupt' });
    await root.close();
  });

  it('bind() partially applies; the bound task keeps the name and options and takes no arguments', async () => {
    const add = task(async (a: number, b: number) => a + b, { name: 'add', interrupt: 'observe' });
    const bound = add.bind(1, 2);
    expectTypeOf(bound).toEqualTypeOf<Task<[], number>>();
    expect(bound.name).toBe('add');
    const root = createRootContext();
    expect(await root.call(bound)).toBe(3);
    expect(await root.call(add, 20, 22)).toBe(42);
    const modes = await root.call(async () => {
      const f = bound.with({ name: 'b2' }).fork();
      await join(f);
      return [f.name, impl(f).mode];
    });
    expect(modes).toEqual(['b2', 'observe']);
    await root.close();
  });

  it('t.fork() and t.call() are fork(t) and call(t): children of the current node; no current node → NoCurrentNodeError', async () => {
    const parents: unknown[] = [];
    const t = task(async (x: number) => {
      parents.push(impl(current()).parent); // the body's own node's parent
      return x;
    });
    expect(() => t.fork(1)).toThrow(NoCurrentNodeError);
    expect(() => t.call(1)).toThrow(NoCurrentNodeError);
    const root = createRootContext();
    await root.call(async () => {
      const me = current();
      const f = t.fork(7);
      expect(impl(f).parent).toBe(me);
      expect(await join(f)).toBe(7);
      expect(await t.call(8)).toBe(8);
      expect(parents).toHaveLength(2);
      expect(parents[0], 't.fork').toBe(me);
      expect(parents[1], 't.call').toBe(me);
    });
    await root.close();
  });
});

describe('start semantics (§7.3, I20)', () => {
  it("fork never runs any part of the body in the forker's frame; the body sees its own node current from its first line", async () => {
    const t = trace();
    const root = createRootContext();
    await root.call(async () => {
      const me = current();
      let first: Context | undefined;
      let firstSignal: AbortSignal | undefined;
      const f = fork(async () => {
        first = current();
        firstSignal = signal();
        t.push('body');
        await tick();
        return 1;
      });
      t.push('after fork');
      expect(first).toBeUndefined();
      expect(current()).toBe(me); // the forker's frame is untouched
      expect(impl(f).parent).toBe(me);
      expect(await join(f)).toBe(1);
      expect(first).toBe(f);
      expect(firstSignal).toBe(f.signal);
    });
    expect(t.log).toEqual(['after fork', 'body']);
    await root.close();
  });

  it('call starts the body synchronously with the child current, lends the caller, and resolves with the value', async () => {
    const t = trace();
    const root = createRootContext();
    await root.call(async () => {
      const me = current();
      let inner: Context | undefined;
      const p = call(async () => {
        inner = current();
        t.push('body start');
        await tick();
        return 42;
      });
      t.push('after call');
      expect(inner).toBeDefined();
      expect(inner).not.toBe(me);
      expect(impl(inner!).parent).toBe(me);
      expect(impl(me).lentTo).toBe(inner); // §7.11
      expect(await p).toBe(42);
      expect(impl(me).lentTo).toBeUndefined();
    });
    expect(t.log).toEqual(['body start', 'after call']);
    await root.close();
  });

  it('a body cannot tell whether it was forked or called', async () => {
    const shapes: Record<string, unknown>[] = [];
    const probe = task(
      async () => {
        const n = impl(current());
        shapes.push({
          kind: n.kind,
          name: n.name,
          parentKind: n.parent?.kind,
          subscribed: n.subscribed,
          stack: n.entryOnOwner?.stack.kind,
          state: n.state,
          mode: n.mode,
          aborted: signal().aborted,
          outcome: n.outcome,
        });
        await tick();
        return 'done';
      },
      { name: 'probe' },
    );
    const root = createRootContext();
    await root.call(async () => {
      expect(await join(probe.fork())).toBe('done');
      expect(await probe.call()).toBe('done');
    });
    expect(shapes).toHaveLength(2);
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[0]).toMatchObject({ kind: 'fiber', name: 'probe', parentKind: 'fiber', subscribed: true, stack: 'explicit' });
    await root.close();
  });
});

describe('failure destinations (§7.4)', () => {
  it("'join' (the default): the failure is held for join; unjoined, it surfaces from the parent's completion", async () => {
    const err = new Error('held');
    const root = createRootContext();
    await root.call(async () => {
      const f = fork(async () => {
        throw err;
      });
      await tick();
      expect(f.outcome).toEqual({ status: 'failure', error: err }); // held, nothing thrown yet
      expect(await rejection(join(f))).toBe(err);
    });
    // Not joined: the call fiber's own completion surfaces it, once.
    const surfaced = await rejection(
      root.call(async () => {
        fork(async () => {
          throw err;
        });
        await tick();
      }),
    );
    expect(surfaced).toBe(err);
    await root.close(); // nothing left over
  });

  it("'link' aborts the parent as soon as the fiber fails, and surfaces from the parent's completion", async () => {
    const err = new Error('linked');
    const root = createRootContext();
    let parentSignal: AbortSignal | undefined;
    const t = trace();
    const e = await rejection(
      root.call(async () => {
        parentSignal = signal();
        own(() => t.push('parent released'));
        fork(
          task(async () => {
            throw err;
          }, link),
        );
        await never();
        t.push('resumed');
      }),
    );
    expect(e).toBe(err);
    expect(parentSignal?.aborted).toBe(true);
    expect(parentSignal?.reason).toBe(err);
    expect(t.log).toEqual(['parent released']);
    await root.close();
  });

  it('a handler is called once with the error and the fiber; the parent is unaffected', async () => {
    const err = new Error('handled');
    const handler = vi.fn();
    const root = createRootContext();
    const f = root.fork(
      task(async () => {
        throw err;
      }, { onFailure: handler }),
    );
    await root.close();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(err);
    expect(handler.mock.calls[0][1]).toBe(f);
    expect(root.outcome).toEqual({ status: 'success', value: undefined });
    expect(root.signal.aborted).toBe(false);
  });

  describe('an async handler (D-113)', () => {
    it('holds the parent open until it settles: after an await it still has the parent current, resolves from it and attaches to it (D-45)', async () => {
      const t = trace();
      const K = createInjectionKey<string>('K');
      const root = createRootContext({ providers: [valueProvider(K, 'k')] });
      root.fork(
        task(
          async () => {
            throw new Error('body');
          },
          {
            onFailure: async () => {
              await tick();
              t.push(`after await: ${lookup(K)}, parent current: ${String(current() === root)}`);
              own(() => t.push('handler entry released')); // NodeCompletedError if the parent had completed
            },
          },
        ),
      );
      await root.close();
      expect(t.log).toEqual(['after await: k, parent current: true', 'handler entry released']);
      expect(root.outcome).toEqual({ status: 'success', value: undefined });
      // The setup hook fails this test if anything was an unhandled rejection (I10).
    });

    it("a task handler that rejects after an await: the rejection is a handler exception on the parent, never an unhandled rejection", async () => {
      const handlerError = new Error('async handler');
      const root = createRootContext();
      root.fork(
        task(
          async () => {
            throw new Error('body');
          },
          {
            onFailure: async () => {
              await tick();
              throw handlerError;
            },
          },
        ),
      );
      await expect(root.close()).rejects.toBe(handlerError);
    });

    it('a pool handler that rejects: the pool waits for it, and the rejection surfaces from the pool and its parent', async () => {
      const handlerError = new Error('async pool handler');
      const gate = deferred();
      const root = createRootContext();
      const p = root.pool({
        name: 'p',
        onFailure: async (e) => {
          await gate.promise;
          throw new AggregateError([e], 'rethrown', { cause: handlerError });
        },
      });
      const f = p.fork(async () => {
        throw new Error('body');
      });
      await tick();
      expect(f.state).toBe('complete'); // the handler is running
      const closing = root.close();
      await tick(2);
      expect(p.state).toBe('releasing'); // aborted by root's close, held open by its handler
      gate.resolve();
      const err = await rejection(closing);
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as Error).cause).toBe(handlerError);
      expect(p.outcome).toEqual({ status: 'failure', error: err });
    });

    it("its managed awaits never freeze the parent: interrupted() there resumes with the parent's abort reason, and the parent completes", async () => {
      const t = trace();
      const root = createRootContext();
      const Y = root.fork(
        task(async () => {
          fork(
            task(
              async () => {
                throw new Error('child');
              },
              { onFailure: async () => void t.push(`handler saw ${String(await interrupted())}`) },
            ),
          );
          await never();
        }, link),
      );
      await tick();
      expect(Y.state).toBe('running'); // waiting for its handler's interrupt
      Y.abort('stop');
      await root.close();
      expect(t.log).toEqual(['handler saw stop']);
      expect(Y.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    });

    it("a managed promise its parent's body made is the handler's own await: the parent's delivery does not cut it, the handler resumes and the parent completes (D-116)", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const t = trace();
        const connect = deferred<string>();
        const root = createRootContext();
        const Y = root.fork(
          task(async () => {
            const conn = managed(connect.promise); // targeted at Y: made in Y's body
            const stop = interrupted(); // cut-only: Y awaits its own interrupt below
            fork(
              task(
                async () => {
                  throw new Error('fatal');
                },
                {
                  onFailure: async (e) => {
                    t.push(`stop: ${String(await stop)}`);
                    t.push(`reported ${(e as Error).message} on ${await conn}`);
                  },
                },
              ),
            );
            await stop;
          }, link),
        );
        await tick(); // the handler waits on `stop`
        Y.abort('stop'); // cuts Y's own await of `stop`, not the handler's
        await tick();
        expect(Y.state).toBe('releasing'); // frozen, held by the handler, which now waits on `conn`
        connect.resolve('conn');
        await within(root.close());
        expect(t.log).toEqual(['stop: stop', 'reported fatal on conn']);
        expect(Y.outcome).toEqual({ status: 'aborted', reason: 'stop' });
        expect(warn).not.toHaveBeenCalled(); // no foreign-awaiter report: the handler's await is supported
      } finally {
        warn.mockRestore();
      }
    });

    it("a fiber the handler attaches after its parent's body exited is released next: awaiting it does not hold the parent forever, and the handler's own entries wait for it (D-118, §6.2)", async () => {
      const t = trace();
      const go = deferred();
      const root = createRootContext();
      let Y: Context | undefined;
      const done = root.call(async () => {
        Y = current();
        fork(
          task(
            async () => {
              throw new Error('fatal');
            },
            {
              onFailure: async () => {
                await go.promise;
                own(() => t.push('handler entry released'));
                try {
                  await call(async () => {
                    await never(); // only an interrupt ends it
                  });
                  t.push('call returned');
                } catch (e) {
                  const byOwner = e instanceof FiberAbortedError && e.reason instanceof OwnerInterrupt && e.reason.owner === Y;
                  t.push(byOwner ? 'call interrupted by its owner' : `call: ${String(e)}`);
                }
                t.push('handler done');
              },
            },
          ),
        );
        await tick();
        return 'Y ok';
      });
      await tick(3);
      expect(Y?.state).toBe('releasing'); // the body returned; the loop waits for the handler
      go.resolve(); // the handler's call is attached to Y only now
      expect(await within(done)).toBe('Y ok');
      expect(t.log).toEqual(['call interrupted by its owner', 'handler done', 'handler entry released']);
      await root.close();
    });

    describe("a handler that awaits its parent's completion or an ancestor's holds nothing, so the tree completes (D-117)", () => {
      const fail = async (): Promise<never> => {
        throw new Error('fatal');
      };
      type Handler = (error: unknown, fiber: Fiber<unknown>) => void; // a task's and a pool's onFailure
      const closers: [string, (app: Context) => Handler][] = [
        ['() => app.close()', (app) => () => app.close()],
        ['async () => { await app.close() }', (app) => async () => void (await app.close())],
        ['async () => { await tick(3); await app.close() } (the parent already waits)', (app) => async () => {
          await tick(3);
          await app.close();
        }],
      ];
      for (const [name, onFailure] of closers) {
        it(`a fiber's onFailure: ${name}`, async () => {
          const error = vi.spyOn(console, 'error').mockImplementation(() => {});
          try {
            const app = createRootContext();
            const Y = app.fork(
              task(async () => {
                fork(task(fail, { onFailure: onFailure(app) }));
                await tick();
                return 'Y';
              }, link),
            );
            await within(impl(app).completion); // the handler alone shuts the app down
            expect(app.outcome).toEqual({ status: 'success', value: undefined });
            expect(Y.outcome).toEqual({ status: 'success', value: 'Y' });
            expect(error).not.toHaveBeenCalled();
          } finally {
            error.mockRestore();
          }
        });

        it(`a pool's onFailure: ${name}`, async () => {
          const error = vi.spyOn(console, 'error').mockImplementation(() => {});
          try {
            const app = createRootContext();
            const p = app.pool({ name: 'p', onFailure: onFailure(app) });
            p.fork(fail);
            await within(impl(app).completion);
            expect(app.outcome).toEqual({ status: 'success', value: undefined });
            expect(p.state).toBe('complete');
            expect(error).not.toHaveBeenCalled();
          } finally {
            error.mockRestore();
          }
        });
      }

      const waits: [string, (root: Context, Y: () => Fiber<string>) => Handler][] = [
        ['root.join(Y)', (root, Y) => async () => void (await root.join(Y()))],
        ['root.result(Y)', (root, Y) => async () => void (await root.result(Y()))],
        ['Y[Symbol.asyncDispose]()', (_root, Y) => async () => void (await Y()[Symbol.asyncDispose]().catch(() => {}))],
        ['root.release(Y)', (root, Y) => async () => void (await root.release(Y()))],
        ['root.releaseAll()', (root) => async () => void (await root.releaseAll())],
      ];
      for (const [name, onFailure] of waits)
        it(`a handler of Y's child that awaits ${name}`, async () => {
          const root = createRootContext();
          const Y: Fiber<string> = root.fork(
            task(async () => {
              fork(task(fail, { onFailure: onFailure(root, () => Y) }));
              await tick();
              return 'Y';
            }, link),
          );
          await within(impl(Y).completion);
          expect(Y.outcome?.status).not.toBe('failure');
          await within(root.close());
        });
    });

    it('a handler that returns a fiber is not awaited and never trips the fiber then trap (D-29)', async () => {
      const root = createRootContext();
      let reported: Fiber<string> | undefined;
      root.fork(
        task(
          async () => {
            throw new Error('body');
          },
          { onFailure: () => (reported = fork(task(async () => 'reported', { onFailure: () => {} }))) },
        ),
      );
      await expect(root.close()).resolves.toBeUndefined();
      expect(reported?.outcome).toEqual({ status: 'success', value: 'reported' });
    });
  });

  it("Q6: fork onto a bodiless node with the default 'join' destination throws TypeError at once and attaches nothing; a destination makes it legal (D-15)", async () => {
    const root = createRootContext();
    const body = async (): Promise<number> => 1;
    expect(() => root.fork(body)).toThrow(TypeError);
    expect(() => root.fork(task(body))).toThrow(/nothing would join it/);
    const c = root.child();
    expect(() => c.fork(task(body))).toThrow(TypeError);
    expect(() => c.run(() => fork(body))).toThrow(TypeError); // the free form on a bodiless current node
    expect(impl(root).explicit.size).toBe(1); // only the child
    expect(impl(c).explicit.size).toBe(0);

    const handled = vi.fn();
    const f1 = root.fork(task(body, link));
    const f2 = c.fork(task(body).with({ onFailure: handled }));
    const f3 = c.run(() => fork(task(body, link)));
    await root.close();
    expect(f1.outcome).toEqual({ status: 'success', value: 1 });
    expect(f2.outcome).toEqual({ status: 'success', value: 1 });
    expect(f3.outcome).toEqual({ status: 'success', value: 1 });
    expect(handled).not.toHaveBeenCalled();
  });

  it('call always joins: it consumes the failure even when the task declares a handler', async () => {
    const err = new Error('called');
    const handler = vi.fn();
    const root = createRootContext();
    await root.call(async () => {
      expect(
        await rejection(
          call(
            task(async () => {
              throw err;
            }, { onFailure: handler }),
          ),
        ),
      ).toBe(err);
    });
    await root.close();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('join and result (§4.6, §7.4)', () => {
  it("join resolves with the value and throws the fiber's failure", async () => {
    const err = new Error('boom');
    const root = createRootContext();
    await root.call(async () => {
      expect(await join(fork(async () => 'v'))).toBe('v');
      expect(await rejection(join(fork(async () => Promise.reject(err))))).toBe(err);
    });
    await root.close();
  });

  it('join of an aborted fiber throws FiberAbortedError to an awaiter that is not frozen: an observe body draining after its interrupt', async () => {
    let seen: unknown;
    const root = createRootContext();
    const shutdown = root.fork(
      task(
        async () => {
          const worker = fork(async () => {
            await never();
          });
          const why = await interrupted(); // observe: the body sees the interrupt and keeps running
          worker.abort(`after ${String(why)}`);
          seen = await rejection(join(worker));
          return 'drained';
        },
        { interrupt: 'observe', onFailure: 'link' },
      ),
    );
    await tick();
    root.abort('stop');
    await root.close();
    expect(seen).toBeInstanceOf(FiberAbortedError);
    expect((seen as FiberAbortedError).reason).toBe('after stop');
    expect(shutdown.outcome).toEqual({ status: 'success', value: 'drained' });
  });

  it('result never rejects: success, failure and aborted are values, and a failure it delivers is consumed', async () => {
    const err = new Error('r');
    const root = createRootContext();
    await root.call(async () => {
      const ok = fork(async () => 'v');
      const bad = fork(async () => {
        throw err;
      });
      const gone = fork(async () => {
        await never();
      });
      await tick();
      gone.abort('reason');
      const outcomes: Outcome<unknown>[] = [await result(ok), await result(bad), await result(gone)];
      expect(outcomes).toEqual([
        { status: 'success', value: 'v' },
        { status: 'failure', error: err },
        { status: 'aborted', reason: 'reason' },
      ]);
    });
    await root.close(); // the failure was consumed by result: nothing surfaces
  });

  it('a fiber is not awaitable: await, Promise.resolve and Promise.all reject with FiberNotAwaitableError (D-29)', async () => {
    const root = createRootContext();
    await root.call(async () => {
      const f = fork(async () => 1);
      const asPromise = f as unknown as Promise<number>;
      expect(await rejection((async () => await asPromise)())).toBeInstanceOf(FiberNotAwaitableError);
      expect(await rejection(Promise.resolve(asPromise))).toBeInstanceOf(FiberNotAwaitableError);
      expect(await rejection(Promise.all([asPromise]))).toBeInstanceOf(FiberNotAwaitableError);
      expect(() => (f as unknown as { then: unknown }).then).toThrow(/use join\(f\) or result\(f\)/);
      expect(await join(f)).toBe(1); // the fiber itself is unaffected
    });
    await root.close();
  });

  it('a sync body and an async body that return a fiber both fail with FiberNotAwaitableError; nothing escapes the start microtask (D-49)', async () => {
    const inner = task(async () => 1);
    const root = createRootContext();
    await root.call(async () => {
      const syncF = fork(() => fork(inner));
      const asyncF = fork(async () => fork(inner));
      const callErr = await rejection(call(() => fork(inner)));
      const [o1, o2] = [await result(syncF), await result(asyncF)];
      expect(o1.status).toBe('failure');
      expect((o1 as { error: unknown }).error).toBeInstanceOf(FiberNotAwaitableError);
      expect(o2.status).toBe('failure');
      expect((o2 as { error: unknown }).error).toBeInstanceOf(FiberNotAwaitableError);
      expect(callErr).toBeInstanceOf(FiberNotAwaitableError);
    });
    await root.close();
    // The setup hook fails this test if anything was an unhandled rejection (I10).
  });
});

describe('all and race (§7.5)', () => {
  it('all resolves with the tuple in task order, typed as a tuple (D-58)', async () => {
    const root = createRootContext();
    const values = await root.call(async () => {
      const p = all([
        task(async () => {
          await tick(2);
          return 1;
        }).bind(),
        task(async (s: string) => s).bind('two'),
        task(() => true).bind(),
      ]);
      expectTypeOf(p).toEqualTypeOf<Promise<[number, string, boolean]>>();
      return await p;
    });
    expect(values).toEqual([1, 'two', true]);
    expect(await root.call(() => all([]))).toEqual([]);
    await root.close();
  });

  it('the method all infers the tuple too, on a named node and through current() (D-58)', async () => {
    const root = createRootContext();
    const a = task(async (n: number) => n);
    const b = task((s: string) => s);
    const viaRoot = root.all([a.bind(1), b.bind('x')]);
    expectTypeOf(viaRoot).toEqualTypeOf<Promise<[number, string]>>();
    expect(await viaRoot).toEqual([1, 'x']);
    const viaCurrent = await root.call(async () => {
      const p = current().all([b.bind('y'), a.bind(2)]);
      expectTypeOf(p).toEqualTypeOf<Promise<[string, number]>>();
      return await p;
    });
    expect(viaCurrent).toEqual(['y', 2]);
    const ctx: Context = root;
    expectTypeOf(ctx.all([a.bind(3)])).toEqualTypeOf<Promise<[number]>>();
    await root.close();
  });

  it('all reports every real failure in one AggregateError and leaves aborted members out of it', async () => {
    const e1 = new Error('one');
    const e2 = new Error('two');
    const root = createRootContext();
    const err = await rejection(
      root.call(() =>
        all([
          task(async () => {
            throw e1;
          }).bind(),
          task(async () => 'ok').bind(),
          task(async () => {
            current().abort('self');
            await never();
          }).bind(),
          task(async () => {
            await tick();
            throw e2;
          }).bind(),
        ]),
      ),
    );
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toEqual([e1, e2]);
    await root.close();
  });

  it('all rejects with FiberAbortedError when a member was aborted and none failed (D-14)', async () => {
    const root = createRootContext();
    const err = await rejection(
      root.call(() =>
        all([
          task(async () => 1).bind(),
          task(async () => {
            current().abort('gone');
            await never();
          }).bind(),
        ]),
      ),
    );
    expect(err).toBeInstanceOf(FiberAbortedError);
    expect((err as FiberAbortedError).reason).toBe('gone');
    await root.close();
  });

  it('race resolves with the first success after aborting and awaiting the rest', async () => {
    const t = trace();
    const root = createRootContext();
    const v = await root.call(() =>
      race([
        task(async () => {
          own(() => t.push('slow released'));
          await never();
          return 'slow';
        }).bind(),
        task(async () => {
          await tick();
          return 'fast';
        }).bind(),
      ]),
    );
    expect(v).toBe('fast');
    expect(t.log).toEqual(['slow released']); // the loser was released before race resolved
    await root.close();
  });

  it('race: every member failed → AggregateError; every member aborted → FiberAbortedError; race([]) → TypeError', async () => {
    const e1 = new Error('a');
    const e2 = new Error('b');
    const root = createRootContext();
    await root.call(async () => {
      const failed = await rejection(
        race([
          task(async () => {
            throw e1;
          }).bind(),
          task(async () => {
            await tick();
            throw e2;
          }).bind(),
        ]),
      );
      expect(failed).toBeInstanceOf(AggregateError);
      expect((failed as AggregateError).errors).toEqual([e1, e2]);
      const aborted = await rejection(
        race([
          task(async () => {
            current().abort('x');
            await never();
          }).bind(),
        ]),
      );
      expect(aborted).toBeInstanceOf(FiberAbortedError);
      expect(() => race([])).toThrow(TypeError);
    });
    await root.close();
  });

  it("members declared with 'link' or a handler run as 'join' members: the AggregateError arrives and no handler runs (D-51)", async () => {
    const e1 = new Error('linked');
    const e2 = new Error('handled');
    const handler = vi.fn();
    const root = createRootContext();
    await root.call(async () => {
      const members = [
        task(async () => {
          throw e1;
        }, link).bind(),
        task(async () => {
          await tick();
          throw e2;
        }, { onFailure: handler }).bind(),
      ];
      const fromAll = await rejection(all(members));
      expect(fromAll).toBeInstanceOf(AggregateError);
      expect((fromAll as AggregateError).errors).toEqual([e1, e2]);
      const fromRace = await rejection(race(members));
      expect(fromRace).toBeInstanceOf(AggregateError);
      expect((fromRace as AggregateError).errors).toEqual([e1, e2]);
      // A linked member's failure does not abort the race: a later success still wins.
      expect(
        await race([
          members[0],
          task(async () => {
            await tick();
            return 'ok';
          }).bind(),
        ]),
      ).toBe('ok');
    });
    await root.close();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('interruption seen from a body (§4)', () => {
  it('interrupted() resolves with the reason in an observe body, which then settles on its own', async () => {
    const root = createRootContext();
    const f = root.fork(task(async () => `saw ${String(await interrupted())}`, { interrupt: 'observe', ...link }));
    await tick();
    f.abort('why');
    await root.close();
    expect(f.outcome).toEqual({ status: 'success', value: 'saw why' });
  });

  it("never() freezes a freeze body: cut at delivery, its node released in the same tick, and it never resumes nor runs its finally", async () => {
    const t = trace();
    const root = createRootContext();
    const f = root.fork(
      task(async () => {
        own(() => t.push('released'));
        t.push('before');
        try {
          await never();
          t.push('resumed');
        } finally {
          t.push('finally');
        }
      }, link),
    );
    await tick();
    expect(t.log).toEqual(['before']);
    f.abort('x');
    expect(t.log).toEqual(['before', 'released']);
    expect(f.state).toBe('complete');
    expect(f.outcome).toEqual({ status: 'aborted', reason: 'x' });
    await tick(2);
    expect(t.log).toEqual(['before', 'released']);
    await root.close();
  });

  it('managed(p) passes a value or a rejection through, freezes a delivered body, and plain code between delivery and the next managed await still runs (§4.2)', async () => {
    const t = trace();
    const err = new Error('p failed');
    const root = createRootContext();
    await root.call(async () => {
      expect(await managed(Promise.resolve(3))).toBe(3);
      expect(await rejection(managed(Promise.reject(err)))).toBe(err);
    });

    const late = deferred<string>();
    const cut = root.fork(
      task(async () => {
        t.push(`cut got ${await managed(late.promise)}`);
      }, link),
    );
    const bare = deferred();
    const after = root.fork(
      task(async () => {
        await bare.promise; // bare: completes normally after delivery
        t.push('plain code after delivery');
        own(() => t.push('owned after delivery released'));
        await managed(Promise.resolve());
        t.push('resumed');
      }, link),
    );
    await tick();
    cut.abort();
    after.abort();
    expect(cut.state).toBe('complete');
    expect(cut.outcome?.status).toBe('aborted');
    late.resolve('late');
    bare.resolve();
    await tick(2);
    expect(t.log).toEqual(['plain code after delivery', 'owned after delivery released']);
    expect(after.outcome?.status).toBe('aborted');
    await root.close();
  });

  it('timeoutMs delivers a TimeoutError to the fiber; a timed-out call rejects with FiberAbortedError at top level', async () => {
    const root = createRootContext();
    const f = root.fork(
      task(async () => {
        await never();
      }, { timeoutMs: 5, ...link }),
    );
    const o = await root.result(f);
    expect(o.status).toBe('aborted');
    expect(((o as { reason: unknown }).reason as DOMException).name).toBe('TimeoutError');
    expect((f.signal.reason as DOMException).name).toBe('TimeoutError');

    const bounded = await rejection(
      root.call(
        task(
          async () => {
            await never();
          },
          { timeoutMs: 5 },
        ),
      ),
    );
    expect(bounded).toBeInstanceOf(FiberAbortedError);
    expect(((bounded as FiberAbortedError).reason as DOMException).name).toBe('TimeoutError');
    await root.close();
  });

  it('a pre-aborted { signal } settles the fiber aborted at once, without running its body (D-13)', async () => {
    const ac = new AbortController();
    ac.abort('pre');
    let ran = false;
    const root = createRootContext();
    const f = root.fork(
      task(() => {
        ran = true;
      }, { signal: ac.signal, ...link }),
    );
    expect(f.state).toBe('complete');
    expect(f.outcome).toEqual({ status: 'aborted', reason: 'pre' });
    const called = await rejection(root.call(task(() => (ran = true), { signal: ac.signal })));
    expect(called).toBeInstanceOf(FiberAbortedError);
    await tick();
    expect(ran).toBe(false);
    await root.close();
  });

  it('top level: `await app.call(main)` rejects with FiberAbortedError when a platform callback aborts the app, and the `await using` block completes (§4.3)', async () => {
    const t = trace();
    let caught: unknown;
    let appRef: Context | undefined;
    {
      await using app = createRootContext();
      appRef = app;
      app.own(() => t.push('app released'));
      const main = task(async () => {
        own(() => t.push('main released'));
        await never();
      });
      setTimeout(() => app.abort('SIGTERM'), 5); // a platform callback: no current node
      try {
        await app.call(main);
      } catch (e) {
        caught = e;
      }
      t.push('after call');
    }
    t.push('after using');
    expect(caught).toBeInstanceOf(FiberAbortedError);
    expect((caught as FiberAbortedError).reason).toBe('SIGTERM');
    expect(t.log[0]).toBe('main released');
    expect(t.log.indexOf('after call')).toBeGreaterThan(0);
    expect(t.log.indexOf('app released')).toBeGreaterThan(0);
    expect(t.log.at(-1)).toBe('after using');
    expect(appRef?.state).toBe('complete');
    expect(appRef?.outcome?.status).toBe('aborted');
  });

  it("Promise.all([call(a), call(b)]) throws UnawaitedCallError on the second call; a's failure, never delivered, surfaces from the parent and is never an unhandled rejection (D-38)", async () => {
    const aErr = new Error('a failed, never delivered');
    const root = createRootContext();
    let caught: unknown;
    const surfaced = await rejection(
      root.call(async () => {
        try {
          await Promise.all([
            call(async () => {
              await tick();
              throw aErr;
            }),
            call(async () => 'b'),
          ]);
        } catch (e) {
          caught = e;
        }
        await tick(3); // bare: `a` fails meanwhile, while its wrapper is never awaited
      }),
    );
    expect(caught).toBeInstanceOf(UnawaitedCallError);
    expect(surfaced).toBe(aErr); // I11: surfaced from the call fiber's completion
    await root.close();
    // The setup hook fails this test if anything was an unhandled rejection (I10).
  });
});

// ---------------------------------------------------------------------------
// Ports of the previous fiber suite (IMPLEMENTATION.md §6.2): Fiber.call (11),
// Fiber.spawn (12 of 13; `.promise` dropped), withAbortSignal (4 of 6, as
// signal()), Fiber integration (2), linkAbortSignal (3, as task(fn, {
// signal })), Fiber.fork (4), Fiber.join (2), Fiber.result (2), Fiber.all (3).
// `Fiber.call(fn, { context })` → `ctx.call(task(fn, opts))`;
// `Fiber.spawn(fn, { context })` → `ctx.fork(task(fn, { onFailure: 'link' }))`
// or a fork inside a call; `Fiber.join/result/all` → `join/result/all`.
// ---------------------------------------------------------------------------

describe('ported: call', () => {
  it('runs an async function in a child node', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test', { factory: () => 'hello' });
    expect(await ctx.call(async () => lookup(KEY))).toBe('hello');
    await ctx.close();
  });

  it('provides values via the providers option', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test');
    expect(await ctx.call(task(async () => lookup(KEY), { providers: [valueProvider(KEY, 'provided')] }))).toBe('provided');
    await ctx.close();
  });

  it('attaches scopes to the child node', async () => {
    const ctx = createRootContext();
    const TestScope = createScope('test');
    const KEY = createInjectionKey<string>('scoped', { factory: () => 'scoped-value', scope: TestScope });
    expect(await ctx.call(task(async () => lookup(KEY), { scopes: [TestScope] }))).toBe('scoped-value');
    await ctx.close();
  });

  it('releases the child node after completion', async () => {
    const ctx = createRootContext();
    let disposed = false;
    const KEY = createInjectionKey<string>('test');
    await ctx.call(
      task(
        async () => {
          lookup(KEY);
        },
        {
          providers: [
            factoryProvider(KEY, () => {
              own(() => {
                disposed = true;
              });
              return 'value';
            }),
          ],
        },
      ),
    );
    expect(disposed).toBe(true);
    await ctx.close();
  });

  it('releases the child node on error', async () => {
    const ctx = createRootContext();
    let disposed = false;
    const KEY = createInjectionKey<string>('test');
    const err = await rejection(
      ctx.call(
        task(
          async () => {
            lookup(KEY);
            throw new Error('boom');
          },
          {
            providers: [
              factoryProvider(KEY, () => {
                own(() => {
                  disposed = true;
                });
                return 'value';
              }),
            ],
          },
        ),
      ),
    );
    expect((err as Error).message).toBe('boom');
    expect(disposed).toBe(true);
    await ctx.close();
  });

  it('propagates errors from the body', async () => {
    const ctx = createRootContext();
    const err = await rejection(
      ctx.call(async () => {
        throw new Error('test error');
      }),
    );
    expect((err as Error).message).toBe('test error');
    await ctx.close();
  });

  it('supports nested calls', async () => {
    const ctx = createRootContext();
    const KEY_A = createInjectionKey<string>('A');
    const KEY_B = createInjectionKey<string>('B');
    const r = await ctx.call(
      task(
        async () => {
          const a = lookup(KEY_A);
          const b = await call(task(async () => lookup(KEY_B), { providers: [valueProvider(KEY_B, 'inner')] }));
          return `${a}-${b}`;
        },
        { providers: [valueProvider(KEY_A, 'outer')] },
      ),
    );
    expect(r).toBe('outer-inner');
    await ctx.close();
  });

  it('detects an unawaited nested call: the next call throws UnawaitedCallError naming the first (§7.11)', async () => {
    const ctx = createRootContext();
    await ctx.call(async () => {
      let first: Context | undefined;
      const p1 = call(async () => {
        first = current();
        await tick(3);
        return 'first';
      });
      await tick();
      let e: unknown;
      try {
        await call(async () => 'second');
      } catch (x) {
        e = x;
      }
      expect(e).toBeInstanceOf(UnawaitedCallError);
      expect((e as UnawaitedCallError).child).toBe(first);
      expect(await p1).toBe('first');
    });
    await ctx.close();
  });

  it('throws NoCurrentNodeError when no node is current', () => {
    expect(() => call(async () => 'hello')).toThrow(NoCurrentNodeError);
    expect(() => call(async () => 'hello')).toThrow(/no current node/);
  });

  it('a nested call uses the current node', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test');
    const r = await ctx.call(async () => {
      const outer = current();
      return await call(
        task(
          async () => {
            expect(impl(current()).parent).toBe(outer);
            return lookup(KEY);
          },
          { providers: [valueProvider(KEY, 'nested')] },
        ),
      );
    });
    expect(r).toBe('nested');
    await ctx.close();
  });

  it('returns the value from the body', async () => {
    const ctx = createRootContext();
    expect(await ctx.call(async () => 42)).toBe(42);
    await ctx.close();
  });
});

describe('ported: spawn (fork with a destination, or inside a call)', () => {
  it('returns a fiber that can be joined', async () => {
    const ctx = createRootContext();
    expect(await ctx.call(async () => await join(fork(async () => 'spawned')))).toBe('spawned');
    await ctx.close();
  });

  it('has a name', async () => {
    const ctx = createRootContext();
    const fiber = ctx.fork(task(async () => 'hi', { name: 'my-fiber', ...link }));
    expect(fiber.name).toBe('my-fiber');
    expect(await ctx.result(fiber)).toEqual({ status: 'success', value: 'hi' });
    await ctx.close();
  });

  it("releases the fiber's node on completion", async () => {
    const ctx = createRootContext();
    let disposed = false;
    const KEY = createInjectionKey<string>('test');
    await ctx.call(async () => {
      const fiber = fork(
        task(
          async () => {
            lookup(KEY);
          },
          {
            providers: [
              factoryProvider(KEY, () => {
                own(() => {
                  disposed = true;
                });
                return 'value';
              }),
            ],
          },
        ),
      );
      await join(fiber);
      expect(disposed).toBe(true); // join resolves at completion, after the release
    });
    await ctx.close();
  });

  it("releases the fiber's node on error", async () => {
    const ctx = createRootContext();
    let disposed = false;
    const KEY = createInjectionKey<string>('test');
    await ctx.call(async () => {
      const fiber = fork(
        task(
          async () => {
            lookup(KEY);
            throw new Error('spawn error');
          },
          {
            providers: [
              factoryProvider(KEY, () => {
                own(() => {
                  disposed = true;
                });
                return 'value';
              }),
            ],
          },
        ),
      );
      expect(((await rejection(join(fiber))) as Error).message).toBe('spawn error');
      expect(disposed).toBe(true);
    });
    await ctx.close();
  });

  it('runs concurrently', async () => {
    const ctx = createRootContext();
    const order: string[] = [];
    await ctx.call(async () => {
      const f1 = fork(async () => {
        order.push('f1-start');
        await sleep(30);
        order.push('f1-end');
      });
      const f2 = fork(async () => {
        order.push('f2-start');
        await sleep(10);
        order.push('f2-end');
      });
      await join(f1);
      await join(f2);
    });
    expect(order).toEqual(['f1-start', 'f2-start', 'f2-end', 'f1-end']);
    await ctx.close();
  });

  it('abort() on the fiber fires its signal() and freezes it at its managed await', async () => {
    const ctx = createRootContext();
    const t = trace();
    let signalAborted = false;
    const fiber = ctx.fork(
      task(async () => {
        const s = signal();
        s.addEventListener('abort', () => {
          signalAborted = true;
        });
        await managed(sleep(1000, s)); // the sleep resolves on abort: only the freeze keeps the body from resuming
        t.push('resumed');
      }, link),
    );
    await tick();
    fiber.abort();
    expect((await ctx.result(fiber)).status).toBe('aborted');
    expect(signalAborted).toBe(true);
    await tick(3);
    expect(t.log).toEqual([]);
    await ctx.close();
  });

  it("close() on the parent waits for the fiber (the parent's wait is the drain)", async () => {
    const ctx = createRootContext();
    let completed = false;
    ctx.fork(
      task(async () => {
        await sleep(50);
        completed = true;
      }, link),
    );
    await ctx.close();
    expect(completed).toBe(true);
  });

  it("abort() on the parent reaches the fiber's signal", async () => {
    const ctx = createRootContext();
    let signalAborted = false;
    ctx.fork(
      task(async () => {
        const s = signal();
        s.addEventListener('abort', () => {
          signalAborted = true;
        });
        await managed(sleep(1000, s));
      }, link),
    );
    await tick();
    ctx.abort();
    await ctx.close();
    expect(signalAborted).toBe(true);
  });

  it("provides providers to the fiber's node", async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test');
    const r = await ctx.call(async () => await join(fork(task(async () => lookup(KEY), { providers: [valueProvider(KEY, 'spawn-provided')] }))));
    expect(r).toBe('spawn-provided');
    await ctx.close();
  });

  it("supports scopes on the fiber's node", async () => {
    const ctx = createRootContext();
    const TestScope = createScope('test');
    const KEY = createInjectionKey<string>('scoped', { factory: () => 'scoped-val', scope: TestScope });
    const r = await ctx.call(async () => await join(fork(task(async () => lookup(KEY), { scopes: [TestScope] }))));
    expect(r).toBe('scoped-val');
    await ctx.close();
  });

  it('throws NoCurrentNodeError when no node is current', () => {
    expect(() => fork(async () => 'hello')).toThrow(NoCurrentNodeError);
  });

  it('supports call inside a forked body', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('inner');
    const r = await ctx.call(async () => {
      const fiber = fork(async () => await call(task(async () => lookup(KEY), { providers: [valueProvider(KEY, 'from-call')] })));
      return await join(fiber);
    });
    expect(r).toBe('from-call');
    await ctx.close();
  });
});

describe('ported: withAbortSignal → signal()', () => {
  it("signal() is the current node's AbortSignal", async () => {
    const ctx = createRootContext();
    await ctx.call(async () => {
      const s = signal();
      expect(s).toBeInstanceOf(AbortSignal);
      expect(s.aborted).toBe(false);
      expect(s).toBe(current().signal);
    });
    await ctx.close();
  });

  it('signal() fires when the node is aborted', async () => {
    const ctx = createRootContext();
    let signalAborted = false;
    const fiber = ctx.fork(
      task(async () => {
        signal().addEventListener('abort', () => {
          signalAborted = true;
        });
        await managed(sleep(1000, signal()));
      }, link),
    );
    await tick();
    fiber.abort();
    await ctx.result(fiber);
    expect(signalAborted).toBe(true);
    await ctx.close();
  });

  it('signal() throws NoCurrentNodeError when no node is current', () => {
    expect(() => signal()).toThrow(NoCurrentNodeError);
  });

  it('works with a fetch-like abort pattern', async () => {
    const ctx = createRootContext();
    const fetchLike = async (s: AbortSignal): Promise<string> => {
      if (s.aborted) throw new Error('aborted');
      return 'data';
    };
    expect(await ctx.call(async () => await fetchLike(signal()))).toBe('data');
    await ctx.close();
  });
});

describe('ported: integration', () => {
  it('supports mixed call and fork patterns', async () => {
    const ctx = createRootContext();
    const results: string[] = [];
    await ctx.call(async () => {
      results.push('call-start');
      const f = fork(async () => {
        await sleep(20);
        results.push('fork-done');
        return 'fork-result';
      });
      results.push('after-fork');
      results.push(`got-${await join(f)}`);
    });
    expect(results).toEqual(['call-start', 'after-fork', 'fork-done', 'got-fork-result']);
    await ctx.close();
  });

  it('cleans up everything when the parent closes', async () => {
    const ctx = createRootContext();
    const disposed: string[] = [];
    const KEY_A = createInjectionKey<string>('A', {
      factory: () => {
        own(() => {
          disposed.push('A');
        });
        return 'a';
      },
    });
    ctx.fork(
      task(async () => {
        lookup(KEY_A);
        await sleep(30);
      }, link),
    );
    await ctx.close();
    expect(disposed).toEqual(['A']);
  });
});

describe('ported: linkAbortSignal → task(fn, { signal })', () => {
  it('aborts the fiber when the signal fires', async () => {
    const ctx = createRootContext();
    const controller = new AbortController();
    let signalAborted = false;
    const fiber = ctx.fork(
      task(
        async () => {
          signal().addEventListener('abort', () => {
            signalAborted = true;
          });
          await managed(sleep(5000, signal()));
        },
        { signal: controller.signal, ...link },
      ),
    );
    await tick();
    controller.abort('linked');
    const o = await ctx.result(fiber);
    expect(o).toEqual({ status: 'aborted', reason: 'linked' });
    expect(signalAborted).toBe(true);
    await ctx.close();
  });

  it('an already-aborted signal settles the fiber aborted before its body runs (D-13)', async () => {
    const ctx = createRootContext();
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const fiber = ctx.fork(
      task(
        async () => {
          ran = true;
        },
        { signal: controller.signal, ...link },
      ),
    );
    expect(fiber.outcome?.status).toBe('aborted');
    await ctx.close();
    expect(ran).toBe(false);
  });

  it('removes the listener when the fiber settles normally', async () => {
    const ctx = createRootContext();
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const fiber = ctx.fork(task(async () => 'done', { signal: controller.signal, ...link }));
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    expect(await ctx.result(fiber)).toEqual({ status: 'success', value: 'done' });
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0][0]).toBe('abort');
    expect(removed.mock.calls[0][1]).toBe(added.mock.calls[0][1]); // the very listener that was added
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0); // nothing keeps the node reachable from the signal
    controller.abort(); // harmless now
    expect(fiber.signal.aborted).toBe(false);
    await ctx.close();
  });
});

describe('ported: fork', () => {
  it('forks from the current node', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test', { factory: () => 'forked' });
    expect(await ctx.call(async () => await join(fork(async () => lookup(KEY))))).toBe('forked');
    await ctx.close();
  });

  it('accepts providers and scopes', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test');
    const TestScope = createScope('test');
    const SCOPED = createInjectionKey<string>('scoped', { factory: () => 'scoped-val', scope: TestScope });
    const r = await ctx.call(async () => {
      const fiber = fork(
        task(async () => `${lookup(KEY)}-${lookup(SCOPED)}`, { providers: [valueProvider(KEY, 'provided')], scopes: [TestScope] }),
      );
      return await join(fiber);
    });
    expect(r).toBe('provided-scoped-val');
    await ctx.close();
  });

  it('throws NoCurrentNodeError when no node is current', () => {
    expect(() => fork(async () => 'hello')).toThrow(NoCurrentNodeError);
  });

  it("the parent's body exit: under childrenOnExit 'await' the fork finishes naturally; by default it is interrupted, and the call still waits for it", async () => {
    const ctx = createRootContext();
    let completed = false;
    await ctx.call(
      task(
        async () => {
          fork(async () => {
            await sleep(30);
            completed = true;
          });
        },
        { childrenOnExit: 'await' },
      ),
    );
    expect(completed).toBe(true);

    const t = trace();
    let forked: Fiber<void> | undefined;
    await ctx.call(async () => {
      forked = fork(async () => {
        own(() => t.push('fork released'));
        await managed(sleep(1000, signal()));
        t.push('resumed');
      });
      await tick(); // let it start
    });
    expect(t.log).toEqual(['fork released']); // released before the call resolved
    expect(forked?.state).toBe('complete');
    expect(forked?.outcome?.status).toBe('aborted');
    await ctx.close();
  });
});

describe('ported: join, result, all', () => {
  it('join resolves with the fiber value', async () => {
    const ctx = createRootContext();
    expect(await ctx.call(async () => await join(fork(async () => 42)))).toBe(42);
    await ctx.close();
  });

  it("join throws the fiber's error", async () => {
    const ctx = createRootContext();
    const err = await rejection(
      ctx.call(async () => {
        const f = fork(async () => {
          throw new Error('join-boom');
        });
        await join(f);
      }),
    );
    expect((err as Error).message).toBe('join-boom');
    await ctx.close();
  });

  it('result returns a success outcome', async () => {
    const ctx = createRootContext();
    expect(await ctx.call(async () => await result(fork(async () => 'ok')))).toEqual({ status: 'success', value: 'ok' });
    await ctx.close();
  });

  it('result returns a failure outcome without throwing', async () => {
    const ctx = createRootContext();
    const o = await ctx.call(
      async () =>
        await result(
          fork(async () => {
            throw new Error('result-boom');
          }),
        ),
    );
    expect(o.status).toBe('failure');
    expect((o as { error: Error }).error).toBeInstanceOf(Error);
    expect((o as { error: Error }).error.message).toBe('result-boom');
    await ctx.close();
  });

  it('all runs the tasks and returns a tuple', async () => {
    const ctx = createRootContext();
    const [a, b, c] = await ctx.call(
      async () => await all([task(async () => 1).bind(), task(async () => 'two').bind(), task(async () => true).bind()]),
    );
    expect(a).toBe(1);
    expect(b).toBe('two');
    expect(c).toBe(true);
    await ctx.close();
  });

  it('all rejects with an AggregateError when any task fails', async () => {
    const ctx = createRootContext();
    const err = await rejection(
      ctx.call(
        async () =>
          await all([
            task(async () => 'ok').bind(),
            task(async () => {
              throw new Error('all-boom');
            }).bind(),
          ]),
      ),
    );
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual(['all-boom']);
    await ctx.close();
  });

  it('all works with an empty array', async () => {
    const ctx = createRootContext();
    expect(await ctx.call(async () => await all([]))).toEqual([]);
    await ctx.close();
  });
});
