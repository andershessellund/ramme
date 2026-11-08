// Tests for di / provider registration.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey, setDependencies } from '../../src/context-key.js';
import { createRootContext } from '../../src/create-context.js';
import { inject } from '../../src/inject.js';
import { aliasProvider, classProvider, factoryProvider, valueProvider } from '../../src/provider-util.js';
import { PlacementError } from '../../src/resource.js';
import { SelfScope, createScope } from '../../src/scope.js';
import { impl } from '../support/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('addProvider', () => {
  it('should allow addProvider before any resolution of the key', () => {
    const key = createInjectionKey<string>('Lazy');
    const ctx = createRootContext();
    ctx.addProvider({ key, provide: () => 'hello' });
    expect(ctx.get(key)).toBe('hello');
  });

  it('should throw when adding provider after key is resolved locally', () => {
    const key = createInjectionKey<string>('Eager');
    const ctx = createRootContext({
      providers: [valueProvider(key, 'original')],
    });
    ctx.get(key);
    expect(() => ctx.addProvider({ key, provide: () => 'replacement' })).toThrow(PlacementError);
    expect(() => ctx.addProvider({ key, provide: () => 'replacement' })).toThrow(/decided/);
  });

  it('allows adding a provider at a fresh child after the key resolved at an ancestor', () => {
    // DESIGN.md §3.4: a fresh child has no decisions, so providing there is allowed. The ancestor's
    // answer is unchanged; the child answers for itself.
    const key = createInjectionKey<string>('Root');
    const root = createRootContext({
      providers: [valueProvider(key, 'root-value')],
    });
    root.get(key); // resolve at root
    const child = root.child();
    expect(() => child.addProvider({ key, provide: () => 'child-value' })).not.toThrow();
    expect(child.get(key)).toBe('child-value');
    expect(root.get(key)).toBe('root-value');
  });

  it('allows adding a provider at the root after an auto-scoped value was stored at a child', () => {
    // DESIGN.md §3.4: the root never answered for UserRepo (the child did), so it may provide it,
    // and root.get(UserRepo) builds a distinct root instance instead of the order-dependent "No provider found".
    class Database {}
    class UserRepo {
      db = inject(Database);
    }
    const root = createRootContext();
    const child = root.child({
      providers: [classProvider(Database)],
    });
    const atChild = child.get(UserRepo); // auto-scoped to child; the root is not decided
    expect(() => root.addProvider({ key: UserRepo, provide: () => new UserRepo() })).not.toThrow();
    const atRoot = root.get(UserRepo);
    expect(atRoot).not.toBe(atChild);
    expect(atRoot.db).not.toBe(atChild.db);
    expect(child.get(UserRepo)).toBe(atChild); // the child's answer is unchanged (I19)
  });

  it('a scoped key that is not provided marks the whole walk, so a later provider above the scope owner is refused (I19)', () => {
    const σ = createScope('request');
    const key = createInjectionKey<string>('ScopedMissing', { scope: σ });
    const root = createRootContext();
    const T = root.child({ scopes: [σ] });
    const R = T.child();
    expect(R.get(key, { optional: true })).toBeUndefined(); // the provider search walked R..root
    // A scoped key may be provided at or above its scope owner; doing so now would change R's answer.
    expect(() => root.addProvider(valueProvider(key, 'late'))).toThrow(PlacementError);
    expect(() => T.addProvider(valueProvider(key, 'late'))).toThrow(PlacementError);
    expect(R.get(key, { optional: true })).toBeUndefined(); // unchanged
  });

  it('classProvider resolves constructor arguments declared with setDependencies, in both forms', () => {
    const Url = createInjectionKey<string>('Url');
    class Client {
      constructor(readonly url: string) {}
    }
    setDependencies(Client, Url);
    const Api = createInjectionKey<Client>('Api');
    const root = createRootContext({
      providers: [valueProvider(Url, 'https://x'), classProvider(Client), classProvider(Api, Client)],
    });
    expect(root.get(Client).url).toBe('https://x');
    expect(root.get(Api).url).toBe('https://x');
    expect(root.get(Api)).not.toBe(root.get(Client)); // two providers, two instances
  });

  it('should throw when adding provider after optional lookup returns undefined', () => {
    const key = createInjectionKey<string>('Missing');
    const ctx = createRootContext();
    expect(ctx.get(key, { optional: true })).toBeUndefined();
    expect(() => ctx.addProvider({ key, provide: () => 'late' })).toThrow(PlacementError);
    expect(() => ctx.addProvider({ key, provide: () => 'late' })).toThrow(/decided/);
  });

  it('should allow addProvider for unrelated keys after other keys resolved', () => {
    const key1 = createInjectionKey<string>('Key1');
    const key2 = createInjectionKey<string>('Key2');
    const ctx = createRootContext({
      providers: [valueProvider(key1, 'val1')],
    });
    ctx.get(key1); // resolve key1
    // key2 was never resolved — addProvider should work
    ctx.addProvider({ key: key2, provide: () => 'val2' });
    expect(ctx.get(key2)).toBe('val2');
  });

  it('should allow creation-time providers to shadow parent values', () => {
    const key = createInjectionKey<string>('Shadowed');
    const root = createRootContext({
      providers: [valueProvider(key, 'root-value')],
    });
    root.get(key); // resolve at root
    // New child created with its own provider — this is fine
    const child = root.child({
      providers: [valueProvider(key, 'child-value')],
    });
    expect(child.get(key)).toBe('child-value');
  });
});

