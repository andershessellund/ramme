// Tests for platform / async iteration.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fork, never, result, sleep } from './ambient.js';
import type { Context } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { each } from './platform.js';
import { trace, within } from '../tests/support/util.js';
import type { Trace } from '../tests/support/util.js';
import { showError as show } from '../tests/support/observations.js';

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

afterEach(async () => {
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
  vi.unstubAllGlobals();
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** A source over `values` (an async generator), recording `return()` calls; its `finally` waits 5 ms, then traces `source closed`. */
interface RecordingSource<T> extends AsyncIterable<T> {
  /** How many times `return()` was called on an iterator of it. */
  readonly returns: number;
}

function recordingSource<T>(values: readonly T[], t: Trace): RecordingSource<T> {
  async function* items(): AsyncGenerator<T, void, undefined> {
    try {
      for (const v of values) yield v;
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 5));
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

// --- each --------------------------------------------------------------------------------------------------------

describe("each, decision 24's shape", () => {
  it('for (const x of yield* each(source)) { …; yield* each.next(); } visits every item in order', async () => {
    const t = trace();
    const source = recordingSource([1, 2, 3], t);
    const root = app();
    const seen = await within(
      root.call(function* () {
        const items: number[] = [];
        for (const x of yield* each(source)) {
          items.push(x);
          yield* each.next();
        }
        return items;
      }),
    );
    expect({ seen, log: t.log }).toEqual({ seen: [1, 2, 3], log: ['source closed'] });
  });

  it("each closes its source when the body leaves the loop early, by break, return or a throw: return() is called once, by the body's next yield*, and the source's finally runs before the node completes", async () => {
    const boom = new Error('boom');
    const root = app();
    const seen: Record<string, unknown> = {};

    const tb = trace();
    const sb = recordingSource([1, 2, 3], tb);
    const broke = await within(
      root.call(function* () {
        const items: number[] = [];
        for (const x of yield* each(sb)) {
          items.push(x);
          if (x === 2) break;
          yield* each.next();
        }
        yield* sleep(0);
        return { items, returnsAtNextYield: sb.returns };
      }),
    );
    seen.break = { ...broke, returns: sb.returns, log: tb.log };

    const tr = trace();
    const sr = recordingSource([1, 2, 3], tr);
    const returned = await within(
      root.call(function* () {
        for (const x of yield* each(sr)) {
          if (x === 2) return x;
          yield* each.next();
        }
        return 0;
      }),
    );
    seen.return = { returned, returns: sr.returns, log: tr.log };

    const tt = trace();
    const st = recordingSource([1, 2, 3], tt);
    const thrown = await within(
      root.attempt(function* () {
        for (const x of yield* each(st)) {
          if (x === 2) throw boom;
          yield* each.next();
        }
      }),
    );
    seen.throw = { outcome: show(thrown, { boom }), returns: st.returns, log: tt.log };

    expect(seen).toEqual({
      break: { items: [1, 2], returnsAtNextYield: 1, returns: 1, log: ['return()', 'source closed'] },
      return: { returned: 2, returns: 1, log: ['return()', 'source closed'] },
      throw: { outcome: 'defect(boom)', returns: 1, log: ['return()', 'source closed'] },
    });
  });

  it("each closes its source when the body is halted inside the loop: return() is called once as release work, the source's finally runs before the node completes, and the outcome is aborted", async () => {
    const t = trace();
    const source = recordingSource([1, 2, 3], t);
    const stop = new Error('stop');
    const root = app();
    const outcome = await within(
      root.call(function* () {
        const f = fork(
          task(
            function* () {
              for (const x of yield* each(source)) {
                t.push(`item ${x}`);
                yield* never();
                yield* each.next();
              }
              t.push('after the loop');
            },
            { name: 'consuming' },
          ),
        );
        while (t.log.length === 0) yield* sleep(1);
        f.abort(stop);
        return show(yield* result(f), { stop }); // result waits for f's completion, which waits for the close
      }),
    );
    expect({ outcome, returns: source.returns, log: t.log }).toEqual({
      outcome: 'aborted(stop)',
      returns: 1,
      log: ['item 1', 'return()', 'source closed'],
    });
  });

  it('each closes its source when the body is halted waiting in each.next(): return() is called once and the halt completes', async () => {
    let nextCalls = 0;
    let returns = 0;
    // Its second read is in flight for 30 ms: whether the halt waits for it or not, the source is returned once.
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const n = ++nextCalls;
          if (n === 1) return Promise.resolve({ value: 1, done: false });
          return new Promise<IteratorResult<number>>((resolve) => setTimeout(() => resolve({ value: n, done: false }), 30));
        },
        return: () => {
          returns++;
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
    const stop = new Error('stop');
    const root = app();
    const outcome = await within(
      root.call(function* () {
        const f = fork(
          task(
            function* () {
              for (const _ of yield* each(source)) yield* each.next();
            },
            { name: 'reading' },
          ),
        );
        while (nextCalls < 2) yield* sleep(1);
        f.abort(stop);
        return show(yield* result(f), { stop });
      }),
    );
    expect({ outcome, returns }).toEqual({ outcome: 'aborted(stop)', returns: 1 });
  });
});
