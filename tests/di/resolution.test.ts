// Tests for di / resolution.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey } from '../../src/context-key.js';
import { createRootContext } from '../../src/create-context.js';
import { inject } from '../../src/inject.js';
import { aliasProvider, classProvider, valueProvider } from '../../src/provider-util.js';
import { lookup } from '../../src/ambient.js';
import { impl } from '../support/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Context', () => {
  const KEY_A = createInjectionKey<string>('A');
  const KEY_B = createInjectionKey<string>('B');

  it('should provide values', () => {
    const context = createRootContext({
      providers: [valueProvider(KEY_A, 'value-a')],
    });

    expect(context.get(KEY_A)).toBe('value-a');
  });

  it('should throw for missing values', () => {
    const context = createRootContext();
    expect(() => context.get(KEY_A)).toThrow('No provider found for key: A');
  });

  it('should return undefined for optional missing values', () => {
    const context = createRootContext();
    expect(context.get(KEY_A, { optional: true })).toBeUndefined();
  });

  it('should resolve dependencies', () => {
    const context = createRootContext({
      providers: [
        valueProvider(KEY_A, 'value-a'),
        {
          key: KEY_B,
          provide: () => inject(KEY_A) + '-b',
        },
      ],
    });

    expect(context.get(KEY_B)).toBe('value-a-b');
  });

  it('should handle class providers', () => {
    class ServiceA {
      value = 'service-a';
    }

    const context = createRootContext({
      providers: [classProvider(ServiceA)],
    });

    expect(context.get(ServiceA)).toBeInstanceOf(ServiceA);
    expect(context.get(ServiceA).value).toBe('service-a');
  });

  it('should handle alias providers', () => {
    const context = createRootContext({
      providers: [valueProvider(KEY_A, 'value-a'), aliasProvider(KEY_B, KEY_A)],
    });
    expect(context.get(KEY_B)).toBe('value-a');
  });

  it('should detect circular dependencies', () => {
    const context = createRootContext({
      providers: [
        { key: KEY_A, provide: () => inject(KEY_B) },
        { key: KEY_B, provide: () => inject(KEY_A) },
      ],
    });

    expect(() => {
      context.get(KEY_A);
    }).toThrow('Circular dependency detected: A → B → A');
  });

  it('should detect self-referencing circular dependency', () => {
    const context = createRootContext({
      providers: [{ key: KEY_A, provide: () => inject(KEY_A) }],
    });

    expect(() => {
      context.get(KEY_A);
    }).toThrow('Circular dependency detected: A → A');
  });

  it('should detect circular dependencies in longer chains', () => {
    const KEY_C = createInjectionKey<string>('C');
    const context = createRootContext({
      providers: [
        { key: KEY_A, provide: () => inject(KEY_B) },
        { key: KEY_B, provide: () => inject(KEY_C) },
        { key: KEY_C, provide: () => inject(KEY_A) },
      ],
    });

    expect(() => {
      context.get(KEY_A);
    }).toThrow('Circular dependency detected: A → B → C → A');
  });

  it('should inherit from parent context', () => {
    const parent = createRootContext({
      providers: [valueProvider(KEY_A, 'parent-a')],
    });
    const child = parent.child({
      providers: [valueProvider(KEY_B, 'child-b')],
    });

    expect(child.get(KEY_A)).toBe('parent-a');
    expect(child.get(KEY_B)).toBe('child-b');
  });

  it('should shadow parent providers', () => {
    const parent = createRootContext({
      providers: [valueProvider(KEY_A, 'parent-a')],
    });
    const child = parent.child({
      providers: [valueProvider(KEY_A, 'child-a')],
    });

    expect(child.get(KEY_A)).toBe('child-a');
  });

  describe('default providers', () => {
    it('should use class as key with default provider', () => {
      class Logger {
        log(msg: string) {
          return msg;
        }
      }

      const ctx = createRootContext();
      const logger = ctx.get(Logger);

      expect(logger).toBeInstanceOf(Logger);
      expect(logger.log('hello')).toBe('hello');
    });

    it('should return same instance on repeated get', () => {
      class Logger {}

      const ctx = createRootContext();
      expect(ctx.get(Logger)).toBe(ctx.get(Logger));
    });

    it('should use explicit key with default factory', () => {
      const CONFIG = createInjectionKey<{ port: number }>('CONFIG', {
        factory: () => ({ port: 3000 }),
      });

      const ctx = createRootContext();
      expect(ctx.get(CONFIG)).toEqual({ port: 3000 });
    });

    it('should use function as key with default provider', () => {
      const createAdder = () => (a: number, b: number) => a + b;

      const ctx = createRootContext();
      const adder = ctx.get(createAdder);

      expect(adder(2, 3)).toBe(5);
    });

    it('should inject dependencies in class default provider', () => {
      const CONFIG = createInjectionKey('CONFIG', { factory: () => ({ greeting: 'Hello' }) });

      class Greeter {
        config = inject(CONFIG);
        greet(name: string) {
          return `${this.config.greeting}, ${name}!`;
        }
      }

      const ctx = createRootContext();
      expect(ctx.get(Greeter).greet('World')).toBe('Hello, World!');
    });

    it('should inject dependencies in function default provider', () => {
      const CONFIG = createInjectionKey('CONFIG', { factory: () => ({ greeting: 'Hi' }) });

      const createGreeter = () => {
        const config = inject(CONFIG);
        return (name: string) => `${config.greeting}, ${name}!`;
      };

      const ctx = createRootContext();
      expect(ctx.get(createGreeter)('World')).toBe('Hi, World!');
    });
  });

  describe('auto-scoping', () => {
    it('should auto-scope class with no deps to root', () => {
      class Logger {}

      const root = createRootContext();
      const child = root.child();

      const logger = child.get(Logger);

      expect(logger).toBeInstanceOf(Logger);
      // Should be auto-scoped to root — same instance from root
      expect(root.get(Logger)).toBe(logger);
    });

    it('should auto-scope to the level of the deepest dependency', () => {
      class Database {}

      class UserRepo {
        db = inject(Database);
      }

      const root = createRootContext();
      const child = root.child({
        providers: [valueProvider(Database, new Database())],
      });

      const repo = child.get(UserRepo);

      expect(repo).toBeInstanceOf(UserRepo);
      expect(repo.db).toBeInstanceOf(Database);
      // UserRepo depends on Database which is in child — so UserRepo stays in child
      expect(child.get(UserRepo)).toBe(repo);
      // Root should NOT have UserRepo
      expect(root.get(UserRepo, { optional: true })).not.toBe(repo);
    });

    it('should auto-scope transitive deps to root when all deps are at root', () => {
      class Logger {}

      class Database {
        logger = inject(Logger);
      }

      class UserRepo {
        db = inject(Database);
      }

      const root = createRootContext();
      const child = root.child();

      const repo = child.get(UserRepo);

      // All deps are default-provided, all auto-scope to root
      expect(root.get(UserRepo)).toBe(repo);
      expect(root.get(Database)).toBe(repo.db);
      expect(root.get(Logger)).toBe(repo.db.logger);
    });

    it('should auto-scope function keys to root when no child deps', () => {
      const createLogger = () => (msg: string) => `[LOG] ${msg}`;

      const root = createRootContext();
      const child = root.child();

      const logger = child.get(createLogger);

      expect(logger('test')).toBe('[LOG] test');
      expect(root.get(createLogger)).toBe(logger);
    });

    it('should not auto-scope past a child-level dependency', () => {
      const REQUEST = createInjectionKey<{ url: string }>('REQUEST');

      class RequestHandler {
        request = inject(REQUEST);
      }

      const root = createRootContext();
      const child = root.child({
        providers: [valueProvider(REQUEST, { url: '/api/users' })],
      });

      const handler = child.get(RequestHandler);

      expect(handler.request.url).toBe('/api/users');
      // Handler should be at child level — same instance from child
      expect(child.get(RequestHandler)).toBe(handler);
      // Root can't create RequestHandler because REQUEST isn't available there
      expect(() => root.get(RequestHandler)).toThrow();
    });

    it('should auto-scope to intermediate level based on deps', () => {
      class RootService {}

      const TENANT_ID = createInjectionKey<string>('TENANT_ID');

      class TenantService {
        rootService = inject(RootService);
        tenantId = inject(TENANT_ID);
      }

      const root = createRootContext();
      const tenant = root.child({
        providers: [valueProvider(TENANT_ID, 'tenant-1')],
      });
      const request = tenant.child();

      const svc = request.get(TenantService);

      expect(svc.tenantId).toBe('tenant-1');
      expect(svc.rootService).toBeInstanceOf(RootService);
      // TenantService should be at tenant level (deepest dep is TENANT_ID)
      expect(tenant.get(TenantService)).toBe(svc);
      // RootService should be at root
      expect(root.get(RootService)).toBe(svc.rootService);
    });
  });
});

