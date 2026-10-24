// placement-view.test.ts — permanent decisions and placement by view
// (DESIGN.md §3.4, I19), decided markers, deps(V) including optional misses
// and scope shadows (D10′), scoped hits (DESIGN.md §3.1), the order-dependent
// "No provider" at the root, a shadowed explicit key, lazy registration order,
// captureAutoScoped, stale provided values (I22), D7.
//
// `lookup` and `own` are the free functions of ambient.ts (`./ambient.js`).
import { afterEach, describe, expect, it, vi } from 'vitest';
import './node.js';
import { createInjectionKey, getKeyDescription } from './context-key.js';
import type { InjectionKey } from './context-key.js';
import type { Context } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { ContextKey, inject } from './inject.js';
import { classProvider, factoryProvider, valueProvider } from './provider-util.js';
import { NodeCompletedError, PlacementError } from './resource.js';
import { SelfScope, createScope } from './scope.js';
import { lookup, own } from './ambient.js';
import { deferred, here, impl, tick, trace } from './test/util.js';

const linked = { onFailure: 'link' } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The DESIGN.md §3.4 traces: A provided at P and at C, B injects A, D injects B
// ---------------------------------------------------------------------------

function world() {
  const A = createInjectionKey<string>('A');
  class B {
    a = inject(A);
  }
  class D {
    b = inject(B);
  }
  const root = createRootContext({ name: 'root' });
  const P = root.child({ name: 'P', providers: [valueProvider(A, 'A@P')] });
  const C = P.child({ name: 'C', providers: [valueProvider(A, 'A@C')] });
  const C2 = P.child({ name: 'C2' });
  return { A, B, D, root, P, C, C2 };
}
type World = ReturnType<typeof world>;

/** What each context caches, described by the view each value was built from. */
function snapshot(w: World): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [label, ctx] of Object.entries({ root: w.root, P: w.P, C: w.C, C2: w.C2 })) {
    const cache = impl(ctx).cache;
    const row: Record<string, string> = {};
    for (const [key, entry] of cache) {
      const v = entry.value;
      row[getKeyDescription(key as InjectionKey<unknown>)] =
        v instanceof w.D
          ? `D(B(${v.b.a}))${v.b === cache.get(w.B)?.value ? ' shares the B cached here' : ''}`
          : v instanceof w.B
            ? `B(${v.a})`
            : String(v);
    }
    out[label] = row;
  }
  return out;
}

const OPS: Record<string, (w: World) => unknown> = {
  'C.get(B)': (w) => w.C.get(w.B),
  'P.get(B)': (w) => w.P.get(w.B),
  'C2.get(B)': (w) => w.C2.get(w.B),
  'C.get(D)': (w) => w.C.get(w.D),
  'P.get(D)': (w) => w.P.get(w.D),
};

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

