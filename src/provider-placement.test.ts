// provider-placement.test.ts — an explicit provider lives where it is registered (D36, DESIGN.md §3.1, §3.3):
// whatever the key declares as its scope, a provider's value is stored on its node; scope places only a key's own
// default. With it: the effective scope of placement by view (none under a provider; DESIGN.md §3.4, D10′), a scoped
// default deciding its key up to the root, the D7 re-run check over the keys a factory injected itself, and a
// provider for a SelfScope-declared key shared like any provider.
//
// `call` and `lookup` are the free functions of ambient.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey } from './context-key.js';
import type { InjectionKey } from './context-key.js';
import type { Context } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { inject } from './inject.js';
import { classProvider, factoryProvider, valueProvider } from './provider-util.js';
import { PlacementError } from './resource.js';
import { RequestScope, RootScope, SelfScope, createScope } from './scope.js';
import { call, current, lookup } from './ambient.js';
import { impl } from './test/util.js';

const SessionScope = createScope('session');

afterEach(() => {
  vi.restoreAllMocks();
});

/** Resolve `key` from a request fiber (it carries RequestScope) run under `session`. */
async function fromRequest<T>(session: Context, key: InjectionKey<T>): Promise<T> {
  return session.call(task(function* () { return lookup(key); }, { name: 'request', scopes: [RequestScope] }));
}

/** The names of the nodes, among `nodes`, that cache `key`. */
function storedOn(key: object, nodes: Record<string, Context>): string[] {
  return Object.entries(nodes)
    .filter(([, n]) => impl(n).cache.has(key as never))
    .map(([name]) => name);
}

describe('an explicit provider stores its value where it is registered, whatever the key’s scope (D36)', () => {
  it('a valueProvider or classProvider at the root for a session-declared class gives both sessions the one root instance', async () => {
    class SessionCache {
      static readonly scope = SessionScope;
      readonly entries = new Map<string, string>();
    }
    const shared = new SessionCache(); // injects nothing: constructible outside creation
    for (const p of [valueProvider(SessionCache, shared), classProvider(SessionCache)]) {
      const app = createRootContext({ providers: [p] });
      const s1 = app.child({ name: 's1', scopes: [SessionScope] });
      const s2 = app.child({ name: 's2', scopes: [SessionScope] });
      const a = await fromRequest(s1, SessionCache);
      expect(await fromRequest(s2, SessionCache)).toBe(a);
      expect(storedOn(SessionCache, { app, s1, s2 })).toEqual(['app']);
      expect(impl(app).cache.get(SessionCache)?.scope).toBeUndefined(); // a provider's entry carries no scope
      await app.close();
    }
  });

  it('on a session node it serves a requester under a nested owner of the scope from the providing node', async () => {
    class SessionCache {
      static readonly scope = SessionScope;
      readonly entries = new Map<string, string>();
    }
    const app = createRootContext();
    const s1 = app.child({ name: 's1', scopes: [SessionScope], providers: [classProvider(SessionCache)] });
    const nested = s1.child().child({ name: 'nested', scopes: [SessionScope] });
    const a = await fromRequest(nested, SessionCache);
    expect(s1.get(SessionCache)).toBe(a); // not a second instance at the nested owner
    expect(storedOn(SessionCache, { app, s1, nested })).toEqual(['s1']);
    await app.close();
  });

  it('a provider for a request-declared key on a call child below the request node is allowed and shadows the request’s value for that child only', async () => {
    class UnitOfWork {
      static readonly scope = RequestScope;
      readonly label: string = 'real';
    }
    const fake: UnitOfWork = { label: 'fake' };
    const app = createRootContext();
    const seen = await app.call(
      task(
        function* () {
          const own = lookup(UnitOfWork); // the request's own, stored on the request node
          const overridden = yield* call(
            task(function* () { return lookup(UnitOfWork); }, { name: 'override', providers: [valueProvider(UnitOfWork, fake)] }),
          );
          const sibling = yield* call(task(function* () { return lookup(UnitOfWork); }, { name: 'sibling' }));
          return { own, overridden, sibling, again: lookup(UnitOfWork) };
        },
        { name: 'request', scopes: [RequestScope] },
      ),
    );
    expect(seen.overridden).toBe(fake);
    expect(seen.own.label).toBe('real');
    expect(seen.sibling).toBe(seen.own);
    expect(seen.again).toBe(seen.own);
    await app.close();
  });

  it('providers: on task.with() for a key whose scope owner is above the call are stored on the call’s node', async () => {
    class Settings {
      static readonly scope = RootScope; // owned by the root, above every call
      readonly mode: string = 'default';
    }
    const read = task(function* () { return ({ value: lookup(Settings), here: impl(current()).cache.has(Settings) }); });
    const app = createRootContext();
    const r = await app.call(read.with({ providers: [valueProvider(Settings, { mode: 'test' })] }));
    expect(r).toEqual({ value: { mode: 'test' }, here: true });
    expect(app.get(Settings).mode).toBe('default'); // the root's own default, unaffected
    await app.close();
  });

  it('decided markers still refuse addProvider of a key served through the node (D10′), at the providing node too', async () => {
    class SessionCache {
      static readonly scope = SessionScope;
      readonly entries = new Map<string, string>();
    }
    const app = createRootContext({ providers: [classProvider(SessionCache)] });
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    s1.get(SessionCache); // served from the root's provider: s1..root decided
    expect(() => s1.addProvider(classProvider(SessionCache))).toThrow(PlacementError);
    expect(() => s1.addProvider(classProvider(SessionCache))).toThrow(/already been decided/);
    expect(() => app.addProvider(classProvider(SessionCache))).toThrow(PlacementError);
    // A fresh session has no decisions: providing at construction is allowed, and stores there.
    const s2 = app.child({ name: 's2', scopes: [SessionScope], providers: [classProvider(SessionCache)] });
    expect(s2.get(SessionCache)).not.toBe(s1.get(SessionCache));
    expect(storedOn(SessionCache, { app, s1, s2 })).toEqual(['app', 's2']);
    await app.close();
  });
});

