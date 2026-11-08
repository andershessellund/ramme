// Tests for lifecycle / interruption order.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { child, current, fork, interrupted, join, lookup, never, own, pool, race, release, shield, signal, sleep, wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import type { Context, Fiber, Instruction, Op, Outcome } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { valueProvider } from '../../src/provider-util.js';
import { RequestScope } from '../../src/scope.js';
import { deferred, impl, tick, trace, within } from '../support/util.js';
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

describe('interruption and release ordering', () => {
  it('after a halted call the finally runs lookup, fork, shield and call, the callee complete; a fork there is born delivered (it addresses the node, U3), a shield and a call are release work', async () => {
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
            yield* slow();
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
              call: yield* task(function* () {
                yield* sleep(1);
                return `called; delivered ${String(signal().aborted)}`;
              })(),
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

  it('a call of an observe task yielded after a halted wait(p) resumed the body is not run; a join of an observe fork made then returns the body at once, the fork undelivered, which hears the interruption when the body’s exit interrupts it', async () => {
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
              if (shape === 'call') yield* drain(); // not started: returned here, drain never runs
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

  it('a halted body yields release(tx) in its finally, whose rollback, a generator release, throws; it catches that: the outcome is failure carrying the release error, reported once', async () => {
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
            yield* slow();
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

  it('in its halted finally a body may yield [Symbol.asyncDispose]() and close() of nodes below it: release work; a close() of an unsubscribed pool is a drain as long as its work', async () => {
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
            yield* slow();
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

  it('a body that yields its own current()[Symbol.asyncDispose](), an ancestor’s, the release of its own entry, or its owner’s releaseAll() that releases it, is returned there, not waited for, no catch run, and completes aborted', async () => {
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

  it('a shield nobody yields runs nothing: its body never runs, and the owner releases and completes without it; one run through then holds its owner: its lookup after a tick finds the value still live, the owner completes after it, and its failure is consumed by that then, so the owner succeeds', async () => {
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

  it('a shield started on its owner during the release phase (ctx.shield from an entry’s release) still completes before the owner, with no ordering against entries already released', async () => {
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

  it('a generator body has no Promise combinator; race() aborts and awaits its loser, so a loser’s late failure never happens, nothing is consumed into an ignored race, and nothing warns', async () => {
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
