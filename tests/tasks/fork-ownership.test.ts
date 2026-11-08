import { describe, expect, it } from 'vitest';
import { all, current, fail, fork, join, never, own, race, release, result, settle, shield, wait } from '../../src/ambient.js';
import type { Context, Fiber, Outcome } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { UnjoinedFiberError } from '../../src/resource.js';
import { deferred, tick, within } from '../support/util.js';

function defect(o: Outcome<unknown>): unknown {
  expect(o.status).toBe('defect');
  return (o as { error: unknown }).error;
}

describe('fork ownership at body exit', () => {
  it.each(['running', 'complete'] as const)('rejects an unjoined %s child before any owner release', async (state) => {
    await using root = createRootContext();
    let child!: Fiber<unknown>;
    let owner!: Context;
    let atRelease: Outcome<unknown> | undefined;
    const o = await root.attempt(function* () {
      owner = current();
      own(() => { atRelease = owner.outcome; });
      child = fork(task(function* child() {
        if (state === 'running') yield* never();
        return 1;
      }));
      yield* wait(tick());
      expect(child.state === 'complete').toBe(state === 'complete');
      return 42;
    });
    expect(defect(o)).toBeInstanceOf(UnjoinedFiberError);
    expect(atRelease).toBe(o);
    expect(owner.signal.aborted).toBe(false);
    expect(child.state).toBe('complete');
  });

  it.each(['join', 'result'] as const)('making a dropped %s op does not discharge the obligation', async (verb) => {
    await using root = createRootContext();
    const o = await root.attempt(function* () {
      const f = fork(() => 1);
      if (verb === 'join') void join(f);
      else void result(f);
      yield* wait(tick());
    });
    expect(defect(o)).toBeInstanceOf(UnjoinedFiberError);
  });

  it('starting a join without waiting for it to finish is insufficient', async () => {
    await using root = createRootContext();
    let waiter!: Promise<unknown>;
    const o = await root.attempt(function* () {
      const f = fork(function* () { yield* never(); });
      waiter = Promise.resolve(join(f)).catch(() => {});
      yield* wait(tick());
    });
    expect(defect(o)).toBeInstanceOf(UnjoinedFiberError);
    await within(waiter);
  });

  it('a halted observer cannot discharge another body’s child obligation without consuming its failure', async () => {
    await using root = createRootContext();
    const boom = new Error('unconsumed');
    const o = await root.attempt(function* () {
      const failed = fork(() => { throw boom; });
      const observer = fork(function* () {
        try { yield* never(); } finally { yield* result(failed); }
      });
      yield* wait(tick());
      observer.abort();
      yield* result(observer);
    });
    expect(defect(o)).toMatchObject({
      name: 'SuppressedError',
      error: boom,
      suppressed: expect.any(UnjoinedFiberError),
    });
  });

  it.each(['join', 'result'] as const)('a completed %s discharges successful and failed children', async (verb) => {
    await using root = createRootContext();
    const boom = new Error('child');
    expect(await root.call(function* () {
      for (const throws of [false, true]) {
        const f = fork(() => { if (throws) throw boom; return 7; });
        if (verb === 'result') yield* result(f);
        else {
          try { yield* join(f); } catch (e) { expect(e).toBe(boom); }
        }
      }
      return 42;
    })).toBe(42);
  });

  it.each(['abort', 'dispose', 'release'] as const)('%s is sufficient; completion still waits for child cleanup', async (verb) => {
    await using root = createRootContext();
    const cleanup = deferred();
    const started = deferred();
    const log: string[] = [];
    const done = Promise.resolve(root.call(function* () {
      const f = fork(function* () {
        try {
          started.resolve();
          yield* never();
        } finally {
          yield* wait(cleanup.promise);
          log.push('child cleaned');
        }
      });
      yield* wait(started.promise);
      if (verb === 'abort') f.abort();
      else if (verb === 'dispose') f[Symbol.dispose]();
      else void release(f); // release is eager
      log.push('body returned');
      return 42;
    })).then(value => { log.push('owner complete'); return value; });
    await tick();
    expect(log).toEqual(['body returned']);
    cleanup.resolve();
    expect(await within(done)).toBe(42);
    expect(log).toEqual(['body returned', 'child cleaned', 'owner complete']);
  });

  it('abort before the start microtask prevents the child body from running', async () => {
    await using root = createRootContext();
    let ran = false;
    expect(await root.call(() => {
      fork(() => { ran = true; }).abort();
      return 42;
    })).toBe(42);
    expect(ran).toBe(false);
  });

  it('abort of a completed child does not erase its failure', async () => {
    await using root = createRootContext();
    const boom = new Error('child');
    const o = await root.attempt(function* () {
      const f = fork(() => { throw boom; });
      yield* wait(tick());
      f.abort();
    });
    expect(defect(o)).toBe(boom);
  });

  it('cancellation does not erase a cleanup failure', async () => {
    await using root = createRootContext();
    const boom = new Error('cleanup');
    const o = await root.attempt(function* () {
      const f = fork(function* () {
        try { yield* never(); } finally { throw boom; }
      });
      yield* wait(tick());
      f.abort();
    });
    expect(defect(o)).toBe(boom);
  });

  it.each(['interrupt', 'await'] as const)('childrenOnExit: %s cannot bypass strict ownership', async (childrenOnExit) => {
    await using root = createRootContext();
    const o = await within(root.attempt(task(() => { fork(function* () { yield* never(); }); }, { childrenOnExit })));
    expect(defect(o)).toBeInstanceOf(UnjoinedFiberError);
  });

  it('a failure handler and own(f) do not discharge a body’s fork obligation', async () => {
    await using root = createRootContext();
    const o = await root.attempt(function* () {
      own(fork(task(() => 1, { onFailure: () => {} })));
      yield* wait(tick());
    });
    expect(defect(o)).toBeInstanceOf(UnjoinedFiberError);
  });

  it('reports every outstanding child, while joined and cancelled children are excluded', async () => {
    await using root = createRootContext();
    const o = await root.attempt(function* () {
      fork(task(() => 1, { name: 'forgotten-one' }));
      fork(task(() => 2, { name: 'forgotten-two' }));
      yield* join(fork(task(() => 3, { name: 'joined-child' })));
      fork(task(() => 4, { name: 'cancelled-child' })).abort();
    });
    const error = defect(o) as Error;
    expect(error).toBeInstanceOf(UnjoinedFiberError);
    expect(error.message).toMatch(/forgotten-one.*forgotten-two/);
    expect(error.message).not.toMatch(/joined-child|cancelled-child/);
  });

  it('a thrown or expected body failure cleans up its children without an ownership error', async () => {
    await using root = createRootContext();
    const boom = new Error('body');
    expect(defect(await root.attempt(() => {
      fork(function* () { yield* never(); });
      throw boom;
    }))).toBe(boom);
    expect(await root.attempt(function* () {
      fork(function* () { yield* never(); });
      yield* fail('expected');
    })).toEqual({ status: 'failure', error: 'expected' });
  });

  it('a bodiless owner can supervise a background child', async () => {
    await using root = createRootContext();
    const f = root.fork(task(() => 42, { onFailure: () => {} }));
    await tick();
    expect(f.outcome).toEqual({ status: 'success', value: 42 });
  });

  it('an observe body must still account for forks when returning successfully after interruption', async () => {
    await using root = createRootContext();
    const o = await root.attempt(task(function* () {
      fork(() => 1);
      yield* wait(tick());
      current().abort();
      return 'success despite interruption';
    }, { interrupt: 'observe' }));
    expect(defect(o)).toBeInstanceOf(UnjoinedFiberError);
  });

  it('automatic child cancellation does not stand in for observing or explicitly cancelling it', async () => {
    await using root = createRootContext();
    const signal = AbortSignal.abort();
    const o = await root.attempt(() => {
      fork(task(() => 1, { signal }));
    });
    expect(defect(o)).toBeInstanceOf(UnjoinedFiberError);
  });

  it.each(['release', 'shield'] as const)('%s bodies also account for their forks', async (kind) => {
    await using root = createRootContext();
    const body = function* () {
      fork(() => 1);
      yield* wait(tick());
    };
    const o = await root.attempt(function* () {
      if (kind === 'release') own(body);
      else yield* shield(body);
    });
    expect(defect(o)).toBeInstanceOf(UnjoinedFiberError);
  });

  it('combinators account for their members', async () => {
    await using root = createRootContext();
    expect(await root.call(function* () {
      const a = yield* all([task(() => 1)(), task(() => 2)()]);
      const r = yield* race([task(() => 3)(), task(function* () { yield* never(); })()]);
      const s = yield* settle([task(() => 4)(), task(() => { throw 'failure'; })()]);
      return { a, r, s };
    })).toEqual({ a: [1, 2], r: 3, s: [{ status: 'success', value: 4 }, { status: 'defect', error: 'failure' }] });
  });
});