describe('placement by view (DESIGN.md §3.4)', () => {
  it('C first, then P: B@C and B@P, each built from its own A', () => {
    const w = world();
    const bc = w.C.get(w.B);
    const bp = w.P.get(w.B);
    expect(bc.a).toBe('A@C');
    expect(bp.a).toBe('A@P');
    expect(impl(w.C).cache.get(w.B)?.value).toBe(bc);
    expect(impl(w.P).cache.get(w.B)?.value).toBe(bp);
  });

  it('P first, then C: C hits B@P across its own A and re-creates B@C', () => {
    const w = world();
    const bp = w.P.get(w.B);
    const bc = w.C.get(w.B);
    expect(bc).not.toBe(bp);
    expect(bc.a).toBe('A@C');
    expect(w.P.get(w.B)).toBe(bp); // the P answer never changes (I19)
    expect(w.C.get(w.B)).toBe(bc); // memoized at C (D10′: S′ = C, which provides A itself)
  });

  it('a sibling without the override shares B@P (no shadow between)', () => {
    const w = world();
    const bp = w.P.get(w.B);
    w.C.get(w.B);
    expect(w.C2.get(w.B)).toBe(bp);
    expect(impl(w.C2).cache.size).toBe(0);
  });

  it('transitively: D resolved from C after D@P exists re-creates D@C and, inside its factory, B@C', () => {
    const w = world();
    const dp = w.P.get(w.D);
    expect(dp.b.a).toBe('A@P');
    const dc = w.C.get(w.D);
    expect(dc).not.toBe(dp);
    expect(dc.b.a).toBe('A@C');
    expect(impl(w.C).cache.get(w.B)?.value).toBe(dc.b);
    expect(impl(w.C).cache.get(w.D)?.deps).toEqual(new Set([w.B, w.A])); // deps(D) is transitive
  });

  it('every order of resolution ends in the same state (all 120 permutations)', () => {
    const expected = {
      root: {},
      P: { A: 'A@P', B: 'B(A@P)', D: 'D(B(A@P)) shares the B cached here' },
      C: { A: 'A@C', B: 'B(A@C)', D: 'D(B(A@C)) shares the B cached here' },
      C2: {},
    };
    const orders = permutations(Object.keys(OPS));
    expect(orders).toHaveLength(120);
    for (const order of orders) {
      const w = world();
      for (const op of order) OPS[op](w);
      expect(snapshot(w), order.join(', ')).toEqual(expected);
    }
  });

  it('a child providing A after an ancestor cached auto-hoisted V with A in deps(V) gets V rebuilt by its view', () => {
    const A = createInjectionKey<{ tag: string }>('A');
    class V {
      a = inject(A);
    }
    const aRoot = { tag: 'root' };
    const aChild = { tag: 'child' };
    const root = createRootContext({ providers: [valueProvider(A, aRoot)] });
    const v = root.get(V);
    const child = root.child({ providers: [valueProvider(A, aChild)] });
    const vc = child.get(V);
    expect(vc).not.toBe(v);
    expect(vc.a).toBe(aChild); // identity of the dependency inside the rebuilt value
    expect(v.a).toBe(aRoot);
    expect(root.get(V)).toBe(v);
    expect(child.get(V)).toBe(vc);
  });

  it('a shadow on a deeper requester is placed at or below the shadow (D10′: S′, not R)', () => {
    const A = createInjectionKey<string>('A');
    class V {
      a = inject(A);
    }
    const root = createRootContext({ providers: [valueProvider(A, 'root')] });
    root.get(V);
    const shadow = root.child({ name: 'shadow', providers: [valueProvider(A, 'shadow')] });
    const leaf = shadow.child().child();
    const v = leaf.get(V);
    expect(v.a).toBe('shadow');
    expect(impl(shadow).cache.get(V)?.value).toBe(v); // S′ = the deepest dependency of leaf's view
    expect(shadow.child().get(V)).toBe(v); // every requester under S′ with the same view shares it
  });

  it('a re-creation whose factory injects different keys than the first run throws PlacementError (D7)', () => {
    const A = createInjectionKey<string>('A');
    const Bk = createInjectionKey<string>('B');
    let runs = 0;
    class V {
      b = inject(Bk);
      a = runs++ === 0 ? inject(A) : undefined;
    }
    const root = createRootContext();
    const P = root.child({ providers: [valueProvider(A, 'a@P'), valueProvider(Bk, 'b@P')] });
    const v = P.get(V);
    const C = P.child({ providers: [valueProvider(A, 'a@C')] });
    // C's view shadows A, so V is re-created from C; this run injects {B} where the first injected {B, A}.
    let err: unknown;
    try {
      C.get(V);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PlacementError);
    expect(String(err)).toMatch(/must inject the same keys/);
    expect(runs).toBe(2);
    expect(impl(C).cache.has(V)).toBe(false); // nothing cached at C
    expect(P.get(V)).toBe(v); // P's answer is unchanged (I19)
  });

  it('a re-creation that injects the same keys is placed by the requester’s view, with no error', () => {
    const A = createInjectionKey<string>('A');
    class V {
      a = inject(A);
    }
    const root = createRootContext();
    const P = root.child({ providers: [valueProvider(A, 'a@P')] });
    const v = P.get(V);
    const C = P.child({ providers: [valueProvider(A, 'a@C')] });
    const vc = C.get(V);
    expect(vc).not.toBe(v);
    expect(vc.a).toBe('a@C');
    expect(impl(C).cache.get(V)?.value).toBe(vc);
  });
});

// ---------------------------------------------------------------------------
// Decided markers
// ---------------------------------------------------------------------------

