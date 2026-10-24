// node-core.test.ts — anatomy, delivery, sticky rejection, the release loop, release
// fibers, C1–C8, the lifecycle table and the use-after-release table
// (DESIGN.md §2.7), run/runSync, unstarted fibers, stall.
//
// `here()` is a `current()` that throws; this suite uses the method form on it,
// which is what the free functions are (DESIGN.md §6).
import { afterEach, describe, expect, it, vi } from 'vitest';
import './node.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber } from './context.js';
import { currentFrame } from './context-storage.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import type { NodeImpl } from './node-impl.js';
import { factoryProvider, valueProvider } from './provider-util.js';
import { inject } from './inject.js';
import { NodeTopic } from './lifecycle-events.js';
import type { NodeEvent } from './lifecycle-events.js';
import {
  AlreadyOwnedError,
  AsyncRunError,
  CreationViolationError,
  FiberAbortedError,
  FiberNotAwaitableError,
  InterruptedError,
  NodeCompletedError,
  NotOwnedError,
  OwnerInterrupt,
  PendingNodeError,
} from './resource.js';
import { RootScope } from './scope.js';
import { deferred, events, here, impl, micro, tick, trace } from './test/util.js';

/** A fiber forked onto a bodiless node needs a destination other than 'join' (D14); 'link' surfaces failures. */
const linked = { onFailure: 'link' } as const;

