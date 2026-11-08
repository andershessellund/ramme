// Tests for lifecycle / reentrant shutdown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { child, current, fork, interrupted, join, never, own, release, result, shield, sleep, wait } from '../../src/ambient.js';
import type { Context, Fiber, Instruction, Op, Operation, Outcome } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { deferred, events, impl, tick, trace, within } from '../support/util.js';
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

describe('reentrant shutdown and failure accounting', () => {
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

  it('an op one body made, returned by a synchronous body (driven as its body, decision 28) or yielded by another, runs for the body that consumes it: its maker’s interruption reaches neither, nothing is classified by awaiter, and nothing warns', async () => {
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

  it('the applied-awaiter rule reads the awaiter that is resumed: an aborted fork yielding its live parent’s release(x) is returned when the release fails, consuming nothing, and the parent reports the release failure once', async () => {
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

  it('a shield in the halted finally yielding its body’s release(x) is not an applied awaiter: it consumes what it catches, and what it rethrows is reported once', async () => {
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
              yield* slow();
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
              yield* withTx(conn, () => (work === 'call' ? insert() : sleep(1000)));
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

  it('once the body has returned, while a shield run through then holds the owner open, a child’s generator failure handler may sleep and shield through the owner, which completes after both', async () => {
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
      outcome: { status: 'defect', error: expect.objectContaining({ name: 'UnjoinedFiberError' }) },
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
            yield* slow();
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

  it('a halted body’s close() and [Symbol.asyncDispose]() of nodes below it, yielded in its finally, consume nothing: a failure they hand it becomes its outcome, reported once', async () => {
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
              yield* slow();
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

  it('a shield made in a body runs nothing until it is yielded, so the body forks freely meanwhile; yielded, its release fiber is made then, and is current in its body', async () => {
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

  it('a body halted on close() or [Symbol.asyncDispose]() of an unrelated node is returned at once, not waited for; in its halted finally the same wait is release work, waited for to its end', async () => {
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
            yield* slow();
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

  it('join and result of a fork subscribed below a halted body return it once the fork has completed, so a helper’s finally around them runs after its work; an owned fork’s join returns it at once', async () => {
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

  it('the shape delivers a fork the delivery did not reach: below an observe child, a halted body’s join(f) aborts f with the body’s reason and returns the body once f has completed, while the observe child runs on', async () => {
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
                yield* result(f); // the observer still returns successfully, so it accounts for its child
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
