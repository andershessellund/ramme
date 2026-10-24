// rejection-pin.test.ts — the pinning tests of sticky rejection (D39; DESIGN.md §4.2 as rewritten by it).
//
// Each test states the behaviour D39 specifies. After delivery, every managed await of a `freeze` body rejects
// with `InterruptedError(reason)`: one in flight at the delivery, and every one made afterwards. Release work
// (`release`, `releaseAll`, `close`, `shield`) is exempt. The node completes only after its body has unwound,
// and its outcome is `aborted` by state (D24). Under freeze (D13, superseded) the body instead never resumed:
// tests 1–6 failed against the code they were written before, and test 7 passed there too.
//
// Each test first compares one observation object (the trace, the outcome, the warnings), so that a failure
// shows the whole of the behaviour in its diff, and checks classes only afterwards. The second describe block
// pins the amendments of the specification's review (its section F), the third the fixes of the implementation's
// review.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './node.js';
import { call, child, current, fork, interrupted, join, lookup, managed, never, own, pool, release, result, shield, signal, sleep } from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber, Outcome } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { inject } from './inject.js';
import { valueProvider } from './provider-util.js';
import { FiberAbortedError, InterruptedError, OwnerInterrupt, UnawaitedCallError } from './resource.js';
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

/** A bare wait: a platform timer, which no delivery touches (DESIGN.md §4.4). */
function bare(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `.reason` of an error (InterruptedError, FiberAbortedError) or of an outcome; `undefined` for anything else. */
function reasonOf(x: unknown): unknown {
  return typeof x === 'object' && x !== null ? (x as { reason?: unknown }).reason : undefined;
}

type Settlement = { state: 'pending' } | { state: 'fulfilled'; value: unknown } | { state: 'rejected'; error: unknown };

/** How a NATIVE promise has settled after `ms` real milliseconds. Never call it on a managed promise: that would be an await. */
async function settlement(p: Promise<unknown>, ms = 20): Promise<Settlement> {
  let s: Settlement = { state: 'pending' };
  p.then(
    (value) => void (s = { state: 'fulfilled', value }),
    (error: unknown) => void (s = { state: 'rejected', error }),
  );
  await bare(ms);
  return s;
}

/** `f`'s outcome, read from top level. It pushes `complete` to `t` when it arrives, which is a microtask or two after the node completed. */
function completion<T>(root: Context, f: Fiber<T>, t: Trace): Promise<Outcome<T>> {
  return root.result(f).then((o) => {
    t.push('complete');
    return o;
  });
}

/** The work in flight when the body is interrupted: a `call` that never ends on its own. */
function slowTask(t: Trace) {
  return task(
    async () => {
      t.push('slow running');
      await never();
    },
    { name: 'slow' },
  );
}

describe('sticky rejection: the pinning tests (D39, DESIGN.md §4.2)', () => {
  it('1. foreign finally: a helper’s finally around an interrupted call runs before the node releases its entries', async () => {
    const t = trace();
    const reason = new Error('hang up');
    // A driver's transaction helper (`db.transaction(async (tx) => …)`). It is a plain async function that runs in
    // the body's own async context, so ramme cannot tell it from the body.
    const withTx = async <T>(fn: () => Promise<T>): Promise<T> => {
      t.push('begin');
      try {
        return await fn();
      } finally {
        t.push('end');
      }
    };
    const slow = slowTask(t);
    let tx: Promise<unknown> | undefined;
    const root = app();
    const f = root.fork(
      task(
        () => {
          own(t.at('entry released'));
          const p = withTx(() => call(slow));
          tx = p;
          return p;
        },
        { name: 'request', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['begin', 'slow running']); // the call is in flight
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    const s = await settlement(tx!);
    expect({ log: t.log, outcome: o, tx: s.state, txReason: s.state === 'rejected' ? reasonOf(s.error) : undefined }).toEqual({
      log: ['begin', 'slow running', 'end', 'entry released', 'complete'],
      outcome: { status: 'aborted', reason },
      tx: 'rejected',
      txReason: reason,
    });
    expect((s as { error: unknown }).error).toBeInstanceOf(InterruptedError);
    await root.close();
  });

  it('2. sticky: a body that catches its interruption does no more ramme work, and is aborted', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const slow = slowTask(t);
    const other = task(
      async () => {
        t.push('other ran');
      },
      { name: 'other' },
    );
    let caught: unknown;
    let sleepError: unknown;
    const root = app();
    const f = root.fork(
      task(
        async () => {
          try {
            await call(slow);
          } catch (e) {
            caught = e; // the body's own interruption, swallowed
            t.push('caught');
          }
          try {
            await sleep(1);
          } catch (e) {
            sleepError = e; // recorded and rethrown: the sleep's rejection is what unwinds the body
            t.push('sleep rejected');
            throw e;
          }
          t.push('slept');
          await call(other);
          t.push('after other');
        },
        { name: 'swallower', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['slow running']);
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    await bare(20); // a body that resumed late would show here
    expect({ log: t.log, outcome: o, caughtReason: reasonOf(caught), sleepReason: reasonOf(sleepError) }).toEqual({
      log: ['slow running', 'caught', 'sleep rejected', 'complete'],
      outcome: { status: 'aborted', reason },
      caughtReason: reason,
      sleepReason: reason,
    });
    expect(caught).toBeInstanceOf(InterruptedError);
    expect(caught).not.toBeInstanceOf(FiberAbortedError); // the caller's own interruption, not the callee's abort
    expect(sleepError).toBeInstanceOf(InterruptedError);
    await root.close();
  });

  it('3. bare work after a caught interruption: the owner waits for it; aborted by state, the value discarded, no warning', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const slow = slowTask(t);
    const root = app();
    const f = root.fork(
      task(
        async () => {
          try {
            await call(slow);
          } catch {
            t.push('caught');
          }
          await bare(20);
          t.push('bare work done');
          return 'discarded';
        },
        { name: 'bare-after-catch', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['slow running']);
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    await bare(40); // a body still running after its node completed would show here
    expect({ log: t.log, outcome: o, warnings: rammeWarnings() }).toEqual({
      log: ['slow running', 'caught', 'bare work done', 'complete'],
      outcome: { status: 'aborted', reason },
      warnings: [],
    });
    await root.close();
  });

  it('4. shield: release work after the interruption runs to its end, undelivered, and the node completes after it', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const slow = slowTask(t);
    const inShield: { kind: string; mode: string; parentIsBody: boolean; aborted: boolean }[] = [];
    const root = app(); // no releaseTimeoutMs: a shield's signal never fires
    const f = root.fork(
      task(
        async () => {
          const body = current();
          const look = (): void => {
            const n = impl(current());
            inShield.push({ kind: n.kind, mode: n.mode, parentIsBody: n.parent === body, aborted: signal().aborted });
          };
          try {
            await call(slow);
          } catch (e) {
            await shield(async () => {
              look();
              await sleep(5); // a release fiber's sleep runs its full duration
              look();
              t.push('rolled back');
            });
            t.push('after shield');
            throw e;
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
    const asRelease = { kind: 'release', mode: 'observe', parentIsBody: true, aborted: false };
    expect({ log: t.log, outcome: o, inShield }).toEqual({
      log: ['slow running', 'rolled back', 'after shield', 'complete'],
      outcome: { status: 'aborted', reason },
      inShield: [asRelease, asRelease],
    });
    await root.close();
  });

  it('5. lease order: under the unit-of-work idiom, a foreign finally runs before the entries, and rollback runs in a release fiber', async () => {
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
    /** README's UnitOfWork, as DESIGN.md §2.6 writes it. */
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
      query(sql: string): Promise<void> {
        return this.#lease.conn.query(sql, signal());
      }
      async commit(): Promise<void> {
        await tick();
        t.push(`commit in ${impl(current()).kind}`);
      }
      async rollback(): Promise<void> {
        await tick();
        t.push(`rollback in ${impl(current()).kind}`);
      }
    }
    // A foreign helper with a finally, in the request body: a mutex, a retry wrapper, a driver's transaction callback.
    const mutex = {
      async run<T>(fn: () => Promise<T>): Promise<T> {
        t.push('lock');
        try {
          return await fn();
        } finally {
          t.push('unlock');
        }
      },
    };
    const insert = task(async (uow: UnitOfWork) => uow.query('insert'), { name: 'insert' });
    const request = task(
      async () => {
        const uow = lookup(UnitOfWork); // stored on this fiber, which carries RequestScope
        return mutex.run(() => call(insert, uow));
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

  it('6. combinators: Promise.race over managed promises is safe but not structured', async () => {
    // `Promise.race([call(a), call(b)])` cannot be written: `call(a)` lends the current node until `a` completes, so
    // `call(b)` throws UnawaitedCallError (DESIGN.md §4.9, unchanged by D39). The managed promises raced are therefore
    // joins of forks.
    const racers = (t: Trace) => ({
      a: task(
        async () => {
          await sleep(1);
          return 'a';
        },
        { name: 'a' },
      ),
      b: task(
        async (): Promise<string> => {
          t.push('b running');
          return never();
        },
        { name: 'b' },
      ),
    });

    // (a) Not interrupted: the winner's value, and the loser keeps running until the body ends, which interrupts it.
    const t = trace();
    const { a, b } = racers(t);
    let loser: Fiber<string> | undefined;
    const root = app();
    const v = await within(
      root.call(async () => {
        const fa = fork(a);
        const fb = fork(b);
        loser = fb;
        const winner = await Promise.race([join(fa), join(fb)]);
        t.push(`won ${winner}`);
        t.push(`loser ${fb.state}`);
        await bare(10); // the body goes on; the loser is not aborted (ramme's race() would have)
        t.push(`loser still ${fb.state}`);
        return winner;
      }),
    );
    expect({
      value: v,
      log: t.log,
      loser: loser!.outcome?.status,
      loserReasonIsOwnerInterrupt: reasonOf(loser!.outcome) instanceof OwnerInterrupt,
      warnings: rammeWarnings(),
    }).toEqual({
      value: 'a',
      log: ['b running', 'won a', 'loser running', 'loser still running'],
      loser: 'aborted',
      loserReasonIsOwnerInterrupt: true,
      warnings: [],
    });

    // (b) The same shape, interrupted after the race while the body does bare work and the loser's join is still
    // awaited by the race: no accounting hazard. The body runs to its end, the node completes after it, and nothing warns.
    const t2 = trace();
    const r2 = racers(t2);
    const reason = new Error('hang up');
    const raced = deferred();
    const f = root.fork(
      task(
        async () => {
          const fa = fork(r2.a);
          const fb = fork(r2.b);
          const winner = await Promise.race([join(fa), join(fb)]);
          t2.push(`won ${winner}`);
          raced.resolve();
          await bare(20); // interrupted meanwhile
          t2.push('bare work done');
          return winner;
        },
        { name: 'racer', ...quiet },
      ),
    );
    await within(raced.promise);
    const done = completion(root, f, t2);
    f.abort(reason);
    const o = await within(done);
    await bare(40); // a body still running after its node completed would show here
    expect({ log: t2.log, outcome: o, warnings: rammeWarnings() }).toEqual({
      log: ['b running', 'won a', 'bare work done', 'complete'],
      outcome: { status: 'aborted', reason },
      warnings: [],
    });
    await root.close();
  });

  it('7. I10: a stored, never-awaited call on an interrupted node is never an unhandled rejection', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const slow = slowTask(t);
    const quick = task(
      () => {
        t.push('quick ran'); // born delivered, under the birth rule: runs until its first managed await
        return 'q';
      },
      { name: 'quick' },
    );
    let before: Promise<unknown> | undefined;
    let after: Promise<unknown> | undefined;
    const stored = deferred();
    const root = app();
    const f = root.fork(
      task(
        async () => {
          before = call(slow); // stored before the delivery and never awaited; the node is lent to slow until it completes
          stored.resolve();
          await bare(20); // across the delivery (a bare await: the node is lent, so a managed one would be refused)
          after = call(quick); // stored after the delivery and never awaited
          t.push('body ends');
        },
        { name: 'storer', ...quiet },
      ),
    );
    await within(stored.promise);
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    await tick(3); // Node reports an unhandled rejection once the microtask queue drains
    const guard = unhandledRejectionGuard();
    expect({
      log: t.log,
      outcome: o,
      unhandled: (guard?.seen ?? []).map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))),
      storedAreManaged: [before instanceof Promise, after instanceof Promise], // read, never awaited
    }).toEqual({
      log: ['slow running', 'quick ran', 'body ends', 'complete'],
      outcome: { status: 'aborted', reason },
      unhandled: [],
      storedAreManaged: [true, true],
    });
    await root.close();
  });
});

describe('sticky rejection: the amendments (D39 settled notes)', () => {
  it('A.2: after an interrupted call the catch runs lookup, fork and shield without UnawaitedCallError, the callee complete; a call made then to an observe task delivers it and rejects once it completed', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const K = createInjectionKey<string>('K');
    let callee!: Context;
    let drained!: Context;
    const slow = task(
      async () => {
        callee = current();
        t.push('slow running');
        await never();
      },
      { name: 'slow' },
    );
    const drain = task(
      async () => {
        drained = current();
        await interrupted(); // an observe body: resolves with the reason
        t.push('drain stopped');
      },
      { name: 'drain', interrupt: 'observe' },
    );
    let inCatch: Record<string, unknown> = {};
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    roots.push(root);
    const f = root.fork(
      task(
        async () => {
          const withTx = async <T>(fn: () => Promise<T>): Promise<T> => {
            try {
              return await fn();
            } finally {
              t.push(`foreign finally: callee ${callee.state}`);
            }
          };
          try {
            await withTx(() => call(slow));
          } catch (e) {
            inCatch = {
              interrupted: e instanceof InterruptedError,
              callee: callee.state,
              lookup: lookup(K),
              forkBornDelivered: fork(async () => 'forked').signal.aborted,
              shield: await shield(() => lookup(K)),
            };
            try {
              await call(drain); // after the delivery: an observe child is not born delivered (D12)
            } catch (e2) {
              inCatch.drain = `${(e2 as Error).name}; drain ${drained.state}, delivered ${String(drained.signal.aborted)}`;
            }
            throw e;
          }
        },
        { name: 'request', ...quiet },
      ),
    );
    await tick();
    f.abort(reason);
    const o = await within(root.result(f));
    expect({ log: t.log, outcome: o, inCatch }).toEqual({
      log: ['slow running', 'foreign finally: callee complete', 'drain stopped'],
      outcome: { status: 'aborted', reason },
      inCatch: {
        interrupted: true,
        callee: 'complete',
        lookup: 'k',
        forkBornDelivered: true,
        shield: 'k',
        drain: 'InterruptedError; drain complete, delivered true',
      },
    });
    expect(Object.values(inCatch).some((v) => v instanceof UnawaitedCallError)).toBe(false);
    await root.close();
  });

  it('A.3: an interrupted body awaits release(tx), whose rollback throws; it swallows that and rethrows its InterruptedError: the outcome is failure carrying the release error, reported once', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const rollbackError = new Error('rollback failed');
    const slow = slowTask(t);
    const failures: unknown[] = [];
    let fromRelease: unknown;
    let rethrown: unknown;
    const root = app();
    const f = root.fork(
      task(
        async () => {
          const tx = own({}, async () => {
            await tick();
            throw rollbackError;
          });
          try {
            await call(slow);
          } catch (e) {
            try {
              await release(tx); // release work: not rejected, and its failure is not consumed by this applied body
            } catch (r) {
              fromRelease = r;
            }
            rethrown = e;
            throw e;
          }
        },
        { name: 'tx', onFailure: (e) => void failures.push(e) },
      ),
    );
    await tick();
    f.abort(reason);
    const o = await within(root.result(f));
    expect({ outcome: o, fromRelease, failures }).toEqual({
      outcome: { status: 'failure', error: rollbackError }, // aborted + the unconsumed release failure (D24)
      fromRelease: rollbackError,
      failures: [rollbackError],
    });
    expect(rethrown).toBeInstanceOf(InterruptedError);
    await expect(root.close()).resolves.toBeUndefined(); // once: the handler had it
  });

  it('A.3: after its delivery a body may still await [Symbol.asyncDispose]() and close() of nodes below it: release work, not rejected; a close() of an unsubscribed pool is a drain as long as its work', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const gate = deferred();
    const slow = slowTask(t);
    const root = app();
    const f = root.fork(
      task(
        async () => {
          const jobs = pool({ name: 'jobs', onFailure: () => {} }); // unsubscribed: not delivered with the body (D15)
          jobs.fork(async () => {
            await gate.promise;
            t.push('job finished');
          });
          const scope = child({ name: 'scope' });
          scope.own(() => void t.push('scope released'));
          try {
            await call(slow);
          } catch (e) {
            await scope[Symbol.asyncDispose](); // below the body: exempt
            t.push('scope disposed');
            await jobs.close(); // below the body: exempt, and a graceful drain
            t.push('pool drained');
            throw e;
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

  it('A.3: a body that awaits its own current()[Symbol.asyncDispose](), an ancestor’s, or the release of its own entry is rejected, not exempt, and completes aborted', async () => {
    const seen: unknown[] = [];
    const root = app();
    const selfRelease = root.fork(
      task(
        async () => {
          try {
            await root.release(current()); // its own entry on root: the release waits for this body's completion
          } catch (e) {
            seen.push(e);
            throw e;
          }
        },
        { name: 'self-release', ...quiet },
      ),
    );
    const own1 = root.fork(
      task(
        async () => {
          try {
            await current()[Symbol.asyncDispose](); // waits for this body's own completion: exempting it would deadlock
          } catch (e) {
            seen.push(e);
            throw e;
          }
        },
        { name: 'self', ...quiet },
      ),
    );
    const svc = root.child({ name: 'svc' });
    const shutdown = svc.fork(
      task(
        async () => {
          try {
            await svc[Symbol.asyncDispose](); // a shutdown fork awaiting its own owner's disposal
          } catch (e) {
            seen.push(e);
            throw e;
          }
        },
        { name: 'shutdown', ...quiet },
      ),
    );
    const outcomes = await within(Promise.all([root.result(selfRelease), root.result(own1), root.result(shutdown)]));
    expect(outcomes.map((o) => o.status)).toEqual(['aborted', 'aborted', 'aborted']);
    expect(seen).toHaveLength(3);
    for (const e of seen) expect(e).toBeInstanceOf(InterruptedError);
    expect(svc.state).toBe('complete');
    await root.close();
  });

  it('A.4: a shield nobody awaits holds its owner: its lookup after a tick finds the value still live, the owner completes after it, and its failure surfaces from the owner', async () => {
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
        () => {
          const conn = lookup(Conn); // stored on this fiber, which carries RequestScope
          void shield(async () => {
            await tick();
            t.push(`shield: same conn ${String(lookup(Conn) === conn)}`);
            throw shieldError;
          });
          t.push('body returns');
          return 'done';
        },
        { name: 'owner', scopes: [RequestScope], onFailure: (e) => void failures.push(e) },
      ),
    );
    const o = await within(completion(root, f, t));
    expect({ log: t.log, outcome: o, failures }).toEqual({
      log: ['body returns', 'shield: same conn true', 'conn released', 'complete'],
      outcome: { status: 'failure', error: shieldError }, // success + the shield's unconsumed failure (I11)
      failures: [shieldError],
    });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('A.4: a shield started on its owner during the release phase (ctx.shield from an entry’s release) still completes before the owner, with no ordering against entries already released', async () => {
    const t = trace();
    const root = app();
    const f = root.fork(
      task(
        () => {
          const owner = current();
          own(() => {
            // In the entry's release fiber: a shield on the owner, which is releasing, not on this release fiber.
            void owner.shield(async () => {
              await tick(2);
              t.push(`late shield done; owner ${owner.state}`);
            });
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

  it('A.7: an undelivered body awaiting a managed promise a delivered body made is rejected with FiberAbortedError, and rethrowing it fails with it, never as an interruption', async () => {
    const reason = new Error('hang up');
    const made = deferred();
    let shared: Promise<unknown> | undefined;
    const root = app();
    const long = root.fork(task(async () => never(), { name: 'long', ...quiet }));
    const creator = root.fork(
      task(
        async () => {
          shared = join(long); // targeted at creator, which made it
          made.resolve();
          await never();
        },
        { name: 'creator', ...quiet },
      ),
    );
    await within(made.promise);
    const failures: unknown[] = [];
    let seen: unknown;
    const awaiter = root.fork(
      task(
        async () => {
          try {
            await shared;
          } catch (e) {
            seen = e;
            throw e;
          }
        },
        { name: 'awaiter', onFailure: (e) => void failures.push(e) },
      ),
    );
    await tick();
    creator.abort(reason);
    const o = await within(root.result(awaiter));
    expect({
      outcome: o.status,
      seen: (seen as Error)?.name,
      seenReason: (seen as { reason?: unknown })?.reason,
      failures: failures.map((e) => (e as Error).name),
      warnings: rammeWarnings().map((w) => /is awaited by fiber #\d+ 'awaiter'.*FiberAbortedError/.test(w)),
    }).toEqual({
      outcome: 'failure', // not aborted: the awaiter was not interrupted (I12)
      seen: 'FiberAbortedError',
      seenReason: reason,
      failures: ['FiberAbortedError'],
      warnings: [true],
    });
    expect(seen).not.toBeInstanceOf(InterruptedError);
    long.abort();
    await root.close();
  });

  it('A.8: Promise.race([join(fa), join(fb)]) whose loser fails after the race settled: the failure is consumed into the ignored race and lost, and the owner completes cleanly (the documented hazard)', async () => {
    const lost = new Error('loser failed late');
    const gate = deferred();
    let fb!: Fiber<never>;
    const root = app();
    const v = await within(
      root.call(async () => {
        const fa = fork(async () => 'a');
        fb = fork(async (): Promise<never> => {
          await gate.promise;
          throw lost;
        });
        const winner = await Promise.race([join(fa), join(fb)]);
        gate.resolve();
        await bare(10); // fb fails while the body runs on; its join's resume step consumes the failure into the race
        return winner;
      }),
    );
    expect({ value: v, loser: fb.outcome, consumed: impl(fb).failure?.consumed, warnings: rammeWarnings() }).toEqual({
      value: 'a',
      loser: { status: 'failure', error: lost },
      consumed: true,
      warnings: [],
    });
    await expect(root.close()).resolves.toBeUndefined(); // nothing surfaces: the failure is gone
  });
});

describe('sticky rejection: the fixes of the implementation review', () => {
  /** A plain async transaction helper over a connection-like object: its finally reports whether the connection is still open. */
  function txHelper(t: Trace) {
    return async <T>(conn: { open: boolean }, fn: () => Promise<T>): Promise<T> => {
      t.push('BEGIN');
      try {
        return await fn();
      } finally {
        t.push(conn.open ? 'ROLLBACK on open connection' : 'ROLLBACK on RETURNED connection');
      }
    };
  }

  it('A.7: a synchronous body returning another body’s managed promise, and managed() over one, are its own cross-body awaits: FiberAbortedError and the dev warning, never an InterruptedError', async () => {
    const reason = new Error('hang up');
    const root = app();
    /** A body that makes a sleep, its own managed promise, and parks on never(). */
    const creator = (name: string) => {
      const box: { shared?: Promise<void> } = {};
      const made = deferred();
      const f = root.fork(
        task(
          async () => {
            box.shared = sleep(1000);
            made.resolve();
            await never();
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
    const syncReturn = root.fork(task(() => a.box.shared!, { name: 'sync-return', onFailure })); // startBody subscribes for it
    const viaManaged = root.fork(
      task(
        async () => {
          await managed(b.box.shared!); // managed(p) subscribes to its managed source for this body
        },
        { name: 'via-managed', onFailure },
      ),
    );
    await tick();
    a.f.abort(reason);
    b.f.abort(reason);
    const outcomes = await within(Promise.all([root.result(syncReturn), root.result(viaManaged)]));
    expect({
      outcomes: outcomes.map((o) => (o.status === 'failure' ? `${(o.error as Error).name}, reason ${String(reasonOf(o.error) === reason)}` : o.status)),
      failures: failures.map((e) => (e as Error).name),
      warnings: rammeWarnings().map((w) => /is awaited by fiber #\d+ '([^']+)'.*FiberAbortedError/.exec(w)?.[1]),
    }).toEqual({
      outcomes: ['FiberAbortedError, reason true', 'FiberAbortedError, reason true'], // not interrupted, so not InterruptedError (I12)
      failures: ['FiberAbortedError', 'FiberAbortedError'],
      warnings: ['sync-return', 'via-managed'],
    });
    await root.close();
  });

  it('A.3: the applied-awaiter rule reads the awaiter that is resumed: an aborted fork awaiting its live parent’s release(x) consumes nothing, and the parent reports the release failure once', async () => {
    const rollbackError = new Error('rollback failed');
    const failures: unknown[] = [];
    let awaiterOutcome: Outcome<unknown> | undefined;
    let awaiterSaw: unknown;
    const root = app();
    const parent = root.fork(
      task(
        async () => {
          const x = own({}, async () => {
            await bare(20);
            throw rollbackError;
          });
          const p = release(x); // the parent's release work; the parent is never interrupted
          const started = deferred();
          const awaiter = fork(async () => {
            started.resolve();
            try {
              await p; // a cross-body await of the parent's promise
            } catch (e) {
              awaiterSaw = e;
              throw e;
            }
          });
          await started.promise;
          await bare(1);
          awaiter.abort(); // applied while it waits: the release fails after this, and its throw is discarded (D24)
          awaiterOutcome = await result(awaiter);
          return 'parent done';
        },
        { name: 'parent', onFailure: (e) => void failures.push(e) },
      ),
    );
    const o = await within(root.result(parent));
    expect({ outcome: o, failures, awaiter: awaiterOutcome?.status, awaiterSaw, warnings: rammeWarnings().length }).toEqual({
      outcome: { status: 'failure', error: rollbackError }, // the record stayed with its holder (I11)
      failures: [rollbackError],
      awaiter: 'aborted',
      awaiterSaw: rollbackError, // handed the failure, as an applied awaiter is, without consuming it
      warnings: 1, // the cross-body await is still reported
    });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('A.3: a shield awaiting its interrupted body’s release(x) is not an applied awaiter: it consumes what it catches, and what it rethrows is reported once', async () => {
    const reason = new Error('hang up');
    const rollbackError = new Error('rollback failed');
    const failures: unknown[] = [];
    const t = trace();
    const slow = slowTask(t);
    const root = app();
    const run = (rethrow: boolean) =>
      root.fork(
        task(
          async () => {
            const x = own({}, async () => {
              await tick();
              throw rollbackError;
            });
            try {
              await call(slow);
            } catch (e) {
              const p = release(x); // made by the applied body: release work
              try {
                await shield(async () => {
                  try {
                    await p; // the shield's cross-body await: the shield is not applied, so it consumes
                  } catch (r) {
                    if (rethrow) throw r;
                  }
                });
              } catch {
                // the shield's own failure, rethrown from p: the applied body consumes nothing
              }
              throw e;
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
        { status: 'failure', error: rollbackError }, // the shield's failure alone, not also the release record it consumed
      ],
      failures: [rollbackError],
    });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('a child() scope of an interrupted body is released after the body has unwound, at its turn: a foreign finally around the interrupted await still finds what the scope owns', async () => {
    const logs: Record<string, readonly string[]> = {};
    for (const work of ['call', 'sleep'] as const)
      for (const stop of ['abort', 'root dispose'] as const) {
        const t = trace();
        const withTx = txHelper(t);
        const insert = task(
          async () => {
            t.push('insert running');
            await never();
          },
          { name: 'insert' },
        );
        const root = app();
        const f = root.fork(
          task(
            async () => {
              const scope = child({ name: 'scope' });
              const conn = scope.own({ open: true }, (c) => {
                c.open = false;
                t.push('returned to pool');
              });
              scope.child({ name: 'inner' }).own(t.at('inner released')); // a bodiless node below the scope: released with it
              await withTx(conn, () => (work === 'call' ? call(insert) : sleep(1000)));
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

  it('A.4: a void shield lends its owner only while the body runs: once the body has returned, a child’s failure handler may sleep and shield through the owner', async () => {
    const t = trace();
    const err = new Error('child failed');
    const gate = deferred();
    const ev = events();
    roots.push(ev.root);
    const owner = ev.root.fork(
      task(
        async () => {
          own(
            fork(
              task(
                async () => {
                  await tick();
                  throw err;
                },
                {
                  name: 'kid',
                  onFailure: async () => {
                    try {
                      await sleep(5);
                      t.push('handler slept');
                      t.push(await shield(async () => 'handler shielded'));
                    } catch (e) {
                      t.push(`handler: ${(e as Error).name}`);
                    } finally {
                      gate.resolve();
                    }
                  },
                },
              ),
            ),
          );
          void shield(async () => {
            await gate.promise; // outlives the body, and the handler
            t.push('shield done');
          });
          return 'ok';
        },
        { name: 'owner', ...quiet },
      ),
    );
    const o = await within(ev.root.result(owner));
    const ownerId = impl(owner).id;
    const lent = ev.of('node:lent').filter((e) => e.id === ownerId);
    const returned = ev.of('node:returned').filter((e) => e.id === ownerId);
    const shieldId = lent[0]?.childId;
    const settledBody = ev.of('node:settled').find((e) => e.id === ownerId);
    const shieldComplete = ev.of('node:complete').find((e) => e.id === shieldId);
    expect({
      outcome: o,
      log: t.log,
      pairs: [lent.length, returned.length, returned[0]?.childId === shieldId],
      returnedWithTheBody: returned[0] !== undefined && settledBody !== undefined && returned[0].seq > settledBody.seq,
      beforeTheShieldCompleted: returned[0] !== undefined && shieldComplete !== undefined && returned[0].seq < shieldComplete.seq,
    }).toEqual({
      outcome: { status: 'success', value: 'ok' },
      log: ['handler slept', 'handler shielded', 'shield done'],
      pairs: [1, 1, true],
      returnedWithTheBody: true,
      beforeTheShieldCompleted: true,
    });
  });

  it('shield’s resume step consumes a failure the body catches, and an interrupted body’s consumes nothing: the shield’s error is then its outcome, reported once', async () => {
    const reason = new Error('hang up');
    const shieldError = new Error('cleanup failed');
    const failures: unknown[] = [];
    const onFailure = (e: unknown): void => void failures.push(e);
    const t = trace();
    const slow = slowTask(t);
    let fromShield: unknown;
    const root = app();
    const live = root.fork(
      task(
        async () => {
          try {
            await shield(async () => {
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
    const interruptedBody = root.fork(
      task(
        async () => {
          try {
            await call(slow);
          } catch (e) {
            try {
              await shield(async () => {
                await tick();
                throw shieldError;
              });
            } catch (s) {
              fromShield = s;
            }
            throw e;
          }
        },
        { name: 'interrupted', onFailure },
      ),
    );
    await tick();
    interruptedBody.abort(reason);
    const outcomes = await within(Promise.all([root.result(live), root.result(interruptedBody)]));
    expect({ outcomes, fromShield, failures }).toEqual({
      outcomes: [
        { status: 'success', value: 'ok' },
        { status: 'failure', error: shieldError }, // aborted + the shield's unconsumed failure (D24)
      ],
      fromShield: shieldError,
      failures: [shieldError],
    });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('A.3: an interrupted body’s close() and [Symbol.asyncDispose]() of nodes below it consume nothing: a failure they hand it becomes its outcome, reported once', async () => {
    const reason = new Error('hang up');
    const releaseError = new Error('release failed');
    const bodyError = new Error('fiber body failed');
    const failures: string[] = [];
    const handed: string[] = [];
    const t = trace();
    const slow = slowTask(t);
    const root = app();
    /** A body interrupted mid-call whose catch awaits `stop()` of something below it, swallows what it hands over, and rethrows. */
    const shape = (name: string, prepare: () => () => Promise<void>) =>
      root.fork(
        task(
          async () => {
            const stop = prepare();
            try {
              await call(slow);
            } catch (e) {
              try {
                await stop();
              } catch (r) {
                handed.push(`${name}: ${(r as Error).message}`);
              }
              throw e;
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
          async () => {
            await interrupted(); // an observe body: its outcome is its own, so its throw is a failure
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
        { status: 'failure', error: releaseError },
        { status: 'failure', error: releaseError },
        { status: 'failure', error: bodyError },
      ],
      handed: ['close: release failed', 'dispose scope: release failed', 'dispose fiber: fiber body failed'],
      failures: ['close: release failed', 'dispose fiber: fiber body failed', 'dispose scope: release failed'],
    });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('A.4: shield lends the current node while its body runs: an unawaited shield is a forgotten await, and the lending ends when the shield completes', async () => {
    const ev = events();
    roots.push(ev.root);
    let refused: unknown;
    let shieldNode: Context | undefined;
    let body: Context | undefined;
    const v = await within(
      ev.root.call(async () => {
        body = current();
        const p = shield(async () => {
          shieldNode = current();
          await tick();
          return 'shielded';
        });
        try {
          fork(async () => 'too early');
        } catch (e) {
          refused = e;
        }
        const r = await p;
        fork(async () => 'after the shield'); // returned: no longer lent
        return r;
      }),
    );
    const bodyId = impl(body!).id;
    const lending = ev.log.filter((e) => e.id === bodyId && (e.type === 'node:lent' || e.type === 'node:returned'));
    expect({
      value: v,
      refused: refused instanceof UnawaitedCallError,
      refusedNames: (refused as UnawaitedCallError | undefined)?.child === shieldNode,
      shieldKind: shieldNode === undefined ? undefined : impl(shieldNode).kind,
      lending: lending.map((e) => `${e.type} ${String((e as { childId: number }).childId === impl(shieldNode!).id)}`),
    }).toEqual({
      value: 'shielded',
      refused: true,
      refusedNames: true,
      shieldKind: 'release',
      lending: ['node:lent true', 'node:returned true'],
    });
  });

  it('A.3: an interrupted body’s close() and [Symbol.asyncDispose]() of an unrelated node reject at once: not its release work, and not waited for', async () => {
    const reason = new Error('hang up');
    const gate = deferred();
    const t = trace();
    const slow = slowTask(t);
    const root = app();
    const sibling = root.child({ name: 'sibling' });
    sibling.fork(
      task(
        async () => {
          await gate.promise;
        },
        { name: 'busy', ...quiet },
      ),
    );
    const other = root.child({ name: 'other' });
    other.own(async () => {
      await gate.promise; // its release waits for the gate
    });
    const seen: string[] = [];
    const f = root.fork(
      task(
        async () => {
          try {
            await call(slow);
          } catch (e) {
            const ops = [
              ['close', () => sibling.close()],
              ['asyncDispose', () => other[Symbol.asyncDispose]()],
            ] as const;
            for (const [name, op] of ops) {
              try {
                await op();
                seen.push(`${name} resolved`);
              } catch (r) {
                seen.push(`${name}: ${(r as Error).name}`);
              }
            }
            throw e;
          }
        },
        { name: 'body', ...quiet },
      ),
    );
    await tick();
    const done = root.result(f).then((o) => o);
    f.abort(reason);
    const s = await settlement(done, 30);
    const before = { settled: s.state, seen: [...seen], sibling: sibling.state, other: other.state };
    gate.resolve();
    await within(root.close());
    expect({ before, outcome: s.state === 'fulfilled' ? s.value : undefined }).toEqual({
      before: { settled: 'fulfilled', seen: ['close: InterruptedError', 'asyncDispose: InterruptedError'], sibling: 'releasing', other: 'releasing' },
      outcome: { status: 'aborted', reason },
    });
  });

  it('A.2: join and result of a fork subscribed below an interrupted body reject once the fork has completed, so a foreign finally around them runs after its work; an owned fork’s join rejects at once', async () => {
    const logs: Record<string, readonly string[]> = {};
    for (const shape of ['join', 'result', 'owned join'] as const) {
      const t = trace();
      const update = task(
        async () => {
          t.push('writing');
          await bare(30); // a bare driver write, not handed signal()
          t.push('wrote');
        },
        { name: 'update' },
      );
      const helper = async (fn: () => Promise<unknown>): Promise<void> => {
        t.push('lock');
        try {
          await fn();
        } finally {
          t.push('unlock');
        }
      };
      const root = app();
      const f = root.fork(
        task(
          async () => {
            await helper(async () => {
              const w = shape === 'owned join' ? own(fork(update)) : fork(update);
              return shape === 'result' ? result(w) : join(w);
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

  it('A.2: a join in the catch of an observe fork born undelivered delivers it through the mark, and rejects once it has stopped', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const slow = slowTask(t);
    let joinError: unknown;
    const root = app();
    const f = root.fork(
      task(
        async () => {
          try {
            await call(slow);
          } catch (e) {
            const drain = fork(
              task(
                async () => {
                  const r = await interrupted(); // an observe body: resolves when the mark delivers it
                  t.push(`drain heard the body’s reason: ${String(r === reason)}`);
                },
                { name: 'drain', interrupt: 'observe' }, // not born delivered (D12)
              ),
            );
            try {
              await join(drain);
            } catch (j) {
              joinError = j;
              t.push(`join rejected; drain ${drain.state}`);
            }
            throw e;
          }
        },
        { name: 'request', ...quiet },
      ),
    );
    await tick();
    f.abort(reason);
    const o = await within(root.result(f));
    expect({ log: t.log, outcome: o, joinError: (joinError as Error | undefined)?.name }).toEqual({
      log: ['slow running', 'drain heard the body’s reason: true', 'join rejected; drain complete'],
      outcome: { status: 'aborted', reason },
      joinError: 'InterruptedError',
    });
    await root.close();
  });
});
