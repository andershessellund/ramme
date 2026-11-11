// Tests for runtime / interruption.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, current, lookup, never, own, race, settle, shield, signal, sleep, wait } from '../../src/ambient.js';
import type { Context, Fiber, Instruction, Op, Operation, Outcome } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { inject } from '../../src/inject.js';
import { RequestScope } from '../../src/scope.js';
import { deferred, impl, tick, trace, unhandledRejectionGuard, within } from '../support/util.js';
import type { Trace } from '../support/util.js';

/** Every `console.warn` of the current test, first argument only; the spy keeps them off the console. */
const warnings: string[] = [];

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

beforeEach(() => {
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
});

afterEach(async () => {
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

/** The development-mode warnings ramme printed during this test. */
function rammeWarnings(): string[] {
  return warnings.filter((w) => w.startsWith('ramme:'));
}

/** A platform timer: a foreign promise, which no delivery touches. */
function bare(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `f`'s outcome, read from top level. It pushes `complete` to `t` when it arrives, which is a microtask or two after the node completed. */
function completion<T>(root: Context, f: Fiber<T>, t: Trace): PromiseLike<Outcome<T>> {
  return root.result(f).then((o) => {
    t.push('complete');
    return o;
  });
}

/** The work in flight when the body is halted: a `call` that never ends on its own; `state()` reads its node's state. */
function slowTask(t?: Trace) {
  let node: Context | undefined;
  const slow = task(
    function* () {
      node = current();
      t?.push('slow running');
      yield* never();
    },
    { name: 'slow' },
  );
  return { slow, state: () => node?.state };
}

/** Whether `ancestor` is on `n`'s parent chain. */
function isBelow(n: Context, ancestor: Context): boolean {
  for (let c = n.parent; c !== undefined; c = c.parent) if (c === ancestor) return true;
  return false;
}

describe('interruption at operation boundaries', () => {
  it('1. foreign finally: a helper’s finally around a halted yield* call(t) runs once t has completed, before the node releases its entries', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const { slow, state } = slowTask(t);
    // A transaction helper, a generator helper of the body (`yield* withTx(…)`): the halt reaches its `finally`
    // through `yield*`, innermost first. Its finally does not yield, so it needs nothing of the driver.
    function* withTx<T>(fn: () => Operation<T>): Generator<Instruction, T, unknown> {
      t.push('begin');
      try {
        return yield* fn();
      } finally {
        t.push(`end; slow ${String(state())}`);
      }
    }
    const root = app();
    const f = root.fork(
      task(
        function* () {
          own(t.at('entry released'));
          return yield* withTx(() => slow());
        },
        { name: 'request', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['begin', 'slow running']); // the call is in flight
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({ log: t.log, outcome: o }).toEqual({
      log: ['begin', 'slow running', 'end; slow complete', 'entry released', 'complete'],
      outcome: { status: 'aborted', reason },
    });
    await root.close();
  });

  it('2. the halt is not an error: the body’s catch never sees it, nothing after the halted yield* runs, its finally does, and it is aborted', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const { slow, state } = slowTask(t);
    const other = task(
      function* () {
        t.push('other ran');
      },
      { name: 'other' },
    );
    let caught: unknown = 'nothing caught';
    const root = app();
    const f = root.fork(
      task(
        function* () {
          try {
            yield* slow();
            t.push('after the call');
          } catch (e) {
            caught = e; // never: the halt is a return(), not a throw
            t.push('caught');
          } finally {
            t.push(`finally; slow ${String(state())}`);
          }
          t.push('after the try');
          yield* other();
        },
        { name: 'halted', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['slow running']);
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    await bare(20); // a body that went on would show here
    expect({ log: t.log, outcome: o, caught }).toEqual({
      log: ['slow running', 'finally; slow complete', 'complete'],
      outcome: { status: 'aborted', reason },
      caught: 'nothing caught',
    });
    await root.close();
  });

  it('3. bare work after a halted wait(p): p finishes, the body runs until its next yield*, where it is returned; the owner waits for it; aborted by state, the value discarded, no warning', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const root = app();
    const f = root.fork(
      task(
        function* () {
          t.push('waiting');
          const v = yield* wait(bare(20).then(() => 'driver value')); // a driver call not handed signal()
          t.push(`bare work with ${v}`); // runs: the halt let p finish (decision 10)
          yield* sleep(1); // returned here
          t.push('unreachable');
          return 'discarded';
        },
        { name: 'bare-after-halt', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['waiting']);
    const done = completion(root, f, t);
    f.abort(reason);
    await tick(2);
    const meanwhile = [...t.log]; // not returned at the halt: still waiting for p
    const o = await within(done);
    await bare(40); // a body still running after its node completed would show here
    expect({ meanwhile, log: t.log, outcome: o, warnings: rammeWarnings() }).toEqual({
      meanwhile: ['waiting'],
      log: ['waiting', 'bare work with driver value', 'complete'],
      outcome: { status: 'aborted', reason },
      warnings: [],
    });
    await root.close();
  });

  it('3b. wait(p, { abandon: true }) stops waiting at the halt: returned at once, p left running, and its later failure handled', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const late = deferred<string>();
    const root = app();
    const f = root.fork(
      task(
        function* () {
          t.push('waiting');
          try {
            yield* wait(late.promise, { abandon: true });
            t.push('unreachable');
          } finally {
            t.push('finally');
          }
        },
        { name: 'abandons', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    const before = [...t.log];
    late.reject(new Error('late failure')); // after its waiter left: marked handled, never an unhandled rejection
    await tick(3);
    expect({ before, outcome: o, unhandled: unhandledRejectionGuard()?.seen.length ?? 0 }).toEqual({
      before: ['waiting', 'finally', 'complete'],
      outcome: { status: 'aborted', reason },
      unhandled: 0,
    });
    await root.close();
  });

  it('4. shield in the halted finally: release work runs to its end, undelivered, and the node completes after it', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const { slow } = slowTask(t);
    const inShield: { kind: string; mode: string; underBody: boolean; aborted: boolean }[] = [];
    let inFinally: Record<string, unknown> = {};
    const root = app(); // no releaseTimeoutMs: a shield's signal never fires
    const f = root.fork(
      task(
        function* () {
          const body = current();
          const look = (): void => {
            const c = current();
            inShield.push({ kind: impl(c).kind, mode: impl(c).mode, underBody: isBelow(c, body), aborted: signal().aborted });
          };
          try {
            yield* slow();
          } finally {
            // U3: the synchronous verbs address the halted node, whose signal has fired.
            inFinally = { currentIsBody: current() === body, signalAborted: signal().aborted };
            yield* shield(function* () {
              look();
              yield* sleep(5); // a release fiber's sleep runs its full duration
              look();
              t.push('rolled back');
            });
            t.push('after shield');
          }
        },
        { name: 'tx', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['slow running']);
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    const asRelease = { kind: 'release', mode: 'observe', underBody: true, aborted: false };
    expect({ log: t.log, outcome: o, inShield, inFinally }).toEqual({
      log: ['slow running', 'rolled back', 'after shield', 'complete'],
      outcome: { status: 'aborted', reason },
      inShield: [asRelease, asRelease],
      inFinally: { currentIsBody: true, signalAborted: true },
    });
    await root.close();
  });

  it('5. lease order: under the unit-of-work idiom, a helper’s finally runs before the entries, and the rollback, a generator release, runs in a release fiber', async () => {
    const t = trace();
    const reason = new Error('client hung up');

    class Conn {
      /** Answers never; rejects with the signal's reason when it aborts, as a driver handed `signal()` does. */
      query(sql: string, s: AbortSignal): Promise<void> {
        t.push(`query ${sql}`);
        return new Promise<void>((_, reject) => s.addEventListener('abort', () => reject(s.reason), { once: true }));
      }
    }
    class Lease implements Disposable {
      constructor(readonly conn: Conn) {}
      [Symbol.dispose](): void {
        t.push('lease returned');
      }
    }
    /** A synchronous acquire that attaches the lease to the owner it is given before returning (DESIGN.md §2.6, D48). */
    class DbPool {
      readonly #conn = new Conn();
      acquire(owner: Context): Lease {
        return owner.own(new Lease(this.#conn));
      }
    }
    /** A release can return a generator; the runtime drives it to completion. */
    class UnitOfWork {
      static readonly scope = RequestScope;
      readonly #node = current();
      readonly #lease = inject(DbPool).acquire(this.#node); // owned by this value's node, below the entry that commits (LIFO)
      constructor() {
        own(this, () => {
          const o = this.#node.parent!.outcome; // the request's outcome
          if (o === undefined) return this.#node.signal.aborted ? this.rollback() : this.commit();
          return o.status === 'success' ? this.commit() : this.rollback();
        });
      }
      /** A wait handed the signal() of the body that makes it: its halt aborts the query. */
      query(sql: string): Op<void> {
        return wait((s) => this.#lease.conn.query(sql, s));
      }
      *commit(): Generator<Instruction, void, unknown> {
        yield* wait(tick());
        t.push(`commit in ${impl(current()).kind}`);
      }
      *rollback(): Generator<Instruction, void, unknown> {
        yield* wait(tick());
        t.push(`rollback in ${impl(current()).kind}`);
      }
    }
    // A helper with a finally, in the request body: a mutex, a retry wrapper.
    const mutex = {
      *run<T>(fn: () => Operation<T>): Generator<Instruction, T, unknown> {
        t.push('lock');
        try {
          return yield* fn();
        } finally {
          t.push('unlock');
        }
      },
    };
    const insert = task(
      function* (uow: UnitOfWork) {
        yield* uow.query('insert');
      },
      { name: 'insert' },
    );
    const request = task(
      function* () {
        const uow = lookup(UnitOfWork); // stored on this fiber, which carries RequestScope
        return yield* mutex.run(() => insert(uow));
      },
      { name: 'request', scopes: [RequestScope], ...quiet },
    );
    const root = app();
    const f = root.fork(request);
    await tick();
    expect(t.log).toEqual(['lock', 'query insert']); // mid-query
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({ log: t.log, outcome: o }).toEqual({
      log: ['lock', 'query insert', 'unlock', 'rollback in release', 'lease returned', 'complete'],
      outcome: { status: 'aborted', reason },
    });
    await root.close();
  });

  it('6. combinators: all, race and settle take generator members, race aborts its loser, and a halt inside all() is returned once every member has stopped', async () => {
    // A generator body has no `Promise.race` to misuse: its combinators are ramme's, which follow nodes (D28).
    const boom = new Error('member failed');
    const losers: Context[] = [];
    const a = task(
      function* () {
        yield* sleep(1);
        return 'a';
      },
      { name: 'a' },
    );
    const three = task(
      function* () {
        return 3;
      },
      { name: 'three' },
    );
    const b = task(
      function* (): Generator<Instruction, string, unknown> {
        losers.push(current());
        return yield* never();
      },
      { name: 'b' },
    );
    const failing = task(
      function* (): Generator<Instruction, never, unknown> {
        yield* sleep(1);
        throw boom;
      },
      { name: 'failing' },
    );
    const root = app();
    const v = await within(
      root.call(function* () {
        const pair = yield* all([a, three]);
        const winner = yield* race([a, b]);
        const outcomes = yield* settle([a, failing]);
        return { pair, winner, outcomes, loser: losers[0]?.outcome?.status };
      }),
    );
    expect({ v, warnings: rammeWarnings() }).toEqual({
      v: {
        pair: ['a', 3],
        winner: 'a',
        outcomes: [
          { status: 'success', value: 'a' },
          { status: 'defect', error: boom },
        ],
        loser: 'aborted',
      },
      warnings: [],
    });
    await expect(root.close()).resolves.toBeUndefined(); // settle's resume step consumed the member's failure

    // Halted inside all(): call-shaped, so the body is returned once the group and its members have completed.
    const t = trace();
    const reason = new Error('hang up');
    const members: Context[] = [];
    const stuck = (name: string) =>
      task(
        function* () {
          members.push(current());
          yield* never();
        },
        { name },
      );
    const root2 = app();
    const f = root2.fork(
      task(
        function* () {
          try {
            yield* all([stuck('m1'), stuck('m2')]);
            t.push('unreachable');
          } finally {
            t.push(`finally; members ${members.map((m) => m.state).join(', ')}`);
          }
        },
        { name: 'grouped', ...quiet },
      ),
    );
    await tick();
    expect(members.length).toBe(2);
    const done = completion(root2, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({ log: t.log, outcome: o, members: members.map((m) => m.outcome) }).toEqual({
      log: ['finally; members complete, complete', 'complete'],
      outcome: { status: 'aborted', reason },
      members: [
        { status: 'aborted', reason },
        { status: 'aborted', reason },
      ],
    });
  });

  it('7. I10: work ops made and never yielded, before the delivery and in the halted finally, run nothing and are never an unhandled rejection; a work op is a plain thenable, not a Promise', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const quick = task(
      function* () {
        t.push('quick ran');
        return 'q';
      },
      { name: 'quick' },
    );
    let before: Op<void> | undefined;
    let after: Op<string> | undefined;
    const root = app();
    const f = root.fork(
      task(
        function* () {
          before = sleep(10_000); // made before the delivery and never yielded: no timer was ever armed
          try {
            yield* never();
          } finally {
            after = quick(); // made in the halted finally and never yielded: quick never runs
            t.push('body ends');
          }
        },
        { name: 'storer', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    await tick(3); // Node reports an unhandled rejection once the microtask queue drains
    const guard = unhandledRejectionGuard();
    expect({
      log: t.log,
      outcome: o,
      unhandled: (guard?.seen ?? []).map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))),
      made: [before instanceof Promise, typeof before?.[Symbol.iterator], after instanceof Promise, typeof after?.[Symbol.iterator]],
    }).toEqual({
      log: ['body ends', 'complete'],
      outcome: { status: 'aborted', reason },
      unhandled: [],
      made: [false, 'function', false, 'function'], // a plain thenable and iterable, read, never consumed
    });
    await root.close();
  });

  it('7b. I10: a wait’s function is called, and a thenable resolved, only when the wait is yielded: one made and never yielded calls nothing; the function form’s promise, rejected after the halt, ends the body and is never an unhandled rejection', async () => {
    const t = trace();
    const reason = new Error('hang up');
    /** A fetch-like driver: answers after 10 s, or rejects with the signal's reason when it aborts. */
    const fetchLike = (name: string, s: AbortSignal): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(name), 10_000);
        s.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            t.push(`${name} aborted`);
            reject(s.reason);
          },
          { once: true },
        );
      });
    /** A thenable that is no Promise: wait() wraps it in Promise.resolve, a promise only ramme holds. */
    const thenable = {
      then(_resolve: (v: string) => void, reject: (e: unknown) => void) {
        setTimeout(() => {
          t.push('thenable rejects');
          reject(new Error('thenable rejected'));
        }, 5);
      },
    } as unknown as Promise<string>;
    const root = app();
    const both = root.fork(
      task(
        function* () {
          const a = wait((s) => fetchLike('a', s));
          const b = wait((s) => fetchLike('b', s)); // its promise is ramme's alone: the user never held it
          return [yield* a, yield* b]; // a's rejection after the halt ends the body here: b is never yielded
        },
        { name: 'both', ...quiet },
      ),
    );
    const later = root.fork(
      task(
        function* () {
          const w = wait(thenable);
          yield* never(); // halted here: w is never yielded
          return yield* w;
        },
        { name: 'later', ...quiet },
      ),
    );
    await tick();
    both.abort(reason);
    later.abort(reason);
    const outcomes = await within(Promise.all([root.result(both), root.result(later)]));
    await bare(20); // the thenable rejects 5 ms after it was made
    await tick(3); // Node reports an unhandled rejection once the microtask queue drains
    const guard = unhandledRejectionGuard();
    expect({
      log: [...t.log].sort(),
      outcomes,
      unhandled: (guard?.seen ?? []).map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))),
    }).toEqual({
      log: ['a aborted'], // b's function and the thenable's then are never called
      outcomes: [
        { status: 'aborted', reason },
        { status: 'aborted', reason },
      ],
      unhandled: [],
    });
  });
});
