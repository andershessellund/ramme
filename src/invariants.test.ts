// invariants.test.ts — one named test per invariant of DESIGN.md §10
// (I1–I27). Each test pins the invariant end to end in ramme's idiom (law 2);
// the edge cases live in the per-module suites the comments name. The
// candidate scenarios for the probes the review left without a scenario (see
// probes.test.ts) are here too:
// G1–G4, the closed door and open window, aborted-is-not-failure, no
// unhandled rejection from an unjoined failed fork, and release failures that
// do not stop the remaining releases.
//
// A delivered freeze body's outcome is `aborted` whatever it does (I13), so
// nothing is asserted inside one: such bodies record, and the test asserts
// after.
import { describe, expect, it, vi } from 'vitest';
import {
  all,
  call,
  child,
  current,
  fork,
  interrupted,
  join,
  lookup,
  never,
  own,
  pool,
  race,
  release,
  releaseAll,
  result,
  runSync,
  shield,
  signal,
  sleep,
  wait,
} from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber } from './context.js';
import { currentCreation } from './context-storage.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { ContextKey, inject } from './inject.js';
import type { NodeImpl } from './node-impl.js';
import { factoryProvider, valueProvider } from './provider-util.js';
import {
  CreationViolationError,
  FiberAbortedError,
  FiberNotAwaitableError,
  NodeCompletedError,
  NotOwnedError,
  NoCurrentNodeError,
  PlacementError,
} from './resource.js';
import { deferred, events, impl, tick, trace, unhandledRejectionGuard, within } from './test/util.js';

const link = { onFailure: 'link' } as const;

/** The rejection of `p`; throws if `p` fulfils. */
async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

/**
 * What `fn` throws, or 'ok'. An op it returns is dropped, not consumed: a work op runs nothing then, and a
 * lifecycle op's sources never reject (D13), so a dropped one is never an unhandled rejection (I10).
 */
function attempt(fn: () => unknown): unknown {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e;
  }
}

/** Every node on `n`'s stacks, recursively, `n` included. */
function subtree(n: NodeImpl): NodeImpl[] {
  const out = [n];
  for (const s of [n.explicit, n.provided]) for (const e of s) if (e.node) out.push(...subtree(e.node));
  return out;
}

