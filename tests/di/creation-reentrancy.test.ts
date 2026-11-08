// Tests for di / creation reentrancy.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey } from '../../src/context-key.js';
import { currentCreation, peekCurrentNode } from '../../src/context-storage.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { ContextKey, inject } from '../../src/inject.js';
import { NodeTopic } from '../../src/lifecycle-events.js';
import type { NodeEvent } from '../../src/lifecycle-events.js';
import type { NodeImpl } from '../../src/node-impl.js';
import { factoryProvider, valueProvider } from '../../src/provider-util.js';
import { CreationViolationError, NoCurrentNodeError } from '../../src/resource.js';
import { fork, lookup, own } from '../../src/ambient.js';
import { deferred, gcUntil, here, impl, tick } from '../support/util.js';

afterEach(() => {
  vi.restoreAllMocks();
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
              managed: () => here().wait(Promise.resolve(1), { abandon: true }),
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
              fork: () => fork(task(function* () { return void (forkRan = true); }, { onFailure: () => {} })),
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
