// lending.test.ts — lending (DESIGN.md §4.9, D11, I26), skipSelf inside a call()ed body (DESIGN.md §3.2) and a failure handler while its parent is lent (DESIGN.md §4.7).
import { describe, expect, it } from 'vitest';
import './node.js';
import {
  all,
  call,
  child,
  current,
  fork,
  interrupted,
  join,
  lookup,
  managed,
  never,
  pool,
  race,
  result,
  runSync,
} from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import type { NodeImpl } from './node-impl.js';
import { valueProvider } from './provider-util.js';
import { FiberAbortedError, UnawaitedCallError } from './resource.js';
import { deferred, events, here, impl, tick } from './test/util.js';

const linked = { onFailure: 'link' } as const;

function spawn<T>(on: Context, body: () => Promise<T> | T, opts: Parameters<typeof task>[1] = {}): Fiber<T> {
  return on.fork(task(body, { ...linked, ...opts }));
}

describe('lending (DESIGN.md §4.9)', () => {
  it('Promise.all([call(a), call(b)]) throws UnawaitedCallError on the second call, naming the first call and all(); nothing rejects unhandled (D13)', async () => {
    const app = createRootContext();
    let caught: unknown;
    let firstChild: NodeImpl | undefined;
    await app.call(async () => {
      const self = here();
      try {
        await Promise.all([
          self.call(
            task(
              async () => {
                firstChild = here();
                await tick();
                return 'a';
              },
              { name: 'a' },
            ),
          ),
          self.call(task(async () => 'b', { name: 'b' })),
        ]);
      } catch (e) {
        caught = e;
      }
      // The first call is still running, and its wrapper was never awaited: the body must wait for it
      // through its owner's completion, not through an orphaned promise.
    });
    expect(caught).toBeInstanceOf(UnawaitedCallError);
    expect((caught as UnawaitedCallError).child).toBe(firstChild);
    expect((caught as Error).message).toMatch(/lent to a#/);
    expect((caught as Error).message).toMatch(/use all\(\)/);
    await app.close();
  });

  it('every body-shaped method throws while the node is lent; own, release, close, abort and asyncDispose do not', async () => {
    const K = createInjectionKey<number>('K');
    const app = createRootContext({ providers: [valueProvider(K, 1)] });
    const lent = async (): Promise<{ node: NodeImpl; release: () => void; done: Promise<unknown> }> => {
      const gate = deferred();
      const hold = deferred();
      let node!: NodeImpl;
      const done = app.call(async () => {
        node = here();
        const p = here().call(async () => {
          await gate.promise;
        }); // not awaited yet: the node is lent
        await hold.promise; // bare
        await p;
      });
      await tick();
      return {
        node,
        done,
        release: () => {
          gate.resolve();
          hold.resolve();
        },
      };
    };

    const { node: B, release, done } = await lent();
    expect(B.lentTo).toBeDefined();
    const f = spawn(app, async () => 1);
    const t = task(async () => 1);
    const ops: [string, () => unknown][] = [
      ['get', () => B.get(K)],
      ['call', () => B.call(async () => 1)],
      ['fork', () => B.fork(async () => 1)],
      ['child', () => B.child()],
      ['pool', () => B.pool({ name: 'p', onFailure: () => {} })],
      ['all', () => B.all([t])],
      ['race', () => B.race([t])],
      ['join', () => B.join(f)],
      ['result', () => B.result(f)],
      ['interrupted', () => B.interrupted()],
      ['never', () => B.never()],
      ['managed', () => B.managed(Promise.resolve(1))],
      ['run', () => B.run(() => 1)],
      ['runSync', () => B.runSync(() => 1)],
    ];
    for (const [op, call] of ops) {
      expect(call, op).toThrow(UnawaitedCallError);
      try {
        call();
      } catch (e) {
        expect((e as UnawaitedCallError).child, op).toBe(B.lentTo);
        expect((e as Error).message, op).toContain(`${op}()`);
      }
    }
    // Another party may perform these on a node whose body is inside a call (a producer attaching on behalf, cancellation).
    const x = B.own({}, () => {});
    await B.release(x);
    const closing = B.close();
    release();
    await done;
    await closing;

    const b2 = await lent();
    expect(() => b2.node.abort()).not.toThrow();
    b2.release();
    await expect(b2.done).rejects.toBeInstanceOf(FiberAbortedError);

    const b3 = await lent();
    const disposing = b3.node[Symbol.asyncDispose]();
    b3.release();
    await expect(disposing).rejects.toBeInstanceOf(FiberAbortedError);
    await expect(b3.done).rejects.toBeInstanceOf(FiberAbortedError);
    await app.close();
  });

  it('lentTo is cleared before the awaiting body resumes: after success, failure and abort of the child', async () => {
    const app = createRootContext();
    const seen: unknown[] = [];
    await app.call(async () => {
      const self = here();
      await self.call(async () => 1);
      seen.push(self.lentTo);
      try {
        await self.call(async () => {
          throw new Error('child failed');
        });
      } catch {
        seen.push(self.lentTo);
      }
      let child!: NodeImpl;
      const p = self.call(async () => {
        child = here();
        await here().never();
      });
      setTimeout(() => child.abort(), 1);
      try {
        await p;
      } catch (e) {
        seen.push(self.lentTo, e instanceof FiberAbortedError);
      }
    });
    expect(seen).toEqual([undefined, undefined, undefined, true]);
    await app.close();
  });

  it('a nested call lends only the node that made it', async () => {
    const app = createRootContext();
    const seen: boolean[] = [];
    await app.call(async () => {
      const B = here();
      await B.call(async () => {
        const C = here();
        await C.call(async () => {
          const D = here();
          seen.push(B.lentTo === C, C.lentTo === D, D.lentTo === undefined);
        });
      });
    });
    expect(seen).toEqual([true, true, true]);
    await app.close();
  });

  it('otherCtx.call(fn) from a body lends the body (the awaiting node), not otherCtx (D11)', async () => {
    const app = createRootContext();
    const other = app.child();
    const seen: boolean[] = [];
    await app.call(async () => {
      const B = here();
      await other.call(async () => {
        const X = here();
        seen.push(X.parent === impl(other), B.lentTo === X, impl(other).lentTo === undefined);
      });
    });
    expect(seen).toEqual([true, true, true]);
    await app.close();
  });

  it('a top-level await app.call(main) lends nothing, so app.fork(...) from a platform callback works during it (DESIGN.md §4.9)', async () => {
    const app = createRootContext();
    const gate = deferred();
    const main = app.call(async () => {
      await gate.promise;
      return 'main';
    });
    expect(impl(app).lentTo).toBeUndefined();
    let forked!: Fiber<string>;
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        forked = spawn(app, async () => 'handler'); // a platform callback: no current node
        resolve(); // never resolve a promise with a fiber: that is `await fiber` (I27)
      }, 1),
    );
    expect(await app.join(forked)).toBe('handler');
    gate.resolve();
    expect(await main).toBe('main');
    await app.close();
  });

  it('a call from a release fiber lends the release fiber', async () => {
    const app = createRootContext();
    const seen: boolean[] = [];
    const N = app.child();
    N.own(async () => {
      const rf = here();
      await rf.call(async () => {
        seen.push(rf.kind === 'release', rf.lentTo === here());
      });
      seen.push(rf.lentTo === undefined);
    });
    await N.close();
    expect(seen).toEqual([true, true, true]);
    await app.close();
  });

  it('get(K, { skipSelf }) inside a call()ed body resolves from the lent parent without UnawaitedCallError (DESIGN.md §3.2)', async () => {
    const K = createInjectionKey<number>('K');
    const app = createRootContext({ providers: [valueProvider(K, 0)] });
    const v = await app.call(
      task(
        async () => {
          const B = here();
          return B.call(
            task(
              async () => {
                expect(B.lentTo).toBe(here());
                return [here().get(K), here().get(K, { skipSelf: true })];
              },
              { providers: [valueProvider(K, 2)] },
            ),
          );
        },
        { providers: [valueProvider(K, 1)] },
      ),
    );
    expect(v).toEqual([2, 1]);
    await app.close();
  });

  it('a lender that completes before its otherCtx.call(...) child leaves child.lender undefined (A2)', async () => {
    const app = createRootContext();
    const gate = deferred();
    let work!: NodeImpl;
    let Y!: NodeImpl;
    const y = spawn(app, async () => {
      Y = here();
      await app.call(
        task(
          async () => {
            work = here();
            await gate.promise;
          },
          { interrupt: 'observe' },
        ),
      );
    });
    await tick();
    expect(work.lender).toBe(Y);
    y.abort();
    expect(Y.state).toBe('complete');
    expect(work.state).toBe('running');
    expect(work.lender).toBeUndefined();
    expect(Y.lentTo).toBeUndefined();
    gate.resolve();
    await app.close();
  });

  it('a current node that is already lent cannot make a second call through another receiver; all() and race() name themselves (DESIGN.md §4.9)', async () => {
    const app = createRootContext();
    const other = app.child();
    const caught: Record<string, unknown> = {};
    let lentTo: NodeImpl | undefined;
    await app.call(async () => {
      const p = other.call(async () => {
        await tick();
      }); // lends the body
      lentTo = here().lentTo;
      const t = task(async () => 1);
      const ops: [string, () => unknown][] = [
        ['call', () => other.call(async () => {})],
        ['all', () => other.all([t])],
        ['race', () => other.race([t])],
      ];
      for (const [op, run] of ops)
        try {
          run();
        } catch (e) {
          caught[op] = e;
        }
      await p;
    });
    for (const op of ['call', 'all', 'race']) {
      expect(caught[op], op).toBeInstanceOf(UnawaitedCallError);
      expect((caught[op] as UnawaitedCallError).child, op).toBe(lentTo);
      expect((caught[op] as Error).message, op).toMatch(new RegExp(`^${op}\\(\\) on `)); // the method the user called
    }
    expect((caught.call as Error).message).toMatch(/use all\(\)/);
    for (const op of ['all', 'race']) expect((caught[op] as Error).message, op).not.toMatch(/use all\(\)|call\(\)/);
    await app.close();
  });

  it('a lent current node cannot make a managed await through another receiver either: join, result, interrupted, never, managed (DESIGN.md §4.9, I26)', async () => {
    const app = createRootContext();
    const other = app.child({ name: 'other' });
    const f = spawn(app, async () => 1);
    const caught: Record<string, unknown> = {};
    let lentTo: NodeImpl | undefined;
    let exempt = false;
    await app.call(async () => {
      const self = here();
      const p = self.call(async () => {
        await tick();
      }); // lends the body; not awaited yet
      lentTo = self.lentTo;
      const ops: [string, () => unknown][] = [
        ['join', () => other.join(f)],
        ['result', () => other.result(f)],
        ['interrupted', () => other.interrupted()],
        ['never', () => other.never()],
        ['managed', () => other.managed(Promise.resolve(1))],
      ];
      for (const [op, run] of ops)
        try {
          run();
        } catch (e) {
          caught[op] = e;
        }
      // Not the current node's managed awaits: another party may do these on `other` (DESIGN.md §4.9).
      const x = other.own({}, () => {});
      void other.release(x);
      other.child().abort();
      exempt = true;
      await p;
    });
    expect(lentTo).toBeDefined();
    expect(exempt).toBe(true);
    for (const op of ['join', 'result', 'interrupted', 'never', 'managed']) {
      expect(caught[op], op).toBeInstanceOf(UnawaitedCallError);
      expect((caught[op] as UnawaitedCallError).child, op).toBe(lentTo);
      expect((caught[op] as Error).message, op).toContain(`${op}()`);
    }
    expect(await app.join(f)).toBe(1);
    await app.close();
  });

  it('a call whose child settled at birth (an already-aborted signal) lends nothing: the caller is not left lent (DESIGN.md §4.6)', async () => {
    const app = createRootContext();
    let lentAfter: NodeImpl | undefined | null = null;
    let forked = false;
    await app.call(async () => {
      const self = here();
      const p = self.call(task(async () => 1, { signal: AbortSignal.abort('pre') }));
      lentAfter = self.lentTo; // the child completed in its constructor: nothing would clear lentTo
      await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
      self.fork(async () => void (forked = true)); // UnawaitedCallError if it were still lent
    });
    expect(lentAfter).toBeUndefined();
    expect(forked).toBe(true);
    await app.close();
  });

  it('fork lends nothing; call emits node:lent and node:returned', async () => {
    const ev = events();
    let B!: NodeImpl;
    await ev.root.call(async () => {
      B = here();
      const f = here().fork(async () => 1);
      expect(B.lentTo).toBeUndefined();
      await here().join(f);
      await here().call(async () => 2);
    });
    const lent = ev.of('node:lent').filter((e) => e.id === B.id);
    const returned = ev.of('node:returned').filter((e) => e.id === B.id);
    expect(lent).toHaveLength(1);
    expect(returned.map((e) => e.childId)).toEqual(lent.map((e) => e.childId));
    await ev.root.close();
  });
});