// D36: a provider has no `scope` option and stores its value where it is registered; a key's scope places
  // only the key's own default. The per-creation binding is an alias to a SelfScope-declared implementation.
  describe('providers place where registered', () => {
  it('should store explicit provider value on its own node', () => {
    const requestScope = createScope('request');
    const CONFIG = createInjectionKey<string>('CONFIG', { scope: requestScope });

    const root = createRootContext({
      providers: [valueProvider(CONFIG, 'root-config')],
    });
    const child = root.child({ scopes: [requestScope] });

    // The key's scope is owned by the child, below the provider: the value is still the root's.
    expect(child.get(CONFIG)).toBe('root-config');
    expect(impl(root).cache.has(CONFIG)).toBe(true);
    expect(impl(child).cache.has(CONFIG)).toBe(false);
  });

  it('should let a provider below the key scope owner override the key default for its subtree', () => {
    const appScope = createScope('app');
    const requestScope = createScope('request');

    const KEY = createInjectionKey<string>('KEY', {
      factory: () => 'default',
      scope: appScope,
    });

    const root = createRootContext({ scopes: [appScope, requestScope] });
    const mid = root.child({ scopes: [requestScope] });
    const child = mid.child();

    // Below the owner of the key's appScope, and allowed: stored on mid
    mid.addProvider(factoryProvider(KEY, () => 'overridden'));

    expect(child.get(KEY)).toBe('overridden');
    expect(mid.get(KEY)).toBe('overridden');
    expect(impl(mid).cache.has(KEY)).toBe(true);
    expect(root.get(KEY)).toBe('default'); // the default, at the scope owner
  });

  it('should not need the key scope to be carried anywhere when provided', () => {
    const missingScope = createScope('missing');
    const KEY = createInjectionKey<string>('KEY', { scope: missingScope });
    const DEFAULTED = createInjectionKey<string>('DEFAULTED', { scope: missingScope, factory: () => 'default' });

    const root = createRootContext({
      providers: [valueProvider(KEY, 'val')],
    });

    expect(root.get(KEY)).toBe('val');
    expect(() => root.get(DEFAULTED)).toThrow("No context found for scope 'missing'"); // a default needs its scope
  });

  it('should give each creation its own instance through an alias to a SelfScope implementation (creation context)', () => {
    let counter = 0;
    const KEY = createInjectionKey<number>('SelfProvider');
    const IMPL = createInjectionKey<number>('SelfImpl', { scope: SelfScope, factory: () => ++counter });

    const root = createRootContext({
      providers: [aliasProvider(KEY, IMPL)],
    });

    // Each creation gets its own instance. root.create(WRAPPER) is removed:
    // two sibling children each resolve WRAPPER, pinned at its requester (DESIGN.md §3.4).
    const WRAPPER = createInjectionKey<number>('Wrapper', {
      factory: () => inject(KEY),
    });
    const c1 = root.child().get(WRAPPER);
    const c2 = root.child().get(WRAPPER);
    expect(c1).toBe(1);
    expect(c2).toBe(2);
  });

  it('should give each SelfScope context its own instance through an alias to a SelfScope implementation (scoped context)', () => {
    let counter = 0;
    const KEY = createInjectionKey<number>('SelfProvider');
    const IMPL = createInjectionKey<number>('SelfImpl', { scope: SelfScope, factory: () => ++counter });

    const root = createRootContext({
      providers: [aliasProvider(KEY, IMPL)],
    });

    const child1 = root.child({ scopes: [SelfScope] });
    const child2 = root.child({ scopes: [SelfScope] });
    expect(child1.get(KEY)).toBe(1);
    expect(child2.get(KEY)).toBe(2);
    expect(child1.get(KEY)).toBe(1);
  });

  it('should cache a factoryProvider value on its node', () => {
    let counter = 0;
    const KEY = createInjectionKey<number>('Counter');

    const root = createRootContext({
      providers: [factoryProvider(KEY, () => ++counter)],
    });

    expect(root.get(KEY)).toBe(1);
    expect(root.child().get(KEY)).toBe(1); // cached
  });

  it("should construct a classProvider value on its node, ignoring the implementation's static scope", () => {
    const appScope = createScope('app');

    class MyService {
      name = 'service';
    }
    class MyServiceImpl extends MyService {
      static readonly scope = appScope; // ignored: classProvider(Key, Impl) states the placement (D36)
    }

    const root = createRootContext({
      providers: [classProvider(MyService, MyServiceImpl)],
    });
    const child = root.child({ scopes: [appScope] }); // the owner of the implementation's scope, below the provider

    const fromChild = child.get(MyService);
    expect(fromChild).toBeInstanceOf(MyServiceImpl);
    expect(fromChild.name).toBe('service');
    expect(root.get(MyService)).toBe(fromChild); // same instance, stored at root
    expect(impl(root).cache.has(MyService)).toBe(true);
    expect(impl(child).cache.has(MyService)).toBe(false);
    expect(impl(child).cache.has(MyServiceImpl)).toBe(false);
  });
});
