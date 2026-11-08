// Tests for runtime / context entry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey } from '../../src/context-key.js';
import { createRootContext } from '../../src/create-context.js';
import { inject } from '../../src/inject.js';
import { valueProvider } from '../../src/provider-util.js';
import { CreationViolationError, NoCurrentNodeError } from '../../src/resource.js';
import { lookup } from '../../src/ambient.js';
import { here, impl } from '../support/util.js';

afterEach(() => {
  vi.restoreAllMocks();
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