describe('a failure handler while its parent is lent (DESIGN.md §4.7)', () => {
  it('a handler that runs while the parent body awaits a call can lookup, get, fork, child, pool and runSync on the parent; the parent is unaffected (DESIGN.md §4.7)', async () => {
    const K = createInjectionKey<string>('K');
    const app = createRootContext({ providers: [valueProvider(K, 'k')] });
    const seen: unknown[] = [];
    let Y!: NodeImpl;
    let lentInHandler: NodeImpl | undefined;
    let side: Fiber<string> | undefined;
    const done = app.call(async () => {
      Y = here();
      fork(
        task(
          async () => {
            throw new Error('child failed');
          },
          {
            onFailure: () => {
              lentInHandler = Y.lentTo; // the body is inside the call below
              seen.push(lookup(K));
              seen.push(current().get(K)); // the method form on the handler's own parent
              side = fork(async () => 'side');
              seen.push(impl(child()).parent === Y);
              seen.push(impl(pool({ name: 'handler-pool', onFailure: () => {} })).parent === Y);
              seen.push(runSync(() => lookup(K)));
              seen.push(Y.lentTo === lentInHandler); // nothing above touched the lending
            },
          },
        ),
      );
      await call(async () => {
        await tick(3);
      });
      return 'Y ok';
    });
    await expect(done).resolves.toBe('Y ok'); // not UnawaitedCallError: no await was forgotten (I26)
    expect(lentInHandler).toBeDefined();
    expect(seen).toEqual(['k', 'k', true, true, 'k', true]);
    expect(impl(side!).parent).toBe(Y);
    expect(side!.outcome).toEqual({ status: 'success', value: 'side' });
    await expect(app.close()).resolves.toBeUndefined();
  });

  it('call, all, race, run and the managed awaits stay refused there, naming the handler, and the lending is not overwritten', async () => {
    const app = createRootContext();
    const refused: string[] = [];
    let Y!: NodeImpl;
    let lentAfter: NodeImpl | undefined | null = null;
    const done = app.call(async () => {
      Y = here();
      fork(
        task(
          async () => {
            throw new Error('child failed');
          },
          {
            onFailure: (_e, failed) => {
              const lent = Y.lentTo;
              const ops: [string, () => unknown][] = [
                ['call', () => call(async () => 1)],
                ['all', () => all([])],
                ['race', () => race([task(async () => 1)])],
                ['join', () => join(failed)],
                ['result', () => result(failed)],
                ['interrupted', () => interrupted()],
                ['never', () => never()],
                ['managed', () => managed(Promise.resolve(1))],
                ['run', () => current().run(() => 1)],
              ];
              for (const [op, f] of ops) {
                try {
                  f();
                  refused.push(`${op}: not refused`);
                } catch (e) {
                  const ok = e instanceof UnawaitedCallError && e.child === lent && /failure handler/.test(e.message);
                  refused.push(ok ? op : `${op}: ${String(e)}`);
                }
              }
              lentAfter = Y.lentTo === lent ? lent : null;
            },
          },
        ),
      );
      await call(async () => {
        await tick(3);
      });
      return 'Y ok';
    });
    await expect(done).resolves.toBe('Y ok');
    expect(refused).toEqual(['call', 'all', 'race', 'join', 'result', 'interrupted', 'never', 'managed', 'run']);
    expect(lentAfter).toBeDefined();
    expect(lentAfter).not.toBeNull();
    await expect(app.close()).resolves.toBeUndefined();
  });

  it('through a receiver other than its parent, a handler may await and call while the parent is lent: join, result, managed, call and all (DESIGN.md §4.7)', async () => {
    const app = createRootContext();
    const other = app.child({ name: 'other' });
    const gate = deferred();
    const seen: unknown[] = [];
    let Y!: NodeImpl;
    const done = app.call(async () => {
      Y = here();
      fork(
        task(
          async () => {
            throw new Error('child failed');
          },
          {
            onFailure: async () => {
              const lent = Y.lentTo; // the body is inside the call below
              try {
                const g = other.fork(task(async () => 'g', linked));
                seen.push(await other.join(g));
                seen.push((await other.result(g)).status);
                seen.push(await other.managed(Promise.resolve('m')));
                seen.push(await other.call(async () => 'c'));
                seen.push(await other.all([task(async () => 'a')]));
                seen.push(lent !== undefined && Y.lentTo === lent); // lent all along, never overwritten
                try {
                  void join(g); // through the parent it stays refused (DESIGN.md §4.7)
                  seen.push('join through the parent: not refused');
                } catch (e) {
                  seen.push(e instanceof UnawaitedCallError && /failure handler/.test((e as Error).message));
                }
              } finally {
                gate.resolve();
              }
            },
          },
        ),
      );
      await call(async () => {
        await gate.promise;
      });
      return 'Y ok';
    });
    await expect(done).resolves.toBe('Y ok'); // no UnawaitedCallError on the parent: nothing was forgotten (I26)
    expect(seen).toEqual(['g', 'success', 'm', 'c', ['a'], true, true]);
    await expect(app.close()).resolves.toBeUndefined();
  });

  it("a call made from a handler lends nothing: the parent's body keeps resolving while an async handler awaits it", async () => {
    const K = createInjectionKey<string>('K');
    const app = createRootContext({ providers: [valueProvider(K, 'k')] });
    const gate = deferred();
    const handlerDone = deferred();
    const log: string[] = [];
    const done = app.call(async () => {
      const Y = here();
      fork(
        task(
          async () => {
            throw new Error('child failed');
          },
          {
            onFailure: async () => {
              log.push(
                await call(async () => {
                  await gate.promise;
                  return 'handler call done';
                }),
              );
              handlerDone.resolve();
            },
          },
        ),
      );
      await tick(); // the handler is inside its call now
      log.push(`Y lent: ${String(Y.lentTo !== undefined)}`);
      try {
        log.push(lookup(K)); // UnawaitedCallError if the handler's call had lent Y
      } catch (e) {
        log.push(String(e));
      }
      gate.resolve();
      await handlerDone.promise; // bare: Y's exit would interrupt the handler's call child, which is Y's (I21)
      return 'Y ok';
    });
    await expect(done).resolves.toBe('Y ok');
    expect(log).toEqual(['Y lent: false', 'k', 'handler call done']);
    await expect(app.close()).resolves.toBeUndefined();
  });
});
