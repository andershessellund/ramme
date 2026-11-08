// Tests for di / disposal.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey } from '../../src/context-key.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { ContextKey, inject } from '../../src/inject.js';
import { factoryProvider, valueProvider } from '../../src/provider-util.js';
import { CreationViolationError, NoCurrentNodeError } from '../../src/resource.js';
import { createScope } from '../../src/scope.js';
import { lookup, own } from '../../src/ambient.js';
import { here, impl, tick } from '../support/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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
        // Release removes the entry and runs its cleanup (DESIGN.md §2.6).
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

describe('own() in creation', () => {
  it('own() with no current node throws NoCurrentNodeError', () => {
    // DESIGN.md §2.6: own() needs a current node to attach to.
    expect(() => own(() => {})).toThrow(NoCurrentNodeError);
  });

  it('own() in an execution context attaches to the current node', async () => {
    // DESIGN.md §2.6: in a body (here: ctx.run), own() attaches to the current node.
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
    // DESIGN.md §3.2: creation-time reads must use inject() so dependencies are tracked.
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

describe('child auto-disposal', () => {
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

describe('own(v, release) in a factoryProvider', () => {
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

  it('should store an owning provider value on its own node, whatever the key scope (D36)', () => {
    const myScope = createScope('test-scope');
    const KEY = createInjectionKey<{ v: string }>('Scoped', { scope: myScope });

    const root = createRootContext();
    const child = root.child({
      providers: [factoryProvider(KEY, () => own({ v: 'val' }, () => {}))],
    });
    const scoped = child.child({ scopes: [myScope] });

    expect(scoped.get(KEY).v).toBe('val');
    expect(impl(child).cache.get(KEY)?.valueNode?.parent).toBe(child); // the value's node is on the provider's node
    expect(impl(scoped).cache.has(KEY)).toBe(false);
  });
});