/** Fork a body onto a bodiless node with the 'link' destination. */
function spawn<T>(on: Context, body: () => Promise<T> | T, opts: Parameters<typeof task>[1] = {}): Fiber<T> {
  return on.fork(task(body, { ...linked, ...opts }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('anatomy', () => {
  it('ids are unique across every node kind', async () => {
    const V = createInjectionKey<object>('V');
    const ev = events({
      providers: [
        factoryProvider(V, () => {
          here(); // materialises the value's node (DESIGN.md §3.3)
          return {};
        }),
      ],
    });
    const app = ev.root;
    app.child();
    app.pool({ name: 'p', onFailure: () => {} });
    await app.call(async () => {
      here().own(() => {}); // a release fiber at the fiber's completion
      app.get(V);
    });
    await app.close();
    const created = ev.of('node:created');
    const ids = created.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(created.map((e) => e.kind))).toEqual(new Set(['context', 'pool', 'fiber', 'release', 'value']));
  });

  it('state runs running → settling → releasing → complete', async () => {
    const seen: string[] = [];
    const app = createRootContext();
    let F!: NodeImpl;
    await app.call(async () => {
      F = here();
      here().own(() => void seen.push(`release:${F.state}`));
      const g = here().fork(async () => {
        await here().never();
      });
      g.signal.addEventListener('abort', () => void seen.push(`interrupt:${F.state}`));
      seen.push(`body:${F.state}`);
      await tick();
    });
    seen.push(`after:${F.state}`);
    expect(seen).toEqual(['body:running', 'interrupt:settling', 'release:releasing', 'after:complete']);
    await app.close();
  });

  it('scopes is a read-only view: the root carries RootScope; scope-less nodes share one empty set', async () => {
    const app = createRootContext();
    expect(app.scopes.has(RootScope)).toBe(true);
    const a = app.child();
    const b = app.child();
    expect(a.scopes.size).toBe(0);
    expect(a.scopes).toBe(b.scopes);
    await app.close();
  });

  it('child() is a subscribed explicit entry; pool() is an unsubscribed explicit entry', async () => {
    const app = createRootContext();
    const c = impl(app.child());
    const p = impl(app.pool({ name: 'p', onFailure: () => {} }));
    const root = impl(app);
    expect(c.subscribed).toBe(true);
    expect(root.subscribers.has(c)).toBe(true);
    expect(c.entryOnOwner?.stack).toBe(root.explicit);
    expect(p.subscribed).toBe(false);
    expect(root.subscribers.has(p)).toBe(false);
    expect(p.entryOnOwner?.stack).toBe(root.explicit);
    expect(c.kind).toBe('context');
    expect(p.kind).toBe('pool');
    await app.close();
  });
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
    const B = spawn(app, async () => {
      await here().never();
    });
    const C = app.child();
    await tick(); // B is suspended on never()
    let born: NodeImpl | undefined;
    A.signal.addEventListener('abort', () => {
      born = impl(B.fork(async () => {})); // B is a fiber: 'join' is allowed
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
        async () => {
          F = here().fork(() => void (ran = true)); // not started: its start microtask is queued
          here().signal.addEventListener('abort', () => F.abort());
          here().abort(); // from P's own plain code: P's body is running, so P's loop does not reach F yet
          afterAbort = F.outcome?.status; // settled in pass 2b, after its signal fired
          await here().never();
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
    const F = spawn(A, async () => {
      await here().never();
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
      async () => {
        await gate.promise;
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
    const viaAbort = spawn(app, () => gates[0].promise, { interrupt: 'observe' });
    const viaTimeout = spawn(app, () => gates[1].promise, { interrupt: 'observe', timeoutMs: 5 });
    const viaSignal = spawn(app, () => gates[2].promise, { interrupt: 'observe', signal: ac.signal });
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
      async () => {
        await here().never();
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
        expect(() => app.fork(task(async () => {}, { ...linked, [k]: v })), `fork ${k}: ${String(v)}`).toThrow(TypeError);
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
    const f = spawn(app, () => new Promise<void>((r) => setTimeout(r, 30)), { timeoutMs: Infinity });
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
    F.own(async () => {
      await new Promise((r) => setTimeout(r, 20));
      fired = here().signal.aborted;
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
      async () => {
        await here().never();
      },
      { signal: ac1.signal },
    );
    await tick();
    ac1.abort('go');
    expect(f1.signal.reason).toBe('go'); // delivered at once; the body unwinds from its rejected never() and completes later (D39)
    expect(await app.result(f1)).toEqual({ status: 'aborted', reason: 'go' });

    const ac2 = new AbortController();
    const remove = vi.spyOn(ac2.signal, 'removeEventListener');
    const f2 = spawn(app, async () => 1, { signal: ac2.signal });
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
          const P = spawn(app, () => gate.promise, { interrupt: parentMode }); // a bare await: delivery does not reject it
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
      const O = spawn(app, () => gate.promise, { interrupt: 'observe' });
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
      const P = spawn(app, () => gate.promise);
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
        async () => {
          await here().never();
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
describe('sticky rejection (DESIGN.md §4.2, D39)', () => {
  it('a body suspended on join(f) is rejected with InterruptedError, runs its finally, and its node releases after the body has unwound', async () => {
    const t = trace();
    const app = createRootContext();
    const f = spawn(app, async () => {
      await here().never();
    });
    let B!: NodeImpl;
    let caught: unknown;
    const p = app.call(async () => {
      B = here();
      here().own(() => void t.push(`release:${t.log.includes('finally')}`));
      try {
        await here().join(f);
        t.push('after');
      } catch (e) {
        caught = e;
        throw e;
      } finally {
        t.push('finally');
      }
    });
    await tick();
    B.abort('stop');
    expect(t.log).toEqual([]); // nothing inside abort(): the rejection is a queued job, and B completes after its body
    expect(B.state).toBe('running');
    await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
    expect(t.log).toEqual(['finally', 'release:true']);
    expect(caught).toBeInstanceOf(InterruptedError);
    expect((caught as InterruptedError).reason).toBe('stop');
    expect(B.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    f.abort();
    await app.close();
  });

  it('plain code between delivery and the next managed await runs, and what it owns is released', async () => {
    const t = trace();
    const app = createRootContext();
    const gate = deferred();
    let B!: NodeImpl;
    const p = app.call(async () => {
      B = here();
      await gate.promise; // bare
      t.push('plain');
      here().own(t.at('late-own'));
      await here().never();
      t.push('after');
    });
    await tick();
    B.abort();
    expect(t.log).toEqual([]);
    gate.resolve();
    await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
    expect(t.log).toEqual(['plain', 'late-own']);
    await app.close();
  });

  it('a stored, unawaited managed promise is not rejected while the body is in a bare await; awaiting it later rejects (D13, D39)', async () => {
    const t = trace();
    const app = createRootContext();
    const f = spawn(app, async () => {
      await here().never();
    });
    const gate = deferred();
    let B!: NodeImpl;
    const p = app.call(async () => {
      B = here();
      const j = here().join(f);
      await gate.promise; // bare
      t.push('resumed');
      await j;
      t.push('after');
    });
    await tick();
    B.abort();
    expect(B.bodyDone).toBe(false); // nothing awaited j yet: the body runs on
    gate.resolve();
    await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
    expect(t.log).toEqual(['resumed']);
    expect(B.outcome?.status).toBe('aborted');
    f.abort();
    await app.close();
  });

  it('after delivery, p.catch() on a stored join(f) does not release anything inside the body\'s synchronous code (DESIGN.md §4.4)', async () => {
    const t = trace();
    const app = createRootContext();
    const f = spawn(app, async () => {
      await here().never();
    });
    const gate = deferred();
    let B!: NodeImpl;
    let ownError: unknown;
    const p = app.call(async () => {
      B = here();
      const j = here().join(f);
      await gate.promise; // delivered meanwhile
      j.catch(() => {});
      try {
        here().own(t.at('conn released'));
        t.push(`conn owned, released so far: ${t.log.length}`);
      } catch (e) {
        ownError = e;
      }
      await here().never();
    });
    await tick();
    B.abort();
    gate.resolve();
    await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
    expect(ownError).toBeUndefined();
    expect(t.log).toEqual(['conn owned, released so far: 0', 'conn released']);
    f.abort();
    await app.close();
  });

  describe('combinators and stored wrappers, pinned with a real node (DESIGN.md §4.2, §4.4)', () => {
    it("Promise.allSettled([join(f1), join(f2)]): f1 failed, the owner aborted while f2 runs — both outcomes reach the body, f1's failure as its rejection (D39)", async () => {
      const app = createRootContext();
      let B!: NodeImpl;
      let f1!: NodeImpl;
      let seen: PromiseSettledResult<unknown>[] | undefined;
      const p = app.call(async () => {
        B = here();
        f1 = impl(
          here().fork(async () => {
            throw new Error('f1');
          }),
        );
        const f2 = here().fork(async () => {
          await here().never();
        });
        seen = await Promise.allSettled([here().join(f1 as unknown as Fiber<unknown>), here().join(f2)]);
      });
      await tick();
      expect(f1.outcome?.status).toBe('failure');
      B.abort('stop');
      await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
      expect(B.outcome?.status).toBe('aborted');
      expect(seen?.map((s) => s.status)).toEqual(['rejected', 'rejected']);
      expect(((seen![0] as PromiseRejectedResult).reason as Error).message).toBe('f1'); // consumed by a delivery the body saw
      expect((seen![1] as PromiseRejectedResult).reason).toBeInstanceOf(InterruptedError);
      expect(f1.failure?.consumed).toBe(true);
      await expect(app.close()).resolves.toBeUndefined();
    });

    it('a .catch attached to a stored wrapper before delivery, then a bare await: the delivery rejects into the .catch, and the node completes after the body returns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const t = trace();
      const app = createRootContext();
      const f = spawn(app, async () => {
        await here().never();
      });
      const gate = deferred();
      let B!: NodeImpl;
      const p = app.call(async () => {
        B = here();
        here().own(t.at('released'));
        const j = here().join(f);
        j.catch((e: unknown) => t.push(`catch: ${(e as Error).name}`)); // arms the await
        await gate.promise; // bare
        t.push('resumed');
        return 'done';
      });
      await tick();
      B.abort();
      expect(B.bodyDone).toBe(false); // the body is running plain code: nothing settles it
      await tick();
      expect(t.log).toEqual(['catch: InterruptedError']);
      gate.resolve();
      await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
      expect(t.log).toEqual(['catch: InterruptedError', 'resumed', 'released']);
      expect(warn).not.toHaveBeenCalled();
      expect(B.outcome?.status).toBe('aborted'); // by state: the return value is discarded (D24)
      f.abort();
      await app.close();
    });

    it('a managed promise awaited by another body: dev mode reports the foreign awaiter (DESIGN.md §4.4)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const app = createRootContext();
      const f = spawn(app, async () => 7);
      let wrapper!: Promise<number>;
      const creator = spawn(app, async () => {
        wrapper = here().join(f) as Promise<number>; // created in `creator`'s body, targeted at it
        await here().never();
      });
      await tick();
      const awaiter = spawn(app, async () => wrapper); // another body awaits it
      expect(await app.join(awaiter)).toBe(7);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/is awaited by fiber/));
      creator.abort();
      await app.close();
    });

    it('the loser of await Promise.race([join(f1), join(f2)]) stays armed; a delivery during a later bare await rejects it into the settled race, and the node completes after the body (DESIGN.md §4.2)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const t = trace();
      const app = createRootContext();
      const f1 = spawn(app, async () => 1);
      const f2 = spawn(app, async () => {
        await here().never();
      });
      const gate = deferred();
      let B!: NodeImpl;
      const p = app.call(async () => {
        B = here();
        await Promise.race([here().join(f1), here().join(f2)]);
        expect(B.onApplied.size).toBe(1); // the loser's await is still armed
        await gate.promise; // bare
        t.push('resumed');
        return 'done';
      });
      await tick();
      B.abort();
      expect(B.onApplied.size).toBe(0); // rejected into the race, which ignores it
      expect(B.bodyDone).toBe(false);
      gate.resolve();
      await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
      expect(t.log).toEqual(['resumed']);
      expect(B.outcome?.status).toBe('aborted');
      expect(warn).not.toHaveBeenCalled();
      f2.abort();
      await app.close();
    });

    it('await Promise.all([call(a), a bare promise rejected by the signal]): the bare rejection reaches the catch at once, and the node completes after its call child (DESIGN.md §4.2)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const t = trace();
      const app = createRootContext();
      let B!: NodeImpl;
      let A!: NodeImpl;
      const p = app.call(async () => {
        B = here();
        const sig = here().signal;
        const fetchLike = new Promise((_, reject) => sig.addEventListener('abort', () => reject(new Error('aborted fetch'))));
        try {
          await Promise.all([
            here().call(async () => {
              A = here();
              await here().never();
            }),
            fetchLike,
          ]);
        } catch (e) {
          t.push(`caught ${(e as Error).message}`);
        }
        return 'done';
      });
      await tick();
      B.abort();
      await expect(p).rejects.toBeInstanceOf(FiberAbortedError);
      expect(t.log).toEqual(['caught aborted fetch']);
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
      const early = await app.call(async () => {
        const reason = await c.interrupted();
        return reason;
      });
      expect(early).toBe('done');
      hold.resolve();
      // Delivered during the await: from a call child, and from a subscribed fork that app.close() waits for.
      const other = app.child({ name: 'other' });
      const called = app.call(async () => {
        const reason = await other.interrupted();
        return `woke: ${String(reason)}`;
      });
      let forkHeard: unknown;
      const forked = spawn(app, async () => {
        forkHeard = await other.interrupted();
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
          task(async () => {
            const reason = await svc.interrupted();
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

  it('an observe body settles its managed awaits after delivery and finishes on its own', async () => {
    const app = createRootContext();
    const f = spawn(
      app,
      async () => {
        const reason = await here().interrupted();
        const v = await here().call(async () => 7); // a freeze child under a delivered observe parent: not delivered at birth
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

// ---------------------------------------------------------------------------
describe('the release loop (DESIGN.md §2.4)', () => {
  it('explicit LIFO, then provided LIFO (I3, I5)', async () => {
    const t = trace();
    const K1 = createInjectionKey<object>('K1');
    const K2 = createInjectionKey<object>('K2');
    const app = createRootContext({
      providers: [
        factoryProvider(K1, () => here().own({}, () => t.push('K1'))),
        factoryProvider(K2, () => here().own({}, () => t.push('K2'))),
      ],
    });
    app.get(K1);
    app.own(t.at('a'));
    app.get(K2);
    app.own(t.at('b'));
    await app.close();
    expect(t.log).toEqual(['b', 'a', 'K2', 'K1']);
  });

  it('a release that own()s onto its owner has that entry released next (C2, DESIGN.md §2.4)', async () => {
    const t = trace();
    const app = createRootContext();
    app.own(t.at('first'));
    app.own(() => {
      t.push('second');
      app.own(t.at('pushed during release'));
    });
    await app.close();
    expect(t.log).toEqual(['second', 'pushed during release', 'first']);
  });

  it('an own() from the microtask drain after the last async release is released or refused, never left live on a complete node (I7)', async () => {
    const app = createRootContext();
    const N = impl(app.child());
    N.own(async () => {
      await micro();
    });
    const results: string[] = [];
    let chain = Promise.resolve();
    for (let i = 0; i < 16; i++)
      chain = chain.then(() => {
        try {
          N.own({ [Symbol.dispose]: () => void (results[i] = 'released') });
          results[i] = 'owned';
        } catch (e) {
          results[i] = e instanceof NodeCompletedError ? 'refused' : `other: ${String(e)}`;
        }
      });
    await N.close();
    await chain;
    await tick();
    expect(results.every((r) => r === 'released' || r === 'refused')).toBe(true);
    expect(results).toContain('released');
    expect(results).toContain('refused');
    expect(N.explicit.size).toBe(0);
    await app.close();
  });

  it("a release fiber's lookup that creates a value during the provided phase has it released before older provided values", async () => {
    const t = trace();
    const OLD = createInjectionKey<object>('OLD');
    const A = createInjectionKey<object>('A');
    const LATE = createInjectionKey<object>('LATE');
    const app = createRootContext({
      providers: [
        factoryProvider(OLD, () => here().own({}, () => t.push('OLD'))),
        factoryProvider(A, () =>
          here().own({}, () => {
            t.push('A');
            here().get(LATE); // the release fiber resolves through the releasing owner (DESIGN.md §3.3)
          }),
        ),
        factoryProvider(LATE, () => here().own({}, () => t.push('LATE'))),
      ],
    });
    app.get(OLD);
    app.get(A);
    await app.close();
    expect(t.log).toEqual(['A', 'LATE', 'OLD']);
  });

  it('a value created during the explicit phase is released at the top of the provided phase (I3)', async () => {
    const t = trace();
    const OLD = createInjectionKey<object>('OLD');
    const NEW = createInjectionKey<object>('NEW');
    const app = createRootContext({
      providers: [
        factoryProvider(OLD, () => here().own({}, () => t.push('OLD'))),
        factoryProvider(NEW, () => here().own({}, () => t.push('NEW'))),
      ],
    });
    app.get(OLD);
    app.own(() => {
      t.push('explicit');
      here().get(NEW);
    });
    await app.close();
    expect(t.log).toEqual(['explicit', 'NEW', 'OLD']);
  });

  for (const [label, kinds] of [
    ['sync-only', ['s', 's', 's']],
    ['async-only', ['a', 'a', 'a']],
    ['mixed', ['s', 'a', 's', 'a']],
  ] as const)
    it(`${label} stacks release in reverse order`, async () => {
      const t = trace();
      const app = createRootContext();
      kinds.forEach((k, i) =>
        app.own(
          k === 's'
            ? t.at(`${i}`)
            : async () => {
                await tick();
                t.push(`${i}`);
              },
        ),
      );
      await app.close();
      expect(t.log).toEqual(kinds.map((_, i) => `${i}`).reverse());
    });

  it('synchronous releases complete synchronously inside abort(), nested child() and unstarted fiber entries included (DESIGN.md §2.4)', async () => {
    const t = trace();
    const app = createRootContext();
    const outer = app.child();
    outer.own(t.at('outer-1'));
    const inner = outer.child();
    inner.own(t.at('inner-1'));
    const deeper = inner.child();
    deeper.own(t.at('deeper-1'));
    const unstarted = outer.fork(
      task(
        () => {
          t.push('never runs');
        },
        linked,
      ),
    );
    unstarted.own(t.at('fiber-own')); // attached on behalf of the fiber before it starts
    outer.own(t.at('outer-2'));
    outer.abort();
    expect(outer.state).toBe('complete'); // no microtask was needed
    expect(t.log).toEqual(['outer-2', 'fiber-own', 'deeper-1', 'inner-1', 'outer-1']);
    expect(unstarted.outcome?.status).toBe('aborted');
    await app.close();
  });

  it('releaseAll() racing release(x) on one entry runs that release once, and both settle (D16)', async () => {
    const app = createRootContext();
    let n = 0;
    const d = deferred();
    const x = app.own({}, async () => {
      n++;
      await d.promise;
    });
    const p1 = app.release(x);
    const p2 = app.releaseAll();
    d.resolve();
    await p1;
    await p2;
    expect(n).toBe(1);
    await app.close();
    expect(n).toBe(1);
  });

  it('an abort() arriving in the middle of a releaseAll() runs every release once (D16)', async () => {
    const ev = events();
    const N = ev.root.child({ name: 'N' });
    const counts = { a: 0, b: 0, c: 0 };
    const gates = { a: deferred(), b: deferred(), c: deferred() };
    for (const k of ['a', 'b', 'c'] as const)
      N.own({ name: k }, async () => {
        counts[k]++;
        await gates[k].promise;
      });
    const all = N.releaseAll(); // starts c
    await micro();
    N.abort(); // N's loop finds c releasing and waits on it
    gates.c.resolve();
    await tick();
    gates.b.resolve();
    await tick();
    gates.a.resolve();
    await all;
    await N.close();
    expect(counts).toEqual({ a: 1, b: 1, c: 1 });
    expect(ev.of('entry:released').filter((e) => e.id === N.id)).toHaveLength(3);
    await ev.root.close();
  });

  it('a release that synchronously calls owner.abort() does not throw, and the owner completes (e.done exists first, D16)', async () => {
    const app = createRootContext();
    const N = app.child();
    const x = N.own({}, () => N.abort());
    await N.release(x);
    await tick();
    expect(N.state).toBe('complete');
    await app.close();
  });
});

describe('release errors that String() cannot convert (DESIGN.md §2.4, I2, I10)', () => {
  const unprintable = (): unknown[] => [
    Object.create(null),
    {
      toString(): string {
        throw new Error('no toString');
      },
    },
  ];
  for (const asyncRelease of [false, true])
    for (const withReceiver of [false, true])
      it(`${asyncRelease ? 'an async' : 'a sync'} release that throws one still finishes ${withReceiver ? 'with' : 'without'} a receiver: abort() returns, the owner completes, the error surfaces`, async () => {
        for (const bad of unprintable()) {
          const ev = withReceiver ? events() : undefined;
          const app = ev?.root ?? createRootContext();
          const c = app.child({ name: 'c' });
          c.own(
            asyncRelease
              ? async () => {
                  await null;
                  throw bad;
                }
              : () => {
                  throw bad;
                },
          );
          expect(() => c.abort()).not.toThrow();
          await tick();
          expect(c.state).toBe('complete');
          expect(c.outcome?.status).toBe('failure');
          expect((c.outcome as { error: unknown }).error).toBe(bad);
          if (ev !== undefined) expect(ev.of('entry:released').find((e) => e.id === c.id)?.error).toBe('[object Object]');
          await expect(app.close()).rejects.toBe(bad);
        }
      });
});

// ---------------------------------------------------------------------------
describe('release fibers (DESIGN.md §2.4, I14)', () => {
  it('own(x, release), own({[Symbol.asyncDispose]}) and own(fn) run in a release fiber: current, child of the owner, its own deadline, owner.outcome readable', async () => {
    const OWNER = createInjectionKey<string>('OWNER');
    const app = createRootContext();
    const N = app.child({ providers: [valueProvider(OWNER, 'N')], releaseTimeoutMs: 15 });
    const seen: Record<string, unknown>[] = [];
    const probe = async (label: string): Promise<void> => {
      const rf = here();
      const row: Record<string, unknown> = {
        label,
        kind: rf.kind,
        parentIsOwner: rf.parent === impl(N),
        lookup: rf.get(OWNER),
        ownerOutcome: N.outcome?.status,
        freshSignal: rf.signal !== N.signal && !rf.signal.aborted,
      };
      await new Promise((r) => setTimeout(r, 40));
      row.deadlineFired = rf.signal.aborted && (rf.signal.reason as DOMException).name === 'TimeoutError';
      seen.push(row);
    };
    N.own({}, () => probe('pair'));
    N.own({ [Symbol.asyncDispose]: () => probe('asyncDispose') });
    N.own(() => probe('defer'));
    await N.close();
    const expected = { kind: 'release', parentIsOwner: true, lookup: 'N', ownerOutcome: 'success', freshSignal: true, deadlineFired: true };
    expect(seen).toEqual([
      { label: 'defer', ...expected },
      { label: 'asyncDispose', ...expected },
      { label: 'pair', ...expected },
    ]);
    await app.close();
  });

  it("what a release owns is released when the release finishes, before the outer entry's entry:released", async () => {
    const ev = events();
    const N = ev.root.child({ name: 'N' });
    N.own(function outerRelease() {
      here().own(function innerRelease() {});
    });
    await N.close();
    const released = ev.of('entry:released').map((e) => e.entryName);
    expect(released.indexOf('innerRelease')).toBeGreaterThanOrEqual(0);
    expect(released.indexOf('innerRelease')).toBeLessThan(released.indexOf('outerRelease'));
    await ev.root.close();
  });
});

// ---------------------------------------------------------------------------
describe('ownership contracts (DESIGN.md §2.6)', () => {
  it('C1: own is synchronous — the entry exists before own returns; a value without a dispose protocol throws at the call', async () => {
    const app = createRootContext();
    const x = { [Symbol.dispose]() {} };
    expect(app.own(x)).toBe(x);
    expect(impl(app).explicit.find(x)).toBeDefined();
    expect(() => app.own({} as Disposable)).toThrow(TypeError);
    expect(() => app.own(42 as unknown as Disposable)).toThrow(TypeError);
    await app.close();
  });

  it('C2: own on a delivered but incomplete node succeeds; the entry is released at completion', async () => {
    const t = trace();
    const app = createRootContext();
    const gate = deferred();
    const f = spawn(app, () => gate.promise);
    await tick();
    f.abort();
    f.own(t.at('late'));
    expect(t.log).toEqual([]);
    gate.resolve();
    await app.close();
    expect(t.log).toEqual(['late']);
  });

  it('C3: own on a complete node throws NodeCompletedError', async () => {
    const app = createRootContext();
    const c = app.child();
    await c.close();
    expect(() => c.own(() => {})).toThrow(NodeCompletedError);
    await app.close();
  });

  it('C4: one release per entry, in a release fiber, after everything above it; provided entries after the whole explicit stack', async () => {
    const t = trace();
    const P = createInjectionKey<object>('P');
    const app = createRootContext({ providers: [factoryProvider(P, () => here().own({}, () => t.push(`P:${here().kind}`)))] });
    app.get(P);
    app.own(() => void t.push(`low:${here().kind}`));
    app.own(() => void t.push(`high:${here().kind}`));
    await app.close();
    await app.close();
    expect(t.log).toEqual(['high:release', 'low:release', 'P:release']);
  });

  it('C5: an owned fiber that fails while its owner is open aborts the owner; one that succeeds is removed', async () => {
    const app = createRootContext();
    const gate = deferred();
    let ownerNode!: NodeImpl;
    let ok!: NodeImpl;
    const p = app.call(async () => {
      ownerNode = here();
      ok = impl(here().own(here().fork(async () => 'ok')));
      await tick();
      expect(ok.state).toBe('complete');
      expect(ownerNode.explicit.find(ok)).toBeUndefined(); // removed
      here().own(
        here().fork(async () => {
          await gate.promise;
          throw new Error('owned failed');
        }),
      );
      await here().never();
    });
    await tick();
    gate.resolve();
    await expect(p).rejects.toThrow('owned failed'); // aborted, then the failure surfaced (DESIGN.md §4.12, C5)
    expect(ownerNode.signal.aborted).toBe(true);
    await app.close();
  });

  it('C6: a release that throws does not stop the remaining releases', async () => {
    const t = trace();
    const app = createRootContext();
    app.own(t.at('first'));
    app.own(() => {
      throw new Error('bad release');
    });
    app.own(t.at('third'));
    await expect(app.close()).rejects.toThrow('bad release');
    expect(t.log).toEqual(['third', 'first']);
  });

  it('C7: release(x) runs the release now, exactly once; concurrent calls share one promise; release of a stranger throws NotOwnedError', async () => {
    const app = createRootContext();
    let n = 0;
    const d = deferred();
    const x = app.own({}, async () => {
      n++;
      await d.promise;
    });
    const p1 = app.release(x);
    expect(n).toBe(1); // now
    const p2 = app.release(x);
    d.resolve();
    await Promise.all([p1, p2]);
    expect(n).toBe(1);
    expect(() => app.release(x)).toThrow(NotOwnedError); // released: no longer owned
    expect(() => app.release({})).toThrow(NotOwnedError);
    for (const v of [null, undefined, 5, 'x']) expect(() => app.release(v as never), String(v)).toThrow(NotOwnedError);
    await app.close();
  });

  it('C8: a second release for one object throws AlreadyOwnedError; own(x) with one argument on an owned x is a no-op (D16)', async () => {
    const app = createRootContext();
    let n = 0;
    const x = { [Symbol.dispose]: () => void n++ };
    app.own(x);
    expect(app.own(x)).toBe(x);
    expect(impl(app).explicit.size).toBe(1);
    expect(() => app.own(x, () => {})).toThrow(AlreadyOwnedError);
    await app.close();
    expect(n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the lifecycle table (DESIGN.md §2.7)', () => {
  it('abort() delivers the signal and returns without waiting', async () => {
    const app = createRootContext();
    const N = app.child();
    const d = deferred();
    N.own(() => d.promise);
    expect(N.abort()).toBeUndefined();
    expect(N.signal.aborted).toBe(true);
    expect(N.state).toBe('releasing');
    d.resolve();
    await app.close();
    expect(N.state).toBe('complete');
  });

  it('close() on a bodiless node: success, subscribed children closed recursively, unsubscribed ones aborted', async () => {
    const app = createRootContext();
    const N = app.child();
    const owned = N.own(
      spawn(N, async () => {
        await here().never();
      }),
    );
    const C = N.child(); // above `owned` on N's stack: released (closed) first
    const gate = deferred();
    const natural = spawn(C, async () => {
      await gate.promise;
      return 'done';
    });
    await tick();
    const closing = N.close();
    expect(natural.signal.aborted).toBe(false); // closed, not signalled: it finishes naturally
    expect(owned.signal.aborted).toBe(false); // the owned fiber hears at its turn, after the subscribed child
    gate.resolve();
    await closing;
    expect(natural.outcome).toEqual({ status: 'success', value: 'done' });
    expect(owned.outcome?.status).toBe('aborted');
    expect(N.outcome).toEqual({ status: 'success', value: undefined });
    expect(C.outcome?.status).toBe('success');
    await app.close();
  });

  it('close() on a fiber waits for its body without a signal; a later abort() wins (DESIGN.md §2.7)', async () => {
    const app = createRootContext();
    const gate = deferred();
    let sub!: Fiber<unknown>;
    const f = spawn(app, async () => {
      sub = here().fork(async () => {
        await here().never();
      });
      await gate.promise;
      return 1;
    });
    await tick();
    const closing = f.close();
    expect(f.signal.aborted).toBe(false);
    await tick();
    expect(f.state).toBe('running');
    f.abort('now');
    expect(sub.signal.aborted).toBe(true);
    gate.resolve();
    await closing;
    expect(f.outcome?.status).toBe('aborted');
    await app.close();
  });

  it("close(), then abort(), on an observe node whose bodiless exit was 'await': the abort wins and interrupts its freeze subscribers (DESIGN.md §2.7)", async () => {
    const app = createRootContext();
    const A = app.child({ name: 'A', interrupt: 'observe' });
    const f = spawn(A, async () => {
      await here().never();
    });
    await tick(); // f is suspended on never()
    const closing = A.close();
    await tick();
    expect(A.state).toBe('releasing'); // close() waits for f
    expect(impl(A).exitKind).toBe('await');
    A.abort('stop');
    expect(impl(A).exitKind).toBe('interrupt');
    expect(impl(f).delivered).toBe(true); // the body has exited: no observe body decides for the subtree
    await closing;
    expect(f.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    expect(A.outcome?.status).toBe('success'); // fixed when it settled under close() (DESIGN.md §4.12)
    await app.close();
  });

  it('close() of an already-delivered bodiless node is an interrupt, not a wait: the abort came first and wins (DESIGN.md §2.7)', async () => {
    const app = createRootContext();
    const gate = deferred();
    const P = spawn(app, () => gate.promise); // a bare await: delivery does not reject it
    await tick();
    P.abort('stop');
    const C = P.child({ name: 'C' }); // born delivered (D12)
    const O = C.child({ name: 'O', interrupt: 'observe' }); // observe: never delivered at birth
    const G = spawn(O, async () => {
      await here().never();
    }); // freeze under an undelivered observe node
    await tick();
    expect([impl(C).delivered, impl(O).delivered, impl(G).delivered]).toEqual([true, false, false]);
    await C.close();
    expect(impl(C).exitKind).toBe('interrupt');
    expect(G.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    gate.resolve();
    await app.close();
  });

  it('[Symbol.dispose]() throws on a root and aborts any other node', async () => {
    const app = createRootContext();
    expect(() => app[Symbol.dispose]()).toThrow(TypeError);
    const c = app.child();
    c[Symbol.dispose]();
    expect(c.signal.aborted).toBe(true);
    expect(c.state).toBe('complete');
    {
      using scoped = app.child();
      scoped.own(() => {});
    }
    await app.close();
  });

  it('[Symbol.asyncDispose]() twice shares one release per entry and one completion', async () => {
    const ev = events();
    const N = ev.root.child();
    let n = 0;
    N.own(async () => {
      await tick();
      n++;
    });
    await Promise.all([N[Symbol.asyncDispose](), N[Symbol.asyncDispose](), N.close()]);
    N.abort();
    expect(n).toBe(1);
    expect(ev.of('node:complete').filter((e) => e.id === N.id)).toHaveLength(1);
    await ev.root.close();
  });

  it('await using runs the releases', async () => {
    const t = trace();
    {
      await using app = createRootContext();
      app.own(t.at('released'));
    }
    expect(t.log).toEqual(['released']);
  });
});

// ---------------------------------------------------------------------------
describe('use after release (DESIGN.md §2.7, I7, I8)', () => {
  it('a complete node refuses every operation but the lifecycle quartet (DESIGN.md §2.7)', async () => {
    const K = createInjectionKey<number>('K');
    const app = createRootContext({ providers: [valueProvider(K, 1)] });
    const f = spawn(app, async () => 1);
    await app.join(f);
    const n = app.child();
    await n.close();
    const ops: [string, () => unknown][] = [
      ['get', () => n.get(K)],
      ['own', () => n.own(() => {})],
      ['release', () => n.release({})],
      ['releaseAll', () => n.releaseAll()],
      ['fork', () => n.fork(task(async () => 1, linked))],
      ['call', () => n.call(async () => 1)],
      ['child', () => n.child()],
      ['pool', () => n.pool({ name: 'p', onFailure: () => {} })],
      ['addProvider', () => n.addProvider(valueProvider(K, 2))],
      ['run', () => n.run(() => 1)],
      ['runSync', () => n.runSync(() => 1)],
      ['join', () => n.join(f)],
      ['result', () => n.result(f)],
      ['interrupted', () => n.interrupted()],
      ['never', () => n.never()],
      ['managed', () => n.managed(Promise.resolve(1))],
    ];
    for (const [op, call] of ops) expect(call, op).toThrow(NodeCompletedError);
    expect(() => n.abort()).not.toThrow();
    await expect(n.close()).resolves.toBeUndefined();
    await expect(n[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(() => n[Symbol.dispose]()).not.toThrow();
    await app.close();
  });

  it('between delivery and completion get, own, release, fork, child, call and pool work (I8); a freeze child is born delivered, an observe one is not', async () => {
    const K = createInjectionKey<number>('K');
    const app = createRootContext({ providers: [valueProvider(K, 1)] });
    const gate = deferred();
    const results: unknown[] = [];
    const f = spawn(app, async () => {
      await gate.promise; // bare: delivery arrives while the body runs
      const self = here();
      results.push(self.get(K));
      const x = self.own({}, () => void results.push('x released'));
      void self.release(x); // runs now; not awaited (the test reads what plain code does after delivery, I8)
      let inside!: NodeImpl;
      void self.call(() => {
        inside = here();
        return 3;
      }); // not awaited, for the same reason; the call child completed synchronously
      results.push(inside.delivered, inside.outcome?.status);
    });
    await tick();
    f.abort();
    const n = impl(f);
    expect(n.state).toBe('running');
    expect(f.get(K)).toBe(1);
    const y = f.own({}, () => {});
    void f.release(y);
    const freezeChild = impl(f.child());
    const observeChild = impl(f.child({ interrupt: 'observe' }));
    expect(freezeChild.delivered).toBe(true);
    expect(observeChild.delivered).toBe(false);
    const fiber = impl(f.fork(async () => 1));
    expect(fiber.delivered).toBe(true);
    let outside!: NodeImpl;
    const called = f.call(() => {
      outside = here();
      return 2;
    });
    expect(outside.parent).toBe(n);
    expect(outside.delivered).toBe(true); // born delivered: its outcome is aborted, so join semantics reject
    await expect(called).rejects.toBeInstanceOf(FiberAbortedError);
    const p = impl(f.pool({ name: 'p', onFailure: () => {} }));
    expect(p.state).toBe('running');
    gate.resolve();
    await app.close();
    expect(results).toEqual([1, 'x released', true, 'aborted']);
  });
});

// ---------------------------------------------------------------------------
describe('bodies and messages (DESIGN.md §4.5, §4.12)', () => {
  it('a body that returns a context or a pool returns it as its value, sync or async; one that returns a fiber fails (DESIGN.md §4.5)', async () => {
    const app = createRootContext();
    let c!: Context;
    await expect(app.call(() => (c = app.child()))).resolves.toBe(c);
    await expect(app.call(async () => (c = app.child()))).resolves.toBe(c);
    let p: unknown;
    await expect(app.call(() => (p = app.pool({ name: 'p', onFailure: () => {} })))).resolves.toBe(p);
    const f = spawn(app, () => here().never());
    await expect(app.call(() => f as unknown as number)).rejects.toThrow(/returned a fiber/);
    await expect(app.call(async () => f as unknown as number)).rejects.toBeInstanceOf(FiberNotAwaitableError);
    f.abort();
    await app.close();
  });

  it("inject() outside creation throws CreationViolationError starting with 'inject() outside creation'", () => {
    const K = createInjectionKey<number>('K');
    expect(() => inject(K)).toThrow(CreationViolationError);
    expect(() => inject(K)).toThrow(/^inject\(\) outside creation/);
  });
});

// ---------------------------------------------------------------------------
describe('run and runSync (DESIGN.md §4.11)', () => {
  it('run makes the node current for a synchronous fn and restores the frame on return and on throw', async () => {
    const app = createRootContext();
    expect(currentFrame()).toBeUndefined();
    expect(app.run(() => here())).toBe(impl(app));
    expect(currentFrame()).toBeUndefined();
    expect(() =>
      app.run(() => {
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(currentFrame()).toBeUndefined();
    await app.close();
  });

  it('run(fn) returning a promise throws AsyncRunError (DESIGN.md §4.4, §4.11)', async () => {
    const app = createRootContext();
    expect(() => app.run(async () => 1)).toThrow(AsyncRunError);
    await app.close();
  });

  it('runSync is child + run + abort, and the child releases synchronously before runSync returns', async () => {
    const t = trace();
    const app = createRootContext();
    let inner!: NodeImpl;
    const v = app.runSync((a: number, b: number) => {
      inner = here();
      here().own(t.at('released'));
      return a + b;
    }, 2, 3);
    expect(v).toBe(5);
    expect(inner.parent).toBe(impl(app));
    expect(inner.kind).toBe('context');
    expect(inner.state).toBe('complete');
    expect(t.log).toEqual(['released']);
    await app.close();
  });

  it('runSync with a throwing fn still releases', async () => {
    const t = trace();
    const app = createRootContext();
    expect(() =>
      app.runSync(() => {
        here().own(t.at('released'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(t.log).toEqual(['released']);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
describe('unstarted fibers (DESIGN.md §4.6)', () => {
  it('abort() before the start microtask settles the fiber aborted; the body never runs', async () => {
    const app = createRootContext();
    let ran = false;
    const f = spawn(app, () => {
      ran = true;
    });
    f.abort('early');
    expect(f.outcome).toEqual({ status: 'aborted', reason: 'early' });
    await tick();
    expect(ran).toBe(false);
    await app.close();
  });

  it('a fiber forked under an already-delivered freeze parent runs until its first managed await', async () => {
    const t = trace();
    const app = createRootContext();
    const gate = deferred();
    let child!: NodeImpl;
    const P = spawn(app, async () => {
      await gate.promise;
      child = impl(
        here().fork(async () => {
          t.push('child ran');
          here().own(t.at('child released'));
          await here().never();
          t.push('child resumed');
        }),
      );
      await here().join(child as unknown as Fiber<unknown>);
    });
    await tick();
    P.abort();
    gate.resolve();
    await app.close();
    expect(child.delivered).toBe(true);
    expect(t.log).toEqual(['child ran', 'child released']);
    expect(child.outcome?.status).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
describe('stall diagnostics (DESIGN.md §4.4)', () => {
  it('node:stalled after stallWarningMs for a delivered freeze body that never reaches a managed await', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const ev = events({ stallWarningMs: 100 });
    const gate = deferred();
    const f = spawn(ev.root, () => gate.promise);
    await micro();
    await micro();
    f.abort();
    vi.advanceTimersByTime(99);
    expect(ev.of('node:stalled')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(ev.of('node:stalled').map((e) => e.id)).toEqual([f.id]);
    expect(ev.of('node:stalled')[0].sinceMs).toBe(100);
    gate.resolve();
    vi.useRealTimers();
    await ev.root.close();
  });

  it('node:stalled for a slow release (a release fiber is a node)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const ev = events({ stallWarningMs: 50 });
    const gate = deferred();
    const N = ev.root.child();
    N.own(function slowRelease() {
      return gate.promise;
    });
    const closing = N.close();
    vi.advanceTimersByTime(50);
    const stalled = ev.of('node:stalled');
    expect(stalled).toHaveLength(1);
    expect(ev.of('node:created').find((e) => e.id === stalled[0].id)?.kind).toBe('release');
    gate.resolve();
    vi.useRealTimers();
    await closing;
    await ev.root.close();
  });

  it('stallWarningMs 0 disables the diagnostic', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const ev = events({ stallWarningMs: 0 });
    const gate = deferred();
    const f = spawn(ev.root, () => gate.promise);
    await micro();
    f.abort();
    vi.advanceTimersByTime(1e6);
    expect(ev.of('node:stalled')).toHaveLength(0);
    gate.resolve();
    vi.useRealTimers();
    await ev.root.close();
  });
});

// Keeps the OwnerInterrupt import honest: a parent's natural exit interrupts its subscribers with one (DESIGN.md §2.4).
describe('body exit (DESIGN.md §2.4)', () => {
  it("a parent's natural exit delivers an OwnerInterrupt to its subscribers and does not mark itself", async () => {
    const app = createRootContext();
    let sub!: Fiber<unknown>;
    let P!: NodeImpl;
    await app.call(async () => {
      P = here();
      sub = here().fork(async () => {
        await here().never();
      });
      await tick();
    });
    expect(sub.signal.reason).toBeInstanceOf(OwnerInterrupt);
    expect((sub.signal.reason as OwnerInterrupt).owner).toBe(P);
    expect(P.delivered).toBe(false);
    expect(P.outcome?.status).toBe('success');
    await app.close();
  });

  it("childrenOnExit: 'await' waits for subscribers instead of interrupting them", async () => {
    const app = createRootContext();
    const gate = deferred();
    let sub!: Fiber<unknown>;
    const p = app.call(
      task(
        async () => {
          sub = here().fork(async () => {
            await gate.promise;
            return 'natural';
          });
        },
        { childrenOnExit: 'await' },
      ),
    );
    await tick();
    expect(sub.signal.aborted).toBe(false);
    gate.resolve();
    await p;
    expect(sub.outcome).toEqual({ status: 'success', value: 'natural' });
    await app.close();
  });
});


// ---------------------------------------------------------------------------
describe('NodeTopic receivers are sinks (DESIGN.md §4.7, §5)', () => {
  it('a receiver that throws or returns a rejecting promise is reported with console.error; the tree completes and nothing rejects unhandled', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = new Error('receiver threw');
    const rejected = new Error('receiver rejected');
    const seen: string[] = [];
    let n = 0;
    const app = createRootContext({
      providers: [
        valueProvider(NodeTopic, (async (e: NodeEvent) => {
          seen.push(e.type);
          if (++n === 1) throw rejected; // an async receiver: a rejected promise, not a throw
        }) as (e: NodeEvent) => void),
      ],
    });
    const app2 = createRootContext({
      providers: [
        valueProvider(NodeTopic, () => {
          throw thrown;
        }),
      ],
    });
    await app.call(async () => 1);
    await app2.call(async () => 2);
    await app.close();
    await app2.close();
    await tick(); // the setup hook fails this test on an unhandled rejection (I10)
    expect(seen).toContain('node:complete');
    expect(app.state).toBe('complete');
    expect(app2.state).toBe('complete');
    const reported = errors.mock.calls.map((c) => c[1]);
    expect(reported).toContain(rejected);
    expect(reported).toContain(thrown);
  });
});

// ---------------------------------------------------------------------------
// `parent` (DESIGN.md §2.1, D33). Value nodes and the unit-of-work idiom are in parent.test.ts.
describe('parent (DESIGN.md §2.1, D33)', () => {
  it("a root's parent is undefined", async () => {
    const app = createRootContext();
    expect(app.parent).toBeUndefined();
    await app.close();
  });

  it('child, fork, call and pool children, and a pool’s forks, have the node they were made on as parent', async () => {
    const app = createRootContext();
    const c = app.child();
    expect(c.parent).toBe(app);
    expect(c.child().parent).toBe(c);
    const p = app.pool({ name: 'p', onFailure: () => {} });
    expect(p.parent).toBe(app);
    const pf = p.fork(async () => {});
    expect(pf.parent).toBe(p);
    const seen: { fork?: unknown; forkBody?: unknown; call?: unknown; me?: Context } = {};
    await app.call(async () => {
      const me = here() as Context;
      seen.me = me;
      const f = here().fork(async () => {
        seen.forkBody = here().parent; // a body reads its own node's parent the same way
      });
      seen.fork = f.parent;
      await here().call(async () => {
        seen.call = here().parent;
      });
      await here().join(f);
    });
    expect(seen.fork).toBe(seen.me);
    expect(seen.forkBody).toBe(seen.me);
    expect(seen.call).toBe(seen.me);
    expect(seen.me!.parent).toBe(app); // app.call's own child
    await app.close();
  });

  it('inside a release fiber, current().parent is the owner', async () => {
    const app = createRootContext();
    const N = app.child({ name: 'N' });
    let seen: { kind: string; parent: unknown } | undefined;
    N.own(() => {
      const rf = here();
      seen = { kind: rf.kind, parent: rf.parent };
    });
    await N.close();
    expect(seen).toEqual({ kind: 'release', parent: N });
    await app.close();
  });

  it("a pending value node refuses parent with PendingNodeError, as it refuses get and addProvider (DESIGN.md §3.3)", async () => {
    const app = createRootContext();
    let refused: unknown;
    let pendingState: string | undefined;
    const K = createInjectionKey<object>('K', {
      factory: () => {
        const n = here(); // materialises the auto-hoisted value's node: pending until placement
        pendingState = n.state;
        try {
          void n.parent;
        } catch (e) {
          refused = e;
        }
        return { n };
      },
    });
    const v = app.get(K) as { n: Context };
    expect(pendingState).toBe('pending');
    expect(refused).toBeInstanceOf(PendingNodeError);
    expect(v.n.parent).toBe(app); // placed: the storage node
    await app.close();
  });

  it('parent is readable after completion: the tree shape stays', async () => {
    const app = createRootContext();
    const c = app.child();
    let f!: Fiber<unknown>;
    await app.call(async () => {
      f = here().fork(async () => 1);
      await here().join(f);
    });
    c.abort();
    expect(c.state).toBe('complete');
    expect(c.parent).toBe(app);
    expect(f.state).toBe('complete');
    expect(f.parent?.parent).toBe(app);
    await app.close();
    expect(app.state).toBe('complete');
    expect(app.parent).toBeUndefined();
    expect(c.parent).toBe(app);
  });
});
