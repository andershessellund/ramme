// ambient.test.ts — the free functions of ambient.ts (law 2, I21). Each is
// `current().<method>(...)` (DESIGN.md §6); `current()` and
// `signal()` read the current node in a fork, a call, a `run` frame, a
// release, a creation and a failure handler; with storage registered and no
// current node every one throws NoCurrentNodeError (the no-storage message
// is tested in storage.test.ts, the one test file that imports no
// context-storage adapter); `runSync`; `lookup` options; `own` (D16);
// the creation-frame split of ambient.ts (I16; DESIGN.md §3.5); and the
// `Context.run` suite ported from the pre-redesign push-context.test.ts.
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  all,
  attempt,
  call,
  child,
  current,
  fork,
  interrupted,
  join,
  lookup,
  never,
  own,
  pool,
  race,
  release,
  releaseAll,
  result,
  runSync,
  settle,
  signal,
  wait,
} from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber, Op, Pool } from './context.js';
import { peekCurrentNode } from './context-storage.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { ContextKey, inject } from './inject.js';
import { NodeImpl } from './node-impl.js';
import { valueProvider } from './provider-util.js';
import {
  AlreadyOwnedError,
  AsyncRunError,
  CreationViolationError,
  NoCurrentNodeError,
  NotOwnedError,
} from './resource.js';
import { deferred, impl, tick, trace } from './test/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const link = { onFailure: 'link' } as const;

