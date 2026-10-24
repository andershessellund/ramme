// alias-provider.test.ts — `aliasProvider(key, target)` is a redirect (D36, DESIGN.md §3.1, §3.3, §3.4): from
// the providing node down, resolving `key` resolves `target` from the base of the walk that found the alias, by
// `target`'s own rules, and caches nothing under `key`. The alias is a decision on `key` at its node (D10′); a
// value that injects `key` records the redirect chain and its target in deps(V), misses included, and is never
// stored above the alias node; chains are followed and cycles name their hops.
//
// `lookup` is the free function of ambient.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import './node.js';
import { createInjectionKey } from './context-key.js';
import type { InjectionKey } from './context-key.js';
import type { Context } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { inject } from './inject.js';
import { aliasProvider, classProvider, factoryProvider, valueProvider } from './provider-util.js';
import { PlacementError } from './resource.js';
import { RequestScope, RootScope, SelfScope, createScope } from './scope.js';
import { lookup } from './ambient.js';
import { impl } from './test/util.js';

const SessionScope = createScope('session');

afterEach(() => {
  vi.restoreAllMocks();
});

/** Resolve `key` from a request fiber (it carries RequestScope) run under `session`. */
async function fromRequest<T>(session: Context, key: InjectionKey<T>): Promise<T> {
  return session.call(task(async () => lookup(key), { name: 'request', scopes: [RequestScope] }));
}

/** The names of the nodes, among `nodes`, that cache `key`. */
function storedOn(key: object, nodes: Record<string, Context>): string[] {
  return Object.entries(nodes)
    .filter(([, n]) => impl(n).cache.has(key as never))
    .map(([name]) => name);
}

/** What application code depends on: an interface key whose implementation is chosen by wiring. */
interface Cache {
  get(k: string): string | undefined;
  set(k: string, v: string): void;
}
const CacheKey = createInjectionKey<Cache>('Cache');

class SessionCache implements Cache {
  static readonly scope = SessionScope;
  readonly #entries = new Map<string, string>();
  get(k: string): string | undefined {
    return this.#entries.get(k);
  }
  set(k: string, v: string): void {
    this.#entries.set(k, v);
  }
}

