import { describe, it, expect, vi } from 'vitest';
import './node.js';
import { ManagedPromise, managedCall, managedFor, managedNever, managedRelease, managedSignal, neverPromise } from './managed.js';
import type { FreezeTarget } from './managed.js';
import { currentFrame, runInFrame } from './context-storage.js';
import type { Frame, HandlerRun } from './context-storage.js';
import type { NodeImpl } from './node-impl.js';
import { FiberAbortedError, InterruptedError } from './resource.js';
import { deferred, gcUntil, hasGc, neverSettles, settled, tick, unhandledRejectionGuard } from './test/util.js';
import type { UnhandledRejectionGuard } from './test/util.js';

/** A fake node. `apply(reason)` is what delivery's fire() does for it: mark, then run and clear the interrupt functions. */
class FakeTarget implements FreezeTarget {
  hasBody = true;
  kind = 'fiber';
  applied = false;
  abortReason: unknown = undefined;
  readonly onApplied = new Set<() => void>();
  constructor(
    public mode: 'freeze' | 'observe' | 'restore' = 'freeze',
    readonly name?: string,
  ) {}
  apply(reason: unknown = 'stop'): void {
    this.abortReason = reason;
    this.applied = this.mode !== 'observe';
    if (!this.applied) return;
    const interrupts = [...this.onApplied];
    this.onApplied.clear();
    for (const interrupt of interrupts) interrupt();
  }
}

function noop(): void {}

/** The rejection of `p`; throws if `p` fulfils. On a managed promise this is an await. */
async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
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

