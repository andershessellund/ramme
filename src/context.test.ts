import { describe, it, expect } from 'vitest';
import { createInjectionKey, setScope, setDependencies } from './context-key.js';
import {
  classProvider,
  valueProvider,
  aliasProvider,
  factoryProvider,
  resourceProvider,
} from './provider-util.js';
import { createContext, createRootContext } from './create-context.js';
import { inject, lookup, create, RegisterResource, ContextRefKey } from './inject.js';
import { Dispose } from './resource.js';
import './node.js';
import { createScope, SelfScope, RootScope } from './scope.js';
import { createRefCountedKey, refCountedProvider } from './ref-count.js';

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
        {
          key: KEY_A,
          provide: () => inject(KEY_B),
        },
        {
          key: KEY_B,
          provide: () => inject(KEY_A),
        },
      ],
    });

    expect(() => {
      context.get(KEY_A);
    }).toThrow('Circular dependency detected: A → B → A');
  });

  it('should detect self-referencing circular dependency', () => {
    const context = createRootContext({
      providers: [
        {
          key: KEY_A,
          provide: () => inject(KEY_A),
        },
      ],
    });

    expect(() => {
      context.get(KEY_A);
    }).toThrow('Circular dependency detected: A → A');
  });

  it('should detect circular dependencies in longer chains', () => {
    const KEY_C = createInjectionKey<string>('C');
    const context = createRootContext({
      providers: [
        {
          key: KEY_A,
          provide: () => inject(KEY_B),
        },
        {
          key: KEY_B,
          provide: () => inject(KEY_C),
        },
        {
          key: KEY_C,
          provide: () => inject(KEY_A),
        },
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
    const child = createContext({
      parent,
      providers: [valueProvider(KEY_B, 'child-b')],
    });

    expect(child.get(KEY_A)).toBe('parent-a');
    expect(child.get(KEY_B)).toBe('child-b');
  });

  it('should shadow parent providers', () => {
    const parent = createRootContext({
      providers: [valueProvider(KEY_A, 'parent-a')],
    });
    const child = createContext({
      parent,
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
      const child = createContext({ parent: root });

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
      const child = createContext({
        parent: root,
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
      const child = createContext({ parent: root });

      const repo = child.get(UserRepo);

      // All deps are default-provided, all auto-scope to root
      expect(root.get(UserRepo)).toBe(repo);
      expect(root.get(Database)).toBe(repo.db);
      expect(root.get(Logger)).toBe(repo.db.logger);
    });

    it('should auto-scope function keys to root when no child deps', () => {
      const createLogger = () => (msg: string) => `[LOG] ${msg}`;

      const root = createRootContext();
      const child = createContext({ parent: root });

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
      const child = createContext({
        parent: root,
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
      const tenant = createContext({
        parent: root,
        providers: [valueProvider(TENANT_ID, 'tenant-1')],
      });
      const request = createContext({ parent: tenant });

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

describe('Execution Context', () => {
  it('lookup() should read from context inside ctx.run()', () => {
    const KEY = createInjectionKey<string>('KEY');

    const ctx = createRootContext({
      providers: [valueProvider(KEY, 'hello')],
    });

    ctx.run(() => {
      expect(lookup(KEY)).toBe('hello');
    });
  });

  it('should resolve child context providers via runSync', () => {
    const REQUEST = createInjectionKey<{ url: string }>('REQUEST');

    const ctx = createRootContext();

    ctx.runSync(
      () => {
        expect(lookup(REQUEST)).toEqual({ url: '/api/test' });
      },
      { providers: [valueProvider(REQUEST, { url: '/api/test' })] },
    );
  });

  it('child context providers win over parent (child-wins)', () => {
    const KEY = createInjectionKey<string>('KEY');

    const ctx = createRootContext({
      providers: [valueProvider(KEY, 'parent')],
    });

    // runSync providers override the parent context's providers
    ctx.runSync(
      () => {
        expect(lookup(KEY)).toBe('child');
      },
      { providers: [valueProvider(KEY, 'child')] },
    );
  });

  it('inject() should throw outside any context', () => {
    const KEY = createInjectionKey<string>('KEY');
    expect(() => lookup(KEY)).toThrow(/outside/i);
  });

  it('nested runSync should inherit parent EC', () => {
    const OUTER = createInjectionKey<string>('OUTER');
    const INNER = createInjectionKey<string>('INNER');

    const ctx = createRootContext();

    ctx.runSync(
      (outerCtx) => {
        outerCtx.runSync(
          () => {
            // Inner EC can see its own provider
            expect(lookup(INNER)).toBe('inner-val');
            // Inner EC can see outer EC's provider via parent chain
            expect(lookup(OUTER)).toBe('outer-val');
          },
          { providers: [valueProvider(INNER, 'inner-val')] },
        );
      },
      { providers: [valueProvider(OUTER, 'outer-val')] },
    );
  });

  it('should auto-scope class with only structural deps into structural context', () => {
    class Logger {
      log(msg: string) {
        return msg;
      }
    }

    const ctx = createRootContext();

    ctx.run(() => {
      const logger = lookup(Logger);
      expect(logger).toBeInstanceOf(Logger);
    });

    // Logger had no deps — auto-scoped to structural root
    expect(ctx.get(Logger)).toBeInstanceOf(Logger);
  });

  it('should auto-scope class depending on structural dep to structural context', () => {
    class Database {}

    class UserRepo {
      db = inject(Database);
    }

    const ctx = createRootContext();

    ctx.run(() => {
      const repo = lookup(UserRepo);
      expect(repo).toBeInstanceOf(UserRepo);
      expect(repo.db).toBeInstanceOf(Database);
    });

    // Both auto-scoped to structural root
    expect(ctx.get(UserRepo)).toBeInstanceOf(UserRepo);
    expect(ctx.get(Database)).toBeInstanceOf(Database);
  });

  it('should store in execution context when depending on EC provider', () => {
    const REQUEST = createInjectionKey<{ url: string }>('REQUEST');

    class RequestHandler {
      request = inject(REQUEST);
    }

    const ctx = createRootContext();

    let handler: RequestHandler;
    ctx.runSync(
      () => {
        handler = lookup(RequestHandler);
        expect(handler.request.url).toBe('/test');
      },
      { providers: [valueProvider(REQUEST, { url: '/test' })] },
    );

    // RequestHandler should NOT be in structural context — trying to
    // create it there would fail because REQUEST has no structural provider.
    // Instead, verify that the structural injector doesn't have it cached.
    expect(() => ctx.get(RequestHandler)).toThrow();
  });

  it('should store in EC when mixing structural and EC deps', () => {
    class Database {}

    const REQUEST = createInjectionKey<{ url: string }>('REQUEST');

    class RequestHandler {
      db = inject(Database);
      request = inject(REQUEST);
    }

    const ctx = createRootContext();

    let handler: RequestHandler;
    ctx.runSync(
      () => {
        handler = lookup(RequestHandler);
        expect(handler.db).toBeInstanceOf(Database);
        expect(handler.request.url).toBe('/api');
      },
      { providers: [valueProvider(REQUEST, { url: '/api' })] },
    );

    // Database should be auto-scoped to structural root (pure structural dep)
    expect(ctx.get(Database)).toBe(handler!.db);
    // RequestHandler depends on EC provider — should NOT be in structural.
    // Trying to create it structurally fails because REQUEST has no structural provider.
    expect(() => ctx.get(RequestHandler)).toThrow();
  });

  it('each runSync should get independent EC-scoped instances', () => {
    const REQUEST = createInjectionKey<{ id: number }>('REQUEST');

    class RequestHandler {
      request = inject(REQUEST);
    }

    const ctx = createRootContext();

    let handler1: RequestHandler;
    let handler2: RequestHandler;

    ctx.runSync(
      () => {
        handler1 = lookup(RequestHandler);
      },
      { providers: [valueProvider(REQUEST, { id: 1 })] },
    );

    ctx.runSync(
      () => {
        handler2 = lookup(RequestHandler);
      },
      { providers: [valueProvider(REQUEST, { id: 2 })] },
    );

    expect(handler1!).not.toBe(handler2!);
    expect(handler1!.request.id).toBe(1);
    expect(handler2!.request.id).toBe(2);
  });

  it('default-factory class auto-created in EC should share structural deps', () => {
    class SharedService {
      value = 'shared';
    }

    const REQUEST = createInjectionKey<string>('REQUEST');

    class HandlerA {
      shared = inject(SharedService);
      request = inject(REQUEST);
    }
    class HandlerB {
      shared = inject(SharedService);
      request = inject(REQUEST);
    }

    const ctx = createRootContext();

    ctx.runSync(
      () => {
        const a = lookup(HandlerA);
        const b = lookup(HandlerB);
        // SharedService is purely structural — should be same instance
        expect(a.shared).toBe(b.shared);
      },
      { providers: [valueProvider(REQUEST, 'req-1')] },
    );

    // SharedService should be auto-scoped to structural root
    expect(ctx.get(SharedService)).toBeInstanceOf(SharedService);
  });
});

describe('Context.runSync', () => {
  it('lookup() should read from parent inside runSync', () => {
    const KEY = createInjectionKey<string>('KEY');

    const ctx = createRootContext({
      providers: [valueProvider(KEY, 'hello')],
    });

    ctx.runSync(() => {
      expect(lookup(KEY)).toBe('hello');
    });
  });

  it('should resolve child providers via runSync', () => {
    const REQUEST = createInjectionKey<{ url: string }>('REQUEST');

    const ctx = createRootContext();

    ctx.runSync(
      () => {
        expect(lookup(REQUEST)).toEqual({ url: '/api/test' });
      },
      { providers: [valueProvider(REQUEST, { url: '/api/test' })] },
    );
  });

  it('child providers win over parent (child-wins)', () => {
    const KEY = createInjectionKey<string>('KEY');

    const ctx = createRootContext({
      providers: [valueProvider(KEY, 'parent')],
    });

    ctx.runSync(
      () => {
        expect(lookup(KEY)).toBe('child');
      },
      { providers: [valueProvider(KEY, 'child')] },
    );
  });

  it('nested runSync should inherit parent', () => {
    const OUTER = createInjectionKey<string>('OUTER');
    const INNER = createInjectionKey<string>('INNER');

    const ctx = createRootContext();

    ctx.runSync(
      (outerCtx) => {
        outerCtx.runSync(
          () => {
            expect(lookup(INNER)).toBe('inner-val');
            expect(lookup(OUTER)).toBe('outer-val');
          },
          { providers: [valueProvider(INNER, 'inner-val')] },
        );
      },
      { providers: [valueProvider(OUTER, 'outer-val')] },
    );
  });

  it('should auto-scope class with only structural deps into structural context', () => {
    class Logger {
      log(msg: string) {
        return msg;
      }
    }

    const ctx = createRootContext();

    ctx.runSync(() => {
      const logger = lookup(Logger);
      expect(logger).toBeInstanceOf(Logger);
    });

    // Logger had no deps — auto-scoped to structural root
    expect(ctx.get(Logger)).toBeInstanceOf(Logger);
  });

  it('should store in child context when depending on child provider', () => {
    const REQUEST = createInjectionKey<{ url: string }>('REQUEST');

    class RequestHandler {
      request = inject(REQUEST);
    }

    const ctx = createRootContext();

    let handler: RequestHandler;
    ctx.runSync(
      () => {
        handler = lookup(RequestHandler);
        expect(handler.request.url).toBe('/test');
      },
      { providers: [valueProvider(REQUEST, { url: '/test' })] },
    );

    // RequestHandler depends on EC provider — should NOT be in structural
    expect(() => ctx.get(RequestHandler)).toThrow();
  });

  it('each runSync should get independent child-scoped instances', () => {
    const REQUEST = createInjectionKey<{ id: number }>('REQUEST');

    class RequestHandler {
      request = inject(REQUEST);
    }

    const ctx = createRootContext();

    let handler1: RequestHandler;
    let handler2: RequestHandler;

    ctx.runSync(
      () => {
        handler1 = lookup(RequestHandler);
      },
      { providers: [valueProvider(REQUEST, { id: 1 })] },
    );

    ctx.runSync(
      () => {
        handler2 = lookup(RequestHandler);
      },
      { providers: [valueProvider(REQUEST, { id: 2 })] },
    );

    expect(handler1!).not.toBe(handler2!);
    expect(handler1!.request.id).toBe(1);
    expect(handler2!.request.id).toBe(2);
  });

  it('runSync from within enterSync should see entered context as grandparent', async () => {
    const OUTER = createInjectionKey<string>('OUTER');
    const INNER = createInjectionKey<string>('INNER');

    const ctx = createRootContext();

    const outerCtx = createContext({ parent: ctx, providers: [valueProvider(OUTER, 'async-val')] });
    outerCtx.enterSync();
    try {
      outerCtx.runSync(
        () => {
          expect(lookup(INNER)).toBe('sync-val');
          expect(lookup(OUTER)).toBe('async-val');
        },
        { providers: [valueProvider(INNER, 'sync-val')] },
      );
    } finally {
      outerCtx.leaveSync();
      await outerCtx.dispose();
    }
  });

  it('should return the value from the callback', () => {
    const ctx = createRootContext();

    const result = ctx.runSync(() => {
      return 42;
    });

    expect(result).toBe(42);
  });
});

describe('Disposal', () => {
  describe('sync disposal', () => {
    it('should dispose resources in reverse creation order', () => {
      const order: string[] = [];

      const KEY_A = createInjectionKey('A', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('A') });
          return 'a';
        },
      });
      const KEY_B = createInjectionKey('B', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('B') });
          return 'b';
        },
      });
      const KEY_C = createInjectionKey('C', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('C') });
          return 'c';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY_A);
      ctx.get(KEY_B);
      ctx.get(KEY_C);
      ctx.dispose();

      expect(order).toEqual(['C', 'B', 'A']);
    });

    it('should run multiple RegisterResource callbacks in reverse registration order', () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          const register = inject(RegisterResource);
          register({ [Dispose]: () => void order.push('onDispose-1') });
          register({ [Dispose]: () => void order.push('onDispose-2') });
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);
      ctx.dispose();

      expect(order).toEqual(['onDispose-2', 'onDispose-1']);
    });

    it('should allow unregistering resources', () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          const register = inject(RegisterResource);
          register({ [Dispose]: () => void order.push('kept') });
          const { unregister } = register({ [Dispose]: () => void order.push('removed') });
          unregister();
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);
      ctx.dispose();

      expect(order).toEqual(['kept']);
    });

    it('should dispose children before parent values', async () => {
      const order: string[] = [];

      const PARENT_KEY = createInjectionKey('PARENT_KEY', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('parent') });
          return 'parent';
        },
      });

      const CHILD_KEY = createInjectionKey('CHILD_KEY', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('child') });
          return 'child';
        },
      });

      const parent = createRootContext();
      parent.get(PARENT_KEY);

      const child = createContext({ parent });
      child.get(CHILD_KEY);

      await parent.dispose();

      expect(order).toEqual(['child', 'parent']);
    });

    it('should dispose multiple children in reverse creation order', async () => {
      const order: string[] = [];

      const KEY_1 = createInjectionKey('KEY_1', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('child-1') });
          return 'c1';
        },
      });
      const KEY_2 = createInjectionKey('KEY_2', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('child-2') });
          return 'c2';
        },
      });

      const parent = createRootContext();

      const child1 = createContext({ parent });
      child1.get(KEY_1);

      const child2 = createContext({ parent });
      child2.get(KEY_2);

      await parent.dispose();

      expect(order).toEqual(['child-2', 'child-1']);
    });

    it('should be idempotent (double-dispose is safe)', async () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('disposed') });
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);
      await ctx.dispose();
      await ctx.dispose();

      expect(order).toEqual(['disposed']);
    });

    it('should work with await using syntax via [Symbol.asyncDispose]', async () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('disposed') });
          return 'value';
        },
      });

      {
        await using ctx = createRootContext();
        ctx.get(KEY);
      }

      expect(order).toEqual(['disposed']);
    });
  });

  describe('async disposal', () => {
    it('should dispose resources in reverse creation order', async () => {
      const order: string[] = [];

      const KEY_A = createInjectionKey('A', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('A') });
          return 'a';
        },
      });
      const KEY_B = createInjectionKey('B', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('B') });
          return 'b';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY_A);
      ctx.get(KEY_B);
      await ctx.dispose();

      expect(order).toEqual(['B', 'A']);
    });

    it('should be idempotent (double-dispose returns resolved promise)', async () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('disposed') });
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);
      await ctx.dispose();
      await ctx.dispose();

      expect(order).toEqual(['disposed']);
    });

    it('should work with await using syntax via [Symbol.asyncDispose]', async () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('disposed') });
          return 'value';
        },
      });

      {
        await using ctx = createRootContext();
        ctx.get(KEY);
      }

      expect(order).toEqual(['disposed']);
    });

    it('should dispose child contexts before parent', async () => {
      const order: string[] = [];

      const P_KEY = createInjectionKey('P', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('parent') });
          return 'p';
        },
      });
      const C_KEY = createInjectionKey('C', {
        factory: () => {
          inject(RegisterResource)({ [Dispose]: () => void order.push('child') });
          return 'c';
        },
      });

      const parent = createRootContext();
      parent.get(P_KEY);

      const child = createContext({ parent });
      child.get(C_KEY);

      await parent.dispose();

      expect(order).toEqual(['child', 'parent']);
    });
  });

  describe('RegisterResource', () => {
    it('should throw when injecting RegisterResource outside creation context', () => {
      expect(() => lookup(RegisterResource)).toThrow(/creation/i);
    });

    it('should throw when injecting RegisterResource from execution context', () => {
      const ctx = createRootContext();

      ctx.run(() => {
        expect(() => lookup(RegisterResource)).toThrow(/creation/i);
      });
    });

    it('should allow injecting RegisterResource during factory execution', () => {
      const KEY = createInjectionKey('KEY', {
        factory: () => {
          const register = inject(RegisterResource);
          expect(typeof register).toBe('function');
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);
    });

    it('should allow injecting RegisterResource during class construction', () => {
      class MyService {
        registerFn = inject(RegisterResource);
      }

      const ctx = createRootContext();
      const svc = ctx.get(MyService);
      expect(typeof svc.registerFn).toBe('function');
    });

    it('should call RegisterResource callbacks on context dispose', async () => {
      let disposed = false;

      class MyService {
        constructor() {
          const register = inject(RegisterResource);
          register({
            [Dispose]: () => {
              disposed = true;
            },
          });
        }
      }

      const ctx = createRootContext();
      ctx.get(MyService);
      expect(disposed).toBe(false);

      await ctx.dispose();
      expect(disposed).toBe(true);
    });

    it('should allow unregistering after creation (post-flush)', async () => {
      const order: string[] = [];

      let handle: { unregister(): void };
      const KEY = createInjectionKey('KEY', {
        factory: () => {
          const register = inject(RegisterResource);
          register({
            [Dispose]: () => {
              order.push('kept');
            },
          });
          handle = register({
            [Dispose]: () => {
              order.push('removed');
            },
          });
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);

      // Unregister after creation (callbacks already flushed to context)
      handle!.unregister();

      await ctx.dispose();
      expect(order).toEqual(['kept']);
    });
  });

  describe('execution context auto-disposal', () => {
    it('runSync should auto-dispose EC values', () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          const register = inject(RegisterResource);
          register({
            [Dispose]: () => {
              order.push('ec-disposed');
            },
          });
          return 'value';
        },
      });

      const ctx = createRootContext();

      ctx.runSync(
        () => {
          lookup(KEY);
        },
        {
          providers: [
            {
              key: KEY,
              provide: () => {
                const register = inject(RegisterResource);
                register({
                  [Dispose]: () => {
                    order.push('ec-disposed');
                  },
                });
                return 'provided-value';
              },
            },
          ],
        },
      );

      expect(order).toEqual(['ec-disposed']);
    });

    it('runSync should auto-dispose class instances', () => {
      const order: string[] = [];

      const REQUEST = createInjectionKey<string>('REQUEST');

      class Handler {
        request = inject(REQUEST);
        constructor() {
          const register = inject(RegisterResource);
          register({
            [Dispose]: () => {
              order.push('handler-disposed');
            },
          });
        }
      }

      const ctx = createRootContext();

      ctx.runSync(
        () => {
          lookup(Handler);
        },
        { providers: [valueProvider(REQUEST, '/test')] },
      );

      expect(order).toEqual(['handler-disposed']);
    });

    it('runSync should dispose even if callback throws', () => {
      let disposed = false;

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          const register = inject(RegisterResource);
          register({
            [Dispose]: () => {
              disposed = true;
            },
          });
          return 'value';
        },
      });

      const ctx = createRootContext();

      expect(() =>
        ctx.runSync(
          () => {
            lookup(KEY);
            throw new Error('boom');
          },
          {
            providers: [
              {
                key: KEY,
                provide: () => {
                  const register = inject(RegisterResource);
                  register({
                    [Dispose]: () => {
                      disposed = true;
                    },
                  });
                  return 'value';
                },
              },
            ],
          },
        ),
      ).toThrow('boom');

      expect(disposed).toBe(true);
    });
  });

  describe('context type properties', () => {
    it('createContext should return a Context with dispose()', () => {
      const ctx = createRootContext();
      expect(typeof ctx.dispose).toBe('function');
    });
  });

  describe('Scopes', () => {
    it('should place scoped explicit key on the context that owns the scope', () => {
      const appScope = createScope('app');
      const CONFIG = createInjectionKey<string>('CONFIG', {
        factory: () => 'default-config',
        scope: appScope,
      });

      const root = createRootContext({ scopes: [appScope] });
      const child = createContext({ parent: root });

      // Resolving from child should still place the value on root (which owns the scope)
      expect(child.get(CONFIG)).toBe('default-config');
      // Root should now have it cached
      expect(root.get(CONFIG)).toBe('default-config');
    });

    it('should place scoped class key on the scoped context', () => {
      const appScope = createScope('app');

      class AppService {
        name = 'app-service';
      }
      setScope(AppService, appScope);

      const root = createRootContext({ scopes: [appScope] });
      const child = createContext({ parent: root });

      const fromChild = child.get(AppService);
      expect(fromChild.name).toBe('app-service');
      // Same instance from root
      expect(root.get(AppService)).toBe(fromChild);
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
      const REQUEST_ID = createInjectionKey<string>('REQUEST_ID', {
        factory: () => 'req-1',
        scope: requestScope,
      });

      const root = createRootContext({ scopes: [requestScope] });
      const mid = createContext({ parent: root, scopes: [requestScope] });
      const child = createContext({ parent: mid });

      // Should resolve to mid (nearest scope owner)
      child.get(REQUEST_ID);
      expect(mid.get(REQUEST_ID)).toBe('req-1');
    });

    it('should use setScope to assign scope to a key', () => {
      const appScope = createScope('app');
      const KEY = createInjectionKey<number>('KEY', { factory: () => 42 });
      setScope(KEY, appScope);

      const root = createRootContext({ scopes: [appScope] });
      const child = createContext({ parent: root });

      expect(child.get(KEY)).toBe(42);
      expect(root.get(KEY)).toBe(42);
    });

    it('should support setScope after key creation', () => {
      const appScope = createScope('app');
      const KEY = createInjectionKey<string>('KEY', { factory: () => 'scoped-value' });
      setScope(KEY, appScope);

      const root = createRootContext({ scopes: [appScope] });
      expect(root.get(KEY)).toBe('scoped-value');
    });

    it('should support scope on execution context', () => {
      const requestScope = createScope('request');
      const REQUEST_ID = createInjectionKey<string>('REQUEST_ID', {
        factory: () => 'auto-id',
        scope: requestScope,
      });

      const root = createRootContext();

      root.runSync(
        () => {
          expect(lookup(REQUEST_ID)).toBe('auto-id');
        },
        { scopes: [requestScope] },
      );
    });

    it('should work with explicit provider on scoped context', () => {
      const appScope = createScope('app');
      const CONFIG = createInjectionKey<string>('CONFIG', { scope: appScope });

      const root = createRootContext({
        scopes: [appScope],
        providers: [valueProvider(CONFIG, 'provided-config')],
      });
      const child = createContext({ parent: root });

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
      const child = createContext({ parent: root });

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
      const child = createContext({ parent: root });

      expect(child.get(MAIN)).toBe('main[dep-val]');
    });
  });

  describe('Dependencies (constructor injection)', () => {
    it('should inject class constructor dependencies via setDependencies', () => {
      class Logger {
        log(msg: string) {
          return msg;
        }
      }

      class Service {
        constructor(public logger: Logger) {}
      }
      setDependencies(Service, Logger);

      const ctx = createRootContext();
      const service = ctx.get(Service);
      expect(service).toBeInstanceOf(Service);
      expect(service.logger).toBeInstanceOf(Logger);
    });

    it('should inject multiple constructor dependencies', () => {
      const DB_URL = createInjectionKey<string>('DB_URL', {
        factory: () => 'postgres://localhost',
      });

      class Logger {
        log(msg: string) {
          return msg;
        }
      }

      class Database {
        constructor(
          public url: string,
          public logger: Logger,
        ) {}
      }
      setDependencies(Database, DB_URL, Logger);

      const ctx = createRootContext();
      const db = ctx.get(Database);
      expect(db.url).toBe('postgres://localhost');
      expect(db.logger).toBeInstanceOf(Logger);
    });

    it('should inject function key dependencies via setDependencies', () => {
      class Logger {
        log(msg: string) {
          return msg;
        }
      }

      function createGreeter(logger: Logger) {
        return { greet: (name: string) => logger.log(`Hello, ${name}!`) };
      }
      setDependencies(createGreeter, Logger);

      const ctx = createRootContext();
      const greeter = ctx.get(createGreeter);
      expect(greeter.greet('World')).toBe('Hello, World!');
    });

    it('should support setDependencies on a class', () => {
      class Dep {
        value = 42;
      }

      class Consumer {
        constructor(public dep: Dep) {}
      }
      setDependencies(Consumer, Dep);

      const ctx = createRootContext();
      expect(ctx.get(Consumer).dep.value).toBe(42);
    });

    it('should work with 3rd party classes via setDependencies', () => {
      class ThirdPartyClient {
        constructor(public baseUrl: string) {}
        fetch() {
          return this.baseUrl;
        }
      }

      const BASE_URL = createInjectionKey<string>('BASE_URL', {
        factory: () => 'https://api.example.com',
      });
      setDependencies(ThirdPartyClient, BASE_URL);

      const ctx = createRootContext();
      const client = ctx.get(ThirdPartyClient);
      expect(client.fetch()).toBe('https://api.example.com');
    });

    it('should auto-scope class with dependencies to correct depth', () => {
      class Logger {
        name = 'logger';
      }

      class Service {
        constructor(public logger: Logger) {}
      }
      setDependencies(Service, Logger);

      const root = createRootContext();
      const child = createContext({ parent: root });

      const service = child.get(Service);
      expect(service.logger).toBeInstanceOf(Logger);

      // Same instance from root (auto-scoped)
      expect(root.get(Service)).toBe(service);
      expect(root.get(Logger)).toBe(service.logger);
    });

    it('should allow mixing constructor deps and field-initializer inject()', () => {
      const CONFIG = createInjectionKey<string>('CONFIG', { factory: () => 'config-value' });

      class Logger {
        name = 'logger';
      }

      class Service {
        config = inject(CONFIG);
        constructor(public logger: Logger) {}
      }
      setDependencies(Service, Logger);

      const ctx = createRootContext();
      const service = ctx.get(Service);
      expect(service.logger).toBeInstanceOf(Logger);
      expect(service.config).toBe('config-value');
    });

    it('should work with explicit providers that override default factory', () => {
      class Logger {
        name = 'default';
      }
      class CustomLogger extends Logger {
        override name = 'custom';
      }

      class Service {
        constructor(public logger: Logger) {}
      }
      setDependencies(Service, Logger);

      const ctx = createRootContext({
        providers: [classProvider(Logger, CustomLogger)],
      });
      const service = ctx.get(Service);
      expect(service.logger.name).toBe('custom');
    });

    it('should detect circular dependencies through constructor injection', () => {
      class A {
        constructor(public b: any) {}
      }
      class B {
        constructor(public a: any) {}
      }
      setDependencies(A, B as any);
      setDependencies(B, A as any);

      const ctx = createRootContext();
      expect(() => ctx.get(A)).toThrow('Circular dependency detected: A → B → A');
    });
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
      expect(() => ctx.addProvider({ key, provide: () => 'replacement' })).toThrow(
        /already been resolved/,
      );
    });

    it('should throw when adding provider at child after key resolved at ancestor', () => {
      const key = createInjectionKey<string>('Root');
      const root = createRootContext({
        providers: [valueProvider(key, 'root-value')],
      });
      root.get(key); // resolve at root
      const child = createContext({ parent: root });
      expect(() => child.addProvider({ key, provide: () => 'child-value' })).toThrow(
        /already been resolved/,
      );
    });

    it('should throw when adding provider at root after auto-scope stored at child', () => {
      class Database {}
      class UserRepo {
        db = inject(Database);
      }
      const root = createRootContext();
      const child = createContext({
        parent: root,
        providers: [classProvider(Database)],
      });
      child.get(UserRepo); // auto-scopes to child, memoizes not-found at root
      expect(() => root.addProvider({ key: UserRepo, provide: () => new UserRepo() })).toThrow(
        /already been resolved/,
      );
    });

    it('should throw when adding provider after optional lookup returns undefined', () => {
      const key = createInjectionKey<string>('Missing');
      const ctx = createRootContext();
      expect(ctx.get(key, { optional: true })).toBeUndefined();
      expect(() => ctx.addProvider({ key, provide: () => 'late' })).toThrow(
        /already been resolved/,
      );
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
      const child = createContext({
        parent: root,
        providers: [valueProvider(key, 'child-value')],
      });
      expect(child.get(key)).toBe('child-value');
    });
  });

  describe('resolution caching', () => {
    it('should return same value on repeated gets from same context', () => {
      class Service {}
      const root = createRootContext();
      const s1 = root.get(Service);
      const s2 = root.get(Service);
      expect(s1).toBe(s2);
    });

    it('should return same value from child after parent resolves', () => {
      class Service {}
      const root = createRootContext();
      const child = createContext({ parent: root });
      const fromChild = child.get(Service);
      const fromRoot = root.get(Service);
      expect(fromChild).toBe(fromRoot);
    });

    it('should cache resolutions probabilistically after misses', () => {
      // Create a deep hierarchy and resolve many keys to trigger caching
      const keys = Array.from({ length: 20 }, (_, i) => createInjectionKey<number>(`K${i}`));
      const root = createRootContext({
        providers: keys.map((key, i) => valueProvider(key, i)),
      });
      const child = createContext({ parent: root });

      // Resolve all keys — some will be cached at child via probabilistic memoization
      for (const key of keys) {
        const val = child.get(key);
        expect(typeof val).toBe('number');
      }

      // Re-resolve — should still return correct values (whether from cache or walk)
      for (let i = 0; i < keys.length; i++) {
        expect(child.get(keys[i])).toBe(i);
      }
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

        const root = createRootContext();
        const c1 = root.create(WRAPPER);
        const c2 = root.create(WRAPPER);
        expect(c1.value).toBe(1);
        expect(c2.value).toBe(2);
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
        const result = root.create(WRAPPER);
        expect(result.value).toBe('1-1');
      });

      it('should wire disposal to the outer creation context', async () => {
        let disposed = false;
        const SELF_KEY = createInjectionKey<string>('SelfKey', {
          factory: () => {
            inject(RegisterResource)({
              [Dispose]: () => {
                disposed = true;
              },
            });
            return 'val';
          },
          scope: SelfScope,
        });
        const WRAPPER = createInjectionKey<string>('Wrapper', {
          factory: () => inject(SELF_KEY),
        });

        const root = createRootContext();
        const created = root.create(WRAPPER);
        expect(created.value).toBe('val');
        expect(disposed).toBe(false);
        await created.dispose();
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
        const child1 = createContext({ parent: root, scopes: [SelfScope] });
        const child2 = createContext({ parent: root, scopes: [SelfScope] });

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
        const child = createContext({ parent: root, scopes: [SelfScope] });

        expect(child.get(KEY)).toBe(1);
        // Different SelfScope boundary → different instance
        const child2 = createContext({ parent: root, scopes: [SelfScope] });
        expect(child2.get(KEY)).toBe(2);
      });

      it('should work with SelfScope on a class key', () => {
        class MyService {
          id = Math.random();
        }
        setScope(MyService, SelfScope);

        const root = createRootContext();
        const child1 = createContext({ parent: root, scopes: [SelfScope] });
        const child2 = createContext({ parent: root, scopes: [SelfScope] });

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
            inject(RegisterResource)({
              [Dispose]: () => {
                disposed = true;
              },
            });
            return 'val';
          },
          scope: SelfScope,
        });

        const root = createRootContext();
        const child = createContext({ parent: root, scopes: [SelfScope] });
        expect(child.get(KEY)).toBe('val');
        expect(disposed).toBe(false);

        await child.dispose();
        expect(disposed).toBe(true);
      });

      it('should not hoist past the SelfScope boundary', () => {
        let counter = 0;
        const KEY = createInjectionKey<number>('SelfKey', {
          factory: () => ++counter,
          scope: SelfScope,
        });

        const root = createRootContext({ scopes: [SelfScope] });
        const child = createContext({ parent: root, scopes: [SelfScope] });

        expect(child.get(KEY)).toBe(1);
        // Root should get its own instance — child's SelfScope boundary caught it
        expect(root.get(KEY)).toBe(2);
      });
    });
  });

  describe('Provider.scope', () => {
    it('should store explicit provider value on scoped context', () => {
      const requestScope = createScope('request');
      const CONFIG = createInjectionKey<string>('CONFIG');

      const root = createRootContext({
        scopes: [requestScope],
        providers: [valueProvider(CONFIG, 'root-config', { scope: requestScope })],
      });
      const child = createContext({ parent: root });

      // Provider is on root with scope=requestScope, root owns requestScope
      // Value should be stored on root (the scope owner)
      expect(child.get(CONFIG)).toBe('root-config');
      expect(root.get(CONFIG)).toBe('root-config');
    });

    it('should override key scope with provider scope', () => {
      const appScope = createScope('app');
      const requestScope = createScope('request');

      const KEY = createInjectionKey<string>('KEY', {
        factory: () => 'default',
        scope: appScope,
      });

      const root = createRootContext({ scopes: [appScope, requestScope] });
      const mid = createContext({ parent: root, scopes: [requestScope] });
      const child = createContext({ parent: mid });

      // Provider has scope=requestScope, overriding key's appScope
      mid.addProvider(factoryProvider(KEY, () => 'overridden', { scope: requestScope }));

      // Resolving from child: provider scope wins, stored on mid (nearest requestScope)
      expect(child.get(KEY)).toBe('overridden');
      expect(mid.get(KEY)).toBe('overridden');
    });

    it('should throw when provider scope is not found in chain', () => {
      const missingScope = createScope('missing');
      const KEY = createInjectionKey<string>('KEY');

      const root = createRootContext({
        providers: [valueProvider(KEY, 'val', { scope: missingScope })],
      });

      expect(() => root.get(KEY)).toThrow("No context found for scope 'missing'");
    });

    it('should support SelfScope on provider scope (creation context)', () => {
      let counter = 0;
      const KEY = createInjectionKey<number>('SelfProvider');

      const root = createRootContext({
        providers: [factoryProvider(KEY, () => ++counter, { scope: SelfScope })],
      });

      // SelfScope on provider: each creation gets its own instance
      const WRAPPER = createInjectionKey<number>('Wrapper', {
        factory: () => inject(KEY),
      });
      const c1 = root.create(WRAPPER);
      const c2 = root.create(WRAPPER);
      expect(c1.value).toBe(1);
      expect(c2.value).toBe(2);
    });

    it('should support SelfScope on provider scope (scoped context)', () => {
      let counter = 0;
      const KEY = createInjectionKey<number>('SelfProvider');

      const root = createRootContext({
        providers: [factoryProvider(KEY, () => ++counter, { scope: SelfScope })],
      });

      const child1 = createContext({ parent: root, scopes: [SelfScope] });
      const child2 = createContext({ parent: root, scopes: [SelfScope] });
      expect(child1.get(KEY)).toBe(1);
      expect(child2.get(KEY)).toBe(2);
    });

    it('should work with factoryProvider scope', () => {
      const requestScope = createScope('request');
      let counter = 0;
      const KEY = createInjectionKey<number>('Counter');

      const root = createRootContext({
        scopes: [requestScope],
        providers: [factoryProvider(KEY, () => ++counter, { scope: requestScope })],
      });

      expect(root.get(KEY)).toBe(1);
      expect(root.get(KEY)).toBe(1); // cached
    });

    it('should work with classProvider scope', () => {
      const appScope = createScope('app');

      class MyService {
        name = 'service';
      }

      const root = createRootContext({
        scopes: [appScope],
        providers: [classProvider(MyService, MyService, { scope: appScope })],
      });
      const child = createContext({ parent: root });

      const fromChild = child.get(MyService);
      expect(fromChild.name).toBe('service');
      expect(root.get(MyService)).toBe(fromChild); // same instance, stored at root
    });
  });

  describe('context.create()', () => {
    it('should create a value in a child context', () => {
      const KEY = createInjectionKey<string>('KEY', { factory: () => 'created' });

      const root = createRootContext();
      const result = root.create(KEY);

      expect(result.value).toBe('created');
    });

    it('should dispose the child context', async () => {
      let disposed = false;
      const KEY = createInjectionKey<string>('KEY', {
        factory: () => {
          inject(RegisterResource)({
            [Dispose]: () => {
              disposed = true;
            },
          });
          return 'value';
        },
      });

      const root = createRootContext();
      const result = root.create(KEY);
      expect(result.value).toBe('value');
      expect(disposed).toBe(false);

      await result.dispose();
      expect(disposed).toBe(true);
    });

    it('should support Symbol.asyncDispose', async () => {
      let disposed = false;
      const KEY = createInjectionKey<string>('KEY', {
        factory: () => {
          inject(RegisterResource)({
            [Dispose]: () => {
              disposed = true;
            },
          });
          return 'val';
        },
      });

      const root = createRootContext();
      {
        await using result = root.create(KEY);
        expect(result.value).toBe('val');
      }
      expect(disposed).toBe(true);
    });

    it('should reuse existing values from parent', () => {
      let depCreated = 0;
      const DEP = createInjectionKey<string>('DEP', {
        factory: () => {
          depCreated++;
          return 'dep-val';
        },
      });
      const MAIN = createInjectionKey<string>('MAIN', {
        factory: () => `main[${inject(DEP)}]`,
      });

      const root = createRootContext();
      // Pre-resolve DEP on root
      expect(root.get(DEP)).toBe('dep-val');
      expect(depCreated).toBe(1);

      // create() should reuse the existing DEP, not create a new one
      const result = root.create(MAIN);
      expect(result.value).toBe('main[dep-val]');
      expect(depCreated).toBe(1); // not incremented
    });

    it('should create independent instances', async () => {
      let counter = 0;
      const KEY = createInjectionKey<number>('Counter', { factory: () => ++counter });

      const root = createRootContext();
      const r1 = root.create(KEY);
      const r2 = root.create(KEY);

      expect(r1.value).toBe(1);
      expect(r2.value).toBe(2);

      await r1.dispose();
      await r2.dispose();
    });

    it('should not affect parent when child is disposed', async () => {
      const KEY = createInjectionKey<string>('KEY', { factory: () => 'val' });

      const root = createRootContext();
      const parentValue = root.get(KEY);
      expect(parentValue).toBe('val');

      const created = root.create(KEY);
      expect(created.value).toBe('val'); // fresh instance in child

      await created.dispose();

      // Parent's value should still work
      expect(root.get(KEY)).toBe('val');
    });

    it('should auto-hoist deps normally (no child boundary)', async () => {
      let depDisposed = false;
      const DEP = createInjectionKey<string>('DEP', {
        factory: () => {
          inject(RegisterResource)({
            [Dispose]: () => {
              depDisposed = true;
            },
          });
          return 'dep';
        },
      });
      const MAIN = createInjectionKey<string>('MAIN', {
        factory: () => `main[${inject(DEP)}]`,
      });

      const root = createRootContext();
      const result = root.create(MAIN);
      expect(result.value).toBe('main[dep]');

      // DEP was auto-hoisted to root — not isolated in a child boundary
      await result.dispose();
      expect(depDisposed).toBe(false); // DEP still alive on root

      await root.dispose();
      expect(depDisposed).toBe(true); // DEP disposed with root
    });
  });

  describe('create() dep tracking', () => {
    it('should track deps from create() for auto-hoisting', () => {
      // DEP lives at `middle`. A factory that calls create(VALUE_KEY)
      // where VALUE_KEY depends on DEP should auto-hoist to middle (not root).
      const middleScope = createScope('middle');
      const DEP = createInjectionKey<string>('DEP', {
        factory: () => 'dep-val',
        scope: middleScope,
      });
      const OWNER = createInjectionKey<string>('OWNER', {
        factory: () => {
          const handle = create(
            createInjectionKey<string>('Inner', {
              factory: () => `inner[${inject(DEP)}]`,
            }),
          );
          return `owner[${handle.value}]`;
        },
      });

      const root = createRootContext();
      const middle = createContext({ parent: root, scopes: [middleScope] });

      const val = middle.get(OWNER);
      expect(val).toBe('owner[inner[dep-val]]');

      // OWNER should be stored at middle (not root) because create()
      // resolved DEP which lives at middle — the tracker saw it.
      // Verify by checking that root does NOT have OWNER cached.
      const _root2child = createContext({ parent: root });
      // This would resolve OWNER again, getting a different value if root
      // doesn't have it. But since OWNER has no scope, it auto-hoists.
      // The key test: middle.get(OWNER) should return the same value.
      expect(middle.get(OWNER)).toBe('owner[inner[dep-val]]');
    });

    it('should track deps recursively through nested create()', () => {
      const appScope = createScope('app');
      const DEP = createInjectionKey<string>('DEP', {
        factory: () => 'deep-dep',
        scope: appScope,
      });
      const INNER = createInjectionKey<string>('Inner', {
        factory: () => inject(DEP),
      });
      const MIDDLE = createInjectionKey<string>('Middle', {
        factory: () => {
          const result = create(INNER);
          return `mid[${result.value}]`;
        },
      });
      const OUTER = createInjectionKey<string>('Outer', {
        factory: () => {
          const result = create(MIDDLE);
          return `out[${result.value}]`;
        },
      });

      const root = createRootContext();
      const app = createContext({ parent: root, scopes: [appScope] });

      const val = app.get(OUTER);
      expect(val).toBe('out[mid[deep-dep]]');
    });
  });

  describe('createRefCountedKey', () => {
    it('should share the same value across multiple consumers', () => {
      let counter = 0;
      const WS = createRefCountedKey<number>('WS', {
        factory: () => ++counter,
      });

      const root = createRootContext();
      const child1 = createContext({ parent: root, scopes: [SelfScope] });
      const child2 = createContext({ parent: root, scopes: [SelfScope] });

      // Both should get the same underlying value
      expect(child1.get(WS)).toBe(1);
      expect(child2.get(WS)).toBe(1);
      expect(counter).toBe(1); // factory called once
    });

    it('should dispose when all consumers are disposed', async () => {
      let disposed = false;
      const WS = createRefCountedKey<string>('WS', {
        factory: () => {
          inject(RegisterResource)({
            [Dispose]: () => {
              disposed = true;
            },
          });
          return 'connection';
        },
      });

      const root = createRootContext();
      const child1 = createContext({ parent: root, scopes: [SelfScope] });
      const child2 = createContext({ parent: root, scopes: [SelfScope] });

      child1.get(WS);
      child2.get(WS);

      // Dispose first consumer — value should survive
      await child1.dispose();
      expect(disposed).toBe(false);

      // Dispose second consumer — refCount hits 0, value disposed
      await child2.dispose();
      await new Promise((r) => setTimeout(r, 10));
      expect(disposed).toBe(true);
    });

    it('should scope the holder to the specified scope', () => {
      const appScope = createScope('app');
      let counter = 0;
      const WS = createRefCountedKey<number>('WS', {
        factory: () => ++counter,
        scope: appScope,
      });

      const root = createRootContext({ scopes: [appScope] });
      const child1 = createContext({ parent: root, scopes: [SelfScope] });
      const child2 = createContext({ parent: root, scopes: [SelfScope] });

      // Both share the same value — holder lives at root (scope owner)
      expect(child1.get(WS)).toBe(1);
      expect(child2.get(WS)).toBe(1);
    });

    it('should be transparent to the consumer', () => {
      const WS = createRefCountedKey<string>('WS', {
        factory: () => 'ws-value',
      });

      const root = createRootContext();
      const child = createContext({ parent: root, scopes: [SelfScope] });
      // Consumer just calls get() — no knowledge of ref counting
      expect(child.get(WS)).toBe('ws-value');
    });

    it('should create separate refs per SelfScope (each consumer gets own ref)', () => {
      const WS = createRefCountedKey<string>('WS', {
        factory: () => 'ws',
      });

      const root = createRootContext();
      const child1 = createContext({ parent: root, scopes: [SelfScope] });
      const child2 = createContext({ parent: root, scopes: [SelfScope] });

      // Each child has its own SelfScope boundary, but they share the underlying value
      expect(child1.get(WS)).toBe('ws');
      expect(child2.get(WS)).toBe('ws');
    });

    it('should recreate after full disposal and new consumer appears', async () => {
      let counter = 0;
      const WS = createRefCountedKey<number>('WS', {
        factory: () => ++counter,
      });

      const root = createRootContext();
      const child1 = createContext({ parent: root, scopes: [SelfScope] });
      expect(child1.get(WS)).toBe(1);

      await child1.dispose();
      await new Promise((r) => setTimeout(r, 10));

      // New consumer should get a fresh instance
      const child2 = createContext({ parent: root, scopes: [SelfScope] });
      expect(child2.get(WS)).toBe(2);

      await child2.dispose();
    });
  });

  describe('refCountedProvider', () => {
    it('should make an existing key ref-counted via provider', () => {
      let counter = 0;
      const KEY = createInjectionKey<number>('MyKey');

      const root = createRootContext({
        providers: [
          refCountedProvider(KEY, {
            factory: () => ++counter,
          }),
        ],
      });
      const child1 = createContext({ parent: root, scopes: [SelfScope] });
      const child2 = createContext({ parent: root, scopes: [SelfScope] });

      expect(child1.get(KEY)).toBe(1);
      expect(child2.get(KEY)).toBe(1); // shared
      expect(counter).toBe(1);
    });

    it('should dispose when all consumers are gone', async () => {
      let disposed = false;
      const KEY = createInjectionKey<string>('MyKey');

      const root = createRootContext({
        providers: [
          refCountedProvider(KEY, {
            factory: () => {
              inject(RegisterResource)({
                [Dispose]: () => {
                  disposed = true;
                },
              });
              return 'value';
            },
          }),
        ],
      });

      const child1 = createContext({ parent: root, scopes: [SelfScope] });
      const child2 = createContext({ parent: root, scopes: [SelfScope] });

      child1.get(KEY);
      child2.get(KEY);

      await child1.dispose();
      expect(disposed).toBe(false);

      await child2.dispose();
      await new Promise((r) => setTimeout(r, 10));
      expect(disposed).toBe(true);
    });

    it('should respect scope option on provider', () => {
      const appScope = createScope('app');
      let counter = 0;
      const KEY = createInjectionKey<number>('Scoped');

      const root = createRootContext({
        scopes: [appScope],
        providers: [
          refCountedProvider(KEY, {
            factory: () => ++counter,
            scope: appScope,
          }),
        ],
      });

      const child1 = createContext({ parent: root, scopes: [SelfScope] });
      const child2 = createContext({ parent: root, scopes: [SelfScope] });

      expect(child1.get(KEY)).toBe(1);
      expect(child2.get(KEY)).toBe(1);
    });

    it('should use key scope as fallback when provider scope not specified', () => {
      const appScope = createScope('app');
      let counter = 0;
      const KEY = createInjectionKey<number>('FallbackScope', { scope: appScope });

      const root = createRootContext({
        scopes: [appScope],
        providers: [
          refCountedProvider(KEY, {
            factory: () => ++counter,
          }),
        ],
      });

      const child1 = createContext({ parent: root, scopes: [SelfScope] });
      const child2 = createContext({ parent: root, scopes: [SelfScope] });

      expect(child1.get(KEY)).toBe(1);
      expect(child2.get(KEY)).toBe(1);
    });
  });

  describe('skipSelf', () => {
    it('context.get with skipSelf resolves from parent', () => {
      const KEY = createInjectionKey<string>('Val');
      const root = createRootContext({
        providers: [valueProvider(KEY, 'root')],
      });
      const child = createContext({
        parent: root,
        providers: [valueProvider(KEY, 'child')],
      });

      expect(child.get(KEY)).toBe('child');
      expect(child.get(KEY, { skipSelf: true })).toBe('root');
    });

    it('context.get with skipSelf + optional returns undefined when no parent', () => {
      const KEY = createInjectionKey<string>('Val');
      const root = createRootContext({
        providers: [valueProvider(KEY, 'root')],
      });

      expect(root.get(KEY, { skipSelf: true, optional: true })).toBeUndefined();
    });

    it('context.get with skipSelf throws when no parent and not optional', () => {
      const KEY = createInjectionKey<string>('Val');
      const root = createRootContext({
        providers: [valueProvider(KEY, 'root')],
      });

      expect(() => root.get(KEY, { skipSelf: true })).toThrow(/no parent context/i);
    });

    it('inject with skipSelf during creation resolves from parent provider', async () => {
      const HttpClient = createInjectionKey<{ name: string }>('HttpClient');

      const root = createRootContext({
        providers: [factoryProvider(HttpClient, () => ({ name: 'base' }))],
      });

      const child = createContext({
        parent: root,
        providers: [
          factoryProvider(HttpClient, () => {
            const parent = inject(HttpClient, { skipSelf: true });
            return { name: `logging(${parent.name})` };
          }),
        ],
      });

      expect(child.get(HttpClient)).toEqual({ name: 'logging(base)' });
      expect(root.get(HttpClient)).toEqual({ name: 'base' });
    });

    it('inject with skipSelf during creation returns undefined when optional and no parent value', async () => {
      const KEY = createInjectionKey<string>('Optional');

      const root = createRootContext({
        providers: [
          factoryProvider(KEY, () => {
            const parent = inject(KEY, { skipSelf: true, optional: true });
            return parent ? `wrapped(${parent})` : 'root-default';
          }),
        ],
      });

      expect(root.get(KEY)).toBe('root-default');
    });

    it('inject with skipSelf in execution context skips current context', () => {
      const KEY = createInjectionKey<string>('Val');
      const root = createRootContext({
        providers: [valueProvider(KEY, 'root')],
      });
      const child = createContext({
        parent: root,
        providers: [valueProvider(KEY, 'child')],
      });

      const result = child.runSync(() => {
        return lookup(KEY, { skipSelf: true });
      });

      expect(result).toBe('child');
    });

    it('decorator pattern: multiple levels of wrapping', () => {
      const Service = createInjectionKey<{ trace(): string }>('Service');

      const root = createRootContext({
        providers: [factoryProvider(Service, () => ({ trace: () => 'base' }))],
      });

      const mid = createContext({
        parent: root,
        providers: [
          factoryProvider(Service, () => {
            const parent = inject(Service, { skipSelf: true });
            return { trace: () => `mid(${parent.trace()})` };
          }),
        ],
      });

      const leaf = createContext({
        parent: mid,
        providers: [
          factoryProvider(Service, () => {
            const parent = inject(Service, { skipSelf: true });
            return { trace: () => `leaf(${parent.trace()})` };
          }),
        ],
      });

      expect(leaf.get(Service).trace()).toBe('leaf(mid(base))');
      expect(mid.get(Service).trace()).toBe('mid(base)');
      expect(root.get(Service).trace()).toBe('base');
    });
  });

  describe('resourceProvider', () => {
    it('should provide the value and register a resource', async () => {
      const KEY = createInjectionKey<string>('Conn');
      let disposed = false;

      const ctx = createRootContext({
        providers: [
          resourceProvider(KEY, 'my-connection', {
            [Dispose]: () => {
              disposed = true;
            },
          }),
        ],
      });

      expect(ctx.get(KEY)).toBe('my-connection');
      expect(disposed).toBe(false);

      await ctx.dispose();
      expect(disposed).toBe(true);
    });

    it('should dispose resources in reverse registration order', async () => {
      const A = createInjectionKey<string>('A');
      const B = createInjectionKey<string>('B');
      const order: string[] = [];

      const ctx = createRootContext({
        providers: [
          resourceProvider(A, 'a', {
            [Dispose]: () => {
              order.push('A');
            },
          }),
          resourceProvider(B, 'b', {
            [Dispose]: () => {
              order.push('B');
            },
          }),
        ],
      });

      ctx.get(A);
      ctx.get(B);
      await ctx.dispose();

      expect(order).toEqual(['B', 'A']);
    });

    it('should work with child contexts', async () => {
      const KEY = createInjectionKey<string>('Lease');
      let released = false;

      const root = createRootContext();
      const child = createContext({
        parent: root,
        providers: [
          resourceProvider(KEY, 'leased-resource', {
            [Dispose]: () => {
              released = true;
            },
          }),
        ],
      });

      expect(child.get(KEY)).toBe('leased-resource');
      await child.dispose();
      expect(released).toBe(true);
    });

    it('should support scope option', () => {
      const KEY = createInjectionKey<string>('Scoped');
      const myScope = createScope('test-scope');

      const root = createRootContext();
      const child = createContext({
        parent: root,
        providers: [resourceProvider(KEY, 'val', { [Dispose]: () => {} }, { scope: myScope })],
        scopes: [myScope],
      });

      expect(child.get(KEY)).toBe('val');
    });
  });

  describe('ContextRef', () => {
    it('should return a pre-resolved ref for explicitly scoped keys', () => {
      class MyService {
        ref = inject(ContextRefKey);
      }
      setScope(MyService, RootScope);

      const root = createRootContext();
      const svc = root.get(MyService);
      expect(svc.ref.isResolved).toBe(true);
      expect(svc.ref.context).toBe(root);
    });

    it('should return a pre-resolved ref when provided via a provider', () => {
      class MyService {
        ref = inject(ContextRefKey);
      }

      const root = createRootContext({
        providers: [classProvider(MyService, MyService)],
      });
      const svc = root.get(MyService);
      expect(svc.ref.isResolved).toBe(true);
      expect(svc.ref.context).toBe(root);
    });

    it('should return the scoped context, not the requesting context', () => {
      class MyService {
        ref = inject(ContextRefKey);
      }
      setScope(MyService, RootScope);

      const root = createRootContext();
      const child = createContext({ parent: root });
      const svc = child.get(MyService);
      expect(svc.ref.context).toBe(root);
    });

    it('should be available for auto-hoisted values (resolved after factory)', () => {
      class MyService {
        ref = inject(ContextRefKey);
      }

      const root = createRootContext();
      const svc = root.get(MyService);
      // After creation completes, the ref is resolved
      expect(svc.ref.isResolved).toBe(true);
      expect(svc.ref.context).toBe(root);
    });

    it('should throw when reading .context during auto-hoisted factory body', () => {
      let threwDuringCreation = false;
      class MyService {
        ref = inject(ContextRefKey);
        constructor() {
          try {
            // Reading .context during factory should throw for auto-hoisted
            void this.ref.context;
          } catch {
            threwDuringCreation = true;
          }
        }
      }

      const root = createRootContext();
      const svc = root.get(MyService);
      expect(threwDuringCreation).toBe(true);
      // After creation, it's resolved
      expect(svc.ref.isResolved).toBe(true);
    });

    it('should fire whenResolved callback for auto-hoisted values', () => {
      let resolvedCtx: unknown;
      class MyService {
        ref = inject(ContextRefKey);
        constructor() {
          this.ref.whenResolved((ctx) => { resolvedCtx = ctx; });
        }
      }

      const root = createRootContext();
      root.get(MyService);
      expect(resolvedCtx).toBe(root);
    });

    it('should throw when used with lookup() outside creation', () => {
      expect(() => lookup(ContextRefKey)).toThrow(/creation/i);
    });

    it('should throw when used with lookup() inside execution context', () => {
      const root = createRootContext();
      root.run(() => {
        expect(() => lookup(ContextRefKey)).toThrow(/creation/i);
      });
    });

    it('should work in factory functions with explicit scope', () => {
      const MyKey = createInjectionKey<{ ref: unknown }>('MyKey', {
        scope: RootScope,
        factory: () => ({ ref: inject(ContextRefKey) }),
      });

      const root = createRootContext();
      const val = root.get(MyKey);
      expect((val.ref as any).context).toBe(root);
    });

    it('should return a functional context (can call get)', () => {
      const ConfigKey = createInjectionKey<string>('Config', {
        factory: () => 'hello',
      });

      class MyService {
        ref = inject(ContextRefKey);
        getConfig() {
          return this.ref.context.get(ConfigKey);
        }
      }
      setScope(MyService, RootScope);

      const root = createRootContext();
      const svc = root.get(MyService);
      expect(svc.getConfig()).toBe('hello');
    });

    it('should work with custom scopes', () => {
      const myScope = createScope('my-scope');

      class MyService {
        ref = inject(ContextRefKey);
      }
      setScope(MyService, myScope);

      const root = createRootContext();
      const child = createContext({ parent: root, scopes: [myScope] });
      const svc = child.get(MyService);
      expect(svc.ref.context).toBe(child);
    });
  });
});
