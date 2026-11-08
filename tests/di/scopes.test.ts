// Tests for di / scopes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey, setScope } from '../../src/context-key.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { ContextKey, inject } from '../../src/inject.js';
import { valueProvider } from '../../src/provider-util.js';
import { SelfScope, createScope } from '../../src/scope.js';
import { lookup, own } from '../../src/ambient.js';
import { impl } from '../support/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Scopes', () => {
    it('should place scoped explicit key on the context that owns the scope', () => {
      const appScope = createScope('app');
      const CONFIG = createInjectionKey<string>('CONFIG', {
        factory: () => 'default-config',
        scope: appScope,
      });

      // The owner is not the root, so auto-hoisting (which would land on the root) is told apart from scope placement.
      const root = createRootContext();
      const owner = root.child({ scopes: [appScope] });
      const child = owner.child();

      // Resolving from child should still place the value on the owner of the scope
      expect(child.get(CONFIG)).toBe('default-config');
      // The owner should now have it cached, under the key's scope, not auto-hoisted
      expect(owner.get(CONFIG)).toBe('default-config');
      expect(impl(owner).cache.get(CONFIG)?.scope).toBe(appScope);
      expect(impl(owner).cache.get(CONFIG)?.autoHoisted).toBe(false);
      expect(impl(root).cache.has(CONFIG)).toBe(false);
    });

    it('should place scoped class key on the scoped context', () => {
      const appScope = createScope('app');

      class AppService {
        name = 'app-service';
      }
      setScope(AppService, appScope);

      // The owner is not the root: an auto-hoisted AppService (no dependencies) would land on the root.
      const root = createRootContext();
      const owner = root.child({ scopes: [appScope] });
      const child = owner.child();

      const fromChild = child.get(AppService);
      expect(fromChild.name).toBe('app-service');
      // Same instance from the owner, stored there under the scope
      expect(owner.get(AppService)).toBe(fromChild);
      expect(impl(owner).cache.get(AppService)?.value).toBe(fromChild);
      expect(impl(owner).cache.get(AppService)?.scope).toBe(appScope);
      expect(impl(owner).cache.get(AppService)?.autoHoisted).toBe(false);
      expect(impl(root).cache.has(AppService)).toBe(false);
    });

    it('should throw when scope is not found in context chain', () => {
      const requestScope = createScope('request');
      const REQUEST_ID = createInjectionKey<string>('REQUEST_ID', {
        factory: () => 'req-1',
        scope: requestScope,
      });

      const ctx = createRootContext(); // no scopes declared

      expect(() => ctx.get(REQUEST_ID)).toThrow("No context found for scope 'request'");
    });

    it('should find nearest scope in parent chain', () => {
      const requestScope = createScope('request');
      let n = 0;
      const REQUEST_ID = createInjectionKey<string>('REQUEST_ID', {
        factory: () => `req-${++n}`,
        scope: requestScope,
      });

      const root = createRootContext({ scopes: [requestScope] });
      const mid = root.child({ scopes: [requestScope] });
      const child = mid.child();

      // Should resolve to mid (nearest scope owner)
      expect(child.get(REQUEST_ID)).toBe('req-1');
      expect(mid.get(REQUEST_ID)).toBe('req-1');
      expect(impl(mid).cache.has(REQUEST_ID)).toBe(true);
      expect(impl(root).cache.has(REQUEST_ID)).toBe(false);
    });

    it('should use setScope to assign scope to a key', () => {
      const appScope = createScope('app');
      const KEY = createInjectionKey<number>('KEY', { factory: () => 42 });
      setScope(KEY, appScope);

      const root = createRootContext({ scopes: [appScope] });
      const child = root.child();

      expect(child.get(KEY)).toBe(42);
      expect(root.get(KEY)).toBe(42);
      // stored at the scope owner under the key's scope, not auto-hoisted
      expect(impl(root).cache.get(KEY)?.scope).toBe(appScope);
      expect(impl(root).cache.get(KEY)?.autoHoisted).toBe(false);
      // a nested owner of the scope stores its own (DESIGN.md §3.1); an unscoped key would hit the root's
      const owner = root.child({ scopes: [appScope] });
      expect(owner.child().get(KEY)).toBe(42);
      expect(impl(owner).cache.get(KEY)?.scope).toBe(appScope);
    });

    it('should support setScope after key creation', () => {
      const appScope = createScope('app');
      const KEY = createInjectionKey<string>('KEY', { factory: () => 'scoped-value' });
      setScope(KEY, appScope);

      const root = createRootContext({ scopes: [appScope] });
      expect(root.get(KEY)).toBe('scoped-value');
      expect(impl(root).cache.get(KEY)?.scope).toBe(appScope);
      expect(impl(root).cache.get(KEY)?.autoHoisted).toBe(false);
    });

    it('should support scope on a child (was: on an execution context)', () => {
      const requestScope = createScope('request');
      const REQUEST_ID = createInjectionKey<string>('REQUEST_ID', {
        factory: () => 'auto-id',
        scope: requestScope,
      });

      const root = createRootContext();

      using c = root.child({ scopes: [requestScope] });
      c.run(() => {
        expect(lookup(REQUEST_ID)).toBe('auto-id');
      });
    });

    it('should work with explicit provider on scoped context', () => {
      const appScope = createScope('app');
      const CONFIG = createInjectionKey<string>('CONFIG', { scope: appScope });

      const root = createRootContext({
        scopes: [appScope],
        providers: [valueProvider(CONFIG, 'provided-config')],
      });
      const child = root.child();

      expect(child.get(CONFIG)).toBe('provided-config');
    });

    it('should support multiple scopes on the same context', () => {
      const appScope = createScope('app');
      const dbScope = createScope('db');

      const APP_KEY = createInjectionKey<string>('APP', {
        factory: () => 'app-val',
        scope: appScope,
      });
      const DB_KEY = createInjectionKey<string>('DB', { factory: () => 'db-val', scope: dbScope });

      const root = createRootContext({ scopes: [appScope, dbScope] });
      const child = root.child();

      expect(child.get(APP_KEY)).toBe('app-val');
      expect(child.get(DB_KEY)).toBe('db-val');
    });

    it('should scope injection deps correctly', () => {
      const appScope = createScope('app');

      const DEP = createInjectionKey<string>('DEP', { factory: () => 'dep-val', scope: appScope });
      const MAIN = createInjectionKey<string>('MAIN', {
        factory: () => `main[${inject(DEP)}]`,
        scope: appScope,
      });

      const root = createRootContext({ scopes: [appScope] });
      const child = root.child();

      expect(child.get(MAIN)).toBe('main[dep-val]');
    });
  });

