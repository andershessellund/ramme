// probes.test.ts — one named test per probe. Pn are test ids local to this
// file: they number the probes of the design review of the first extraction,
// which the redesign was checked against.
//   P1 resource-list leak: own/release and fork/join cycles, failing ones included, leave no entries, subscribers or failure records behind.
//   P2 double dispose: asyncDispose twice, close and abort on one node release each entry once, share one completion and complete once.
//   P3 admission after dispose: every operation on a complete node throws NodeCompletedError; the lifecycle four are no-ops.
//   P4 call not yielded by its body: a dropped call is a lazy op that runs nothing (D41), so there is no child for the parent's close() to wait for.
//   P5 creation-context leak into a forked body: a constructor fork starts after the factory returned and sees no creation; inject throws, lookup works, current() is the fiber.
//   P7 order-dependent override / 'No provider' at the root: both resolution orders converge, and PlacementError never depends on sibling activity.
//   P19 enterSync bleed: nothing is current after ctx.run(fn) returns or throws, and a run frame does not leak across await (no async context).
//   P20 shadowed explicit key: a child providing A after an ancestor cached V with A in deps(V) gets V rebuilt by its own view.
//   P21 lazy registration order: a value first looked up by a running fiber lands on the provided stack and is released after the fiber (G1).
//   P22 constructor-forked fiber's parent: it is the value's node at the storage node; the fiber starts after placement and outlives the request.
//   P23 failed factory leaks resources: what a throwing factory owned is released, nothing is cached, the error rethrows, and the next get runs the factory again.
// P6 and P8–P18 have no recorded scenario; their candidate scenarios are
// tested under invariant names in invariants.test.ts.
//
// Written in ramme's idiom (law 2): the free functions of ambient.ts inside
// bodies, the method form only where a node that is not current is named.
import { describe, expect, it } from 'vitest';
import { call, current, fork, join, lookup, never, own, release, result, wait } from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber } from './context.js';
import { currentCreation, currentFrame } from './context-storage.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { inject } from './inject.js';
import { classProvider, valueProvider } from './provider-util.js';
import {
  CreationViolationError,
  NoCurrentNodeError,
  NodeCompletedError,
  PlacementError,
} from './resource.js';
import { deferred, events, impl, micro, tick, trace, within } from './test/util.js';

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

