// Tests for lifecycle / node operations.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import type { Body, Context, Fiber } from '../../src/context.js';
import { currentFrame } from '../../src/context-storage.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import type { NodeImpl } from '../../src/node-impl.js';
import { valueProvider } from '../../src/provider-util.js';
import { inject } from '../../src/inject.js';
import { AsyncRunError, CreationViolationError, FiberAbortedError, FiberNotAwaitableError, NodeCompletedError } from '../../src/resource.js';
import { deferred, events, here, impl, start, tick, trace } from '../support/util.js';

/** A fiber forked onto a bodiless node needs a destination other than 'join' (D14); 'link' surfaces failures. */
const linked = { onFailure: 'link' } as const;

/** Fork a body onto a bodiless node with the 'link' destination. */
function spawn<T>(on: Context, body: Body<T>, opts: Parameters<typeof task>[1] = {}): Fiber<T> {
  return on.fork(task(body, { ...linked, ...opts }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('the lifecycle table (DESIGN.md §2.7)', () => {
  it('abort() delivers the signal and returns without waiting', async () => {
    const app = createRootContext();
    const N = app.child();
    const d = deferred();
    N.own(() => d.promise);
    expect(N.abort()).toBeUndefined();
    expect(N.signal.aborted).toBe(true);
    expect(N.state).toBe('releasing');
    d.resolve();
    await app.close();
    expect(N.state).toBe('complete');
  });

  it('close() on a bodiless node: success, subscribed children closed recursively, unsubscribed ones aborted', async () => {
    const app = createRootContext();
    const N = app.child();
    const owned = N.own(
      spawn(N, function* () {
        yield* here().never();
      }),
    );
    const C = N.child(); // above `owned` on N's stack: released (closed) first
    const gate = deferred();
    const natural = spawn(C, function* () {
      yield* wait(gate.promise);
      return 'done';
    });
    await tick();
    const closing = N.close();
    expect(natural.signal.aborted).toBe(false); // closed, not signalled: it finishes naturally
    expect(owned.signal.aborted).toBe(false); // the owned fiber hears at its turn, after the subscribed child
    gate.resolve();
    await closing;
    expect(natural.outcome).toEqual({ status: 'success', value: 'done' });
    expect(owned.outcome?.status).toBe('aborted');
    expect(N.outcome).toEqual({ status: 'success', value: undefined });
    expect(C.outcome?.status).toBe('success');
    await app.close();
  });

  it('close() on a fiber waits for its body without a signal; a later abort() wins (DESIGN.md §2.7)', async () => {
    const app = createRootContext();
    const gate = deferred();
    let sub!: Fiber<unknown>;
    const f = spawn(app, function* () {
      sub = here().fork(function* () {
        yield* here().never();
      });
      yield* wait(gate.promise);
      return 1;
    });
    await tick();
    const closing = f.close();
    expect(f.signal.aborted).toBe(false);
    await tick();
    expect(f.state).toBe('running');
    f.abort('now');
    expect(sub.signal.aborted).toBe(true);
    gate.resolve();
    await closing;
    expect(f.outcome?.status).toBe('aborted');
    await app.close();
  });

  it("close(), then abort(), on an observe node whose bodiless exit was 'await': the abort wins and interrupts its freeze subscribers (DESIGN.md §2.7)", async () => {
    const app = createRootContext();
    const A = app.child({ name: 'A', interrupt: 'observe' });
    const f = spawn(A, function* () {
      yield* here().never();
    });
    await tick(); // f is suspended on never()
    const closing = A.close();
    await tick();
    expect(A.state).toBe('releasing'); // close() waits for f
    expect(impl(A).exitKind).toBe('await');
    A.abort('stop');
    expect(impl(A).exitKind).toBe('interrupt');
    expect(impl(f).delivered).toBe(true); // the body has exited: no observe body decides for the subtree
    await closing;
    expect(f.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    expect(A.outcome?.status).toBe('success'); // fixed when it settled under close() (DESIGN.md §4.12)
    await app.close();
  });

  it('close() of an already-delivered bodiless node is an interrupt, not a wait: the abort came first and wins (DESIGN.md §2.7)', async () => {
    const app = createRootContext();
    const gate = deferred();
    const P = spawn(app, function* () { return yield* wait(gate.promise); }); // a bare await: delivery does not reject it
    await tick();
    P.abort('stop');
    const C = P.child({ name: 'C' }); // born delivered (D12)
    const O = C.child({ name: 'O', interrupt: 'observe' }); // observe: never delivered at birth
    const G = spawn(O, function* () {
      yield* here().never();
    }); // freeze under an undelivered observe node
    await tick();
    expect([impl(C).delivered, impl(O).delivered, impl(G).delivered]).toEqual([true, false, false]);
    await C.close();
    expect(impl(C).exitKind).toBe('interrupt');
    expect(G.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    gate.resolve();
    await app.close();
  });

  it('[Symbol.dispose]() throws on a root and aborts any other node', async () => {
    const app = createRootContext();
    expect(() => app[Symbol.dispose]()).toThrow(TypeError);
    const c = app.child();
    c[Symbol.dispose]();
    expect(c.signal.aborted).toBe(true);
    expect(c.state).toBe('complete');
    {
      using scoped = app.child();
      scoped.own(() => {});
    }
    await app.close();
  });

  it('[Symbol.asyncDispose]() twice shares one release per entry and one completion', async () => {
    const ev = events();
    const N = ev.root.child();
    let n = 0;
    N.own(async () => {
      await tick();
      n++;
    });
    await Promise.all([N[Symbol.asyncDispose](), N[Symbol.asyncDispose](), N.close()]);
    N.abort();
    expect(n).toBe(1);
    expect(ev.of('node:complete').filter((e) => e.id === N.id)).toHaveLength(1);
    await ev.root.close();
  });

  it('await using runs the releases', async () => {
    const t = trace();
    {
      await using app = createRootContext();
      app.own(t.at('released'));
    }
    expect(t.log).toEqual(['released']);
  });
});

// ---------------------------------------------------------------------------
describe('use after release (DESIGN.md §2.7, I7, I8)', () => {
  it('a complete node refuses every operation but the lifecycle quartet (DESIGN.md §2.7)', async () => {
    const K = createInjectionKey<number>('K');
    const app = createRootContext({ providers: [valueProvider(K, 1)] });
    const f = spawn(app, function* () { return 1; });
    await app.join(f);
    const n = app.child();
    await n.close();
    const ops: [string, () => unknown][] = [
      ['get', () => n.get(K)],
      ['own', () => n.own(() => {})],
      ['release', () => n.release({})],
      ['releaseAll', () => n.releaseAll()],
      ['fork', () => n.fork(task(function* () { return 1; }, linked))],
      ['call', () => n.call(function* () { return 1; })],
      ['child', () => n.child()],
      ['pool', () => n.pool({ name: 'p', onFailure: () => {} })],
      ['addProvider', () => n.addProvider(valueProvider(K, 2))],
      ['run', () => n.run(() => 1)],
      ['runSync', () => n.runSync(() => 1)],
      ['join', () => n.join(f)],
      ['result', () => n.result(f)],
      ['interrupted', () => n.interrupted()],
      ['never', () => n.never()],
      ['managed', () => n.wait(Promise.resolve(1), { abandon: true })],
    ];
    for (const [op, call] of ops) expect(call, op).toThrow(NodeCompletedError);
    expect(() => n.abort()).not.toThrow();
    await expect(n.close()).resolves.toBeUndefined();
    await expect(n[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(() => n[Symbol.dispose]()).not.toThrow();
    await app.close();
  });

  it('between delivery and completion get, own, release, fork, child, call and pool work (I8); a freeze child is born delivered, an observe one is not', async () => {
    const K = createInjectionKey<number>('K');
    const app = createRootContext({ providers: [valueProvider(K, 1)] });
    const gate = deferred();
    const results: unknown[] = [];
    const f = spawn(app, function* () {
      yield* wait(gate.promise); // bare: delivery arrives while the body runs
      const self = here();
      results.push(self.get(K));
      const x = self.own({}, () => void results.push('x released'));
      void self.release(x); // eager: runs now; not waited for (the test reads what plain code does after delivery, I8)
      let inside: NodeImpl | undefined;
      void self.call(() => {
        inside = here();
        return 3;
      }); // a work op nobody consumes: it runs nothing (D41, decision 2)
      results.push(inside === undefined);
    });
    await tick();
    f.abort();
    const n = impl(f);
    expect(n.state).toBe('running');
    expect(f.get(K)).toBe(1);
    const y = f.own({}, () => {});
    void f.release(y);
    const freezeChild = impl(f.child());
    const observeChild = impl(f.child({ interrupt: 'observe' }));
    expect(freezeChild.delivered).toBe(true);
    expect(observeChild.delivered).toBe(false);
    const fiber = impl(f.fork(function* () { return 1; }));
    expect(fiber.delivered).toBe(true);
    let outside!: NodeImpl;
    const called = start(f.call(() => {
      outside = here();
      return 2;
    }));
    expect(outside.parent).toBe(n);
    expect(outside.delivered).toBe(true); // born delivered: its outcome is aborted, so join semantics reject
    await expect(called).rejects.toBeInstanceOf(FiberAbortedError);
    const p = impl(f.pool({ name: 'p', onFailure: () => {} }));
    expect(p.state).toBe('running');
    gate.resolve();
    await app.close();
    expect(results).toEqual([1, 'x released', true]);
  });
});

// ---------------------------------------------------------------------------
describe('bodies and messages (DESIGN.md §4.5, §4.12)', () => {
  it('a body that returns a context or a pool returns it as its value, sync or async; one that returns a fiber fails (DESIGN.md §4.5)', async () => {
    const app = createRootContext();
    let c!: Context;
    expect(await app.call(() => (c = app.child()))).toBe(c); // the op runs when awaited: c is set by then
    expect(await app.call(function* () { return (c = app.child()); })).toBe(c);
    let p: unknown;
    expect(await app.call(() => (p = app.pool({ name: 'p', onFailure: () => {} })))).toBe(p);
    const f = spawn(app, () => here().never());
    await expect(app.call(() => f as unknown as number)).rejects.toThrow(/returned a fiber/);
    await expect(app.call(function* () { return f as unknown as number; })).rejects.toBeInstanceOf(FiberNotAwaitableError);
    f.abort();
    await app.close();
  });

  it("inject() outside creation throws CreationViolationError starting with 'inject() outside creation'", () => {
    const K = createInjectionKey<number>('K');
    expect(() => inject(K)).toThrow(CreationViolationError);
    expect(() => inject(K)).toThrow(/^inject\(\) outside creation/);
  });
});

// ---------------------------------------------------------------------------
describe('run and runSync (DESIGN.md §4.11)', () => {
  it('run makes the node current for a synchronous fn and restores the frame on return and on throw', async () => {
    const app = createRootContext();
    expect(currentFrame()).toBeUndefined();
    expect(app.run(() => here())).toBe(impl(app));
    expect(currentFrame()).toBeUndefined();
    expect(() =>
      app.run(() => {
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(currentFrame()).toBeUndefined();
    await app.close();
  });

  it('run(fn) returning a promise throws AsyncRunError (DESIGN.md §4.4, §4.11)', async () => {
    const app = createRootContext();
    expect(() => app.run(async () => 1)).toThrow(AsyncRunError);
    await app.close();
  });

  it('run(fn) returning an op returns it as a value: made in the run, it ran nothing, and runs when consumed (D41, decision 28)', async () => {
    const app = createRootContext();
    let ran = 0;
    const op = app.run(() =>
      here().call(function* () {
        ran++;
        return 'ran';
      }),
    );
    const before = ran;
    expect({ before, value: await op, after: ran }).toEqual({ before: 0, value: 'ran', after: 1 });
    await app.close();
  });

  it('runSync is child + run + abort, and the child releases synchronously before runSync returns', async () => {
    const t = trace();
    const app = createRootContext();
    let inner!: NodeImpl;
    const v = app.runSync((a: number, b: number) => {
      inner = here();
      here().own(t.at('released'));
      return a + b;
    }, 2, 3);
    expect(v).toBe(5);
    expect(inner.parent).toBe(impl(app));
    expect(inner.kind).toBe('context');
    expect(inner.state).toBe('complete');
    expect(t.log).toEqual(['released']);
    await app.close();
  });

  it('runSync with a throwing fn still releases', async () => {
    const t = trace();
    const app = createRootContext();
    expect(() =>
      app.runSync(() => {
        here().own(t.at('released'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(t.log).toEqual(['released']);
    await app.close();
  });
});
