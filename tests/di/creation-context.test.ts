// Tests for di / creation context.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey, setScope } from '../../src/context-key.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { ContextKey, inject } from '../../src/inject.js';
import { classProvider } from '../../src/provider-util.js';
import { CreationViolationError, PendingNodeError } from '../../src/resource.js';
import { RootScope, createScope } from '../../src/scope.js';
import { lookup } from '../../src/ambient.js';
import { here, impl, tick } from '../support/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContextKey / current() in creation', () => {
    it('is the live value node, placed on the scope owner, for explicitly scoped keys', () => {
      class MyService {
        ctx = inject(ContextKey);
      }
      setScope(MyService, RootScope);

      const root = createRootContext();
      const svc = root.get(MyService);
      expect(impl(svc.ctx).kind).toBe('value');
      expect(svc.ctx.state).toBe('running');
      expect(impl(svc.ctx).parent).toBe(impl(root));
      // placed by its scope, not auto-hoisted to the same root
      expect(impl(root).cache.get(MyService)?.scope).toBe(RootScope);
      expect(impl(root).cache.get(MyService)?.autoHoisted).toBe(false);
      expect(impl(root).cache.get(MyService)?.valueNode).toBe(impl(svc.ctx));
    });

    it('is the live value node when provided via a provider', () => {
      class MyService {
        ctx = inject(ContextKey);
      }

      const root = createRootContext({
        providers: [classProvider(MyService, MyService)],
      });
      const svc = root.get(MyService);
      expect(svc.ctx.state).toBe('running');
      expect(impl(svc.ctx).parent).toBe(impl(root));
    });

    it('sits under the scoped context, not the requesting context', () => {
      class MyService {
        ctx = inject(ContextKey);
      }
      setScope(MyService, RootScope);

      const root = createRootContext();
      const child = root.child();
      const svc = child.get(MyService);
      expect(impl(svc.ctx).parent).toBe(impl(root));
      expect(impl(root).cache.get(MyService)?.scope).toBe(RootScope);
      expect(impl(root).cache.get(MyService)?.autoHoisted).toBe(false);
      // a non-root owner of a scope: auto-hoisting would land on the root instead
      const appScope = createScope('app');
      class AppService {
        ctx = inject(ContextKey);
      }
      setScope(AppService, appScope);
      const owner = root.child({ scopes: [appScope] });
      const app = owner.child().get(AppService);
      expect(impl(app.ctx).parent).toBe(impl(owner));
      expect(impl(owner).cache.get(AppService)?.scope).toBe(appScope);
      expect(impl(root).cache.has(AppService)).toBe(false);
    });

    it('is available for auto-hoisted values (placed after the factory)', () => {
      class MyService {
        ctx = inject(ContextKey);
      }

      const root = createRootContext();
      const svc = root.get(MyService);
      // After creation completes, the node is placed
      expect(svc.ctx.state).toBe('running');
      expect(impl(svc.ctx).parent).toBe(impl(root));
    });

    it('throws PendingNodeError when used for get() during the auto-hoisted factory body', () => {
      // DESIGN.md §3.3: reading inject(ContextKey) in an auto-hoisted factory is allowed — it is the
      // pending node — and get() on it throws PendingNodeError.

      const ConfigKey = createInjectionKey<string>('Config', { factory: () => 'hello' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      let caught: unknown;
      class MyService {
        ctx = inject(ContextKey);
        constructor() {
          try {
            // the pending node cannot resolve before placement (DESIGN.md §3.3)
            this.ctx.get(ConfigKey);
          } catch (e) {
            caught = e;
          }
        }
      }

      const root = createRootContext();
      const svc = root.get(MyService);
      expect(caught).toBeInstanceOf(PendingNodeError);
      // After creation, it's placed
      expect(svc.ctx.state).toBe('running');
      expect(svc.ctx.get(ConfigKey)).toBe('hello');
    });

    it('a constructor fork runs after placement', async () => {
      let seen: { state: string; parent: unknown } | undefined;
      class MyService {
        ctx = inject(ContextKey);
        constructor() {
          const n = here();
          const ctx = this.ctx; // a function* has its own `this`
          n.own(
            n.fork(function* () {
              seen = { state: ctx.state, parent: impl(ctx).parent };
            }),
          );
        }
      }

      const root = createRootContext();
      root.get(MyService);
      expect(seen).toBeUndefined(); // never in the creation frame (I20)
      await tick();
      expect(seen).toEqual({ state: 'running', parent: impl(root) });
      await root.close();
    });

    it('throws CreationViolationError when read outside creation (DESIGN.md §4.12)', () => {
      expect(() => inject(ContextKey)).toThrow(CreationViolationError);
      const root = createRootContext();
      expect(() => root.get(ContextKey)).toThrow(CreationViolationError);
    });

    it('throws CreationViolationError when looked up inside an execution context (DESIGN.md §4.12)', () => {
      const root = createRootContext();
      root.run(() => {
        expect(() => lookup(ContextKey)).toThrow(CreationViolationError);
      });
    });

    it('works in factory functions with explicit scope', () => {
      const MyKey = createInjectionKey<{ ctx: Context }>('MyKey', {
        scope: RootScope,
        factory: () => ({ ctx: inject(ContextKey) }),
      });

      const root = createRootContext();
      const val = root.get(MyKey);
      expect(impl(val.ctx).parent).toBe(impl(root));
      expect(impl(root).cache.get(MyKey)?.scope).toBe(RootScope);
      expect(impl(root).cache.get(MyKey)?.autoHoisted).toBe(false);
      // with a non-root owner of the key's scope, the value sits under that owner
      const appScope = createScope('app');
      const AppKey = createInjectionKey<{ ctx: Context }>('AppKey', {
        scope: appScope,
        factory: () => ({ ctx: inject(ContextKey) }),
      });
      const owner = root.child({ scopes: [appScope] });
      const app = owner.child().get(AppKey);
      expect(impl(app.ctx).parent).toBe(impl(owner));
      expect(impl(owner).cache.get(AppKey)?.scope).toBe(appScope);
      expect(impl(root).cache.has(AppKey)).toBe(false);
    });

    it('is a functional context after creation (#ctx.get)', () => {
      const ConfigKey = createInjectionKey<string>('Config', {
        factory: () => 'hello',
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      class MyService {
        ctx = inject(ContextKey);
        getConfig() {
          return this.ctx.get(ConfigKey);
        }
      }
      setScope(MyService, RootScope);

      const root = createRootContext();
      const svc = root.get(MyService);
      expect(svc.getConfig()).toBe('hello');
      expect(svc.getConfig()).toBe('hello');
      // a late read on a value's node that creates a value is reported, once per key (DESIGN.md §3.5, §4.4)
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/late read/);
    });

    it('works with custom scopes', () => {
      const myScope = createScope('my-scope');

      class MyService {
        ctx = inject(ContextKey);
      }
      setScope(MyService, myScope);

      const root = createRootContext();
      const child = root.child({ scopes: [myScope] });
      const svc = child.get(MyService);
      expect(impl(svc.ctx).parent).toBe(impl(child));
    });
  });
