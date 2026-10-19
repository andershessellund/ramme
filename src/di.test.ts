// di.test.ts — ported from the pre-redesign context.test.ts suites
// (129 tests; the 21 dropped ones are context type properties (1), the
// probabilistic memo (1), context.create() (7), create() dep tracking (2),
// createRefCountedKey (6), refCountedProvider (4)) plus push-context.test.ts's
// captureAutoScoped suite (4), with `ctx.run` instead of the removed enterSync/leaveSync pair.
//
// Mechanical substitutions: `createContext({ parent: p, … })` →
// `p.child({ … })`; `inject(RegisterResource)({ [Dispose]: f })` →
// `own({ [Symbol.dispose]: f })` or `own(() => f())`; `ctx.dispose()` (sync) →
// `ctx.abort()`, observed synchronously (DESIGN.md §2.4); `await ctx.dispose()` →
// `await ctx.close()`; `ctx.runSync(fn, { providers, scopes })` →
// `using c = ctx.child({ providers, scopes }); c.run(fn)` (DESIGN.md §4.11).
//
// FLIP marks a port whose expectation the redesign reversed; each is annotated
// with the DESIGN.md section that reversed it. The flip that release fibers exist
// without a receiver while events do not is a lifecycle-events flip and is in
// node-topic.test.ts. The flip that `lookup` is refused in a factory had no old
// test (nothing read through `lookup` in a factory), so it is one added case.
// One more change follows from the substitutions and is annotated
// `(DESIGN.md §2.6)`: there is no bare detach, so the old `unregister()`
// becomes `release(x)`, which runs the release now.
//
// `lookup` and `own` are the free functions of ambient.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import './node.js';
import { createInjectionKey, setDependencies, setScope } from './context-key.js';
import type { Context } from './context.js';
import { createRootContext } from './create-context.js';
import { ContextKey, inject } from './inject.js';
import { aliasProvider, classProvider, factoryProvider, valueProvider } from './provider-util.js';
import { CreationViolationError, NoCurrentNodeError, PendingNodeError, PlacementError } from './resource.js';
import { RootScope, SelfScope, createScope } from './scope.js';
import { lookup, own } from './ambient.js';
import { here, impl, tick } from './test/util.js';

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

  it('should resolve child context providers via a child and run', () => {
    const REQUEST = createInjectionKey<{ url: string }>('REQUEST');

    const ctx = createRootContext();

    using c = ctx.child({ providers: [valueProvider(REQUEST, { url: '/api/test' })] });
    c.run(() => {
      expect(lookup(REQUEST)).toEqual({ url: '/api/test' });
    });
  });

  it('child context providers win over parent (child-wins)', () => {
    const KEY = createInjectionKey<string>('KEY');

    const ctx = createRootContext({
      providers: [valueProvider(KEY, 'parent')],
    });

    // the child's providers override the parent context's providers
    using c = ctx.child({ providers: [valueProvider(KEY, 'child')] });
    c.run(() => {
      expect(lookup(KEY)).toBe('child');
    });
  });

  it('lookup() and inject() throw outside any context', () => {
    const KEY = createInjectionKey<string>('KEY');
    expect(() => lookup(KEY)).toThrow(NoCurrentNodeError);
    expect(() => inject(KEY)).toThrow(CreationViolationError);
  });

  it('nested children inherit the parent chain', () => {
    const OUTER = createInjectionKey<string>('OUTER');
    const INNER = createInjectionKey<string>('INNER');

    const ctx = createRootContext();

    using outer = ctx.child({ providers: [valueProvider(OUTER, 'outer-val')] });
    outer.run(() => {
      using inner = here().child({ providers: [valueProvider(INNER, 'inner-val')] });
      inner.run(() => {
        // Inner can see its own provider
        expect(lookup(INNER)).toBe('inner-val');
        // Inner can see outer's provider via the parent chain
        expect(lookup(OUTER)).toBe('outer-val');
      });
    });
  });

  it('should auto-scope class with only structural deps into structural context', () => {
    class Logger {
      log(msg: string) {
        return msg;
      }
    }

    const ctx = createRootContext();

    let logger: Logger | undefined;
    ctx.run(() => {
      logger = lookup(Logger);
      expect(logger).toBeInstanceOf(Logger);
    });

    // Logger had no deps — auto-scoped to structural root
    expect(ctx.get(Logger)).toBe(logger);
  });

  it('should auto-scope class depending on structural dep to structural context', () => {
    class Database {}

    class UserRepo {
      db = inject(Database);
    }

    const ctx = createRootContext();

    let repo: UserRepo | undefined;
    ctx.run(() => {
      repo = lookup(UserRepo);
      expect(repo).toBeInstanceOf(UserRepo);
      expect(repo.db).toBeInstanceOf(Database);
    });

    // Both auto-scoped to structural root: the same instances are served there
    expect(ctx.get(UserRepo)).toBe(repo);
    expect(ctx.get(Database)).toBe(repo!.db);
  });

  it('should store in the child when depending on a child provider', () => {
    const REQUEST = createInjectionKey<{ url: string }>('REQUEST');

    class RequestHandler {
      request = inject(REQUEST);
    }

    const ctx = createRootContext();

    {
      using c = ctx.child({ providers: [valueProvider(REQUEST, { url: '/test' })] });
      c.run(() => {
        const handler = lookup(RequestHandler);
        expect(handler.request.url).toBe('/test');
      });
    }

    // RequestHandler is not on the root: creating it there fails because REQUEST has no root provider.
    expect(() => ctx.get(RequestHandler)).toThrow();
  });

  it('should store in the child when mixing structural and child deps', () => {
    class Database {}

    const REQUEST = createInjectionKey<{ url: string }>('REQUEST');

    class RequestHandler {
      db = inject(Database);
      request = inject(REQUEST);
    }

    const ctx = createRootContext();

    let handler: RequestHandler | undefined;
    {
      using c = ctx.child({ providers: [valueProvider(REQUEST, { url: '/api' })] });
      c.run(() => {
        handler = lookup(RequestHandler);
        expect(handler.db).toBeInstanceOf(Database);
        expect(handler.request.url).toBe('/api');
      });
    }

    // Database should be auto-scoped to the root (pure structural dep)
    expect(ctx.get(Database)).toBe(handler!.db);
    // RequestHandler depends on a child provider — it is not on the root.
    expect(() => ctx.get(RequestHandler)).toThrow();
  });

  it('each child gets independent child-scoped instances', () => {
    const REQUEST = createInjectionKey<{ id: number }>('REQUEST');

    class RequestHandler {
      request = inject(REQUEST);
    }

    const ctx = createRootContext();

    let handler1: RequestHandler | undefined;
    let handler2: RequestHandler | undefined;

    {
      using c = ctx.child({ providers: [valueProvider(REQUEST, { id: 1 })] });
      c.run(() => {
        handler1 = lookup(RequestHandler);
      });
    }
    {
      using c = ctx.child({ providers: [valueProvider(REQUEST, { id: 2 })] });
      c.run(() => {
        handler2 = lookup(RequestHandler);
      });
    }

    expect(handler1).not.toBe(handler2);
    expect(handler1!.request.id).toBe(1);
    expect(handler2!.request.id).toBe(2);
  });

  it('default-factory class auto-created in a child should share structural deps', () => {
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

    let shared: SharedService | undefined;
    {
      using c = ctx.child({ providers: [valueProvider(REQUEST, 'req-1')] });
      c.run(() => {
        const a = lookup(HandlerA);
        const b = lookup(HandlerB);
        // SharedService is purely structural — should be same instance
        expect(a.shared).toBe(b.shared);
        shared = a.shared;
      });
    }

    // SharedService should be auto-scoped to the structural root: the child's instance is the root's
    expect(ctx.get(SharedService)).toBe(shared);
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

  it('should resolve child providers via runSync: providers go on a child (DESIGN.md §4.11)', () => {
    const REQUEST = createInjectionKey<{ url: string }>('REQUEST');

    const ctx = createRootContext();

    using c = ctx.child({ providers: [valueProvider(REQUEST, { url: '/api/test' })] });
    c.runSync(() => {
      expect(lookup(REQUEST)).toEqual({ url: '/api/test' });
    });
  });

  it('child providers win over parent (child-wins)', () => {
    const KEY = createInjectionKey<string>('KEY');

    const ctx = createRootContext({
      providers: [valueProvider(KEY, 'parent')],
    });

    using c = ctx.child({ providers: [valueProvider(KEY, 'child')] });
    c.runSync(() => {
      expect(lookup(KEY)).toBe('child');
    });
  });

  it('nested runSync should inherit parent', () => {
    const OUTER = createInjectionKey<string>('OUTER');
    const INNER = createInjectionKey<string>('INNER');

    const ctx = createRootContext();

    using outer = ctx.child({ providers: [valueProvider(OUTER, 'outer-val')] });
    outer.runSync(() => {
      using inner = here().child({ providers: [valueProvider(INNER, 'inner-val')] });
      inner.runSync(() => {
        expect(lookup(INNER)).toBe('inner-val');
        expect(lookup(OUTER)).toBe('outer-val');
      });
    });
  });

  it('should auto-scope class with only structural deps into structural context', () => {
    class Logger {
      log(msg: string) {
        return msg;
      }
    }

    const ctx = createRootContext();

    let logger: Logger | undefined;
    ctx.runSync(() => {
      logger = lookup(Logger);
      expect(logger).toBeInstanceOf(Logger);
    });

    // Logger had no deps — auto-scoped to the structural root, so it outlives the runSync child
    expect(ctx.get(Logger)).toBe(logger);
  });

  it('should store in child context when depending on child provider', () => {
    const REQUEST = createInjectionKey<{ url: string }>('REQUEST');

    class RequestHandler {
      request = inject(REQUEST);
    }

    const ctx = createRootContext();

    {
      using c = ctx.child({ providers: [valueProvider(REQUEST, { url: '/test' })] });
      c.runSync(() => {
        const handler = lookup(RequestHandler);
        expect(handler.request.url).toBe('/test');
      });
    }

    // RequestHandler depends on a child provider — it is not on the root
    expect(() => ctx.get(RequestHandler)).toThrow();
  });

  it('each runSync should get independent child-scoped instances', () => {
    const REQUEST = createInjectionKey<{ id: number }>('REQUEST');

    class RequestHandler {
      request = inject(REQUEST);
    }

    const ctx = createRootContext();

    let handler1: RequestHandler | undefined;
    let handler2: RequestHandler | undefined;

    {
      using c = ctx.child({ providers: [valueProvider(REQUEST, { id: 1 })] });
      c.runSync(() => {
        handler1 = lookup(RequestHandler);
      });
    }
    {
      using c = ctx.child({ providers: [valueProvider(REQUEST, { id: 2 })] });
      c.runSync(() => {
        handler2 = lookup(RequestHandler);
      });
    }

    expect(handler1).not.toBe(handler2);
    expect(handler1!.request.id).toBe(1);
    expect(handler2!.request.id).toBe(2);
  });

  it('runSync from within ctx.run should see the entered context as grandparent', async () => {
    // The removed enterSync/leaveSync pair is replaced by `ctx.run(fn)`: the entered context is the one
    // `run` makes current.
    const OUTER = createInjectionKey<string>('OUTER');
    const INNER = createInjectionKey<string>('INNER');

    const ctx = createRootContext();

    const outerCtx = ctx.child({ providers: [valueProvider(OUTER, 'async-val')] });
    outerCtx.run(() => {
      using inner = here().child({ providers: [valueProvider(INNER, 'sync-val')] });
      inner.runSync(() => {
        expect(impl(here()).parent?.parent).toBe(impl(outerCtx));
        expect(lookup(INNER)).toBe('sync-val');
        expect(lookup(OUTER)).toBe('async-val');
      });
    });
    await outerCtx.close();
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
          own({ [Symbol.dispose]: () => void order.push('A') });
          return 'a';
        },
      });
      const KEY_B = createInjectionKey('B', {
        factory: () => {
          own({ [Symbol.dispose]: () => void order.push('B') });
          return 'b';
        },
      });
      const KEY_C = createInjectionKey('C', {
        factory: () => {
          own({ [Symbol.dispose]: () => void order.push('C') });
          return 'c';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY_A);
      ctx.get(KEY_B);
      ctx.get(KEY_C);
      ctx.abort();

      expect(order).toEqual(['C', 'B', 'A']);
      expect(ctx.state).toBe('complete'); // synchronous releases complete inside abort() (DESIGN.md §2.4)
    });

    it('should run multiple own() releases in reverse registration order', () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          own(() => void order.push('onDispose-1'));
          own(() => void order.push('onDispose-2'));
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);
      ctx.abort();

      expect(order).toEqual(['onDispose-2', 'onDispose-1']);
    });

    it('should allow releasing resources early (DESIGN.md §2.6: release(x) runs the release now)', () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          own(() => void order.push('kept'));
          const removed = own(() => void order.push('removed'));
          // There is no bare detach (DESIGN.md §2.6): an entry nobody owns is a leak. The old unregister()
          // becomes release(x), which runs the release now, exactly once (C7), in a release fiber.
          void here().release(removed);
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);
      expect(order).toEqual(['removed']);
      ctx.abort();

      expect(order).toEqual(['removed', 'kept']);
    });

    it('should dispose children before parent values', () => {
      const order: string[] = [];

      const PARENT_KEY = createInjectionKey('PARENT_KEY', {
        factory: () => {
          own({ [Symbol.dispose]: () => void order.push('parent') });
          return 'parent';
        },
      });

      const CHILD_KEY = createInjectionKey('CHILD_KEY', {
        factory: () => {
          own({ [Symbol.dispose]: () => void order.push('child') });
          return 'child';
        },
      });

      const parent = createRootContext();
      parent.get(PARENT_KEY);

      const child = parent.child();
      child.get(CHILD_KEY);

      parent.abort(); // the child entry (explicit) completes synchronously too (DESIGN.md §2.4)

      expect(order).toEqual(['child', 'parent']);
      expect(child.state).toBe('complete');
    });

    it('should dispose multiple children in reverse creation order', () => {
      const order: string[] = [];

      const KEY_1 = createInjectionKey('KEY_1', {
        factory: () => {
          own({ [Symbol.dispose]: () => void order.push('child-1') });
          return 'c1';
        },
      });
      const KEY_2 = createInjectionKey('KEY_2', {
        factory: () => {
          own({ [Symbol.dispose]: () => void order.push('child-2') });
          return 'c2';
        },
      });

      const parent = createRootContext();

      const child1 = parent.child();
      child1.get(KEY_1);

      const child2 = parent.child();
      child2.get(KEY_2);

      parent.abort();

      expect(order).toEqual(['child-2', 'child-1']);
    });

    it('should be idempotent (double-dispose is safe)', async () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          own({ [Symbol.dispose]: () => void order.push('disposed') });
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);
      await ctx.close();
      await ctx.close();

      expect(order).toEqual(['disposed']);
    });

    it('should work with await using syntax via [Symbol.asyncDispose]', async () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          own({ [Symbol.dispose]: () => void order.push('disposed') });
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
          own({
            [Symbol.asyncDispose]: async () => {
              await tick();
              order.push('A');
            },
          });
          return 'a';
        },
      });
      const KEY_B = createInjectionKey('B', {
        factory: () => {
          own({
            [Symbol.asyncDispose]: async () => {
              await tick();
              order.push('B');
            },
          });
          return 'b';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY_A);
      ctx.get(KEY_B);
      await ctx.close();

      expect(order).toEqual(['B', 'A']);
    });

    it('should be idempotent (double-dispose returns resolved promise)', async () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          own({ [Symbol.asyncDispose]: async () => void order.push('disposed') });
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);
      await ctx.close();
      await ctx.close();

      expect(order).toEqual(['disposed']);
    });

    it('should work with await using syntax via [Symbol.asyncDispose]', async () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          own({ [Symbol.asyncDispose]: async () => void order.push('disposed') });
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
          own({ [Symbol.asyncDispose]: async () => void order.push('parent') });
          return 'p';
        },
      });
      const C_KEY = createInjectionKey('C', {
        factory: () => {
          own({ [Symbol.asyncDispose]: async () => void order.push('child') });
          return 'c';
        },
      });

      const parent = createRootContext();
      parent.get(P_KEY);

      const child = parent.child();
      child.get(C_KEY);

      await parent.close();

      expect(order).toEqual(['child', 'parent']);
    });
  });

  describe('own() in creation (was RegisterResource)', () => {
    it('own() with no current node throws NoCurrentNodeError', () => {
      // FLIP (DESIGN.md §2.6): own() is no longer creation-only; outside any node there is nothing to attach to.
      expect(() => own(() => {})).toThrow(NoCurrentNodeError);
    });

    it('own() in an execution context attaches to the current node', async () => {
      // FLIP (DESIGN.md §2.6): in a body (here: ctx.run), own() attaches to the current node.
      const ctx = createRootContext();
      let released = false;

      ctx.run(() => {
        own(() => {
          released = true;
        });
      });

      expect(impl(ctx).explicit.size).toBe(1);
      expect(released).toBe(false);
      await ctx.close();
      expect(released).toBe(true);
    });

    it('lookup() inside a factory throws CreationViolationError', () => {
      // FLIP (DESIGN.md §3.2): lookup used to read untracked during creation; a creation-time read is now
      // inject() (tracked) or nothing.
      const KEY = createInjectionKey<string>('KEY');
      const V = createInjectionKey<string>('V', { factory: () => lookup(KEY) });
      const ctx = createRootContext({ providers: [valueProvider(KEY, 'k')] });
      expect(() => ctx.get(V)).toThrow(CreationViolationError);
      expect(() => ctx.get(V)).toThrow(/use inject\(\)/);
      expect(impl(ctx).cache.has(V)).toBe(false);
    });

    it('should allow own() during factory execution', () => {
      const resource = { [Symbol.dispose]() {} };
      const KEY = createInjectionKey('KEY', {
        factory: () => {
          expect(own(resource)).toBe(resource); // every overload returns what it attached
          expect(impl(here()).explicit.size).toBe(1); // on the value's own node (DESIGN.md §2.6)
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);
    });

    it('should allow own() during class construction', () => {
      class MyService {
        resource = own({ [Symbol.dispose]() {} });
        node = inject(ContextKey);
      }

      const ctx = createRootContext();
      const svc = ctx.get(MyService);
      expect(typeof svc.resource[Symbol.dispose]).toBe('function');
      expect(impl(svc.node).explicit.find(svc.resource)).toBeDefined();
    });

    it('should run own() releases on context dispose', async () => {
      let disposed = false;

      class MyService {
        constructor() {
          own({
            [Symbol.dispose]: () => {
              disposed = true;
            },
          });
        }
      }

      const ctx = createRootContext();
      ctx.get(MyService);
      expect(disposed).toBe(false);

      await ctx.close();
      expect(disposed).toBe(true);
    });

    it('should allow releasing early after creation (DESIGN.md §2.6: release(x) runs the release now)', async () => {
      const order: string[] = [];

      let node: Context | undefined;
      let removed: object | undefined;
      const KEY = createInjectionKey('KEY', {
        factory: () => {
          own(() => void order.push('kept'));
          removed = own(() => void order.push('removed'));
          node = here();
          return 'value';
        },
      });

      const ctx = createRootContext();
      ctx.get(KEY);

      // after creation, through the value's (now placed) node
      await node!.release(removed!);
      expect(order).toEqual(['removed']);

      await ctx.close();
      expect(order).toEqual(['removed', 'kept']);
    });
  });

  describe('child auto-disposal (was execution context auto-disposal)', () => {
    it('a child disposes its values when its using block ends', () => {
      const order: string[] = [];

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          own(() => void order.push('ec-disposed'));
          return 'value';
        },
      });

      const ctx = createRootContext();

      {
        using c = ctx.child({
          providers: [
            {
              key: KEY,
              provide: () => {
                own(() => void order.push('ec-disposed'));
                return 'provided-value';
              },
            },
          ],
        });
        c.run(() => {
          lookup(KEY);
        });
        expect(order).toEqual([]);
      }

      expect(order).toEqual(['ec-disposed']); // synchronous (DESIGN.md §2.4, §4.11)
    });

    it('a child disposes class instances placed on it', () => {
      const order: string[] = [];

      const REQUEST = createInjectionKey<string>('REQUEST');

      class Handler {
        request = inject(REQUEST);
        constructor() {
          own(() => void order.push('handler-disposed'));
        }
      }

      const ctx = createRootContext();

      {
        using c = ctx.child({ providers: [valueProvider(REQUEST, '/test')] });
        c.run(() => {
          lookup(Handler);
        });
      }

      expect(order).toEqual(['handler-disposed']);
    });

    it('a child disposes even if the callback throws', () => {
      let disposed = false;

      const KEY = createInjectionKey('KEY', {
        factory: () => {
          own(() => {
            disposed = true;
          });
          return 'value';
        },
      });

      const ctx = createRootContext();

      expect(() => {
        using c = ctx.child({
          providers: [
            {
              key: KEY,
              provide: () => {
                own(() => {
                  disposed = true;
                });
                return 'value';
              },
            },
          ],
        });
        c.run(() => {
          lookup(KEY);
          throw new Error('boom');
        });
      }).toThrow('boom');

      expect(disposed).toBe(true);
    });
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
      const child = root.child();

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
      expect(() => ctx.addProvider({ key, provide: () => 'replacement' })).toThrow(PlacementError);
      expect(() => ctx.addProvider({ key, provide: () => 'replacement' })).toThrow(/decided/);
    });

    it('allows adding a provider at a fresh child after the key resolved at an ancestor', () => {
      // FLIP (DESIGN.md §3.4): a fresh child has no decisions, so providing there is allowed. The ancestor's
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
      // FLIP (DESIGN.md §3.4): the root never answered for UserRepo (the child did), so it may provide it,
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
      const child = root.child();
      const fromChild = child.get(Service);
      const fromRoot = root.get(Service);
      expect(fromChild).toBe(fromRoot);
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

  describe('Provider.scope', () => {
    it('should store explicit provider value on scoped context', () => {
      const requestScope = createScope('request');
      const CONFIG = createInjectionKey<string>('CONFIG');

      const root = createRootContext({
        scopes: [requestScope],
        providers: [valueProvider(CONFIG, 'root-config', { scope: requestScope })],
      });
      const child = root.child();

      // Provider is on root with scope=requestScope, root owns requestScope:
      // the value is stored on root (the scope owner)
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
      const mid = root.child({ scopes: [requestScope] });
      const child = mid.child();

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

      // SelfScope on provider: each creation gets its own instance. root.create(WRAPPER) is removed:
      // two sibling children each resolve WRAPPER, pinned at its requester (DESIGN.md §3.4).
      const WRAPPER = createInjectionKey<number>('Wrapper', {
        factory: () => inject(KEY),
      });
      const c1 = root.child().get(WRAPPER);
      const c2 = root.child().get(WRAPPER);
      expect(c1).toBe(1);
      expect(c2).toBe(2);
    });

    it('should support SelfScope on provider scope (scoped context)', () => {
      let counter = 0;
      const KEY = createInjectionKey<number>('SelfProvider');

      const root = createRootContext({
        providers: [factoryProvider(KEY, () => ++counter, { scope: SelfScope })],
      });

      const child1 = root.child({ scopes: [SelfScope] });
      const child2 = root.child({ scopes: [SelfScope] });
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
      const child = root.child();

      const fromChild = child.get(MyService);
      expect(fromChild.name).toBe('service');
      expect(root.get(MyService)).toBe(fromChild); // same instance, stored at root
    });
  });

  describe('skipSelf', () => {
    it('context.get with skipSelf resolves from parent', () => {
      const KEY = createInjectionKey<string>('Val');
      const root = createRootContext({
        providers: [valueProvider(KEY, 'root')],
      });
      const child = root.child({
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

    it('inject with skipSelf during creation resolves from parent provider', () => {
      const HttpClient = createInjectionKey<{ name: string }>('HttpClient');

      const root = createRootContext({
        providers: [factoryProvider(HttpClient, () => ({ name: 'base' }))],
      });

      const child = root.child({
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

    it('inject with skipSelf during creation returns undefined when optional and no parent value', () => {
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

    it('lookup with skipSelf in a runSync skips the current node', () => {
      const KEY = createInjectionKey<string>('Val');
      const root = createRootContext({
        providers: [valueProvider(KEY, 'root')],
      });
      const child = root.child({
        providers: [valueProvider(KEY, 'child')],
      });

      // runSync's node is a child of `child`: skipping it resolves from `child`, past the node's own provider.
      const result = child.runSync(() => {
        here().addProvider(valueProvider(KEY, 'self'));
        return { self: lookup(KEY), skipped: lookup(KEY, { skipSelf: true }) };
      });

      expect(result).toEqual({ self: 'self', skipped: 'child' });
    });

    it('decorator pattern: multiple levels of wrapping', () => {
      const Service = createInjectionKey<{ trace(): string }>('Service');

      const root = createRootContext({
        providers: [factoryProvider(Service, () => ({ trace: () => 'base' }))],
      });

      const mid = root.child({
        providers: [
          factoryProvider(Service, () => {
            const parent = inject(Service, { skipSelf: true });
            return { trace: () => `mid(${parent.trace()})` };
          }),
        ],
      });

      const leaf = mid.child({
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

  describe('own(v, release) in a factoryProvider (was resourceProvider)', () => {
    // resourceProvider(k, v, r) → factoryProvider(k, () => own(v, release)); attached values are objects.
    it('should provide the value and register a resource', async () => {
      const KEY = createInjectionKey<{ name: string }>('Conn');
      const conn = { name: 'my-connection' };
      let disposed = false;

      const ctx = createRootContext({
        providers: [
          factoryProvider(KEY, () =>
            own(conn, () => {
              disposed = true;
            }),
          ),
        ],
      });

      expect(ctx.get(KEY)).toBe(conn);
      expect(disposed).toBe(false);

      await ctx.close();
      expect(disposed).toBe(true);
    });

    it('should dispose resources in reverse registration order', async () => {
      const A = createInjectionKey<{ v: string }>('A');
      const B = createInjectionKey<{ v: string }>('B');
      const order: string[] = [];

      const ctx = createRootContext({
        providers: [
          factoryProvider(A, () => own({ v: 'a' }, () => void order.push('A'))),
          factoryProvider(B, () => own({ v: 'b' }, () => void order.push('B'))),
        ],
      });

      ctx.get(A);
      ctx.get(B);
      await ctx.close();

      expect(order).toEqual(['B', 'A']);
    });

    it('should work with child contexts', async () => {
      const KEY = createInjectionKey<{ v: string }>('Lease');
      let released = false;

      const root = createRootContext();
      const child = root.child({
        providers: [
          factoryProvider(KEY, () =>
            own({ v: 'leased-resource' }, () => {
              released = true;
            }),
          ),
        ],
      });

      expect(child.get(KEY).v).toBe('leased-resource');
      await child.close();
      expect(released).toBe(true);
    });

    it('should support scope option', () => {
      const KEY = createInjectionKey<{ v: string }>('Scoped');
      const myScope = createScope('test-scope');

      const root = createRootContext();
      const child = root.child({
        providers: [factoryProvider(KEY, () => own({ v: 'val' }, () => {}), { scope: myScope })],
        scopes: [myScope],
      });

      expect(child.get(KEY).v).toBe('val');
    });
  });

  describe('ContextKey / current() in creation (was ContextRef)', () => {
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
      // FLIP (DESIGN.md §3.3): reading inject(ContextKey) in an auto-hoisted factory is allowed — it is the
      // pending node — and get() on it throws PendingNodeError (was: ContextRef.context threw).

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

    it('a constructor fork runs after placement (was whenResolved)', async () => {
      let seen: { state: string; parent: unknown } | undefined;
      class MyService {
        ctx = inject(ContextKey);
        constructor() {
          const n = here();
          n.own(
            n.fork(async () => {
              seen = { state: this.ctx.state, parent: impl(this.ctx).parent };
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

    // FLIP (DESIGN.md §3.3, §3.4): the negative memo at the boundary's parent is gone, so the suite builds a fresh
    // instance of its own instead of throwing.
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

    // FLIP (DESIGN.md §3.3, §3.4): UserRepo was captured; the suite builds its own instead of throwing.
    const fresh = suite.run(() => lookup(UserRepo));
    expect(fresh).not.toBe(repo);
    // Database is still served (it was explicitly provided at suite level)
    expect(fresh.db).toBe(repo.db);
    expect(suite.run(() => lookup(Database)).name).toBe('test-db');

    await suite.close();
  });
});
