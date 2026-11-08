// Tests for lifecycle / nodes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import type { Context, Fiber } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import type { NodeImpl } from '../../src/node-impl.js';
import { factoryProvider } from '../../src/provider-util.js';
import { PendingNodeError } from '../../src/resource.js';
import { RootScope } from '../../src/scope.js';
import { events, here, impl, tick } from '../support/util.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('anatomy', () => {
  it('ids are unique across every node kind', async () => {
    const V = createInjectionKey<object>('V');
    const ev = events({
      providers: [
        factoryProvider(V, () => {
          here(); // materialises the value's node (DESIGN.md §3.3)
          return {};
        }),
      ],
    });
    const app = ev.root;
    app.child();
    app.pool({ name: 'p', onFailure: () => {} });
    await app.call(function* () {
      here().own(() => {}); // a release fiber at the fiber's completion
      app.get(V);
    });
    await app.close();
    const created = ev.of('node:created');
    const ids = created.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(created.map((e) => e.kind))).toEqual(new Set(['context', 'pool', 'fiber', 'release', 'value']));
  });

  it('state runs running → settling → releasing → complete', async () => {
    const seen: string[] = [];
    const app = createRootContext();
    let F!: NodeImpl;
    await app.call(function* () {
      F = here();
      here().own(() => void seen.push(`release:${F.state}`));
      const g = here().fork(function* () {
        yield* here().never();
      });
      g.signal.addEventListener('abort', () => void seen.push(`interrupt:${F.state}`));
      seen.push(`body:${F.state}`);
      yield* wait(tick());
    });
    seen.push(`after:${F.state}`);
    expect(seen).toEqual(['body:running', 'interrupt:settling', 'release:releasing', 'after:complete']);
    await app.close();
  });

  it('scopes is a read-only view: the root carries RootScope; scope-less nodes share one empty set', async () => {
    const app = createRootContext();
    expect(app.scopes.has(RootScope)).toBe(true);
    const a = app.child();
    const b = app.child();
    expect(a.scopes.size).toBe(0);
    expect(a.scopes).toBe(b.scopes);
    await app.close();
  });

  it('child() is a subscribed explicit entry; pool() is an unsubscribed explicit entry', async () => {
    const app = createRootContext();
    const c = impl(app.child());
    const p = impl(app.pool({ name: 'p', onFailure: () => {} }));
    const root = impl(app);
    expect(c.subscribed).toBe(true);
    expect(root.subscribers.has(c)).toBe(true);
    expect(c.entryOnOwner?.stack).toBe(root.explicit);
    expect(p.subscribed).toBe(false);
    expect(root.subscribers.has(p)).toBe(false);
    expect(p.entryOnOwner?.stack).toBe(root.explicit);
    expect(c.kind).toBe('context');
    expect(p.kind).toBe('pool');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// `parent` (DESIGN.md §2.1, D33). Value nodes and the unit-of-work idiom are in parent.test.ts.
describe('parent (DESIGN.md §2.1, D33)', () => {
  it("a root's parent is undefined", async () => {
    const app = createRootContext();
    expect(app.parent).toBeUndefined();
    await app.close();
  });

  it('child, fork, call and pool children, and a pool’s forks, have the node they were made on as parent', async () => {
    const app = createRootContext();
    const c = app.child();
    expect(c.parent).toBe(app);
    expect(c.child().parent).toBe(c);
    const p = app.pool({ name: 'p', onFailure: () => {} });
    expect(p.parent).toBe(app);
    const pf = p.fork(function* () {});
    expect(pf.parent).toBe(p);
    const seen: { fork?: unknown; forkBody?: unknown; call?: unknown; me?: Context } = {};
    await app.call(function* () {
      const me = here() as Context;
      seen.me = me;
      const f = here().fork(function* () {
        seen.forkBody = here().parent; // a body reads its own node's parent the same way
      });
      seen.fork = f.parent;
      yield* here().call(function* () {
        seen.call = here().parent;
      });
      yield* here().join(f);
    });
    expect(seen.fork).toBe(seen.me);
    expect(seen.forkBody).toBe(seen.me);
    expect(seen.call).toBe(seen.me);
    expect(seen.me!.parent).toBe(app); // app.call's own child
    await app.close();
  });

  it('inside a release fiber, current().parent is the owner', async () => {
    const app = createRootContext();
    const N = app.child({ name: 'N' });
    let seen: { kind: string; parent: unknown } | undefined;
    N.own(() => {
      const rf = here();
      seen = { kind: rf.kind, parent: rf.parent };
    });
    await N.close();
    expect(seen).toEqual({ kind: 'release', parent: N });
    await app.close();
  });

  it("a pending value node refuses parent with PendingNodeError, as it refuses get and addProvider (DESIGN.md §3.3)", async () => {
    const app = createRootContext();
    let refused: unknown;
    let pendingState: string | undefined;
    const K = createInjectionKey<object>('K', {
      factory: () => {
        const n = here(); // materialises the auto-hoisted value's node: pending until placement
        pendingState = n.state;
        try {
          void n.parent;
        } catch (e) {
          refused = e;
        }
        return { n };
      },
    });
    const v = app.get(K) as { n: Context };
    expect(pendingState).toBe('pending');
    expect(refused).toBeInstanceOf(PendingNodeError);
    expect(v.n.parent).toBe(app); // placed: the storage node
    await app.close();
  });

  it('parent is readable after completion: the tree shape stays', async () => {
    const app = createRootContext();
    const c = app.child();
    let f!: Fiber<unknown>;
    await app.call(function* () {
      f = here().fork(function* () { return 1; });
      yield* here().join(f);
    });
    c.abort();
    expect(c.state).toBe('complete');
    expect(c.parent).toBe(app);
    expect(f.state).toBe('complete');
    expect(f.parent?.parent).toBe(app);
    await app.close();
    expect(app.state).toBe('complete');
    expect(app.parent).toBeUndefined();
    expect(c.parent).toBe(app);
  });
});
