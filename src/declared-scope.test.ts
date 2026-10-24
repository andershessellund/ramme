// declared-scope.test.ts — a key's lifetime declared at the class: `static readonly scope = S` (D32,
// DESIGN.md §3.1, §3.3). A declaration is a Scope made by createScope, read through the prototype chain;
// `undefined` and function values are ignored; anything else is a TypeError at every read. setScope is the form
// for keys you do not own, refused on a key that already declares one; a provider's own scope still wins.
import { afterEach, describe, expect, it, vi } from 'vitest';
import './node.js';
import { createInjectionKey, getKeyScope, setScope } from './context-key.js';
import type { InjectionKey } from './context-key.js';
import type { Context } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { inject } from './inject.js';
import { classProvider, factoryProvider, valueProvider } from './provider-util.js';
import { RequestScope, RootScope, createScope } from './scope.js';
import type { Scope } from './scope.js';
import { current, lookup } from './ambient.js';
import { impl } from './test/util.js';

const SessionScope = createScope('session');

afterEach(() => {
  vi.restoreAllMocks();
});

/** A root-level dependency: auto-hoisted to the root, whatever injects it. */
class Config {
  readonly url = 'https://example.com';
}

/** Resolve `key` from a request fiber (it carries RequestScope) run under `session`. */
async function fromRequest<T>(session: Context, key: InjectionKey<T>): Promise<T> {
  return session.call(task(async () => lookup(key), { name: 'request', scopes: [RequestScope] }));
}

/** The node a resolved key is cached on, among `nodes`. */
function storedOn(key: object, nodes: Record<string, Context>): string[] {
  return Object.entries(nodes)
    .filter(([, n]) => impl(n).cache.has(key as never))
    .map(([name]) => name);
}

describe('a declared scope places the value at the scope node (DESIGN.md §3.1, §3.3)', () => {
  it('a class with static scope = SessionScope is stored on the session, though it injects only root-level keys; shared by the session’s requests, not across sessions', async () => {
    class SessionCache {
      static readonly scope = SessionScope;
      readonly config = inject(Config);
      readonly node = current(); // the value's own node: its parent is the storage node
    }
    const app = createRootContext();
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    const s2 = app.child({ name: 's2', scopes: [SessionScope] });
    const a = await fromRequest(s1, SessionCache);
    const b = await fromRequest(s1, SessionCache);
    const c = await fromRequest(s2, SessionCache);
    expect(a).toBe(b); // two requests of one session share it
    expect(c).not.toBe(a); // another session has its own
    expect(storedOn(SessionCache, { app, s1, s2 })).toEqual(['s1', 's2']);
    expect(storedOn(Config, { app, s1, s2 })).toEqual(['app']); // its dependency stays at the root
    expect(a.config).toBe(c.config);
    expect(impl(a.node).parent).toBe(impl(s1));
    await app.close();
  });

  it('a function key with a scope property behaves the same', async () => {
    function sessionCounter(): { n: number } {
      return { n: inject(Config).url.length };
    }
    sessionCounter.scope = SessionScope;
    const app = createRootContext();
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    const s2 = app.child({ name: 's2', scopes: [SessionScope] });
    const a = await fromRequest(s1, sessionCounter);
    expect(await fromRequest(s1, sessionCounter)).toBe(a);
    expect(await fromRequest(s2, sessionCounter)).not.toBe(a);
    expect(storedOn(sessionCounter, { app, s1, s2 })).toEqual(['s1', 's2']);
    await app.close();
  });

  it('a subclass inherits its base’s declaration, and static override readonly scope re-declares it', async () => {
    class Base {
      static readonly scope: Scope = SessionScope;
    }
    class Inherits extends Base {}
    class Redeclares extends Base {
      static override readonly scope = RootScope;
    }
    expect(getKeyScope(Inherits)).toBe(SessionScope);
    expect(getKeyScope(Redeclares)).toBe(RootScope);
    const app = createRootContext();
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    await fromRequest(s1, Inherits);
    await fromRequest(s1, Redeclares);
    expect(storedOn(Inherits, { app, s1 })).toEqual(['s1']);
    expect(storedOn(Redeclares, { app, s1 })).toEqual(['app']);
    await app.close();
  });

  it('static scope?: Scope with no initializer is ignored (the key is auto-hoisted), and so is a static method named scope', async () => {
    class Optional {
      static scope?: Scope;
      readonly config = inject(Config);
    }
    class OrmModel {
      static scope(): string {
        return 'an ORM query scope, not a lifetime';
      }
      readonly config = inject(Config);
    }
    expect(Object.hasOwn(Optional, 'scope')).toBe(true); // ES2022 class fields emit an own `undefined`
    expect(Optional.scope).toBeUndefined();
    expect(getKeyScope(Optional)).toBeUndefined();
    expect(getKeyScope(OrmModel)).toBeUndefined();
    const app = createRootContext();
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    await fromRequest(s1, Optional);
    await fromRequest(s1, OrmModel);
    // Auto-hoisted to their deepest dependency, Config at the root (DESIGN.md §3.3).
    expect(storedOn(Optional, { app, s1 })).toEqual(['app']);
    expect(storedOn(OrmModel, { app, s1 })).toEqual(['app']);
    await app.close();
  });

  it('a provider’s own scope takes precedence over the key’s static scope', async () => {
    class Declared {
      static readonly scope = SessionScope;
    }
    const app = createRootContext({ providers: [classProvider(Declared, Declared, { scope: RootScope })] });
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    const s2 = app.child({ name: 's2', scopes: [SessionScope] });
    const a = await fromRequest(s1, Declared);
    expect(await fromRequest(s2, Declared)).toBe(a);
    expect(storedOn(Declared, { app, s1, s2 })).toEqual(['app']);
    await app.close();
  });

  it('createInjectionKey with scope is unchanged', async () => {
    const Token = createInjectionKey<{ id: number }>('Token', { factory: () => ({ id: 1 }), scope: SessionScope });
    expect(getKeyScope(Token)).toBe(SessionScope);
    const app = createRootContext();
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    const s2 = app.child({ name: 's2', scopes: [SessionScope] });
    const a = await fromRequest(s1, Token);
    expect(await fromRequest(s1, Token)).toBe(a);
    expect(await fromRequest(s2, Token)).not.toBe(a);
    expect(storedOn(Token, { app, s1, s2 })).toEqual(['s1', 's2']);
    await app.close();
  });
});