/** Resolves after `ms`, or as soon as `s` aborts (the timer is cleared then). */
function sleep(ms: number, s?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    s?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

interface Via {
  /** `this` of the first call of the prototype method. */
  readonly self: unknown;
  /** Its arguments. */
  readonly args: unknown[] | undefined;
  /** What the method returned. */
  readonly returned: unknown;
  /** What the free function returned. */
  readonly ret: unknown;
  /** How many times the method ran. */
  readonly calls: number;
}

/**
 * Run `run` with `NodeImpl.prototype[method]` spied on, and report its first call. Vitest's spy
 * attaches `then` to a returned `Promise` (for `mock.settledResults`): a lifecycle op, whose `then` is
 * one more consumer of work already started; a work op is no `Promise`, so the spy never runs it.
 */
function viaPrototype(method: keyof NodeImpl, run: () => unknown): Via {
  const spy = vi.spyOn(NodeImpl.prototype as any, method as string);
  try {
    const ret = run();
    return {
      self: spy.mock.contexts[0],
      args: spy.mock.calls[0],
      returned: spy.mock.results[0]?.value,
      ret,
      calls: spy.mock.calls.length,
    };
  } finally {
    spy.mockRestore();
  }
}

describe('each free function is current().<method>(...) (law 2, I21)', () => {
  it('own, release, releaseAll, fork, call, all, race, pool, child, join, result, interrupted, never, wait, runSync and lookup call the method on the current node with the same arguments and return its result', async () => {
    const K = createInjectionKey<string>('K');
    const root = createRootContext();
    const echo = task(function* (n: number) { return n; }, { name: 'echo' });
    const onFailure = (): void => {};
    const checked: string[] = [];
    await root.call(
      task(
        function* () {
          const N = current();
          const expectVia = (r: Via, args: unknown[], label: string): void => {
            expect(r.self, label).toBe(N);
            expect(r.args, label).toEqual(args);
            expect(r.ret, label).toBe(r.returned);
            checked.push(label);
          };

          const x = { [Symbol.dispose]: () => {} };
          expectVia(viaPrototype('own', () => own(x)), [x], 'own');
          const relX = viaPrototype('release', () => release(x));
          expectVia(relX, [x], 'release');
          yield* (relX.ret as Op<void>);
          own(() => {});
          const relAll = viaPrototype('releaseAll', () => releaseAll());
          expectVia(relAll, [], 'releaseAll');
          yield* (relAll.ret as Op<void>);
          expect(impl(N).explicit.size).toBe(0);

          const forked = viaPrototype('fork', () => fork(echo, 1));
          expectVia(forked, [echo, 1], 'fork');
          const f = forked.ret as Fiber<number>;
          expect(impl(f).parent).toBe(N);

          const joined = viaPrototype('join', () => join(f));
          expectVia(joined, [f], 'join');
          expect(yield* (joined.ret as Op<number>)).toBe(1);
          const resulted = viaPrototype('result', () => result(f));
          expectVia(resulted, [f], 'result');
          expect(yield* (resulted.ret as Op<unknown>)).toEqual({ status: 'success', value: 1 });

          const called = viaPrototype('call', () => call(echo, 2));
          expectVia(called, [echo, 2], 'call');
          expect(yield* (called.ret as Op<number>)).toBe(2);

          const members = [echo.bind(3)];
          const alled = viaPrototype('all', () => all(members, { name: 'g' }));
          expectVia(alled, [members, { name: 'g' }], 'all');
          expect(yield* (alled.ret as Op<number[]>)).toEqual([3]);
          const raced = viaPrototype('race', () => race(members));
          expectVia(raced, [members, undefined], 'race');
          expect(yield* (raced.ret as Op<number>)).toBe(3);

          const pooled = viaPrototype('pool', () => pool({ name: 'p', onFailure }));
          expectVia(pooled, [{ name: 'p', onFailure }], 'pool');
          expect(impl(pooled.ret as Pool).parent).toBe(N);
          const childed = viaPrototype('child', () => child({ name: 'c' }));
          expectVia(childed, [{ name: 'c' }], 'child');
          expect(impl(childed.ret as Context).parent).toBe(N);

          expectVia(viaPrototype('interrupted', () => interrupted()), [], 'interrupted'); // dropped unconsumed: runs nothing
          expectVia(viaPrototype('never', () => never()), [], 'never');
          const p = Promise.resolve(5);
          const opts = { abandon: true };
          const waited = viaPrototype('wait', () => wait(p, opts));
          expectVia(waited, [p, opts], 'wait');
          expect(yield* (waited.ret as Op<number>)).toBe(5);

          const add = (a: number, b: number): number => a + b;
          const synced = viaPrototype('runSync', () => runSync(add, 4, 5));
          expectVia(synced, [add, 4, 5], 'runSync');
          expect(synced.ret).toBe(9);

          const looked = viaPrototype('get', () => lookup(K, { optional: true }));
          expectVia(looked, [K, { optional: true }], 'lookup');
          expect(viaPrototype('get', () => lookup(K)).args).toEqual([K, undefined]);

          // current() and signal() read the node itself.
          expect(signal()).toBe(N.signal);
        },
        { providers: [valueProvider(K, 'k')] },
      ),
    );
    expect(checked).toHaveLength(16);
    await root.close();
  });

  it('they act on whichever node is current: a forked fiber, a call child, a run frame, a release fiber', async () => {
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'root k')] });
    type Probe = { node: Context; sig: boolean; owned: boolean; childParent: boolean; looked: string };
    const probe = (): Probe => {
      const node = current();
      const x = own({ [Symbol.dispose]: () => {} });
      const c = child();
      return {
        node,
        sig: signal() === node.signal,
        owned: impl(node).explicit.find(x) !== undefined,
        childParent: impl(c).parent === node,
        looked: lookup(K),
      };
    };
    const seen: Record<string, Probe> = {};
    let caller: Context | undefined;
    await root.call(function* () {
      caller = current();
      const f = fork(function* () {
        seen.fork = probe();
      });
      yield* join(f);
      yield* call(function* () {
        seen.call = probe();
      });
      const ctx = child({ name: 'ctx' });
      ctx.run(() => {
        seen.run = probe();
      });
      expect(current()).toBe(caller); // run restored the frame
      own(() => {
        seen.release = probe();
      });
    });
    expect(Object.keys(seen)).toEqual(['fork', 'call', 'run', 'release']);
    for (const [where, p] of Object.entries(seen)) {
      expect(p.sig, where).toBe(true);
      expect(p.owned, where).toBe(true);
      expect(p.childParent, where).toBe(true);
      expect(p.looked, where).toBe('root k');
    }
    expect(impl(seen.fork.node).kind).toBe('fiber');
    expect(impl(seen.call.node).kind).toBe('fiber');
    expect(impl(seen.fork.node).parent).toBe(caller);
    expect(impl(seen.call.node).parent).toBe(caller);
    expect(seen.run.node.name).toBe('ctx');
    expect(impl(seen.release.node).kind).toBe('release');
    expect(impl(seen.release.node).parent).toBe(caller);
    await root.close();
  });
});