describe('probes', () => {
  // -------------------------------------------------------------------------
  it('P1 resource-list leak: own/release and fork/join cycles leave no entries, subscribers or failure records behind', async () => {
    const root = createRootContext();
    await root.call(function* () {
      const me = impl(current());
      let last: object | undefined;
      for (let i = 0; i < 10_000; i++) {
        const o = { [Symbol.dispose]() {} };
        own(o);
        yield* release(o);
        last = o;
      }
      expect(me.explicit.size).toBe(0);
      expect(me.explicit.find(last!)).toBeUndefined();

      let lastFiber: Fiber<number> | undefined;
      for (let i = 0; i < 10_000; i++) {
        lastFiber = fork(function* () { return i; });
        expect(yield* join(lastFiber)).toBe(i);
      }
      expect(me.explicit.size).toBe(0); // completed fibers are unlinked
      expect(me.subscribers.size).toBe(0);
      expect(impl(lastFiber!).body).toBeUndefined(); // a completed fiber retains no closure (A1)

      const boom = new Error('boom');
      for (let i = 0; i < 10_000; i++) {
        const f = fork(function* () {
          throw boom;
        });
        expect(yield* wait(rejection(join(f)))).toBe(boom);
      }
      expect(me.unconsumed.size).toBe(0); // the record leaves the set at delivery (D16)
      expect(me.subscribers.size).toBe(0);
      expect(me.explicit.size).toBe(0);

      for (let i = 0; i < 1_000; i++) {
        const f = fork(function* () {
          throw boom;
        });
        expect((yield* result(f)).status).toBe('defect');
      }
      expect(me.unconsumed.size).toBe(0);
      expect(me.subscribers.size).toBe(0);
      expect(me.explicit.size).toBe(0);
    });
    expect(impl(root).explicit.size).toBe(0);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('P2 double dispose: asyncDispose ×2, close and abort on one node release each entry once, share one completion and complete once', async () => {
    for (const kind of ['context', 'fiber'] as const) {
      const ev = events();
      let passive = 0;
      let asyncPassive = 0;
      const gate = deferred();
      const N: Context =
        kind === 'context'
          ? ev.root.child({ name: 'N' })
          : ev.root.fork(
              task(
                function* () {
                  yield* never();
                },
                { ...link, name: 'N' },
              ),
            );
      if (kind === 'fiber') await tick();
      N.own(() => void passive++);
      N.own({
        async [Symbol.asyncDispose]() {
          await gate.promise;
          asyncPassive++;
        },
      });
      const all = [N[Symbol.asyncDispose](), N[Symbol.asyncDispose](), N.close()];
      N.abort();
      all.push(N.close());
      // One completion: each promise settles only once N is complete, with node:complete already emitted.
      const at: ({ state: string; logged: number } | undefined)[] = all.map(() => undefined);
      all.forEach((p, i) => {
        const mark = (): void => {
          at[i] = { state: N.state, logged: ev.log.length };
        };
        void p.then(mark, mark);
      });
      await tick(2);
      expect(N.state, kind).toBe('releasing'); // the async entry is held at the gate
      expect(at, kind).toEqual([undefined, undefined, undefined, undefined]); // and nothing has settled
      gate.resolve();
      const outcomes = await within(Promise.allSettled(all));
      const completeAt = ev.log.findIndex((e) => e.id === N.id && e.type === 'node:complete');
      expect(completeAt, kind).toBeGreaterThanOrEqual(0);
      for (const a of at) {
        expect(a?.state, kind).toBe('complete');
        expect(a!.logged, kind).toBeGreaterThan(completeAt);
      }
      expect([passive, asyncPassive], kind).toEqual([1, 1]);
      expect(ev.of('node:complete').filter((e) => e.id === N.id), kind).toHaveLength(1);
      expect(ev.of('entry:released').filter((e) => e.id === N.id), kind).toHaveLength(2);
      // a context's disposal resolves; a fiber's asyncDispose acts as join and reports its abort (DESIGN.md §4.12)
      const statuses = outcomes.map((o) => o.status);
      expect(statuses, kind).toEqual(kind === 'context' ? ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'] : ['rejected', 'rejected', 'fulfilled', 'fulfilled']);
      await ev.root.close();
    }
  });

  // -------------------------------------------------------------------------
  it('P3 admission after dispose: every operation on a complete node throws NodeCompletedError; the lifecycle quartet is a no-op', async () => {
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    let otherFiber: Fiber<number> | undefined;
    await root.call(function* () {
      otherFiber = fork(function* () { return 1; });
      yield* join(otherFiber);
    });
    const c = root.child();
    await c.close();
    expect(c.state).toBe('complete');
    const ops: [string, () => unknown][] = [
      ['get', () => c.get(K)],
      ['own', () => c.own({ [Symbol.dispose]() {} })],
      ['release', () => c.release({})],
      ['fork', () => c.fork(function* () {})],
      ['call', () => c.call(function* () {})],
      ['child', () => c.child()],
      ['pool', () => c.pool({ name: 'p', onFailure: () => {} })],
      ['addProvider', () => c.addProvider(valueProvider(K, 'again'))],
      ['run', () => c.run(() => {})],
      ['join', () => c.join(otherFiber!)],
    ];
    for (const [name, op] of ops) expect(op, name).toThrow(NodeCompletedError);
    expect(() => c.abort()).not.toThrow();
    await expect(c.close()).resolves.toBeUndefined();
    expect(() => c[Symbol.dispose]()).not.toThrow();
    await expect(c[Symbol.asyncDispose]()).resolves.toBeUndefined();
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('P4 call not yielded by its body: a dropped call is a lazy op that runs nothing, so no child exists for the parent to wait for; the body goes on, lookup works, and close() completes', async () => {
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    const gate = deferred();
    let child: Context | undefined;
    let looked: string | undefined;
    const t = trace();
    root.fork(
      task(function* () {
        void call(function* () {
          child = current();
          yield* wait(gate.promise);
          t.push('child finished');
        }); // the yield* was forgotten (eslint-plugin-ramme's no-unused-op reports it)
        looked = lookup(K);
        t.push('body returned');
      }, link),
    );
    await tick();
    await within(root.close()); // nothing to wait for: the call never ran
    expect({ child, looked, log: t.log }).toEqual({ child: undefined, looked: 'k', log: ['body returned'] });
  });

  // -------------------------------------------------------------------------
  it('P5 creation context leak into a spawned body: a constructor fork starts after the factory returned and sees no creation, inject throws, lookup works, current() is the fiber', async () => {
    const Name = createInjectionKey<string>('Name');
    let factoryReturned = false;
    const seen: {
      started?: boolean;
      creation?: unknown;
      frameCreation?: unknown;
      inject?: unknown;
      lookup?: string;
      current?: Context;
    } = {};
    let fiber: Fiber<void> | undefined;
    class Service {
      constructor() {
        fiber = own(
          fork(function* () {
            seen.started = factoryReturned;
            seen.creation = currentCreation();
            seen.frameCreation = currentFrame()?.creation;
            try {
              inject(Name);
            } catch (e) {
              seen.inject = e;
            }
            seen.lookup = lookup(Name);
            seen.current = current();
          }),
        );
      }
    }
    const root = createRootContext({ providers: [valueProvider(Name, 'n')] });
    root.get(Service);
    factoryReturned = true;
    expect(seen.started).toBeUndefined(); // not one line of the body ran in the creation frame (I16, I20)
    await tick();
    expect(seen.started).toBe(true);
    expect(seen.creation).toBeUndefined();
    expect(seen.frameCreation).toBeUndefined();
    expect(seen.inject).toBeInstanceOf(CreationViolationError);
    expect(seen.lookup).toBe('n');
    expect(seen.current).toBe(fiber);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('P7 order-dependent override / "No provider" at root: both orders converge, no "No provider" when Database has a default, and PlacementError never depends on sibling activity', async () => {
    class Database {}
    class UserRepo {
      db = inject(Database);
    }
    for (const order of ['child first', 'root first'] as const) {
      const root = createRootContext();
      const child = root.child({ providers: [classProvider(Database)] });
      const got =
        order === 'child first'
          ? { child: child.get(UserRepo), root: root.get(UserRepo) }
          : { root: root.get(UserRepo), child: child.get(UserRepo) };
      expect(got.child, order).not.toBe(got.root);
      expect(got.child.db, order).toBe(child.get(Database));
      expect(got.root.db, order).toBe(root.get(Database));
      expect(child.get(UserRepo), order).toBe(got.child); // memoized: answers never change (I19)
      expect(root.get(UserRepo), order).toBe(got.root);
      await root.close();
    }
    // The root never answered for UserRepo while only children did: providing it there is allowed (DESIGN.md §3.4).
    const root = createRootContext();
    const a = root.child({ providers: [classProvider(Database)] });
    const b = root.child({ providers: [classProvider(Database)] });
    a.get(UserRepo);
    b.get(UserRepo);
    expect(() => root.addProvider({ key: UserRepo, provide: () => new UserRepo() })).not.toThrow();
    expect(root.get(UserRepo)).not.toBe(a.get(UserRepo));
    // ...and once the root has answered, providing there is refused, whatever the siblings did.
    expect(() => root.addProvider({ key: UserRepo, provide: () => new UserRepo() })).toThrow(PlacementError);
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('P19 enterSync bleed: after ctx.run(fn) returns or throws nothing is current, there is no sync stack, a run frame does not leak across await, and async work started inside run has no node after its first await (no async context, D41)', async () => {
    const root = createRootContext();
    expect(() => current()).toThrow(NoCurrentNodeError);
    expect(root.run(() => current())).toBe(root);
    expect(() => current()).toThrow(NoCurrentNodeError);
    expect(() =>
      root.run(() => {
        throw new Error('inside');
      }),
    ).toThrow('inside');
    expect(() => current()).toThrow(NoCurrentNodeError);
    expect(currentFrame()).toBeUndefined();
    // nested runs restore the outer frame, then nothing
    const c = root.child();
    root.run(() => {
      c.run(() => expect(current()).toBe(c));
      expect(current()).toBe(root);
    });
    expect(currentFrame()).toBeUndefined();
    // async work started inside run sees run's node before its first await, and nothing after it: the slot is
    // synchronous, and ramme has no async context (D41, decision 18); the caller's continuation sees nothing either
    let inner: Promise<Context> | undefined;
    let before: Context | undefined;
    root.run(() => {
      inner = (async () => {
        before = current();
        await micro();
        return current();
      })();
    });
    await micro();
    expect(currentFrame()).toBeUndefined();
    expect(before).toBe(root);
    await expect(inner).rejects.toThrow(NoCurrentNodeError);
    expect(currentFrame()).toBeUndefined();
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('P20 shadowed explicit key: a child providing A after an ancestor cached V with A ∈ deps(V) gets V rebuilt by its view', async () => {
    const A = createInjectionKey<{ tag: string }>('A');
    class V {
      a = inject(A);
    }
    const aRoot = { tag: 'root' };
    const aChild = { tag: 'child' };
    const root = createRootContext({ providers: [valueProvider(A, aRoot)] });
    const vRoot = root.get(V);
    expect(vRoot.a).toBe(aRoot);
    const child = root.child({ providers: [valueProvider(A, aChild)] });
    const vChild = child.get(V);
    expect(vChild).not.toBe(vRoot);
    expect(vChild.a).toBe(aChild); // the dependency inside the rebuilt value is the child's own
    expect(vRoot.a).toBe(aRoot);
    expect(child.get(V)).toBe(vChild);
    expect(root.child().get(V)).toBe(vRoot); // a sibling without the override shares V@root
    await root.close();
  });

  // -------------------------------------------------------------------------
  it('P21 lazy registration order: a value first looked up by a running fiber lands on the provided stack of its deepest dependency and is released after the fiber (G1)', async () => {
    const t = trace();
    const Config = createInjectionKey<string>('Config');
    class Pool {
      config = inject(Config);
      constructor() {
        own(t.at('pool'));
      }
    }
    class Cache {
      config = inject(Config);
      constructor() {
        own(t.at('cache'));
      }
    }
    const app = createRootContext();
    const svc = app.child({ name: 'svc', providers: [valueProvider(Config, 'cfg')] });
    const gate = deferred();
    // A is forked before Pool exists and requests it last; B requests Cache first.
    svc.fork(
      task(function* () {
        yield* wait(gate.promise);
        lookup(Pool);
        own(t.at('fiber A'));
        yield* never();
      }, link),
    );
    svc.fork(
      task(function* () {
        lookup(Cache);
        own(t.at('fiber B'));
        gate.resolve();
        yield* never();
      }, link),
    );
    await tick();
    expect([...impl(svc).provided].map((e) => e.name)).toEqual(['Cache', 'Pool']); // creation order, at the deepest dependency
    expect(impl(app).provided.size).toBe(0);
    await app[Symbol.asyncDispose]();
    expect(t.log.slice(0, 2).sort()).toEqual(['fiber A', 'fiber B']); // every fiber first (G1)
    expect(t.log.slice(2)).toEqual(['pool', 'cache']); // then provided LIFO: reverse creation order
  });

  // -------------------------------------------------------------------------
  it("P22 constructor-spawned fiber parented to requester: the fiber's parent is the value's node at the storage context; it starts after placement and outlives the request fiber", async () => {
    const ev = events();
    const root = ev.root;
    let svcFiber: Context | undefined;
    class Service {
      constructor() {
        own(
          fork(function* () {
            svcFiber = current();
            yield* never();
          }),
        );
      }
    }
    let request: Context | undefined;
    await root.call(
      task(
        function* () {
          request = current();
          lookup(Service);
          yield* wait(tick());
        },
        { name: 'request' },
      ),
    );
    expect(request?.state).toBe('complete');
    const entry = impl(root).cache.get(Service)!;
    const valueNode = entry.valueNode!;
    expect(valueNode.parent).toBe(impl(root)); // placed at the storage context, not under the request
    expect(impl(svcFiber!).parent).toBe(valueNode);
    expect(svcFiber?.state).toBe('running'); // outlives the request fiber
    const placed = ev.of('node:placed').find((e) => e.id === valueNode.id)!;
    const started = ev.of('node:started').find((e) => e.id === svcFiber!.id)!;
    expect(started.seq).toBeGreaterThan(placed.seq);
    await root.close();
    expect(svcFiber?.outcome?.status).toBe('aborted');
  });

  // -------------------------------------------------------------------------
  it('P23 failed factory leaks resources: what a throwing factory owned is released, nothing is held or cached, the error rethrows, the next get runs the factory again', async () => {
    let runs = 0;
    const released: number[] = [];
    class Flaky {
      constructor() {
        const run = ++runs;
        own(() => void released.push(run));
        if (run === 1) throw new Error('first attempt');
      }
    }
    const root = createRootContext();
    expect(() => root.get(Flaky)).toThrow('first attempt');
    expect(released).toEqual([1]);
    expect(impl(root).cache.has(Flaky)).toBe(false);
    expect(impl(root).provided.size).toBe(0);
    expect(impl(root).explicit.size).toBe(0);
    const ok = root.get(Flaky);
    expect(runs).toBe(2);
    expect(root.get(Flaky)).toBe(ok);
    await root.close();
    expect(released).toEqual([1, 2]);
  });
});