describe('managed promises (DESIGN.md §4.2, D39)', () => {
  // managedFor ALWAYS returns a ManagedPromise, since delivery happens only in then (DESIGN.md §4.2, D13). What
  // stays untouched is the source's value and, for managed(p), its rejection.
  it('(1) with no current node: nothing is interrupted, and the source settles the wrapper untouched', async () => {
    const value = { v: 1 };
    const mp = managedFor(Promise.resolve(value));
    expect(mp).toBeInstanceOf(ManagedPromise);
    expect(await mp).toBe(value);
    const err = new Error('user rejection');
    await expect(managedFor(Promise.reject(err))).rejects.toBe(err);
  });

  it('(1) the decision is made for the node current when the managed await is created, not where it is awaited (DESIGN.md §4.2)', async () => {
    const a = new FakeTarget();
    const src = deferred<number>();
    const targeted = inFrame(a, () => managedFor(src.promise));
    const untargeted = managedFor(src.promise);
    const p1 = targeted.then((v) => v);
    expect(a.onApplied.size).toBe(1);
    const p2 = inFrame(a, () => untargeted.then((v) => v));
    expect(a.onApplied.size).toBe(1);
    a.apply('stop');
    src.resolve(5);
    const e1 = await rejection(p1);
    expect(e1).toBeInstanceOf(InterruptedError); // its `then` ran under no node: the creator's own interruption (D39)
    expect((e1 as InterruptedError).reason).toBe('stop');
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
    }
    const creation = runInFrame({ node: undefined, creation: { nodeIfCreated: undefined } as never }, () =>
      managedFor(Promise.resolve(3)),
    );
    expect(await creation).toBe(3);
  });

  it('(2) then on an applied target rejects with InterruptedError in a job queued at once, never inside then(), in the awaiter’s context; deliver never runs, and every later then rejects too (D39)', async () => {
    const t = new FakeTarget();
    const src = deferred<number>();
    const d = counting<number>();
    const mp = new ManagedPromise(t, src.promise, d.deliver);
    t.apply('stop');
    const seen: { error: unknown; frame: Frame | undefined }[] = [];
    const p = inFrame(t, () =>
      mp.then(
        () => 'resumed',
        (e: unknown) => {
          seen.push({ error: e, frame: currentFrame() });
          return 'rejected';
        },
      ),
    );
    expect(seen).toEqual([]); // not inside the caller's synchronous code
    expect(t.onApplied.size).toBe(0); // nothing armed: it is rejected, not waiting
    expect(await p).toBe('rejected');
    expect(seen[0].error).toBeInstanceOf(InterruptedError);
    expect((seen[0].error as InterruptedError).reason).toBe('stop');
    expect(seen[0].frame?.node).toBe(t); // the awaiter's captured context, as a source reaction's would be
    src.resolve(1);
    await tick();
    expect(d.calls).toBe(0);
    // I6: sticky. A second managed await requested after the delivery rejects too.
    expect(await rejection(mp.then((v) => v))).toBeInstanceOf(InterruptedError);
    expect(d.calls).toBe(0);
  });

  it('(2) a .catch the body attaches after delivery never runs inside its synchronous code; the next managed await rejects the body', async () => {
    const t = new FakeTarget();
    const log: string[] = [];
    t.apply(); // delivered while the body runs plain code (DESIGN.md §4.2)
    const src = deferred<number>();
    const body = inFrame(t, async () => {
      const p = managedFor(src.promise); // join(f)
      log.push('before catch');
      p.catch((e: unknown) => log.push(`catch ${(e as Error).name}`)); // `then` runs now, inside the body
      log.push('after catch'); // the owner has not released anything: use(conn) is safe here
      await managedFor(deferred<number>().promise); // the next managed await rejects the body
      log.push('resumed');
    });
    expect(log).toEqual(['before catch', 'after catch']); // the whole synchronous part ran before any rejection
    expect(await rejection(body)).toBeInstanceOf(InterruptedError);
    expect(log).toEqual(['before catch', 'after catch', 'catch InterruptedError']);
    src.resolve(1);
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
    expect(d.calls).toBe(0);
  });

  it('(4) awaiting arms the interrupt; applying the target rejects the await, whose catch and finally run, even though the source settles later; deliver never runs', async () => {
    const t = new FakeTarget();
    const src = deferred<number>();
    const d = counting<number>();
    const mp = new ManagedPromise(t, src.promise, d.deliver);
    const log: string[] = [];
    const body = (async () => {
      try {
        await mp;
        log.push('resumed');
      } catch (e) {
        log.push(`caught ${(e as Error).name}`);
      } finally {
        log.push('finally');
      }
    })();
    await tick();
    expect(t.onApplied.size).toBe(1);
    t.apply();
    expect(log).toEqual([]); // not inside the delivery
    expect(t.onApplied.size).toBe(0);
    src.resolve(1);
    await body;
    expect(log).toEqual(['caught InterruptedError', 'finally']);
    expect(d.calls).toBe(0);
  });

  it('(5) a source that settles before application settles the await and removes the interrupt', async () => {
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
  });

  it('(6) Promise.all over two wrappers arms both, and the delivery rejects both: the all rejects once, with InterruptedError', async () => {
    const t = new FakeTarget();
    const s1 = deferred<number>();
    const s2 = deferred<number>();
    const all = Promise.all([new ManagedPromise(t, s1.promise), new ManagedPromise(t, s2.promise)]);
    await tick();
    expect(t.onApplied.size).toBe(2);
    t.apply();
    expect(t.onApplied.size).toBe(0);
    s1.resolve(1);
    s2.resolve(2);
    expect(await rejection(all)).toBeInstanceOf(InterruptedError);
  });

  it('(6) a Promise.all over managed wrappers that fulfils leaves nothing armed once the body resumes (DESIGN.md §4.2)', async () => {
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
    t.apply(); // delivery while the resumed body runs plain code (DESIGN.md §4.2): nothing to reject
  });

  // "then was called" outlives the suspension in a race: the loser stays armed, and a later delivery rejects it
  // into the race, which has settled and ignores it. No accounting goes wrong, and nothing is unhandled; the loser's
  // work runs on, which ramme's race() would have aborted (DESIGN.md §4.2).
  it('(6) a Promise.race loser stays armed after the body resumed; a later delivery rejects it into the settled race, which ignores it: safe, not structured', async () => {
    const t = new FakeTarget();
    const s1 = deferred<number>();
    const s2 = deferred<number>();
    const raced = Promise.race([new ManagedPromise(t, s1.promise), new ManagedPromise(t, s2.promise)]);
    s1.resolve(1);
    expect(await raced).toBe(1); // the body has resumed
    expect(t.onApplied.size).toBe(1); // the loser's cell is still armed
    t.apply();
    expect(t.onApplied.size).toBe(0);
    s2.resolve(2);
    await tick();
    expect(guard().seen).toEqual([]);
  });

  it('(6) a bare member and managed ones under Promise.all: the delivery rejects the managed members, a bare one the signal rejects rejects too, and the all rejects once with either; wrapped in managed(), it is rejected with the rest and handled', async () => {
    const err = new Error('aborted fetch');
    const t = new FakeTarget();
    const bare = deferred<number>();
    const mixed = Promise.all([new ManagedPromise(t, deferred<number>().promise), bare.promise]);
    await tick();
    t.apply();
    bare.reject(err); // the delivered signal aborts the fetch
    const first = await rejection(mixed);
    expect(first === err || first instanceof InterruptedError).toBe(true); // which one wins is microtask order, not design

    const w = new FakeTarget();
    const fetchLike = deferred<number>();
    const all = Promise.all([new ManagedPromise(w, deferred<number>().promise), new ManagedPromise(w, fetchLike.promise)]);
    await tick();
    w.apply();
    fetchLike.reject(err);
    expect(await rejection(all)).toBeInstanceOf(InterruptedError);
    await tick();
    expect(guard().seen).toEqual([]); // managed(p) handled p's rejection (D13)
  });

  // A consuming member under a combinator (DESIGN.md §4.2): a member's deliver consumes a failure, and the combinator
  // stores it. Promise.allSettled hands it to the body with the sibling's rejection, so nothing is lost; a
  // Promise.all that rejects drops it: in a node the record has left the owner's `unconsumed`, so the failure
  // surfaces nowhere (I11, D13's cost).
  it('(6) Promise.allSettled delivers every outcome, a consumed failure included; a Promise.all that rejects loses a result() member’s consumed failure (DESIGN.md §4.2)', async () => {
    const shapes = {
      'allSettled over join': (a: Promise<unknown>, b: Promise<unknown>) => Promise.allSettled([a, b]),
      'Promise.all over result': (a: Promise<unknown>, b: Promise<unknown>) => Promise.all([a, b]),
    };
    const seen: Record<string, unknown> = {};
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
      const waited = combine(first, new ManagedPromise(t, f2.promise)).then(
        (v) => ({ fulfilled: v }),
        (e: unknown) => ({ rejected: e }),
      );
      await tick();
      expect(t.onApplied.size).toBe(2);
      f1.resolve(); // f1 fails
      await tick();
      expect(record.consumed).toBe(true); // delivered to the combinator, which keeps waiting
      expect(t.onApplied.size).toBe(1);
      t.apply('stop'); // N is aborted while f2 runs: the second wrapper is rejected
      f2.resolve();
      seen[shape] = await waited;
    }
    const settledOut = (seen['allSettled over join'] as { fulfilled: PromiseSettledResult<unknown>[] }).fulfilled;
    expect(settledOut.map((s) => s.status)).toEqual(['rejected', 'rejected']);
    expect(((settledOut[0] as PromiseRejectedResult).reason as Error).message).toBe('f1 failed (allSettled over join)'); // the body sees it
    expect((settledOut[1] as PromiseRejectedResult).reason).toBeInstanceOf(InterruptedError);
    expect((seen['Promise.all over result'] as { rejected: unknown }).rejected).toBeInstanceOf(InterruptedError); // f1's outcome is gone

    // Promise.all over members whose deliver consumes only when it throws: a member that fulfilled consumed nothing,
    // so a rejection loses nothing.
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
    expect(await rejection(all)).toBeInstanceOf(InterruptedError);
    expect(record.consumed).toBe(false);
  });

  // A .then/.catch attached without awaiting (DESIGN.md §4.2): `.then`/`.catch`/`.finally` on a stored wrapper is
  // `then`: it arms the wrapper, and the body moves on.
  it('(6) a .catch attached to a stored wrapper arms it; a delivery during a bare await rejects into the .catch, and the body resumes when the bare await settles', async () => {
    const t = new FakeTarget();
    const joined = deferred<number>();
    const fetchLike = deferred<number>();
    const log: string[] = [];
    const body = inFrame(t, async () => {
      const p = managedFor(joined.promise); // join(f)
      p.catch((e: unknown) => log.push(`catch ${(e as Error).name}`)); // not awaited
      await fetchLike.promise; // a bare await
      log.push('resumed'); // in a node: its owner waits for the body (DESIGN.md §2.4)
    });
    expect(t.onApplied.size).toBe(1); // armed by the .catch
    t.apply();
    await tick();
    expect(log).toEqual(['catch InterruptedError']);
    fetchLike.resolve(1);
    await body;
    expect(log).toEqual(['catch InterruptedError', 'resumed']);
  });

  // A managed promise awaited by another body (DESIGN.md §4.2): the target is fixed at creation, not at `then`.
  it('(6) a wrapper awaited by another body is rejected by its creator’s delivery with FiberAbortedError, never by the awaiter’s own; dev mode reports it once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = new FakeTarget('freeze', 'a');
      const b = new FakeTarget('freeze', 'b');
      const loaded = deferred<number>();
      const cache = new Map<string, Promise<number>>();
      inFrame(a, () => cache.set('k', managedFor(loaded.promise))); // a single-flight cache: call(load) in A
      expect(warn).not.toHaveBeenCalled(); // creating is fine
      let bSeen: unknown;
      const bBody = inFrame(b, async () => {
        try {
          await cache.get('k'); // `then` runs in a job queued in B's frame
        } catch (e) {
          bSeen = e;
        }
      });
      await tick();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(
        /created in the body of fiber 'a' is awaited by fiber 'b'.*rejects this await with FiberAbortedError/,
      );
      expect(b.onApplied.size).toBe(0); // armed on the creator, not on the awaiter
      b.apply('b stops'); // the awaiter's own delivery does not reject it (A.7 of D39)
      await tick();
      expect(bSeen).toBeUndefined();
      a.apply('a stops'); // A is aborted
      await bBody;
      expect(bSeen).toBeInstanceOf(FiberAbortedError); // another node's abort, not B's own interruption (I12)
      expect((bSeen as FiberAbortedError).reason).toBe('a stops');
      loaded.resolve(1);

      // Once per creating node; the creator, a node without a body, top level and NO_NODE are not reported.
      const c = new FakeTarget('freeze', 'c');
      const other = deferred<number>();
      const fromA = inFrame(a, () => managedFor(other.promise));
      void inFrame(c, () => fromA.then(noop, noop));
      const fromC = inFrame(c, () => managedFor(other.promise));
      void inFrame(c, () => fromC.then(noop, noop));
      void fromC.then(noop, noop);
      void runInFrame({ node: undefined, creation: undefined }, () => fromC.then(noop, noop));
      const bodiless = Object.assign(new FakeTarget(), { hasBody: false });
      void inFrame(bodiless, () => fromC.then(noop, noop));
      expect(warn).toHaveBeenCalledTimes(1);
      // An observe body awaiting another node's wrapper is reported: the creator's delivery rejects it the same way.
      const d = new FakeTarget('freeze', 'd');
      void inFrame(new FakeTarget('observe', 'o'), () => inFrame(d, () => managedFor(other.promise)).then(noop, noop));
      expect(warn).toHaveBeenCalledTimes(2);
      // Production builds do not check.
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        void inFrame(b, () => inFrame(new FakeTarget('freeze', 'e'), () => managedFor(other.promise)).then(noop, noop));
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

  it('(7) never (source undefined): then makes a cell armed on the target, and only its delivery settles it, by rejecting it in a queued job', async () => {
    const t = new FakeTarget();
    const mp = new ManagedPromise<never, never>(t, undefined);
    const log: string[] = [];
    const p = mp.then(
      () => log.push('resumed'),
      (e: unknown) => log.push(`rejected ${(e as Error).name}`),
    );
    expect(t.onApplied.size).toBe(1);
    await tick();
    expect(log).toEqual([]);
    t.apply();
    expect(log).toEqual([]); // not inside the delivery
    await p;
    expect(log).toEqual(['rejected InterruptedError']);
  });

  it.skipIf(!hasGc)('(7) never: once rejected, the callbacks are unreachable from the wrapper', async () => {
    const t = new FakeTarget();
    const mp = new ManagedPromise<never, never>(t, undefined);
    const refs = ((): WeakRef<object>[] => {
      const onF = (): void => {};
      const onR = (): void => {};
      void mp.then(onF, onR);
      return [new WeakRef(onF), new WeakRef(onR)];
    })();
    expect(t.onApplied.size).toBe(1); // armed: the cell holds the callbacks until the delivery
    t.apply();
    await gcUntil(() => refs.every((r) => r.deref() === undefined));
    expect(mp).toBeInstanceOf(ManagedPromise); // the wrapper is alive, the callbacks are not
  });

  it('(7) managedNever(): a sourceless wrapper for an awaiter that can be interrupted, an untargeted never-settling one otherwise (an op either way, D41)', async () => {
    const t = new FakeTarget();
    const targeted = inFrame(t, () => managedNever());
    expect(targeted).toBeInstanceOf(ManagedPromise);
    const p = targeted.then(
      () => 'resumed',
      (e: unknown) => e,
    );
    expect(t.onApplied.size).toBe(1);
    t.apply();
    expect(await p).toBeInstanceOf(InterruptedError);

    // Untargeted, it is still an op, so `yield* never()` runs in an observe body, a release fiber and a halted
    // finally (DESIGN.md §4.14): nothing settles it, and it arms nothing on the node.
    const top = managedNever();
    expect(typeof top[Symbol.iterator]).toBe('function');
    await neverSettles(top);
    const observe = new FakeTarget('observe');
    const obs = inFrame(observe, () => managedNever());
    expect(typeof obs[Symbol.iterator]).toBe('function');
    await neverSettles(obs);
    expect(observe.onApplied.size).toBe(0);

    const n1 = neverPromise();
    const n2 = neverPromise();
    expect(n1).not.toBe(n2);
    await neverSettles(n1);
  });

  it('(7) each never() raced in a loop stays armed until the delivery, which rejects every one into its settled race: nothing unhandled, nothing shared across targets (the retention D39 accepts)', async () => {
    const t = new FakeTarget();
    for (let i = 0; i < 100; i++) {
      const never = inFrame(t, () => managedNever());
      expect(await Promise.race([never, Promise.resolve(i)])).toBe(i);
    }
    expect(t.onApplied.size).toBe(100);
    const other = new FakeTarget();
    const o = inFrame(other, () => managedNever()).then(noop, (e: unknown) => e);
    expect(other.onApplied.size).toBe(1);
    t.apply();
    expect(t.onApplied.size).toBe(0);
    await tick();
    expect(guard().seen).toEqual([]);
    expect(other.onApplied.size).toBe(1); // per target: t's delivery leaves other's never()
    other.apply();
    expect(await o).toBeInstanceOf(InterruptedError);
  });

  it('(7) managedSignal (interrupted()): sourceless for an awaiter of its own node, whose delivery rejects it although the source resolves in the same step; the source for anyone else', async () => {
    const t = new FakeTarget();
    const delivered = deferred<string>(); // deliveredResolvers.promise
    const sig = inFrame(t, () => managedSignal(delivered.promise, t));
    expect(sig).toBeInstanceOf(ManagedPromise);
    const p = inFrame(t, () =>
      sig.then(
        () => 'resumed',
        (e: unknown) => e,
      ),
    );
    expect(t.onApplied.size).toBe(1);
    delivered.resolve('reason'); // fire() resolves the source in pass 2a and interrupts in 2b
    t.apply('reason');
    const e = await p;
    expect(e).toBeInstanceOf(InterruptedError); // never resumed by the source
    expect((e as InterruptedError).reason).toBe('reason');

    for (const awaiter of [new FakeTarget('observe'), Object.assign(new FakeTarget(), { kind: 'release' })]) {
      const reason = deferred<string>();
      const s = inFrame(awaiter, () => managedSignal(reason.promise, awaiter));
      expect(s).toBeInstanceOf(ManagedPromise);
      const seen = s.then((r) => r);
      expect(awaiter.onApplied.size).toBe(0);
      reason.resolve('reason');
      awaiter.apply();
      expect(await seen).toBe('reason'); // the body sees the interrupt (DESIGN.md §4.3)
    }
    expect(await managedSignal(Promise.resolve('top level'), t)).toBe('top level');

    // A freeze body awaiting ANOTHER node's interrupt. The receiver's delivery settles the source without
    // rejecting the awaiter, so the wrapper must be sourced: it resumes with the reason, and only the awaiter's own
    // delivery rejects it.
    const awaiter = new FakeTarget('freeze', 'awaiter');
    const receiver = new FakeTarget('freeze', 'receiver');
    const other = deferred<string>();
    const s2 = inFrame(awaiter, () => managedSignal(other.promise, receiver));
    expect(s2).toBeInstanceOf(ManagedPromise);
    const seen = inFrame(awaiter, () => s2.then((r) => r));
    expect(awaiter.onApplied.size).toBe(1); // armed on the awaiter
    expect(receiver.onApplied.size).toBe(0);
    other.resolve('stop'); // the receiver is delivered; the awaiter is not
    receiver.apply();
    expect(await seen).toBe('stop');
    expect(awaiter.onApplied.size).toBe(0);
    const pending = deferred<string>();
    const rejectMe = inFrame(awaiter, () =>
      managedSignal(pending.promise, receiver).then(
        () => 'resumed',
        (err: unknown) => err,
      ),
    );
    awaiter.apply(); // the awaiter's own delivery rejects it
    pending.resolve('late');
    expect(await rejectMe).toBeInstanceOf(InterruptedError);
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
  });

  it('(9) .catch and .finally go through the override', async () => {
    const applied = new FakeTarget();
    applied.apply();
    const s = deferred<number>();
    expect(await new ManagedPromise(applied, s.promise).catch((e: unknown) => e)).toBeInstanceOf(InterruptedError);
    let afterApplied = false;
    expect(
      await rejection(
        new ManagedPromise(applied, s.promise).finally(() => {
          afterApplied = true;
        }),
      ),
    ).toBeInstanceOf(InterruptedError);
    expect(afterApplied).toBe(true);

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

  it('(10) deliver runs neither when the awaiter is rejected nor when the wrapper is never awaited, and once per then (D13)', async () => {
    const t = new FakeTarget();
    const rejSrc = deferred<number>();
    const rejD = counting<number>();
    const rejected = new ManagedPromise(t, rejSrc.promise, rejD.deliver).then(noop, noop);
    t.apply();
    rejSrc.resolve(1);
    await rejected;
    await tick();
    expect(rejD.calls).toBe(0);

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

  it('(11) a deliver that throws rejects the derived promise, and a second then runs it again', async () => {
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

  it('(11) a then after a delivery is armed again: a delivery before its reaction runs rejects it (DESIGN.md §4.12)', async () => {
    const t = new FakeTarget();
    const d = counting<number>();
    const mp = new ManagedPromise(t, Promise.resolve(1), d.deliver);
    expect(await mp).toBe(1);
    expect(d.calls).toBe(1);
    expect(t.onApplied.size).toBe(0);
    const p = mp.then(
      (v) => v,
      (e: unknown) => e,
    );
    expect(t.onApplied.size).toBe(1);
    t.apply();
    expect(await p).toBeInstanceOf(InterruptedError);
    expect(d.calls).toBe(1);
  });

  it('(11) the interrupt stays armed while any cell is in flight: a delivery from the first continuation rejects the second', async () => {
    const t = new FakeTarget();
    const src = deferred<number>();
    const d = counting<number>();
    const mp = new ManagedPromise(t, src.promise, d.deliver);
    const first = mp.then((v) => {
      t.apply(); // the first continuation's code delivers the node
      return v;
    });
    let secondRan = false;
    const second = mp.then(
      () => (secondRan = true),
      (e: unknown) => e,
    );
    expect(t.onApplied.size).toBe(1);
    src.resolve(1);
    expect(await first).toBe(1);
    expect(await second).toBeInstanceOf(InterruptedError);
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

  it.skipIf(!hasGc)('(12) after the rejection the cells are empty: the callbacks and the awaiter’s async-context values are collectable while the source is pending (A2)', async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const als = new AsyncLocalStorage<object>();
    const t = new FakeTarget();
    const src = deferred<number>();
    const mp = new ManagedPromise(t, src.promise, (v) => v);
    const refs = ((): WeakRef<object>[] => {
      const onF = (): void => {};
      const onR = (): void => {};
      const store = { big: new Array<number>(100_000).fill(1) };
      als.run(store, () => void mp.then(onF, onR));
      return [new WeakRef(onF), new WeakRef(onR), new WeakRef(store)];
    })();
    expect(t.onApplied.size).toBe(1);
    t.apply();
    await gcUntil(() => refs.every((r) => r.deref() === undefined));
    // The source and the wrapper are still alive and pending; settling the source now does nothing.
    expect(await settled(src.promise)).toBe('pending');
    src.resolve(1);
    await tick();
  });

  it.skipIf(!hasGc)('(12) an async body rejected at the delivery unwinds, and nothing of its frame is retained while the source is pending (A2)', async () => {
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
      })().catch(noop);
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

  it('(14) a stored wrapper awaited after a timer delivers its error to the late awaiter (D13)', async () => {
    const err = new Error('late');
    const mp = managedFor(Promise.resolve(1), () => {
      throw err;
    });
    await tick(2);
    await expect(mp).rejects.toBe(err);
  });

  it('(14) an awaited managed(p) whose awaiter is rejected marks p handled: a rejecting p is no unhandled rejection, and the awaiter gets InterruptedError, not p’s error (D13, D39)', async () => {
    const err = new Error('aborted fetch');
    const t = new FakeTarget();
    t.apply(); // born delivered, or delivered while the body ran plain code (DESIGN.md §4.2, §2.7)
    const body = (async () => {
      await inFrame(t, () => managedFor(Promise.reject(err))); // the fetch saw the aborted signal
    })();
    const later = deferred<number>();
    const direct = new ManagedPromise(t, later.promise).then(
      () => 'resumed',
      (e: unknown) => e,
    );
    const all = Promise.all([new ManagedPromise(t, Promise.reject(err)), new ManagedPromise(t, Promise.reject(err))]);
    later.reject(err);
    expect(await rejection(body)).toBeInstanceOf(InterruptedError);
    expect(await direct).toBeInstanceOf(InterruptedError);
    expect(await rejection(all)).toBeInstanceOf(InterruptedError);

    // In flight, then rejected: #listen subscribed before the delivery, and a later then rejects on its own.
    const c = new FakeTarget();
    const slow = deferred<number>();
    const mp = new ManagedPromise(c, slow.promise);
    const first = mp.then(
      () => 'resumed',
      (e: unknown) => e,
    );
    c.apply();
    const again = mp.then(
      () => 'resumed',
      (e: unknown) => e,
    );
    slow.reject(err);
    expect(await first).toBeInstanceOf(InterruptedError);
    expect(await again).toBeInstanceOf(InterruptedError);
    await tick(2);
    expect(guard().seen).toEqual([]);
  });

  it('(15) deliver and the callbacks run in the context `then` was called in, user AsyncLocalStorage values included', async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const als = new AsyncLocalStorage<string>();
    const t = new FakeTarget('observe'); // current node, but nothing interrupts it
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

  it("(16) in a failure handler's frame `then` ignores the target: it arms nothing, the creator's delivery leaves it, and the source settles it; a wrapper the creator was rejected on keeps its source and resume step for the handler (DESIGN.md §4.7, D39)", async () => {
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
      const bodyAwait = inFrame(y, () =>
        conn.then(
          () => 'body resumed',
          (e: unknown) => e,
        ),
      ); // y's own await: armed
      expect(y.onApplied.size).toBe(1);
      const handlerAwait = inHandler(y, () => conn.then((v) => v + 1));
      expect(y.onApplied.size).toBe(1); // the handler's await arms nothing
      y.apply(); // y is aborted: its own await is rejected, the handler's is not
      expect(await bodyAwait).toBeInstanceOf(InterruptedError);
      src.resolve(5);
      expect(await handlerAwait).toBe(11);
      expect(d.calls).toBe(1);

      // On an applied target the handler's await is not rejected: the source settles it.
      const late = inFrame(y, () => managedFor(Promise.resolve(3)));
      expect(await inHandler(y, () => late.then((v) => v))).toBe(3);

      // An interrupted() the body made for its own interrupt still resolves for the handler.
      const z = new FakeTarget('freeze', 'z');
      const delivered = deferred<string>();
      const stop = inFrame(z, () => managedSignal(delivered.promise, z));
      const zAwait = inHandler(z, () => stop.then((v) => v));
      expect(z.onApplied.size).toBe(0);
      delivered.resolve('stop');
      z.apply();
      expect(await zAwait).toBe('stop');

      // What the wrapper waits for is reported to the run, at the handler's await only.
      const waits = (): boolean => true;
      const withWaits = inFrame(y, () => managedFor(Promise.resolve(1), undefined, waits));
      expect(reported).toEqual([]);
      await inHandler(y, () => withWaits.then(() => {}));
      expect(reported).toEqual([waits]);

      // The rejection of y's await kept conn's source and resume step: a handler's later await of it is delivered.
      expect(await inHandler(y, () => conn.then((v) => v * 10))).toBe(100);
      expect(d.calls).toBe(2);
      await neverSettles(inHandler(y, () => managedNever().then(() => {}))); // never() in a handler: a wait nothing settles
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('(17) call-shaped (D39, A.2): in flight at the delivery the wrapper is marked, onMark runs once with the reason, and the cells reject only when the callee completes, unresumed; a then after the delivery marks it too', async () => {
    const t = new FakeTarget();
    const done = deferred<void>(); // the callee's completion
    const d = counting<void>();
    const marks: unknown[] = [];
    const mark = (into: unknown[]) => (target: FreezeTarget) => into.push(target.abortReason) > 0;
    const mp = inFrame(t, () => managedCall(done.promise, d.deliver, mark(marks)));
    const log: string[] = [];
    const p = inFrame(t, () =>
      mp.then(
        () => log.push('resumed'),
        (e: unknown) => log.push(`rejected ${(e as Error).name}`),
      ),
    );
    expect(t.onApplied.size).toBe(1);
    t.apply('stop');
    expect(marks).toEqual(['stop']); // the callee is delivered with the awaiter's reason, if the delivery missed it
    await tick(2);
    expect(log).toEqual([]); // still lent to the callee: nothing settles before it completes
    done.resolve();
    await p;
    expect(log).toEqual(['rejected InterruptedError']);
    expect(d.calls).toBe(0); // the resume step never ran: nothing was consumed (D13)

    // Made, then awaited after the delivery: marked once, at the first `then`, and rejected when the callee completes.
    const late = deferred<void>();
    const lateMarks: unknown[] = [];
    const mp2 = inFrame(t, () => managedCall(late.promise, d.deliver, mark(lateMarks)));
    expect(lateMarks).toEqual([]); // a stored call is not marked
    const p2 = inFrame(t, () => mp2.then(noop, (e: unknown) => e));
    const p3 = inFrame(t, () => mp2.then(noop, (e: unknown) => e));
    expect(lateMarks).toEqual(['stop']);
    expect(t.onApplied.size).toBe(0);
    await tick();
    late.resolve();
    expect(await p2).toBeInstanceOf(InterruptedError);
    expect(await p3).toBeInstanceOf(InterruptedError);
    expect(d.calls).toBe(0);

    // A callee that completed before the delivery resumes its awaiter, as any managed await whose source settled.
    const u = new FakeTarget();
    const quick = counting<void>(() => 'value');
    expect(await inFrame(u, () => managedCall(Promise.resolve(), quick.deliver, () => true))).toBe('value');
    expect(quick.calls).toBe(1);

    // A mark that declines (a join of a fiber the target's delivery does not stop): decided once, and the wrapper then
    // rejects at the delivery like any other managed await, without waiting for its source.
    const v = new FakeTarget();
    const never = deferred<void>();
    let asked = 0;
    const declined = inFrame(v, () =>
      managedCall(never.promise, d.deliver, () => {
        asked++;
        return false;
      }),
    );
    const q1 = inFrame(v, () => declined.then(noop, (e: unknown) => e));
    v.apply('stop');
    expect(await q1).toBeInstanceOf(InterruptedError); // the source never settles: only the delivery rejected it
    expect(await inFrame(v, () => declined.then(noop, (e: unknown) => e))).toBeInstanceOf(InterruptedError);
    expect(asked).toBe(1);
    expect(d.calls).toBe(0);
  });

  it('(18) release work (D39, A.3): an exempt wrapper arms nothing and is never rejected, and its resume step runs with applied set when the awaiter is applied; where the criterion does not hold, an ordinary managed await', async () => {
    const t = new FakeTarget();
    const src = deferred<number>();
    const seen: boolean[] = [];
    const step = (v: number, applied: boolean): number => {
      seen.push(applied);
      return v;
    };
    const mp = inFrame(t, () => managedRelease(() => true, src.promise, step));
    const p = inFrame(t, () => mp.then((v) => v));
    expect(t.onApplied.size).toBe(0);
    t.apply();
    src.resolve(7);
    expect(await p).toBe(7);
    // Made and awaited after the delivery: still release work.
    expect(await inFrame(t, () => managedRelease(() => true, Promise.resolve(8), step).then((v) => v))).toBe(8);
    // An awaiter that is not applied consumes as usual.
    const u = new FakeTarget();
    expect(await inFrame(u, () => managedRelease(() => true, Promise.resolve(9), step))).toBe(9);
    expect(seen).toEqual([true, true, false]);
    // The applied state is the resumed awaiter's, not the creator's: an unapplied awaiter of an applied creator's
    // promise consumes, an applied awaiter of an unapplied creator's does not, and neither do a bodiless node and
    // top-level code count as applied bodies.
    seen.length = 0;
    const fromApplied = inFrame(t, () => managedRelease(() => true, Promise.resolve(1), step));
    expect(await inFrame(u, () => fromApplied.then((v) => v))).toBe(1);
    const appliedAwaiter = new FakeTarget();
    appliedAwaiter.apply();
    const fromLive = inFrame(u, () => managedRelease(() => true, Promise.resolve(2), step));
    expect(await inFrame(appliedAwaiter, () => fromLive.then((v) => v))).toBe(2);
    const bodiless = Object.assign(new FakeTarget(), { hasBody: false });
    bodiless.apply();
    expect(await inFrame(bodiless, () => fromApplied.then((v) => v))).toBe(1);
    expect(await fromApplied.then((v) => v)).toBe(1);
    expect(seen).toEqual([false, true, false, false]);
    // The criterion is decided for the awaiting node when the promise is made.
    const w = new FakeTarget();
    const criterion: FreezeTarget[] = [];
    const notExempt = inFrame(w, () =>
      managedRelease(
        (a) => {
          criterion.push(a);
          return false;
        },
        deferred<number>().promise,
      ),
    );
    expect(criterion).toEqual([w]);
    const q = inFrame(w, () => notExempt.then(noop, (e: unknown) => e));
    expect(w.onApplied.size).toBe(1);
    w.apply();
    expect(await q).toBeInstanceOf(InterruptedError);
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
