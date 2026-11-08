// Tests for tasks / failure handlers.
import { describe, expect, it, vi } from 'vitest';
import { current, fork, interrupted, join, lookup, never, own, signal, wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import type { Context, Fiber } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { valueProvider } from '../../src/provider-util.js';
import { FiberAbortedError, OwnerInterrupt } from '../../src/resource.js';
import { deferred, impl, start, tick, trace, within } from '../support/util.js';

const link = { onFailure: 'link' } as const;

/** The rejection of `p`; throws if `p` fulfils. Awaits `p` directly, so a managed `p` is awaited by its own body, a direct await (DESIGN.md §4.2). */
async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('failure destinations (DESIGN.md §4.7)', () => {
  it("'join' (the default): the failure is held for join; unjoined, it surfaces from the parent's completion", async () => {
    const err = new Error('held');
    const root = createRootContext();
    await root.call(function* () {
      const f = fork(function* () {
        throw err;
      });
      yield* wait(tick());
      expect(f.outcome).toEqual({ status: 'defect', error: err }); // held, nothing thrown yet
      expect(yield* wait(rejection(join(f)))).toBe(err);
    });
    // Not joined: the call fiber's own completion surfaces it, once.
    const surfaced = await rejection(
      root.call(function* () {
        fork(function* () {
          throw err;
        });
        yield* wait(tick());
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
      root.call(function* () {
        parentSignal = signal();
        own(() => t.push('parent released'));
        fork(
          task(function* () {
            throw err;
          }, link),
        );
        yield* never();
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
      task(function* () {
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

  describe('an async handler (DESIGN.md §4.7)', () => {
    it('holds the parent open until it settles: after an await it still has the parent current, resolves from it and attaches to it (DESIGN.md §4.7)', async () => {
      const t = trace();
      const K = createInjectionKey<string>('K');
      const root = createRootContext({ providers: [valueProvider(K, 'k')] });
      root.fork(
        task(
          function* () {
            throw new Error('body');
          },
          {
            onFailure: function* () {
              yield* wait(tick());
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
          function* () {
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
      const f = p.fork(function* () {
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
      expect(p.outcome).toEqual({ status: 'defect', error: err }); // a handler exception amends the pool's outcome: a defect
    });

    it("a generator handler is never halted by the parent's delivery: interrupted() there resumes with the parent's abort reason, and the parent completes", async () => {
      const t = trace();
      const root = createRootContext();
      const Y = root.fork(
        task(function* () {
          fork(
            task(
              function* () {
                throw new Error('child');
              },
              { onFailure: function* () { return void t.push(`handler saw ${String(yield* interrupted())}`); } },
            ),
          );
          yield* never();
        }, link),
      );
      await tick();
      expect(Y.state).toBe('running'); // waiting for its handler's interrupt
      Y.abort('stop');
      await root.close();
      expect(t.log).toEqual(['handler saw stop']);
      expect(Y.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    });

    it("ops its parent's body made run afresh for the handler, which nothing halts: the parent's delivery does not touch them, the handler resumes and the parent completes (DESIGN.md §4.7)", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const t = trace();
        const connect = deferred<string>();
        const root = createRootContext();
        const Y = root.fork(
          task(function* () {
            const conn = wait(connect.promise, { abandon: true }); // made in Y's body, through Y
            const stop = interrupted(); // Y waits on its own interrupt below and is halted by it
            fork(
              task(
                function* () {
                  throw new Error('fatal');
                },
                {
                  onFailure: function* (e) {
                    t.push(`stop: ${String(yield* stop)}`);
                    t.push(`reported ${(e as Error).message} on ${yield* conn}`);
                  },
                },
              ),
            );
            yield* stop;
          }, link),
        );
        await tick(); // the handler waits on `stop`
        Y.abort('stop'); // rejects Y's own await of `stop`, not the handler's
        await tick();
        expect(Y.state).toBe('releasing'); // Y's body unwound; Y is held by the handler, which now waits on `conn`
        connect.resolve('conn');
        await within(root.close());
        expect(t.log).toEqual(['stop: stop', 'reported fatal on conn']);
        expect(Y.outcome).toEqual({ status: 'aborted', reason: 'stop' });
        expect(warn).not.toHaveBeenCalled(); // no foreign-awaiter report: the handler's await is supported
      } finally {
        warn.mockRestore();
      }
    });

    it("a fiber the handler attaches after its parent's body exited is released next: awaiting it does not hold the parent forever, and the handler's own entries wait for it (DESIGN.md §2.4)", async () => {
      const t = trace();
      const go = deferred();
      const root = createRootContext();
      let Y: Context | undefined;
      const done = start(root.call(function* () {
        Y = current();
        fork(
          task(
            function* () {
              throw new Error('fatal');
            },
            {
              onFailure: function* () {
                yield* wait(go.promise);
                own(() => t.push('handler entry released'));
                try {
                  yield* task(function* () {
                    yield* never(); // only an interrupt ends it
                  })();
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
        yield* wait(tick());
        return 'Y ok';
      }));
      await tick(3);
      expect(Y?.state).toBe('releasing'); // the body returned; the loop waits for the handler
      go.resolve(); // the handler's call is attached to Y only now
      expect(await within(done)).toBe('Y ok');
      expect(t.log).toEqual(['call interrupted by its owner', 'handler done', 'handler entry released']);
      await root.close();
    });

    describe("a handler that waits for its parent's completion or an ancestor's holds nothing, so the tree completes: one returning the op (decision 28), or a generator handler (DESIGN.md §4.7)", () => {
      const fail = function* () {
        throw new Error('fatal');
      };
      type Handler = (error: unknown, fiber: Fiber<unknown, unknown>) => void; // a task's and a pool's onFailure
      const closers: [string, (app: Context) => Handler][] = [
        ['() => app.close()', (app) => () => app.close()],
        ['function* () { yield* app.close() }', (app) => function* () {
          yield* app.close();
        }],
        ['function* () { yield* wait(tick(3)); yield* app.close() } (the parent already waits)', (app) => function* () {
          yield* wait(tick(3));
          yield* app.close();
        }],
      ];
      for (const [name, onFailure] of closers) {
        it(`a fiber's onFailure: ${name}`, async () => {
          const error = vi.spyOn(console, 'error').mockImplementation(() => {});
          try {
            const app = createRootContext();
            const Y = app.fork(
              task(function* () {
                fork(task(fail, { onFailure: onFailure(app) }));
                yield* wait(tick());
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
        ['root.join(Y)', (root, Y) => function* () {
          yield* root.join(Y());
        }],
        ['root.result(Y)', (root, Y) => function* () {
          yield* root.result(Y());
        }],
        ['Y[Symbol.asyncDispose]()', (_root, Y) => function* () {
          try {
            yield* Y()[Symbol.asyncDispose]();
          } catch {
            // Y's own outcome, if it failed
          }
        }],
        ['root.release(Y)', (root, Y) => function* () {
          yield* root.release(Y());
        }],
        ['root.releaseAll()', (root) => function* () {
          yield* root.releaseAll();
        }],
      ];
      for (const [name, onFailure] of waits)
        it(`a generator handler of Y's child that yields ${name}`, async () => {
          const root = createRootContext();
          const Y: Fiber<string> = root.fork(
            task(function* () {
              fork(task(fail, { onFailure: onFailure(root, () => Y) }));
              yield* wait(tick());
              return 'Y';
            }, link),
          );
          await within(impl(Y).completion);
          expect(['failure', 'defect']).not.toContain(Y.outcome?.status);
          await within(root.close());
        });
    });

    it('a handler that returns a fiber is not awaited and never trips the fiber then trap (DESIGN.md §4.5)', async () => {
      const root = createRootContext();
      let reported: Fiber<string> | undefined;
      root.fork(
        task(
          function* () {
            throw new Error('body');
          },
          { onFailure: () => (reported = fork(task(function* () { return 'reported'; }, { onFailure: () => {} }))) },
        ),
      );
      await expect(root.close()).resolves.toBeUndefined();
      expect(reported?.outcome).toEqual({ status: 'success', value: 'reported' });
    });
  });

  it("fork onto a bodiless node with the default 'join' destination throws TypeError at once and attaches nothing; a destination makes it legal (D14)", async () => {
    const root = createRootContext();
    const body = function* () { return 1; };
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
    await root.call(function* () {
      expect(
        yield* wait(rejection(
          task(function* () {
            throw err;
          }, { onFailure: handler })(),
        )),
      ).toBe(err);
    });
    await root.close();
    expect(handler).not.toHaveBeenCalled();
  });
});
