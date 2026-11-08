// Tests for tasks / pool capacity.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wait } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { task } from '../../src/fiber.js';
import { PoolFullError } from '../../src/resource.js';
import { deferred, events, within } from '../support/util.js';
import type { EventLog } from '../support/util.js';

/** Every `console.warn` of the current test, first argument only; the spy keeps them off the console. */
const warnings: string[] = [];

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

beforeEach(() => {
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

/** A root that records its tree's events (test/util.ts `events`), closed after the test. */
function recorded(): EventLog {
  const ev = events();
  roots.push(ev.root);
  return ev;
}

/** What `f()` threw: its class name and whether its message names each of `words`; `'returned'` when it did not throw. */
function thrownBy(f: () => unknown, words: readonly string[] = []): string {
  try {
    f();
    return 'returned';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const named = words.filter((w) => message.includes(w));
    return `${e instanceof Error ? e.constructor.name : typeof e}${named.length > 0 ? ` naming ${named.join(' and ')}` : ''}`;
  }
}

describe('pools: maxPending', () => {
  it('maxPending bounds pending under whenFull: wait: a fork beyond it is refused with PoolFullError naming maxPending and makes no node; maxPending: 0 is reject; it is validated; it is allowed beside reject', async () => {
    const ev = recorded();
    const root = ev.root;
    const onFailure = (): void => {};
    const gate = deferred();
    const job = task(function* job(n: number) {
      yield* wait(gate.promise);
      return n;
    });
    const p = root.pool({ name: 'jobs', onFailure, concurrency: 1, maxPending: 2 });
    const fibers = (): number => ev.of('node:created').filter((e) => e.parentId === p.id && e.kind === 'fiber').length;
    const pending: number[] = [];
    const forked = [1, 2, 3].map((n) => {
      const f = p.fork(job, n);
      pending.push(p.pending);
      return f;
    });
    const before = { running: p.running, pending: p.pending, fibers: fibers() };
    const refused = thrownBy(() => p.fork(job, 4), ['maxPending']);
    pending.push(p.pending);
    const after = { running: p.running, pending: p.pending, fibers: fibers() };
    gate.resolve();
    const values = [];
    for (const f of forked) values.push(await within(root.join(f)));
    const again = thrownBy(() => p.fork(job, 5)); // the queue drained: accepted
    // maxPending: 0 under 'wait' is 'reject'
    const zero = root.pool({ name: 'zero', onFailure, concurrency: 1, maxPending: 0 });
    zero.fork(job, 1);
    const zeroRefused = thrownBy(() => zero.fork(job, 2), ['maxPending']);
    const rejecting = root.pool({ name: 'rejecting', onFailure, concurrency: 1, whenFull: 'reject' });
    rejecting.fork(job, 1);
    const rejectRefused = thrownBy(() => rejecting.fork(job, 2));
    // validation: a non-negative integer; allowed beside 'reject'
    const invalid = [-1, 1.5, Number.NaN, '2'].map((m) =>
      thrownBy(() => root.pool({ name: 'bad', onFailure, maxPending: m as number }), ['maxPending']),
    );
    const besideReject = thrownBy(() => root.pool({ name: 'both', onFailure, whenFull: 'reject', maxPending: 1 }));
    expect({
      pending,
      before,
      refused,
      isPoolFull: refused.startsWith(PoolFullError.name),
      after,
      values,
      again,
      zero: { refused: zeroRefused, pending: zero.pending },
      rejectRefused,
      invalid,
      besideReject,
    }).toEqual({
      pending: [0, 1, 2, 2],
      before: { running: 1, pending: 2, fibers: 3 },
      refused: 'PoolFullError naming maxPending',
      isPoolFull: true,
      after: { running: 1, pending: 2, fibers: 3 },
      values: [1, 2, 3],
      again: 'returned',
      zero: { refused: 'PoolFullError naming maxPending', pending: 0 },
      rejectRefused: 'PoolFullError',
      invalid: ['TypeError naming maxPending', 'TypeError naming maxPending', 'TypeError naming maxPending', 'TypeError naming maxPending'],
      besideReject: 'returned',
    });
  });
});
