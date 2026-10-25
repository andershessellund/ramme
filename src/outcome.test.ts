// outcome.test.ts — outcome classification, release and body errors
// (DESIGN.md §4.12), destinations (DESIGN.md §4.7, §4.12), the
// interrupted-awaiter group (D13, D16, D39) and the I13 converse.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wait } from './ambient.js';
import type { Body, Context, Fiber, Instruction, Operation, Pool } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import type { NodeImpl } from './node-impl.js';
import { FiberAbortedError } from './resource.js';
import { deferred, events, here, impl, start, tick, trace, within } from './test/util.js';

const linked = { onFailure: 'link' } as const;

function spawn<T>(on: Context, body: Body<T>, opts: Parameters<typeof task>[1] = {}): Fiber<T> {
  return on.fork(task(body, { ...linked, ...opts }));
}

/** `yield* op`'s failure as its value: what `.catch((e) => e)` gave an op that was a promise. */
function* failureOf(op: Operation<unknown>): Generator<Instruction, unknown, unknown> {
  try {
    return yield* op;
  } catch (e) {
    return e;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('classification by state (DESIGN.md §4.12, I13)', () => {
  it('a delivered freeze body that returns is aborted', async () => {
    const app = createRootContext();
    const gate = deferred();
    const f = spawn(app, function* () {
      yield* wait(gate.promise);
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
    const f = spawn(app, function* () {
      yield* wait(gate.promise);
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
      function* () {
        yield* here().interrupted();
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
      function* () {
        yield* wait(gate.promise);
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
    const f = spawn(app, function* () {
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
  it('body defect + release failure → defect(SuppressedError(releaseError, bodyError))', async () => {
    const app = createRootContext();
    const releaseError = new Error('release');
    const bodyError = new Error('body');
    const err = await app
      .call(function* () {
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

  it('body success + two release failures → defect with an AggregateError (release order)', async () => {
    const app = createRootContext();
    const e1 = new Error('first owned');
    const e2 = new Error('second owned');
    const err = await app
      .call(function* () {
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

  it('aborted body + release failure → defect', async () => {
    const app = createRootContext();
    const releaseError = new Error('release');
    let B!: NodeImpl;
    const p = start(app.call(function* () {
      B = here();
      here().own(() => {
        throw releaseError;
      });
      yield* here().never();
    }));
    await tick();
    B.abort();
    await expect(p).rejects.toBe(releaseError);
    expect(B.outcome).toEqual({ status: 'defect', error: releaseError });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
describe('failure destinations (DESIGN.md §4.7, §4.12)', () => {
  it("an unconsumed 'join' failure surfaces once, from the parent's completion", async () => {
    const app = createRootContext();
    const err = new Error('unjoined');
    let P!: NodeImpl;
    const p = start(app.call(function* () {
      P = here();
      here().fork(function* () {
        throw err;
      });
      yield* wait(tick());
      return 'parent ok';
    }));
    await expect(p).rejects.toBe(err);
    expect(P.outcome).toEqual({ status: 'defect', error: err });
    await expect(app.close()).resolves.toBeUndefined(); // delivered to the caller of call: not again
  });

  it("a joined failure does not surface from the parent, and leaves parent.unconsumed empty", async () => {
    const app = createRootContext();
    const err = new Error('joined');
    let P!: NodeImpl;
    let caught: unknown;
    const v = await app.call(function* () {
      P = here();
      const f = here().fork(function* () {
        throw err;
      });
      yield* wait(tick());
      expect(P.unconsumed.size).toBe(1);
      try {
        yield* here().join(f);
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
    spawn(app, function* () {
      here().own(() => void (parentAbortedAtRelease = app.signal.aborted)); // runs after the settle
      throw err;
    });
    await tick();
    expect(app.signal.aborted).toBe(true);
    expect(parentAbortedAtRelease).toBe(true);
    await expect(app.close()).rejects.toBe(err);
    expect(app.outcome).toEqual({ status: 'defect', error: err });
  });

  it("'link' interrupts a parent that is closing: its siblings are delivered and close() settles (DESIGN.md §4.7)", async () => {
    const app = createRootContext();
    const c = app.child();
    const err = new Error('linked during close');
    const gate = deferred();
    let siblingHeard: unknown;
    spawn(c, function* () {
      yield* wait(gate.promise);
      throw err;
    });
    spawn(
      c,
      function* () {
        siblingHeard = yield* here().interrupted();
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
      function* () {
        here().own(
          here().fork(function* () {
            yield* wait(gate.promise);
            throw err;
          }),
        );
        here().fork(
          task(
            function* () {
              siblingHeard = yield* here().interrupted();
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
    await expect(app.result(O)).resolves.toEqual({ status: 'defect', error: err });
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
      function* () {
        worker = here().fork(function* () {
          yield* here().never();
        });
        here().fork(
          task(
            function* () {
              yield* wait(gate.promise);
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
    await expect(app.result(S)).resolves.toEqual({ status: 'defect', error: err });
    expect(worker.outcome).toEqual({ status: 'aborted', reason: err }); // delivered, halted at never()
    await expect(app.close()).rejects.toBe(err);
  });

  it("a 'link' fiber whose body succeeds and whose release fails surfaces from a bodiless parent that completes inside the escalation (I11)", async () => {
    const ev = events();
    const app = ev.root;
    const boom = new Error('release after success');
    const f = spawn(app, function* () {
      here().own(() => {
        throw boom;
      });
    });
    await tick();
    expect(app.state).toBe('complete'); // aborted by the escalation, and completed inside it
    expect(app.outcome).toEqual({ status: 'defect', error: boom });
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
        task(function* () {
          here().own(() => {
            throw boom;
          });
        }, linked),
      ),
    );
    await tick();
    expect(owner.state).toBe('complete');
    expect(owner.outcome).toEqual({ status: 'defect', error: boom });
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
    pool.fork(function* () {
      throw new Error('body');
    });
    await tick();
    expect(pool.state).toBe('complete');
    expect(pool.outcome).toEqual({ status: 'defect', error: handlerError });
    await expect(app.close()).rejects.toBe(handlerError);
  });

  it('a handler is called once with the final failure — a release failure after a successful body included — with the parent current (DESIGN.md §4.7)', async () => {
    const app = createRootContext();
    const releaseError = new Error('release after success');
    const calls: { error: unknown; fiber: unknown; current: NodeImpl }[] = [];
    const f = app.fork(
      task(
        function* () {
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
    const p = start(app.call(function* () {
      O = here();
      here().own(
        here().fork(function* () {
          yield* wait(tick());
          throw err;
        }),
      );
      yield* here().never();
    }));
    await expect(p).rejects.toBe(err);
    expect(O.signal.reason).toBe(err);
    await app.close();
  });

  it('an aborted fiber fires no destination (I12)', async () => {
    const app = createRootContext();
    const handler = vi.fn();
    const f = app.fork(
      task(
        function* () {
          yield* here().never();
        },
        { onFailure: handler },
      ),
    );
    const l = spawn(app, function* () {
      yield* here().never();
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
        function* () {
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
describe('halted waiters consume nothing (D13, D16, D39)', () => {
  it("an owner interrupted on join(f) by its owned f's failure is halted at once (an owned fiber's join is not call-shaped): no catch runs, its finally does, the owner's outcome is failure, it surfaces exactly once, and f's record is consumed", async () => {
    const app = createRootContext();
    const err = new Error('owned f failed');
    let O!: NodeImpl;
    let f!: NodeImpl;
    let caught: unknown = 'no catch ran';
    let reason: unknown;
    const p = start(app.call(function* () {
      O = here();
      f = impl(
        here().own(
          here().fork(function* () {
            yield* wait(tick());
            throw err;
          }),
        ),
      );
      try {
        yield* here().join(f as unknown as Fiber<unknown>); // halted by f's C5 abort; this join never delivers
      } catch (e) {
        caught = e;
        throw e;
      } finally {
        reason = here().signal.reason;
      }
    }));
    await expect(p).rejects.toBe(err);
    expect(caught).toBe('no catch ran');
    expect(reason).toBe(err); // C5 aborts the owner with the owned fiber's failure
    expect(O.outcome).toEqual({ status: 'defect', error: err });
    expect(f.failure?.consumed).toBe(true);
    await expect(app.close()).resolves.toBeUndefined(); // exactly once
  });

  it('a parent interrupted on call(observeChild) whose child fails after the parent was delivered is halted once the child completed: no catch runs, nothing is consumed, and the failure surfaces from the parent', async () => {
    const app = createRootContext();
    const err = new Error('late observe failure');
    let P!: NodeImpl;
    let C!: NodeImpl;
    let atCatch: string | undefined;
    let atFinally: string | undefined;
    const p = start(app.call(function* () {
      P = here();
      try {
        yield* here().call(
          task(
            function* () {
              C = here();
              yield* here().interrupted();
              yield* wait(tick());
              throw err;
            },
            { interrupt: 'observe' },
          ),
        );
      } catch (e) {
        atCatch = `${(e as Error).name}, child ${C.state}`;
        throw e;
      } finally {
        atFinally = `child ${C.state}`;
      }
    }));
    await tick();
    P.abort();
    expect(P.bodyDone).toBe(false); // call-shaped: not returned while the child has not stopped
    await expect(p).rejects.toBe(err);
    expect({ atCatch, atFinally }).toEqual({ atCatch: undefined, atFinally: 'child complete' });
    expect(P.outcome).toEqual({ status: 'defect', error: err });
    await app.close();
  });

  it('a request fiber aborted while awaiting app.call(work), where work later fails: the mark delivers work, the fiber waits for it, and the failure surfaces from app.close()', async () => {
    const app = createRootContext();
    const err = new Error('work failed late');
    const gate = deferred();
    let work!: NodeImpl;
    const Y = spawn(app, function* () {
      yield* app.call(
        task(
          function* () {
            work = here();
            yield* wait(gate.promise);
            throw err;
          },
          { interrupt: 'observe' },
        ),
      );
    });
    await tick();
    Y.abort();
    await tick();
    expect(work.delivered).toBe(true); // the app's child, not Y's: delivered by the call's shape (D39, A.2)
    expect(Y.state).toBe('running'); // call-shaped: Y is returned only once work has completed
    gate.resolve();
    await within(app.result(Y));
    expect(Y.outcome?.status).toBe('aborted');
    expect(work.state).toBe('complete');
    await expect(app.close()).rejects.toBe(err);
  });

  it('a join(f) stored and awaited after a timer: no unhandled rejection; delivered at the late await; unconsumed empty afterwards', async () => {
    const app = createRootContext();
    const err = new Error('late join');
    let P!: NodeImpl;
    let caught: unknown;
    await app.call(function* () {
      P = here();
      const f = here().fork(function* () {
        throw err;
      });
      const j = here().join(f);
      yield* wait(new Promise((r) => setTimeout(r, 5)));
      try {
        yield* j;
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
    const p = start(app.call(function* () {
      const f = here().fork(function* () {
        throw err;
      });
      void here().join(f);
      void here().result(f);
      yield* wait(tick());
      return 'ok';
    }));
    await expect(p).rejects.toBe(err);
    await app.close();
  });

  it("release(x) whose release throws after the caller was interrupted: release work, which the halt lets finish; its failure returns the caller there, unconsumed and never thrown in, and it surfaces from the owner's completion (D39, A.3)", async () => {
    const app = createRootContext();
    const err = new Error('early release failed');
    const gate = deferred();
    let P!: NodeImpl;
    let caught: unknown = 'no catch ran';
    const p = start(app.call(function* () {
      P = here();
      const x = here().own({}, async () => {
        await gate.promise;
        throw err;
      });
      try {
        yield* here().release(x);
      } catch (e) {
        caught = e;
      }
      return 'swallowed';
    }));
    await tick();
    P.abort();
    expect(P.bodyDone).toBe(false); // release work: not returned at the delivery
    gate.resolve();
    await expect(p).rejects.toBe(err);
    expect(caught).toBe('no catch ran'); // returned at the failure, never thrown into
    expect(P.outcome).toEqual({ status: 'defect', error: err }); // aborted + the unconsumed release failure (D24)
    await app.close();
  });

  it('a delivered release(x) caller receives the error, and the owner does not', async () => {
    const app = createRootContext();
    const err = new Error('early release failed');
    let caught: unknown;
    let P!: NodeImpl;
    const v = await app.call(function* () {
      P = here();
      const x = here().own({}, async () => {
        await tick();
        throw err;
      });
      try {
        yield* here().release(x);
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
        function* () {
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
    expect(N.outcome).toEqual({ status: 'defect', error: E3 });
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
        function* () {
          const releasing = M.releaseAll(); // b first, held at the gate
          awaiting.resolve();
          yield* releasing;
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
    await app.call(function* () {
      f = here().fork(function* () {
        throw err;
      });
      yield* wait(expect(here().join(f)).rejects.toBe(err));
      yield* wait(expect(here().join(f)).rejects.toBe(err));
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
      spawn(app, function* () {
        throw abortError;
      }, { onFailure: () => {} }),
    );
    const r2 = await app.result(
      spawn(app, function* () {
        throw fiberAborted;
      }, { onFailure: () => {} }),
    );
    expect(r1).toEqual({ status: 'defect', error: abortError });
    expect(r2).toEqual({ status: 'defect', error: fiberAborted });
    await app.close();
  });

  it('a delivered observe body that throws fails with its own error', async () => {
    const app = createRootContext();
    const err = new Error('observe threw');
    const f = spawn(
      app,
      function* () {
        yield* here().interrupted();
        throw err;
      },
      { interrupt: 'observe', onFailure: () => {} },
    );
    await tick();
    f.abort();
    expect(await app.result(f)).toEqual({ status: 'defect', error: err });
    await app.close();
  });

  it('a delivered freeze body that returns normally is aborted', async () => {
    const t = trace();
    const app = createRootContext();
    const gate = deferred();
    const f = spawn(app, function* () {
      yield* wait(gate.promise);
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
    const results = await app.call(function* () {
      const self = here();
      const ok = yield* self.all([task(function* () { return 1; }), task(function* () { return 'x'; }).bind(), task(function* (n: number) { return n * 2; }).bind(21)]);
      const failed = yield* failureOf(
        self.all([
          task(function* () {
            throw e1;
          }, { onFailure: 'link' }), // forced to 'join' inside the group (DESIGN.md §4.8)
          task(function* () { return 'fine'; }),
          task(function* () {
            throw e2;
          }),
        ]),
      );
      const aborted = yield* failureOf(
        self.all([
          task(function* () {
            here().abort('member aborted');
            yield* here().never();
          }),
          task(function* () { return 2; }),
        ]),
      );
      const empty = yield* self.all([]);
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
    const out = await app.call(function* () {
      const self = here();
      const winner = yield* self.race([
        task(function* () {
          yield* wait(tick());
          return 'slow';
        }),
        task(function* () { return 'fast'; }),
        task(function* () {
          here().own(t.at('loser released'));
          yield* here().never();
          return 'never';
        }),
      ]);
      t.push('race returned');
      const allFailed = yield* failureOf(
        self.race([
          task(function* () {
            throw err;
          }),
          task(function* () {
            throw err;
          }),
        ]),
      );
      let empty: unknown;
      try {
        yield* self.race([]);
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
    const p = start(app.call(function* () {
      P = here();
      yield* here().all([
        task(function* () {
          group = here().parent!;
          throw err;
        }),
        task(function* () {
          yield* here().never();
        }),
      ]);
    }));
    await tick();
    expect(group.unconsumed.size).toBe(1); // the failed member waits for the whole group
    P.abort();
    await expect(p).rejects.toBe(err);
    expect(group.outcome).toEqual({ status: 'defect', error: err }); // aborted by state + the member's unconsumed failure
    await expect(app.close()).resolves.toBeUndefined();
  });
});