// ---------------------------------------------------------------------------
// push-context.test.ts › captureAutoScoped (4), with ctx.run instead of the removed enter/leave pair
// ---------------------------------------------------------------------------

describe('captureAutoScoped', () => {
  class AutoScopedService {
    readonly id = Math.random();
  }

  it('without capture, auto-scoped values are placed on the parent context', async () => {
    const suite = createRootContext();
    const test = suite.child();

    const svc = test.run(() => lookup(AutoScopedService));
    await test.close();

    // The value was placed on suite — still served there
    expect(suite.run(() => lookup(AutoScopedService))).toBe(svc);
    await suite.close();
  });

  it('with capture, auto-scoped values stay within the boundary', async () => {
    const suite = createRootContext();
    const test = suite.child({ captureAutoScoped: true });

    const svc = test.run(() => lookup(AutoScopedService));
    expect(svc).toBeInstanceOf(AutoScopedService);
    expect(impl(test).cache.has(AutoScopedService)).toBe(true);
    expect(impl(suite).cache.has(AutoScopedService)).toBe(false);

    await test.close();

    // DESIGN.md §3.3, §3.4: the suite resolves independently of the captured child and builds its own instance.
    const fresh = suite.run(() => lookup(AutoScopedService));
    expect(fresh).toBeInstanceOf(AutoScopedService);
    expect(fresh).not.toBe(svc);
    await suite.close();
  });

  it('each captured context gets a fresh auto-scoped instance', async () => {
    const suite = createRootContext();

    const test1 = suite.child({ captureAutoScoped: true });
    const svc1 = test1.run(() => lookup(AutoScopedService));
    await test1.close();

    const test2 = suite.child({ captureAutoScoped: true });
    const svc2 = test2.run(() => lookup(AutoScopedService));
    expect(svc2).not.toBe(svc1); // fresh instance
    await test2.close();

    await suite.close();
  });

  it('auto-scoped values with deps on suite providers are captured', async () => {
    class Database {
      readonly name = 'test-db';
    }

    class UserRepo {
      db = inject(Database);
    }

    const suite = createRootContext();
    suite.addProvider(valueProvider(Database, new Database()));

    const test = suite.child({ captureAutoScoped: true });
    const repo = test.run(() => lookup(UserRepo));
    expect(repo).toBeInstanceOf(UserRepo);
    expect(repo.db.name).toBe('test-db');
    expect(impl(test).cache.has(UserRepo)).toBe(true);

    await test.close();

    // DESIGN.md §3.3, §3.4: the captured UserRepo belongs to the child; the suite builds its own.
    const fresh = suite.run(() => lookup(UserRepo));
    expect(fresh).not.toBe(repo);
    // Database is still served (it was explicitly provided at suite level)
    expect(fresh.db).toBe(repo.db);
    expect(suite.run(() => lookup(Database)).name).toBe('test-db');

    await suite.close();
  });
});
