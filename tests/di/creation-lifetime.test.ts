// Tests for di / creation lifetime.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey } from '../../src/context-key.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { ContextKey, inject } from '../../src/inject.js';
import type { NodeImpl } from '../../src/node-impl.js';
import { factoryProvider, valueProvider } from '../../src/provider-util.js';
import { NodeCompletedError } from '../../src/resource.js';
import { lookup, own, wait } from '../../src/ambient.js';
import { deferred, events, here, impl, tick, trace } from '../support/util.js';

afterEach(() => {
  vi.restoreAllMocks();
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
          own(function* () {
            if (shape === 'all') yield* here().all([task(function* () { return 1; })]);
            else yield* here().join(here().fork(function* () { return 1; }));
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
        const x = own({}, function* () {
          const f = here().fork(function* () { return 1; }); // queued on the value node until placement (DESIGN.md §4.6)
          fiberOutcome = (yield* here().result(f)).status;
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
            own(function* () {
              yield* wait(tick());
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