describe('aliasProvider resolves its target by the target’s own rules (D36)', () => {
  it('a root alias to a session-declared class gives each session its own instance, shared by its requests', async () => {
    const app = createRootContext({ providers: [aliasProvider(CacheKey, SessionCache)] });
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    const s2 = app.child({ name: 's2', scopes: [SessionScope] });
    const a = await fromRequest(s1, CacheKey);
    expect(a).toBeInstanceOf(SessionCache);
    expect(await fromRequest(s1, CacheKey)).toBe(a);
    const c = await fromRequest(s2, CacheKey);
    expect(c).not.toBe(a);
    expect(s1.get(SessionCache)).toBe(a); // the target's own per-session instance
    expect(storedOn(SessionCache, { app, s1, s2 })).toEqual(['s1', 's2']);
    expect(storedOn(CacheKey, { app, s1, s2 })).toEqual([]); // nothing under the alias key
    await app.close();
  });

  it('an auto-hoisted target lands at its deepest dependency, as if injected directly', () => {
    const A = createInjectionKey<string>('A');
    class Impl implements Cache {
      readonly a = inject(A);
      get(): string | undefined {
        return this.a;
      }
      set(): void {}
    }
    const root = createRootContext({ name: 'root', providers: [aliasProvider(CacheKey, Impl)] });
    const P = root.child({ name: 'P', providers: [valueProvider(A, 'a@P')] });
    const R = P.child({ name: 'R' }).child();
    const v = R.get(CacheKey);
    expect(v.get('x')).toBe('a@P');
    expect(storedOn(Impl, { root, P })).toEqual(['P']);
    expect(P.get(Impl)).toBe(v);
  });

  it('caches nothing under the key at the alias node: two resolutions, one instance of the target', () => {
    class Impl implements Cache {
      get(): string | undefined {
        return undefined;
      }
      set(): void {}
    }
    const root = createRootContext({ providers: [aliasProvider(CacheKey, Impl)] });
    const N = root.child({ name: 'N', providers: [aliasProvider(CacheKey, SessionCache)] });
    const s = N.child({ scopes: [SessionScope] });
    const first = root.get(CacheKey);
    expect(root.get(CacheKey)).toBe(first);
    expect(root.get(Impl)).toBe(first);
    expect(impl(root).cache.has(CacheKey)).toBe(false);
    expect(s.get(CacheKey)).toBe(s.get(CacheKey));
    expect(impl(N).cache.has(CacheKey)).toBe(false);
    expect(impl(s).cache.has(CacheKey)).toBe(false);
  });

  it('follows a chain of aliases, each caching nothing', async () => {
    const Middle = createInjectionKey<Cache>('Middle');
    const app = createRootContext({ providers: [aliasProvider(CacheKey, Middle), aliasProvider(Middle, SessionCache)] });
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    const s2 = app.child({ name: 's2', scopes: [SessionScope] });
    const a = await fromRequest(s1, CacheKey);
    expect(a).toBe(s1.get(SessionCache));
    expect(await fromRequest(s2, CacheKey)).toBe(s2.get(SessionCache));
    expect(storedOn(CacheKey, { app, s1, s2 })).toEqual([]);
    expect(storedOn(Middle, { app, s1, s2 })).toEqual([]);
    await app.close();
  });

  it('a cycle of aliases, and one through a creation, throw the circular-dependency error naming the hops', () => {
    const A = createInjectionKey<string>('A');
    const B = createInjectionKey<string>('B');
    const pure = createRootContext({ providers: [aliasProvider(A, B), aliasProvider(B, A)] });
    expect(() => pure.get(A)).toThrow(new Error('Circular dependency detected: A → B → A'));
    const Self = createInjectionKey<string>('Self');
    expect(() => createRootContext({ providers: [aliasProvider(Self, Self)] }).get(Self)).toThrow(
      new Error('Circular dependency detected: Self → Self'),
    );
    // An alias whose class target injects the alias key again: the frame of the target is reached through the alias.
    const K = createInjectionKey<object>('K');
    class Target {
      readonly k: object = inject(K);
    }
    const viaCreation = createRootContext({ providers: [aliasProvider(K, Target)] });
    expect(() => viaCreation.get(K)).toThrow(new Error('Circular dependency detected: K → Target → K'));
    expect(impl(viaCreation).cache.has(Target)).toBe(false);
  });

  it('a cycle through a declared-placement target names the hops when requested from below its storage node', () => {
    // The target's own inject resolves from its storage node, not from the requester that found the alias.
    const Loop = createInjectionKey<object>('Loop');
    class SessionLoop {
      static readonly scope = SessionScope;
      readonly back: object = inject(Loop);
    }
    const app = createRootContext({ providers: [aliasProvider(Loop, SessionLoop)] });
    const s = app.child({ name: 's', scopes: [SessionScope] });
    expect(() => s.child().get(Loop)).toThrow(new Error('Circular dependency detected: Loop → SessionLoop → Loop'));
    expect(() => s.get(Loop)).toThrow(new Error('Circular dependency detected: Loop → SessionLoop → Loop'));
    expect(impl(s).cache.has(SessionLoop)).toBe(false);
    const Back = createInjectionKey<object>('Back');
    class RootLoop {
      static readonly scope = RootScope;
      readonly back: object = inject(Back);
    }
    const scoped = createRootContext({ providers: [aliasProvider(Back, RootLoop)] });
    expect(() => scoped.child().child().get(Back)).toThrow(new Error('Circular dependency detected: Back → RootLoop → Back'));
    const P = createInjectionKey<object>('P');
    class Provided {
      readonly p: object = inject(P);
    }
    const provided = createRootContext({ providers: [aliasProvider(P, Provided), classProvider(Provided)] });
    expect(() => provided.child().get(P)).toThrow(new Error('Circular dependency detected: P → Provided → P'));
    expect(() => provided.get(P)).toThrow(new Error('Circular dependency detected: P → Provided → P'));
    // Through a chain: the message ends at the first alias hop the target's creation reaches again.
    const Outer = createInjectionKey<object>('Outer');
    const Inner = createInjectionKey<object>('Inner');
    class Chained {
      static readonly scope = SessionScope;
      readonly back: object = inject(Inner);
    }
    const chained = createRootContext({ providers: [aliasProvider(Outer, Inner), aliasProvider(Inner, Chained)] });
    const cs = chained.child({ scopes: [SessionScope] });
    expect(() => cs.child().get(Outer)).toThrow(new Error('Circular dependency detected: Outer → Inner → Chained → Inner'));
  });

  it('an alias key reached again from a target’s storage node through other providers is no cycle', () => {
    interface Named {
      readonly v: string;
    }
    const A = createInjectionKey<Named>('A');
    const U = createInjectionKey<Named>('U');
    class T {
      static readonly scope = SessionScope; // stored on s, above the alias node M: its inject resolves from s
      readonly a = inject(A);
      readonly v: string = 't';
    }
    // A different alias for the same key above the storage node.
    const root = createRootContext({ providers: [aliasProvider(A, U), valueProvider(U, { v: 'u' })] });
    const s = root.child({ name: 's', scopes: [SessionScope] });
    const M = s.child({ name: 'M', providers: [aliasProvider(A, T)] });
    const t = M.child().get(A);
    expect(t).toBeInstanceOf(T);
    expect((t as T).a).toEqual({ v: 'u' });
    // The same alias provider, but the rest of the chain differs from the storage node.
    const B = createInjectionKey<Named>('B');
    class T2 {
      static readonly scope = SessionScope;
      readonly a = inject(A);
      readonly v: string = 't2';
    }
    const root2 = createRootContext({ providers: [aliasProvider(A, B), valueProvider(B, { v: 'b' })] });
    const s2 = root2.child({ name: 's2', scopes: [SessionScope] });
    const M2 = s2.child({ name: 'M2', providers: [aliasProvider(B, T2)] });
    const t2 = M2.child().get(A);
    expect(t2).toBeInstanceOf(T2);
    expect((t2 as T2).a).toEqual({ v: 'b' });
  });

  it('the target resolves from the walk’s base: explicit providers for it above and below the alias node are both seen', () => {
    const Target = createInjectionKey<Cache>('Target');
    const make = (label: string): Cache => ({ get: () => label, set: () => {} });
    const root = createRootContext({ name: 'root' });
    const M = root.child({ name: 'M', providers: [valueProvider(Target, make('M'))] });
    const N = M.child({ name: 'N', providers: [aliasProvider(CacheKey, Target)] });
    const below = N.child({ name: 'below', providers: [valueProvider(Target, make('below'))] });
    expect(N.child().get(CacheKey).get('')).toBe('M'); // the provider above the alias
    expect(below.child().get(CacheKey).get('')).toBe('below'); // the requester's view of the target
    expect(N.get(CacheKey).get('')).toBe('M');
  });

  it('the walk’s base is the storage node in a declared-placement creation and the parent for skipSelf', () => {
    class SessionThing {
      static readonly scope = SessionScope;
    }
    const Key = createInjectionKey<SessionThing>('Key');
    const Holder = createInjectionKey<{ t: SessionThing }>('Holder');
    const root = createRootContext({
      providers: [aliasProvider(Key, SessionThing), factoryProvider(Holder, () => ({ t: inject(Key) }))],
    });
    const s1 = root.child({ name: 's1', scopes: [SessionScope] });
    // Holder is built on the root and resolves from it, where no node carries the session scope.
    expect(() => s1.get(Holder)).toThrow("No context found for scope 'session' when resolving key: SessionThing");
    expect(impl(s1).cache.has(SessionThing)).toBe(false);
    // skipSelf in an auto-hoisted creation resolves from the requester's parent: the root's view of the target.
    const Label = createInjectionKey<string>('Label');
    const Inner = createInjectionKey<string>('Inner');
    class Decorated {
      readonly inner = inject(Label, { skipSelf: true });
    }
    const app = createRootContext({ providers: [aliasProvider(Label, Inner), valueProvider(Inner, 'root')] });
    const R = app.child({ name: 'R', providers: [valueProvider(Inner, 'R')] });
    expect(R.get(Label)).toBe('R');
    expect(R.get(Decorated).inner).toBe('root');
    expect(R.get(Label, { skipSelf: true })).toBe('root');
  });

  it('a test fake bound through an alias keeps the scope it declares: one per session', async () => {
    class FakeSessionCache {
      static readonly scope = SessionScope;
      readonly calls: string[] = []; // a test-only member
      get(k: string): string | undefined {
        this.calls.push(k);
        return undefined;
      }
      set(): void {}
    }
    class Greeter {
      readonly #cache = inject(SessionCache);
      greet(name: string): string {
        return this.#cache.get(name) ?? `hello ${name}`;
      }
    }
    const app = createRootContext({ providers: [aliasProvider(SessionCache, FakeSessionCache)] });
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    const s2 = app.child({ name: 's2', scopes: [SessionScope] });
    expect((await fromRequest(s1, Greeter)).greet('ann')).toBe('hello ann');
    expect((await fromRequest(s2, Greeter)).greet('bob')).toBe('hello bob');
    expect((await fromRequest(s1, Greeter)).greet('cid')).toBe('hello cid');
    expect(s1.get(FakeSessionCache).calls).toEqual(['ann', 'cid']);
    expect(s2.get(FakeSessionCache).calls).toEqual(['bob']);
    expect(storedOn(FakeSessionCache, { app, s1, s2 })).toEqual(['s1', 's2']);
    await app.close();
  });
});

