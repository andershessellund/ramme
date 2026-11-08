// Tests for lifecycle / delivery.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wait } from '../../src/ambient.js';
import type { Body, Context, Fiber } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import type { NodeImpl } from '../../src/node-impl.js';
import { FiberAbortedError } from '../../src/resource.js';
import { deferred, events, here, impl, start, tick, trace } from '../support/util.js';

/** A fiber forked onto a bodiless node needs a destination other than 'join' (D14); 'link' surfaces failures. */
const linked = { onFailure: 'link' } as const;

/** Fork a body onto a bodiless node with the 'link' destination. */
function spawn<T>(on: Context, body: Body<T>, opts: Parameters<typeof task>[1] = {}): Fiber<T> {
  return on.fork(task(body, { ...linked, ...opts }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('delivery (DESIGN.md §4.1, §4.3)', () => {
  it('abort marks the whole subscribed subtree before any listener runs (I9)', async () => {
    const app = createRootContext();
    const A = app.child();
    const B = app.child();
    const B1 = B.child();
    const seen: unknown[] = [];
    A.signal.addEventListener('abort', () => {
      seen.push(impl(B).delivered, impl(B1).delivered, B.signal.aborted, B1.signal.aborted);
    });
    app.abort();
    expect(seen).toEqual([true, true, false, false]); // marked, not yet fired
    expect(B1.signal.aborted).toBe(true);
    await app.close();
  });

  it("a listener that forks under an already-marked sibling gets a born-delivered fiber; B.abort() from it emits no second node:delivered", async () => {
    const ev = events();
    const app = ev.root;
    const A = app.child();
    const B = spawn(app, function* () {
      yield* here().never();
    });
    const C = app.child();
    await tick(); // B is suspended on never()
    let born: NodeImpl | undefined;
    A.signal.addEventListener('abort', () => {
      born = impl(B.fork(function* () {})); // B is a fiber: 'join' is allowed
      expect(born.delivered).toBe(true); // born delivered: B is marked and in freeze mode
      expect(born.signal.aborted).toBe(true);
      C.abort(); // already marked: no second delivery
    });
    app.abort();
    await app.close().catch(() => {});
    expect(born).toBeDefined();
    expect(ev.of('node:delivered').filter((e) => e.id === C.id)).toHaveLength(1);
    expect(born!.outcome?.status).toBe('aborted');
  });

  it("B.abort() from A's listener releases B only after B's signal fired: node:delivered before entry:released and node:complete (DESIGN.md §2.4, §4.1)", async () => {
    const ev = events();
    const app = ev.root;
    const A = app.child({ name: 'A' });
    const B = app.child({ name: 'B' });
    let sawAborted: boolean | undefined;
    B.own(function releaseB() {
      sawAborted = B.signal.aborted;
    });
    A.signal.addEventListener('abort', () => B.abort());
    app.abort();
    expect(sawAborted).toBe(true);
    expect(B.state).toBe('complete');
    const order = ev.typesOf(B.id);
    expect(order.indexOf('node:delivered')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('node:delivered')).toBeLessThan(order.indexOf('entry:released'));
    expect(order.indexOf('node:delivered')).toBeLessThan(order.indexOf('node:complete'));
    expect(ev.of('node:delivered').filter((e) => e.id === B.id)).toHaveLength(1);
    await app.close();
  });

  it("close() of an already-marked node from a listener waits for the delivery's pass 2: the abort wins, after the signal (DESIGN.md §2.7, §4.1)", async () => {
    const app = createRootContext();
    const A = app.child();
    const B = app.child();
    const B1 = B.child();
    const saw: Record<string, boolean> = {};
    B.own(() => void (saw.B = B.signal.aborted));
    B1.own(() => void (saw.B1 = B1.signal.aborted));
    A.signal.addEventListener('abort', () => void B.close().catch(() => {}));
    app.abort();
    expect(saw).toEqual({ B: true, B1: true }); // each released after its own signal; B1 interrupted, not closed
    expect(B.outcome?.status).toBe('aborted');
    await app.close();
  });

  it("an unstarted fiber aborted from a listener while its delivery's pass 2 runs still never runs (DESIGN.md §4.1, §4.6)", async () => {
    const ev = events();
    const app = ev.root;
    let ran = false;
    let F!: Fiber<void>;
    let afterAbort: string | undefined;
    const P = app.fork(
      task(
        function* () {
          F = here().fork(() => void (ran = true)); // not started: its start microtask is queued
          here().signal.addEventListener('abort', () => F.abort());
          here().abort(); // from P's own plain code: P's body is running, so P's loop does not reach F yet
          afterAbort = F.outcome?.status; // settled in pass 2b, after its signal fired
          yield* here().never();
        },
        linked,
      ),
    );
    await app.result(P);
    expect(afterAbort).toBe('aborted');
    expect(ran).toBe(false);
    const order = ev.typesOf(F.id);
    expect(order).not.toContain('node:started');
    expect(order.indexOf('node:delivered')).toBeLessThan(order.indexOf('node:settled'));
    await app.close();
  });

  it("an abort() of an already-fired ancestor from a later-fired subscriber's listener waits for pass 2b: every signal of the delivery fires before the ancestor releases (DESIGN.md §2.4, §4.1)", async () => {
    const app = createRootContext();
    const t = trace();
    const A = app.child({ name: 'A' });
    const B1 = A.child({ name: 'B1' });
    const B2 = A.child({ name: 'B2' });
    A.own(() => t.push(`A released P; B2.signal.aborted=${B2.signal.aborted}`));
    B1.signal.addEventListener('abort', () => {
      t.push('B1 listener');
      A.abort(); // A was fired before B1; B2 is still to fire
    });
    B2.signal.addEventListener('abort', () => t.push('B2 listener'));
    A.abort('stop');
    expect(t.log).toEqual(['B1 listener', 'B2 listener', 'A released P; B2.signal.aborted=true']);
    expect([A.state, B1.state, B2.state]).toEqual(['complete', 'complete', 'complete']); // still synchronous (DESIGN.md §2.4)
    await app.close();
  });

  it("a close() of an already-fired observe ancestor from a later-fired restore subscriber's listener: the abort wins, and its freeze subscribers are interrupted (DESIGN.md §2.7, §4.1)", async () => {
    const app = createRootContext();
    const A = app.child({ name: 'A', interrupt: 'observe' });
    const R = A.child({ name: 'R', interrupt: 'restore' });
    const F = spawn(A, function* () {
      yield* here().never();
    });
    await tick(); // F is suspended on never(); A's delivery reaches it only through A's exit
    let closing: Promise<void> | undefined;
    R.signal.addEventListener('abort', () => {
      closing = A.close();
    });
    A.abort('stop');
    expect(closing).toBeDefined();
    expect(impl(A).exitKind).toBe('interrupt'); // not 'await': pass 2b exited A
    await closing;
    expect(F.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    expect(A.state).toBe('complete');
    await app.close();
  });

  it('observe forwards only to restore subscribers; freeze nodes in between pass it through unmarked', async () => {
    const app = createRootContext();
    const gate = deferred();
    const O = spawn(
      app,
      function* () {
        yield* wait(gate.promise);
      },
      { interrupt: 'observe' },
    );
    const F = O.child();
    const R = F.child({ interrupt: 'restore' });
    const F2 = R.child();
    await tick(); // started: an unstarted fiber would settle at abort (DESIGN.md §4.6)
    O.abort('stop');
    expect([impl(O).delivered, impl(F).delivered, impl(R).delivered, impl(F2).delivered]).toEqual([true, false, true, true]);
    expect([O.signal.aborted, F.signal.aborted, R.signal.aborted]).toEqual([true, false, true]);
    expect(impl(O).applied).toBe(false); // observe: delivered, not applied
    expect(impl(R).applied).toBe(true);
    gate.resolve();
    await app.close();
    expect(O.outcome?.status).toBe('success'); // observe: the body's own result
  });

  it("an observe node's own abort(), timeoutMs and linked signal always deliver to it", async () => {
    const app = createRootContext();
    const gates = [deferred(), deferred(), deferred()];
    const ac = new AbortController();
    const viaAbort = spawn(app, function* () { return yield* wait(gates[0].promise); }, { interrupt: 'observe' });
    const viaTimeout = spawn(app, function* () { return yield* wait(gates[1].promise); }, { interrupt: 'observe', timeoutMs: 5 });
    const viaSignal = spawn(app, function* () { return yield* wait(gates[2].promise); }, { interrupt: 'observe', signal: ac.signal });
    await tick(); // started: an unstarted fiber would settle at abort (DESIGN.md §4.6)
    viaAbort.abort('direct');
    ac.abort('linked');
    await new Promise((r) => setTimeout(r, 20));
    expect(viaAbort.signal.reason).toBe('direct');
    expect((viaTimeout.signal.reason as DOMException).name).toBe('TimeoutError');
    expect(viaSignal.signal.reason).toBe('linked');
    for (const g of gates) g.resolve();
    await app.close();
    for (const f of [viaAbort, viaTimeout, viaSignal]) expect(f.outcome?.status).toBe('success');
  });

  it('timeoutMs delivers a TimeoutError reason; a freeze body interrupted by it is aborted', async () => {
    const app = createRootContext();
    const f = spawn(
      app,
      function* () {
        yield* here().never();
      },
      { timeoutMs: 5 },
    );
    const o = await app.result(f);
    expect(o.status).toBe('aborted');
    const reason = (o as { reason: unknown }).reason as DOMException;
    expect(reason).toBeInstanceOf(DOMException);
    expect(reason.name).toBe('TimeoutError');
    await app.close();
  });

  it('millisecond options are checked at the call site: undefined, Infinity or [0, 2^31 - 1] (DESIGN.md §2.1)', async () => {
    const app = createRootContext();
    for (const k of ['timeoutMs', 'releaseTimeoutMs', 'stallWarningMs'] as const)
      for (const v of [-1, NaN, 2 ** 31, -Infinity, '5' as unknown as number]) {
        expect(() => app.child({ [k]: v }), `${k}: ${String(v)}`).toThrow(TypeError);
        expect(() => app.fork(task(function* () {}, { ...linked, [k]: v })), `fork ${k}: ${String(v)}`).toThrow(TypeError);
      }
    expect(() => createRootContext({ releaseTimeoutMs: -1 })).toThrow(TypeError);
    expect(() => app.pool({ name: 'p', onFailure: () => {}, timeoutMs: NaN })).toThrow(TypeError);
    expect(impl(app).explicit.size).toBe(0); // nothing was attached by a refused construction
    for (const v of [0, 1.5, 2 ** 31 - 1, Infinity]) expect(() => app.child({ timeoutMs: v }).abort()).not.toThrow();
    await app.close();
  });

  it('timeoutMs: Infinity arms no timer; it never delivers (DESIGN.md §2.1)', async () => {
    const app = createRootContext();
    const c = app.child({ timeoutMs: Infinity });
    const f = spawn(app, function* () { return yield* wait(new Promise<void>((r) => setTimeout(r, 30))); }, { timeoutMs: Infinity });
    expect(impl(c).timeoutTimer).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(c.signal.aborted).toBe(false);
    expect(f.signal.aborted).toBe(false);
    await app.join(f);
    expect(f.outcome?.status).toBe('success');
    await app.close();
  });

  it('releaseTimeoutMs: Infinity is no deadline, also over an inherited one; a fractional value is a deadline (DESIGN.md §2.1)', async () => {
    const app = createRootContext({ releaseTimeoutMs: Infinity });
    const signals: AbortSignal[] = [];
    app.own(() => void signals.push(here().signal)); // synchronous: close() must not throw
    const N = app.child({ releaseTimeoutMs: 1 }).child({ releaseTimeoutMs: Infinity });
    N.own(async () => {
      signals.push(here().signal);
      await new Promise((r) => setTimeout(r, 20));
    });
    await N.close();
    const F = app.child({ releaseTimeoutMs: 1.5 });
    let fired: boolean | undefined;
    F.own(function* () {
      yield* wait(new Promise((r) => setTimeout(r, 20)));
      fired = here().signal.aborted; // a generator release: its fiber is current at every step
    });
    await F.close();
    await expect(app.close()).resolves.toBeUndefined();
    expect(signals.map((s) => s.aborted)).toEqual([false, false]);
    expect(fired).toBe(true);
  });

  it('opts.signal delivers, and its listener is removed at completion', async () => {
    const app = createRootContext();
    const ac1 = new AbortController();
    const f1 = spawn(
      app,
      function* () {
        yield* here().never();
      },
      { signal: ac1.signal },
    );
    await tick();
    ac1.abort('go');
    expect(f1.signal.reason).toBe('go'); // delivered at once; the body unwinds from its rejected never() and completes later (D39)
    expect(await app.result(f1)).toEqual({ status: 'aborted', reason: 'go' });

    const ac2 = new AbortController();
    const remove = vi.spyOn(ac2.signal, 'removeEventListener');
    const f2 = spawn(app, function* () { return 1; }, { signal: ac2.signal });
    await app.join(f2);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    ac2.abort('late'); // nobody listens any more
    expect(f2.outcome?.status).toBe('success');
    await app.close();
  });

  describe('the birth rule under a delivered parent (D12)', () => {
    const modes = ['freeze', 'observe', 'restore'] as const;
    // delivered at birth iff the parent would have forwarded to it
    const expected: Record<(typeof modes)[number], Record<(typeof modes)[number], boolean>> = {
      freeze: { freeze: true, observe: false, restore: true },
      observe: { freeze: false, observe: false, restore: true },
      restore: { freeze: true, observe: false, restore: true },
    };
    for (const parentMode of modes)
      for (const childMode of modes)
        it(`parent ${parentMode} × child ${childMode} → ${expected[parentMode][childMode] ? 'delivered' : 'not delivered'}`, async () => {
          const app = createRootContext();
          const gate = deferred();
          const P = spawn(app, function* () { return yield* wait(gate.promise); }, { interrupt: parentMode }); // a bare await: delivery does not reject it
          await tick();
          P.abort('stop');
          expect(impl(P).delivered).toBe(true);
          const c = impl(P.child({ interrupt: childMode }));
          expect(c.delivered).toBe(expected[parentMode][childMode]);
          expect(c.signal.aborted).toBe(expected[parentMode][childMode]);
          if (c.delivered) expect(c.signal.reason).toBe('stop');
          gate.resolve();
          await app.close();
        });

    it('restore: delivered at birth when any ancestor is, even through an undelivered freeze node', async () => {
      const app = createRootContext();
      const gate = deferred();
      const O = spawn(app, function* () { return yield* wait(gate.promise); }, { interrupt: 'observe' });
      const F = O.child();
      await tick();
      O.abort('stop');
      expect(impl(F).delivered).toBe(false);
      expect(impl(F.child({ interrupt: 'restore' })).delivered).toBe(true);
      expect(impl(F.child()).delivered).toBe(false);
      gate.resolve();
      await app.close();
    });

    it('unsubscribed nodes are not delivered at birth: they hear at their turn (I4; D12)', async () => {
      const app = createRootContext();
      const gate = deferred();
      const P = spawn(app, function* () { return yield* wait(gate.promise); });
      await tick();
      P.abort('stop');
      const pool = impl(P.pool({ name: 'late', onFailure: () => {} }));
      expect(pool.delivered).toBe(false);
      gate.resolve();
      await app.close();
      expect(pool.delivered).toBe(true); // at its turn in P's release loop
    });

    it("restore: the walk follows subscription edges only, so a restore fiber in an undelivered pool is not delivered, forked before or after its owner's abort (I4; D12)", async () => {
      const app = createRootContext();
      const pool = impl(app.pool({ name: 'p', onFailure: () => {} }));
      const gate = deferred();
      app.own({}, () => gate.promise); // above the pool: app's loop waits here, so the pool's turn comes later
      const restore = task(
        function* () {
          yield* here().never();
        },
        { interrupt: 'restore' },
      );
      const R1 = impl(pool.fork(restore));
      await tick(); // R1 is suspended on never()
      app.abort('stop');
      expect(impl(app).delivered).toBe(true);
      const R2 = impl(pool.fork(restore)); // the pool still takes work: it has not heard yet
      await tick();
      expect([R1.delivered, R2.delivered, pool.delivered]).toEqual([false, false, false]); // the same, before or after
      gate.resolve();
      await app.close();
      expect([R1.delivered, R2.delivered, pool.delivered]).toEqual([true, true, true]); // at the pool's turn
      for (const R of [R1, R2]) expect(R.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    });
  });
});

// ---------------------------------------------------------------------------
describe('the halt (DESIGN.md §4.2, D39, D41)', () => {
  it('a body suspended on join(f) of a fiber not below it is halted at once: no catch runs, its finally does, and its node releases after the body has unwound', async () => {
    const t = trace();
    const app = createRootContext();
    const f = spawn(app, function* () {
      yield* here().never();
    });
    let B!: NodeImpl;
    let caught: unknown = 'no catch ran';
    const p = start(app.call(function* () {
      B = here();
      here().own(() => void t.push(`release:${t.log.includes('finally')}`));
      try {
        yield* here().join(f);
        t.push('after');
      } catch (e) {
        caught = e;
        throw e;
      } finally {
        t.push('finally');
      }
    }));
    await tick();
    B.abort('stop');
    expect(t.log).toEqual([]); // nothing inside abort(): the return is a queued job, and B completes after its body
    expect(B.state).toBe('running');
    await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
    expect(t.log).toEqual(['finally', 'release:true']);
    expect(caught).toBe('no catch ran');
    expect(B.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    f.abort();
    await app.close();
  });

  it('plain code between a halted wait(p) and the next yield* runs, and what it owns is released', async () => {
    const t = trace();
    const app = createRootContext();
    const gate = deferred();
    let B!: NodeImpl;
    const p = start(app.call(function* () {
      B = here();
      yield* wait(gate.promise); // the halt lets p finish (row 3)
      t.push('plain');
      here().own(t.at('late-own'));
      yield* here().never();
      t.push('after');
    }));
    await tick();
    B.abort();
    expect(t.log).toEqual([]);
    gate.resolve();
    await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
    expect(t.log).toEqual(['plain', 'late-own']);
    await app.close();
  });

  it('a stored, unyielded join runs nothing while the body waits on wait(p); yielded after the delivery, it is not started, and the body is returned there (D13′, D41)', async () => {
    const t = trace();
    const app = createRootContext();
    const f = spawn(app, function* () {
      yield* here().never();
    });
    const gate = deferred();
    let B!: NodeImpl;
    const p = start(app.call(function* () {
      B = here();
      const j = here().join(f);
      yield* wait(gate.promise); // the halt lets p finish
      t.push('resumed');
      yield* j; // returned here, without running it
      t.push('after');
    }));
    await tick();
    B.abort();
    expect(B.bodyDone).toBe(false); // a wait(p) the halt lets finish: the body runs on
    gate.resolve();
    await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
    expect(t.log).toEqual(['resumed']);
    expect(B.outcome?.status).toBe('aborted');
    f.abort();
    await app.close();
  });

  describe('Promise combinators over ops, pinned with a real node (DESIGN.md §4.2)', () => {
    it("Promise.allSettled([join(f1), join(f2)]) runs both joins through their then, which nothing halts: f1 failed, the owner aborted while f2 runs, and both outcomes reach the body, f1's failure as its rejection and f2's abort as FiberAbortedError", async () => {
      const app = createRootContext();
      let B!: NodeImpl;
      let f1!: NodeImpl;
      let seen: PromiseSettledResult<unknown>[] | undefined;
      const p = start(app.call(function* () {
        B = here();
        f1 = impl(
          here().fork(function* () {
            throw new Error('f1');
          }),
        );
        const f2 = here().fork(function* () {
          yield* here().never();
        });
        seen = yield* wait(Promise.allSettled([here().join(f1 as unknown as Fiber<unknown>), here().join(f2)]));
      }));
      await tick();
      expect(f1.outcome?.status).toBe('defect');
      B.abort('stop');
      await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
      expect(B.outcome?.status).toBe('aborted');
      expect(seen?.map((s) => s.status)).toEqual(['rejected', 'rejected']);
      expect(((seen![0] as PromiseRejectedResult).reason as Error).message).toBe('f1'); // consumed by a delivery the body saw
      expect((seen![1] as PromiseRejectedResult).reason).toBeInstanceOf(FiberAbortedError); // f2, a subscriber, was aborted with B
      expect(f1.failure?.consumed).toBe(true);
      await expect(app.close()).resolves.toBeUndefined();
    });

    it('the loser of Promise.race([join(f1), join(f2)]) is a then subscription that no halt touches: it adds no hook to the body, the body runs on through a halted wait(p), and the node completes after the body', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const t = trace();
      const app = createRootContext();
      const f1 = spawn(app, function* () { return 1; });
      const f2 = spawn(app, function* () {
        yield* here().never();
      });
      const gate = deferred();
      const sizes: number[] = [];
      let B!: NodeImpl;
      const p = start(app.call(function* () {
        B = here();
        yield* wait(Promise.race([here().join(f1), here().join(f2)]));
        sizes.push(B.onApplied.size); // in a step: no hook; the loser's then is no wait of this body
        yield* wait(gate.promise); // the halt lets p finish
        t.push('resumed');
        return 'done';
      }));
      await tick();
      sizes.push(B.onApplied.size); // the hook of the wait(p) in flight
      B.abort();
      sizes.push(B.onApplied.size); // fire() ran it
      expect(B.bodyDone).toBe(false);
      gate.resolve();
      await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
      expect(t.log).toEqual(['resumed']);
      expect(sizes).toEqual([0, 1, 0]);
      expect(B.outcome?.status).toBe('aborted');
      expect(warn).not.toHaveBeenCalled();
      f2.abort();
      await app.close();
    });

    it('yield* wait(Promise.all([call(a), a foreign promise rejected by the signal])): the call runs through its then as a child of the body; the rejection after the halt returns the body, no catch runs, and the node completes after its call child (DESIGN.md §4.2)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const t = trace();
      const app = createRootContext();
      let B!: NodeImpl;
      let A!: NodeImpl;
      const p = start(app.call(function* () {
        B = here();
        const sig = here().signal;
        const fetchLike = new Promise((_, reject) => sig.addEventListener('abort', () => reject(new Error('aborted fetch'))));
        try {
          yield* wait(Promise.all([
            here().call(function* () {
              A = here();
              yield* here().never();
            }),
            fetchLike,
          ]));
        } catch (e) {
          t.push(`caught ${(e as Error).message}`);
        }
        return 'done';
      }));
      await tick();
      B.abort();
      await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
      expect(t.log).toEqual([]); // returned at the failure of a wait(p) the halt let finish (row 3), never thrown in
      expect(A.state).toBe('complete'); // B waited for its call child before completing (D21)
      expect(warn).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('interrupted() of a node other than the awaiting body (DESIGN.md §4.2)', () => {
    it("a freeze body awaiting another node's interrupt wakes with its reason: delivered before the await, or during it", async () => {
      const app = createRootContext();
      // Delivered before the await: c is still releasing behind a slow entry when the body asks.
      const c = app.child({ name: 'c' });
      const hold = deferred();
      c.own(() => hold.promise);
      c.abort('done');
      expect(c.state).toBe('releasing');
      const early = await app.call(function* () {
        const reason = yield* c.interrupted();
        return reason;
      });
      expect(early).toBe('done');
      hold.resolve();
      // Delivered during the await: from a call child, and from a subscribed fork that app.close() waits for.
      const other = app.child({ name: 'other' });
      const called = start(app.call(function* () {
        const reason = yield* other.interrupted();
        return `woke: ${String(reason)}`;
      }));
      let forkHeard: unknown;
      const forked = spawn(app, function* () {
        forkHeard = yield* other.interrupted();
      });
      await tick(); // both bodies are suspended on other.interrupted(); neither is delivered
      other.abort('stop');
      expect(await called).toBe('woke: stop');
      await app.join(forked);
      expect(forkHeard).toBe('stop');
      expect(forked.outcome?.status).toBe('success');
      await app.close();
    });

    it("an owned reaper awaiting its owner's interrupt wakes at the owner's delivery, before its own turn behind a slow entry (DESIGN.md §2.2)", async () => {
      const app = createRootContext();
      const svc = app.child({ name: 'svc' });
      const t = trace();
      const reaper = svc.own(
        svc.fork(
          task(function* () {
            const reason = yield* svc.interrupted();
            t.push(`reaper woke: ${String(reason)}`);
          }, linked),
        ),
      );
      const slow = deferred();
      svc.own(async function slowEntry() {
        t.push('slow entry');
        await slow.promise;
      });
      await tick(); // the reaper is suspended on svc.interrupted()
      svc.abort('stop');
      expect(impl(reaper).delivered).toBe(false); // unsubscribed: it is not delivered before its turn (I4)
      await tick();
      expect(t.log).toEqual(['slow entry', 'reaper woke: stop']); // but its await on svc's signal settles now
      expect(reaper.outcome?.status).toBe('success'); // it finished on its own: never aborted at its turn
      slow.resolve();
      await app.close();
      expect(svc.state).toBe('complete');
    });
  });

  it('an observe body is never halted: its waits settle after delivery and it finishes on its own', async () => {
    const app = createRootContext();
    const f = spawn(
      app,
      function* () {
        const reason = yield* here().interrupted();
        const v = yield* here().call(function* () { return 7; }); // a freeze child under a delivered observe parent: not delivered at birth
        return [reason, v];
      },
      { interrupt: 'observe' },
    );
    await tick();
    f.abort('stop');
    expect(await app.join(f)).toEqual(['stop', 7]);
    expect(f.outcome?.status).toBe('success');
    await app.close();
  });
});
