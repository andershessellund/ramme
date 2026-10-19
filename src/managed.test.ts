import { describe, it, expect, vi } from 'vitest';
import './node.js';
import { ManagedPromise, managedFor, managedNever, managedSignal, neverPromise } from './managed.js';
import type { FreezeTarget } from './managed.js';
import { currentFrame, runInFrame } from './context-storage.js';
import type { Frame, HandlerRun } from './context-storage.js';
import type { NodeImpl } from './node-impl.js';
import { deferred, gcUntil, hasGc, micro, neverSettles, settled, tick, unhandledRejectionGuard } from './test/util.js';
import type { UnhandledRejectionGuard } from './test/util.js';

/** A fake node. `apply()` is what delivery's fire() does for it: mark, then run and clear the cuts. */
class FakeTarget implements FreezeTarget {
  hasBody = true;
  kind = 'fiber';
  applied = false;
  readonly onApplied = new Set<() => void>();
  frozen = 0;
  /** The frame each `markFrozen` ran under. */
  readonly frozenIn: (Frame | undefined)[] = [];
  /** Called from `markFrozen`, for ordering assertions. */
  onFrozen: (() => void) | undefined = undefined;
  constructor(
    public mode: 'freeze' | 'observe' | 'restore' = 'freeze',
    readonly name?: string,
  ) {}
  markFrozen(): void {
    this.frozen++;
    this.frozenIn.push(currentFrame());
    this.onFrozen?.();
  }
  apply(): void {
    this.applied = this.mode !== 'observe';
    if (!this.applied) return;
    const cuts = [...this.onApplied];
    this.onApplied.clear();
    for (const cut of cuts) cut();
  }
}

/** Run `fn` with `target` as the current node (a body frame). */
function inFrame<R>(target: FakeTarget, fn: () => R): R {
  return runInFrame({ node: target as unknown as NodeImpl, creation: undefined }, fn);
}

/** A deliver step that counts its runs. */
function counting<S>(fn: (v: S) => unknown = (v) => v): { deliver: (v: S) => any; readonly calls: number } {
  const c = {
    calls: 0,
    deliver: (v: S) => {
      c.calls++;
      return fn(v);
    },
  };
  return c;
}

/** The setup file's unhandled-rejection guard (src/test/setup.ts). */
function guard(): UnhandledRejectionGuard {
  const g = unhandledRejectionGuard();
  if (g === undefined) throw new Error('src/test/setup.ts is not installed (vitest.config.ts setupFiles)');
  return g;
}