describe('current() and signal() (DESIGN.md §2.4, §4.7, §6)', () => {
  it('inside a release, current() is the release fiber: its parent is the owner, signal() is its own deadline, and the owner outcome is readable', async () => {
    const root = createRootContext();
    const seen: Record<string, { kind: string; parentIsOwner: boolean; freshSignal: boolean; ownerOutcome: unknown }> = {};
    let owner: Context | undefined;
    const record = (label: string): void => {
      const rf = impl(current());
      seen[label] = {
        kind: rf.kind,
        parentIsOwner: rf.parent === owner,
        freshSignal: signal() === rf.signal && signal() !== owner!.signal,
        ownerOutcome: owner!.outcome?.status,
      };
    };
    await root.call(function* () {
      owner = current();
      own({ [Symbol.asyncDispose]: async () => record('asyncDispose') });
      own({ v: 1 }, () => record('value, release'));
      own(() => record('defer'));
      return 'ok';
    });
    expect(Object.keys(seen)).toEqual(['defer', 'value, release', 'asyncDispose']); // LIFO
    for (const [label, s] of Object.entries(seen))
      expect(s, label).toEqual({ kind: 'release', parentIsOwner: true, freshSignal: true, ownerOutcome: 'success' });
    await root.close();
  });

  it("a release's signal() is its deadline: it fires after releaseTimeoutMs with a TimeoutError", async () => {
    const root = createRootContext();
    let reason: unknown;
    await root.call(
      task(
        function* () {
          own(function* () {
            const s = signal();
            yield* wait(sleep(1000, s));
            reason = s.reason;
          });
        },
        { releaseTimeoutMs: 5 },
      ),
    );
    expect((reason as DOMException).name).toBe('TimeoutError');
    await root.close();
  });

  it('in a creation frame current() is the value node, created on demand, and the same node inject(ContextKey) gives', () => {
    const root = createRootContext();
    let seen: { before: unknown; node: Context; viaKey: Context; sig: AbortSignal; state: string } | undefined;
    class Svc {
      constructor() {
        const before = peekCurrentNode();
        const node = current();
        seen = { before, node, viaKey: inject(ContextKey), sig: signal(), state: node.state };
      }
    }
    root.get(Svc);
    expect(seen?.before).toBeUndefined(); // nothing existed until current() asked for it
    expect(impl(seen!.node).kind).toBe('value');
    expect(seen?.viaKey).toBe(seen?.node);
    expect(seen?.sig).toBe(seen?.node.signal);
    expect(seen?.state).toBe('pending');
    expect(impl(seen!.node).parent).toBe(root); // placed after the constructor returned
  });

  it('in a failure handler current() is the parent', async () => {
    const root = createRootContext();
    let inHandler: Context | undefined;
    root.fork(
      task(
        function* () {
          throw new Error('x');
        },
        {
          onFailure: () => {
            inHandler = current();
          },
        },
      ),
    );
    await root.close();
    expect(inHandler).toBe(root);
  });
});

