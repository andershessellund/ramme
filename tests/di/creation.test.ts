// Tests for di / creation.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey } from '../../src/context-key.js';
import type { Context } from '../../src/context.js';
import { currentCreation, peekCurrentNode } from '../../src/context-storage.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { ContextKey, inject } from '../../src/inject.js';
import type { NodeImpl } from '../../src/node-impl.js';
import { factoryProvider, valueProvider } from '../../src/provider-util.js';
import { CreationViolationError, FactoryReturnedUndefinedError, PendingNodeError } from '../../src/resource.js';
import { SelfScope } from '../../src/scope.js';
import { child, fork, lookup, own, pool } from '../../src/ambient.js';
import { events, here, impl, tick, trace } from '../support/util.js';

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
      fork: () => void fork(task(function* () {}, { onFailure: () => {} })),
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
          seen = { state: n!.state, parent: n!.up, sameRoot: n!.root === impl(requester).root }; // the internal field: `parent` refuses a pending node (D33)
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
        const f = n.own(n.fork(task(function* () {}, { name: 'reaper' })));
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
    const f = root.fork(task(function* () { return 1; }, { onFailure: () => {} })); // a live fiber the pending node may not await (DESIGN.md §3.3)
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
      managed: (n) => n.wait(Promise.resolve(1), { abandon: true }),
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
      't()': () => task(() => 1)(), // a task's call (D44)
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
        root.fork(task(function* () { return void t.push('outside fork ran'); }, { onFailure: 'link' }));
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

  it('then of a work op made outside and handed in refuses to run it inside a factory: CreationViolationError, no body entered and no wait function called (I16); the op stays unrun, so a then after the creation runs it, and an op already running is only awaited there', async () => {
    const t = trace();
    const root = createRootContext();
    const op = root.call(
      task(function* () {
        t.push('call body ran');
        return 'called';
      }),
    );
    const fnOp = root.wait(() => {
      t.push('wait fn called');
      return Promise.resolve('waited');
    });
    const running = root.call(
      task(function* () {
        t.push('running body ran');
        return 'ran';
      }),
    );
    const before = running.then((v) => v); // runs it now, before the creation
    const inFactory: Record<string, unknown> = {};
    const record = (name: string) => [(v: unknown) => void (inFactory[name] = v), (e: unknown) => void (inFactory[name] = e)] as const;
    const V = createInjectionKey<object>('V', {
      factory: () => {
        t.push('factory starts');
        void op.then(...record('call'));
        void fnOp.then(...record('wait'));
        void running.then(...record('running'));
        t.push('factory ends');
        return {};
      },
    });
    root.get(V);
    await tick();
    const after = { call: await op, wait: await fnOp, running: await before };
    expect({
      log: t.log,
      call: inFactory.call instanceof CreationViolationError,
      wait: inFactory.wait instanceof CreationViolationError,
      running: inFactory.running,
      after,
    }).toEqual({
      log: ['running body ran', 'factory starts', 'factory ends', 'call body ran', 'wait fn called'],
      call: true,
      wait: true,
      running: 'ran',
      after: { call: 'called', wait: 'waited', running: 'ran' },
    });
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
          n.fork(function* () {
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
