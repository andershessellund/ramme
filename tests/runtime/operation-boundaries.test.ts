// Tests for runtime / operation boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, current, fork, interrupted, join, never, own, release, result, shield, sleep, wait } from '../../src/ambient.js';
import type { Context, Instruction, Op } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { deferred, events, impl, tick, within } from '../support/util.js';

const warnings: string[] = [];

const roots: Context[] = [];

beforeEach(() => {
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(opts: { releaseTimeoutMs?: number } = {}): Context {
  const root = createRootContext(opts);
  roots.push(root);
  return root;
}

function rammeWarnings(): string[] {
  return warnings.filter((w) => w.startsWith('ramme:'));
}

/** A platform timer: a foreign promise. */
function bare(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fork `body` on a fresh root, halt it once it is suspended, and read its outcome (the failure's message, if any). */
async function halt(body: () => Generator<Instruction, unknown, unknown>, opts: { releaseTimeoutMs?: number } = {}) {
  const root = app(opts);
  const f = root.fork(task(body, { name: 'halted', onFailure: () => {} }));
  await tick();
  f.abort(new Error('hang up'));
  const o = await within(root.result(f), 2000);
  return o.status === 'defect' ? `defect: ${(o.error as Error).message}` : o.status;
}

/** A source whose `then` throws: a `Promise` subclass that overrides it. */
class Hostile<T> extends Promise<T> {
  override then(): never {
    throw new Error('hostile then');
  }
}

const failing = (name: string, ms = 1) =>
  task(
    function* (): Generator<Instruction, never, unknown> {
      yield* sleep(ms);
      throw new Error(`${name} failed`);
    },
    { name },
  );

describe('operation boundaries during interruption', () => {
  it('wait(fn) whose fn returns a ramme op keeps that op’s waitsFor: a failure handler’s wait(() => root.close()) holds nothing, so the close completes, and in a halted finally wait(() => current()[Symbol.asyncDispose]()) is decision 12’s return, with the warning, as the op yielded bare is', async () => {
    const shapes: [string, (root: Context) => Op<void>][] = [
      ['bare', (root) => root.close()],
      ['wait(op)', (root) => wait(root.close())],
      ['wait(fn)', (root) => wait(() => root.close())],
    ];
    const closes: Record<string, string> = {};
    for (const [name, closing] of shapes) {
      const root = app();
      root.fork(
        task(
          function* (): Generator<Instruction, never, unknown> {
            throw new Error('boom');
          },
          {
            onFailure: function* () {
              yield* closing(root); // waits for its parent's completion: holds nothing from here on (DESIGN.md §4.7)
            },
          },
        ),
      );
      await tick();
      closes[name] = await within(root.close(), 300).then(
        () => 'closed',
        (e: Error) => e.message,
      );
    }
    const log: string[] = [];
    const disposals: [string, () => Op<void>][] = [
      ['bare', () => current()[Symbol.asyncDispose]()],
      ['wait(fn)', () => wait(() => current()[Symbol.asyncDispose]())],
      ['wait(fn), close', () => wait(() => current().close())],
    ];
    const self: Record<string, string> = {};
    for (const [name, disposing] of disposals)
      self[name] = await halt(function* () {
        try {
          yield* never();
        } finally {
          yield* disposing(); // its completion waits for this finally
          log.push(`${name}: unreachable`);
        }
      });
    expect({ closes, self, log, warned: rammeWarnings().filter((w) => /waits for its own/.test(w)).length }).toEqual({
      closes: { bare: 'closed', 'wait(op)': 'closed', 'wait(fn)': 'closed' },
      self: { bare: 'aborted', 'wait(fn)': 'aborted', 'wait(fn), close': 'aborted' },
      log: [],
      warned: 3,
    });
  });

  it('U3 for then: work ops made in the halted finally and run through their then (Promise.all, an async helper) run on the unwind fiber, as yield* all([…]) does: each cleanup runs to its end, the node ends aborted with nothing recorded, wait’s function there is handed the live deadline, and a cleanup’s failure is reported once', async () => {
    const log: string[] = [];
    const cleanup = (name: string) =>
      task(
        function* () {
          yield* sleep(5); // a child born delivered is returned here, before its cleanup
          log.push(`${name} cleaned`);
        },
        { name },
      );
    const outcomes: Record<string, string> = {
      'Promise.all': await halt(function* () {
        try {
          yield* never();
        } finally {
          yield* wait(Promise.all([cleanup('a')(), cleanup('b')()]));
        }
      }),
      'async helper': await halt(function* () {
        try {
          yield* never();
        } finally {
          const op = cleanup('c')();
          yield* wait((async () => await op)());
        }
      }),
      'yield* all': await halt(function* () {
        try {
          yield* never();
        } finally {
          yield* all([cleanup('d'), cleanup('e')]);
        }
      }),
      'a failing cleanup': await halt(function* () {
        try {
          yield* never();
        } finally {
          yield* wait(Promise.all([failing('f', 20)(), cleanup('g')()])); // f fails after g has cleaned
        }
      }),
    };
    let handedAborted: boolean | undefined;
    outcomes['wait(fn) through then'] = await halt(function* () {
      try {
        yield* never();
      } finally {
        const op = wait((signal) => {
          handedAborted = signal.aborted; // the unwind fiber's deadline, not the node's fired signal
          return bare(1);
        });
        yield* wait(Promise.resolve(op));
      }
    });
    expect({ outcomes, log: [...log].sort(), handedAborted }).toEqual({
      outcomes: {
        'Promise.all': 'aborted',
        'async helper': 'aborted',
        'yield* all': 'aborted',
        'a failing cleanup': 'defect: f failed', // once: the then consumed it, and the wait(p) recorded it
        'wait(fn) through then': 'aborted',
      },
      log: ['a cleaned', 'b cleaned', 'c cleaned', 'd cleaned', 'e cleaned', 'g cleaned'],
      handedAborted: false,
    });
  });

  it('a then whose op was made in a step of a body that is halted when the work settles leaves the failure with its holder: Promise.all over call, release or shield in a halted wait(p) still fails the node once, as yield* all([…]) does; the maker, not the receiver, decides (D39’s two cases)', async () => {
    const rollback = () => new Error('rollback failed');
    /** Fork `body` on a fresh root, abort it once it is suspended, and read its outcome and its handler's calls. */
    const interrupted = async (name: string, body: (log: string[]) => Generator<Instruction, unknown, unknown>, abortAfterMs = 0) => {
      const root = app();
      const handled: string[] = [];
      const log: string[] = [];
      const f = root.fork(task(() => body(log), { name, onFailure: (e: unknown) => void handled.push((e as Error).message) }));
      await (abortAfterMs > 0 ? bare(abortAfterMs) : tick());
      f.abort(new Error('hang up'));
      const o = await within(root.result(f));
      await within(root.close());
      return { outcome: o.status === 'defect' ? `defect: ${(o.error as Error).message}` : o.status, handled, log };
    };
    const child = task(
      function* () {
        own(() => {
          throw rollback(); // the child's release fails: aborted plus a release failure is failure (§4.12)
        });
        yield* sleep(1000);
      },
      { name: 'child' },
    );
    const other = task(
      function* () {
        yield* sleep(1000);
      },
      { name: 'other' },
    );
    const slowRollback = function* (): Generator<Instruction, never, unknown> {
      yield* sleep(5);
      throw rollback();
    };
    const cases = {
      call: await interrupted('call', function* () {
        yield* wait(Promise.all([child(), other()]));
      }),
      release: await interrupted('release', function* () {
        const x = own({}, slowRollback);
        yield* wait(Promise.all([release(x)]));
      }),
      shield: await interrupted('shield', function* () {
        yield* wait(Promise.all([shield(slowRollback)]));
      }),
      'yield* all': await interrupted('all', function* () {
        yield* all([child, other]);
      }),
      // D39: an aborted fork awaiting its live parent's release(x): the failure is the parent's, not lost in the
      // fork's discarded wait.
      'a fork’s then of its live parent’s release(x)': await interrupted('parent', function* () {
        const parent = current();
        const x = own({}, slowRollback);
        const releaser = fork(
          task(
            function* () {
              yield* wait(Promise.all([parent.release(x)]));
            },
            { name: 'releaser' },
          ),
        );
        yield* sleep(1);
        releaser.abort(new Error('stop'));
        yield* sleep(20);
        return 'done';
      }, 100),
      // D39: a shield awaiting its interrupted body's release(x) consumes what it handles.
      'a shield’s then of its halted body’s release(x)': await interrupted('body', function* (log) {
        const body = current();
        const x = own({}, slowRollback);
        yield* shield(function* () {
          yield* sleep(10); // the body is halted meanwhile; the shield is release work
          try {
            yield* wait(Promise.all([body.release(x)]));
          } catch (e) {
            log.push(`shield handled: ${(e as Error).message}`);
          }
        });
      }),
    };
    expect(cases).toEqual({
      call: { outcome: 'defect: rollback failed', handled: ['rollback failed'], log: [] },
      release: { outcome: 'defect: rollback failed', handled: ['rollback failed'], log: [] },
      shield: { outcome: 'defect: rollback failed', handled: ['rollback failed'], log: [] },
      'yield* all': { outcome: 'defect: rollback failed', handled: ['rollback failed'], log: [] },
      'a fork’s then of its live parent’s release(x)': { outcome: 'defect: rollback failed', handled: ['rollback failed'], log: [] },
      'a shield’s then of its halted body’s release(x)': { outcome: 'aborted', handled: [], log: ['shield handled: rollback failed'] },
    });
  });

  it('decision 12 covers an observe fork made in the halted finally and joined there: not born delivered, it is delivered only by the node’s release, which waits for that finally, so the join or result returns the generator with the warning and the release then ends the fork; one that already ended gives its value, and one left unjoined ends with the release', async () => {
    const log: string[] = [];
    const obs = task(
      function* () {
        yield* interrupted();
        log.push('obs heard');
        return 'obs done';
      },
      { name: 'obs', interrupt: 'observe' },
    );
    const quick = task(
      function* () {
        return 'quick done';
      },
      { name: 'quick', interrupt: 'observe' },
    );
    const outcomes = {
      join: await halt(function* () {
        try {
          yield* never();
        } finally {
          const o = fork(obs);
          log.push(`join: ${yield* join(o)}`);
        }
      }),
      result: await halt(function* () {
        try {
          yield* never();
        } finally {
          const o = fork(obs);
          log.push(`result: ${(yield* result(o)).status}`);
        }
      }),
      'ended first': await halt(function* () {
        try {
          yield* never();
        } finally {
          const o = fork(quick);
          yield* sleep(1); // its body has ended: it completes on its own
          log.push(`ended first: ${yield* join(o)}`);
        }
      }),
      unjoined: await halt(function* () {
        try {
          yield* never();
        } finally {
          fork(obs);
        }
      }),
    };
    expect({ outcomes, log: [...log].sort(), warned: rammeWarnings().filter((w) => /waits for its own/.test(w)).length }).toEqual({
      outcomes: { join: 'aborted', result: 'aborted', 'ended first': 'aborted', unjoined: 'aborted' },
      log: ['ended first: quick done', 'obs heard', 'obs heard', 'obs heard'],
      warned: 2,
    });
  });

  it('the hazard that stays: a call, in the halted finally, of an observe task that waits for its own interruption is release work on the unwind fiber, which nothing delivers, so it holds the node, past root.abort(), until that task is aborted directly', async () => {
    const root = app();
    let callee: Context | undefined;
    const obs = task(
      function* () {
        callee = current();
        yield* interrupted();
        return 'obs done';
      },
      { name: 'obs', interrupt: 'observe' },
    );
    const f = root.fork(
      task(
        function* () {
          try {
            yield* never();
          } finally {
            yield* obs();
          }
        },
        { name: 'halted', onFailure: () => {} },
      ),
    );
    await tick();
    f.abort(new Error('hang up'));
    const done = deferred<string>();
    void root.result(f).then((o) => done.resolve(o.status));
    let state = 'pending';
    void done.promise.then((s) => (state = s));
    await bare(30);
    const stuck = state;
    root.abort(new Error('shutdown')); // stops at f, delivered already; the unwind fiber is never delivered
    await bare(30);
    const afterRootAbort = state;
    callee!.abort(new Error('direct'));
    expect({ stuck, afterRootAbort, final: await within(done.promise) }).toEqual({ stuck: 'pending', afterRootAbort: 'pending', final: 'aborted' });
  });

  it('a source whose then throws (a Promise subclass that overrides it) fails the wait at the yield*, never escaping the driver: the body catches it, an uncaught one fails the node, a halted body is returned, a halted finally records it as p’s own failure, and a failure handler’s wait fails the handler', async () => {
    const hostile = () => new Hostile<number>((resolve) => resolve(1));
    const root = app();
    const caught = await within(
      root.call(function* () {
        try {
          yield* wait(hostile());
          return 'not reached';
        } catch (e) {
          return `caught: ${(e as Error).message}`;
        }
      }),
    );
    const uncaught = await within(
      root.attempt(function* () {
        yield* wait(hostile());
      }),
    );
    const log: string[] = [];
    const halted = root.fork(
      task(
        function* () {
          try {
            current().abort(new Error('hang up')); // delivered inside its own step
            yield* wait(hostile()); // a started wait: subscribed, and its failure returns the halted body (row 3)
            log.push('unreachable');
          } catch {
            log.push('caught'); // never: a halted body's failed wait is not thrown in
          } finally {
            log.push('finally');
          }
        },
        { name: 'self-abort', onFailure: () => {} },
      ),
    );
    const haltedOutcome = (await within(root.result(halted))).status;
    const inHaltedFinally = await halt(function* () {
      try {
        yield* never();
      } finally {
        try {
          yield* wait(hostile());
        } catch {
          // caught: still p's own failure, recorded as a release failure, as its rejection would be
        }
      }
    });
    const handlerRoot = createRootContext();
    handlerRoot.fork(
      task(
        function* (): Generator<Instruction, never, unknown> {
          throw new Error('boom');
        },
        {
          onFailure: function* () {
            yield* sleep(1); // the next step runs in a source's reaction, outside the handler's call
            yield* wait(hostile());
          },
        },
      ),
    );
    await tick();
    const handlerClose = await within(handlerRoot.close()).then(
      () => 'closed',
      (e: Error) => `rejected: ${e.message}`,
    );
    expect({
      caught,
      uncaught: uncaught.status === 'defect' ? (uncaught.error as Error).message : uncaught.status,
      haltedOutcome,
      log,
      inHaltedFinally,
      handlerClose,
    }).toEqual({
      caught: 'caught: hostile then',
      uncaught: 'hostile then',
      haltedOutcome: 'aborted',
      log: ['finally'],
      inHaltedFinally: 'defect: hostile then',
      handlerClose: 'rejected: hostile then', // a handler's failure is collected with its parent's release failures (§4.7)
    });
  });

  it('a stored join or result run after its receiver completed refuses with NodeCompletedError, as a stored call does: the receiver’s completion surfaced the fiber’s failure already, and nothing is emitted on the receiver after its node:complete', async () => {
    const ev = events();
    roots.push(ev.root);
    const boom = new Error('boom');
    let outerId = -1;
    const stored: Record<string, PromiseLike<unknown>> = {};
    const outer = await within(
      ev.root.attempt(
        task(
          function* () {
            outerId = impl(current()).id;
            const f = fork(
              task(
                function* (): Generator<Instruction, never, unknown> {
                  yield* sleep(1);
                  throw boom;
                },
                { name: 'failing' },
              ),
            );
            stored.join = join(f);
            stored.result = result(f);
            stored.call = task(() => 1)();
            yield* sleep(5);
            return 1;
          },
          { name: 'outer' },
        ),
      ),
    );
    const later: Record<string, string> = {};
    for (const [name, op] of Object.entries(stored))
      later[name] = await within(
        Promise.resolve(op).then(
          (v) => `resolved: ${JSON.stringify(v)}`,
          (e: Error) => e.name,
        ),
      );
    const types = ev.typesOf(outerId);
    expect({ outer: outer.status === 'defect' ? outer.error : outer.status, later, last: types[types.length - 1] }).toEqual({
      outer: expect.objectContaining({ name: 'SuppressedError', error: boom, suppressed: expect.objectContaining({ name: 'UnjoinedFiberError' }) }), // surfaced once, from the receiver's completion (I11)
      later: { join: 'NodeCompletedError', result: 'NodeCompletedError', call: 'NodeCompletedError' },
      last: 'node:complete',
    });
  });
});
