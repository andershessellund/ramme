// Tests for runtime / interruption grants.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { current, own, promised, release, shield, sleep, wait } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { deferred, tick, trace, within } from '../support/util.js';
import { labelError as label, showError as show } from '../support/observations.js';

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

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** A handler for forks onto the bodiless root (D14). */
const quiet = { onFailure: () => {} } as const;

/** A platform timer: a foreign promise, which no delivery touches. */
function bare(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether `p` has settled after `ms` real milliseconds; a handler is attached, so a rejection is never unhandled. */
async function settledAfter(p: PromiseLike<unknown>, ms: number): Promise<'pending' | 'settled'> {
  let state: 'pending' | 'settled' = 'pending';
  p.then(
    () => void (state = 'settled'),
    () => void (state = 'settled'),
  );
  await bare(ms);
  return state;
}

/** The unhandled rejections Node reports while `fn` runs, and one macrotask after it (when Node reports them). */
async function unhandledDuring(fn: () => Promise<void>): Promise<string[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => void seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await fn();
    await tick(2);
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen.map((r) => label(r));
}

/** Read, write and commit, foreign async calls: each records its start; `read` waits for the test. */
function storage(read: Promise<string>) {
  const started: string[] = [];
  return {
    started,
    read: (): Promise<string> => {
      started.push('read');
      return read;
    },
    write: (data: string): Promise<string> => {
      started.push(`write ${data}`);
      return bare(1).then(() => `wrote ${data}`);
    },
    commit: (): Promise<string> => {
      started.push('commit');
      return bare(1).then(() => 'committed');
    },
  };
}

describe('one grant per halt (D45)', () => {
  it('the read/write/commit chain of eager waits, interrupted during read: read finishes and the body is resumed with it once; write is started by that segment’s plain code, and its wait returns the body; commit never starts; aborted', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const read = deferred<string>();
    const io = storage(read.promise);
    const root = app();
    const f = root.fork(
      task(function* chain() {
        const data = yield* wait(io.read());
        t.push(`read ${data}`);
        const written = yield* wait(io.write(data)); // after the grant: returned here, the write abandoned
        t.push(written);
        const committed = yield* wait(io.commit());
        t.push(committed);
      }, quiet),
    );
    await tick();
    f.abort(reason);
    read.resolve('row');
    const o = await within(root.result(f));
    await bare(5); // a body that went on after the halt would show here
    expect({ started: io.started, body: t.log, outcome: show(o, { reason }) }).toEqual({
      started: ['read', 'write row'],
      body: ['read row'],
      outcome: 'aborted(reason)',
    });
  });

  it('own(yield* wait(connect()), …) still attaches what connect() produced after a delivery during connect(): the grant resumes the body with it', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const connect = deferred<{ readonly id: number }>();
    const root = app();
    const f = root.fork(
      task(function* () {
        const conn = own(yield* wait(connect.promise), (c) => void t.push(`connection ${c.id} released`));
        t.push(`owned connection ${conn.id}`);
        yield* sleep(10_000);
        t.push('unreachable');
      }, quiet),
    );
    await tick();
    f.abort(reason);
    connect.resolve({ id: 1 });
    const o = await within(root.result(f));
    expect({ body: t.log, outcome: show(o, { reason }) }).toEqual({
      body: ['owned connection 1', 'connection 1 released'],
      outcome: 'aborted(reason)',
    });
  });

  it('a halted body’s second wait((signal) => fn) never calls fn: the first, in flight at the delivery, finishes and resumes the body once', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const first = deferred<string>();
    const calls: string[] = [];
    const root = app();
    const f = root.fork(
      task(function* () {
        const a = yield* wait((signal) => {
          calls.push(`first, handed a signal aborted: ${String(signal.aborted)}`);
          return first.promise; // ignores its signal: finished by the test
        });
        t.push(`got ${a}`);
        const b = yield* wait(() => {
          calls.push('second');
          return Promise.resolve('second');
        });
        t.push(`got ${b}`);
      }, quiet),
    );
    await tick();
    f.abort(reason);
    first.resolve('first');
    const o = await within(root.result(f));
    expect({ calls, body: t.log, outcome: show(o, { reason }) }).toEqual({
      calls: ['first, handed a signal aborted: false'],
      body: ['got first'],
      outcome: 'aborted(reason)',
    });
  });

  it('wait(p) after the grant abandons p: the node completes while p is pending, and p’s later rejection is handled (no unhandled rejection)', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const first = deferred<string>();
    const second = deferred<string>();
    const root = app();
    const f = root.fork(
      task(function* () {
        const a = yield* wait(first.promise);
        t.push(`got ${a}`);
        const b = yield* wait(second.promise); // after the grant: abandoned
        t.push(`got ${b}`);
      }, quiet),
    );
    let whileSecondPending: unknown;
    let outcome = '';
    const unhandled = await unhandledDuring(async () => {
      await tick();
      f.abort(reason);
      first.resolve('first');
      const done = root.result(f);
      whileSecondPending = { completion: await settledAfter(done, 20), state: f.state };
      second.reject(new Error('the abandoned wait failed late'));
      outcome = show(await within(done), { reason });
    });
    expect({ body: t.log, whileSecondPending, outcome, unhandled }).toEqual({
      body: ['got first'],
      whileSecondPending: { completion: 'settled', state: 'complete' },
      outcome: 'aborted(reason)',
      unhandled: [],
    });
  });

  it('a yield* release(x) after the grant still runs, as release work: the body waits for it and is resumed after it', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const first = deferred<string>();
    const root = app();
    const f = root.fork(
      task(function* () {
        const x = own({ name: 'x' }, function* () {
          yield* wait(bare(2));
          t.push('x released');
        });
        const a = yield* wait(first.promise);
        t.push(`got ${a}`);
        yield* release(x);
        t.push('after release(x)');
        yield* sleep(10_000);
        t.push('unreachable');
      }, quiet),
    );
    await tick();
    f.abort(reason);
    first.resolve('first');
    const o = await within(root.result(f));
    expect({ body: t.log, outcome: show(o, { reason }) }).toEqual({
      body: ['got first', 'x released', 'after release(x)'],
      outcome: 'aborted(reason)',
    });
  });

  it('a halted finally is release work and may wait: its wait(p) and its wait((signal) => p), one after the other, both finish', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const first = deferred<string>();
    const root = app();
    const f = root.fork(
      task(function* () {
        try {
          const a = yield* wait(first.promise);
          t.push(`got ${a}`);
          yield* sleep(10_000);
          t.push('unreachable');
        } finally {
          const rolledBack = yield* wait(bare(2).then(() => 'rolled back'));
          t.push(`finally: ${rolledBack}`);
          const closed = yield* wait(() => bare(2).then(() => 'closed'));
          t.push(`finally: ${closed}`);
        }
      }, quiet),
    );
    await tick();
    f.abort(reason);
    first.resolve('first');
    const o = await within(root.result(f));
    expect({ body: t.log, outcome: show(o, { reason }) }).toEqual({
      body: ['got first', 'finally: rolled back', 'finally: closed'],
      outcome: 'aborted(reason)',
    });
  });

  it('a promised body follows the same rule: its host interrupted during read, read finishes and resumes it once, write’s wait returns it, commit never starts', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const read = deferred<string>();
    const io = storage(read.promise);
    const library = (callback: () => Promise<void>): Promise<void> => callback(); // a library that calls back
    const root = app();
    const f = root.fork(
      task(function* host() {
        yield* wait(
          library(
            promised(function* transaction() {
              const data = yield* wait(io.read());
              t.push(`read ${data}`);
              const written = yield* wait(io.write(data));
              t.push(written);
              const committed = yield* wait(io.commit());
              t.push(committed);
            }),
          ),
        );
        t.push('host resumed');
      }, quiet),
    );
    await tick();
    f.abort(reason);
    read.resolve('row');
    const o = await within(root.result(f));
    await bare(5); // a callback that went on after the halt would show here
    expect({ started: io.started, body: t.log, outcome: show(o, { reason }) }).toEqual({
      started: ['read', 'write row'],
      body: ['read row'],
      outcome: 'aborted(reason)',
    });
  });

  it('a finally the grant segment enters by its own return or throw is the body’s flow, not the halted finally: its first wait(p) is abandoned and the rest of that finally never runs; the entry, cleanup’s place, is released', async () => {
    const reason = new Error('hang up');
    const root = app();
    const variant = async (ends: 'return' | 'throw'): Promise<{ log: string[]; afterCompletion: string[]; outcome: string }> => {
      const t = trace();
      const q = deferred<string>();
      const f = root.fork(
        task(function* () {
          own({}, () => void t.push('entry released'));
          try {
            const v = yield* wait(q.promise); // in flight at the delivery: the grant
            t.push(`got ${v}`);
            if (ends === 'throw') throw new Error('after the grant');
            return v;
          } finally {
            t.push('finally');
            yield* wait(bare(5).then(() => void t.push('rollback finished'))); // after the grant: abandoned
            t.push('finally end');
          }
        }, quiet),
      );
      await tick();
      f.abort(reason);
      q.resolve('q');
      const o = await within(root.result(f));
      const log = [...t.log];
      await bare(15); // the abandoned rollback settles after the node completed
      return { log, afterCompletion: t.log.slice(log.length), outcome: show(o, { reason }) };
    };
    const expected = { log: ['got q', 'finally', 'entry released'], afterCompletion: ['rollback finished'], outcome: 'aborted(reason)' };
    expect({ returned: await variant('return'), threw: await variant('throw') }).toEqual({ returned: expected, threw: expected });
  });

  it('a shield yielded after the delivery is not run: lazy, it is halted unrun after the grant and as the first op of a body delivered in its own step; release work after the delivery is the lifecycle ops', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const first = deferred<string>();
    const root = app();
    const afterGrant = root.fork(
      task(function* () {
        t.push(`after the grant: got ${yield* wait(first.promise)}`);
        yield* shield(function* () {
          t.push('after the grant: shield ran');
        });
        t.push('after the grant: unreachable');
      }, quiet),
    );
    const ownStep = root.fork(
      task(function* () {
        current().abort(reason);
        yield* shield(function* () {
          t.push('own step: shield ran');
        });
        t.push('own step: unreachable');
      }, quiet),
    );
    await tick();
    afterGrant.abort(reason);
    first.resolve('first');
    const outcomes = await within(Promise.all([root.result(afterGrant), root.result(ownStep)]));
    expect({ log: t.log, outcomes: outcomes.map((o) => show(o, { reason })) }).toEqual({
      log: ['after the grant: got first'],
      outcomes: ['aborted(reason)', 'aborted(reason)'],
    });
  });
});
