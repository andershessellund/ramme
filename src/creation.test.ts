// creation.test.ts — the pending node and placement (DESIGN.md §3.3; a pending
// value node is born with its requester's root), creation purity
// (DESIGN.md §3.2, §3.5: get/call/run/runSync throw CreationViolationError in
// a creation frame, and only inject reads ContextKey), the deferral of constructor forks
// (D14), a failed factory releasing what it owned, constructor forks (no
// creation-frame leak into a forked body, a constructor-forked fiber's parent),
// SelfScope attachment, placement into a releasing or complete storage
// context, cycles and skipSelf, re-entry from releases (DESIGN.md §3.3), the
// end of a creation (DESIGN.md §3.5) and the scoped-provider rule at placement
// (DESIGN.md §3.4).
//
// `child`, `fork`, `lookup`, `own` and `pool` are the free functions of
// ambient.ts. The other operations use the method form on `here()`
// (= current()), which is what the free functions are.
import { afterEach, describe, expect, it, vi } from 'vitest';
import './node.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Provider } from './context.js';
import { currentCreation, peekCurrentNode } from './context-storage.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { ContextKey, inject } from './inject.js';
import { NodeTopic } from './lifecycle-events.js';
import type { NodeEvent } from './lifecycle-events.js';
import type { NodeImpl } from './node-impl.js';
import { factoryProvider, valueProvider } from './provider-util.js';
import {
  CreationViolationError,
  FactoryReturnedUndefinedError,
  NoCurrentNodeError,
  NodeCompletedError,
  PendingNodeError,
  PlacementError,
} from './resource.js';
import { RootScope, SelfScope, createScope } from './scope.js';
import { child, fork, lookup, own, pool } from './ambient.js';
import { deferred, events, gcUntil, here, impl, tick, trace } from './test/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the pending node (DESIGN.md §3.3)', () => {
  it('a value that attaches nothing gets no node', () => {
    const ev = events();
    class Plain {}
    ev.root.get(Plain);
    expect(ev.of('node:created').filter((e) => e.kind === 'value')).toEqual([]);
    expect(impl(ev.root).provided.size).toBe(0);
    expect(impl(ev.root).cache.get(Plain)?.valueNode).toBeUndefined();
  });

  it('the first own / current() / inject(ContextKey) / fork / pool / child creates it: pending, no parent, the requester’s root', () => {
    const triggers: Record<string, () => void> = {
      own: () => void own(() => {}),
      'current()': () => void here(),
      'inject(ContextKey)': () => void inject(ContextKey),
      // The free functions themselves: none of them goes through current() first.
      fork: () => void fork(task(async () => {}, { onFailure: () => {} })),
      pool: () => void pool({ name: 'p', onFailure: () => {} }),
      child: () => void child(),
    };
    for (const [name, trigger] of Object.entries(triggers)) {
      const root = createRootContext();
      const requester = root.child().child();
      let before: NodeImpl | undefined;
      let n: NodeImpl | undefined;
      let seen: { state: string; parent: unknown; sameRoot: boolean } | undefined;
      const K = createInjectionKey<object>(`K-${name}`, {
        factory: () => {
          before = peekCurrentNode();
          trigger();
          n = peekCurrentNode();
          seen = { state: n!.state, parent: n!.parent, sameRoot: n!.root === impl(requester).root };
          return {};
        },
      });
      requester.get(K);
      expect(before, name).toBeUndefined();
      expect(seen, name).toEqual({ state: 'pending', parent: undefined, sameRoot: true });
      expect(n!.kind, name).toBe('value');
      // placed at the deepest dependency: none here, so the auto-scope root
      expect(n!.state, name).toBe('running');
      expect(n!.parent, name).toBe(impl(root));
      expect(n!.depth, name).toBe(1);
    }
  });

  it('under a receiver, a default factory that owns, forks, reads current() and releases early emits like any node', async () => {
    const ev = events();
    let vid = 0;
    let fid = 0;
    const K = createInjectionKey<object>('K', {
      factory: () => {
        const n = here();
        vid = n.id;
        const x = own(() => {});
        const f = n.own(n.fork(task(async () => {}, { name: 'reaper' })));
        fid = f.id;
        void n.release(x); // a release fiber under the pending node
        return {};
      },
    });
    expect(() => ev.root.get(K)).not.toThrow();
    expect(ev.typesOf(vid)).toEqual([
      'node:created',
      'entry:registered', // own(x)
      'entry:registered', // the fork
      'entry:released', // the early release of x
      'node:placed',
    ]);
    const created = ev.of('node:created').find((e) => e.id === vid)!;
    expect(created).toMatchObject({ kind: 'value', stack: 'none', subscribed: false, name: 'K' });
    expect(ev.of('node:placed').find((e) => e.id === vid)?.storageId).toBe(ev.root.id);
    await tick();
    const placedSeq = ev.of('node:placed').find((e) => e.id === vid)!.seq;
    const startedSeq = ev.of('node:started').find((e) => e.id === fid)!.seq;
    expect(startedSeq).toBeGreaterThan(placedSeq); // node:placed precedes the constructor fork's node:started (DESIGN.md §4.6)
    await ev.root.close();
  });

  it('get / call / run / abort / close and the other refused operations throw PendingNodeError on it', async () => {
    const KEY = createInjectionKey<string>('KEY');
    const root = createRootContext();
    const f = root.fork(task(async () => 1, { onFailure: () => {} })); // a live fiber the pending node may not await (DESIGN.md §3.3)
    const refused: Record<string, (n: Context) => unknown> = {
      get: (n) => n.get(KEY),
      addProvider: (n) => n.addProvider(valueProvider(KEY, 'x')),
      call: (n) => n.call(() => 1),
      all: (n) => n.all([]),
      race: (n) => n.race([task(() => 1)]),
      join: (n) => n.join(f),
      result: (n) => n.result(f),
      interrupted: (n) => n.interrupted(),
      never: (n) => n.never(),
      managed: (n) => n.managed(Promise.resolve(1)),
      run: (n) => n.run(() => 1),
      runSync: (n) => n.runSync(() => 1),
      abort: (n) => n.abort(),
      close: (n) => n.close(),
      '[Symbol.dispose]': (n) => n[Symbol.dispose](),
      '[Symbol.asyncDispose]': (n) => n[Symbol.asyncDispose](),
    };
    const errors: Record<string, unknown> = {};
    const V = createInjectionKey<object>('V', {
      factory: () => {
        const n = here();
        for (const [op, f] of Object.entries(refused)) {
          try {
            f(n);
            errors[op] = 'no error';
          } catch (e) {
            errors[op] = e;
          }
        }
        return {};
      },
    });
    root.get(V);
    for (const op of Object.keys(refused)) expect(errors[op], op).toBeInstanceOf(PendingNodeError);
    await root.close();
  });

  it('after resolution the node is placed: parent is S, state running, depth fixed', () => {
    const D = createInjectionKey<string>('D');
    let n: NodeImpl | undefined;
    class V {
      d = inject(D);
      constructor() {
        n = impl(here());
      }
    }
    const root = createRootContext();
    const S = root.child({ providers: [valueProvider(D, 'd')] });
    const R = S.child().child();
    R.get(V);
    expect(n!.state).toBe('running');
    expect(n!.parent).toBe(impl(S));
    expect(n!.depth).toBe(impl(S).depth + 1);
    expect(n!.entryOnOwner?.stack).toBe(impl(S).provided); // I24: only resolution attaches to the provided stack
    expect(impl(R).provided.size).toBe(0);
  });

  it('a declared placement is live from the first touch: parent is S inside the constructor', () => {
    let inside: { state: string; parent: unknown; onProvided: boolean } | undefined;
    const V = createInjectionKey<object>('V');
    const root = createRootContext();
    const S = root.child({
      providers: [
        factoryProvider(V, () => {
          const n = impl(here());
          inside = { state: n.state, parent: n.parent, onProvided: n.entryOnOwner?.stack === impl(S).provided };
          return {};
        }),
      ],
    });
    S.child().get(V);
    expect(inside).toEqual({ state: 'running', parent: impl(S), onProvided: true });
  });

  it('inject(ContextKey) is current(), and reading it does not move placement (DESIGN.md §3.3)', () => {
    const X = createInjectionKey<string>('X');
    let same = false;
    class V {
      ctx = inject(ContextKey);
      constructor() {
        same = this.ctx === here();
      }
    }
    const root = createRootContext();
    const R = root.child({ providers: [valueProvider(X, 'x')] }).child();
    const v = R.get(V);
    expect(same).toBe(true);
    expect(impl(root).cache.get(V)?.value).toBe(v); // only ContextKey was read: it lands at the auto-scope root
    expect(impl(root).cache.get(V)?.deps?.size).toBe(0); // and ContextKey is not in deps(V)
  });
});