describe('NoCurrentNodeError with storage registered (DESIGN.md §6)', () => {
  const freeFunctions: Record<string, () => unknown> = {
    current: () => current(),
    signal: () => signal(),
    lookup: () => lookup(createInjectionKey<string>('K')),
    'lookup(ContextKey)': () => lookup(ContextKey), // NoCurrentNodeError first; with a node it is a CreationViolationError (DESIGN.md §4.12)
    own: () => own(() => {}),
    release: () => release({}),
    releaseAll: () => releaseAll(),
    fork: () => fork(function* () { return 1; }),
    call: () => call(function* () { return 1; }),
    all: () => all([]),
    race: () => race([task(function* () { return 1; })]),
    pool: () => pool({ name: 'p', onFailure: () => {} }),
    child: () => child(),
    join: () => join({} as Fiber<unknown>),
    result: () => result({} as Fiber<unknown>),
    interrupted: () => interrupted(),
    never: () => never(),
    wait: () => wait(Promise.resolve(1), { abandon: true }),
    runSync: () => runSync(() => 1),
    'task.fork': () => task(function* () { return 1; }).fork(),
    'task.call': () => task(function* () { return 1; }).call(),
  };

  it('every free function throws synchronously at top level, naming the operation and not the adapter import', () => {
    for (const [op, fn] of Object.entries(freeFunctions)) {
      let err: unknown;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      expect(err, op).toBeInstanceOf(NoCurrentNodeError);
      const name = op.startsWith('task.') ? op.slice(5) : op.replace('(ContextKey)', '');
      expect((err as Error).message, op).toContain(`${name}() called with no current node`);
      expect((err as Error).message, op).not.toContain("import 'ramme/node'");
    }
  });

  it('a platform callback (a timer scheduled from top level) has no current node either', async () => {
    const seen = deferred<unknown>();
    setTimeout(() => {
      try {
        current();
        seen.resolve('no error');
      } catch (e) {
        seen.resolve(e);
      }
    }, 1);
    expect(await seen.promise).toBeInstanceOf(NoCurrentNodeError);
  });

  it('nothing is current after ctx.run(fn) returns or throws, and the run frame does not survive an await', async () => {
    const root = createRootContext();
    expect(root.run(() => current())).toBe(root);
    expect(() => current()).toThrow(NoCurrentNodeError);
    expect(() =>
      root.run(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(() => current()).toThrow(NoCurrentNodeError);
    await tick();
    expect(() => current()).toThrow(NoCurrentNodeError);
    await root.close();
  });
});

describe('runSync (DESIGN.md §4.11)', () => {
  it('runs fn in a fresh child of the current node and releases it before returning', async () => {
    const t = trace();
    const root = createRootContext();
    await root.call(function* () {
      const me = current();
      const before = impl(me).explicit.size;
      let inner: Context | undefined;
      const r = runSync(
        (a: number, b: number) => {
          inner = current();
          own(() => t.push('released'));
          return a + b;
        },
        1,
        2,
      );
      expectTypeOf(r).toEqualTypeOf<number>();
      expect(r).toBe(3);
      expect(t.log).toEqual(['released']); // synchronously, before runSync returned (DESIGN.md §2.4)
      expect(inner?.name).toBe('runSync');
      expect(impl(inner!).parent).toBe(me);
      expect(inner?.state).toBe('complete');
      expect(impl(me).explicit.size).toBe(before);
      expect(current()).toBe(me);
    });
    await root.close();
  });

  it('a throwing fn still releases the child, and the error propagates', async () => {
    const t = trace();
    const root = createRootContext();
    await root.call(function* () {
      expect(() =>
        runSync(() => {
          own(() => t.push('released'));
          throw new Error('sync boom');
        }),
      ).toThrow('sync boom');
      expect(t.log).toEqual(['released']);
    });
    await root.close();
  });

  it('works from a run frame and nests', () => {
    const root = createRootContext();
    const names = root.run(() =>
      runSync(() => {
        const outer = current();
        return runSync(() => [current().name, impl(current()).parent === outer, impl(outer).parent === root]);
      }),
    );
    expect(names).toEqual(['runSync', true, true]);
  });
});

describe('lookup (DESIGN.md §3.2): optional and skipSelf pass through', () => {
  it('resolves from the current node; a miss throws unless optional; the overloads type the result', async () => {
    const K = createInjectionKey<string>('K');
    const M = createInjectionKey<string>('M');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    await root.call(function* () {
      const k = lookup(K);
      expectTypeOf(k).toEqualTypeOf<string>();
      expect(k).toBe('k');
      expect(() => lookup(M)).toThrow('No provider found for key: M');
      const maybe = lookup(M, { optional: true });
      expectTypeOf(maybe).toEqualTypeOf<string | undefined>();
      expect(maybe).toBeUndefined();
      expectTypeOf(lookup(K, { skipSelf: true })).toEqualTypeOf<string>();
    });
    await root.close();
  });

  it('skipSelf resolves from the parent, with optional and with no parent at all', async () => {
    const K = createInjectionKey<string>('K');
    const M = createInjectionKey<string>('M');
    const root = createRootContext({ providers: [valueProvider(K, 'outer')] });
    await root.call(
      task(
        function* () {
          expect(lookup(K)).toBe('inner');
          expect(lookup(K, { skipSelf: true })).toBe('outer');
          expect(lookup(M, { skipSelf: true, optional: true })).toBeUndefined();
          expect(() => lookup(M, { skipSelf: true })).toThrow('No provider found for key: M');
        },
        { providers: [valueProvider(K, 'inner')] },
      ),
    );
    root.run(() => {
      expect(() => lookup(K, { skipSelf: true })).toThrow("Cannot skipSelf for key 'K': no parent context exists.");
      expect(lookup(K, { skipSelf: true, optional: true })).toBeUndefined();
    });
    await root.close();
  });

  it('lookup(ContextKey) with a current node is a CreationViolationError pointing at current()', async () => {
    const root = createRootContext();
    await root.call(function* () {
      expect(() => lookup(ContextKey)).toThrow(CreationViolationError);
      expect(() => lookup(ContextKey)).toThrow(/use current\(\)/);
    });
    await root.close();
  });
});

describe('own (DESIGN.md §2.6, D16) and release', () => {
  it('own(x) twice with one argument returns x both times and registers one entry; own(x, release) on an owned x is AlreadyOwnedError', async () => {
    const dispose = vi.fn();
    const root = createRootContext();
    await root.call(function* () {
      const x = { [Symbol.dispose]: dispose };
      expect(own(x)).toBe(x);
      expect(own(x)).toBe(x);
      expect(impl(current()).explicit.size).toBe(1);
      expect(() => own(x, () => {})).toThrow(AlreadyOwnedError);
      expect(impl(current()).explicit.size).toBe(1);
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    await root.close();
  });

  it('the three overloads attach a resource, a value with its release, and a defer; each is released LIFO when the node completes', async () => {
    const t = trace();
    const root = createRootContext();
    let released: unknown;
    await root.call(function* () {
      const r = own({ [Symbol.asyncDispose]: async () => t.push('async resource') });
      const v = own({ id: 7 }, (value) => {
        released = value;
        t.push('value');
      });
      const d = own(() => t.push('defer'));
      expectTypeOf(v).toEqualTypeOf<{ id: number }>();
      expect(typeof d).toBe('function');
      expect(r[Symbol.asyncDispose]).toBeTypeOf('function');
    });
    expect(t.log).toEqual(['defer', 'value', 'async resource']);
    expect(released).toEqual({ id: 7 });
    await root.close();
  });

  it('own(fork(t)) unsubscribes the fiber; a node this node does not hold is NotOwnedError; non-objects and objects without a protocol are TypeErrors', async () => {
    const root = createRootContext();
    await root.call(function* () {
      const me = impl(current());
      const f = own(fork(function* () { return 1; }));
      expect(impl(f).subscribed).toBe(false);
      expect(me.subscribers.has(impl(f))).toBe(false);
      expect(me.explicit.find(f)).toBeDefined(); // its entry stays where it is
      const foreign = root.child();
      expect(() => own(foreign)).toThrow(NotOwnedError);
      expect(() => own(42 as unknown as object, () => {})).toThrow(TypeError);
      expect(() => own({} as Disposable)).toThrow(TypeError);
      foreign.abort();
      expect(yield* join(f)).toBe(1);
    });
    await root.close();
  });

  it('release(x) runs that release now and once; releaseAll() releases the rest top-down; releasing what is not owned is NotOwnedError', async () => {
    const t = trace();
    const root = createRootContext();
    await root.call(function* () {
      const a = own(t.at('a'));
      own(t.at('b'));
      const c = own(t.at('c'));
      yield* release(a);
      expect(t.log).toEqual(['a']);
      expect(() => release(a)).toThrow(NotOwnedError);
      yield* releaseAll();
      expect(t.log).toEqual(['a', 'c', 'b']);
      expect(() => release(c)).toThrow(NotOwnedError);
      expect(impl(current()).explicit.size).toBe(0);
    });
    await root.close();
  });
});

describe('in a creation frame (DESIGN.md §3.2, §3.3, §3.5, I16)', () => {
  it('the body-shaped free functions throw CreationViolationError before touching any node: no value node is created', async () => {
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    const f = root.fork(task(() => 1, link));
    await tick();
    const errors: Record<string, unknown> = {};
    let peeked: unknown = 'unset';
    const V = createInjectionKey<{ made: string }>('V', {
      factory: () => {
        const refused: Record<string, () => unknown> = {
          lookup: () => lookup(K),
          call: () => call(() => 1),
          'task.call': () => task(() => 1).call(),
          attempt: () => attempt(() => 1),
          'task.attempt': () => task(() => 1).attempt(),
          all: () => all([]),
          race: () => race([task(() => 1)]),
          settle: () => settle([]),
          join: () => join(f),
          result: () => result(f),
          interrupted: () => interrupted(),
          never: () => never(),
          wait: () => wait(Promise.resolve(1), { abandon: true }),
          runSync: () => runSync(() => 1),
        };
        for (const [op, fn] of Object.entries(refused)) {
          try {
            fn();
            errors[op] = 'no error';
          } catch (e) {
            errors[op] = e;
          }
        }
        peeked = peekCurrentNode();
        return { made: 'v' };
      },
    });
    expect(root.get(V)).toEqual({ made: 'v' });
    expect(Object.keys(errors)).toHaveLength(14);
    for (const [op, e] of Object.entries(errors)) {
      expect(e, op).toBeInstanceOf(CreationViolationError);
      const name = op.replace(/^task\./, '');
      expect((e as Error).message, op).toBe(name === 'lookup' ? 'lookup() during creation; use inject()' : `${name}() during creation`);
    }
    expect(peeked).toBeUndefined();
    expect(impl(root).cache.get(V)?.valueNode).toBeUndefined(); // the value attached nothing, so it has no node
    await root.close();
  });

  it("own, release, releaseAll, fork, pool, child, current and signal materialise the value's node and act on it", async () => {
    const t = trace();
    let inCtor: { state: string; viaKey: boolean } | undefined;
    let reaperParent: unknown;
    class Svc {
      readonly node = current();
      readonly sig = signal();
      readonly reaper: Fiber<void>;
      readonly pool: Pool;
      readonly child: Context;
      constructor() {
        own(t.at('early'));
        void releaseAll(); // its first (here: only) release runs before it returns; the promise is safe to drop (D13′)
        const x = own(t.at('x'));
        void release(x); // runs now
        own({ [Symbol.dispose]: t.at('kept') });
        this.reaper = own(
          fork(function* () {
            reaperParent = impl(current()).parent;
            yield* never();
          }),
        );
        this.pool = pool({ name: 'p', onFailure: () => {} });
        this.child = child({ name: 'c' });
        inCtor = { state: this.node.state, viaKey: inject(ContextKey) === this.node };
      }
    }
    const root = createRootContext();
    const svc = root.get(Svc);
    expect(inCtor).toEqual({ state: 'pending', viaKey: true });
    expect(t.log).toEqual(['early', 'x']);
    const n = impl(svc.node);
    expect(n.kind).toBe('value');
    expect(n.parent).toBe(root); // only ContextKey was read: placed at the auto-scope root
    expect(n.entryOnOwner?.stack.kind).toBe('provided');
    expect(svc.sig).toBe(n.signal);
    expect(n.explicit.size).toBe(4); // kept, reaper, pool, child
    expect(impl(svc.reaper).parent).toBe(n);
    expect(impl(svc.reaper).subscribed).toBe(false);
    expect(impl(svc.pool).parent).toBe(n);
    expect(impl(svc.child).parent).toBe(n);
    expect(reaperParent).toBeUndefined(); // started only after placement, in a microtask (I20)
    await tick();
    expect(reaperParent).toBe(n);
    await root.close();
    expect(t.log).toEqual(['early', 'x', 'kept']);
    expect(svc.reaper.outcome?.status).toBe('aborted');
  });
});

describe('Context.run (ported from the pre-redesign push-context.test.ts)', () => {
  it('runs a function with the node as current', () => {
    const KEY = createInjectionKey<string>('run-key');
    const ctx = createRootContext({ providers: [valueProvider(KEY, 'run-val')] });
    expect(ctx.run(() => lookup(KEY))).toBe('run-val');
  });

  it('restores the previous node after run completes', () => {
    const KEY1 = createInjectionKey<string>('k1');
    const KEY2 = createInjectionKey<string>('k2');
    const ctx1 = createRootContext({ providers: [valueProvider(KEY1, 'v1')] });
    const ctx2 = ctx1.child({ providers: [valueProvider(KEY2, 'v2')] });
    ctx1.run(() => {
      expect(lookup(KEY1)).toBe('v1');
      ctx2.run(() => {
        expect(lookup(KEY1)).toBe('v1');
        expect(lookup(KEY2)).toBe('v2');
      });
      // After the inner run, ctx1 is current again.
      expect(current()).toBe(ctx1);
      expect(lookup(KEY1)).toBe('v1');
      expect(() => lookup(KEY2)).toThrow();
    });
  });

  it('returns the value from the callback', () => {
    const ctx = createRootContext();
    expect(ctx.run(() => 42)).toBe(42);
  });

  it('a callback that returns a promise is an AsyncRunError in development', () => {
    const ctx = createRootContext();
    expect(() => ctx.run(async () => 1)).toThrow(AsyncRunError);
  });

  it('a callback whose promise rejects is one AsyncRunError, not also an unhandled rejection (I10)', async () => {
    const ctx = createRootContext();
    expect(() =>
      ctx.run(async () => {
        throw new Error('inner');
      }),
    ).toThrow(AsyncRunError);
    await tick(); // the setup hook fails this test if the dropped promise rejected unhandled
    await ctx.close();
  });

  it('runSync with an async fn is one AsyncRunError; the continuation that finds its child complete rejects nothing unhandled (I10)', async () => {
    const root = createRootContext();
    let inner: Context | undefined;
    root.run(() => {
      expect(() =>
        runSync(async () => {
          inner = current();
          await tick();
          own(() => {}); // NodeCompletedError: the runSync child was released when runSync returned
        }),
      ).toThrow(AsyncRunError);
      expect(() =>
        runSync(async () => {
          throw new Error('inner');
        }),
      ).toThrow(AsyncRunError);
    });
    expect(inner?.state).toBe('complete');
    await tick(3);
    await root.close();
  });
});