describe('a value that injects an alias (D36, DESIGN.md §3.4)', () => {
  it('is stored at or below the alias node: under a non-root alias it is that node’s, and a sibling builds its own from the key’s default', () => {
    class Clock {
      now(): string {
        return 'real';
      }
    }
    class FakeClock {
      now(): string {
        return 'fake';
      }
    }
    class Report {
      readonly clock = inject(Clock);
    }
    const root = createRootContext({ name: 'root' });
    const N = root.child({ name: 'N', providers: [aliasProvider(Clock, FakeClock)] });
    const M = root.child({ name: 'M' });
    const atN = N.child().get(Report);
    expect(atN.clock.now()).toBe('fake');
    expect(storedOn(Report, { root, N, M })).toEqual(['N']);
    expect(storedOn(FakeClock, { root, N, M })).toEqual(['root']); // the target itself is placed by its own rules
    expect(M.get(Report).clock.now()).toBe('real');
    expect(M.get(Report)).not.toBe(atN);
  });

  it('records the target in deps(V): a fresh child providing the target is served a V built from it', () => {
    class Impl implements Cache {
      get(): string | undefined {
        return 'impl';
      }
      set(): void {}
    }
    class V {
      readonly cache = inject(CacheKey);
    }
    const root = createRootContext({ name: 'root', providers: [aliasProvider(CacheKey, Impl)] });
    const v = root.get(V);
    expect(v.cache.get('')).toBe('impl');
    const child = root.child({ name: 'child', providers: [valueProvider(Impl, { get: () => 'child', set: () => {} })] });
    const vc = child.get(V);
    expect(vc).not.toBe(v);
    expect(vc.cache.get('')).toBe('child');
    expect(root.get(V)).toBe(v);
    expect([...(impl(root).cache.get(V)?.deps ?? [])]).toEqual([CacheKey, Impl]);
  });

  it('an alias’s scope-declared target is a scope shadow (D10′): a nested owner of the target’s scope gets its own V', () => {
    const σ = createScope('request');
    let n = 0;
    const Dk = createInjectionKey<{ n: number }>('D');
    const Impl = createInjectionKey<{ n: number }>('Impl', { scope: σ, factory: () => ({ n: ++n }) });
    class V {
      readonly d = inject(Dk);
    }
    const root = createRootContext({ name: 'root', providers: [aliasProvider(Dk, Impl)] });
    const r1 = root.child({ name: 'r1', scopes: [σ] });
    const v1 = r1.get(V);
    expect(v1.d.n).toBe(1);
    expect(impl(r1).cache.get(V)?.value).toBe(v1); // V's deepest dependency is Impl@r1, below the alias
    const r2 = r1.child({ name: 'r2', scopes: [σ] }); // a nested owner of the target's scope
    const v2 = r2.child().get(V);
    expect(v2).not.toBe(v1);
    expect(v2.d.n).toBe(2);
    expect(v2.d).toBe(r2.get(Dk));
    expect(r1.child().get(V)).toBe(v1);
  });

  it('an optional inject of an alias whose target is unprovided records the miss: a child providing the target is not served the V built from it', () => {
    const Key = createInjectionKey<string>('Key');
    const Target = createInjectionKey<string>('Target');
    class V {
      readonly k = inject(Key, { optional: true });
    }
    const root = createRootContext({ name: 'root', providers: [aliasProvider(Key, Target)] });
    const v = root.get(V);
    expect(v.k).toBeUndefined();
    const child = root.child({ name: 'child', providers: [valueProvider(Target, 't')] });
    expect(child.get(V).k).toBe('t');
    expect(root.get(V)).toBe(v);
    expect(() => root.addProvider(valueProvider(Target, 'late'))).toThrow(PlacementError); // the miss was a decision
  });

  it('a child overriding the alias key with a value gets a V built from the value, in either order (D7)', () => {
    class Impl implements Cache {
      get(): string | undefined {
        return 'impl';
      }
      set(): void {}
    }
    class V {
      readonly cache = inject(CacheKey);
    }
    for (const order of ['root first', 'child first'] as const) {
      const fake: Cache = { get: () => 'fake', set: () => {} };
      const root = createRootContext({ name: 'root', providers: [aliasProvider(CacheKey, Impl)] });
      const child = root.child({ name: 'child', providers: [valueProvider(CacheKey, fake)] });
      let vr: V;
      let vc: V;
      if (order === 'root first') {
        vr = root.get(V);
        vc = child.get(V); // deps(V) = {Cache, Impl} at the root, {Cache} for the child's re-run
      } else {
        vc = child.get(V);
        vr = root.get(V);
      }
      expect(vc.cache, order).toBe(fake);
      expect(vr.cache.get(''), order).toBe('impl');
      expect(storedOn(V, { root, child }), order).toEqual(['root', 'child']);
    }
  });

  it('a child overriding an alias to a per-creation target that injects something gets a V built from the override, in either order (D7)', () => {
    interface Clock {
      now(): string;
    }
    const ClockKey = createInjectionKey<Clock>('Clock');
    const Config = createInjectionKey<string>('Config', { factory: () => 'config' });
    const Other = createInjectionKey<string>('Other', { factory: () => 'other' });
    class RealClock {
      static readonly scope = SelfScope; // the per-creation binding (D36): its reads run through V's creation
      readonly c = inject(Config);
      now(): string {
        return 'real';
      }
    }
    class TestClock {
      static readonly scope = SelfScope;
      readonly o = inject(Other);
      now(): string {
        return 'test';
      }
    }
    class V {
      readonly clock = inject(ClockKey);
    }
    for (const override of ['value', 'alias'] as const)
      for (const order of ['root first', 'child first'] as const) {
        const label = `${override}, ${order}`;
        const root = createRootContext({ name: 'root', providers: [aliasProvider(ClockKey, RealClock)] });
        const child = root.child({
          name: 'child',
          providers: [override === 'value' ? valueProvider(ClockKey, { now: () => 'fake' }) : aliasProvider(ClockKey, TestClock)],
        });
        let vr: V;
        let vc: V;
        if (order === 'root first') {
          vr = root.get(V);
          vc = child.get(V); // V is pinned at the root (a SelfScope read): the child re-runs it
        } else {
          vc = child.get(V);
          vr = root.get(V);
        }
        expect(vc.clock.now(), label).toBe(override === 'value' ? 'fake' : 'test');
        expect(vr.clock.now(), label).toBe('real');
        expect(storedOn(V, { root, child }), label).toEqual(['root', 'child']);
        // RealClock's read of Config is in the closure deps(V), not among the keys V's factory injected itself.
        expect(impl(root).cache.get(V)?.deps, label).toEqual(new Set([Config, ClockKey, RealClock]));
        expect(impl(root).cache.get(V)?.direct, label).toEqual(new Set([ClockKey]));
      }
  });

  it('the alias is its node’s decision on the key: addProvider of it there is a PlacementError once it answered (D10′)', () => {
    class Impl implements Cache {
      get(): string | undefined {
        return undefined;
      }
      set(): void {}
    }
    const root = createRootContext({ name: 'root' });
    const N = root.child({ name: 'N', providers: [aliasProvider(CacheKey, Impl)] });
    const R = N.child({ name: 'R' });
    expect(() => N.addProvider(valueProvider(Impl, new Impl()))).not.toThrow(); // nothing answered through N yet
    R.get(CacheKey);
    for (const c of [R, N])
      expect(() => c.addProvider(valueProvider(CacheKey, new Impl())), c.name).toThrow(PlacementError);
    expect(() => root.addProvider(valueProvider(CacheKey, new Impl()))).not.toThrow(); // above the alias: never answered
  });
});