describe('invariants (DESIGN.md §10)', () => {
  // -------------------------------------------------------------------------
  it('I1 single owner: a node is on exactly one stack, own(foreign node) is NotOwnedError; a passive object owned by two nodes is released once by each (D16)', async () => {
    const root = createRootContext();
    const A = root.child({ name: 'A' });
    const B = root.child({ name: 'B' });
    const c = A.child({ name: 'c' });
    const f = A.fork(task(function* () { return yield* never(); }, link));
    const p = A.pool({ name: 'p', onFailure: () => {} });
    const nodes = subtree(impl(root));
    for (const n of [c, f, p]) {
      const holders = nodes.filter((x) => x.explicit.find(n) !== undefined || x.provided.find(n) !== undefined);
      expect(holders).toEqual([impl(A)]);
      expect(() => B.own(n)).toThrow(NotOwnedError); // no transfer of an entry between owners (DESIGN.md §9)
    }
    let disposed = 0;
    const x = { [Symbol.dispose]: () => void disposed++ };
    A.own(x);
    B.own(x);
    await A.release(x);
    expect(disposed).toBe(1);
    expect(impl(B).explicit.find(x)).toBeDefined(); // B's entry stays live
    await B.close();
    expect(disposed).toBe(2);
    await root[Symbol.asyncDispose]();
  });

  // -------------------------------------------------------------------------
  it('I2 once: a node completes once and each release runs once under concurrent abort/close/asyncDispose, releaseAll racing release(x), and abort mid-releaseAll (D16)', async () => {
    const ev = events();
    // (a) the lifecycle quartet, concurrently
    const N = ev.root.child({ name: 'N' });
    let n = 0;
    N.own(async () => {
      await tick();
      n++;
    });
    const ps = [N.close(), N[Symbol.asyncDispose]()];
    N.abort();
    ps.push(N.close(), N[Symbol.asyncDispose]());
    await within(Promise.all(ps));
    expect(n).toBe(1);
    expect(ev.of('node:complete').filter((e) => e.id === N.id)).toHaveLength(1);
    // (b) releaseAll() racing release(x) in a body
    const counts = { x: 0, y: 0 };
    await ev.root.call(function* () {
      const x = own({ [Symbol.asyncDispose]: async () => void counts.x++ });
      own({ [Symbol.asyncDispose]: async () => void counts.y++ });
      yield* wait(Promise.all([releaseAll(), release(x)]));
    });
    expect(counts).toEqual({ x: 1, y: 1 });
    // (c) abort() arriving in the middle of a releaseAll(), whose last release fails. The error is the
    // releaseAll() caller's alone: it is still awaiting when the owner's loop finds both stacks empty, so
    // the owner does not surface it too (DESIGN.md §4.12, I11, D16).
    const M = ev.root.child({ name: 'M' });
    const gate = deferred();
    const m = { a: 0, b: 0 };
    const E = new Error('a failed');
    M.own(function a() {
      m.a++;
      throw E;
    });
    M.own(async function b() {
      await gate.promise;
      m.b++;
    });
    const releasing = M.releaseAll(); // b first, held at the gate
    M.abort(); // the loop finds b in flight and waits on it
    gate.resolve();
    const [all, closed] = await within(Promise.allSettled([releasing, M.close()]));
    expect(all).toEqual({ status: 'rejected', reason: E });
    expect(closed).toEqual({ status: 'fulfilled', value: undefined });
    expect(M.outcome?.status).toBe('aborted'); // not 'defect': the error was the caller's
    expect(m).toEqual({ a: 1, b: 1 });
    expect(ev.of('entry:released').filter((e) => e.id === M.id).map((e) => e.entryName)).toEqual(['b', 'a']);
    expect(ev.of('node:complete').filter((e) => e.id === M.id)).toHaveLength(1);
    // (d) the same with release(x): the loop finds x in flight, and x fails after the caller awaited
    const M2 = ev.root.child({ name: 'M2' });
    const E2 = new Error('x failed');
    const x = M2.own({}, async () => {
      await tick();
      throw E2;
    });
    const releasingX = M2.release(x);
    M2.abort();
    const [one, closed2] = await within(Promise.allSettled([releasingX, M2.close()]));
    expect(one).toEqual({ status: 'rejected', reason: E2 });
    expect(closed2).toEqual({ status: 'fulfilled', value: undefined });
    // (e) (c) with synchronous entries: releaseAll() records a's failure before it returns, and close()
    // finds both stacks empty before the combinator calls releaseAll()'s `then` (D16)
    const M3 = ev.root.child({ name: 'M3' });
    const E3 = new Error('a3 failed');
    M3.own(function b3() {});
    M3.own(function a3() {
      throw E3;
    });
    const [all3, closed3] = await within(Promise.allSettled([M3.releaseAll(), M3.close()]));
    expect(all3).toEqual({ status: 'rejected', reason: E3 });
    expect(closed3).toEqual({ status: 'fulfilled', value: undefined });
    expect(M3.outcome?.status).toBe('success'); // not 'defect': the error was the caller's
    expect(ev.of('entry:released').filter((e) => e.id === M3.id).map((e) => e.entryName)).toEqual(['a3', 'b3']);
    await expect(ev.root.close()).resolves.toBeUndefined(); // neither error surfaces a second time
  });

  // -------------------------------------------------------------------------
  it('I3 explicit before provided (G1): every value is released after every explicit entry, whether it was created before or after them', async () => {
    const t = trace();
    class Service {
      constructor() {
        own(t.at('service'));
      }
    }
    class Late {
      constructor() {
        own(t.at('late service'));
      }
    }
    class Spawned {
      constructor() {
        own(t.at('spawned service'));
      }
    }
    const root = createRootContext();
    root.get(Service); // provided, before any explicit entry
    root.own(t.at('explicit 1'));
    root.get(Late); // provided AFTER an explicit entry: one merged LIFO stack would release it before 'explicit 1'
    root.child().own(t.at('child entry'));
    await root.call(function* () {
      lookup(Service); // read from inside a body: the service outlives it (G1)
      own(t.at('call entry'));
    });
    const gate = deferred();
    let spawned: unknown;
    root.fork(
      task(function* () {
        own(t.at('fork entry'));
        spawned = lookup(Spawned); // first made here, after every explicit entry, by a fork still running at close
        yield* wait(gate.promise);
      }, link),
    );
    await tick();
    expect(spawned).toBeInstanceOf(Spawned);
    expect([...impl(root).provided].map((e) => e.name)).toEqual(['Service', 'Late', 'Spawned']); // hoisted to the root (I17)
    const closing = root.close(); // waits for the fork (DESIGN.md §2.7)
    await tick();
    expect(t.log).toEqual(['call entry']);
    gate.resolve();
    await within(closing);
    expect(t.log).toEqual([
      'call entry', // the call child completed on its own
      'fork entry', // the fork completed when close() let it finish
      'child entry', // explicit, LIFO
      'explicit 1',
      'spawned service', // provided, LIFO, only after the explicit stack is empty
      'late service',
      'service',
    ]);
  });

  // -------------------------------------------------------------------------
  it('I4 unsubscribed hear late: an owned fiber and a pool hear the signal only at their turn in the release loop', async () => {
    const t = trace();
    const root = createRootContext();
    await root.call(function* () {
      const p = pool({ name: 'p', onFailure: () => {} });
      p.signal.addEventListener('abort', () => t.push('pool heard'));
      const reaper = own(fork(function* () { return yield* never(); }));
      reaper.signal.addEventListener('abort', () => t.push('owned fiber heard'));
      const worker = fork(function* () { return yield* never(); });
      worker.signal.addEventListener('abort', () => t.push('subscriber heard'));
      own(t.at('top entry released'));
      yield* wait(tick());
    });
    expect(t.log).toEqual(['subscriber heard', 'top entry released', 'owned fiber heard', 'pool heard']);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I5 LIFO, fixed positions: releasing a middle entry early leaves the others in their order', async () => {
    const t = trace();
    const root = createRootContext();
    await root.call(function* () {
      own(t.at('a'));
      const b = own(t.at('b'));
      own(t.at('c'));
      own(t.at('d'));
      yield* release(b);
    });
    expect(t.log).toEqual(['b', 'd', 'c', 'a']);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I6 once a freeze or restore node is delivered, its body runs no op it yields on its normal path, except one already started; what its own finally yields is release work, never interrupted; the outcome is aborted', async () => {
    const t = trace();
    const root = createRootContext();
    const gate = deferred();
    let workRan = false;
    const f = root.fork(
      task(function* () {
        const x = own({}, () => void t.push('x released'));
        t.push('before');
        yield* wait(gate.promise); // delivered meanwhile: a started wait, which the halt lets finish (row 3)
        t.push('resumed');
        t.push(`late: ${yield* wait(Promise.resolve('started'))}`); // started before it was yielded: run (row 5)
        try {
          yield* call(function* () {
            workRan = true; // never: not started, so not run; the body is returned here (row 4)
          });
          t.push('unreachable');
        } catch {
          t.push('caught'); // never: no catch sees the halt
        } finally {
          t.push('finally');
          yield* sleep(5); // release work: the unwind fiber is never interrupted, so it sleeps its full duration
          t.push('slept in finally');
          yield* release(x);
          t.push('released in finally');
        }
        return 'unreachable';
      }, link),
    );
    await tick();
    f.abort('stop');
    gate.resolve();
    expect(await within(root.result(f))).toEqual({ status: 'aborted', reason: 'stop' }); // by state (D24)
    expect({ log: t.log, workRan }).toEqual({
      log: ['before', 'resumed', 'late: started', 'finally', 'slept in finally', 'x released', 'released in finally'],
      workRan: false,
    });
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I7 closed door: after completion every operation on the node throws NodeCompletedError; the lifecycle quartet is idempotent', async () => {
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    let done: Fiber<number> | undefined;
    await root.call(function* () {
      done = fork(function* () { return 1; });
      yield* join(done);
    });
    for (const n of [root.child(), done!]) {
      if (n.state !== 'complete') await n.close();
      expect(n.state).toBe('complete');
      const t = task(function* () { return 0; });
      const ops: Record<string, () => unknown> = {
        get: () => n.get(K),
        addProvider: () => n.addProvider(valueProvider(K, 'again')),
        own: () => n.own({ [Symbol.dispose]() {} }),
        release: () => n.release({}),
        releaseAll: () => n.releaseAll(),
        fork: () => n.fork(t),
        call: () => n.call(t),
        all: () => n.all([t]),
        race: () => n.race([t]),
        shield: () => n.shield(t),
        pool: () => n.pool({ name: 'p', onFailure: () => {} }),
        child: () => n.child(),
        join: () => n.join(done!),
        result: () => n.result(done!),
        interrupted: () => n.interrupted(),
        never: () => n.never(),
        managed: () => n.wait(Promise.resolve(), { abandon: true }),
        run: () => n.run(() => {}),
        runSync: () => n.runSync(() => {}),
      };
      for (const [name, op] of Object.entries(ops)) expect(attempt(op), `${n.name ?? n.id}.${name}`).toBeInstanceOf(NodeCompletedError);
      expect(() => n.abort()).not.toThrow();
      expect(() => n[Symbol.dispose]()).not.toThrow();
      await expect(n.close()).resolves.toBeUndefined();
    }
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I8 open window: between delivery and completion own/release/fork/child/get work, its own finally may wait, and what is owned then is released at completion', async () => {
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    const gate = deferred();
    const t = trace();
    const seen: Record<string, unknown> = {};
    const f = root.fork(
      task(function* () {
        let z: object | undefined;
        try {
          yield* wait(gate.promise); // the body is delivered meanwhile, resumed when p finishes, and runs plain code
          seen.delivered = signal().aborted;
          const x = own(t.at('owned after delivery'));
          seen.get = lookup(K);
          const g = fork(function* () {
            return yield* never();
          });
          seen.forkBornDelivered = g.signal.aborted;
          const c = child();
          seen.childBornDelivered = c.signal.aborted;
          const y = own(t.at('released early'));
          void release(y); // eager: it runs now, and nobody waits for it
          seen.releasedNow = t.log.includes('released early');
          seen.xLive = impl(current()).explicit.find(x) !== undefined;
          z = own(t.at('released and waited for'));
          yield* never(); // returned here
        } finally {
          yield* release(z!); // its own finally may wait: release work, never interrupted
          seen.shielded = yield* shield(() => lookup(K)); // so may a shield there
        }
      }, link),
    );
    await tick();
    f.abort('stop');
    gate.resolve();
    await root.close();
    expect(seen).toEqual({
      delivered: true,
      get: 'k',
      forkBornDelivered: true,
      childBornDelivered: true,
      releasedNow: true,
      xLive: true,
      shielded: 'k',
    });
    expect(t.log).toEqual(['released early', 'released and waited for', 'owned after delivery']);
    // from outside: own() on a delivered node that is still releasing (C2)
    const other = createRootContext();
    const N = other.child();
    const held = deferred();
    N.own(() => held.promise);
    N.abort();
    expect(N.state).toBe('releasing');
    let late = false;
    N.own(() => void (late = true));
    held.resolve();
    await N.close();
    expect(late).toBe(true);
    await other.close();
  });

  // -------------------------------------------------------------------------
  it('I9 marked before heard: the whole subscribed subtree is marked before any abort listener runs (G4)', async () => {
    const root = createRootContext();
    const seen: boolean[] = [];
    let a: Context | undefined;
    let deep: Context | undefined;
    await root.call(function* () {
      a = fork(function* () { return yield* never(); });
      const b = child();
      deep = b.fork(task(function* () { return yield* never(); }, link));
      a.signal.addEventListener('abort', () => {
        seen.push(impl(b).delivered, impl(deep!).delivered, deep!.signal.aborted);
      });
      yield* wait(tick());
      current().abort();
    }).then(undefined, () => {});
    expect(seen).toEqual([true, true, false]); // marked, not yet fired
    expect(deep?.signal.aborted).toBe(true);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I10 no unhandled rejections from the core’s promises, and a work op nobody consumes never runs: an unjoined failed fork and a dropped join surface as values, a dropped call runs nothing, never an unhandled rejection', async () => {
    const guard = unhandledRejectionGuard()!;
    expect(guard).toBeDefined();
    const before = guard.seen.length;
    const root = createRootContext();
    const err = await rejection(
      root.call(function* () {
        fork(function* () {
          throw new Error('unjoined');
        });
        const f = fork(function* () {
          throw new Error('dropped join');
        });
        void join(f); // runs nothing: f's failure is unjoined, and surfaces from this body's node
        yield* wait(tick(3));
      }),
    );
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message).sort()).toEqual(['dropped join', 'unjoined']);
    let ran = false;
    const dropped = await root.call(function* () {
      void call(function* () {
        ran = true;
        throw new Error('dropped call');
      }); // the yield* was forgotten: the call never runs (no-unused-op reports it)
      yield* wait(tick(2));
      return 'returned';
    });
    expect({ dropped, ran }).toEqual({ dropped: 'returned', ran: false });
    await expect(root.close()).resolves.toBeUndefined();
    await tick(2);
    expect(guard.seen.length).toBe(before);
  });

  // -------------------------------------------------------------------------
  it('I11 consumed once or surfaced: a joined failure does not surface from the parent; an unjoined one surfaces exactly once', async () => {
    const boom = new Error('boom');
    const root = createRootContext();
    await expect(
      root.call(function* () {
        const f = fork(function* () {
          throw boom;
        });
        expect(yield* wait(rejection(join(f)))).toBe(boom);
        expect(impl(current()).unconsumed.size).toBe(0);
      }),
    ).resolves.toBeUndefined();
    // a 'join' fork onto a bodiless node is refused (D14), so the unjoined fork is made from a body
    const parent = root.child();
    const err = await rejection(
      parent.call(function* () {
        fork(function* () {
          throw boom;
        });
        yield* wait(tick()); // bare: let it fail; a body that returned at once would interrupt it unstarted (DESIGN.md §2.4, §4.6)
      }),
    );
    expect(err).toBe(boom); // surfaced from the call fiber's completion
    await expect(parent.close()).resolves.toBeUndefined(); // consumed by that delivery: not again
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I12 aborted is not failure: an aborted fiber fires no destination, does not abort a linked parent, and is excluded from an AggregateError', async () => {
    const root = createRootContext();
    const handled: unknown[] = [];
    const h = root.fork(task(function* () { return yield* never(); }, { onFailure: (e) => void handled.push(e) }));
    const l = root.fork(task(function* () { return yield* never(); }, link));
    await tick();
    h.abort();
    l.abort();
    await tick();
    expect(handled).toEqual([]);
    expect(root.signal.aborted).toBe(false);
    expect(h.outcome?.status).toBe('aborted');
    const boom = new Error('boom');
    const err = await rejection(
      root.call(function* () { return yield* all([
          task(function* () {
            throw boom;
          }),
          task(function* () {
            current().abort('self');
            yield* never();
          }),
        ]); },
      ),
    );
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toEqual([boom]);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I13 state decides: a delivered freeze body is aborted whatever it produced, whatever its finally does; an undelivered one that throws an AbortError has failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // the lost halt below is reported in dev mode
    const root = createRootContext();
    const gate = deferred();
    const returning = root.fork(
      task(function* () {
        yield* wait(gate.promise);
        return 'value';
      }, link),
    );
    const swallowing = root.fork(
      task(function* () {
        try {
          yield* never();
        } finally {
          return 'returned from its finally'; // a lost halt (dev mode reports it); the outcome stays aborted (D24)
        }
      }, link),
    );
    const throwing = root.fork(
      task(function* () {
        yield* wait(gate.promise);
        throw new Error('after delivery');
      }, link),
    );
    const observer = root.fork(
      task(
        function* () {
          yield* wait(gate.promise);
          return 'observed';
        },
        { ...link, interrupt: 'observe' },
      ),
    );
    await tick();
    for (const f of [returning, throwing, swallowing, observer]) f.abort('stop');
    gate.resolve();
    await tick(2);
    expect(returning.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    expect(throwing.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    expect(swallowing.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    expect(observer.outcome).toEqual({ status: 'success', value: 'observed' });
    const abortError = new DOMException('not really', 'AbortError');
    const fake = await root.call(function* () { return yield* result(
        fork(function* () {
          throw abortError;
        }),
      ); },
    );
    expect(fake).toEqual({ status: 'defect', error: abortError }); // never inspected (DESIGN.md §4.12)
    expect(warn.mock.calls.map((c) => /halt of .* was lost/.test(String(c[0])))).toEqual([true]);
    warn.mockRestore();
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I14 every release is a fiber, current while it runs synchronously or steps: kind release, parented to the owner, signal() is its deadline, owner.outcome is readable, across a generator release’s yield*s too', async () => {
    const root = createRootContext();
    const seen: { kind: string; parent: unknown; deadline: AbortSignal; outcome: unknown }[] = [];
    const record = (owner: Context) => () =>
      void seen.push({ kind: impl(current()).kind, parent: impl(current()).parent, deadline: signal(), outcome: owner.outcome });
    let owner: Context | undefined;
    await root.call(
      task(
        function* () {
          owner = current();
          const me = owner;
          own({}, record(me)); // own(value, release)
          own({ [Symbol.asyncDispose]: async () => record(me)() }); // the contract: current until its first await
          own(record(me)); // defer
          own({}, function* () {
            yield* sleep(1);
            record(me)(); // a generator release: current at every step
          });
        },
        { releaseTimeoutMs: 50 },
      ),
    );
    expect(seen).toHaveLength(4);
    for (const s of seen) {
      expect(s.kind).toBe('release');
      expect(s.parent).toBe(owner);
      expect(s.deadline).not.toBe(owner!.signal);
      expect(s.outcome).toEqual({ status: 'success', value: undefined });
    }
    // the deadline fires after releaseTimeoutMs (DESIGN.md §2.4)
    const N = root.child({ releaseTimeoutMs: 20 });
    let fired: unknown;
    N.own(() => {
      const deadline = signal(); // read in the release fiber; the timer's listener runs under no node
      return new Promise<void>((resolve) =>
        deadline.addEventListener('abort', () => {
          fired = deadline.reason;
          resolve();
        }),
      );
    });
    await within(N.close());
    expect((fired as DOMException).name).toBe('TimeoutError');
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I15 synchronous attachment: own, fork, child and pool entries are registered before they return', async () => {
    const ev = events();
    await ev.root.call(function* () {
      const me = current();
      const registered = () => ev.of('entry:registered').filter((e) => e.id === me.id).length;
      const n0 = registered();
      const x = own({ [Symbol.dispose]() {} });
      expect(registered()).toBe(n0 + 1);
      expect(impl(me).explicit.find(x)).toBeDefined();
      const f = fork(function* () { return 1; });
      expect(registered()).toBe(n0 + 2);
      expect(impl(me).explicit.find(f)).toBeDefined();
      const c = child();
      expect(registered()).toBe(n0 + 3);
      expect(impl(me).explicit.find(c)).toBeDefined();
      const p = pool({ name: 'p', onFailure: () => {} });
      expect(registered()).toBe(n0 + 4);
      expect(impl(me).explicit.find(p)).toBeDefined();
      yield* join(f);
    });
    await ev.root.close();
  });

  // -------------------------------------------------------------------------
  it('I16 nothing runs in a creation frame: body-shaped operations throw CreationViolationError in a factory, and a fork made there starts after it returns', async () => {
    // K is a plain provided key: get(K) and lookup(K) succeed outside a creation, so their
    // CreationViolationError here comes from the creation guard alone (ContextKey throws it in any frame, DESIGN.md §4.12).
    const K = createInjectionKey<string>('K');
    const other = createRootContext({ providers: [valueProvider(K, 'other k')] });
    expect(other.get(K)).toBe('other k');
    const seen: Record<string, unknown> = {};
    let forkRan = false;
    let forkRanDuringFactory = false;
    let inFactory = false;
    const t = task(function* () { return 0; });
    class Value {
      constructor() {
        inFactory = true;
        const done = other.fork(task(function* () { return 1; }, link));
        const ops: Record<string, () => unknown> = {
          lookup: () => lookup(K),
          call: () => call(t),
          all: () => all([t]),
          race: () => race([t]),
          join: () => join(done),
          result: () => result(done),
          interrupted: () => interrupted(),
          never: () => never(),
          managed: () => wait(Promise.resolve(), { abandon: true }),
          runSync: () => runSync(() => {}),
          'other.run': () => other.run(() => {}),
          'other.get': () => other.get(K),
          'other.call': () => other.call(t),
        };
        for (const [name, op] of Object.entries(ops)) seen[name] = attempt(op);
        own(
          fork(function* () {
            forkRan = true;
            forkRanDuringFactory = inFactory;
            seen.creationInFork = currentCreation();
          }),
        );
        inFactory = false;
      }
    }
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    await root.call(function* () {
      seen.lookupInBody = lookup(K); // the same lookup outside a creation
    });
    expect(seen.lookupInBody).toBe('k');
    delete seen.lookupInBody;
    root.get(Value);
    expect(forkRan).toBe(false); // not in the factory, not at its return: the fork is a later job, run under an empty frame (DESIGN.md §6)
    await tick();
    expect(Object.keys(seen)).toContain('creationInFork'); // the fork did run …
    for (const [name, v] of Object.entries(seen).filter(([k]) => k !== 'creationInFork'))
      expect(v, name).toBeInstanceOf(CreationViolationError);
    expect(forkRan).toBe(true);
    expect(forkRanDuringFactory).toBe(false); // … after the factory returned
    expect(seen.creationInFork).toBeUndefined(); // … in no creation frame
    await root.close();
    await other.close();
  });

  // -------------------------------------------------------------------------
  it('I17 placement follows dependencies: a default-factory value lands at the deepest context it injected from, and contexts below share it', async () => {
    const Db = createInjectionKey<object>('Db');
    class Repo {
      db = inject(Db);
    }
    class Plain {}
    const root = createRootContext();
    const req = root.child({ name: 'req', providers: [valueProvider(Db, {})] });
    const deeper = req.child();
    const repo = deeper.get(Repo);
    expect(impl(req).cache.get(Repo)?.value).toBe(repo);
    expect(impl(deeper).cache.has(Repo)).toBe(false);
    expect(impl(root).cache.has(Repo)).toBe(false);
    expect(req.child().get(Repo)).toBe(repo);
    const plain = deeper.get(Plain);
    expect(impl(root).cache.get(Plain)?.value).toBe(plain); // no dependencies: shared as widely as possible
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I18 every creation-time read is inject: lookup throws in creation, tracked reads place only auto-hoisted values, the value’s own node is untracked', async () => {
    const Db = createInjectionKey<object>('Db');
    class Borrows {
      constructor() {
        lookup(Db);
      }
    }
    class OwnNodeOnly {
      ctx = inject(ContextKey);
    }
    class Auto {
      db = inject(Db);
    }
    const Declared = createInjectionKey<{ db: object }>('Declared');
    const root = createRootContext({ providers: [valueProvider(Db, {})] });
    const T = root.child({ name: 'T', providers: [factoryProvider(Declared, () => ({ db: inject(Db) }))] });
    expect(() => T.get(Borrows)).toThrow(CreationViolationError);
    expect(() => T.get(Borrows)).toThrow(/lookup\(\) during creation; use inject\(\)/);
    const own_ = T.get(OwnNodeOnly);
    expect(impl(root).cache.get(OwnNodeOnly)?.value).toBe(own_); // reading its own node did not move it
    expect(impl(own_.ctx).parent).toBe(impl(root));
    expect(impl(root).cache.get(OwnNodeOnly)?.deps?.size).toBe(0);
    T.get(Auto);
    expect(impl(root).cache.has(Auto)).toBe(true); // auto-hoisted: placed by its tracked read
    T.get(Declared);
    expect(impl(T).cache.get(Declared)?.autoHoisted).toBe(false); // declared: stays where it was declared
    expect(impl(root).cache.has(Declared)).toBe(false);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I19 decisions are permanent and placement is by view: a context never changes an answer; a hit never crosses a shadow of its dependencies', async () => {
    const K = createInjectionKey<string>('K');
    const A = createInjectionKey<string>('A');
    class B {
      a = inject(A);
    }
    const root = createRootContext({ providers: [valueProvider(A, 'root A')] });
    const c = root.child();
    expect(c.get(K, { optional: true })).toBeUndefined(); // "not provided here" is an answer
    expect(() => c.addProvider(valueProvider(K, 'late'))).toThrow(PlacementError);
    expect(() => root.addProvider(valueProvider(K, 'late'))).toThrow(PlacementError);
    expect(root.child({ providers: [valueProvider(K, 'fresh')] }).get(K)).toBe('fresh'); // a fresh child has no decisions
    // every order of resolution ends in the same state
    const states: string[] = [];
    for (const order of [
      ['P', 'C', 'C2'],
      ['C', 'P', 'C2'],
      ['C2', 'C', 'P'],
    ]) {
      const P = createRootContext({ providers: [valueProvider(A, 'P')] });
      const C = P.child({ providers: [valueProvider(A, 'C')] });
      const C2 = P.child();
      const at = { P, C, C2 } as Record<string, Context>;
      for (const name of order) at[name].get(B);
      states.push(JSON.stringify(['P', 'C', 'C2'].map((name) => [name, impl(at[name]).cache.get(B)?.value])));
      expect(C.get(B).a).toBe('C');
      expect(C2.get(B)).toBe(P.get(B));
      await P.close();
    }
    expect(new Set(states).size).toBe(1);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I20 fork is asynchronous: no part of a forked body runs in the forker’s frame, and the body sees its own node from its first line', async () => {
    const root = createRootContext();
    const log: string[] = [];
    let first: Context | undefined;
    await root.call(function* () {
      const f = fork(function* () {
        first = current();
        log.push('body');
      });
      log.push('after fork');
      expect(log).toEqual(['after fork']);
      yield* join(f);
      expect(first).toBe(f);
    });
    expect(log).toEqual(['after fork', 'body']);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I21 the current node is the default owner: every free function acts on current()', async () => {
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'outer')] });
    await root.call(function* () {
      const me = impl(current());
      const x = own({ [Symbol.dispose]() {} });
      expect(me.explicit.find(x)).toBeDefined();
      const f = fork(function* () { return 1; });
      expect(impl(f).parent).toBe(me);
      expect(impl(child()).parent).toBe(me);
      expect(impl(pool({ name: 'p', onFailure: () => {} })).parent).toBe(me);
      expect(signal()).toBe(me.signal);
      expect(lookup(K)).toBe('outer');
      expect(yield* call(task(() => lookup(K), { providers: [valueProvider(K, 'inner')] }))).toBe('inner');
      expect(yield* join(f)).toBe(1);
      yield* release(x);
      expect(me.explicit.find(x)).toBeUndefined();
    });
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I22 escape fails loudly: a released provided value fails on a cache hit, and a node reference that escaped its lifetime throws on use', async () => {
    class Service {
      ctx: Context = inject(ContextKey);
    }
    const root = createRootContext();
    const svc = root.get(Service);
    svc.ctx.abort(); // the value's node completes; its cache entry stays
    expect(() => root.get(Service)).toThrow(NodeCompletedError);
    let escaped: Context | undefined;
    await root.call(function* () {
      escaped = current();
    });
    expect(() => escaped!.own({ [Symbol.dispose]() {} })).toThrow(NodeCompletedError);
    expect(() => escaped!.fork(function* () {})).toThrow(NodeCompletedError);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I23 every acquisition is releasable early: release(x) for passive entries, fibers, children and pools, and a handle whose release() goes through its owner', async () => {
    const t = trace();
    class Handle implements Disposable {
      constructor(readonly owner: Context) {
        owner.own(this);
      }
      release(): Promise<void> {
        return this.owner.release(this);
      }
      [Symbol.dispose](): void {
        t.push('handle');
      }
    }
    const acquire = (owner: Context = current()) => new Handle(owner);
    const root = createRootContext();
    await root.call(function* () {
      const x = own(t.at('passive'));
      yield* release(x);
      const f = fork(function* () {
        own(t.at('fiber'));
        yield* never();
      });
      yield* wait(tick());
      yield* release(f);
      expect(f.outcome?.status).toBe('aborted');
      const c = child();
      c.own(t.at('child'));
      yield* release(c);
      const p = pool({ name: 'p', onFailure: () => {} });
      p.own(t.at('pool'));
      yield* release(p);
      const h = acquire();
      yield* wait(h.release());
      expect(impl(current()).explicit.size).toBe(0);
    });
    expect(t.log).toEqual(['passive', 'fiber', 'child', 'pool', 'handle']);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I24 only resolution attaches to the provided stack: own() never lands there, and a DI value’s node always does', async () => {
    class Service {
      constructor() {
        own(() => {});
      }
    }
    const root = createRootContext();
    root.own(() => {});
    root.get(Service);
    await root.call(function* () {
      own(() => {});
      expect(impl(current()).provided.size).toBe(0);
    });
    const provided = [...impl(root).provided];
    expect(provided.map((e) => e.node?.kind)).toEqual(['value']);
    const valueNode = provided[0].node!;
    expect(valueNode.explicit.size).toBe(1); // what the constructor owned is on the value node's explicit stack
    expect(valueNode.provided.size).toBe(0);
    expect([...impl(root).explicit].every((e) => e.node === undefined || e.node.kind !== 'value')).toBe(true);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I25 every asynchronous hook is a fiber, or a synchronous re-entry of its node through a ramme wrapper: own(fn) runs inside a release fiber, as does a value release; a failure handler runs in its parent’s frame, and node.run re-enters a node synchronously', async () => {
    const root = createRootContext();
    const kinds: string[] = [];
    let handlerCurrent: Context | undefined;
    await root.call(function* () {
      own(() => void kinds.push(impl(current()).kind));
      own({}, () => void kinds.push(impl(current()).kind));
    });
    const f = root.fork(
      task(
        function* () {
          throw new Error('x');
        },
        { onFailure: () => void (handlerCurrent = current()) },
      ),
    );
    await tick(2);
    expect(kinds).toEqual(['release', 'release']);
    expect(handlerCurrent).toBe(root); // the one callback the design keeps runs with a node current (DESIGN.md §4.7)
    expect(f.outcome?.status).toBe('defect');
    // A platform callback re-enters a node synchronously, and only for its synchronous part (DESIGN.md §6)
    let reentered: Context | undefined;
    let afterAwait: unknown;
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        root.run(() => {
          reentered = current();
          void (async () => {
            await Promise.resolve();
            try {
              current();
            } catch (e) {
              afterAwait = e;
            }
            resolve();
          })();
        });
      }, 0),
    );
    expect(reentered).toBe(root);
    expect(afterAwait).toBeInstanceOf(NoCurrentNodeError);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I26 (gone with lending, D41 decision 2): a work op made and not yet yielded runs nothing, so nothing is lent: while one is made, every body-shaped operation works on the node, and the op runs at its yield*', async () => {
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    const seen: Record<string, unknown> = {};
    let ran = 0;
    const t = task(function* () {
      return 0;
    });
    const Y = root.fork(
      task(function* () {
        const other = fork(function* () {
          return 1;
        });
        yield* join(other);
        const y = current();
        const pending = call(function* () {
          ran++;
          return 'called';
        }); // made, not yielded: nothing runs, nothing is lent
        const ops: Record<string, () => unknown> = {
          get: () => y.get(K),
          call: () => y.call(t),
          fork: () => y.fork(t),
          child: () => y.child(),
          pool: () => y.pool({ name: 'p', onFailure: () => {} }),
          all: () => y.all([t]),
          race: () => y.race([t]),
          shield: () => y.shield(t),
          join: () => y.join(other),
          result: () => y.result(other),
          interrupted: () => y.interrupted(),
          never: () => y.never(),
          wait: () => y.wait(Promise.resolve(), { abandon: true }),
          run: () => y.run(() => {}),
          runSync: () => y.runSync(() => {}),
        };
        for (const [name, op] of Object.entries(ops)) seen[name] = attempt(op);
        seen.ranBeforeYield = ran;
        seen.value = yield* pending;
        seen.ranAfterYield = ran;
      }, link),
    );
    expect(await root.call(function* () { return (yield* result(Y)).status; })).toBe('success');
    expect(seen).toEqual({
      ...Object.fromEntries(['get', 'call', 'fork', 'child', 'pool', 'all', 'race', 'shield', 'join', 'result', 'interrupted', 'never', 'wait', 'run', 'runSync'].map((n) => [n, 'ok'])),
      ranBeforeYield: 0,
      value: 'called',
      ranAfterYield: 1,
    });
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('I27 fibers are not awaitable and tasks are not callable', async () => {
    const root = createRootContext();
    const tk = task(function* (n: number) { return n * 2; });
    // @ts-expect-error a Task has no call signature
    expect(() => tk(1)).toThrow(TypeError);
    await root.call(function* () {
      const f = fork(tk, 21);
      const awaited = yield* wait(rejection(
        (async () => {
          await (f as unknown as Promise<number>);
        })(),
      ));
      expect(awaited).toBeInstanceOf(FiberNotAwaitableError);
      expect(yield* wait(rejection(Promise.resolve(f)))).toBeInstanceOf(FiberNotAwaitableError);
      expect(yield* wait(rejection(Promise.all([f])))).toBeInstanceOf(FiberNotAwaitableError);
      expect(yield* join(f)).toBe(42);
    });
    // an aborted fiber awaited from the top level reports FiberAbortedError: the top level is never interrupted (DESIGN.md §4.2)
    const g = root.fork(task(function* () { return yield* never(); }, link));
    await tick();
    g.abort('stop');
    expect(await rejection(root.join(g))).toBeInstanceOf(FiberAbortedError);
    await root.close();
  });
});