describe('managed promises (§2.4)', () => {
  // Fixed against §2.4/D-38: the plan's "(1) the source is returned untouched" predates revision 2, in which
  // managedFor ALWAYS returns a ManagedPromise (delivery happens only in then). What stays untouched is the
  // source's value and, for managed(p), its rejection.
  it('(1) with no current node: nothing can freeze, and the source settles the wrapper untouched', async () => {
    const value = { v: 1 };
    const mp = managedFor(Promise.resolve(value));
    expect(mp).toBeInstanceOf(ManagedPromise);
    expect(await mp).toBe(value);
    const err = new Error('user rejection');
    await expect(managedFor(Promise.reject(err))).rejects.toBe(err);
  });

  it('(1) the decision is made for the node current when the managed await is created, not where it is awaited (§4.3)', async () => {
    const a = new FakeTarget();
    const src = deferred<number>();
    const targeted = inFrame(a, () => managedFor(src.promise));
    const untargeted = managedFor(src.promise);
    const p1 = targeted.then((v) => v);
    expect(a.onApplied.size).toBe(1);
    const p2 = inFrame(a, () => untargeted.then((v) => v));
    expect(a.onApplied.size).toBe(1);
    a.apply();
    src.resolve(5);
    await neverSettles(p1);
    expect(await p2).toBe(5);
  });

  it('(1) observe, release and bodiless current nodes, and creation frames, get an untargeted wrapper', async () => {
    const observe = new FakeTarget('observe');
    const release = Object.assign(new FakeTarget(), { kind: 'release' });
    const bodiless = Object.assign(new FakeTarget(), { hasBody: false });
    const src = deferred<number>();
    for (const t of [observe, release, bodiless]) {
      const p = inFrame(t, () => managedFor(src.promise)).then((v) => v);
      expect(t.onApplied.size).toBe(0);
      t.applied = true;
      src.resolve(9);
      expect(await p).toBe(9);
      expect(t.frozen).toBe(0);
    }
    const creation = runInFrame({ node: undefined, creation: { nodeIfCreated: undefined } as never }, () =>
      managedFor(Promise.resolve(3)),
    );
    expect(await creation).toBe(3);
  });

  it('(2) then on an applied target calls markFrozen once, a microtask later under no frame, and the returned promise never settles (D-68)', async () => {
    const t = new FakeTarget();
    const src = deferred<number>();
    const d = counting<number>();
    const mp = new ManagedPromise(t, src.promise, d.deliver);
    t.apply();
    let called = false;
    const p = inFrame(t, () =>
      mp.then(
        () => (called = true),
        () => (called = true),
      ),
    );
    expect(t.frozen).toBe(0); // not inside the caller's synchronous code
    await micro();
    expect(t.frozen).toBe(1);
    expect(t.frozenIn).toEqual([undefined]); // NO_NODE (D-46), not the body's frame
    expect(t.onApplied.size).toBe(0);
    src.resolve(1);
    await neverSettles(p);
    expect(called).toBe(false);
    expect(d.calls).toBe(0);
    // I6: a second managed await requested after freezing never settles either.
    const again = mp.then(() => (called = true));
    await micro();
    expect(t.frozen).toBe(2);
    await neverSettles(again);
    expect(called).toBe(false);
  });

  it('(2) a .catch the body attaches after delivery never counts it frozen inside its synchronous code (D-68)', async () => {
    const t = new FakeTarget();
    const log: string[] = [];
    t.onFrozen = () => log.push('markFrozen');
    t.apply(); // delivered while the body runs plain code (§4.2)
    const src = deferred<number>();
    let resumed = false;
    const body = inFrame(t, async () => {
      const p = managedFor(src.promise); // join(f)
      log.push('before catch');
      p.catch(() => {}); // the floating-promise idiom: `then` runs now, inside the body
      log.push('after catch'); // the owner has not released yet: use(conn) is safe here
      await managedFor(deferred<number>().promise); // the next managed await suspends the body for good
      resumed = true;
    });
    expect(log).toEqual(['before catch', 'after catch']); // the whole synchronous part ran before any freeze
    await tick();
    expect(log).toEqual(['before catch', 'after catch', 'markFrozen', 'markFrozen']); // the .catch, then the managed await
    expect(t.frozenIn).toEqual([undefined, undefined]);
    src.resolve(1);
    await neverSettles(body);
    expect(resumed).toBe(false);
  });

  it('(3) a ManagedPromise that is never awaited registers nothing in onApplied', async () => {
    const t = new FakeTarget();
    const src = deferred<number>();
    const d = counting<number>();
    new ManagedPromise(t, src.promise, d.deliver);
    inFrame(t, () => managedFor(src.promise, d.deliver));
    expect(t.onApplied.size).toBe(0);
    src.resolve(1);
    await tick();
    expect(t.onApplied.size).toBe(0);
    t.apply();
    expect(t.frozen).toBe(0);
    expect(d.calls).toBe(0);
  });

  it('(4) awaiting arms the cut; applying the target cuts the await even though the source settles later', async () => {
    const t = new FakeTarget();
    const src = deferred<number>();
    const d = counting<number>();
    const mp = new ManagedPromise(t, src.promise, d.deliver);
    let resumed = false;
    let finallyRan = false;
    const body = (async () => {
      try {
        await mp;
        resumed = true;
      } finally {
        finallyRan = true;
      }
    })();
    await tick();
    expect(t.onApplied.size).toBe(1);
    t.apply();
    expect(t.frozen).toBe(1);
    src.resolve(1);
    await tick(2);
    expect(resumed).toBe(false);
    expect(finallyRan).toBe(false);
    expect(d.calls).toBe(0);
    expect(t.frozen).toBe(1);
    await neverSettles(body);
  });

  it('(5) a source that settles before application settles the await and removes the cut', async () => {
    const t = new FakeTarget();
    const src = deferred<number>();
    const mp = new ManagedPromise(t, src.promise, (v) => v * 2);
    const p = (async () => await mp)();
    await tick();
    expect(t.onApplied.size).toBe(1);
    src.resolve(7);
    expect(await p).toBe(14);
    expect(t.onApplied.size).toBe(0);
    t.apply();
    expect(t.frozen).toBe(0);
  });

  it('(6) Promise.all over two wrappers arms both and both are cut together', async () => {
    const t = new FakeTarget();
    const s1 = deferred<number>();
    const s2 = deferred<number>();
    const all = Promise.all([new ManagedPromise(t, s1.promise), new ManagedPromise(t, s2.promise)]);
    await tick();
    expect(t.onApplied.size).toBe(2);
    t.apply();
    expect(t.frozen).toBe(2);
    s1.resolve(1);
    s2.resolve(2);
    await neverSettles(all);
  });

  it('(6) a Promise.all over managed wrappers that fulfils leaves nothing armed once the body resumes (D-64)', async () => {
    const t = new FakeTarget();
    const s1 = deferred<number>();
    const s2 = deferred<number>();
    const all = Promise.all([new ManagedPromise(t, s1.promise), new ManagedPromise(t, s2.promise)]);
    await tick();
    expect(t.onApplied.size).toBe(2);
    s1.resolve(1);
    await tick();
    expect(t.onApplied.size).toBe(1); // still suspended on the second member
    s2.resolve(2);
    expect(await all).toEqual([1, 2]);
    expect(t.onApplied.size).toBe(0);
    t.apply(); // delivery while the resumed body runs plain code (§4.2)
    expect(t.frozen).toBe(0);
  });

  // D-64 pins these two shapes as unsupported: "then was called" outlives the suspension, a delivery counts the running
  // body frozen, and S1's dev diagnostic reports the body when it later settles.
  it('(6) unsupported (D-64): a Promise.race loser stays armed after the body resumed, and a later delivery counts it frozen', async () => {
    const t = new FakeTarget();
    const s1 = deferred<number>();
    const s2 = deferred<number>();
    const raced = Promise.race([new ManagedPromise(t, s1.promise), new ManagedPromise(t, s2.promise)]);
    s1.resolve(1);
    expect(await raced).toBe(1); // the body has resumed
    expect(t.onApplied.size).toBe(1); // the loser's cell is still armed
    t.apply();
    expect(t.frozen).toBe(1);
    s2.resolve(2);
    await tick();
  });

  it('(6) unsupported (D-64): a bare member resumes a body counted frozen; wrapping it in managed() keeps it suspended', async () => {
    const err = new Error('aborted fetch');
    const t = new FakeTarget();
    const bare = deferred<number>();
    const mixed = Promise.all([new ManagedPromise(t, deferred<number>().promise), bare.promise]);
    await tick();
    t.apply();
    expect(t.frozen).toBe(1);
    bare.reject(err); // the delivered signal aborts the fetch
    expect(await settled(mixed)).toBe('rejected'); // the "frozen" body would resume into its catch/finally

    const w = new FakeTarget();
    const fetchLike = deferred<number>();
    const all = Promise.all([new ManagedPromise(w, deferred<number>().promise), new ManagedPromise(w, fetchLike.promise)]);
    await tick();
    w.apply();
    expect(w.frozen).toBe(2);
    fetchLike.reject(err);
    await neverSettles(all);
    expect(guard().seen).toEqual([]);
  });

  // D-67 (a): a member's deliver consumes a failure, the combinator stores it, a sibling is cut, and the body never
  // reads it. In a node the record has left the owner's `unconsumed`, so the failure surfaces nowhere (I11).
  it('(6) unsupported (D-67): Promise.allSettled, or a result() member, consumes a failure the frozen body never sees', async () => {
    const shapes = {
      'allSettled over join': (a: Promise<unknown>, b: Promise<unknown>) => Promise.allSettled([a, b]),
      'Promise.all over result': (a: Promise<unknown>, b: Promise<unknown>) => Promise.all([a, b]),
    };
    for (const [shape, combine] of Object.entries(shapes)) {
      const t = new FakeTarget();
      const f1 = deferred<void>(); // f1.completion
      const f2 = deferred<void>();
      const record = { consumed: false }; // f1.failure, also in N.unconsumed
      const err = new Error(`f1 failed (${shape})`);
      const first =
        shape === 'allSettled over join'
          ? new ManagedPromise(t, f1.promise, () => {
              record.consumed = true; // take(f1): consumeFailure(), then throw
              throw err;
            })
          : new ManagedPromise(t, f1.promise, () => {
              record.consumed = true; // result(f1): consumeFailure(), then return the outcome
              return { status: 'failure', error: err };
            });
      const waited = combine(first, new ManagedPromise(t, f2.promise));
      await tick();
      expect(t.onApplied.size).toBe(2);
      f1.resolve(); // f1 fails
      await tick();
      expect(record.consumed).toBe(true); // delivered to the combinator, which keeps waiting
      expect(t.onApplied.size).toBe(1);
      t.apply(); // N is aborted while f2 runs: the second wrapper is cut, N counts frozen
      expect(t.frozen).toBe(1);
      f2.resolve();
      await neverSettles(waited); // the body never reads f1's failure
    }

    // The supported counterpart: Promise.all over members whose deliver consumes only when it throws. A member that
    // fulfilled consumed nothing, so a cut loses nothing.
    type Settled = { status: 'success'; value: number } | { status: 'failure'; error: Error };
    const t = new FakeTarget();
    const f1 = deferred<Settled>(); // resolves with f1's outcome, standing in for completion + f1.outcome
    const record = { consumed: false };
    const take = (o: Settled): number => {
      if (o.status === 'success') return o.value;
      record.consumed = true; // join(f): consumes only when it throws, and then Promise.all rejects into the body
      throw o.error;
    };
    const all = Promise.all([new ManagedPromise(t, f1.promise, take), new ManagedPromise(t, deferred<Settled>().promise, take)]);
    await tick();
    f1.resolve({ status: 'success', value: 1 }); // f1 succeeds
    await tick();
    t.apply();
    expect(t.frozen).toBe(1);
    await neverSettles(all);
    expect(record.consumed).toBe(false);
  });

  // D-67 (b): `.then`/`.catch`/`.finally` on a stored wrapper is `then`: it arms the cut, and the body moves on.
  it('(6) unsupported (D-67): a .catch attached to a stored wrapper arms the cut; a delivery during a bare await counts the running body frozen', async () => {
    const t = new FakeTarget();
    const joined = deferred<number>();
    const fetchLike = deferred<number>();
    let resumed = false;
    const body = inFrame(t, async () => {
      const p = managedFor(joined.promise); // join(f)
      p.catch(() => {}); // not awaited
      await fetchLike.promise; // a bare await
      resumed = true; // in a node: runs after the owner released (I6, §4.2)
    });
    expect(t.onApplied.size).toBe(1); // armed by the .catch
    t.apply();
    expect(t.frozen).toBe(1);
    fetchLike.resolve(1);
    await body;
    expect(resumed).toBe(true);
  });

  // D-67 (c): the target is fixed at creation (§2.4 property 1), not at `then`.
  it('(6) unsupported (D-67): a wrapper awaited by another body freezes its creator and strands the awaiter; dev mode reports it once (D-68)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = new FakeTarget('freeze', 'a');
      const b = new FakeTarget('freeze', 'b');
      const loaded = deferred<number>();
      const cache = new Map<string, Promise<number>>();
      inFrame(a, () => cache.set('k', managedFor(loaded.promise))); // a single-flight cache: call(load) in A
      expect(warn).not.toHaveBeenCalled(); // creating is fine
      let bResumed = false;
      const bBody = inFrame(b, async () => {
        await cache.get('k'); // `then` runs in a job queued in B's frame
        bResumed = true;
      });
      await tick();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/created in the body of fiber 'a' is awaited by fiber 'b'/);
      expect(b.onApplied.size).toBe(0); // armed on the creator, not on the awaiter
      a.apply(); // A is aborted
      expect(a.frozen).toBe(1); // A counts frozen although it is not suspended on the wrapper
      loaded.resolve(1);
      await neverSettles(bBody); // B never resumes, and is never counted frozen
      expect(bResumed).toBe(false);
      expect(b.frozen).toBe(0);

      // Once per creating node; the creator, a node without a body, top level and NO_NODE are not reported.
      const c = new FakeTarget('freeze', 'c');
      const other = deferred<number>();
      const fromA = inFrame(a, () => managedFor(other.promise));
      void inFrame(c, () => fromA.then(() => {}));
      const fromC = inFrame(c, () => managedFor(other.promise));
      void inFrame(c, () => fromC.then(() => {}));
      void fromC.then(() => {});
      void runInFrame({ node: undefined, creation: undefined }, () => fromC.then(() => {}));
      const bodiless = Object.assign(new FakeTarget(), { hasBody: false });
      void inFrame(bodiless, () => fromC.then(() => {}));
      expect(warn).toHaveBeenCalledTimes(1);
      // An observe body awaiting another node's wrapper is reported: it is stranded the same way.
      const d = new FakeTarget('freeze', 'd');
      void inFrame(new FakeTarget('observe', 'o'), () => inFrame(d, () => managedFor(other.promise)).then(() => {}));
      expect(warn).toHaveBeenCalledTimes(2);
      // Production builds do not check.
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        void inFrame(b, () => inFrame(new FakeTarget('freeze', 'e'), () => managedFor(other.promise)).then(() => {}));
      } finally {
        if (prev === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prev;
      }
      expect(warn).toHaveBeenCalledTimes(2);
      other.resolve(1);
      await tick();
    } finally {
      warn.mockRestore();
    }
  });

  it('(7) never (source undefined) is cut-only: it drops its callbacks at then time, and delivery freezes it', async () => {
    const t = new FakeTarget();
    const mp = new ManagedPromise<never, never>(t, undefined);
    let called = false;
    const p = mp.then(
      () => (called = true),
      () => (called = true),
    );
    expect(t.onApplied.size).toBe(1);
    t.apply();
    expect(t.frozen).toBe(1);
    await neverSettles(p);
    expect(called).toBe(false);
  });

  it.skipIf(!hasGc)('(7) never: the callbacks are unreachable from the wrapper right after then', async () => {
    const t = new FakeTarget();
    const mp = new ManagedPromise<never, never>(t, undefined);
    const refs = ((): WeakRef<object>[] => {
      const onF = (): void => {};
      const onR = (): void => {};
      void mp.then(onF, onR);
      return [new WeakRef(onF), new WeakRef(onR)];
    })();
    await gcUntil(() => refs.every((r) => r.deref() === undefined));
    expect(t.onApplied.size).toBe(1); // still armed: the wrapper is alive, the callbacks are not
  });

  it('(7) managedNever(): cut-only for a freeze awaiter, a plain never-settling promise otherwise', async () => {
    const t = new FakeTarget();
    const targeted = inFrame(t, () => managedNever());
    expect(targeted).toBeInstanceOf(ManagedPromise);
    const p = targeted.then(() => 'resumed');
    expect(t.onApplied.size).toBe(1);
    t.apply();
    expect(t.frozen).toBe(1);
    await neverSettles(p);

    const top = managedNever();
    expect(top).not.toBeInstanceOf(ManagedPromise);
    await neverSettles(top);
    const observe = new FakeTarget('observe');
    const obs = inFrame(observe, () => managedNever());
    expect(obs).not.toBeInstanceOf(ManagedPromise);
    await neverSettles(obs);
    expect(observe.onApplied.size).toBe(0);

    const n1 = neverPromise();
    const n2 = neverPromise();
    expect(n1).not.toBe(n2);
    await neverSettles(n1);
  });

  it('(7) cut-only wrappers share one cut per target: racing never() in a loop keeps onApplied at one entry (D-64)', async () => {
    const t = new FakeTarget();
    for (let i = 0; i < 1000; i++) {
      const never = inFrame(t, () => managedNever());
      expect(await Promise.race([never, Promise.resolve(i)])).toBe(i);
      expect(t.onApplied.size).toBe(1);
    }
    const tCut = [...t.onApplied][0];
    expect(tCut).toBeTypeOf('function');
    t.apply();
    expect(t.frozen).toBe(1);
    expect(t.onApplied.size).toBe(0);
    const other = new FakeTarget();
    void inFrame(other, () => managedNever()).then(() => {});
    expect(other.onApplied.size).toBe(1);
    expect([...other.onApplied][0]).not.toBe(tCut); // per target: another node's delivery must not freeze t
    other.apply();
    expect(other.frozen).toBe(1);
    expect(t.frozen).toBe(1);
  });

  it('(7) managedSignal (interrupted()): cut-only with the shared cut for a freeze awaiter of its own interrupt, the source for anyone else (D-66, D-86)', async () => {
    const t = new FakeTarget();
    const delivered = deferred<string>(); // deliveredResolvers.promise
    for (let i = 0; i < 100; i++) {
      // a freeze body's `for (…) await Promise.race([interrupted(), next()])`
      const sig = inFrame(t, () => managedSignal(delivered.promise, t));
      expect(sig).toBeInstanceOf(ManagedPromise);
      expect(await Promise.race([sig, Promise.resolve(i)])).toBe(i);
      expect(t.onApplied.size).toBe(1);
    }
    const p = inFrame(t, () => managedSignal(delivered.promise, t)).then(() => 'resumed');
    expect(t.onApplied.size).toBe(1);
    delivered.resolve('reason'); // fire() resolves the source and cuts in one step
    t.apply();
    expect(t.frozen).toBe(1);
    await neverSettles(p); // a freeze awaiter is cut, never resumed by the source

    for (const awaiter of [new FakeTarget('observe'), Object.assign(new FakeTarget(), { kind: 'release' })]) {
      const reason = deferred<string>();
      const sig = inFrame(awaiter, () => managedSignal(reason.promise, awaiter));
      expect(sig).toBeInstanceOf(ManagedPromise);
      const seen = sig.then((r) => r);
      expect(awaiter.onApplied.size).toBe(0);
      reason.resolve('reason');
      awaiter.apply();
      expect(await seen).toBe('reason'); // §2.4 property 5: the body sees the interrupt
      expect(awaiter.frozen).toBe(0);
    }
    expect(await managedSignal(Promise.resolve('top level'), t)).toBe('top level');

    // D-86: a freeze body awaiting ANOTHER node's interrupt. The receiver's delivery settles the source
    // without cutting the awaiter, so the wrapper must be sourced: it resumes with the reason, and only
    // the awaiter's own delivery cuts it.
    const awaiter = new FakeTarget('freeze', 'awaiter');
    const receiver = new FakeTarget('freeze', 'receiver');
    const other = deferred<string>();
    const sig = inFrame(awaiter, () => managedSignal(other.promise, receiver));
    expect(sig).toBeInstanceOf(ManagedPromise);
    const seen = inFrame(awaiter, () => sig.then((r) => r));
    expect(awaiter.onApplied.size).toBe(1); // armed on the awaiter, with its own cut
    expect(receiver.onApplied.size).toBe(0);
    other.resolve('stop'); // the receiver is delivered; the awaiter is not
    receiver.apply();
    expect(await seen).toBe('stop');
    expect(awaiter.frozen).toBe(0);
    expect(awaiter.onApplied.size).toBe(0);
    const pending = deferred<string>();
    const cutMe = inFrame(awaiter, () => managedSignal(pending.promise, receiver).then(() => 'resumed'));
    awaiter.apply(); // the awaiter's own delivery cuts it
    expect(awaiter.frozen).toBe(1);
    pending.resolve('late');
    await neverSettles(cutMe);
  });

  it('(8) an observe node gets an untargeted wrapper that still delivers only in then', async () => {
    const t = new FakeTarget('observe');
    const src = deferred<number>();
    const d = counting<number>((v) => v + 1);
    const mp = inFrame(t, () => managedFor(src.promise, d.deliver));
    t.apply(); // delivered, never applied: observe
    src.resolve(1);
    await tick();
    expect(d.calls).toBe(0);
    expect(await mp).toBe(2);
    expect(d.calls).toBe(1);
    expect(t.onApplied.size).toBe(0);
    expect(t.frozen).toBe(0);
  });

  it('(9) .catch and .finally go through the override', async () => {
    const applied = new FakeTarget();
    applied.apply();
    const s = deferred<number>();
    void new ManagedPromise(applied, s.promise).catch(() => {});
    await micro(); // D-68
    expect(applied.frozen).toBe(1);
    void new ManagedPromise(applied, s.promise).finally(() => {});
    await micro();
    expect(applied.frozen).toBe(2);

    const t = new FakeTarget();
    const err = new Error('delivered');
    const d = counting<number>(() => {
      throw err;
    });
    const src = Promise.resolve(1);
    expect(await new ManagedPromise(t, src, d.deliver).catch((e) => e)).toBe(err);
    expect(d.calls).toBe(1);
    let finallyRan = false;
    await expect(
      new ManagedPromise(t, src, d.deliver).finally(() => {
        finallyRan = true;
      }),
    ).rejects.toBe(err);
    expect(finallyRan).toBe(true);
    expect(d.calls).toBe(2);
  });

  it('(9) promises derived from a wrapper are plain promises', () => {
    const mp = new ManagedPromise(undefined, Promise.resolve(1));
    const derived = [mp.then(), mp.catch(() => {}), mp.finally(() => {})];
    for (const p of derived) {
      expect(p).not.toBeInstanceOf(ManagedPromise);
      expect(Object.getPrototypeOf(p)).toBe(Promise.prototype);
    }
  });

  it('(10) deliver runs neither when the wrapper is cut nor when it is never awaited, and once per then (D-38)', async () => {
    const t = new FakeTarget();
    const cutSrc = deferred<number>();
    const cutD = counting<number>();
    void new ManagedPromise(t, cutSrc.promise, cutD.deliver).then(() => {});
    t.apply();
    cutSrc.resolve(1);
    await tick();
    expect(cutD.calls).toBe(0);

    const idle = counting<number>();
    new ManagedPromise(new FakeTarget(), Promise.resolve(1), idle.deliver);
    managedFor(Promise.resolve(1), idle.deliver);
    await tick();
    expect(idle.calls).toBe(0);

    const twice = counting<number>();
    const mp = new ManagedPromise(new FakeTarget(), Promise.resolve(3), twice.deliver);
    const [a, b] = await Promise.all([mp.then((v) => v), mp.then((v) => v)]);
    expect([a, b]).toEqual([3, 3]);
    expect(twice.calls).toBe(2);
  });

  it('(11) a deliver that throws rejects the derived promise, and a second then runs it again (D-50)', async () => {
    const err = new Error('failure');
    const d = counting<number>(() => {
      throw err;
    });
    const mp = new ManagedPromise(new FakeTarget(), Promise.resolve(1), d.deliver);
    await expect(mp).rejects.toBe(err);
    expect(d.calls).toBe(1);
    await expect(mp).rejects.toBe(err);
    expect(d.calls).toBe(2);
  });

  it('(11) a then after a delivery is armed again: a delivery before its reaction runs cuts it (D-61, D-50)', async () => {
    const t = new FakeTarget();
    const d = counting<number>();
    const mp = new ManagedPromise(t, Promise.resolve(1), d.deliver);
    expect(await mp).toBe(1);
    expect(d.calls).toBe(1);
    expect(t.onApplied.size).toBe(0);
    const p = mp.then((v) => v);
    expect(t.onApplied.size).toBe(1);
    t.apply();
    expect(t.frozen).toBe(1);
    await neverSettles(p);
    expect(d.calls).toBe(1);
  });

  it('(11) the cut stays armed while any cell is in flight: a delivery from the first continuation cuts the second (D-61)', async () => {
    const t = new FakeTarget();
    const src = deferred<number>();
    const d = counting<number>();
    const mp = new ManagedPromise(t, src.promise, d.deliver);
    const first = mp.then((v) => {
      t.apply(); // the first continuation's code delivers the node
      return v;
    });
    let secondRan = false;
    const second = mp.then(() => (secondRan = true));
    expect(t.onApplied.size).toBe(1);
    src.resolve(1);
    expect(await first).toBe(1);
    expect(t.frozen).toBe(1);
    await neverSettles(second);
    expect(secondRan).toBe(false);
    expect(d.calls).toBe(1);
  });

  it('(11) a throwing onFulfilled or onRejected rejects the derived promise (Promise semantics)', async () => {
    const boom = new Error('boom');
    const ok = new ManagedPromise(undefined, Promise.resolve(1));
    await expect(
      ok.then(() => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const failing = managedFor(Promise.reject(new Error('user')));
    await expect(
      failing.then(undefined, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await managedFor(Promise.reject(new Error('user'))).then(undefined, (e: Error) => e.message)).toBe('user');
  });

  it.skipIf(!hasGc)('(12) after a cut the cells are empty: the continuation is collectable while the source is pending', async () => {
    const t = new FakeTarget();
    const src = deferred<number>();
    const mp = new ManagedPromise(t, src.promise, (v) => v);
    const refs = ((): WeakRef<object>[] => {
      const onF = (): void => {};
      const onR = (): void => {};
      void mp.then(onF, onR);
      return [new WeakRef(onF), new WeakRef(onR)];
    })();
    expect(t.onApplied.size).toBe(1);
    t.apply();
    await gcUntil(() => refs.every((r) => r.deref() === undefined));
    // The source and the wrapper are still alive and pending; settling the source now does nothing.
    expect(await settled(src.promise)).toBe('pending');
    src.resolve(1);
    await tick();
  });

  it.skipIf(!hasGc)('(12) a frozen async body and everything its frame holds are collectable', async () => {
    const t = new FakeTarget();
    const src = deferred<number>();
    const mp = new ManagedPromise(t, src.promise);
    const collected: string[] = [];
    const registry = new FinalizationRegistry<string>((held) => collected.push(held));
    (() => {
      const big = new Array<number>(1_000_000).fill(1);
      registry.register(big, 'body frame');
      void (async () => {
        await mp;
        return big.length;
      })();
    })();
    await tick();
    expect(t.onApplied.size).toBe(1);
    t.apply();
    await gcUntil(() => collected.includes('body frame'));
    src.resolve(1);
    await tick();
  });

  it('(13) with no target, a source that settled before then delivers at then time, not before', async () => {
    const d = counting<number>((v) => v * 10);
    const mp = managedFor(Promise.resolve(4), d.deliver);
    await tick(2);
    expect(d.calls).toBe(0);
    expect(await mp).toBe(40);
    expect(d.calls).toBe(1);
  });

  it('(14) a wrapper whose deliver throws, never awaited, produces no unhandled rejection', async () => {
    const d = counting<number>(() => {
      throw new Error('never delivered');
    });
    managedFor(Promise.resolve(1), d.deliver);
    new ManagedPromise(new FakeTarget(), Promise.resolve(1), d.deliver);
    inFrame(new FakeTarget(), () => managedFor(Promise.resolve(1), d.deliver));
    await tick(2);
    expect(d.calls).toBe(0);
    expect(guard().seen).toEqual([]);
    // the setup hook checks again after this test
  });

  it('(14) a stored wrapper awaited after a timer delivers its error to the late awaiter (D-38)', async () => {
    const err = new Error('late');
    const mp = managedFor(Promise.resolve(1), () => {
      throw err;
    });
    await tick(2);
    await expect(mp).rejects.toBe(err);
  });

  it('(14) an awaited managed(p) whose awaiter freezes marks p handled: a rejecting p is no unhandled rejection (D-63)', async () => {
    const err = new Error('aborted fetch');
    const t = new FakeTarget();
    t.apply(); // born delivered, or delivered while the body ran plain code (§4.2, §5.4)
    let resumed = false;
    const body = (async () => {
      try {
        await inFrame(t, () => managedFor(Promise.reject(err))); // the fetch saw the aborted signal
      } finally {
        resumed = true;
      }
    })();
    const later = deferred<number>();
    const direct = new ManagedPromise(t, later.promise).then(
      () => (resumed = true),
      () => (resumed = true),
    );
    const all = Promise.all([new ManagedPromise(t, Promise.reject(err)), new ManagedPromise(t, Promise.reject(err))]);
    await tick();
    later.reject(err);
    await tick(2);
    expect(t.frozen).toBe(4);
    expect(resumed).toBe(false);
    await neverSettles(body);
    await neverSettles(direct);
    await neverSettles(all);

    // In flight, then cut: #listen subscribed before the cut, and a later then on the cut wrapper adds nothing:
    // the cut dropped the target (D-84), so it neither subscribes nor counts the (already frozen) target again.
    const c = new FakeTarget();
    const slow = deferred<number>();
    const mp = new ManagedPromise(c, slow.promise);
    const first = mp.then(() => (resumed = true));
    c.apply();
    const again = mp.then(() => (resumed = true));
    slow.reject(err);
    await tick(2);
    expect(c.frozen).toBe(1);
    await neverSettles(first);
    await neverSettles(again);
    expect(resumed).toBe(false);
    expect(guard().seen).toEqual([]);
  });

  it('(15) deliver and the callbacks run in the context `then` was called in, user AsyncLocalStorage values included (D-84)', async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const als = new AsyncLocalStorage<string>();
    const t = new FakeTarget('observe'); // current node, but nothing can freeze
    const src = deferred<number>();
    const seen: unknown[] = [];
    const mp = new ManagedPromise(undefined, src.promise, (v: number) => {
      seen.push(['deliver', als.getStore(), currentFrame()?.node]);
      return v;
    });
    const p = als.run('request-1', () =>
      inFrame(t, () =>
        mp.then((v) => {
          seen.push(['then', als.getStore(), currentFrame()?.node]);
          return v;
        }),
      ),
    );
    expect(currentFrame()).toBeUndefined();
    src.resolve(1);
    expect(await p).toBe(1);
    expect(seen).toEqual([
      ['deliver', 'request-1', t],
      ['then', 'request-1', t],
    ]);
  });

  it("(16) in a failure handler's frame `then` ignores the target: it arms nothing, the creator's delivery leaves it, and the source settles it; a spent wrapper warns (D-116, D-117)", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const y = new FakeTarget('freeze', 'y');
      const reported: unknown[] = [];
      const run: HandlerRun = { awaits: (w) => void reported.push(w) };
      const inHandler = <R,>(on: FakeTarget, fn: () => R): R =>
        runInFrame({ node: on as unknown as NodeImpl, creation: undefined, handler: run }, fn);
      const src = deferred<number>();
      const d = counting<number>((v) => v * 2);
      const conn = inFrame(y, () => managedFor(src.promise, d.deliver)); // made in y's body: targeted at y
      const bodyAwait = inFrame(y, () => conn.then(() => 'body resumed')); // y's own await: armed
      expect(y.onApplied.size).toBe(1);
      const handlerAwait = inHandler(y, () => conn.then((v) => v + 1));
      expect(y.onApplied.size).toBe(1); // the handler's await arms nothing
      y.apply(); // y is aborted: its own await is cut, the handler's is not
      expect(y.frozen).toBe(1);
      src.resolve(5);
      expect(await handlerAwait).toBe(11);
      expect(d.calls).toBe(1);
      await neverSettles(bodyAwait);

      // On an applied target: no applied path, so nothing is counted frozen and the source settles it.
      const late = inFrame(y, () => managedFor(Promise.resolve(3)));
      expect(await inHandler(y, () => late.then((v) => v))).toBe(3);
      await tick();
      expect(y.frozen).toBe(1);

      // A cut-only interrupted() the body made for its own interrupt still resolves for the handler.
      const z = new FakeTarget('freeze', 'z');
      const delivered = deferred<string>();
      const stop = inFrame(z, () => managedSignal(delivered.promise, z));
      const zAwait = inHandler(z, () => stop.then((v) => v));
      expect(z.onApplied.size).toBe(0);
      delivered.resolve('stop');
      z.apply();
      expect(await zAwait).toBe('stop');
      expect(z.frozen).toBe(0);

      // What the wrapper waits for is reported to the run, at the handler's await only.
      const waits = (): boolean => true;
      const withWaits = inFrame(y, () => managedFor(Promise.resolve(1), undefined, waits));
      expect(reported).toEqual([]);
      await inHandler(y, () => withWaits.then(() => {}));
      expect(reported).toEqual([waits]);

      // A wrapper the creator was frozen on has no source left: it never settles, and dev mode says why.
      expect(warn).not.toHaveBeenCalled();
      await neverSettles(inHandler(y, () => conn.then(() => {})));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/failure handler awaits a managed promise whose creating body was already counted frozen/);
      await neverSettles(inHandler(y, () => managedNever().then(() => {}))); // never() is no misuse
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  // A real unhandled rejection would also fail the run through vitest's own reporter, so the probe drives the
  // guard's listener directly and checks that it is the one Node calls.
  it('the unhandled-rejection guard is installed on the process and records what it hears', () => {
    const g = guard();
    expect(process.listeners('unhandledRejection')).toContain(g.listener);
    const probe = new Error('guard probe');
    g.listener(probe);
    expect(g.seen).toContain(probe);
    g.seen.splice(g.seen.indexOf(probe), 1); // consumed here, so the after-each check passes
  });
});