describe('SelfScope', () => {
    it('should throw without creation context or scopes: [SelfScope]', () => {
      const KEY = createInjectionKey<string>('SelfKey', {
        factory: () => 'val',
        scope: SelfScope,
      });
      const root = createRootContext();
      expect(() => root.get(KEY)).toThrow('SelfScope key');
    });

    describe('inside creation context (per-creation)', () => {
      it('should create per-creation instances', () => {
        let counter = 0;
        const SELF_KEY = createInjectionKey<number>('SelfKey', {
          factory: () => ++counter,
          scope: SelfScope,
        });
        const WRAPPER = createInjectionKey<number>('Wrapper', {
          factory: () => inject(SELF_KEY),
        });

        // root.create(WRAPPER) is removed: two sibling children each resolve WRAPPER. A SelfScope
        // dependency pins its value at the requester (DESIGN.md §3.4), so each child builds its own WRAPPER.
        const root = createRootContext();
        const c1 = root.child().get(WRAPPER);
        const c2 = root.child().get(WRAPPER);
        expect(c1).toBe(1);
        expect(c2).toBe(2);
      });

      it('should cache within the same creation', () => {
        let counter = 0;
        const SELF_KEY = createInjectionKey<number>('SelfKey', {
          factory: () => ++counter,
          scope: SelfScope,
        });
        const WRAPPER = createInjectionKey<string>('Wrapper', {
          factory: () => {
            const a = inject(SELF_KEY);
            const b = inject(SELF_KEY);
            return `${a}-${b}`;
          },
        });

        const root = createRootContext();
        expect(root.child().get(WRAPPER)).toBe('1-1');
      });

      it("should wire disposal to the outer value's node", async () => {
        let disposed = false;
        const SELF_KEY = createInjectionKey<string>('SelfKey', {
          factory: () => {
            own(() => {
              disposed = true;
            });
            return 'val';
          },
          scope: SelfScope,
        });
        let wrapperNode: Context | undefined;
        const WRAPPER = createInjectionKey<string>('Wrapper', {
          factory: () => {
            wrapperNode = inject(ContextKey);
            return inject(SELF_KEY);
          },
        });

        // own() in the SelfScope factory lands on the wrapper's node, released when its child closes.
        const root = createRootContext();
        const c = root.child();
        expect(c.get(WRAPPER)).toBe('val');
        expect(impl(wrapperNode!).explicit.size).toBe(1);
        expect(impl(wrapperNode!).parent).toBe(impl(c));
        expect(disposed).toBe(false);
        await c.close();
        expect(disposed).toBe(true);
      });
    });

    describe('with scopes: [SelfScope] (component boundary)', () => {
      it('should store on the context that owns SelfScope', () => {
        let counter = 0;
        const KEY = createInjectionKey<number>('SelfKey', {
          factory: () => ++counter,
          scope: SelfScope,
        });

        const root = createRootContext();
        const child1 = root.child({ scopes: [SelfScope] });
        const child2 = root.child({ scopes: [SelfScope] });

        expect(child1.get(KEY)).toBe(1);
        expect(child2.get(KEY)).toBe(2);
        // Cached on each child
        expect(child1.get(KEY)).toBe(1);
        expect(child2.get(KEY)).toBe(2);
      });

      it('should work with setScope', () => {
        let counter = 0;
        const KEY = createInjectionKey<number>('SetScopeSelf', {
          factory: () => ++counter,
        });
        setScope(KEY, SelfScope);

        const root = createRootContext();
        const child = root.child({ scopes: [SelfScope] });

        expect(child.get(KEY)).toBe(1);
        // Different SelfScope boundary → different instance
        const child2 = root.child({ scopes: [SelfScope] });
        expect(child2.get(KEY)).toBe(2);
      });

      it('should work with SelfScope on a class key', () => {
        class MyService {
          id = Math.random();
        }
        setScope(MyService, SelfScope);

        const root = createRootContext();
        const child1 = root.child({ scopes: [SelfScope] });
        const child2 = root.child({ scopes: [SelfScope] });

        const s1 = child1.get(MyService);
        const s2 = child2.get(MyService);
        expect(s1).toBeInstanceOf(MyService);
        expect(s2).toBeInstanceOf(MyService);
        expect(s1).not.toBe(s2);
      });

      it('should dispose with the owning context', async () => {
        let disposed = false;
        const KEY = createInjectionKey<string>('SelfKey', {
          factory: () => {
            own(() => {
              disposed = true;
            });
            return 'val';
          },
          scope: SelfScope,
        });

        const root = createRootContext();
        const child = root.child({ scopes: [SelfScope] });
        expect(child.get(KEY)).toBe('val');
        expect(disposed).toBe(false);

        await child.close();
        expect(disposed).toBe(true);
      });

      it('should not hoist past the SelfScope boundary', () => {
        let counter = 0;
        const KEY = createInjectionKey<number>('SelfKey', {
          factory: () => ++counter,
          scope: SelfScope,
        });

        const root = createRootContext({ scopes: [SelfScope] });
        const child = root.child({ scopes: [SelfScope] });

        expect(child.get(KEY)).toBe(1);
        // Root should get its own instance — child's SelfScope boundary caught it
        expect(root.get(KEY)).toBe(2);
      });
    });
  });
