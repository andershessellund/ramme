// outcome.test.ts — outcome classification, release and body errors
// (DESIGN.md §4.12), destinations (DESIGN.md §4.7, §4.12), the
// interrupted-awaiter group (D13, D16, D39) and the I13 converse.
import { afterEach, describe, expect, it, vi } from 'vitest';
import './node.js';
import type { Context, Fiber, Pool } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import type { NodeImpl } from './node-impl.js';
import { FiberAbortedError, InterruptedError } from './resource.js';
import { deferred, events, here, impl, tick, trace, within } from './test/util.js';

const linked = { onFailure: 'link' } as const;

function spawn<T>(on: Context, body: () => Promise<T> | T, opts: Parameters<typeof task>[1] = {}): Fiber<T> {
  return on.fork(task(body, { ...linked, ...opts }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('classification by state (DESIGN.md §4.12, I13)', () => {
  it('a delivered freeze body that returns is aborted', async () => {
    const app = createRootContext();
    const gate = deferred();
    const f = spawn(app, async () => {
      await gate.promise;
      return 'value';
    });
    await tick();
    f.abort('stop');
    gate.resolve();
    expect(await app.result(f)).toEqual({ status: 'aborted', reason: 'stop' });
    await app.close();
  });

  it('a delivered freeze body that throws is aborted', async () => {
    const app = createRootContext();
    const gate = deferred();
    const f = spawn(app, async () => {
      await gate.promise;
      throw new Error('ignored');
    });
    await tick();
    f.abort('stop');
    gate.resolve();
    expect(await app.result(f)).toEqual({ status: 'aborted', reason: 'stop' });
    await app.close();
  });

  it("a delivered observe body's outcome is its own result", async () => {
    const app = createRootContext();
    const f = spawn(
      app,
      async () => {
        await here().interrupted();
        return 'graceful';
      },
      { interrupt: 'observe' },
    );
    await tick();
    f.abort();
    expect(await app.result(f)).toEqual({ status: 'success', value: 'graceful' });
    await app.close();
  });

  it('a delivered restore body is aborted', async () => {
    const app = createRootContext();
    const gate = deferred();
    const f = spawn(
      app,
      async () => {
        await gate.promise;
        return 'value';
      },
      { interrupt: 'restore' },
    );
    await tick();
    f.abort('stop');
    gate.resolve();
    expect((await app.result(f)).status).toBe('aborted');
    await app.close();
  });

  it('a bodiless node is success on close() and aborted on abort()', async () => {
    const app = createRootContext();
    const a = app.child();
    const b = app.child();
    await a.close();
    b.abort('stop');
    expect(a.outcome).toEqual({ status: 'success', value: undefined });
    expect(b.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    await app.close();
  });

  it('a delivery after settling leaves the outcome alone', async () => {
    const app = createRootContext();
    const d = deferred();
    const f = spawn(app, async () => {
      here().own(() => d.promise); // keeps the fiber releasing
      return 1;
    });
    await tick();
    expect(f.state).toBe('releasing');
    f.abort('late');
    d.resolve();
    expect(await app.result(f)).toEqual({ status: 'success', value: 1 });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
describe('body and release errors (DESIGN.md §4.12)', () => {
  it('body failure + release failure → SuppressedError(releaseError, bodyError)', async () => {
    const app = createRootContext();
    const releaseError = new Error('release');
    const bodyError = new Error('body');
    const err = await app
      .call(async () => {
        here().own(() => {
          throw releaseError;
        });
        throw bodyError;
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    const s = err as Error & { error: unknown; suppressed: unknown };
    expect(s.name).toBe('SuppressedError');
    expect(s.error).toBe(releaseError);
    expect(s.suppressed).toBe(bodyError);
    await app.close();
  });

  it('body success + two release failures → failure with an AggregateError (release order)', async () => {
    const app = createRootContext();
    const e1 = new Error('first owned');
    const e2 = new Error('second owned');
    const err = await app
      .call(async () => {
        here().own(() => {
          throw e1;
        });
        here().own(() => {
          throw e2;
        });
        return 'ok';
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toEqual([e2, e1]);
    await app.close();
  });

  it('aborted body + release failure → failure', async () => {
    const app = createRootContext();
    const releaseError = new Error('release');
    let B!: NodeImpl;
    const p = app.call(async () => {
      B = here();
      here().own(() => {
        throw releaseError;
      });
      await here().never();
    });
    await tick();
    B.abort();
    await expect(p).rejects.toBe(releaseError);
    expect(B.outcome).toEqual({ status: 'failure', error: releaseError });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
describe('failure destinations (DESIGN.md §4.7, §4.12)', () => {
  it("an unconsumed 'join' failure surfaces once, from the parent's completion", async () => {
    const app = createRootContext();
    const err = new Error('unjoined');
    let P!: NodeImpl;
    const p = app.call(async () => {
      P = here();
      here().fork(async () => {
        throw err;
      });
      await tick();
      return 'parent ok';
    });
    await expect(p).rejects.toBe(err);
    expect(P.outcome).toEqual({ status: 'failure', error: err });
    await expect(app.close()).resolves.toBeUndefined(); // delivered to the caller of call: not again
  });

  it("a joined failure does not surface from the parent, and leaves parent.unconsumed empty", async () => {
    const app = createRootContext();
    const err = new Error('joined');
    let P!: NodeImpl;
    let caught: unknown;
    const v = await app.call(async () => {
      P = here();
      const f = here().fork(async () => {
        throw err;
      });
      await tick();
      expect(P.unconsumed.size).toBe(1);
      try {
        await here().join(f);
      } catch (e) {
        caught = e;
      }
      expect(P.unconsumed.size).toBe(0);
      return 'ok';
    });
    expect(v).toBe('ok');
    expect(caught).toBe(err);
    await app.close();
  });

  it("'link' aborts the parent when the fiber settles, and surfaces from the parent's completion", async () => {
    const app = createRootContext();
    const err = new Error('linked');
    let parentAbortedAtRelease: boolean | undefined;
    spawn(app, async () => {
      here().own(() => void (parentAbortedAtRelease = app.signal.aborted)); // runs after the settle
      throw err;
    });
    await tick();
    expect(app.signal.aborted).toBe(true);
    expect(parentAbortedAtRelease).toBe(true);
    await expect(app.close()).rejects.toBe(err);
    expect(app.outcome).toEqual({ status: 'failure', error: err });
  });

  it("'link' interrupts a parent that is closing: its siblings are delivered and close() settles (DESIGN.md §4.7)", async () => {
    const app = createRootContext();
    const c = app.child();
    const err = new Error('linked during close');
    const gate = deferred();
    let siblingHeard: unknown;
    spawn(c, async () => {
      await gate.promise;
      throw err;
    });
    spawn(
      c,
      async () => {
        siblingHeard = await here().interrupted();
      },
      { interrupt: 'observe' },
    );
    await tick();
    const closing = c.close();
    await tick();
    expect(c.state).toBe('releasing'); // waiting for its children: close() is mostly a wait
    gate.resolve();
    await expect(closing).rejects.toBe(err);
    expect(siblingHeard).toBe(err);
    expect(c.signal.reason).toBe(err);
    await app.close();
  });

  it("an owned fiber that fails after its owner's body exited under childrenOnExit 'await' interrupts the owner's other children (C5, DESIGN.md §4.7)", async () => {
    const app = createRootContext();
    const err = new Error('owned, after the body');
    const gate = deferred();
    let siblingHeard: unknown;
    const O = spawn(
      app,
      async () => {
        here().own(
          here().fork(async () => {
            await gate.promise;
            throw err;
          }),
        );
        here().fork(
          task(
            async () => {
              siblingHeard = await here().interrupted();
            },
            { interrupt: 'observe' },
          ),
        );
      },
      { childrenOnExit: 'await' },
    );
    await tick();
    expect(O.state).toBe('releasing');
    gate.resolve();
    await expect(app.result(O)).resolves.toEqual({ status: 'failure', error: err });
    expect(siblingHeard).toBe(err);
    await expect(app.close()).rejects.toBe(err); // 'link': O's failure surfaces from its parent too
  });

  it("'link' escalation into an observe parent whose body exited under childrenOnExit 'await' interrupts its freeze children too (DESIGN.md §4.7)", async () => {
    const app = createRootContext();
    const err = new Error('linked after an observe body exited');
    const gate = deferred();
    let worker!: Fiber<void>;
    const S = spawn(
      app,
      async () => {
        worker = here().fork(async () => {
          await here().never();
        });
        here().fork(
          task(
            async () => {
              await gate.promise;
              throw err;
            },
            { onFailure: 'link' },
          ),
        );
      },
      { interrupt: 'observe', childrenOnExit: 'await' },
    );
    await tick();
    expect(S.state).toBe('releasing'); // the body returned; S waits for both children
    gate.resolve();
    await expect(app.result(S)).resolves.toEqual({ status: 'failure', error: err });
    expect(worker.outcome).toEqual({ status: 'aborted', reason: err }); // delivered, rejected at never()
    await expect(app.close()).rejects.toBe(err);
  });

  it("a 'link' fiber whose body succeeds and whose release fails surfaces from a bodiless parent that completes inside the escalation (I11)", async () => {
    const ev = events();
    const app = ev.root;
    const boom = new Error('release after success');
    const f = spawn(app, async () => {
      here().own(() => {
        throw boom;
      });
    });
    await tick();
    expect(app.state).toBe('complete'); // aborted by the escalation, and completed inside it
    expect(app.outcome).toEqual({ status: 'failure', error: boom });
    await expect(app.close()).rejects.toBe(boom);
    expect(impl(app).unconsumed.size).toBe(0);
    const fEvents = ev.typesOf(f.id);
    expect(fEvents.indexOf('node:complete')).toBe(fEvents.length - 1); // never re-marked after completion
    expect(fEvents).not.toContain('node:delivered');
  });

  it('an owned fiber whose release fails after a successful body surfaces from a child() owner that completes inside the escalation (C5, I11)', async () => {
    const app = createRootContext();
    const boom = new Error('owned release');
    const owner = app.child();
    owner.own(
      owner.fork(
        task(async () => {
          here().own(() => {
            throw boom;
          });
        }, linked),
      ),
    );
    await tick();
    expect(owner.state).toBe('complete');
    expect(owner.outcome).toEqual({ status: 'failure', error: boom });
    await expect(app.close()).rejects.toBe(boom); // the owner's failure is routed to app (D16)
  });

  it('a handler that aborts its pool and then throws: the exception surfaces from the pool, which waits for the handler (I11)', async () => {
    const app = createRootContext();
    const handlerError = new Error('handler threw after aborting its pool');
    const pool: Pool = app.pool({
      name: 'p',
      onFailure: () => {
        pool.abort();
        expect(pool.state).not.toBe('complete'); // held open by the failed fork's entry
        throw handlerError;
      },
    });
    pool.fork(async () => {
      throw new Error('body');
    });
    await tick();
    expect(pool.state).toBe('complete');
    expect(pool.outcome).toEqual({ status: 'failure', error: handlerError });
    await expect(app.close()).rejects.toBe(handlerError);
  });

  it('a handler is called once with the final failure — a release failure after a successful body included — with the parent current (DESIGN.md §4.7)', async () => {
    const app = createRootContext();
    const releaseError = new Error('release after success');
    const calls: { error: unknown; fiber: unknown; current: NodeImpl }[] = [];
    const f = app.fork(
      task(
        async () => {
          here().own(() => {
            throw releaseError;
          });
          return 'body ok';
        },
        { onFailure: (error, fiber) => void calls.push({ error, fiber, current: here() }) },
      ),
    );
    await tick(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].error).toBe(releaseError);
    expect(calls[0].fiber).toBe(f);
    expect(calls[0].current).toBe(impl(app));
    await expect(app.close()).resolves.toBeUndefined(); // handled: not the parent's
  });

  it("an owned fiber's failure aborts the owner (C5) and surfaces from the owner", async () => {
    const app = createRootContext();
    const err = new Error('owned');
    let O!: NodeImpl;
    const p = app.call(async () => {
      O = here();
      here().own(
        here().fork(async () => {
          await tick();
          throw err;
        }),
      );
      await here().never();
    });
    await expect(p).rejects.toBe(err);
    expect(O.signal.reason).toBe(err);
    await app.close();
  });

  it('an aborted fiber fires no destination (I12)', async () => {
    const app = createRootContext();
    const handler = vi.fn();
    const f = app.fork(
      task(
        async () => {
          await here().never();
        },
        { onFailure: handler },
      ),
    );
    const l = spawn(app, async () => {
      await here().never();
    });
    await tick();
    f.abort();
    l.abort();
    await tick();
    expect(handler).not.toHaveBeenCalled();
    expect(app.signal.aborted).toBe(false); // the 'link' fiber's abort did not abort the parent
    await expect(app.close()).resolves.toBeUndefined();
  });

  it('a handler that throws is recorded on the parent', async () => {
    const app = createRootContext();
    const handlerError = new Error('handler threw');
    app.fork(
      task(
        async () => {
          throw new Error('body');
        },
        {
          onFailure: () => {
            throw handlerError;
          },
        },
      ),
    );
    await tick();
    await expect(app.close()).rejects.toBe(handlerError);
  });
});

// ---------------------------------------------------------------------------
describe('interrupted awaiters consume nothing (D13, D16, D39)', () => {
  it("an owner interrupted on join(f) by its owned f's failure: the join rejects with InterruptedError, the owner's outcome is failure, it surfaces exactly once, and f's record is consumed", async () => {
    const app = createRootContext();
    const err = new Error('owned f failed');
    let O!: NodeImpl;
    let f!: NodeImpl;
    let caught: unknown;
    const p = app.call(async () => {
      O = here();
      f = impl(
        here().own(
          here().fork(async () => {
            await tick();
            throw err;
          }),
        ),
      );
      try {
        await here().join(f as unknown as Fiber<unknown>); // rejected by f's C5 abort; this join never delivers
      } catch (e) {
        caught = e;
        throw e;
      }
    });
    await expect(p).rejects.toBe(err);
    expect(caught).toBeInstanceOf(InterruptedError);
    expect((caught as InterruptedError).reason).toBe(err); // C5 aborts the owner with the owned fiber's failure
    expect(O.outcome).toEqual({ status: 'failure', error: err });
    expect(f.failure?.consumed).toBe(true);
    await expect(app.close()).resolves.toBeUndefined(); // exactly once
  });

  it('a parent interrupted on call(observeChild) whose child fails after the parent was delivered: the call rejects once the child completed, consumes nothing, and the failure surfaces from the parent', async () => {
    const app = createRootContext();
    const err = new Error('late observe failure');
    let P!: NodeImpl;
    let C!: NodeImpl;
    let atCatch: string | undefined;
    const p = app.call(async () => {
      P = here();
      try {
        await here().call(
          task(
            async () => {
              C = here();
              await here().interrupted();
              await tick();
              throw err;
            },
            { interrupt: 'observe' },
          ),
        );
      } catch (e) {
        atCatch = `${(e as Error).name}, child ${C.state}`;
        throw e;
      }
    });
    await tick();
    P.abort();
    expect(P.bodyDone).toBe(false); // lent to the child, which has not stopped
    await expect(p).rejects.toBe(err);
    expect(atCatch).toBe('InterruptedError, child complete');
    expect(P.outcome).toEqual({ status: 'failure', error: err });
    await app.close();
  });

  it('a request fiber aborted while awaiting app.call(work), where work later fails: the mark delivers work, the fiber waits for it, and the failure surfaces from app.close()', async () => {
    const app = createRootContext();
    const err = new Error('work failed late');
    const gate = deferred();
    let work!: NodeImpl;
    const Y = spawn(app, async () => {
      await app.call(
        task(
          async () => {
            work = here();
            await gate.promise;
            throw err;
          },
          { interrupt: 'observe' },
        ),
      );
    });
    await tick();
    Y.abort();
    await tick();
    expect(work.delivered).toBe(true); // the app's child, not Y's: delivered by the call's mark (D39, A.2)
    expect(Y.state).toBe('running'); // still lent to work (D11)
    expect(work.lender).toBe(impl(Y));
    gate.resolve();
    await within(app.result(Y));
    expect(Y.outcome?.status).toBe('aborted');
    expect(work.lender).toBeUndefined(); // work completed first and cleared the lending pair (A2)
    await expect(app.close()).rejects.toBe(err);
  });

  it('a join(f) stored and awaited after a timer: no unhandled rejection; delivered at the late await; unconsumed empty afterwards', async () => {
    const app = createRootContext();
    const err = new Error('late join');
    let P!: NodeImpl;
    let caught: unknown;
    await app.call(async () => {
      P = here();
      const f = here().fork(async () => {
        throw err;
      });
      const j = here().join(f);
      await new Promise((r) => setTimeout(r, 5));
      try {
        await j;
      } catch (e) {
        caught = e;
      }
      expect(P.unconsumed.size).toBe(0);
    });
    expect(caught).toBe(err);
    await app.close();
  });

  it('result(f) and join(f) whose promises are never awaited: the failure surfaces from the parent', async () => {
    const app = createRootContext();
    const err = new Error('never delivered');
    const p = app.call(async () => {
      const f = here().fork(async () => {
        throw err;
      });
      void here().join(f);
      void here().result(f);
      await tick();
      return 'ok';
    });
    await expect(p).rejects.toBe(err);
    await app.close();
  });

  it("release(x) whose release throws after the caller was interrupted: the exempt await is delivered the error but consumes nothing, and it surfaces from the owner's completion (D39, A.3)", async () => {
    const app = createRootContext();
    const err = new Error('early release failed');
    const gate = deferred();
    let P!: NodeImpl;
    let caught: unknown;
    const p = app.call(async () => {
      P = here();
      const x = here().own({}, async () => {
        await gate.promise;
        throw err;
      });
      try {
        await here().release(x);
      } catch (e) {
        caught = e;
      }
      return 'swallowed';
    });
    await tick();
    P.abort();
    expect(P.bodyDone).toBe(false); // release work: not rejected by the delivery
    gate.resolve();
    await expect(p).rejects.toBe(err);
    expect(caught).toBe(err); // delivered to the awaiter, not consumed by it
    expect(P.outcome).toEqual({ status: 'failure', error: err }); // aborted + the unconsumed release failure (D24)
    await app.close();
  });

  it('a delivered release(x) caller receives the error, and the owner does not', async () => {
    const app = createRootContext();
    const err = new Error('early release failed');
    let caught: unknown;
    let P!: NodeImpl;
    const v = await app.call(async () => {
      P = here();
      const x = here().own({}, async () => {
        await tick();
        throw err;
      });
      try {
        await here().release(x);
      } catch (e) {
        caught = e;
      }
      return 'ok';
    });
    expect(v).toBe('ok');
    expect(caught).toBe(err);
    expect(P.outcome?.status).toBe('success');
    await app.close();
  });

  it("an early-release awaiter still waiting when its owner's loop finds both stacks empty is delivered the error, and the owner does not surface it (D16)", async () => {
    // release(x) on a bodiless owner whose loop registered on x's release before the caller awaited it
    const app = createRootContext();
    const M = app.child({ name: 'M' });
    const err = new Error('x failed');
    const x = M.own({}, async () => {
      await tick();
      throw err;
    });
    const p = M.release(x);
    M.abort(); // the loop waits on x's release first; the caller's await comes after
    await expect(p).rejects.toBe(err);
    expect(M.state).toBe('complete');
    expect(M.outcome?.status).toBe('aborted');
    await expect(M.close()).resolves.toBeUndefined();
    // an observe body that attaches a reaction to releaseAll() and returns: the reaction is delivered, the fiber succeeds
    let seen: unknown;
    let F!: NodeImpl;
    await app.call(
      task(
        async () => {
          F = here();
          here().own({}, () => {
            throw err;
          });
          here().own({}, async () => {
            await tick();
          });
          void here()
            .releaseAll()
            .then(undefined, (e: unknown) => {
              seen = e;
            });
        },
        { interrupt: 'observe' },
      ),
    );
    expect(seen).toBe(err);
    expect(F.outcome?.status).toBe('success');
    await expect(app.close()).resolves.toBeUndefined();
  });

  it("an early release(x) made, and awaited at once, after its owner's loop was woken and before it re-reads is the caller's alone (D16)", async () => {
    const app = createRootContext();
    const M = app.child({ name: 'M' });
    const E1 = new Error('x1 failed');
    const E2 = new Error('x2 failed');
    const x1 = M.own({}, async () => {
      await tick();
      throw E1;
    });
    const p1 = M.release(x1);
    M.abort(); // the loop waits on x1, then for p1's awaiter (D16)
    let c1: unknown;
    try {
      await p1;
    } catch (e) {
      c1 = e;
    }
    // This continuation runs before the loop's re-read, which p1's delivery queued after it.
    expect(c1).toBe(E1);
    expect(M.state).toBe('releasing');
    const x2 = M.own({}, () => {
      throw E2; // synchronous: the failure is recorded before release(x2) returns
    });
    let c2: unknown;
    try {
      await M.release(x2); // `then` is called one microtask later, after the loop's re-read
    } catch (e) {
      c2 = e;
    }
    expect(c2).toBe(E2);
    await expect(within(M.close())).resolves.toBeUndefined(); // not E2 a second time
    expect(M.outcome?.status).toBe('aborted');
    expect(impl(M).earlyAwaits.size).toBe(0);
    // A call nobody awaits is waited for only until an immediate await could have made its `then`: the
    // owner folds the failure then, once.
    const N = app.child({ name: 'N' });
    const E3 = new Error('y failed');
    const y = N.own({}, () => {
      throw E3;
    });
    void N.release(y);
    await expect(within(N.close())).rejects.toBe(E3);
    expect(N.outcome).toEqual({ status: 'failure', error: E3 });
    expect(impl(N).earlyAwaits.size).toBe(0);
    await expect(app.close()).resolves.toBeUndefined();
  });

  it("an early-release awaiter interrupted while its owner's loop waits for it is delivered the error without consuming it, which leaves it to the owner's completion (D16, D39)", async () => {
    const app = createRootContext();
    const M = app.child({ name: 'M' });
    const err = new Error('a failed');
    const gate = deferred();
    let resumed = false;
    M.own(function a() {
      // Runs inside releaseAll()'s loop, after M's own loop registered on b; the abort lands after that
      // loop found both stacks empty and began waiting for Y's delivery.
      queueMicrotask(() => Y.abort());
      throw err;
    });
    M.own(async function b() {
      await gate.promise;
    });
    const awaiting = deferred();
    const Y: Fiber<void> = app.fork(
      task(
        async () => {
          const releasing = M.releaseAll(); // b first, held at the gate
          awaiting.resolve();
          await releasing;
          resumed = true;
        },
        linked, // aborted: fires no destination (I12)
      ),
    );
    await awaiting.promise;
    M.abort();
    gate.resolve();
    await expect(within(M.close())).rejects.toBe(err); // exactly once: from the owner, not from Y
    expect(resumed).toBe(false);
    expect(Y.outcome?.status).toBe('aborted');
    expect(impl(M).earlyAwaits.size).toBe(0);
    await expect(app.close()).resolves.toBeUndefined();
  });

  it("a child() whose entry's release fails surfaces from the parent's close(), unless child.close() was awaited first", async () => {
    const err = new Error('child release failed');
    const app1 = createRootContext();
    app1.child().own(() => {
      throw err;
    });
    await expect(app1.close()).rejects.toBe(err);

    const app2 = createRootContext();
    const c = app2.child();
    c.own(() => {
      throw err;
    });
    await expect(c.close()).rejects.toBe(err);
    await expect(app2.close()).resolves.toBeUndefined();
  });

  it("a pool whose passive entry's release fails surfaces from the owner's close(), unless pool.close() was awaited first", async () => {
    const err = new Error('pool entry release failed');
    const app1 = createRootContext();
    app1.pool({ name: 'p', onFailure: () => {} }).own(() => {
      throw err;
    });
    await expect(app1.close()).rejects.toBe(err);

    const app2 = createRootContext();
    const pool = app2.pool({ name: 'p', onFailure: () => {} });
    pool.own(() => {
      throw err;
    });
    await expect(pool.close()).rejects.toBe(err);
    await expect(app2.close()).resolves.toBeUndefined();
  });

  it('a second join(f) and a second [Symbol.asyncDispose]() on a failed fiber reject again with the same error (DESIGN.md §4.12)', async () => {
    const app = createRootContext();
    const err = new Error('failed fiber');
    let f!: Fiber<unknown>;
    await app.call(async () => {
      f = here().fork(async () => {
        throw err;
      });
      await expect(here().join(f)).rejects.toBe(err);
      await expect(here().join(f)).rejects.toBe(err);
    });
    await expect(f[Symbol.asyncDispose]()).rejects.toBe(err);
    await expect(f[Symbol.asyncDispose]()).rejects.toBe(err);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
describe('I13 converse: the error is never inspected', () => {
  it('an undelivered body that throws an AbortError DOMException or a FiberAbortedError fails with that error', async () => {
    const app = createRootContext();
    const abortError = new DOMException('x', 'AbortError');
    const fiberAborted = new FiberAbortedError('r');
    const r1 = await app.result(
      spawn(app, async () => {
        throw abortError;
      }, { onFailure: () => {} }),
    );
    const r2 = await app.result(
      spawn(app, async () => {
        throw fiberAborted;
      }, { onFailure: () => {} }),
    );
    expect(r1).toEqual({ status: 'failure', error: abortError });
    expect(r2).toEqual({ status: 'failure', error: fiberAborted });
    await app.close();
  });

  it('a delivered observe body that throws fails with its own error', async () => {
    const app = createRootContext();
    const err = new Error('observe threw');
    const f = spawn(
      app,
      async () => {
        await here().interrupted();
        throw err;
      },
      { interrupt: 'observe', onFailure: () => {} },
    );
    await tick();
    f.abort();
    expect(await app.result(f)).toEqual({ status: 'failure', error: err });
    await app.close();
  });

  it('a delivered freeze body that returns normally is aborted', async () => {
    const t = trace();
    const app = createRootContext();
    const gate = deferred();
    const f = spawn(app, async () => {
      await gate.promise;
      t.push('returned normally');
      return 'fine';
    });
    await tick();
    f.abort('stop');
    gate.resolve();
    expect(await app.result(f)).toEqual({ status: 'aborted', reason: 'stop' });
    expect(t.log).toEqual(['returned normally']);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// fiber.test.ts covers all/race's full surface.
describe('all and race outcomes (DESIGN.md §4.8, D13)', () => {
  it('all: the tuple in order; every real failure in one AggregateError; FiberAbortedError for an aborted member and no failure', async () => {
    const app = createRootContext();
    const e1 = new Error('one');
    const e2 = new Error('two');
    const results = await app.call(async () => {
      const self = here();
      const ok = await self.all([task(async () => 1), task(async () => 'x').bind(), task(async (n: number) => n * 2).bind(21)]);
      const failed = await self
        .all([
          task(async () => {
            throw e1;
          }, { onFailure: 'link' }), // forced to 'join' inside the group (DESIGN.md §4.8)
          task(async () => 'fine'),
          task(async () => {
            throw e2;
          }),
        ])
        .catch((e: unknown) => e);
      const aborted = await self
        .all([
          task(async () => {
            here().abort('member aborted');
            await here().never();
          }),
          task(async () => 2),
        ])
        .catch((e: unknown) => e);
      const empty = await self.all([]);
      return { ok, failed, aborted, empty };
    });
    expect(results.ok).toEqual([1, 'x', 42]);
    expect(results.failed).toBeInstanceOf(AggregateError);
    expect((results.failed as AggregateError).errors).toEqual([e1, e2]);
    expect(results.aborted).toBeInstanceOf(FiberAbortedError);
    expect((results.aborted as FiberAbortedError).reason).toBe('member aborted');
    expect(results.empty).toEqual([]);
    await expect(app.close()).resolves.toBeUndefined();
  });

  it('race: the first success wins and the rest are aborted and awaited; all failed → AggregateError; race([]) → TypeError', async () => {
    const app = createRootContext();
    const t = trace();
    const err = new Error('lost');
    const out = await app.call(async () => {
      const self = here();
      const winner = await self.race([
        task(async () => {
          await tick();
          return 'slow';
        }),
        task(async () => 'fast'),
        task(async () => {
          here().own(t.at('loser released'));
          await here().never();
          return 'never';
        }),
      ]);
      t.push('race returned');
      const allFailed = await self
        .race([
          task(async () => {
            throw err;
          }),
          task(async () => {
            throw err;
          }),
        ])
        .catch((e: unknown) => e);
      let empty: unknown;
      try {
        await self.race([]);
      } catch (e) {
        empty = e;
      }
      return { winner, allFailed, empty };
    });
    expect(out.winner).toBe('fast');
    expect(t.log).toEqual(['loser released', 'race returned']);
    expect(out.allFailed).toBeInstanceOf(AggregateError);
    expect((out.allFailed as AggregateError).errors).toEqual([err, err]);
    expect(out.empty).toBeInstanceOf(TypeError);
    await app.close();
  });

  it("an interrupted all() group consumes nothing: a member's early failure surfaces from the group's completion and its caller (DESIGN.md §4.8, D13)", async () => {
    const app = createRootContext();
    const err = new Error('early member failure');
    let P!: NodeImpl;
    let group!: NodeImpl;
    const p = app.call(async () => {
      P = here();
      await here().all([
        task(async () => {
          group = here().parent!;
          throw err;
        }),
        task(async () => {
          await here().never();
        }),
      ]);
    });
    await tick();
    expect(group.unconsumed.size).toBe(1); // the failed member waits for the whole group
    P.abort();
    await expect(p).rejects.toBe(err);
    expect(group.outcome).toEqual({ status: 'failure', error: err }); // aborted by state + the member's unconsumed failure
    await expect(app.close()).resolves.toBeUndefined();
  });
});
