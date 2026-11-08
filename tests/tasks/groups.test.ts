// Tests for tasks / groups.
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { all, current, never, own, race, wait } from '../../src/ambient.js';
import type { Context, Op } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { FiberAbortedError } from '../../src/resource.js';
import { tick, trace } from '../support/util.js';

const link = { onFailure: 'link' } as const;

/** The rejection of `p`; throws if `p` fulfils. Awaits `p` directly, so a managed `p` is awaited by its own body, a direct await (DESIGN.md §4.2). */
async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('all and race (DESIGN.md §4.8)', () => {
  it('all resolves with the tuple in task order, typed as a tuple', async () => {
    const root = createRootContext();
    const values = await root.call(function* () {
      const p = all([
        task(function* () {
          yield* wait(tick(2));
          return 1;
        }),
        task(function* (s: string) { return s; })('two'),
        task(() => true),
      ]);
      expectTypeOf(p).toEqualTypeOf<Op<[number, string, boolean]>>();
      return yield* p;
    });
    expect(values).toEqual([1, 'two', true]);
    expect(await root.call(() => all([]))).toEqual([]);
    await root.close();
  });

  it('the method all infers the tuple too, on a named node and through current()', async () => {
    const root = createRootContext();
    const a = task(function* (n: number) { return n; });
    const b = task((s: string) => s);
    const viaRoot = root.run(() => root.all([a(1), b('x')])); // a task's call reads the slot: made where a node is current
    expectTypeOf(viaRoot).toEqualTypeOf<Op<[number, string]>>();
    expect(await viaRoot).toEqual([1, 'x']);
    const viaCurrent = await root.call(function* () {
      const p = current().all([b('y'), a(2)]);
      expectTypeOf(p).toEqualTypeOf<Op<[string, number]>>();
      return yield* p;
    });
    expect(viaCurrent).toEqual(['y', 2]);
    const ctx: Context = root;
    expectTypeOf(ctx.run(() => ctx.all([a(3)]))).toEqualTypeOf<Op<[number]>>();
    await root.close();
  });

  it('all reports every real failure in one AggregateError and leaves aborted members out of it', async () => {
    const e1 = new Error('one');
    const e2 = new Error('two');
    const root = createRootContext();
    const err = await rejection(
      root.call(() =>
        all([
          task(function* () {
            throw e1;
          }),
          task(function* () { return 'ok'; }),
          task(function* () {
            current().abort('self');
            yield* never();
          }),
          task(function* () {
            yield* wait(tick());
            throw e2;
          }),
        ]),
      ),
    );
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toEqual([e1, e2]);
    await root.close();
  });

  it('all rejects with FiberAbortedError when a member was aborted and none failed (DESIGN.md §4.8)', async () => {
    const root = createRootContext();
    const err = await rejection(
      root.call(() =>
        all([
          task(function* () { return 1; }),
          task(function* () {
            current().abort('gone');
            yield* never();
          }),
        ]),
      ),
    );
    expect(err).toBeInstanceOf(FiberAbortedError);
    expect((err as FiberAbortedError).reason).toBe('gone');
    await root.close();
  });

  it('race resolves with the first success after aborting and awaiting the rest', async () => {
    const t = trace();
    const root = createRootContext();
    const v = await root.call(() =>
      race([
        task(function* () {
          own(() => t.push('slow released'));
          yield* never();
          return 'slow';
        }),
        task(function* () {
          yield* wait(tick());
          return 'fast';
        }),
      ]),
    );
    expect(v).toBe('fast');
    expect(t.log).toEqual(['slow released']); // the loser was released before race resolved
    await root.close();
  });

  it('race: every member failed → AggregateError; every member aborted → FiberAbortedError; race([]) → TypeError', async () => {
    const e1 = new Error('a');
    const e2 = new Error('b');
    const root = createRootContext();
    await root.call(function* () {
      const failed = yield* wait(rejection(
        race([
          task(function* () {
            throw e1;
          }),
          task(function* () {
            yield* wait(tick());
            throw e2;
          }),
        ]),
      ));
      expect(failed).toBeInstanceOf(AggregateError);
      expect((failed as AggregateError).errors).toEqual([e1, e2]);
      const aborted = yield* wait(rejection(
        race([
          task(function* () {
            current().abort('x');
            yield* never();
          }),
        ]),
      ));
      expect(aborted).toBeInstanceOf(FiberAbortedError);
      expect(() => race([])).toThrow(TypeError);
    });
    await root.close();
  });

  it("members declared with 'link' or a handler run as 'join' members: the AggregateError arrives and no handler runs (DESIGN.md §4.8)", async () => {
    const e1 = new Error('linked');
    const e2 = new Error('handled');
    const handler = vi.fn();
    const root = createRootContext();
    await root.call(function* () {
      const members = [
        task(function* () {
          throw e1;
        }, link),
        task(function* () {
          yield* wait(tick());
          throw e2;
        }, { onFailure: handler }),
      ];
      const fromAll = yield* wait(rejection(all(members)));
      expect(fromAll).toBeInstanceOf(AggregateError);
      expect((fromAll as AggregateError).errors).toEqual([e1, e2]);
      const fromRace = yield* wait(rejection(race(members)));
      expect(fromRace).toBeInstanceOf(AggregateError);
      expect((fromRace as AggregateError).errors).toEqual([e1, e2]);
      // A linked member's failure does not abort the race: a later success still wins.
      expect(
        yield* race([
          members[0],
          task(function* () {
            yield* wait(tick());
            return 'ok';
          }),
        ]),
      ).toBe('ok');
    });
    await root.close();
    expect(handler).not.toHaveBeenCalled();
  });
});
