// Tests for tasks / joining.
import { describe, expect, it } from 'vitest';
import { all, fork, interrupted, join, never, result, wait } from '../../src/ambient.js';
import type { Outcome } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { FiberAbortedError, FiberNotAwaitableError } from '../../src/resource.js';
import { tick } from '../support/util.js';

/** The rejection of `p`; throws if `p` fulfils. Awaits `p` directly, so a managed `p` is awaited by its own body, a direct await (DESIGN.md §4.2). */
async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('join and result (DESIGN.md §4.5, §4.7)', () => {
  it("join resolves with the value and throws the fiber's failure", async () => {
    const err = new Error('boom');
    const root = createRootContext();
    await root.call(function* () {
      expect(yield* join(fork(function* () { return 'v'; }))).toBe('v');
      expect(yield* wait(rejection(join(fork(function* () { return yield* wait(Promise.reject(err)); }))))).toBe(err);
    });
    await root.close();
  });

  it('join of an aborted fiber throws FiberAbortedError to an awaiter that is not itself interrupted: an observe body draining after its interrupt', async () => {
    let seen: unknown;
    const root = createRootContext();
    const shutdown = root.fork(
      task(
        function* () {
          const worker = fork(function* () {
            yield* never();
          });
          const why = yield* interrupted(); // observe: the body sees the interrupt and keeps running
          worker.abort(`after ${String(why)}`);
          seen = yield* wait(rejection(join(worker)));
          return 'drained';
        },
        { interrupt: 'observe', onFailure: 'link' },
      ),
    );
    await tick();
    root.abort('stop');
    await root.close();
    expect(seen).toBeInstanceOf(FiberAbortedError);
    expect((seen as FiberAbortedError).reason).toBe('after stop');
    expect(shutdown.outcome).toEqual({ status: 'success', value: 'drained' });
  });

  it('result never rejects: success, a defect and aborted are values, and a defect it delivers is consumed', async () => {
    const err = new Error('r');
    const root = createRootContext();
    await root.call(function* () {
      const ok = fork(function* () { return 'v'; });
      const bad = fork(function* () {
        throw err;
      });
      const gone = fork(function* () {
        yield* never();
      });
      yield* wait(tick());
      gone.abort('reason');
      const outcomes: Outcome<unknown>[] = [yield* result(ok), yield* result(bad), yield* result(gone)];
      expect(outcomes).toEqual([
        { status: 'success', value: 'v' },
        { status: 'defect', error: err },
        { status: 'aborted', reason: 'reason' },
      ]);
    });
    await root.close(); // the failure was consumed by result: nothing surfaces
  });

  it('a fiber is not awaitable: await, Promise.resolve and Promise.all reject with FiberNotAwaitableError (DESIGN.md §4.5)', async () => {
    const root = createRootContext();
    await root.call(function* () {
      const f = fork(function* () { return 1; });
      const asPromise = f as unknown as Promise<number>;
      expect(yield* wait(rejection((async () => await asPromise)()))).toBeInstanceOf(FiberNotAwaitableError);
      expect(yield* wait(rejection(Promise.resolve(asPromise)))).toBeInstanceOf(FiberNotAwaitableError);
      expect(yield* wait(rejection(Promise.all([asPromise])))).toBeInstanceOf(FiberNotAwaitableError);
      expect(() => (f as unknown as { then: unknown }).then).toThrow(/use join\(f\) or result\(f\)/);
      expect(yield* join(f)).toBe(1); // the fiber itself is unaffected
    });
    await root.close();
  });

  it('a sync body and an async body that return a fiber both fail with FiberNotAwaitableError; nothing escapes the start microtask (DESIGN.md §4.5)', async () => {
    const inner = task(function* () { return 1; });
    const root = createRootContext();
    await root.call(function* () {
      const syncF = fork(() => fork(inner));
      const asyncF = fork(function* () { return fork(inner); });
      const callErr = yield* wait(rejection(task(() => fork(inner))()));
      const [o1, o2] = [yield* result(syncF), yield* result(asyncF)];
      expect(o1.status).toBe('defect');
      expect((o1 as { error: unknown }).error).toBeInstanceOf(FiberNotAwaitableError);
      expect(o2.status).toBe('defect');
      expect((o2 as { error: unknown }).error).toBeInstanceOf(FiberNotAwaitableError);
      expect(callErr).toBeInstanceOf(FiberNotAwaitableError);
    });
    await root.close();
    // The setup hook fails this test if anything was an unhandled rejection (I10).
  });
});

describe('join, result, all', () => {
  it('join resolves with the fiber value', async () => {
    const ctx = createRootContext();
    expect(await ctx.call(function* () { return yield* join(fork(function* () { return 42; })); })).toBe(42);
    await ctx.close();
  });

  it("join throws the fiber's error", async () => {
    const ctx = createRootContext();
    const err = await rejection(
      ctx.call(function* () {
        const f = fork(function* () {
          throw new Error('join-boom');
        });
        yield* join(f);
      }),
    );
    expect((err as Error).message).toBe('join-boom');
    await ctx.close();
  });

  it('result returns a success outcome', async () => {
    const ctx = createRootContext();
    expect(await ctx.call(function* () { return yield* result(fork(function* () { return 'ok'; })); })).toEqual({ status: 'success', value: 'ok' });
    await ctx.close();
  });

  it('result returns a defect outcome without throwing', async () => {
    const ctx = createRootContext();
    const o = await ctx.call(
      function* () { return yield* result(
          fork(function* () {
            throw new Error('result-boom');
          }),
        ); },
    );
    expect(o.status).toBe('defect');
    expect((o as { error: Error }).error).toBeInstanceOf(Error);
    expect((o as { error: Error }).error.message).toBe('result-boom');
    await ctx.close();
  });

  it('all runs the tasks and returns a tuple', async () => {
    const ctx = createRootContext();
    const [a, b, c] = await ctx.call(
      function* () { return yield* all([task(function* () { return 1; }), task(function* () { return 'two'; }), task(function* () { return true; })]); },
    );
    expect(a).toBe(1);
    expect(b).toBe('two');
    expect(c).toBe(true);
    await ctx.close();
  });

  it('all rejects with an AggregateError when any task fails', async () => {
    const ctx = createRootContext();
    const err = await rejection(
      ctx.call(
        function* () { return yield* all([
            task(function* () { return 'ok'; }),
            task(function* () {
              throw new Error('all-boom');
            }),
          ]); },
      ),
    );
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual(['all-boom']);
    await ctx.close();
  });

  it('all works with an empty array', async () => {
    const ctx = createRootContext();
    expect(await ctx.call(function* () { return yield* all([]); })).toEqual([]);
    await ctx.close();
  });
});