describe('decided markers (DESIGN.md §3.4)', () => {
  function chain() {
    const A = createInjectionKey<string>('A');
    class V {
      a = inject(A);
    }
    const root = createRootContext({ name: 'root' });
    const P = root.child({ name: 'P', providers: [valueProvider(A, 'a')] });
    const M = P.child({ name: 'M' });
    const R = M.child({ name: 'R' });
    return { A, V, root, P, M, R };
  }

  it('addProvider(K) anywhere on R..S after R resolved K is a PlacementError; above S and on a fresh child it is allowed', () => {
    const { V, root, P, M, R } = chain();
    R.get(V); // V@P
    expect(impl(P).cache.has(V)).toBe(true);
    for (const c of [R, M, P]) {
      expect(() => c.addProvider(classProvider(V)), c.name).toThrow(PlacementError);
      expect(() => c.addProvider(classProvider(V)), c.name).toThrow(/already been decided/);
    }
    expect(() => root.addProvider(classProvider(V))).not.toThrow(); // above S: root never answered for V
    expect(() => R.child().addProvider(classProvider(V))).not.toThrow(); // a fresh child has no decisions
  });

  it("answering V decides deps(V) on the walk: providing one of V's dependencies there is a PlacementError", () => {
    const { A, V, P, M, R } = chain();
    R.get(V);
    expect(() => M.addProvider(valueProvider(A, 'x'))).toThrow(PlacementError);
    expect(() => R.addProvider(valueProvider(A, 'x'))).toThrow(PlacementError);
    // a sibling that has not resolved V yet may still override A
    const sibling = P.child();
    expect(() => sibling.addProvider(valueProvider(A, 'x'))).not.toThrow();
  });

  it("answering V decides the dependencies only V's creation saw: a per-creation SelfScope key and a skipSelf read", () => {
    // A SelfScope dependency is resolved per creation and marks nothing itself (resolveSelf); V's placement does.
    const Self = createInjectionKey<object>('Self', { scope: SelfScope, factory: () => ({}) });
    class V {
      self = inject(Self);
    }
    const root = createRootContext({ name: 'root' });
    const R = root.child({ name: 'R' });
    R.get(V); // pinned at R (DESIGN.md §3.4)
    expect(() => R.addProvider(factoryProvider(Self, () => ({})))).toThrow(PlacementError);
    expect(() => R.addProvider(factoryProvider(Self, () => ({})))).toThrow(/already been decided/);
    // A skipSelf read resolves from R's parent, so its own walk never marks R; V's placement does.
    const K = createInjectionKey<string>('K', { factory: () => 'default' });
    class W {
      k = inject(K, { skipSelf: true });
    }
    const R2 = root.child({ name: 'R2' });
    R2.get(W); // pinned at R2 (DESIGN.md §3.4)
    expect(impl(R2).cache.get(W)?.deps?.has(K)).toBe(true);
    expect(() => R2.addProvider(valueProvider(K, 'x'))).toThrow(PlacementError);
    expect(() => R2.addProvider(valueProvider(K, 'x'))).toThrow(/already been decided/);
  });

  it("addProvider of a dependency of an auto-hoisted hit is a PlacementError for the requester that hit", () => {
    const { A, V, P, R } = chain();
    R.get(V); // V@P
    const R2 = P.child({ name: 'R2' });
    const R3 = P.child({ name: 'R3' });
    expect(R2.get(V)).toBe(R.get(V)); // a hit at P
    expect(() => R2.addProvider(valueProvider(A, 'x'))).toThrow(PlacementError); // deps(V) were marked by the hit
    expect(() => R3.addProvider(valueProvider(A, 'x'))).not.toThrow(); // R3 never resolved V
  });

  it('a negative decision: an optional miss decides the key on the whole walk', () => {
    const K = createInjectionKey<string>('K');
    const root = createRootContext();
    const child = root.child();
    expect(child.get(K, { optional: true })).toBeUndefined();
    expect(() => root.addProvider(valueProvider(K, 'late'))).toThrow(PlacementError);
    expect(() => child.addProvider(valueProvider(K, 'late'))).toThrow(PlacementError);
    const sibling = root.child({ providers: [valueProvider(K, 'fresh')] }); // construction-time: allowed
    expect(sibling.get(K)).toBe('fresh');
  });

  it('a scoped provider below its scope owner is a PlacementError, at addProvider and at child({ providers })', () => {
    const σ = createScope('app');
    const K = createInjectionKey<string>('K', { scope: σ });
    const K2 = createInjectionKey<string>('K2');
    const root = createRootContext({ scopes: [σ] });
    const child = root.child();
    expect(() => child.addProvider(valueProvider(K, 'x'))).toThrow(PlacementError);
    expect(() => child.addProvider(valueProvider(K, 'x'))).toThrow(/above this context/);
    expect(() => root.child({ providers: [valueProvider(K, 'x')] })).toThrow(PlacementError);
    expect(() => root.child({ providers: [valueProvider(K2, 'x', { scope: σ })] })).toThrow(PlacementError); // provider-level scope
    expect(() => root.child({ scopes: [σ], providers: [valueProvider(K, 'x')] })).not.toThrow(); // at its own owner
    expect(() => root.addProvider(valueProvider(K, 'x'))).not.toThrow();
  });

  it('decisions are cleared at completion', async () => {
    const K = createInjectionKey<string>('K');
    const c = createRootContext().child();
    c.get(K, { optional: true });
    expect(impl(c).decided.has(K)).toBe(true);
    await c.close();
    expect(impl(c).decided.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deps(V): optional misses and scope shadows (D10′), scoped hits (DESIGN.md §3.1)
// ---------------------------------------------------------------------------

describe('deps(V)', () => {
  it('an optional miss is a dependency (D10′): a fresh child that provides it rebuilds V', () => {
    const K = createInjectionKey<string>('K');
    class V {
      k = inject(K, { optional: true });
    }
    const root = createRootContext();
    const v = root.get(V);
    expect(v.k).toBeUndefined();
    expect(impl(root).cache.get(V)?.deps?.has(K)).toBe(true); // V lands at the root, K in deps(V)
    const child = root.child({ providers: [valueProvider(K, 'k@child')] });
    const vc = child.get(V);
    expect(vc).not.toBe(v);
    expect(vc.k).toBe('k@child');
    expect(root.get(V)).toBe(v); // the root still serves its own instance
    expect(() => root.addProvider(valueProvider(K, 'late'))).toThrow(PlacementError); // the miss was a decision
  });

  it('a nested scope owner shadows a scoped dependency (D10′): V is rebuilt from the nested owner’s D', () => {
    const σ = createScope('tenant');
    let n = 0;
    const Dk = createInjectionKey<string>('D', { factory: () => `D${++n}`, scope: σ });
    class V {
      d = inject(Dk);
    }
    const root = createRootContext();
    const T = root.child({ name: 'T', scopes: [σ] });
    const vt = T.get(V);
    expect(vt.d).toBe('D1');
    expect(impl(T).cache.get(V)?.value).toBe(vt); // V's deepest dependency is D@T
    const mid = T.child({ name: 'mid' });
    const C = mid.child({ name: 'C', scopes: [σ] });
    const vc = C.get(V);
    expect(vc).not.toBe(vt);
    expect(vc.d).toBe('D2');
    expect(C.get(Dk)).toBe('D2');
    expect(impl(C).cache.get(V)?.value).toBe(vc);
    expect(mid.get(V)).toBe(vt); // mid is under T and owns no σ: T's view
  });

  it('the same in the other order', () => {
    const σ = createScope('tenant');
    let n = 0;
    const Dk = createInjectionKey<string>('D', { factory: () => `D${++n}`, scope: σ });
    class V {
      d = inject(Dk);
    }
    const root = createRootContext();
    const T = root.child({ scopes: [σ] });
    const C = T.child().child({ scopes: [σ] });
    const vc = C.get(V);
    const vt = T.get(V);
    expect([vc.d, vt.d]).toEqual(['D1', 'D2']);
    expect(vc).not.toBe(vt);
  });

  it('a provider-level scope is a scope shadow too, wherever the provider sits (D10′)', () => {
    const σ = createScope('request');
    let n = 0;
    const Dk = createInjectionKey<{ n: number }>('D');
    class V {
      d = inject(Dk);
    }
    const root = createRootContext({ providers: [factoryProvider(Dk, () => ({ n: ++n }), { scope: σ })] });
    const r1 = root.child({ name: 'r1', scopes: [σ] });
    const v1 = r1.get(V);
    expect(v1.d.n).toBe(1);
    const r2 = r1.child({ name: 'r2', scopes: [σ] }); // a nested owner of the provider's scope
    const v2 = r2.child().get(V);
    expect(v2).not.toBe(v1);
    expect(v2.d.n).toBe(2);
    expect(v2.d).toBe(r2.get(Dk));
    expect(r1.child().get(V)).toBe(v1);
  });
});

describe('scoped cache hits are served only to requesters of the same scope owner', () => {
  it('nested owners of one scope: the outer value is never served below the inner owner, in either order', () => {
    const σ = createScope('request');
    for (const order of ['outer first', 'inner first'] as const) {
      let n = 0;
      const ID = createInjectionKey<string>('ID', { factory: () => `id${++n}`, scope: σ });
      const root = createRootContext();
      const outer = root.child({ scopes: [σ] });
      const inner = outer.child({ scopes: [σ] });
      const below = inner.child();
      const ids =
        order === 'outer first'
          ? { outer: outer.get(ID), below: below.get(ID) }
          : { below: below.get(ID), outer: outer.get(ID) };
      expect(ids.outer, order).not.toBe(ids.below);
      expect(inner.get(ID), order).toBe(ids.below);
      expect(outer.child().get(ID), order).toBe(ids.outer);
    }
  });

  it('a SelfScope boundary below another one gets its own value whichever resolves first', () => {
    let counter = 0;
    const KEY = createInjectionKey<number>('SelfKey', { factory: () => ++counter, scope: SelfScope });
    const root = createRootContext({ scopes: [SelfScope] });
    const child = root.child({ scopes: [SelfScope] });
    expect(root.get(KEY)).toBe(1);
    expect(child.get(KEY)).toBe(2); // not root's 1
    expect(child.child().get(KEY)).toBe(2);
    expect(root.get(KEY)).toBe(1);
  });

  it('the inner owner uses the provider found above the outer owner', () => {
    const σ = createScope('request');
    const Kk = createInjectionKey<{ n: number }>('K');
    let n = 0;
    const root = createRootContext({ providers: [factoryProvider(Kk, () => ({ n: ++n }), { scope: σ })] });
    const outer = root.child({ scopes: [σ] });
    const inner = outer.child({ scopes: [σ] });
    expect(outer.get(Kk).n).toBe(1);
    expect(inner.get(Kk).n).toBe(2);
    expect(impl(inner).cache.get(Kk)?.scope).toBe(σ);
  });
});

// ---------------------------------------------------------------------------
// The order-dependent "No provider" at the root, lazy registration order, captureAutoScoped, I22
// ---------------------------------------------------------------------------

describe('order-dependent override and "No provider" at the root', () => {
  it('child provides Database, child.get(UserRepo); then root.addProvider(UserRepo) is allowed and builds a root instance', () => {
    class Database {}
    class UserRepo {
      db = inject(Database);
    }
    const root = createRootContext();
    const child = root.child({ providers: [classProvider(Database)] });
    const atChild = child.get(UserRepo);
    root.addProvider({ key: UserRepo, provide: () => new UserRepo() });
    const atRoot = root.get(UserRepo);
    expect(atRoot).not.toBe(atChild);
    expect(atRoot.db).toBe(root.get(Database));
  });

  it('both orders converge when Database has a default; neither ever reports "No provider"', () => {
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
      expect(impl(child).cache.get(UserRepo)?.value, order).toBe(got.child);
      expect(impl(root).cache.get(UserRepo)?.value, order).toBe(got.root);
    }
  });

  it('"No provider" only when the dependency has no default at the root', () => {
    const Database = createInjectionKey<object>('Database');
    class UserRepo {
      db = inject(Database);
    }
    const root = createRootContext();
    const child = root.child({ providers: [valueProvider(Database, {})] });
    child.get(UserRepo);
    expect(() => root.get(UserRepo)).toThrow('No provider found for Database');
  });

  it('PlacementError at the root never depends on sibling activity', () => {
    class Database {}
    class UserRepo {
      db = inject(Database);
    }
    const root = createRootContext();
    const a = root.child({ providers: [classProvider(Database)] });
    const b = root.child({ providers: [classProvider(Database)] });
    a.get(UserRepo);
    b.get(UserRepo);
    expect(() => root.addProvider({ key: UserRepo, provide: () => new UserRepo() })).not.toThrow();
  });
});

describe('lazy registration order', () => {
  it('a value first requested by a running fiber is placed on the provided stack of its deepest dependency and released after the fiber (G1); provided LIFO follows creation order', async () => {
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
    // A is forked first but requests Pool last; B is forked second and requests Cache first.
    const a = svc.fork(
      task(async () => {
        await gate.promise;
        lookup(Pool);
        here().own(t.at('fiber A'));
        await here().never();
      }, linked),
    );
    const b = svc.fork(
      task(async () => {
        lookup(Cache);
        here().own(t.at('fiber B'));
        gate.resolve();
        await here().never();
      }, linked),
    );
    await tick();
    expect([...impl(svc).provided].map((e) => e.name)).toEqual(['Cache', 'Pool']); // creation order, at the deepest dependency
    expect(impl(app).provided.size).toBe(0);
    svc.abort();
    await svc.close();
    expect(t.log.slice(0, 2).sort()).toEqual(['fiber A', 'fiber B']); // every explicit entry first (G1)
    expect(t.log.slice(2)).toEqual(['pool', 'cache']); // then provided LIFO: reverse creation order
    expect([a.outcome?.status, b.outcome?.status]).toEqual(['aborted', 'aborted']);
    await app.close();
  });
});

describe('captureAutoScoped', () => {
  it('clamps placement to the boundary and gives each captured child a fresh instance', async () => {
    class Svc {}
    const X = createInjectionKey<string>('X');
    class Deep {
      x = inject(X);
    }
    const root = createRootContext();
    const t1 = root.child({ captureAutoScoped: true });
    const below = t1.child();
    const s1 = below.get(Svc);
    expect(impl(t1).cache.get(Svc)?.value).toBe(s1); // clamped up to the boundary, not hoisted to the root
    expect(impl(root).cache.has(Svc)).toBe(false);
    const t2 = root.child({ captureAutoScoped: true });
    expect(t2.get(Svc)).not.toBe(s1);
    // a dependency below the boundary still places the value deeper (max of the two)
    const deeper = t1.child({ providers: [valueProvider(X, 'x')] });
    deeper.get(Deep);
    expect(impl(deeper).cache.has(Deep)).toBe(true);
    await root.close();
  });
});

describe('a released provided value fails loudly (I22, DESIGN.md §2.7)', () => {
  it("a cache hit whose value node completed throws NodeCompletedError", () => {
    class Svc {
      ctx: Context = inject(ContextKey);
    }
    const root = createRootContext();
    const svc = root.get(Svc);
    svc.ctx.abort(); // the value's node completes; its cache entry stays on the root
    expect(svc.ctx.state).toBe('complete');
    expect(() => root.get(Svc)).toThrow(NodeCompletedError);
    expect(() => root.get(Svc)).toThrow(/has been released/);
  });

  it('a release that reads a value released before it (a G3 violation) fails on use', async () => {
    let caught: unknown;
    class Y {
      ctx = inject(ContextKey); // a node of its own: released before X (created after X)
    }
    class X {
      constructor() {
        own(() => {
          try {
            lookup(Y);
          } catch (e) {
            caught = e;
          }
        });
      }
    }
    const root = createRootContext();
    root.get(X);
    root.get(Y);
    await root.close();
    expect(caught).toBeInstanceOf(NodeCompletedError);
  });
});

// ---------------------------------------------------------------------------
// Requester-relative reads (DESIGN.md §3.1, §3.4) and the hit branch's order (I22)
// ---------------------------------------------------------------------------

describe('a SelfScope key is per-creation inside every creation, cached at a boundary or not', () => {
  it('a value injecting a SelfScope key that a [SelfScope] boundary has cached gets its own instance, whichever resolves first', () => {
    for (const order of ['boundary first', 'value first'] as const) {
      let n = 0;
      const Self = createInjectionKey<{ n: number }>('Self', { scope: SelfScope, factory: () => ({ n: ++n }) });
      class V {
        self = inject(Self);
      }
      const root = createRootContext();
      const C = root.child({ name: 'C', scopes: [SelfScope] });
      const R = C.child({ name: 'R' });
      const got = order === 'boundary first' ? { self: C.get(Self), v: R.get(V) } : { v: R.get(V), self: C.get(Self) };
      expect(got.v.self, order).not.toBe(got.self);
      expect([...impl(C).cache.keys()], order).toEqual([Self]); // V is not placed at the boundary
      expect(impl(R).cache.get(V)?.value, order).toBe(got.v);
      // a second requester under the boundary gets a per-creation instance too, never the stored one
      const R2 = C.child({ name: 'R2' });
      const v2 = R2.get(V);
      expect(v2, order).not.toBe(got.v);
      expect(v2.self, order).not.toBe(got.self);
      expect(impl(R2).cache.get(V)?.value, order).toBe(v2);
    }
  });

  it('the same for a default factory under a [SelfScope] root', () => {
    for (const order of ['root first', 'child first'] as const) {
      let n = 0;
      const KEY = createInjectionKey<number>('KEY', { factory: () => ++n, scope: SelfScope });
      const W = createInjectionKey<{ k: number }>('W', { factory: () => ({ k: inject(KEY) }) });
      const root = createRootContext({ scopes: [SelfScope] });
      const child = root.child();
      const got = order === 'root first' ? { k: root.get(KEY), w: child.get(W) } : { w: child.get(W), k: root.get(KEY) };
      expect(got.w.k, order).not.toBe(got.k);
      expect(impl(child).cache.get(W)?.value, order).toBe(got.w);
      expect(impl(root).cache.has(W), order).toBe(false);
    }
  });
});

describe('requester-relative reads pin an auto-hoisted value at its requester', () => {
  it('a SelfScope dependency: every order ends in the same state, and a descendant is never served the ancestor’s instance', () => {
    for (const order of ['R0 first', 'R first'] as const) {
      const Self = createInjectionKey<object>('Self', { scope: SelfScope, factory: () => ({}) });
      class V {
        self = inject(Self);
      }
      const root = createRootContext();
      const R0 = root.child({ name: 'R0' });
      const R = R0.child({ name: 'R' });
      const got = order === 'R0 first' ? { R0: R0.get(V), R: R.get(V) } : { R: R.get(V), R0: R0.get(V) };
      expect(got.R, order).not.toBe(got.R0);
      expect(impl(R0).cache.get(V)?.value, order).toBe(got.R0);
      expect(impl(R).cache.get(V)?.value, order).toBe(got.R);
      expect(impl(root).cache.has(V), order).toBe(false);
      expect(R0.get(V), order).toBe(got.R0); // each answer is permanent (I19)
      expect(R.get(V), order).toBe(got.R);
    }
  });

  it('transitively: a value injecting a pinned value is pinned too', () => {
    for (const order of ['R0 first', 'R first'] as const) {
      const Self = createInjectionKey<object>('Self', { scope: SelfScope, factory: () => ({}) });
      class W {
        self = inject(Self);
      }
      class V {
        w = inject(W);
      }
      const root = createRootContext();
      const R0 = root.child();
      const R = R0.child();
      const got = order === 'R0 first' ? { R0: R0.get(V), R: R.get(V) } : { R: R.get(V), R0: R0.get(V) };
      expect(got.R, order).not.toBe(got.R0);
      expect(got.R.w, order).toBe(R.get(W));
      expect(got.R0.w, order).toBe(R0.get(W));
      expect(impl(R).cache.get(V)?.value, order).toBe(got.R);
    }
  });

  it("a skipSelf read: every order ends in the same state, and each requester's value sees its own parent's answer", () => {
    for (const order of ['R0 first', 'R first'] as const) {
      const K = createInjectionKey<string>('K');
      class V {
        k = inject(K, { skipSelf: true });
      }
      const root = createRootContext({ providers: [valueProvider(K, 'K@root')] });
      const R0 = root.child({ name: 'R0', providers: [valueProvider(K, 'K@R0')] });
      const R = R0.child({ name: 'R' });
      const got = order === 'R0 first' ? { R0: R0.get(V), R: R.get(V) } : { R: R.get(V), R0: R0.get(V) };
      expect(got.R0.k, order).toBe('K@root');
      expect(got.R.k, order).toBe('K@R0');
      expect(impl(R0).cache.get(V)?.value, order).toBe(got.R0);
      expect(impl(R).cache.get(V)?.value, order).toBe(got.R);
    }
  });
});

describe('the hit branch checks liveness after placement by view', () => {
  it("a released value across a shadow is not the requester's answer: it is re-created by the requester's view", () => {
    const A = createInjectionKey<string>('A');
    class V {
      a = inject(A);
      ctx = inject(ContextKey);
    }
    const root = createRootContext({ providers: [valueProvider(A, 'root')] });
    const v = root.get(V);
    v.ctx.abort(); // V@root's node completes; its cache entry stays
    const child = root.child({ providers: [valueProvider(A, 'child')] });
    const vc = child.get(V);
    expect(vc.a).toBe('child');
    expect(impl(child).cache.get(V)?.value).toBe(vc);
    expect(() => root.get(V)).toThrow(NodeCompletedError); // root's own answer still fails loudly (I22)
  });
});
