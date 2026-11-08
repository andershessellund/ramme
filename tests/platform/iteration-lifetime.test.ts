// Tests for platform / iteration lifetime.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, fork, releaseAll, result, sleep } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { each } from '../../src/platform.js';
import { trace, within } from '../support/util.js';
import type { Trace } from '../support/util.js';
import { labelError as label, showError as show } from '../support/observations.js';

const roots: Context[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

function outcomeOf(f: () => unknown): string {
  try {
    f();
    return 'returned';
  } catch (e) {
    return e instanceof Error ? e.constructor.name : String(e);
  }
}

/** An async generator over `values` whose `return()` calls are traced (`return()`) and counted; its `finally` traces `source closed`. */
function recordingSource<T>(values: readonly T[], t: Trace): AsyncIterable<T> & { readonly returns: number } {
  async function* items(): AsyncGenerator<T, void, undefined> {
    try {
      for (const v of values) yield v;
    } finally {
      t.push('source closed');
    }
  }
  let returns = 0;
  return {
    get returns() {
      return returns;
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const g = items();
      return {
        next: () => g.next(),
        return: (v?: unknown) => {
          returns++;
          t.push('return()');
          return g.return(v as undefined) as Promise<IteratorResult<T>>;
        },
      };
    },
  };
}

// --- each ----------------------------------------------------------------------------------------------------------

describe('platform: each', () => {
  it('a halt during the first read stops waiting at once, and the source is returned once before the node completes', async () => {
    let reads = 0;
    let returns = 0;
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          reads++;
          return new Promise<IteratorResult<number>>(() => {}); // a read that never settles
        },
        return: () => {
          returns++;
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
    const root = app();
    const outcome = await within(
      root.call(function* () {
        const f = fork(
          task(function* () {
            for (const _ of yield* each(source)) yield* each.next();
          }),
        );
        while (reads === 0) yield* sleep(1);
        f.abort();
        return (yield* result(f)).status;
      }),
    );
    expect({ outcome, reads, returns }).toEqual({ outcome: 'aborted', reads: 1, returns: 1 });
  });

  it('a pass without yield* each.next() throws a TypeError at the loop head, and the source is returned there', async () => {
    const t = trace();
    const source = recordingSource([1, 2, 3], t);
    const root = app();
    const seen = await within(
      root.call(function* () {
        const items: number[] = [];
        try {
          for (const x of yield* each(source)) items.push(x);
        } catch (e) {
          t.push(`caught ${e instanceof TypeError ? 'TypeError' : label(e)}`);
        }
        return items;
      }),
    );
    expect({ seen, returns: source.returns, log: t.log }).toEqual({
      seen: [1],
      returns: 1,
      log: ['return()', 'caught TypeError', 'source closed'],
    });
  });

  it('each.next() outside a loop, after the loop, and each() of no async iterable are TypeErrors', async () => {
    const t = trace();
    const root = app();
    const outside = await within(root.attempt(function* () {
      yield* each.next();
    }));
    const after = await within(
      root.attempt(function* () {
        for (const _ of yield* each(recordingSource([1], t))) yield* each.next();
        yield* each.next();
      }),
    );
    const named = (o: unknown): boolean => {
      const e = (o as { error?: unknown }).error;
      return e instanceof TypeError && e.message.startsWith('each.next() outside');
    };
    expect({
      outside: [outside.status, named(outside)],
      after: [after.status, named(after)],
      made: outcomeOf(() => each([1, 2] as unknown as AsyncIterable<number>)),
    }).toEqual({ outside: ['defect', true], after: ['defect', true], made: 'TypeError' });
  });

  it("releaseAll() inside a loop releases the iteration's entry, returning the source; the loop then ends at its next read", async () => {
    const t = trace();
    const source = recordingSource([1, 2, 3], t);
    const root = app();
    const outcome = await within(
      root.attempt(function* () {
        const items: number[] = [];
        for (const x of yield* each(source)) {
          items.push(x);
          if (x === 1) yield* releaseAll();
          yield* each.next();
        }
        return items.join(',');
      }),
    );
    expect({ outcome: show(outcome), returns: source.returns, log: t.log }).toEqual({
      outcome: 'success("1")',
      returns: 1,
      log: ['return()', 'source closed'],
    });
  });

  it('nested loops: each.next() advances the innermost; exhausted and empty sources are never returned', async () => {
    const t = trace();
    const sources: { returns: number }[] = [];
    const make = <T>(values: readonly T[]) => {
      const s = recordingSource(values, t);
      sources.push(s);
      return s;
    };
    const root = app();
    const seen = await within(
      root.call(function* () {
        const pairs: string[] = [];
        for (const o of yield* each(make(['a', 'b']))) {
          for (const i of yield* each(make([1, 2]))) {
            pairs.push(`${o}${i}`);
            yield* each.next();
          }
          for (const _ of yield* each(make([]))) pairs.push('never');
          yield* each.next();
        }
        return pairs;
      }),
    );
    expect({ seen, returns: sources.map((s) => s.returns), closed: t.log.filter((l) => l === 'source closed').length }).toEqual({
      seen: ['a1', 'a2', 'b1', 'b2'],
      returns: [0, 0, 0, 0, 0],
      closed: 5,
    });
  });

  it("a failed read is thrown at the yield* and the source is never returned; a return() that rejects is the node's release failure", async () => {
    const boom = new Error('boom');
    const closing = new Error('closing');
    let returns = 0;
    const failing: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => {
        let n = 0;
        return {
          next: () => (++n === 1 ? Promise.resolve({ value: 1, done: false }) : Promise.reject(boom)),
          return: () => {
            returns++;
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
    const rejecting: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ value: 1, done: false }),
        return: () => Promise.reject(closing),
      }),
    };
    const root = app();
    const read = await within(
      root.attempt(function* () {
        for (const _ of yield* each(failing)) yield* each.next();
      }),
    );
    // Caught inside the loop: the loop is over, and ends at its head.
    const inside = await within(
      root.attempt(function* () {
        let passes = 0;
        let caught = 'nothing';
        for (const _ of yield* each(failing)) {
          passes++;
          try {
            yield* each.next();
          } catch (e) {
            caught = label(e, { boom });
          }
        }
        return `${passes} ${caught}`;
      }),
    );
    // Caught in an outer loop's pass: the inner loop is over, and the outer one goes on.
    const t = trace();
    const caught = await within(
      root.attempt(function* () {
        const passes: string[] = [];
        for (const o of yield* each(recordingSource(['a', 'b'], t))) {
          try {
            for (const _ of yield* each(failing)) yield* each.next();
          } catch (e) {
            passes.push(`${o} ${label(e, { boom })}`);
          }
          yield* each.next();
        }
        return passes.join(', ');
      }),
    );
    const closed = await within(
      root.attempt(function* () {
        for (const _ of yield* each(rejecting)) break;
        return 'left';
      }),
    );
    expect({
      read: show(read, { boom }),
      inside: show(inside),
      caught: show(caught),
      returns,
      closed: show(closed, { closing }),
    }).toEqual({
      read: 'defect(boom)',
      inside: 'success("1 boom")',
      caught: 'success("a boom, b boom")',
      returns: 0,
      closed: 'defect(closing)',
    });
  });

  it('a fail inside the loop ends the body with its failure and returns the source', async () => {
    const t = trace();
    const source = recordingSource([1, 2, 3], t);
    const nope = new Error('nope');
    const root = app();
    const outcome = await within(
      root.attempt(function* () {
        for (const x of yield* each(source)) {
          if (x === 2) yield* fail(nope);
          yield* each.next();
        }
      }),
    );
    expect({ outcome: show(outcome, { nope }), returns: source.returns, log: t.log }).toEqual({
      outcome: 'failure(nope)',
      returns: 1,
      log: ['return()', 'source closed'],
    });
  });
});
