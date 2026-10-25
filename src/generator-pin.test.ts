// generator-pin.test.ts — the pinning tests of generator bodies (D41, PR 1: `Op`, the driver, `wait`, `promised`).
//
// Every scenario of rejection-pin.test.ts (sticky rejection, D39) and of unshield.test.ts (the shield cases),
// re-expressed for generator bodies with the generator model's expectations (D41, as the author's decisions settle
// it). A delivery halts a `freeze` or `restore` generator body: the driver calls its generator's
// `return()` at a `yield*`, so its `catch` never sees the interruption and its `finally` runs. The halt comes where
// PR #4 rejected an async body (decision 8): at once for `sleep`, `never`, `interrupted`, a join of a fiber not
// subscribed below, `wait(p, { abandon: true })` and a wait for the node's own completion; once the awaited fiber has
// completed for `call`, `attempt`, `all`, `race`, `settle` and a join of a fiber subscribed below; and after release
// work and `wait(p)`, which finish, at the next `yield*`. A `yield*` in the body's own `finally` during a halt is
// release work, run to its end under an unwind fiber of the node, while the synchronous verbs still address the node
// (U3). The outcome is `aborted` by state whatever the generator then does (D24).
//
// Since PR 2 work ops are lazy (decision 2): an op runs when it is yielded, for the yielding body, so an op made and
// never yielded runs nothing, and a body that finds its node delivered at a `yield*` of an op not yet started is
// returned there without running it. The tests PR 1 marked "transitional" (eager ops, lending) are restated for that.
//
// Each test first compares one observation object, so that a failure shows the whole of the behaviour in its diff,
// and checks classes only afterwards.
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
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
  promised,
  race,
  release,
  result,
  settle,
  shield,
  signal,
  sleep,
  unshield,
  wait,
} from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber, Instruction, Op, Operation, Outcome, Task } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { inject } from './inject.js';
import { valueProvider } from './provider-util.js';
import { FiberAbortedError, NoCurrentNodeError } from './resource.js';
import { RequestScope } from './scope.js';
import { deferred, events, impl, tick, trace, unhandledRejectionGuard, within } from './test/util.js';
import type { Trace } from './test/util.js';

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

/** `.reason` of an error (FiberAbortedError) or of an outcome; `undefined` for anything else. */
function reasonOf(x: unknown): unknown {
  return typeof x === 'object' && x !== null ? (x as { reason?: unknown }).reason : undefined;
}

type Settlement = { state: 'pending' } | { state: 'fulfilled'; value: unknown } | { state: 'rejected'; error: unknown };