describe('placement by view with providers that place where registered (DESIGN.md §3.4, D10′)', () => {
  it('a root-provided session-declared class has no effective scope: an auto-hoisted V injecting it is one V at the root for every session', () => {
    class SessionCache {
      static readonly scope = SessionScope;
    }
    class V {
      readonly cache = inject(SessionCache);
    }
    const root = createRootContext({ name: 'root', providers: [classProvider(SessionCache)] });
    const s1 = root.child({ name: 's1', scopes: [SessionScope] });
    const s2 = root.child({ name: 's2', scopes: [SessionScope] });
    const v = s1.child().get(V);
    expect(s1.child().get(V)).toBe(v);
    expect(s2.child().get(V)).toBe(v); // s2 is no shadow of a key the root's provider serves
    expect(storedOn(V, { root, s1, s2 })).toEqual(['root']);
    expect(v.cache).toBe(root.get(SessionCache));
  });

  it('a scoped default decides its key up to the root: an ancestor cannot provide it afterwards', () => {
    class D {
      static readonly scope = SessionScope;
    }
    class V {
      readonly d = inject(D);
    }
    const root = createRootContext({ name: 'root' });
    const s1 = root.child({ name: 's1', scopes: [SessionScope] });
    const s2 = root.child({ name: 's2', scopes: [SessionScope] });
    const d1 = s1.get(D); // s1's own default
    expect(impl(root).decided.has(D)).toBe(true);
    expect(() => root.addProvider(valueProvider(D, new D()))).toThrow(PlacementError);
    expect(() => root.addProvider(valueProvider(D, new D()))).toThrow(/already been decided/);
    // So s1 is never served a V built from a root D: each session's V is built from its own D.
    const v2 = s2.get(V);
    expect(s1.get(V).d).toBe(d1);
    expect(v2.d).toBe(s2.get(D));
    expect(v2.d).not.toBe(d1);
  });

  it('a re-creation compares the keys the factory injected itself: Dep → Config overridden by a value is no PlacementError, in either order (D7)', () => {
    class Config {
      readonly url: string = 'https://example.com';
    }
    class Dep {
      readonly c = inject(Config);
    }
    class V {
      readonly d = inject(Dep);
    }
    for (const order of ['root first', 'child first'] as const) {
      const value: Dep = { c: { url: 'https://override.example' } };
      const root = createRootContext({ name: 'root' });
      const child = root.child({ name: 'child', providers: [valueProvider(Dep, value)] });
      let vr: V;
      let vc: V;
      if (order === 'root first') {
        vr = root.get(V);
        vc = child.get(V); // a hit at the root that the child's Dep shadows: V's factory re-runs from the child
      } else {
        vc = child.get(V);
        vr = root.get(V);
      }
      expect(vc.d, order).toBe(value); // the child's V is built from the value
      expect(vr.d, order).not.toBe(value);
      expect(vr.d.c.url, order).toBe('https://example.com');
      expect(storedOn(V, { root, child }), order).toEqual(['root', 'child']);
      // The closure deps(V) differs between the two instances; the keys V's factory injected do not.
      expect([...(impl(root).cache.get(V)?.deps ?? [])], order).toEqual([Dep, Config]);
      expect([...(impl(child).cache.get(V)?.deps ?? [])], order).toEqual([Dep]);
    }
  });

  it('the reads of a per-creation SelfScope dependency are not V’s own: a child overriding it with a value gets a V built from the value, in either order (D7)', () => {
    const D = createInjectionKey<string>('D', { factory: () => 'd' });
    class Clock {
      static readonly scope = SelfScope; // per consuming creation; its factory's reads run through V's creation
      readonly d = inject(D);
      now(): string {
        return 'real';
      }
    }
    const Stamp = createInjectionKey<{ d: string }>('Stamp', { scope: SelfScope, factory: () => ({ d: inject(D) }) });
    class V {
      readonly clock = inject(Clock);
    }
    class W {
      readonly stamp = inject(Stamp);
    }
    for (const order of ['root first', 'child first'] as const) {
      const fakeClock: Clock = { d: 'fake', now: () => 'fake' };
      const fakeStamp = { d: 'fake' };
      const root = createRootContext({ name: 'root' });
      const child = root.child({ name: 'child', providers: [valueProvider(Clock, fakeClock), valueProvider(Stamp, fakeStamp)] });
      let vr: V, vc: V, wr: W, wc: W;
      if (order === 'root first') {
        vr = root.get(V);
        wr = root.get(W);
        vc = child.get(V); // V is pinned at the root (a SelfScope read): the child re-runs it
        wc = child.get(W);
      } else {
        vc = child.get(V);
        wc = child.get(W);
        vr = root.get(V);
        wr = root.get(W);
      }
      expect(vc.clock, order).toBe(fakeClock);
      expect(wc.stamp, order).toBe(fakeStamp);
      expect(vr.clock.now(), order).toBe('real');
      expect(wr.stamp.d, order).toBe('d');
      expect(storedOn(V, { root, child }), order).toEqual(['root', 'child']);
      // D is in the closure deps(V), brought in by the SelfScope read, but V's factory injected only Clock.
      expect(impl(root).cache.get(V)?.deps, order).toEqual(new Set([D, Clock]));
      expect(impl(root).cache.get(V)?.direct, order).toEqual(new Set([Clock]));
      expect(impl(root).cache.get(W)?.direct, order).toEqual(new Set([Stamp]));
    }
  });

  it('a provider for a SelfScope-declared key is shared by every creation, like any provider (D36)', () => {
    let n = 0;
    const Self = createInjectionKey<{ n: number }>('Self', { scope: SelfScope, factory: () => ({ n: -1 }) });
    class A {
      readonly self = inject(Self);
    }
    class B {
      readonly self = inject(Self);
    }
    const root = createRootContext({ providers: [factoryProvider(Self, () => ({ n: ++n }))] });
    const a = root.child().get(A);
    const b = root.child().get(B);
    expect(a.self).toBe(b.self);
    expect(a.self.n).toBe(1);
    expect(n).toBe(1);
    expect(impl(root).cache.get(Self)?.value).toBe(a.self); // stored on the providing node
  });
});
