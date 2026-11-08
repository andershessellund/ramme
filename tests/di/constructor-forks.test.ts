// Tests for di / constructor forks.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey } from '../../src/context-key.js';
import type { Context, Provider } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import type { NodeImpl } from '../../src/node-impl.js';
import { factoryProvider, valueProvider } from '../../src/provider-util.js';
import { RootScope } from '../../src/scope.js';
import { child, lookup, own, pool } from '../../src/ambient.js';
import { here, impl, tick, trace } from '../support/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('forks in a constructor (DESIGN.md §4.6, D14)', () => {
  it('a constructor fork starts after placement with the value node as parent, and lookup works inside it', async () => {
    const Config = createInjectionKey<string>('Config');
    const t = trace();
    let svcNode: NodeImpl | undefined;
    let seen: { parent: unknown; config: string; svcState: string } | undefined;
    class Svc {
      constructor() {
        const n = here();
        svcNode = impl(n);
        n.own(
          n.fork(function* () {
            t.push('fork runs');
            seen = { parent: impl(here()).parent, config: lookup(Config), svcState: n.state };
          }),
        );
        t.push('constructor end');
      }
    }
    const app = createRootContext({ providers: [valueProvider(Config, 'cfg')] });
    const req = app.child();
    req.get(Svc);
    t.push('get returned');
    await req.close(); // the request completing does not touch the value's fork: it lives on the value's node
    await tick();
    expect(t.log).toEqual(['constructor end', 'get returned', 'fork runs']);
    expect(seen).toEqual({ parent: svcNode, config: 'cfg', svcState: 'running' });
    expect(svcNode!.parent).toBe(impl(app));
    await app.close();
  });

  it("an unowned 'join' fork in a constructor fails the resolution with a TypeError and the pending node is released", async () => {
    let ran = false;
    let released = false;
    let node: NodeImpl | undefined;
    class Bad {
      constructor() {
        node = impl(here());
        here().own(() => {
          released = true;
        });
        here().fork(function* () {
          ran = true;
        });
      }
    }
    const root = createRootContext();
    expect(() => root.get(Bad)).toThrow(TypeError);
    expect(() => root.get(Bad)).toThrow(/own\(fork\(…\)\) or pass onFailure/);
    expect(released).toBe(true);
    expect(node!.state).toBe('complete');
    expect(impl(root).cache.has(Bad)).toBe(false);
    expect(impl(root).provided.size).toBe(0);
    await tick();
    expect(ran).toBe(false);
  });

  it("the same for a declared placement: the live value node is aborted and leaves S's provided stack", async () => {
    let ran = false;
    let released = false;
    let node: NodeImpl | undefined;
    const V = createInjectionKey<object>('V');
    const root = createRootContext({
      providers: [
        factoryProvider(V, () => {
          node = impl(here());
          own(() => {
            released = true;
          });
          here().fork(function* () {
            ran = true;
          });
          return {};
        }),
      ],
    });
    expect(() => root.get(V)).toThrow(TypeError);
    expect(released).toBe(true);
    expect(node!.state).toBe('complete');
    expect(impl(root).cache.has(V)).toBe(false);
    expect(impl(root).provided.size).toBe(0);
    await tick();
    expect(ran).toBe(false);
    await expect(root.close()).resolves.toBeUndefined(); // an aborted value node surfaces nothing
  });

  it("own(fork(…)), fork(task(…, { onFailure })) and a pool's fork in a constructor are accepted", async () => {
    const t = trace();
    class Good {
      constructor() {
        const n = here();
        n.own(n.fork(function* () { return void t.push('owned'); }));
        n.fork(task(function* () { return void t.push('handled'); }, { onFailure: () => {} }));
        n.fork(task(function* () { return void t.push('linked'); }, { onFailure: 'link' }));
        n.pool({ name: 'p', onFailure: () => {} }).fork(function* () { return void t.push('pooled'); });
      }
    }
    const root = createRootContext();
    expect(() => root.get(Good)).not.toThrow();
    expect(t.log).toEqual([]);
    await tick();
    expect([...t.log].sort()).toEqual(['handled', 'linked', 'owned', 'pooled']);
    await root.close();
  });
});

describe('a provider on a node built under a pending node (D36)', () => {
  it('stores its value on that node once the pending node is placed, whatever the key’s scope', async () => {
    const shapes: Record<string, (p: Provider<unknown>) => Context> = {
      'child({ providers })': (p) => child({ providers: [p] }),
      'child().addProvider': (p) => {
        const c = child();
        c.addProvider(p);
        return c;
      },
      'a grandchild': (p) => child().child({ providers: [p] }),
      'pool({ providers })': (p) => pool({ name: 'p', providers: [p], onFailure: () => {} }),
    };
    for (const [shape, build] of Object.entries(shapes)) {
      const K = createInjectionKey<string>('K', { scope: RootScope, factory: () => 'default' }); // owned by the root, above the node
      let built: Context | undefined;
      class V {
        constructor() {
          built = build(valueProvider(K, 'built') as Provider<unknown>);
        }
      }
      const root = createRootContext();
      expect(root.get(V), shape).toBeInstanceOf(V); // placed at the root, the scope's owner above the built node
      expect(built!.get(K), shape).toBe('built');
      expect(impl(built!).cache.get(K)?.scope, shape).toBeUndefined(); // a provider's value: no scope on its entry
      expect(root.get(K), shape).toBe('default'); // the key's own default, at its scope owner
      await root.close();
    }
  });
});