/** How `p` has settled after `ms` real milliseconds; read from top level. */
async function settlement(p: PromiseLike<unknown>, ms = 20): Promise<Settlement> {
  let s: Settlement = { state: 'pending' };
  p.then(
    (value) => void (s = { state: 'fulfilled', value }),
    (error: unknown) => void (s = { state: 'rejected', error }),
  );
  await bare(ms);
  return s;
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

/** A generator function that yields something other than an op, typed as a body: what untyped code can pass. */
function untyped<T>(g: () => Generator<unknown, T, unknown>): () => Generator<Instruction, T, unknown> {
  return g as unknown as () => Generator<Instruction, T, unknown>;
}

describe('generator bodies: the pinning tests (rejection-pin.test.ts 1–7, re-expressed)', () => {
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
          return yield* withTx(() => call(slow));
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
            yield* call(slow);
            t.push('after the call');
          } catch (e) {
            caught = e; // never: the halt is a return(), not a throw
            t.push('caught');
          } finally {
            t.push(`finally; slow ${String(state())}`);
          }
          t.push('after the try');
          yield* call(other);
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
            yield* wait(late.promise, { abandon: true }); // PR #4's managed(p)
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
            yield* call(slow);
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
    /** A synchronous acquire that attaches the lease to `owner` before returning (DESIGN.md §2.6). */
    class DbPool {
      readonly #conn = new Conn();
      acquire(owner: Context = current()): Lease {
        return owner.own(new Lease(this.#conn));
      }
    }
    /** README's UnitOfWork, its commit and rollback generator methods: the release returns one, and it is driven. */
    class UnitOfWork {
      static readonly scope = RequestScope;
      readonly #node = current();
      readonly #lease = inject(DbPool).acquire(); // owned by this value's node, below the entry that commits (LIFO)
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
        return yield* mutex.run(() => call(insert, uow));
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
            after = call(quick); // made in the halted finally and never yielded: quick never runs
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

describe('generator bodies: the halted finally, and the halt’s other shapes', () => {
  it('a finally in the body may yield*: after a call-shaped halt has completed, its call and its sleep run to their end as release work, under an unwind fiber of the node, while the synchronous verbs address the node (U3)', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const K = createInjectionKey<string>('K');
    const { slow, state } = slowTask(t);
    let cleanupNode: Context | undefined;
    const cleanup = task(
      function* () {
        cleanupNode = current();
        yield* sleep(5); // not halted: its parent, the unwind fiber, is never delivered
        t.push('cleanup slept');
        return 'ok';
      },
      { name: 'cleanup' },
    );
    let inFinally: Record<string, unknown> = {};
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    roots.push(root);
    const f = root.fork(
      task(
        function* () {
          const body = current();
          try {
            yield* call(slow);
          } finally {
            t.push(`finally; slow ${String(state())}`);
            inFinally = { currentIsBody: current() === body, signalAborted: signal().aborted, lookup: lookup(K) };
            const v = yield* call(cleanup);
            t.push(`cleanup returned ${v}`);
            yield* sleep(5);
            t.push('slept in the finally');
          }
        },
        { name: 'tx', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    const unwind = cleanupNode?.parent;
    expect({
      log: t.log,
      outcome: o,
      inFinally,
      cleanup: { delivered: cleanupNode?.signal.aborted, outcome: cleanupNode?.outcome },
      unwindFiber: {
        kind: unwind === undefined ? undefined : impl(unwind).kind,
        mode: unwind === undefined ? undefined : impl(unwind).mode,
        ownedByBody: unwind?.parent === f,
      },
    }).toEqual({
      log: ['slow running', 'finally; slow complete', 'cleanup slept', 'cleanup returned ok', 'slept in the finally', 'complete'],
      outcome: { status: 'aborted', reason },
      inFinally: { currentIsBody: true, signalAborted: true, lookup: 'k' },
      cleanup: { delivered: false, outcome: { status: 'success', value: 'ok' } },
      unwindFiber: { kind: 'release', mode: 'observe', ownedByBody: true },
    });
    await root.close();
  });

  it('decision 29: a yield* in a helper’s finally loses the halt; the body runs on past it, as release work, and the dev mode reports the lost halt', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const { slow } = slowTask(t);
    const charge = task(
      function* () {
        yield* sleep(1); // run to its end: a child of the unwind fiber, not born delivered
        t.push('charge ran to its end');
      },
      { name: 'charge' },
    );
    /** A helper whose finally waits: by the yield* algorithm its caller is resumed normally once that finally ends. */
    function* withCleanup(): Generator<Instruction, string, unknown> {
      try {
        yield* call(slow);
        return 'done';
      } finally {
        yield* wait(tick());
        t.push('helper cleanup done');
      }
    }
    const root = app();
    const f = root.fork(
      task(
        function* () {
          yield* withCleanup();
          t.push('body continued past the halt');
          yield* call(charge);
          return 'lost';
        },
        { name: 'lossy', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({
      log: t.log,
      outcome: o,
      warnings: rammeWarnings().map((w) => /halt/i.test(w) && w.includes('lossy')),
    }).toEqual({
      log: ['slow running', 'helper cleanup done', 'body continued past the halt', 'charge ran to its end', 'complete'],
      outcome: { status: 'aborted', reason }, // by state (D24), whatever the generator returned
      warnings: [true], // one report, naming the body
    });
    await root.close();
  });

  it('decision 29: after a lost halt the helper’s yield* gives the body the halt’s sentinel, and in dev mode any use of it reports the lost halt, once: rows.map, whose throw is discarded, and String(rows) followed by return rows', async () => {
    const t = trace();
    const reason = new Error('hang up');
    /** A helper whose finally waits: its caller gets the halt's sentinel as the value of the yield*. */
    function* query(): Generator<Instruction, string[], unknown> {
      try {
        yield* never();
        return ['a'];
      } finally {
        yield* wait(bare(5));
      }
    }
    const root = app();
    const mapper = root.fork(
      task(
        function* () {
          const rows = yield* query();
          t.push('mapper ran more work');
          return rows.map((r) => r.toUpperCase()); // a TypeError, discarded: the node is aborted by state
        },
        { name: 'mapper', ...quiet },
      ),
    );
    const passer = root.fork(
      task(
        function* () {
          const rows = yield* query();
          t.push(`passer continued with a ${typeof String(rows)}`);
          yield* sleep(1);
          t.push('passer ran more work');
          return rows; // the sentinel itself: no other value to report
        },
        { name: 'passer', ...quiet },
      ),
    );
    await tick();
    mapper.abort(reason);
    passer.abort(reason);
    const outcomes = await within(Promise.all([root.result(mapper), root.result(passer)]));
    expect({
      log: [...t.log].sort(),
      outcomes: outcomes.map((o) => o.status),
      warned: ['mapper#', 'passer#'].map((n) => rammeWarnings().filter((w) => /halt .* was lost/.test(w) && w.includes(n)).length),
      warnings: rammeWarnings().length,
    }).toEqual({
      log: ['mapper ran more work', 'passer continued with a string', 'passer ran more work'],
      outcomes: ['aborted', 'aborted'],
      warned: [1, 1],
      warnings: 2,
    });
  });

  it('decision 12: a yield* in the halted finally whose wait includes the node itself or an ancestor returns the generator there, with a dev-mode warning, instead of deadlocking the unwind', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const { slow } = slowTask();
    const root = app();
    const shape = (owner: Context, name: string, op: () => Op<void>) =>
      owner.fork(
        task(
          function* () {
            try {
              yield* call(slow);
            } finally {
              t.push(`${name}: finally starts`);
              yield* op();
              t.push(`${name}: unreachable`);
            }
          },
          { name, ...quiet },
        ),
      );
    const self = shape(root, 'self-dispose', () => current()[Symbol.asyncDispose]()); // current() is the node (U3)
    const entry = shape(root, 'own-entry', () => root.release(current())); // its own entry on root
    const svc = root.child({ name: 'svc' });
    const ancestor = shape(svc, 'ancestor-close', () => svc.close()); // its owner's completion waits for it
    const fibers = [self, entry, ancestor];
    await tick();
    for (const x of fibers) x.abort(reason);
    const outcomes = await within(Promise.all(fibers.map((x) => root.result(x))));
    expect({
      log: [...t.log].sort(),
      outcomes: outcomes.map((o) => o.status),
      warned: ['self-dispose', 'own-entry', 'ancestor-close'].map((n) => rammeWarnings().filter((w) => w.includes(n)).length),
      warnings: rammeWarnings().length,
    }).toEqual({
      log: ['ancestor-close: finally starts', 'own-entry: finally starts', 'self-dispose: finally starts'],
      outcomes: ['aborted', 'aborted', 'aborted'],
      warned: [1, 1, 1],
      warnings: 3,
    });
    await within(svc.close());
    expect(svc.state).toBe('complete');
  });

  it('decision 12: in the halted finally a join or result of a fork the node owns, which no delivery reaches and only the node’s own release ends, returns the generator there with the warning instead of deadlocking every owner; an owned fork that has completed gives its value', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const root = app();
    const server = task(
      function* () {
        yield* never(); // ends only when its owner releases it
      },
      { name: 'server' },
    );
    const shape = (name: string, waitFor: (srv: Fiber<void>) => Op<unknown>) =>
      root.fork(
        task(
          function* () {
            const srv = own(fork(server)); // owned: unsubscribed, released with the node, after its finally
            try {
              yield* never();
            } finally {
              t.push(`${name}: finally`);
              try {
                yield* waitFor(srv);
              } catch {
                t.push(`${name}: caught`);
              }
              t.push(`${name}: unreachable`);
            }
          },
          { name, ...quiet },
        ),
      );
    const joiner = shape('joiner', (srv) => join(srv));
    const resulter = shape('resulter', (srv) => result(srv));
    const flusher = root.fork(
      task(
        function* () {
          const flush = own(
            fork(
              task(function* () {
                return 'flushed'; // completes on its own, before the halt
              }),
            ),
          );
          try {
            yield* never();
          } finally {
            t.push(`flusher: ${yield* join(flush)}`);
          }
        },
        { name: 'flusher', ...quiet },
      ),
    );
    const fibers = [joiner, resulter, flusher];
    await tick();
    for (const f of fibers) f.abort(reason);
    const outcomes = await within(Promise.all(fibers.map((f) => root.result(f))));
    expect({
      log: [...t.log].sort(),
      outcomes: outcomes.map((o) => o.status),
      warned: ['joiner#', 'resulter#', 'flusher#'].map((n) => rammeWarnings().filter((w) => w.includes(n)).length),
    }).toEqual({
      log: ['flusher: flushed', 'joiner: finally', 'resulter: finally'],
      outcomes: ['aborted', 'aborted', 'aborted'],
      warned: [1, 1, 0],
    });
  });

  it('wait((signal) => p) hands the work the body’s signal(): the halt aborts it, its rejection ends the body with no catch run, and it is never an unhandled rejection', async () => {
    const t = trace();
    const reason = new Error('navigated away');
    let handed: AbortSignal | undefined;
    let caught: unknown = 'nothing caught';
    /** A fetch-like driver: answers after 10 s, or rejects with the signal's reason when it aborts. */
    const fetchLike = (url: string, s: AbortSignal): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        handed = s;
        t.push(`fetch ${url}`);
        const timer = setTimeout(() => resolve('body'), 10_000);
        s.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            t.push('fetch aborted');
            reject(s.reason);
          },
          { once: true },
        );
      });
    const root = app();
    const f = root.fork(
      task(
        function* () {
          try {
            const body = yield* wait((s) => fetchLike('/search?q=x', s));
            t.push(`got ${body}`);
          } catch (e) {
            caught = e;
          } finally {
            t.push('finally');
          }
        },
        { name: 'search', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({ log: t.log, outcome: o, caught, handedIsBodySignal: handed === f.signal }).toEqual({
      log: ['fetch /search?q=x', 'fetch aborted', 'finally', 'complete'],
      outcome: { status: 'aborted', reason },
      caught: 'nothing caught',
      handedIsBodySignal: true,
    });
    await root.close();
  });

  it('a body born delivered is stepped to its first yield*: a wait(p, { abandon: true }) there, started when made, returns it at once, p left running and its later rejection handled; a call yielded after the delivery is not run (decision 9, row 5)', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const p = deferred<string>();
    let runs = 0;
    let bornNode: Context | undefined;
    let bornDelivered: boolean | undefined;
    const born = task(
      function* () {
        runs++;
        bornNode = current();
        bornDelivered = signal().aborted;
        t.push('born: first step');
        try {
          yield* wait(p.promise, { abandon: true }); // started: subscribed, so p is handled, and returned at once
          t.push('born: unreachable');
        } finally {
          t.push('born: finally');
        }
      },
      { name: 'born' },
    );
    const root = app();
    const f = root.fork(
      task(
        function* () {
          yield* wait(bare(20)); // halted meanwhile: p finishes and the body is resumed, its node delivered
          t.push('resumed');
          fork(born); // a freeze child of a delivered node: born delivered (D12); fork is eager
          yield* call(born); // not started: the parent is returned here, and born runs once
          t.push('unreachable');
        },
        { name: 'parent', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    p.reject(new Error('late')); // handled: the abandoned wait subscribed to p before it was returned
    await tick(3);
    expect({
      log: t.log,
      outcome: o,
      runs,
      bornDelivered,
      born: bornNode?.outcome,
      unhandled: (unhandledRejectionGuard()?.seen ?? []).length,
    }).toEqual({
      log: ['resumed', 'born: first step', 'born: finally', 'complete'],
      outcome: { status: 'aborted', reason },
      runs: 1,
      bornDelivered: true,
      born: { status: 'aborted', reason },
      unhandled: 0,
    });
    await root.close();
  });

  it('modes: an observe generator body is never halted, hears the delivery through interrupted() and settles with its own result; a restore body is halted as a freeze one is', async () => {
    const t = trace();
    const reason = new Error('hang up');
    let window: Outcome<void> | undefined;
    const root = app();
    const observer = root.fork(
      task(
        function* () {
          window = yield* attempt(
            task(
              function* () {
                try {
                  yield* never();
                  t.push('restore child: went on past the halt'); // a halt runs nothing after the yield*
                } catch (e) {
                  t.push(`restore child: caught ${(e as Error).name}`); // nor any catch: the halt is no error
                } finally {
                  t.push('restore child: finally');
                }
              },
              { name: 'window', interrupt: 'restore' }, // hears every delivery on its subscription path
            ),
          );
          const why = yield* interrupted(); // already delivered: resolves at once
          t.push(`observer heard ${String(why === reason)}; signal ${String(signal().aborted)}`);
          yield* sleep(5); // runs its full duration
          t.push('observer slept');
          return 'observed';
        },
        { name: 'observer', interrupt: 'observe', ...quiet },
      ),
    );
    await tick();
    observer.abort(reason);
    const o = await within(root.result(observer));
    expect({ log: t.log, outcome: o, window }).toEqual({
      log: ['restore child: finally', 'observer heard true; signal true', 'observer slept'],
      outcome: { status: 'success', value: 'observed' },
      window: { status: 'aborted', reason },
    });
  });

  it('a yielded value that is not an op (`yield op` without the star, or any other value) is a TypeError thrown into the generator at that yield', async () => {
    const caught: string[] = [];
    const root = app();
    const v = await within(
      root.call(
        task(
          untyped(function* () {
            for (const x of [42, sleep(1)]) {
              try {
                yield x;
              } catch (e) {
                caught.push(e instanceof TypeError ? 'TypeError' : String(e));
              }
            }
            return 'went on';
          }),
          { name: 'yields-values' },
        ),
      ),
    );
    expect({ v, caught }).toEqual({ v: 'went on', caught: ['TypeError', 'TypeError'] });
  });

  it('a generator release runs in its release fiber, current across its yields, its sleep the full duration; a generator failure handler runs with the parent current across its yields and holds the parent until it ends: the parent’s body returns and its entries are released meanwhile, and it completes after the handler', async () => {
    const t = trace();
    const err = new Error('worker failed');
    const handled: unknown[] = [];
    const handlerStarted = deferred();
    const root = app();
    const f = root.fork(
      task(
        function* () {
          const parent = current();
          own({ name: 'conn' }, function* (c) {
            const n = current();
            yield* wait(tick());
            t.push(`release of ${c.name} in ${impl(n).kind}; still current ${String(current() === n)}`);
            yield* sleep(5); // a release fiber's sleep runs its full duration
            t.push('release slept');
          });
          fork(
            task(
              function* (): Generator<Instruction, never, unknown> {
                yield* sleep(1);
                throw err;
              },
              {
                name: 'worker',
                onFailure: function* (e) {
                  handled.push(e);
                  t.push(`handler: parent current ${String(current() === parent)}`);
                  handlerStarted.resolve(); // the body returns now: only the hold keeps the parent open from here on
                  yield* sleep(30); // a handler's sleep runs its full duration, outlasting the conn's release
                  t.push(`handler slept; parent current ${String(current() === parent)}`);
                  t.push(
                    yield* call(function* () {
                      return 'handler called'; // a call from a handler, which nothing halts
                    }),
                  );
                },
              },
            ),
          );
          yield* wait(handlerStarted.promise);
          t.push('body returns');
          return 'done';
        },
        { name: 'owner', ...quiet },
      ),
    );
    const o = await within(completion(root, f, t));
    expect({ log: t.log, outcome: o, handled }).toEqual({
      log: [
        'handler: parent current true',
        'body returns',
        'release of conn in release; still current true', // the hold delays the completion, not the entries' release
        'release slept',
        'handler slept; parent current true',
        'handler called',
        'complete',
      ],
      outcome: { status: 'success', value: 'done' },
      handled: [err],
    });
  });

  it('attempt of a generator task resolves with its outcome, a failure consumed; an interrupted caller is returned once the child has completed and never sees one', async () => {
    const boom = new Error('boom');
    const double = task(
      function* (n: number) {
        yield* sleep(1);
        return n * 2;
      },
      { name: 'double' },
    );
    const failing = task(
      function* (): Generator<Instruction, number, unknown> {
        yield* sleep(1);
        throw boom;
      },
      { name: 'failing' },
    );
    const stuck = task(
      function* (): Generator<Instruction, number, unknown> {
        return yield* never();
      },
      { name: 'stuck', timeoutMs: 10 },
    );
    const root = app();
    const outcomes = await within(
      root.call(function* () {
        return [yield* attempt(double, 21), yield* failing.attempt(), yield* attempt(stuck)];
      }),
    );
    const timedOut = (o: Outcome<number>): unknown => (o.status === 'aborted' ? `aborted: ${(o.reason as Error).name}` : o);
    expect(outcomes.map(timedOut)).toEqual([{ status: 'success', value: 42 }, { status: 'defect', error: boom }, 'aborted: TimeoutError']);
    await expect(root.close()).resolves.toBeUndefined(); // attempt's resume step consumed the failure

    const t = trace();
    const reason = new Error('hang up');
    const { slow, state } = slowTask(t);
    let seen: unknown = 'no outcome';
    const root2 = app();
    const f = root2.fork(
      task(
        function* () {
          try {
            seen = yield* attempt(slow);
          } finally {
            t.push(`finally; slow ${String(state())}`);
          }
        },
        { name: 'caller', ...quiet },
      ),
    );
    await tick();
    f.abort(reason);
    const o = await within(root2.result(f));
    expect({ log: t.log, seen, outcome: o }).toEqual({
      log: ['slow running', 'finally; slow complete'],
      seen: 'no outcome', // aborted would describe the child; the caller's own interruption is never a value (D31)
      outcome: { status: 'aborted', reason },
    });
  });

  it('types: yield* infers through verbs, generator helpers and tasks; a generator is an Operation; an op is awaitable; promised keeps the arguments', () => {
    // Never run: the generators below are only type-checked (vitest's expectTypeOf is a no-op at run time).
    function* double(n: number) {
      yield* sleep(0);
      return n * 2;
    }
    const byLength = task(function* (id: string) {
      const n = yield* double(id.length);
      return `${id}:${n}`;
    });
    const returnsOp = task(() => call(byLength, 'x')); // a synchronous body returning an op (decision 28)
    const asyncBody = task(function* (n: number) { return n + 1; }); // still accepted in PR 1
    const throws = task(function* (): Generator<Instruction, never, unknown> {
      throw new Error('never returns'); // T is never, not the generator object
    });
    expectTypeOf(double).returns.toEqualTypeOf<Generator<Instruction, number, unknown>>();
    expectTypeOf(throws).toEqualTypeOf<Task<[], never>>();
    expectTypeOf(double(1)).toExtend<Operation<number>>();
    expectTypeOf(byLength).toEqualTypeOf<Task<[id: string], string>>();
    expectTypeOf(returnsOp).toEqualTypeOf<Task<[], string>>();
    expectTypeOf(asyncBody).toEqualTypeOf<Task<[n: number], number>>();
    expectTypeOf<Awaited<Op<number>>>().toEqualTypeOf<number>();
    // Operation<T> annotates a helper that is only yield*ed: Body has no Operation<T> arm (D41's settled note), so a
    // helper a body returns, or a body that needs an annotation, is typed Generator<Instruction, T, unknown>.
    function* annotated(n: number): Operation<string> {
      yield* sleep(n);
      return String(n);
    }
    function* typed(n: number): Generator<Instruction, string, unknown> {
      return yield* annotated(n); // yield* of an Operation-annotated helper infers its T
    }
    // @ts-expect-error an Operation-annotated helper returned by a body
    task(() => annotated(1));
    // @ts-expect-error a body annotated Operation<T>
    task(function* (): Operation<number> {
      yield* sleep(0);
      return 1;
    });
    expectTypeOf(task(() => typed(1))).toEqualTypeOf<Task<[], string>>();
    expectTypeOf(
      task(function* (): Generator<Instruction, number, unknown> {
        yield* sleep(0);
        return 1;
      }),
    ).toEqualTypeOf<Task<[], number>>();
    function* probe() {
      expectTypeOf(call(byLength, 'x')).toEqualTypeOf<Op<string>>();
      expectTypeOf(yield* call(byLength, 'x')).toEqualTypeOf<string>();
      expectTypeOf(yield* attempt(byLength, 'x')).toEqualTypeOf<Outcome<string, never>>(); // E = never: byLength yields no fail (D42)
      expectTypeOf(yield* all([byLength.bind('x'), asyncBody.bind(1)])).toEqualTypeOf<[string, number]>();
      expectTypeOf(yield* wait(Promise.resolve(1))).toEqualTypeOf<number>();
      expectTypeOf(yield* wait((s: AbortSignal) => Promise.resolve(String(s.aborted)))).toEqualTypeOf<string>();
      const cb = promised(function* (tx: string) {
        yield* sleep(0);
        return tx.length;
      });
      expectTypeOf(cb).parameters.toEqualTypeOf<[tx: string]>();
      expectTypeOf(cb).returns.toEqualTypeOf<Promise<number>>();
    }
    expect(typeof probe).toBe('function');
  });
});

describe('generator bodies: promised', () => {
  it('promised: a real Promise per call, a call-shaped child of the node captured at creation, started synchronously; its value, its failure consumed, NoCurrentNodeError outside any node', async () => {
    const boom = new Error('boom');
    let outside: unknown;
    try {
      promised(function* () {
        return 1;
      });
    } catch (e) {
      outside = e;
    }
    const root = app();
    const inc = root.promised(function* (x: number) {
      // ctx.promised names the node explicitly, for a module-level entry point
      yield* sleep(1);
      return x + 1;
    });
    const p = inc(1);
    const fails = root.promised(function* (): Generator<Instruction, never, unknown> {
      yield* sleep(1);
      throw boom;
    });
    const failure = await within(fails().then(() => 'resolved', (e: unknown) => e));
    let inBody: Record<string, unknown> = {};
    await within(
      root.call(function* () {
        const node = current();
        let started = false;
        let childParent: Context | undefined;
        const cb = promised(function* (n: number) {
          started = true;
          childParent = current().parent;
          yield* wait(tick());
          return n * 2;
        });
        const q = cb(21);
        const startedSync = started; // synchronous start
        let forked = 'not forked';
        try {
          fork(function* () {
            return 'x';
          });
          forked = 'forked'; // nothing lent
        } catch (e) {
          forked = (e as Error).name;
        }
        inBody = {
          startedSync,
          childOfCapturedNode: childParent === node,
          forked,
          real: Object.getPrototypeOf(q) === Promise.prototype,
          value: yield* wait(q),
        };
      }),
    );
    expect({
      outside: outside instanceof NoCurrentNodeError,
      real: Object.getPrototypeOf(p) === Promise.prototype,
      value: await within(p),
      failure,
      inBody,
    }).toEqual({
      outside: true,
      real: true,
      value: 2,
      failure: boom,
      inBody: { startedSync: true, childOfCapturedNode: true, forked: 'forked', real: true, value: 42 },
    });
    await expect(root.close()).resolves.toBeUndefined(); // the failure was the promise's: consumed, nothing surfaces
  });

  it('promised inside a foreign transaction helper, halted mid-way: the library’s finally runs once the callback’s work has stopped, the callback’s promise rejects with FiberAbortedError, and the body ends aborted after it', async () => {
    const t = trace();
    const reason = new Error('client hung up');
    type Tx = { readonly id: number };
    let insertNode: Context | undefined;
    let callbackNode: Context | undefined;
    let libraryCaught: unknown;
    /** A driver's `transaction(fn)`: plain async code around the callback, as Prisma's, Knex's and Drizzle's are. */
    const db = {
      async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
        t.push('BEGIN');
        try {
          const v = await fn({ id: 1 });
          t.push('COMMIT');
          return v;
        } catch (e) {
          libraryCaught = e;
          t.push(`ROLLBACK; insert ${String(insertNode?.state)}`);
          throw e;
        } finally {
          t.push('connection returned');
        }
      },
    };
    const insert = task(
      function* (tx: Tx) {
        insertNode = current();
        t.push(`insert in tx ${tx.id}`);
        yield* never();
      },
      { name: 'insert' },
    );
    const root = app();
    const f = root.fork(
      task(
        function* () {
          own(t.at('entry released'));
          return yield* wait(
            db.transaction(
              promised(function* (tx: Tx) {
                callbackNode = current();
                yield* call(insert, tx);
                return 'saved';
              }),
            ),
          );
        },
        { name: 'save', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['BEGIN', 'insert in tx 1']);
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({
      log: t.log,
      outcome: o,
      callback: callbackNode?.outcome,
      callbackParentIsBody: callbackNode?.parent === f,
      libraryCaught: reasonOf(libraryCaught),
      warnings: rammeWarnings(),
    }).toEqual({
      log: ['BEGIN', 'insert in tx 1', 'ROLLBACK; insert complete', 'connection returned', 'entry released', 'complete'],
      outcome: { status: 'aborted', reason },
      callback: { status: 'aborted', reason },
      callbackParentIsBody: true,
      libraryCaught: reason,
      warnings: [],
    });
    expect(libraryCaught).toBeInstanceOf(FiberAbortedError);
    await root.close();
  });
});

describe('generator bodies: the amendments (D39 settled notes, re-expressed)', () => {
  it('A.2: after a halted call the finally runs lookup, fork, shield and call, the callee complete; a fork there is born delivered (it addresses the node, U3), a shield and a call are release work', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const K = createInjectionKey<string>('K');
    const { slow, state } = slowTask(t);
    let inFinally: Record<string, unknown> = {};
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    roots.push(root);
    const f = root.fork(
      task(
        function* () {
          try {
            yield* call(slow);
          } finally {
            inFinally = {
              callee: state(),
              lookup: lookup(K),
              forkBornDelivered: fork(function* () {
                return 'forked';
              }).signal.aborted,
              shield: yield* shield(function* () {
                return lookup(K);
              }),
              call: yield* call(function* () {
                yield* sleep(1);
                return `called; delivered ${String(signal().aborted)}`;
              }),
            };
          }
        },
        { name: 'request', ...quiet },
      ),
    );
    await tick();
    f.abort(reason);
    const o = await within(root.result(f));
    expect({ log: t.log, outcome: o, inFinally }).toEqual({
      log: ['slow running'],
      outcome: { status: 'aborted', reason },
      inFinally: { callee: 'complete', lookup: 'k', forkBornDelivered: true, shield: 'k', call: 'called; delivered false' },
    });
    await root.close();
  });

  it('A.2, with lazy ops: a call of an observe task yielded after a halted wait(p) resumed the body is not run; a join of an observe fork made then returns the body at once, the fork undelivered, which hears the interruption when the body’s exit interrupts it', async () => {
    const logs: Record<string, readonly string[]> = {};
    for (const shape of ['call', 'join'] as const) {
      const t = trace();
      const reason = new Error('hang up');
      let drained: Context | undefined;
      const drain = task(
        function* () {
          drained = current();
          t.push('drain started');
          const r = yield* interrupted(); // an observe body: resolves when its parent's exit delivers it
          t.push(`drain heard the reason: ${String(r === reason)}`);
        },
        { name: 'drain', interrupt: 'observe' }, // not born delivered (D12)
      );
      const root = app();
      const f = root.fork(
        task(
          function* () {
            let forked: Fiber<void> | undefined;
            try {
              yield* wait(bare(20)); // halted meanwhile: resumed when p finishes
              t.push('resumed');
              if (shape === 'call') yield* call(drain); // not started: returned here, drain never runs
              else yield* join((forked = fork(drain))); // fork is eager; the join is not started: returned here
              t.push('unreachable');
            } finally {
              const d = forked ?? drained;
              t.push(`finally; drain ${String(d?.state)}, delivered ${String(d?.signal.aborted)}, ${String(d?.outcome?.status)}`);
            }
          },
          { name: 'request', ...quiet },
        ),
      );
      await tick();
      f.abort(reason);
      const o = await within(root.result(f));
      t.push(o.status);
      logs[shape] = t.log;
    }
    expect(logs).toEqual({
      call: ['resumed', 'finally; drain undefined, delivered undefined, undefined', 'aborted'],
      // The return is a job queued after the fork's start: the fork runs first, undelivered (an observe child)
      join: ['resumed', 'drain started', 'finally; drain running, delivered false, undefined', 'drain heard the reason: true', 'aborted'],
    });
  });

  it('A.3: a halted body yields release(tx) in its finally, whose rollback, a generator release, throws; it catches that: the outcome is failure carrying the release error, reported once', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const rollbackError = new Error('rollback failed');
    const { slow } = slowTask(t);
    const failures: unknown[] = [];
    let fromRelease: unknown;
    const root = app();
    const f = root.fork(
      task(
        function* () {
          const tx = own({}, function* () {
            yield* wait(tick());
            throw rollbackError;
          });
          try {
            yield* call(slow);
          } finally {
            try {
              yield* release(tx); // release work under the unwind fiber: its failure is thrown in, not consumed
            } catch (r) {
              fromRelease = r;
            }
          }
        },
        { name: 'tx', onFailure: (e) => void failures.push(e) },
      ),
    );
    await tick();
    f.abort(reason);
    const o = await within(root.result(f));
    expect({ outcome: o, fromRelease, failures }).toEqual({
      outcome: { status: 'defect', error: rollbackError }, // aborted + the unconsumed release failure (D24)
      fromRelease: rollbackError,
      failures: [rollbackError],
    });
    await expect(root.close()).resolves.toBeUndefined(); // once: the handler had it
  });

  it('A.3: in its halted finally a body may yield [Symbol.asyncDispose]() and close() of nodes below it: release work; a close() of an unsubscribed pool is a drain as long as its work', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const gate = deferred();
    const { slow } = slowTask(t);
    const root = app();
    const f = root.fork(
      task(
        function* () {
          const jobs = pool({ name: 'jobs', onFailure: () => {} }); // unsubscribed: not delivered with the body (D15)
          jobs.fork(function* () {
            yield* wait(gate.promise);
            t.push('job finished');
          });
          const scope = child({ name: 'scope' });
          scope.own(() => void t.push('scope released'));
          try {
            yield* call(slow);
          } finally {
            yield* scope[Symbol.asyncDispose]();
            t.push('scope disposed');
            yield* jobs.close(); // a graceful drain
            t.push('pool drained');
          }
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    f.abort(reason);
    await tick(3);
    expect(t.log).toEqual(['slow running', 'scope released', 'scope disposed']); // the drain waits for its job
    gate.resolve();
    const o = await within(root.result(f));
    expect({ log: t.log, outcome: o }).toEqual({
      log: ['slow running', 'scope released', 'scope disposed', 'job finished', 'pool drained'],
      outcome: { status: 'aborted', reason },
    });
    await root.close();
  });

  it('A.3: a body that yields its own current()[Symbol.asyncDispose](), an ancestor’s, the release of its own entry, or its owner’s releaseAll() that releases it, is returned there, not waited for, no catch run, and completes aborted', async () => {
    const ran: string[] = [];
    const caught: unknown[] = [];
    const root = app();
    const body = (name: string, op: () => Op<void>) =>
      task(
        function* () {
          try {
            yield* op();
          } catch (e) {
            caught.push(e);
          } finally {
            ran.push(name);
          }
        },
        { name, ...quiet },
      );
    const selfRelease = root.fork(body('self-release', () => root.release(current()))); // waits for this body's completion
    const self = root.fork(body('self', () => current()[Symbol.asyncDispose]()));
    const svc = root.child({ name: 'svc' });
    const shutdown = svc.fork(body('shutdown', () => svc[Symbol.asyncDispose]())); // a shutdown fork awaiting its own owner
    const owner = root.child({ name: 'owner' });
    const drain = owner.fork(body('self-releaseAll', () => owner.releaseAll())); // releases this fork too, and waits for its completion
    const outcomes = await within(
      Promise.all([root.result(selfRelease), root.result(self), root.result(shutdown), root.result(drain)]),
    );
    expect({ outcomes: outcomes.map((o) => o.status), ran: [...ran].sort(), caught, svc: svc.state }).toEqual({
      outcomes: ['aborted', 'aborted', 'aborted', 'aborted'],
      ran: ['self', 'self-release', 'self-releaseAll', 'shutdown'],
      caught: [],
      svc: 'complete',
    });
    await root.close();
  });

  it('A.4, with lazy ops: a shield nobody yields runs nothing: its body never runs, and the owner releases and completes without it; one run through then holds its owner: its lookup after a tick finds the value still live, the owner completes after it, and its failure is consumed by that then, so the owner succeeds', async () => {
    const t = trace();
    const shieldError = new Error('cleanup failed');
    class Conn {
      static readonly scope = RequestScope;
      constructor() {
        own(() => void t.push('conn released'));
      }
    }
    const failures: unknown[] = [];
    const root = app();
    const f = root.fork(
      task(
        function* () {
          const conn = lookup(Conn); // stored on this fiber, which carries RequestScope
          void shield(function* () {
            t.push('unconsumed shield ran'); // never: an op nobody consumes runs nothing
          });
          // Run through its then, a promise consumer nobody waits for: the shield starts now, on this node.
          void shield(function* () {
            yield* wait(tick());
            t.push(`shield: same conn ${String(lookup(Conn) === conn)}`);
            throw shieldError;
          }).then(undefined, (e: unknown) => void t.push(`then rejected: ${e === shieldError ? 'shieldError' : String(e)}`));
          t.push('body returns');
          return 'done';
        },
        { name: 'owner', scopes: [RequestScope], onFailure: (e) => void failures.push(e) },
      ),
    );
    const o = await within(completion(root, f, t));
    expect({ log: t.log, outcome: o, failures }).toEqual({
      log: ['body returns', 'shield: same conn true', 'then rejected: shieldError', 'conn released', 'complete'],
      outcome: { status: 'success', value: 'done' }, // the then consumed the shield's failure
      failures: [],
    });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('A.4: a shield started on its owner during the release phase (ctx.shield from an entry’s release) still completes before the owner, with no ordering against entries already released', async () => {
    const t = trace();
    const root = app();
    const f = root.fork(
      task(
        function* () {
          const owner = current();
          own(() => {
            // In the entry's release fiber: a shield on the owner, which is releasing, not on this release fiber. Run
            // through its then (a work op runs only when consumed): nothing waits for it but the owner.
            void owner
              .shield(function* () {
                yield* wait(tick(2));
                t.push(`late shield done; owner ${owner.state}`);
              })
              .then(() => {});
            t.push('entry released');
          });
          return 'done';
        },
        { name: 'owner', ...quiet },
      ),
    );
    const o = await within(completion(root, f, t));
    expect({ log: t.log, outcome: o }).toEqual({
      log: ['entry released', 'late shield done; owner releasing', 'complete'],
      outcome: { status: 'success', value: 'done' },
    });
    await root.close();
  });

  it('A.8, re-expressed: a generator body has no Promise combinator; race() aborts and awaits its loser, so a loser’s late failure never happens, nothing is consumed into an ignored race, and nothing warns', async () => {
    const lost = new Error('loser failed late');
    const gate = deferred();
    let loser: Context | undefined;
    const root = app();
    const v = await within(
      root.call(function* () {
        const winner = yield* race([
          task(
            function* () {
              return 'a';
            },
            { name: 'a' },
          ),
          task(
            function* (): Generator<Instruction, string, unknown> {
              loser = current();
              yield* wait(gate.promise, { abandon: true }); // stops waiting at its abort
              throw lost;
            },
            { name: 'b' },
          ),
        ]);
        gate.resolve();
        yield* sleep(10);
        return winner;
      }),
    );
    expect({ value: v, loser: loser?.outcome?.status, consumed: impl(loser!).failure, warnings: rammeWarnings() }).toEqual({
      value: 'a',
      loser: 'aborted',
      consumed: undefined, // no failure record at all
      warnings: [],
    });
    await expect(root.close()).resolves.toBeUndefined();
  });
});

describe('generator bodies: the fixes of the implementation review, re-expressed', () => {
  /** A generator transaction helper over a connection-like object: its finally reports whether the connection is still open. */
  function txHelper(t: Trace) {
    return function* <T>(conn: { open: boolean }, fn: () => Operation<T>): Generator<Instruction, T, unknown> {
      t.push('BEGIN');
      try {
        return yield* fn();
      } finally {
        t.push(conn.open ? 'ROLLBACK on open connection' : 'ROLLBACK on RETURNED connection');
      }
    };
  }

  it('A.7, with lazy ops: an op one body made, returned by a synchronous body (driven as its body, decision 28) or yielded by another, runs for the body that consumes it: its maker’s interruption reaches neither, nothing is classified by awaiter, and nothing warns', async () => {
    const reason = new Error('hang up');
    const root = app();
    /** A body that makes a sleep, through its own node, and parks on never(). */
    const creator = (name: string) => {
      const box: { shared?: Op<void> } = {};
      const made = deferred();
      const f = root.fork(
        task(
          function* () {
            box.shared = sleep(30);
            made.resolve();
            yield* never();
          },
          { name, ...quiet },
        ),
      );
      return { f, box, made: made.promise };
    };
    const a = creator('creator-a');
    const b = creator('creator-b');
    await within(Promise.all([a.made, b.made]));
    const failures: unknown[] = [];
    const onFailure = (e: unknown): void => void failures.push(e);
    const syncReturn = root.fork(task(() => a.box.shared!, { name: 'sync-return', onFailure }));
    const viaYield = root.fork(
      task(
        function* () {
          yield* b.box.shared!;
          return 'slept';
        },
        { name: 'via-yield', onFailure },
      ),
    );
    await tick();
    a.f.abort(reason);
    b.f.abort(reason);
    const makers = await within(Promise.all([root.result(a.f), root.result(b.f)]));
    const outcomes = await within(Promise.all([root.result(syncReturn), root.result(viaYield)]));
    expect({
      makers: makers.map((o) => o.status),
      outcomes,
      failures,
      warnings: rammeWarnings(),
    }).toEqual({
      makers: ['aborted', 'aborted'],
      outcomes: [
        { status: 'success', value: undefined },
        { status: 'success', value: 'slept' },
      ],
      failures: [],
      warnings: [],
    });
    await root.close();
  });

  it('A.3: the applied-awaiter rule reads the awaiter that is resumed: an aborted fork yielding its live parent’s release(x) is returned when the release fails, consuming nothing, and the parent reports the release failure once', async () => {
    const rollbackError = new Error('rollback failed');
    const failures: unknown[] = [];
    let awaiterOutcome: Outcome<void> | undefined;
    let awaiterSaw: unknown = 'nothing thrown in';
    const root = app();
    const parent = root.fork(
      task(
        function* () {
          const x = own({}, function* () {
            yield* wait(bare(20));
            throw rollbackError;
          });
          const p = release(x); // the parent's release work; the parent is never interrupted
          const started = deferred();
          const awaiter = fork(function* () {
            started.resolve();
            try {
              yield* p; // the parent's eager op: this body subscribes to the same release
            } catch (e) {
              awaiterSaw = e;
              throw e;
            }
          });
          yield* wait(started.promise);
          yield* wait(bare(1));
          awaiter.abort(); // halted while it waits: release work is not returned at the halt, and its failure returns it
          awaiterOutcome = yield* result(awaiter);
          return 'parent done';
        },
        { name: 'parent', onFailure: (e) => void failures.push(e) },
      ),
    );
    const o = await within(root.result(parent));
    expect({ outcome: o, failures, awaiter: awaiterOutcome?.status, awaiterSaw, warnings: rammeWarnings().length }).toEqual({
      outcome: { status: 'defect', error: rollbackError }, // the record stayed with its holder (I11)
      failures: [rollbackError],
      awaiter: 'aborted',
      awaiterSaw: 'nothing thrown in', // a halted body is returned, never thrown into
      warnings: 0, // nothing is classified by awaiter any more
    });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('A.3: a shield in the halted finally yielding its body’s release(x) is not an applied awaiter: it consumes what it catches, and what it rethrows is reported once', async () => {
    const reason = new Error('hang up');
    const rollbackError = new Error('rollback failed');
    const failures: unknown[] = [];
    const { slow } = slowTask();
    const root = app();
    const run = (rethrow: boolean) =>
      root.fork(
        task(
          function* () {
            const x = own({}, function* () {
              yield* wait(tick());
              throw rollbackError;
            });
            try {
              yield* call(slow);
            } finally {
              const p = release(x); // the halted body's release work
              try {
                yield* shield(function* () {
                  try {
                    yield* p; // the shield's cross-body wait: the shield is not applied, so it consumes
                  } catch (r) {
                    if (rethrow) throw r;
                  }
                });
              } catch {
                // the shield's own failure, rethrown from p: thrown in unconsumed, folded in at completion
              }
            }
          },
          { name: rethrow ? 'rethrows' : 'swallows', onFailure: (e) => void failures.push(e) },
        ),
      );
    const swallows = run(false);
    const rethrows = run(true);
    await tick();
    swallows.abort(reason);
    rethrows.abort(reason);
    const outcomes = await within(Promise.all([root.result(swallows), root.result(rethrows)]));
    expect({ outcomes, failures }).toEqual({
      outcomes: [
        { status: 'aborted', reason }, // the shield handled it: consumed once, by the awaiter that could act on it
        { status: 'defect', error: rollbackError }, // the shield's failure alone, not also the release record it consumed
      ],
      failures: [rollbackError],
    });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('a child() scope of a halted body is released after the body has unwound, at its turn: a helper’s finally around the halted yield* still finds what the scope owns', async () => {
    const logs: Record<string, readonly string[]> = {};
    for (const work of ['call', 'sleep'] as const)
      for (const stop of ['abort', 'root dispose'] as const) {
        const t = trace();
        const withTx = txHelper(t);
        const insert = task(
          function* () {
            t.push('insert running');
            yield* never();
          },
          { name: 'insert' },
        );
        const root = app();
        const f = root.fork(
          task(
            function* () {
              const scope = child({ name: 'scope' });
              const conn = scope.own({ open: true }, (c) => {
                c.open = false;
                t.push('returned to pool');
              });
              scope.child({ name: 'inner' }).own(t.at('inner released')); // a bodiless node below the scope: released with it
              yield* withTx(conn, () => (work === 'call' ? call(insert) : sleep(1000)));
            },
            { name: 'request', ...quiet },
          ),
        );
        await tick();
        const done = completion(root, f, t);
        if (stop === 'abort') f.abort(new Error('hang up'));
        else await within(root[Symbol.asyncDispose]());
        const o = await within(done);
        t.push(o.status);
        logs[`${work}, ${stop}`] = t.log;
      }
    const expected = (work: string): string[] => [
      'BEGIN',
      ...(work === 'call' ? ['insert running'] : []),
      'ROLLBACK on open connection',
      'inner released',
      'returned to pool',
      'complete',
      'aborted',
    ];
    expect(logs).toEqual({
      'call, abort': expected('call'),
      'call, root dispose': expected('call'),
      'sleep, abort': expected('sleep'),
      'sleep, root dispose': expected('sleep'),
    });
  });

  it('A.4: once the body has returned, while a shield run through then holds the owner open, a child’s generator failure handler may sleep and shield through the owner, which completes after both', async () => {
    const t = trace();
    const err = new Error('child failed');
    const gate = deferred();
    const ev = events();
    roots.push(ev.root);
    const owner = ev.root.fork(
      task(
        function* () {
          own(
            fork(
              task(
                function* (): Generator<Instruction, never, unknown> {
                  yield* wait(tick());
                  throw err;
                },
                {
                  name: 'kid',
                  onFailure: function* () {
                    try {
                      yield* sleep(5);
                      t.push(`handler slept; owner ${String(current() === owner)}`);
                      t.push(
                        yield* shield(function* () {
                          return 'handler shielded';
                        }),
                      );
                    } finally {
                      gate.resolve();
                    }
                  },
                },
              ),
            ),
          );
          // The owner's release waits for every shield it ran before it releases any entry (D39, A.4), so the
          // owned kid lives on, fails, and its handler runs, after the body has returned.
          void shield(function* () {
            yield* wait(gate.promise);
            t.push('shield done');
          }).then(() => {});
          return 'ok';
        },
        { name: 'owner', ...quiet },
      ),
    );
    const o = await within(ev.root.result(owner));
    const ownerId = impl(owner).id;
    const settledBody = ev.of('node:settled').find((e) => e.id === ownerId);
    const ownerComplete = ev.of('node:complete').find((e) => e.id === ownerId);
    t.push('complete');
    expect({
      outcome: o,
      log: t.log,
      bodyFirst: settledBody !== undefined && ownerComplete !== undefined && settledBody.seq < ownerComplete.seq,
    }).toEqual({
      outcome: { status: 'success', value: 'ok' },
      log: ['handler slept; owner true', 'handler shielded', 'shield done', 'complete'],
      bodyFirst: true,
    });
  });

  it('shield’s resume step consumes a failure the body catches, and a halted body’s consumes nothing: the shield’s error is then its outcome, reported once', async () => {
    const reason = new Error('hang up');
    const shieldError = new Error('cleanup failed');
    const failures: unknown[] = [];
    const onFailure = (e: unknown): void => void failures.push(e);
    const { slow } = slowTask();
    let fromShield: unknown;
    const root = app();
    const live = root.fork(
      task(
        function* () {
          try {
            yield* shield(function* (): Generator<Instruction, never, unknown> {
              throw shieldError;
            });
          } catch {
            // handled: the body is not interrupted, so its resume step consumed the shield's failure
          }
          return 'ok';
        },
        { name: 'live', onFailure },
      ),
    );
    const halted = root.fork(
      task(
        function* () {
          try {
            yield* call(slow);
          } finally {
            try {
              yield* shield(function* (): Generator<Instruction, never, unknown> {
                yield* wait(tick());
                throw shieldError;
              });
            } catch (s) {
              fromShield = s;
            }
          }
        },
        { name: 'halted', onFailure },
      ),
    );
    await tick();
    halted.abort(reason);
    const outcomes = await within(Promise.all([root.result(live), root.result(halted)]));
    expect({ outcomes, fromShield, failures }).toEqual({
      outcomes: [
        { status: 'success', value: 'ok' },
        { status: 'defect', error: shieldError }, // aborted + the shield's unconsumed failure (D24)
      ],
      fromShield: shieldError,
      failures: [shieldError],
    });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('A.3: a halted body’s close() and [Symbol.asyncDispose]() of nodes below it, yielded in its finally, consume nothing: a failure they hand it becomes its outcome, reported once', async () => {
    const reason = new Error('hang up');
    const releaseError = new Error('release failed');
    const bodyError = new Error('fiber body failed');
    const failures: string[] = [];
    const handed: string[] = [];
    const { slow } = slowTask();
    const root = app();
    /** A body halted mid-call whose finally yields `stop()` of something below it and catches what it hands over. */
    const shape = (name: string, prepare: () => () => Op<void>) =>
      root.fork(
        task(
          function* () {
            const stop = prepare();
            try {
              yield* call(slow);
            } finally {
              try {
                yield* stop();
              } catch (r) {
                handed.push(`${name}: ${(r as Error).message}`);
              }
            }
          },
          { name, onFailure: (e) => void failures.push(`${name}: ${(e as Error).message}`) },
        ),
      );
    const failingScope = (): Context => {
      const c = child({ name: 'scope' });
      c.own(() => {
        throw releaseError;
      });
      return c;
    };
    const closeScope = shape('close', () => {
      const c = failingScope();
      return () => c.close();
    });
    const disposeScope = shape('dispose scope', () => {
      const c = failingScope();
      return () => c[Symbol.asyncDispose]();
    });
    const disposeFiber = shape('dispose fiber', () => {
      const k = fork(
        task(
          function* (): Generator<Instruction, never, unknown> {
            yield* interrupted(); // an observe body: its outcome is its own, so its throw is a failure
            throw bodyError;
          },
          { name: 'observer', interrupt: 'observe' },
        ),
      );
      return () => k[Symbol.asyncDispose]();
    });
    await tick();
    for (const f of [closeScope, disposeScope, disposeFiber]) f.abort(reason);
    const outcomes = await within(Promise.all([closeScope, disposeScope, disposeFiber].map((f) => root.result(f))));
    expect({ outcomes, handed, failures: [...failures].sort() }).toEqual({
      outcomes: [
        { status: 'defect', error: releaseError },
        { status: 'defect', error: releaseError },
        { status: 'defect', error: bodyError },
      ],
      handed: ['close: release failed', 'dispose scope: release failed', 'dispose fiber: fiber body failed'],
      failures: ['close: release failed', 'dispose fiber: fiber body failed', 'dispose scope: release failed'],
    });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('A.4, with lazy ops: a shield made in a body runs nothing until it is yielded, so the body forks freely meanwhile; yielded, its release fiber is made then, and is current in its body', async () => {
    const ev = events();
    roots.push(ev.root);
    let shieldNode: Context | undefined;
    let beforeYield: string | undefined;
    const v = await within(
      ev.root.call(function* () {
        const p = shield(function* () {
          shieldNode = current();
          yield* wait(tick());
          return 'shielded';
        });
        const f = fork(function* () {
          return 'forked meanwhile';
        });
        beforeYield = `${String(shieldNode)}; ${yield* join(f)}`;
        return yield* p;
      }),
    );
    expect({
      value: v,
      beforeYield,
      shieldKind: shieldNode === undefined ? undefined : impl(shieldNode).kind,
      shieldMade: ev.of('node:created').filter((e) => e.name === 'shield:anonymous').length,
    }).toEqual({
      value: 'shielded',
      beforeYield: 'undefined; forked meanwhile',
      shieldKind: 'release',
      shieldMade: 1,
    });
  });

  it('A.3: a body halted on close() or [Symbol.asyncDispose]() of an unrelated node is returned at once, not waited for; in its halted finally the same wait is release work, waited for to its end', async () => {
    const reason = new Error('hang up');
    const gate = deferred();
    const root = app();
    const sibling = root.child({ name: 'sibling' });
    sibling.fork(
      task(
        function* () {
          yield* wait(gate.promise);
        },
        { name: 'busy', ...quiet },
      ),
    );
    const other = root.child({ name: 'other' });
    other.own({}, function* () {
      yield* wait(gate.promise); // its release waits for the gate
    });
    const later = root.child({ name: 'later' });
    later.own({}, function* () {
      yield* wait(gate.promise);
    });
    const seen: string[] = [];
    const shape = (name: string, op: () => Op<void>) =>
      root.fork(
        task(
          function* () {
            try {
              yield* op();
              seen.push(`${name} resolved`);
            } finally {
              seen.push(`${name}: finally`);
            }
          },
          { name, ...quiet },
        ),
      );
    const closer = shape('close', () => sibling.close());
    const disposer = shape('asyncDispose', () => other[Symbol.asyncDispose]());
    const { slow } = slowTask();
    const unwinder = root.fork(
      task(
        function* () {
          try {
            yield* call(slow);
          } finally {
            yield* later[Symbol.asyncDispose](); // cannot be cancelled: the unwind waits for it (D21)
            seen.push('unwinder: disposed in its finally');
          }
        },
        { name: 'unwinder', ...quiet },
      ),
    );
    await tick();
    const fibers = [closer, disposer, unwinder];
    const done = fibers.map((f) => root.result(f).then((o) => o));
    for (const f of fibers) f.abort(reason);
    const s = await Promise.all(done.map((d) => settlement(d, 30)));
    const before = { settled: s.map((x) => x.state), seen: [...seen], sibling: sibling.state, other: other.state, later: later.state };
    gate.resolve();
    const outcomes = await within(Promise.all(done));
    await within(root.close());
    expect({ before, seen, outcomes: outcomes.map((o) => o.status) }).toEqual({
      before: {
        settled: ['fulfilled', 'fulfilled', 'pending'],
        seen: ['close: finally', 'asyncDispose: finally'],
        sibling: 'releasing',
        other: 'releasing',
        later: 'releasing',
      },
      seen: ['close: finally', 'asyncDispose: finally', 'unwinder: disposed in its finally'],
      outcomes: ['aborted', 'aborted', 'aborted'],
    });
  });

  it('A.2: join and result of a fork subscribed below a halted body return it once the fork has completed, so a helper’s finally around them runs after its work; an owned fork’s join returns it at once', async () => {
    const logs: Record<string, readonly string[]> = {};
    for (const shape of ['join', 'result', 'owned join'] as const) {
      const t = trace();
      const update = task(
        function* () {
          t.push('writing');
          yield* wait(bare(30)); // a driver write not handed signal(): the halt lets it finish
          t.push('wrote');
        },
        { name: 'update' },
      );
      function* helper(fn: () => Operation<unknown>): Generator<Instruction, void, unknown> {
        t.push('lock');
        try {
          yield* fn();
        } finally {
          t.push('unlock');
        }
      }
      const root = app();
      const f = root.fork(
        task(
          function* () {
            yield* helper(function* () {
              const w = shape === 'owned join' ? own(fork(update)) : fork(update);
              return shape === 'result' ? yield* result(w) : yield* join(w);
            });
          },
          { name: 'request', ...quiet },
        ),
      );
      await bare(10); // mid-write
      const done = completion(root, f, t);
      f.abort(new Error('hang up'));
      const o = await within(done);
      t.push(o.status);
      logs[shape] = t.log;
    }
    expect(logs).toEqual({
      join: ['lock', 'writing', 'wrote', 'unlock', 'complete', 'aborted'],
      result: ['lock', 'writing', 'wrote', 'unlock', 'complete', 'aborted'],
      'owned join': ['lock', 'writing', 'unlock', 'wrote', 'complete', 'aborted'], // unsubscribed: not stopped by the delivery (I4)
    });
  });

  it('A.2: the shape delivers a fork the delivery did not reach: below an observe child, a halted body’s join(f) aborts f with the body’s reason and returns the body once f has completed, while the observe child runs on', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const observerGate = deferred();
    const forked = deferred();
    const returned = deferred();
    let f!: Fiber<void>;
    let observer!: Fiber<void>;
    const root = app();
    const b = root.fork(
      task(
        function* () {
          observer = fork(
            task(
              function* () {
                f = fork(function* () {
                  try {
                    yield* never();
                  } finally {
                    t.push('f unwound');
                  }
                });
                forked.resolve();
                yield* wait(observerGate.promise); // an observe body: not halted, it runs on
              },
              { name: 'observer', interrupt: 'observe' },
            ),
          );
          yield* wait(forked.promise);
          try {
            yield* join(f); // f is subscribed below this body, but the delivery stops at the observe child
          } finally {
            t.push('body returned');
            returned.resolve();
          }
        },
        { name: 'body', ...quiet },
      ),
    );
    await tick();
    b.abort(reason);
    await within(returned.promise);
    const fNode = impl(f);
    expect({ log: t.log, f: fNode.outcome?.status, reason: fNode.abortReason === reason, observer: impl(observer).state }).toEqual({
      log: ['f unwound', 'body returned'],
      f: 'aborted',
      reason: true,
      observer: 'running',
    });
    observerGate.resolve();
    expect((await within(root.result(b))).status).toBe('aborted');
    await root.close();
  });
});

describe('generator bodies: shield and unshield (unshield.test.ts, re-expressed)', () => {
  it('cut mid-hole: the owner’s interruption ends the hole, aborted with the owner’s reason; the shield body goes on to its end, the owner is resumed after it and returned at its next yield*, and completes after the shield', async () => {
    const ev = events();
    roots.push(ev.root);
    const t = trace();
    const reason = new Error('owner cut');
    let shieldNode: Context | undefined;
    let hole: Context | undefined;
    let r: Outcome<string> | undefined;
    const owner = ev.root.fork(
      task(
        function* () {
          const v = yield* shield(function* () {
            shieldNode = current();
            t.push('buffer flushed');
            r = yield* unshield(function* () {
              hole = current();
              t.push('peer notified');
              yield* sleep(10_000); // the owner's interruption halts it, and clears its timer
              t.push('peer acknowledged');
              return 'ack';
            });
            t.push('offset written');
            return 'shielded';
          });
          t.push(`after the shield: ${v}`); // release work is not returned at the halt: resumed with its value
          yield* sleep(1); // returned here
          t.push('unreachable');
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['buffer flushed', 'peer notified']);
    const done = completion(ev.root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    const ids = [impl(shieldNode!).id, impl(owner).id];
    expect({
      log: t.log,
      hole: r,
      holeOutcome: hole?.outcome,
      holeParentIsShield: hole?.parent === shieldNode,
      owner: o,
      completed: ev.of('node:complete').flatMap((e) => (ids.includes(e.id) ? [e.id === ids[0] ? 'shield' : 'owner'] : [])),
    }).toEqual({
      log: ['buffer flushed', 'peer notified', 'offset written', 'after the shield: shielded', 'complete'],
      hole: { status: 'aborted', reason },
      holeOutcome: { status: 'aborted', reason },
      holeParentIsShield: true,
      owner: { status: 'aborted', reason },
      completed: ['shield', 'owner'],
    });
  });

  it('owner already interrupted: a hole made in a shield its halted finally runs is skipped at once, its body never runs whatever its interrupt mode, and its outcome is aborted with the owner’s reason', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const ran: string[] = [];
    let r: Outcome<string> | undefined;
    let observeHole: Outcome<string> | undefined;
    const root = app();
    const owner = root.fork(
      task(
        function* () {
          try {
            yield* never(); // halted here
          } finally {
            yield* shield(function* () {
              // release work of the halted node: the shield's owner, whose interruption has come
              const p = unshield(function* () {
                ran.push('hole started');
                yield* sleep(10_000);
                ran.push('past its first yield*');
                return 'ack';
              });
              r = yield* p;
              observeHole = yield* unshield(
                task(
                  function* () {
                    ran.push('observe hole started'); // an observe child is not born delivered, but it is not born at all
                    return 'ack';
                  },
                  { name: 'observe hole', interrupt: 'observe' },
                ),
              );
              t.push('shield goes on');
            });
          }
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({ ran, hole: r, observeHole, log: t.log, owner: o }).toEqual({
      ran: [],
      hole: { status: 'aborted', reason },
      observeHole: { status: 'aborted', reason },
      log: ['shield goes on', 'complete'],
      owner: { status: 'aborted', reason },
    });
  });

  it('a hole that succeeds gives its value, and one that fails its failure as a value, consumed: nothing is left unconsumed on any node', async () => {
    const boom = new Error('peer refused');
    const notifyPeer = task(
      function* (): Generator<Instruction, never, unknown> {
        throw boom;
      },
      { name: 'notifyPeer' },
    );
    let ok: Outcome<number> | undefined;
    let bad: Outcome<never> | undefined;
    const unconsumed: Record<string, number> = {};
    const root = app();
    const v = await within(
      root.call(function* () {
        const body = current();
        return yield* shield(function* () {
          const s = current();
          ok = yield* unshield(function* (n: number) {
            return n * 2;
          }, 21);
          bad = yield* current().unshield(notifyPeer); // the method form, on the shield's node
          unconsumed.shield = impl(s).unconsumed.size;
          unconsumed.body = impl(body).unconsumed.size;
          return 'done';
        });
      }),
    );
    await root.close(); // rejects with anything that surfaced unconsumed
    expect({ v, ok, bad, unconsumed, root: root.outcome }).toEqual({
      v: 'done',
      ok: { status: 'success', value: 42 },
      bad: { status: 'defect', error: boom },
      unconsumed: { shield: 0, body: 0 },
      root: { status: 'success', value: undefined },
    });
  });

  it('nesting: shield > unshield > shield > unshield; the inner hole links to the inner shield’s owner, a child of the outer hole, and aborting that node alone ends it', async () => {
    const t = trace();
    const reason = new Error('inner owner cut');
    const n: Record<'owner' | 'outerShield' | 'outerHole' | 'innerOwner' | 'innerShield' | 'innerHole', Context | undefined> = {
      owner: undefined,
      outerShield: undefined,
      outerHole: undefined,
      innerOwner: undefined,
      innerShield: undefined,
      innerHole: undefined,
    };
    let outer: Outcome<string> | undefined;
    let inner: Outcome<void> | undefined;
    let callError: unknown;
    const root = app();
    const owner = root.fork(
      task(
        function* () {
          n.owner = current();
          yield* shield(function* () {
            n.outerShield = current();
            outer = yield* unshield(function* () {
              n.outerHole = current();
              try {
                yield* call(function* () {
                  n.innerOwner = current();
                  yield* shield(function* () {
                    n.innerShield = current();
                    inner = yield* unshield(function* () {
                      n.innerHole = current();
                      t.push('inner hole waiting');
                      yield* never();
                    });
                    t.push('inner shield goes on');
                  });
                  t.push('inner owner after its shield'); // resumed after its release work
                  yield* sleep(1); // returned here: the inner owner is interrupted
                });
              } catch (e) {
                callError = e;
              }
              return 'outer hole done';
            });
            t.push('outer shield goes on');
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['inner hole waiting']);
    const parents = {
      innerHole: n.innerHole?.parent === n.innerShield,
      innerShield: n.innerShield?.parent === n.innerOwner,
      innerOwner: n.innerOwner?.parent === n.outerHole,
      outerHole: n.outerHole?.parent === n.outerShield,
      outerShield: n.outerShield?.parent === n.owner,
    };
    const done = completion(root, owner, t);
    n.innerOwner!.abort(reason); // that node only: not the outer hole, not the owner
    const o = await within(done);
    expect({
      parents,
      log: t.log,
      inner,
      outer,
      callError: callError instanceof FiberAbortedError ? (callError as FiberAbortedError).reason : callError,
      delivered: [n.owner, n.outerShield, n.outerHole].map((x) => impl(x!).delivered),
      owner: o,
    }).toEqual({
      parents: { innerHole: true, innerShield: true, innerOwner: true, outerHole: true, outerShield: true },
      log: ['inner hole waiting', 'inner shield goes on', 'inner owner after its shield', 'outer shield goes on', 'complete'],
      inner: { status: 'aborted', reason },
      outer: { status: 'success', value: 'outer hole done' },
      callError: reason, // the outer hole's call of the aborted inner owner: another node's abort, thrown in
      delivered: [false, false, false],
      owner: { status: 'success', value: undefined },
    });
  });

  it('from a call made inside the shield body, the hole links to the shield’s owner, not to the shield’s release fiber (current().parent) nor to the call’s node', async () => {
    const t = trace();
    const reason = new Error('owner cut');
    const n: Record<'owner' | 'shield' | 'call' | 'hole', Context | undefined> = {
      owner: undefined,
      shield: undefined,
      call: undefined,
      hole: undefined,
    };
    let linked: AbortSignal | undefined;
    let r: Outcome<string> | undefined;
    const root = app();
    const owner = root.fork(
      task(
        function* () {
          n.owner = current();
          yield* shield(function* () {
            n.shield = current();
            r = yield* call(function* () {
              n.call = current();
              const o = yield* unshield(function* () {
                n.hole = current();
                linked = impl(current()).linkedSignal;
                t.push('hole waiting');
                yield* sleep(10_000);
                return 'unreachable';
              });
              t.push('call goes on');
              return o;
            });
            t.push('shield goes on');
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['hole waiting']);
    const links = {
      holeParentIsCall: n.hole?.parent === n.call,
      callParentIsShield: n.call?.parent === n.shield,
      owner: linked === n.owner!.signal,
      shield: linked === n.shield!.signal,
      call: linked === n.call!.signal,
    };
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({ links, hole: r, log: t.log, owner: o }).toEqual({
      links: { holeParentIsCall: true, callParentIsShield: true, owner: true, shield: false, call: false },
      hole: { status: 'aborted', reason },
      log: ['hole waiting', 'call goes on', 'shield goes on', 'complete'],
      owner: { status: 'aborted', reason },
    });
  });

  it('outside any shield it throws a TypeError before anything runs: in a generator body, in an entry’s release fiber, in a generator release, and after a shield has ended', async () => {
    let ran = 0;
    const thrown: string[] = [];
    const attemptHole = (where: string): void => {
      try {
        void unshield(function* () {
          ran++;
        });
        thrown.push(`${where}: nothing thrown`);
      } catch (e) {
        thrown.push(`${where}: ${e instanceof TypeError && /outside any shield/.test(e.message) ? 'TypeError' : String(e)}`);
      }
    };
    const root = app();
    await within(
      root.call(function* () {
        attemptHole('body');
        const scope = child();
        scope.own(() => attemptHole('entry release'));
        scope.own({}, function* () {
          attemptHole('generator release');
        });
        yield* scope.close();
        yield* shield(function* () {});
        attemptHole('after a shield');
      }),
    );
    expect({ thrown, ran }).toEqual({
      thrown: ['body: TypeError', 'generator release: TypeError', 'entry release: TypeError', 'after a shield: TypeError'],
      ran: 0,
    });
  });

  it('the hole is a subscribed child of the current node: lookup through it resolves the owner’s providers', async () => {
    const Greeting = createInjectionKey<string>('greeting');
    let shieldNode: Context | undefined;
    let hole: Context | undefined;
    let seen: Outcome<string> | undefined;
    const root = app();
    await within(
      root.call(
        task(
          function* () {
            yield* shield(function* () {
              shieldNode = current();
              seen = yield* unshield(function* () {
                hole = current();
                return lookup(Greeting);
              });
            });
          },
          { name: 'owner', providers: [valueProvider(Greeting, 'from the owner')] },
        ),
      ),
    );
    expect({
      seen,
      parentIsShield: hole?.parent === shieldNode,
      subscribed: hole === undefined ? undefined : impl(hole).subscribed,
    }).toEqual({
      seen: { status: 'success', value: 'from the owner' },
      parentIsShield: true,
      subscribed: true,
    });
  });

  it('a hole keeps its task’s own signal: that signal ends it as well, with its own reason, and the owner is not interrupted', async () => {
    const peer = new AbortController();
    const reason = new Error('peer gone');
    let r: Outcome<string> | undefined;
    let ownerDelivered: boolean | undefined;
    const notifyPeer = task(
      function* () {
        yield* sleep(10_000);
        return 'ack';
      },
      { name: 'notifyPeer', signal: peer.signal },
    );
    const root = app();
    await within(
      root.call(function* () {
        const owner = current();
        yield* shield(function* () {
          const p = unshield(notifyPeer);
          setTimeout(() => peer.abort(reason), 1);
          r = yield* p;
          ownerDelivered = impl(owner).delivered;
        });
      }),
    );
    expect({ hole: r, ownerDelivered }).toEqual({ hole: { status: 'aborted', reason }, ownerDelivered: false });
  });

  it('from a fork inside the shield body too: the walk passes the fork, and the hole links to the shield’s owner', async () => {
    const t = trace();
    const reason = new Error('owner cut');
    let r: Outcome<string> | undefined;
    const root = app();
    const owner = root.fork(
      task(
        function* () {
          yield* shield(function* () {
            r = yield* join(
              fork(function* () {
                return yield* unshield(function* () {
                  t.push('hole waiting');
                  yield* sleep(10_000);
                  return 'unreachable';
                });
              }),
            );
            t.push('shield goes on');
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['hole waiting']);
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({ hole: r, log: t.log, owner: o }).toEqual({
      hole: { status: 'aborted', reason },
      log: ['hole waiting', 'shield goes on', 'complete'],
      owner: { status: 'aborted', reason },
    });
  });

  it('an observe hole hears the owner’s interruption through signal() and interrupted() and runs on: its outcome is its own', async () => {
    const t = trace();
    const reason = new Error('owner cut');
    let heard: Record<string, boolean> | undefined;
    let r: Outcome<string> | undefined;
    const root = app();
    const owner = root.fork(
      task(
        function* () {
          yield* shield(function* () {
            r = yield* unshield(
              task(
                function* () {
                  t.push('hole waiting');
                  const why = yield* interrupted(); // the resolving form: an observe body is never halted
                  heard = { aborted: signal().aborted, signalReason: signal().reason === reason, why: why === reason };
                  yield* sleep(1); // not its interruption's to halt
                  return 'finished the step';
                },
                { name: 'notifyPeer', interrupt: 'observe' },
              ),
            );
            t.push('shield goes on');
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['hole waiting']);
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({ heard, hole: r, log: t.log, owner: o }).toEqual({
      heard: { aborted: true, signalReason: true, why: true },
      hole: { status: 'success', value: 'finished the step' },
      log: ['hole waiting', 'shield goes on', 'complete'],
      owner: { status: 'aborted', reason },
    });
  });

  it('the owner is the node the shield runs on: under ctx.shield yielded by another body, the hole follows ctx, and the halted body waits for the shield', async () => {
    const t = trace();
    const reqReason = new Error('request cut');
    const scopeReason = new Error('scope closed');
    let hole: Context | undefined;
    let r: Outcome<string> | undefined;
    const root = app();
    const scope = root.child({ name: 'scope' });
    const req = root.fork(
      task(
        function* () {
          yield* scope.shield(function* () {
            r = yield* unshield(function* () {
              hole = current();
              t.push('hole waiting');
              yield* sleep(10_000);
              return 'ran to end';
            });
            t.push('shield goes on');
          });
        },
        { name: 'req', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['hole waiting']);
    req.abort(reqReason); // the body that yielded the shield: not the owner, and release work is not returned at its halt
    await tick(2);
    const afterReq = { log: [...t.log], holeDelivered: impl(hole!).delivered, hole: r, req: req.state };
    scope.abort(scopeReason); // the node the shield runs on: the owner
    const o = await within(root.result(req));
    expect({ afterReq, hole: r, log: t.log, req: o }).toEqual({
      afterReq: { log: ['hole waiting'], holeDelivered: false, hole: undefined, req: 'running' },
      hole: { status: 'aborted', reason: scopeReason },
      log: ['hole waiting', 'shield goes on'],
      req: { status: 'aborted', reason: reqReason },
    });
  });

  it('a shield inside a shield has the outer shield as its owner: in the halted finally the task’s interruption neither skips nor cuts its hole (Effect’s restore under a nested mask)', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const n: Record<'outer' | 'inner', Context | undefined> = { outer: undefined, inner: undefined };
    let linked: AbortSignal | undefined;
    let r: Outcome<string> | undefined;
    const { slow } = slowTask();
    /** A library helper, non-cancellable except for one step, used where its caller wrapped it in a shield of its own. */
    const helper = (): Op<void> =>
      shield(function* () {
        n.inner = current();
        r = yield* unshield(function* () {
          linked = impl(current()).linkedSignal;
          t.push('peer notified');
          yield* sleep(5);
          t.push('peer acknowledged');
          return 'notified';
        });
      });
    const root = app();
    const owner = root.fork(
      task(
        function* () {
          try {
            yield* call(slow);
          } finally {
            yield* shield(() => {
              n.outer = current();
              return helper(); // a body returning an op: driven in the outer shield's frame (decision 28)
            });
          }
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({
      innerOwnerIsOuterShield: n.inner?.parent === n.outer,
      linkedToOuterShield: linked === n.outer?.signal,
      log: t.log,
      hole: r,
      owner: o,
    }).toEqual({
      innerOwnerIsOuterShield: true,
      linkedToOuterShield: true,
      log: ['peer notified', 'peer acknowledged', 'complete'], // not skipped, though the owner was interrupted
      hole: { status: 'success', value: 'notified' },
      owner: { status: 'aborted', reason },
    });
  });

  it('inside a call made under a shield, a shield’s owner is the call’s node: the task’s interruption mid-hole does not cut its hole', async () => {
    const t = trace();
    const reason = new Error('owner cut');
    let callNode: Context | undefined;
    let linked: AbortSignal | undefined;
    let r: Outcome<string> | undefined;
    const root = app();
    const owner = root.fork(
      task(
        function* () {
          yield* shield(function* () {
            yield* call(function* () {
              callNode = current();
              yield* shield(function* () {
                r = yield* unshield(function* () {
                  linked = impl(current()).linkedSignal;
                  t.push('hole waiting');
                  yield* sleep(20);
                  t.push('hole done');
                  return 'ran to end';
                });
              });
            });
            t.push('shield goes on');
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['hole waiting']);
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({ linkedToCall: linked === callNode?.signal, log: t.log, hole: r, owner: o }).toEqual({
      linkedToCall: true,
      log: ['hole waiting', 'hole done', 'shield goes on', 'complete'],
      hole: { status: 'success', value: 'ran to end' },
      owner: { status: 'aborted', reason },
    });
  });

  it('a nested shield’s hole is bounded by its owner’s own signal: the outer shield’s release deadline, or the delivery of the call it runs on', async () => {
    function* peer(): Generator<Instruction, string, unknown> {
      yield* sleep(10_000); // a peer that never answers
      return 'unreachable';
    }
    const timedOut = (o: Outcome<unknown> | undefined): string =>
      o?.status === 'aborted' ? `aborted: ${(o.reason as Error).name}` : JSON.stringify(o);
    let inShield: Outcome<string> | undefined;
    let inCall: Outcome<string> | undefined;
    let step: Outcome<string> | undefined;
    const root = app();
    const v = await within(
      root.call(
        task(
          function* () {
            yield* shield(() =>
              shield(function* () {
                inShield = yield* unshield(peer); // the outer shield's signal: the deadline
              }),
            );
            return 'owner done';
          },
          { name: 'owner', releaseTimeoutMs: 30 },
        ),
      ),
    );
    await within(
      root.call(function* () {
        yield* shield(function* () {
          step = yield* attempt(
            task(
              function* () {
                yield* shield(function* () {
                  inCall = yield* unshield(peer); // the call's signal: its own timeout, which no shield deadline fires
                });
                return 'step done';
              },
              { name: 'step', timeoutMs: 30 },
            ),
          );
        });
      }),
    );
    expect({ v, inShield: timedOut(inShield), inCall: timedOut(inCall), step: timedOut(step) }).toEqual({
      v: 'owner done',
      inShield: 'aborted: TimeoutError',
      inCall: 'aborted: TimeoutError',
      step: 'aborted: TimeoutError',
    });
  });

  it('one hole around an all(), a body returning an op (decision 28): the owner’s interruption reaches its members, and the hole ends aborted with the owner’s reason', async () => {
    const reason = new Error('owner cut');
    let r: Outcome<unknown> | undefined;
    const members: Context[] = [];
    const step = (name: string) =>
      task(
        function* () {
          members.push(current());
          yield* never();
        },
        { name },
      );
    const root = app();
    const owner = root.fork(
      task(
        function* () {
          yield* shield(function* () {
            r = yield* unshield(() => all([step('a'), step('b')])); // one hole: a body returning an op
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(members.length).toBe(2);
    owner.abort(reason);
    await within(root.result(owner));
    expect({ hole: r, members: members.map((m) => m.outcome) }).toEqual({
      hole: { status: 'aborted', reason },
      members: [
        { status: 'aborted', reason },
        { status: 'aborted', reason },
      ],
    });
  });
});