describe('creation is pure (DESIGN.md §3.2, §3.5)', () => {
  it('lookup / get / call / run / runSync / all / race in a factory throw CreationViolationError', () => {
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    const banned: Record<string, () => unknown> = {
      lookup: () => lookup(K),
      'root.get': () => root.get(K),
      'root.call': () => root.call(() => 1),
      'task.call': () => task(() => 1).call(),
      'root.run': () => root.run(() => 1),
      'root.runSync': () => root.runSync(() => 1),
      'root.all': () => root.all([]),
      'root.race': () => root.race([task(() => 1)]),
    };
    const errors: Record<string, unknown> = {};
    const V = createInjectionKey<object>('V', {
      factory: () => {
        for (const [op, f] of Object.entries(banned)) {
          try {
            f();
            errors[op] = 'no error';
          } catch (e) {
            errors[op] = e;
          }
        }
        return {};
      },
    });
    root.child().get(V);
    for (const op of Object.keys(banned)) expect(errors[op], op).toBeInstanceOf(CreationViolationError);
  });

  it('fork on a live node passed in from outside is allowed and starts in a microtask (DESIGN.md §3.5)', async () => {
    const t = trace();
    const root = createRootContext();
    const V = createInjectionKey<object>('V', {
      factory: () => {
        root.fork(task(async () => void t.push('outside fork ran'), { onFailure: 'link' }));
        t.push('factory returned');
        return {};
      },
    });
    root.get(V);
    expect(t.log).toEqual(['factory returned']);
    await tick();
    expect(t.log).toEqual(['factory returned', 'outside fork ran']);
    await root.close();
  });

  it('inject outside creation throws CreationViolationError; in a forked body inject throws and lookup works', async () => {
    const K = createInjectionKey<string>('K');
    expect(() => inject(K)).toThrow(CreationViolationError);
    let seen: { creation: unknown; injectError: unknown; looked: unknown; isFiber: boolean } | undefined;
    const t = trace();
    class Svc {
      constructor() {
        const n = here();
        n.own(
          n.fork(async () => {
            t.push('body');
            let injectError: unknown;
            try {
              inject(K);
            } catch (e) {
              injectError = e;
            }
            seen = { creation: currentCreation(), injectError, looked: lookup(K), isFiber: here().kind === 'fiber' };
          }),
        );
        t.push('constructor returned');
      }
    }
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    root.get(Svc);
    t.push('get returned');
    await tick();
    expect(t.log).toEqual(['constructor returned', 'get returned', 'body']); // the body did not start before the factory returned
    expect(seen?.creation).toBeUndefined();
    expect(seen?.injectError).toBeInstanceOf(CreationViolationError);
    expect(seen?.looked).toBe('k');
    expect(seen?.isFiber).toBe(true);
    await root.close();
  });

  it('a factory returning undefined throws FactoryReturnedUndefinedError, a CreationViolationError', () => {
    const P = createInjectionKey<string>('P');
    const D = createInjectionKey<string>('D', { factory: () => undefined as unknown as string });
    const root = createRootContext({ providers: [factoryProvider(P, () => undefined as unknown as string)] });
    for (const key of [P, D]) {
      let err: unknown;
      try {
        root.get(key);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(FactoryReturnedUndefinedError);
      expect(err).toBeInstanceOf(CreationViolationError);
      expect(String((err as Error).message)).toBe(`Provider for ${key.name} returned undefined`);
      expect(impl(root).cache.has(key)).toBe(false);
    }
  });

  it('a factory that owns, then throws, releases what it owned, caches nothing and rethrows', () => {
    for (const placement of ['auto-hoisted', 'declared'] as const) {
      const boom = new Error('boom');
      let runs = 0;
      const released: number[] = [];
      const factory = (): object => {
        const n = ++runs;
        own(() => void released.push(n));
        if (n === 1) throw boom;
        return { n };
      };
      const K =
        placement === 'auto-hoisted' ? createInjectionKey<object>('K', { factory }) : createInjectionKey<object>('K');
      const root = createRootContext(placement === 'declared' ? { providers: [factoryProvider(K, factory)] } : {});
      expect(() => root.get(K), placement).toThrow(boom);
      expect(released, placement).toEqual([1]);
      expect(impl(root).cache.has(K), placement).toBe(false);
      expect(impl(root).provided.size, placement).toBe(0);
      expect(root.get(K), placement).toEqual({ n: 2 }); // the next get runs the factory again
      expect(released, placement).toEqual([1]);
    }
  });
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
          n.fork(async () => {
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
        here().fork(async () => {
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
          here().fork(async () => {
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
        n.own(n.fork(async () => void t.push('owned')));
        n.fork(task(async () => void t.push('handled'), { onFailure: () => {} }));
        n.fork(task(async () => void t.push('linked'), { onFailure: 'link' }));
        n.pool({ name: 'p', onFailure: () => {} }).fork(async () => void t.push('pooled'));
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

describe('SelfScope attachment', () => {
  it("a SelfScope value's own() and current() are the outer value's node", async () => {
    let innerNode: Context | undefined;
    let released = false;
    const SELF = createInjectionKey<string>('Self', {
      scope: SelfScope,
      factory: () => {
        innerNode = here();
        own(() => {
          released = true;
        });
        return 'self';
      },
    });
    let outerNode: Context | undefined;
    class Outer {
      ctx = inject(ContextKey);
      self = inject(SELF);
      constructor() {
        outerNode = this.ctx;
      }
    }
    const root = createRootContext();
    const c = root.child();
    c.get(Outer);
    expect(innerNode).toBe(outerNode);
    expect(impl(outerNode!).explicit.size).toBe(1);
    await c.close();
    expect(released).toBe(true);
  });

  it("a SelfScope factory that touches the node first still materialises the outer value's node", async () => {
    for (const touch of ['current()', 'own'] as const) {
      const t = trace();
      let innerNode: NodeImpl | undefined;
      const SELF = createInjectionKey<string>('Self', {
        scope: SelfScope,
        factory: () => {
          if (touch === 'current()') innerNode = here();
          own(t.at('self release')); // with touch 'own', this is the first touch of the shared node
          innerNode ??= impl(here());
          return 'self';
        },
      });
      let outerNode: NodeImpl | undefined;
      class Outer {
        self = inject(SELF); // the inner creation touches the shared node before Outer does
        constructor() {
          outerNode = impl(inject(ContextKey));
          own(t.at('outer release'));
        }
      }
      const root = createRootContext();
      const R = root.child();
      R.get(Outer);
      expect(innerNode, touch).toBe(outerNode);
      expect(outerNode!.name, touch).toBe('Outer'); // named after the outer key, not the SelfScope one
      expect(outerNode!.parent, touch).toBe(impl(R)); // placed with the outer value (a SelfScope dependency pins it at R)
      expect(impl(R).cache.get(Outer)?.valueNode, touch).toBe(outerNode);
      expect(outerNode!.explicit.size, touch).toBe(2);
      await R.close();
      expect(t.log, touch).toEqual(['outer release', 'self release']);
    }
  });

  it('a SelfScope key with neither provider nor default: inject(K, { optional: true }) is undefined, inject(K) is "No provider found"', () => {
    const K = createInjectionKey<string>('K', { scope: SelfScope });
    const V = createInjectionKey<{ k: string | undefined }>('V', { factory: () => ({ k: inject(K, { optional: true }) }) });
    expect(createRootContext().get(V).k).toBeUndefined();
    const W = createInjectionKey<{ k: string }>('W', { factory: () => ({ k: inject(K) }) });
    expect(() => createRootContext().get(W)).toThrow('No provider found for K');
  });
});

describe('placement into a releasing or complete storage context (DESIGN.md §3.3)', () => {
  it('a value created by a release during the provided phase is placed above the cursor and released next, before older provided values', async () => {
    const t = trace();
    const ev = events();
    const app = ev.root;
    let placedOn: string | undefined;
    class Old {
      constructor() {
        own(t.at('old'));
      }
    }
    class Late {
      constructor() {
        own(t.at('late'));
      }
    }
    class Releaser {
      constructor() {
        own(() => {
          lookup(Late); // a release fiber's lookup creates a value on the releasing root
          placedOn = impl(app).cache.get(Late)!.valueNode!.entryOnOwner!.stack.kind;
          t.push('releaser');
        });
      }
    }
    app.get(Old);
    app.get(Releaser);
    await app.close();
    expect(t.log).toEqual(['releaser', 'late', 'old']);
    expect(placedOn).toBe('provided'); // I24: only placement pushes onto provided, and it pushes only there
    const late = ev.of('entry:released').find((e) => e.id === app.id && e.entryName === 'Late');
    expect(late?.stack).toBe('provided');
    expect(ev.of('node:releasing').filter((e) => e.id === app.id).map((e) => e.stack)).toEqual(['provided']);
  });

  it('a value created during the explicit phase is released at the top of the provided phase (I3)', async () => {
    const t = trace();
    const ev = events();
    const app = ev.root;
    let placedOn: string | undefined;
    class Old {
      constructor() {
        own(t.at('old'));
      }
    }
    class Late {
      constructor() {
        own(t.at('late'));
      }
    }
    app.get(Old);
    app.own(() => {
      lookup(Late);
      placedOn = impl(app).cache.get(Late)!.valueNode!.entryOnOwner!.stack.kind;
      t.push('explicit entry');
    });
    await app.close();
    expect(t.log).toEqual(['explicit entry', 'late', 'old']);
    // Late went onto the provided stack, not the explicit one the loop was still releasing (I24), and was
    // released at the top of the provided phase (I3).
    expect(placedOn).toBe('provided');
    const releasing = ev.of('node:releasing').filter((e) => e.id === app.id);
    expect(releasing.map((e) => e.stack)).toEqual(['explicit', 'provided']);
    const late = ev.of('entry:released').find((e) => e.id === app.id && e.entryName === 'Late')!;
    expect(late.stack).toBe('provided');
    expect(late.seq).toBeGreaterThan(releasing[1].seq);
  });

  it('placement into a complete storage context throws NodeCompletedError and caches nothing', () => {
    const D = createInjectionKey<string>('D');
    const root = createRootContext();
    const S = root.child({ providers: [valueProvider(D, 'd')] });
    let released = false;
    class V {
      d = inject(D);
      constructor() {
        own(() => {
          released = true;
        });
        S.abort(); // S completes before V can be placed on it
      }
    }
    expect(() => S.get(V)).toThrow(NodeCompletedError);
    expect(S.state).toBe('complete');
    expect(released).toBe(true); // the pending node was released
    expect(impl(root).cache.has(V)).toBe(false);
    expect(impl(S).cache.size).toBe(0);
  });

  it('the same for a declared placement whose factory completes its storage context', () => {
    const V = createInjectionKey<object>('V');
    const root = createRootContext();
    const S = root.child({
      providers: [
        factoryProvider(V, () => {
          S.abort();
          return {};
        }),
      ],
    });
    expect(() => S.get(V)).toThrow(NodeCompletedError);
    expect(impl(S).cache.size).toBe(0);
  });
});

describe('cycles and skipSelf', () => {
  it('circular dependencies are detected through nested creation frames', () => {
    const KA: ReturnType<typeof createInjectionKey<string>> = createInjectionKey<string>('A', {
      factory: () => inject(KB),
    });
    const KB: ReturnType<typeof createInjectionKey<string>> = createInjectionKey<string>('B', {
      factory: () => inject(KA),
    });
    const root = createRootContext();
    expect(() => root.get(KA)).toThrow('Circular dependency detected: A → B → A');
    expect(impl(root).cache.size).toBe(0);
  });

  it('skipSelf inside creation does not trip the cycle check (decorator pattern), across providers and default factories', () => {
    const Service = createInjectionKey<{ trace(): string }>('Service', { factory: () => ({ trace: () => 'default' }) });
    const root = createRootContext();
    const mid = root.child({
      providers: [
        factoryProvider(Service, () => {
          const parent = inject(Service, { skipSelf: true }); // resolves the default factory above mid
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
    expect(leaf.get(Service).trace()).toBe('leaf(mid(default))');
    expect(root.get(Service).trace()).toBe('default');
  });

  it('K → inject(J, { skipSelf }) → K is a circular dependency: only a skipSelf read of the key itself is exempt', () => {
    const J = createInjectionKey<{ k: unknown }>('J');
    class K {
      j = inject(J, { skipSelf: true }); // J is provided at the root, above the requester's parent
    }
    const root = createRootContext({ providers: [factoryProvider(J, () => ({ k: inject(K) }))] });
    expect(() => root.child().get(K)).toThrow('Circular dependency detected: K → J → K');
    expect(impl(root).cache.has(J)).toBe(false);
    expect(impl(root).cache.has(K)).toBe(false);
    // the same shape without skipSelf
    const J2 = createInjectionKey<{ k: unknown }>('J2');
    class K2 {
      j = inject(J2);
    }
    const root2 = createRootContext({ providers: [factoryProvider(J2, () => ({ k: inject(K2) }))] });
    expect(() => root2.child().get(K2)).toThrow('Circular dependency detected: K2 → J2 → K2');
  });
});

describe('a failed or refused creation is owned by its requester (DESIGN.md §3.3)', () => {
  it("a failed auto-hoisted value's async release holds the requester's completion (DESIGN.md §2.8)", async () => {
    for (const requester of ['the root', 'a child of the root'] as const) {
      const gate = deferred();
      const t = trace();
      const K = createInjectionKey<object>('K', {
        factory: () => {
          inject(ContextKey).own(async () => {
            await gate.promise;
            t.push('released');
          });
          throw new Error('boom');
        },
      });
      const root = createRootContext();
      const R = requester === 'the root' ? root : root.child();
      expect(() => R.get(K), requester).toThrow('boom');
      const closing = R.close();
      await tick(2);
      expect(R.state, requester).toBe('releasing'); // the requester waits for the failed value's release
      expect(t.log, requester).toEqual([]);
      gate.resolve();
      await closing;
      expect(t.log, requester).toEqual(['released']);
      await root.close();
    }
  });

  it("its release failures surface from the requester's completion, as a declared placement's do (DESIGN.md §4.12)", async () => {
    for (const placement of ['auto-hoisted', 'declared'] as const) {
      const factory = (): object => {
        own(() => {
          throw new Error('release-err');
        });
        throw new Error('boom');
      };
      const K =
        placement === 'auto-hoisted' ? createInjectionKey<object>('K', { factory }) : createInjectionKey<object>('K');
      const root = createRootContext(placement === 'declared' ? { providers: [factoryProvider(K, factory)] } : {});
      expect(() => root.get(K), placement).toThrow('boom');
      await expect(root.close(), placement).rejects.toThrow('release-err');
    }
  });

  it('its releases resolve through the requester (DESIGN.md §2.4)', async () => {
    const Db = createInjectionKey<string>('Db');
    let seen: unknown;
    let node: NodeImpl | undefined;
    const K = createInjectionKey<object>('K', {
      factory: () => {
        node = here();
        own(() => {
          try {
            seen = lookup(Db);
          } catch (e) {
            seen = e;
          }
        });
        throw new Error('boom');
      },
    });
    const root = createRootContext({ providers: [valueProvider(Db, 'db@root')] });
    const R = root.child({ providers: [valueProvider(Db, 'db@R')] }); // K does not inject Db: placed, it would be at the root
    expect(() => R.get(K)).toThrow('boom');
    expect(seen).toBe('db@R'); // R's view, not its root's
    expect(node!.parent).toBe(impl(R)); // owned by the requester itself (DESIGN.md §3.3)
    expect(impl(R).provided.size).toBe(0); // released synchronously and gone
    expect(impl(R).cache.has(K)).toBe(false);
    await root.close();
  });

  it('its abort is one delivery: its own signal fires, and every subscriber is marked before any listener runs (I9)', () => {
    let marked: { a: boolean; b: boolean } | undefined;
    let seen: boolean | undefined;
    let node: NodeImpl | undefined;
    const K = createInjectionKey<object>('K', {
      factory: () => {
        node = here();
        const a = node.child();
        const b = node.child();
        // The node's own listener runs first: under one two-pass delivery its subscribers are marked already.
        node.signal.addEventListener('abort', () => {
          marked = { a: impl(a).delivered, b: impl(b).delivered };
        });
        b.signal.addEventListener('abort', () => {
          seen = a.signal.aborted; // not one subscriber at a time, in LIFO order
        });
        throw new Error('boom');
      },
    });
    const root = createRootContext();
    expect(() => root.get(K)).toThrow('boom');
    expect(marked).toEqual({ a: true, b: true });
    expect(seen).toBe(true);
    expect(node!.signal.aborted).toBe(true);
    expect(node!.state).toBe('complete');
    expect(node!.outcome?.status).toBe('aborted'); // the factory's error was rethrown; it is not routed again
  });

  it('with no open node left on the requester path (the factory completed the tree), it is released unowned', () => {
    let released = false;
    const K = createInjectionKey<object>('K', {
      factory: () => {
        own(() => {
          released = true;
        });
        root.abort();
        throw new Error('boom');
      },
    });
    const root = createRootContext();
    expect(() => root.get(K)).toThrow('boom');
    expect(released).toBe(true);
  });

  it('forks made by the releases of a failed value start: a release using all() or fork + join completes, and so does the requester', async () => {
    for (const placement of ['auto-hoisted', 'declared'] as const) {
      for (const shape of ['all', 'fork+join'] as const) {
        const label = `${placement}, ${shape}`;
        let node: NodeImpl | undefined;
        const factory = (): object => {
          node = here();
          own(async () => {
            if (shape === 'all') await here().all([task(async () => 1)]);
            else await here().join(here().fork(async () => 1));
          });
          throw new Error('boom');
        };
        const K =
          placement === 'auto-hoisted' ? createInjectionKey<object>('K', { factory }) : createInjectionKey<object>('K');
        const root = createRootContext(placement === 'declared' ? { providers: [factoryProvider(K, factory)] } : {});
        expect(() => root.get(K), label).toThrow('boom');
        const closing = root.close();
        await tick(3);
        expect(node!.state, label).toBe('complete');
        expect(root.state, label).toBe('complete');
        await closing;
      }
    }
  });

  it('a fork queued during the creation by an early release starts when the creation fails, so that release ends', async () => {
    let node: NodeImpl | undefined;
    let fiberOutcome: string | undefined;
    const K = createInjectionKey<object>('K', {
      factory: () => {
        node = here();
        const x = own({}, async () => {
          const f = here().fork(async () => 1); // queued on the value node until placement (DESIGN.md §4.6)
          fiberOutcome = (await here().result(f)).status;
        });
        void here().release(x); // in flight while the factory throws
        throw new Error('boom');
      },
    });
    const root = createRootContext();
    expect(() => root.get(K)).toThrow('boom');
    await tick(2);
    expect(fiberOutcome).toBe('success'); // the release's own fork runs: the creation is over, not the release
    expect(node!.state).toBe('complete');
    await root.close();
  });

  it('a release of the failed value that resolves its key again is a circular dependency: the factory runs once and the requester completes', async () => {
    for (const placement of ['auto-hoisted', 'declared'] as const) {
      for (const release of ['sync', 'async'] as const) {
        const label = `${placement}, ${release} release`;
        let runs = 0;
        let looked: unknown = 'not run';
        const factory = (): object => {
          runs++;
          if (release === 'sync') own(() => void (looked = lookup(K, { optional: true })));
          else
            own(async () => {
              await tick();
              looked = lookup(K, { optional: true });
            });
          throw new Error('boom');
        };
        const K =
          placement === 'auto-hoisted' ? createInjectionKey<object>('K', { factory }) : createInjectionKey<object>('K');
        const root = createRootContext(placement === 'declared' ? { providers: [factoryProvider(K, factory)] } : {});
        expect(() => root.get(K), label).toThrow('boom');
        // The release fails once, and its failure surfaces from the requester's completion (DESIGN.md §4.12).
        await expect(root.close(), label).rejects.toThrow(/Circular dependency detected: K re-enters the failed creation of K/);
        expect(runs, label).toBe(1);
        expect(looked, label).toBe('not run');
        expect(root.state, label).toBe('complete');
      }
    }
  });

  it('a retry from the requester while the failed value still releases runs the factory again (DESIGN.md §3.3)', async () => {
    const gate = deferred();
    let runs = 0;
    const K = createInjectionKey<{ n: number }>('K', {
      factory: () => {
        const n = ++runs;
        if (n === 1) {
          own(async () => void (await gate.promise));
          throw new Error('boom');
        }
        return { n };
      },
    });
    const root = createRootContext();
    expect(() => root.get(K)).toThrow('boom');
    expect(root.get(K)).toEqual({ n: 2 }); // the first node is still releasing
    gate.resolve();
    await root.close();
  });

  it('a declared value that touches its node before injecting a declared dependency is released before that dependency (G3, DESIGN.md §3.3)', async () => {
    const t = trace();
    const Svc = createInjectionKey<object>('Svc');
    const Db = createInjectionKey<{ closed: boolean }>('Db');
    const root = createRootContext({
      providers: [
        factoryProvider(Svc, () => {
          inject(ContextKey); // the node is live on S from here (DESIGN.md §3.3)
          const db = inject(Db);
          own(() => t.push(`svc release; db closed=${db.closed}`));
          return {};
        }),
        factoryProvider(Db, () => {
          const db = { closed: false };
          own(() => {
            db.closed = true;
            t.push('db release');
          });
          return db;
        }),
      ],
    });
    root.get(Svc);
    expect([...impl(root).provided].map((e) => e.name)).toEqual(['Db', 'Svc']); // creation order, completed
    await root.close();
    expect(t.log).toEqual(['svc release; db closed=false', 'db release']);
  });

  it('a declared factory during which its own node is released fails, caches nothing, and the next get runs it again', async () => {
    for (const how of ['abort', 'close'] as const) {
      let runs = 0;
      let released = 0;
      const K = createInjectionKey<{ n: number }>('K');
      const root = createRootContext({
        providers: [
          factoryProvider(K, () => {
            const n = ++runs;
            own(() => void released++);
            if (n === 1) {
              const ctx = inject(ContextKey);
              if (how === 'abort') ctx.abort();
              else void ctx.close();
            }
            return { n };
          }),
        ],
      });
      expect(() => root.get(K), how).toThrow(NodeCompletedError);
      expect(released, how).toBe(1);
      expect(impl(root).cache.has(K), how).toBe(false);
      expect(root.get(K), how).toEqual({ n: 2 });
      await root.close();
    }
  });
});

describe('a release started during creation cannot re-enter resolution (DESIGN.md §3.3)', () => {
  it("in the value's own release: get / call / run / runSync / all / race throw CreationViolationError; awaits are allowed; the factory runs once", () => {
    let runs = 0;
    const errors: Record<string, unknown> = {};
    const K = createInjectionKey<{ id: number }>('K');
    const root = createRootContext({
      providers: [
        factoryProvider(K, () => {
          const id = ++runs;
          const x = own({}, () => {
            const ops: Record<string, () => unknown> = {
              lookup: () => lookup(K),
              'root.get': () => root.get(K),
              call: () => here().call(() => 1),
              'root.run': () => root.run(() => 1),
              runSync: () => here().runSync(() => 1),
              all: () => here().all([]),
              race: () => here().race([task(() => 1)]),
              managed: () => here().managed(Promise.resolve(1)),
            };
            for (const [op, f] of Object.entries(ops)) {
              try {
                f();
                errors[op] = 'no error';
              } catch (e) {
                errors[op] = e;
              }
            }
          });
          void here().release(x);
          return { id };
        }),
      ],
    });
    expect(root.get(K)).toEqual({ id: 1 });
    expect(runs).toBe(1);
    expect(impl(root).cache.get(K)?.value).toEqual({ id: 1 });
    for (const op of ['lookup', 'root.get', 'call', 'root.run', 'runSync', 'all', 'race'])
      expect(errors[op], op).toBeInstanceOf(CreationViolationError);
    expect(errors.managed).toBe('no error'); // an await enters nothing (DESIGN.md §3.5)
  });

  it('in a release of another node, resolving the key under creation is a circular dependency, and nothing is overwritten (I19)', async () => {
    let runs = 0;
    let caught: unknown;
    const K = createInjectionKey<{ id: number }>('K');
    const root = createRootContext({
      providers: [
        factoryProvider(K, () => {
          const id = ++runs;
          void other.release(x); // the release fiber is under `other`, which is not in creation
          return { id };
        }),
      ],
    });
    const other = root.child();
    const x = other.own({}, () => {
      try {
        lookup(K);
      } catch (e) {
        caught = e;
      }
    });
    expect(root.get(K)).toEqual({ id: 1 });
    expect(runs).toBe(1);
    expect(String(caught)).toMatch(/Circular dependency detected: K/);
    expect(impl(root).cache.get(K)?.value).toEqual({ id: 1 });
    await root.close();
  });

  it('in a release of a node above the requester, it is a circular dependency too: the factory runs once and the root completes (DESIGN.md §3.3)', async () => {
    for (const handled of [true, false]) {
      let runs = 0;
      let caught: unknown;
      const root = createRootContext();
      const req = root.child();
      class V {
        constructor() {
          runs++;
          const d = root.own(() => {
            if (!handled) return void lookup(V);
            try {
              lookup(V);
            } catch (e) {
              caught = e;
            }
          });
          void root.release(d); // the release fiber is under the root, above the requester: no walk from it reaches req
        }
      }
      expect(req.get(V), String(handled)).toBeInstanceOf(V);
      expect(runs, String(handled)).toBe(1);
      if (handled) {
        expect(String(caught)).toMatch(/Circular dependency detected: V re-enters the creation of V in progress/);
        await expect(root.close()).resolves.toBeUndefined();
      } else await expect(root.close()).rejects.toThrow(/Circular dependency detected: V re-enters/); // the early release's failure (D16)
      expect(root.state, String(handled)).toBe('complete');
    }
  });
});

describe('release continuations of a creation run under no frame (DESIGN.md §6)', () => {
  it("a deadline that fires after the creation runs its listeners with no creation and no node current", async () => {
    for (const how of ['release', 'releaseAll'] as const) {
      const Other = createInjectionKey<string>('Other');
      const gate = deferred();
      let seen: { creation: unknown; node: unknown; injectError: unknown } | undefined;
      const K = createInjectionKey<object>(`K-${how}`, {
        factory: () => {
          const slow = own({}, async () => {
            here().signal.addEventListener('abort', () => {
              let injectError: unknown;
              try {
                inject(Other);
              } catch (e) {
                injectError = e;
              }
              seen = { creation: currentCreation(), node: peekCurrentNode(), injectError };
            });
            await gate.promise;
          });
          if (how === 'release') void here().release(slow);
          else {
            own({}, () => {}); // released first; `slow` starts in releaseAll's continuation
            void here().releaseAll();
          }
          return {};
        },
      });
      const root = createRootContext({ releaseTimeoutMs: 10, providers: [valueProvider(Other, 'o')] });
      root.get(K);
      await new Promise((resolve) => setTimeout(resolve, 40));
      gate.resolve();
      expect(seen, how).toBeDefined();
      expect(seen!.creation, how).toBeUndefined();
      expect(seen!.node, how).toBeUndefined();
      expect(seen!.injectError, how).toBeInstanceOf(CreationViolationError);
      await root.close();
    }
  });

  it('a release still running after the creation neither keeps the creation reachable nor emits in its frame', async () => {
    for (const how of ['release', 'releaseAll'] as const) {
      const gate = deferred();
      const heard: { type: string; inCreation: boolean }[] = [];
      let returned = false;
      let ref: WeakRef<object> | undefined;
      const K = createInjectionKey<object>(`K-${how}`, {
        factory: () => {
          ref = new WeakRef(currentCreation()!);
          const slow = own({}, async () => void (await gate.promise));
          if (how === 'release') void here().release(slow);
          else {
            own({}, () => {}); // released first; `slow` starts in releaseAll's continuation
            void here().releaseAll();
          }
          return {};
        },
      });
      const root = createRootContext({
        providers: [
          valueProvider(NodeTopic, (e: NodeEvent) => {
            // After the factory returned: what the release's continuations emit (a release started inside
            // the factory is created in its frame, as it should be).
            if (returned && (e.type === 'entry:released' || (e.type === 'node:created' && e.kind === 'release')))
              heard.push({ type: e.type, inCreation: currentCreation() !== undefined });
          }),
        ],
      });
      root.get(K);
      returned = true;
      await tick();
      // The continuations the release registered (its completion, releaseAll's loop) run under no frame, so
      // nothing retains the finished creation while the release still runs (DESIGN.md §6).
      await gcUntil(() => ref!.deref() === undefined);
      gate.resolve();
      await root.close();
      expect(heard.filter((h) => h.type === 'entry:released').length, how).toBeGreaterThan(0);
      expect(heard.filter((h) => h.inCreation), how).toEqual([]);
    }
  });
});

describe('a creation ends when its factory returns (DESIGN.md §3.5)', () => {
  it('a callback the factory scheduled runs with no frame: own, fork and inject fail loudly instead of reaching an unplaced node', async () => {
    for (const touched of [false, true]) {
      const Other = createInjectionKey<string>('Other');
      const errors: Record<string, unknown> = {};
      let seen: { creation: unknown; node: unknown } | undefined;
      let released = false;
      let forkRan = false;
      let node: NodeImpl | undefined;
      class V {
        constructor() {
          if (touched) node = impl(inject(ContextKey)); // the node exists before the callback runs
          const later = (): void => {
            seen = { creation: currentCreation(), node: peekCurrentNode() };
            const ops: Record<string, () => unknown> = {
              own: () => own(() => void (released = true)),
              fork: () => fork(task(async () => void (forkRan = true), { onFailure: () => {} })),
              inject: () => inject(Other),
              lookup: () => lookup(Other),
            };
            for (const [op, f] of Object.entries(ops)) {
              try {
                f();
                errors[op] = 'no error';
              } catch (e) {
                errors[op] = e;
              }
            }
          };
          queueMicrotask(later);
        }
      }
      const root = createRootContext({ providers: [valueProvider(Other, 'o')] });
      root.get(V);
      await tick();
      const label = touched ? 'node materialised' : 'no node yet';
      expect(seen, label).toEqual({ creation: undefined, node: undefined });
      expect(errors.own, label).toBeInstanceOf(NoCurrentNodeError);
      expect(errors.fork, label).toBeInstanceOf(NoCurrentNodeError);
      expect(errors.inject, label).toBeInstanceOf(CreationViolationError); // I16: inject never works at runtime
      expect(String(errors.inject), label).toMatch(/inject\(\) outside creation/);
      expect(errors.lookup, label).toBeInstanceOf(NoCurrentNodeError);
      if (touched) expect(node!.explicit.size, label).toBe(0);
      await root.close();
      expect(released, label).toBe(false);
      expect(forkRan, label).toBe(false);
    }
  });

  it('a promise continuation and a timer the factory registered see no creation either', async () => {
    const seen: unknown[] = [];
    class V {
      constructor() {
        void Promise.resolve().then(() => seen.push(currentCreation()));
        setTimeout(() => seen.push(currentCreation()), 0);
        seen.push(currentCreation() !== undefined); // during the factory: the creation
      }
    }
    const root = createRootContext();
    root.get(V);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual([true, undefined, undefined]);
    await root.close();
  });
});

describe('a scoped provider built under a pending node is checked when the node is placed (DESIGN.md §3.4)', () => {
  const shapes: Record<string, (p: Provider<unknown>) => void> = {
    'child({ providers })': (p) => void child({ providers: [p] }),
    'child().addProvider': (p) => child().addProvider(p),
    'a grandchild': (p) => void child().child({ providers: [p] }),
    'fork(task(…, { providers }))': (p) => void fork(task(async () => {}, { providers: [p], onFailure: () => {} })),
    'pool({ providers })': (p) => void pool({ name: 'p', providers: [p], onFailure: () => {} }),
  };

  it('below the scope owner it is a PlacementError, nothing is cached, and the owner keeps its own answer (DESIGN.md §3.4, I19)', async () => {
    for (const [shape, build] of Object.entries(shapes)) {
      const K = createInjectionKey<string>('K');
      class V {
        constructor() {
          build(valueProvider(K, 'leaked', { scope: RootScope }) as Provider<unknown>);
        }
      }
      const root = createRootContext({ providers: [valueProvider(K, 'root', { scope: RootScope })] });
      expect(() => root.get(V), shape).toThrow(PlacementError);
      expect(() => root.get(V), shape).toThrow(/Cannot provide scoped key 'K' .* resolves to .* above this context/);
      expect(impl(root).cache.has(V), shape).toBe(false);
      expect(impl(root).provided.size, shape).toBe(0); // the refused node was aborted at its requester (DESIGN.md §3.3)
      expect(root.get(K), shape).toBe('root');
      await root.close();
    }
  });

  it('the same for a key-level scope, and as on a live node: allowed at its own owner, and where no owner exists', async () => {
    const σ = createScope('app');
    const K = createInjectionKey<string>('K', { scope: σ });
    class Bad {
      constructor() {
        child({ providers: [factoryProvider(K, () => 'x')] });
      }
    }
    const root = createRootContext({ scopes: [σ] });
    expect(() => root.get(Bad)).toThrow(PlacementError);
    expect(() => root.get(K)).toThrow('No provider found for key: K'); // the root's answer is not the child's value
    // A control: on a live node the same provider is refused at construction.
    expect(() => root.child().child({ providers: [factoryProvider(K, () => 'x')] })).toThrow(PlacementError);
    // Allowed: at its own owner under the pending node, and for a scope nothing owns.
    const τ = createScope('nowhere');
    const L = createInjectionKey<string>('L', { scope: τ });
    let c: Context | undefined;
    class Good {
      constructor() {
        c = child({ scopes: [σ], providers: [factoryProvider(K, () => 'own owner')] });
        child({ providers: [factoryProvider(L, () => 'unowned')] });
      }
    }
    expect(root.get(Good)).toBeInstanceOf(Good);
    expect(c!.get(K)).toBe('own owner');
    expect(impl(c!).cache.get(K)?.scope).toBe(σ);
    await root.close();
  });

  it('a failed creation drops such a provider before its releases run, so they resolve the owner’s answer', async () => {
    const K = createInjectionKey<string>('K');
    let seen: unknown;
    class V {
      constructor() {
        const c = child({ providers: [valueProvider(K, 'leaked', { scope: RootScope })] });
        c.own(() => void (seen = lookup(K)));
        throw new Error('boom');
      }
    }
    const root = createRootContext({ providers: [valueProvider(K, 'root', { scope: RootScope })] });
    expect(() => root.get(V)).toThrow('boom');
    expect(seen).toBe('root');
    expect(root.get(K)).toBe('root');
    await root.close();
  });
});