describe('setScope and the scope property (D32)', () => {
  it('setScope on a class with a static scope throws TypeError, and so does setScope on a subclass of a declared class', () => {
    class Declared {
      static readonly scope = SessionScope;
    }
    class Sub extends Declared {}
    expect(() => setScope(Declared, RootScope)).toThrow(TypeError);
    expect(() => setScope(Declared, RootScope)).toThrow(/Declared already declares its scope \('session'\)/);
    expect(() => setScope(Sub, RootScope)).toThrow(TypeError);
    expect(getKeyScope(Declared)).toBe(SessionScope); // nothing was registered
    expect(getKeyScope(Sub)).toBe(SessionScope);
  });

  it('setScope on a class whose scope is not a declaration registers, and the registered scope wins', async () => {
    class OrmModel {
      static scope(): string {
        return 'orm';
      }
    }
    class Labelled {
      static scope = 'a label, not a lifetime';
    }
    setScope(OrmModel, SessionScope);
    setScope(Labelled, SessionScope); // no TypeError: the registration is what is read
    expect(getKeyScope(OrmModel)).toBe(SessionScope);
    expect(getKeyScope(Labelled)).toBe(SessionScope);
    const app = createRootContext();
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    await fromRequest(s1, OrmModel);
    await fromRequest(s1, Labelled);
    expect(storedOn(OrmModel, { app, s1 })).toEqual(['s1']);
    expect(storedOn(Labelled, { app, s1 })).toEqual(['s1']);
    await app.close();
  });

  it("static scope = 'session' throws TypeError naming the key at each resolution, and at child({ providers }) and addProvider", async () => {
    class Bad {
      static scope = 'session';
    }
    const app = createRootContext();
    const s1 = app.child({ name: 's1', scopes: [SessionScope] });
    for (let i = 0; i < 2; i++) {
      // Every read, not only the first: nothing is memoized, and nothing is cached by a failed resolution.
      await expect(fromRequest(s1, Bad)).rejects.toThrow(TypeError);
      expect(() => app.get(Bad)).toThrow(/^Bad\.scope is "session", not a Scope made by createScope\(\).*setScope\(Bad, scope\)/);
    }
    expect(() => app.child({ providers: [valueProvider(Bad, new Bad())] })).toThrow(TypeError);
    expect(() => app.child({ providers: [valueProvider(Bad, new Bad())] })).toThrow(/Bad\.scope/);
    expect(() => s1.addProvider(factoryProvider(Bad, () => new Bad()))).toThrow(TypeError);
    // A provider with its own scope never reads the key's (`p.scope ?? getKeyScope(key)`).
    const ok = app.child({ name: 'ok', scopes: [SessionScope], providers: [valueProvider(Bad, new Bad(), { scope: SessionScope })] });
    expect(ok.get(Bad)).toBeInstanceOf(Bad);
    await app.close();
  });

  it('a declaration is a Scope made by createScope, by identity: a scope-shaped object is a TypeError', () => {
    class LookAlike {
      static scope = { name: 'session' };
    }
    expect(() => getKeyScope(LookAlike)).toThrow(/^LookAlike\.scope is an object, not a Scope made by createScope\(\)/);
    expect(() => createRootContext().get(LookAlike)).toThrow(TypeError);
  });
});
