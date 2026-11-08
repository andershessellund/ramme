// review-fixes-pin.test.ts — the pinning tests of PR #6, the review fixes (the specification's items A.1–A.4, B.1, B.2
// and C), written first, against the unmodified tree (4e8aa8c, PR #5 merged).
//
// - A.1: an error value never stands for its own absence. A release that throws `undefined` (or `null`) is a release
//   failure like any other, so `close()` rejects with it, as `[Symbol.asyncDispose]()`, `join`, `result`, `attempt`,
//   `then`, an early `release(x)`, `wait(p)` and a `promised` callback already report it.
// - A.2: `listen` refuses a handler's returned promise in every mode: a `TypeError` naming `promised` and `fork`
//   (the op case's class), thrown after the promise's rejection is handled, so the node ends `defect` with it and no
//   rejection is unhandled, in development mode and in production.
// - A.3: a registration that aborts its own node (an emitter's `newListener`, an `EventTarget` whose
//   `addEventListener` aborts) leaves nothing registered: the listener, and its `opts.signal` listener, are removed
//   at once.
// - A.4: `all` and `settle` keep a promise a generator body returns, and their types say so: no `Awaited` in
//   `AllResult` or `SettleResult` (the last describe, only type-checked, by `pnpm typecheck`; `join`, `result` and
//   `attempt` carry none already, and `then` flattens, guards).
// - B.1, D45's one grant per halt: the wait in flight at the delivery finishes and the body is resumed with its value
//   once; every op the halted body yields after that returns it there (a `wait(p)` abandons `p`, its rejection
//   handled; a `wait((signal) => p)` does not call its function), except release work, which still runs; a halted
//   `finally` is release work and may wait; `promised` bodies follow the same rule. One test per bullet of the
//   specification's pin list.
// - B.2: a halted `finally`'s throw is a release failure, recorded as a failed wait there is: `defect(e)`, the outcome
//   a halted `finally` whose `yield* cleanup()` fails gives; a value it returns stays discarded (`aborted`).
// - C: `PoolOptions.maxPending` bounds `pending` under `whenFull: 'wait'`: a fork beyond it is refused with
//   `PoolFullError` naming `maxPending` and makes no node; `maxPending: 0` is `'reject'`; it is validated as a
//   non-negative integer, and allowed beside `'reject'`.
//
// On the unmodified tree (4e8aa8c) `pnpm test` fails eight of these fourteen tests:
//
// - A.1: only `close()` with `undefined`, of a root and of a child context, `resolved(undefined)` while the outcome
//   is `defect(undefined)`; `null`, and every other verb with `undefined`, already reports it.
// - A.2: in development mode the close rejects with `AsyncRunError` (`node.run`'s check), not the `TypeError`; in
//   production it resolves, the outcome is `success`, and both rejections are unhandled (also reported by the
//   setup's guard).
// - A.3: the emitter and the `EventTarget` that ignores `{ signal }` keep the listener (`listeners: 1`), and all
//   three keep the `opts.signal` listener (`onTheEarlySignal: 1`).
// - B.1: the chain and the `promised` body start `commit` and run to their end (`wrote row`, `committed`); the
//   abandoned `wait(p)` is waited for (`completion: 'pending'`, `state: 'running'` while `p` is pending).
// - B.2: the halted `finally`'s throw is `aborted(reason)`, so `same` is false.
// - C: the fork beyond `maxPending` is accepted (`pending` 3, a fourth fiber), `maxPending: 0` queues, and every
//   invalid value is accepted.
//
// Six pass there, guards of what D45 keeps: A.4's run time (the value is already the promise), B.1's
// `own(yield* wait(connect()))`, second `wait((signal) => fn)`, `release(x)` after the grant and halted `finally`,
// and the type-only test, which vitest does not check. `pnpm typecheck` reports this file's type pins: TS2344 for the
// five `Expect<Equal<…>>` of `all`, `settle`, `AllResult` and `SettleResult` (their `Awaited`), TS2353 for the four
// pool options that name `maxPending`. `_P`, `_Join`, `_Result`, `_Attempt` and `_Then` hold on both trees: guards.
//
// Added after the PR's review, against its tree as it then was (D45 implemented), each mutation-checked:
//
// - B.1: a `finally` the grant segment enters by its own `return` or throw is the body's flow, cut at its first wait
//   (D45's third case, now documented; passes there); a `shield` yielded after the delivery is halted unrun, since
//   release work after the delivery is the lifecycle ops (the documents narrowed; passes there).
// - B.2: a throw of what a wait handed the `finally` is recorded unless something else reports it. Fails there:
//   `inline`, `takenEarlier` and `expectedTaken` are `aborted(reason)`, `failPath` is `failure(theFail)`, since the
//   driver took every handed failure as reported (ramme's `FiberAbortedError`, a consumed record's error) and every
//   re-yielded `Fail` as held. Its companion, a held callee's defect rethrown from a fail's `finally` reported once,
//   passes there and guards the other direction.
// - A.4: `settle([p])` and a task member of `SettleResult` (passes there: a guard of the task branch), and
//   `promised(p)` typed `() => Promise<number>`, the real promise's flattening (TS2344 there: `Promise<Promise<number>>`).
//
// Each test first compares one observation object, so that a failure shows the whole of the behaviour in its diff.
// Outcomes are read as strings (`show`), errors named by identity among the test's own (`label`).
import { EventEmitter, getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, attempt, current, fail, fork, join, never, own, promised, release, result, settle, shield, sleep, wait } from './ambient.js';
import type { AllResult, Context, Fail, Instruction, Op, Outcome, SettleResult, Task } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { listen } from './platform.js';
import { PoolFullError } from './resource.js';
import { deferred, events, tick, trace, within } from './test/util.js';
import type { EventLog } from './test/util.js';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

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

/** A root that records its tree's events (test/util.ts `events`), closed after the test. */
function recorded(): EventLog {
  const ev = events();
  roots.push(ev.root);
  return ev;
}

/** A handler for forks onto the bodiless root (D14). */
const quiet = { onFailure: () => {} } as const;

/** A platform timer: a foreign promise, which no delivery touches. */
function bare(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The test's own values, by name: `label` names what it finds among them by identity. */
type Known = Readonly<Record<string, unknown>>;

/** `x` as an observation reads it: a known value by its name; another error by class and message. */
function label(x: unknown, known: Known = {}): string {
  for (const [name, v] of Object.entries(known)) if (v === x) return name;
  if (x instanceof Error) return `${x.name}: ${x.message}`;
  return typeof x === 'string' ? JSON.stringify(x) : String(x);
}

/** An outcome as one string: `success(…)`, `failure(…)`, `defect(…)` or `aborted(…)`; anything else says what it is. */
function show(o: unknown, known: Known = {}): string {
  const x = o as { status?: unknown; value?: unknown; error?: unknown; reason?: unknown } | undefined;
  switch (x?.status) {
    case 'success':
      return `success(${label(x.value, known)})`;
    case 'failure':
      return `failure(${label(x.error, known)})`;
    case 'defect':
      return `defect(${label(x.error, known)})`;
    case 'aborted':
      return `aborted(${label(x.reason, known)})`;
    default:
      return `not an outcome: ${label(o, known)}`;
  }
}

/** How `p` settled, read from top level: `resolved(…)` or `rejected(…)`; a deadlock rejects after a second. */
async function settledWith(p: PromiseLike<unknown>, known: Known = {}): Promise<string> {
  try {
    return `resolved(${label(await within(p), known)})`;
  } catch (e) {
    return `rejected(${label(e, known)})`;
  }
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

describe('A.1: a thrown undefined or null is the error it is, never “no error”', () => {
  it('a release that throws undefined, and one that throws null: close() rejects with it, as [Symbol.asyncDispose](), join, result, attempt, then, release(x), wait(p) and promised report it', async () => {
    const seen: Record<string, unknown> = {};
    for (const [name, thrown] of [
      ['undefined', undefined],
      ['null', null],
    ] as const) {
      const throwing = (): never => {
        throw thrown;
      };
      const leaky = task(
        function* leaky() {
          own({}, throwing);
          yield* sleep(0);
          return 'value';
        },
        { name: 'leaky' },
      );
      // close() of a root, and of a child context: deliverClose's "no release error" test
      const root = app();
      root.own({}, throwing);
      const rootClose = await settledWith(root.close());
      const parent = app();
      const box = parent.child({ name: 'box' });
      box.own({}, throwing);
      const childClose = await settledWith(box.close());
      // [Symbol.asyncDispose]() of a root
      const disposed = app();
      disposed.own({}, throwing);
      const dispose = await settledWith(disposed[Symbol.asyncDispose]());
      // a fiber whose release throws, through join, result and attempt in a body; an early release(x); wait(p)
      const inBody = await within(
        app().call(function* () {
          let joined: string;
          try {
            joined = `returned ${label(yield* join(fork(leaky)))}`;
          } catch (e) {
            joined = `threw ${label(e)}`;
          }
          const resulted = show(yield* result(fork(leaky)));
          const attempted = show(yield* attempt(leaky()));
          let released: string;
          try {
            const x = own({}, throwing);
            yield* release(x);
            released = 'returned';
          } catch (e) {
            released = `threw ${label(e)}`;
          }
          let waited: string;
          try {
            yield* wait(Promise.reject(thrown));
            waited = 'returned';
          } catch (e) {
            waited = `threw ${label(e)}`;
          }
          return { joined, resulted, attempted, released, waited };
        }),
      );
      // then, from plain async code; a promised callback's promise
      const then = await settledWith(app().call(leaky));
      const viaPromised = await settledWith(
        app().promised(function* () {
          yield* sleep(0);
          throw thrown;
        })(),
      );
      seen[name] = {
        rootClose,
        rootOutcome: show(root.outcome),
        childClose,
        childOutcome: show(box.outcome),
        dispose,
        ...inBody,
        then,
        viaPromised,
      };
    }
    const expected = (x: string) => ({
      rootClose: `rejected(${x})`,
      rootOutcome: `defect(${x})`,
      childClose: `rejected(${x})`,
      childOutcome: `defect(${x})`,
      dispose: `rejected(${x})`,
      joined: `threw ${x}`,
      resulted: `defect(${x})`,
      attempted: `defect(${x})`,
      released: `threw ${x}`,
      waited: `threw ${x}`,
      then: `rejected(${x})`,
      viaPromised: `rejected(${x})`,
    });
    expect(seen).toEqual({ undefined: expected('undefined'), null: expected('null') });
  });
});

describe('A.2: listen and a handler that returns a promise', () => {
  it('in development mode and in production, on an EventTarget and on an emitter: a TypeError naming promised and fork at the event, the node ends defect with it, and the rejection is handled', async () => {
    const seen: Record<string, unknown> = {};
    const unhandled = await unhandledDuring(async () => {
      for (const mode of ['development', 'production']) {
        vi.stubEnv('NODE_ENV', mode);
        for (const on of ['EventTarget', 'emitter']) {
          const rejection = new Error(`rejected in ${mode} on the ${on}`);
          const box = app().child({ name: 'box' });
          let calls = 0;
          const handler = (): Promise<never> => {
            calls++;
            return Promise.reject(rejection);
          };
          if (on === 'EventTarget') {
            const target = new EventTarget();
            box.run(() => listen(target, 'ping', handler));
            target.dispatchEvent(new Event('ping'));
          } else {
            const em = new EventEmitter();
            box.run(() => listen(em, 'ping', handler));
            em.emit('ping');
          }
          let closed: string;
          try {
            await within(box.close());
            closed = 'resolved';
          } catch (e) {
            closed = thrownBy(() => {
              throw e;
            }, ['promised', 'fork']);
          }
          seen[`${mode}, ${on}`] = { calls, closed, outcome: box.outcome?.status };
        }
        vi.unstubAllEnvs();
      }
    });
    const refused = { calls: 1, closed: 'TypeError naming promised and fork', outcome: 'defect' };
    expect({ seen, unhandled }).toEqual({
      seen: {
        'development, EventTarget': refused,
        'development, emitter': refused,
        'production, EventTarget': refused,
        'production, emitter': refused,
      },
      unhandled: [],
    });
  });
});

describe('A.3: a registration that aborts its own node leaves nothing registered', () => {
  it('an emitter whose newListener aborts the node, and EventTargets whose addEventListener aborts it (one that ignores { signal }, as ws does, and one that honours it): the listener and its opts.signal listener are removed at once', async () => {
    const seen: Record<string, unknown> = {};
    // An emitter: `newListener` is emitted inside on(), before the listener is added.
    {
      const box = app().child({ name: 'box' });
      const em = new EventEmitter();
      em.on('newListener', (type: string | symbol) => {
        if (type === 'ping') box.abort(new Error('aborted while registering'));
      });
      const early = new AbortController();
      let calls = 0;
      box.run(() => listen(em, 'ping', () => void calls++, { signal: early.signal }));
      const closed = await settledWith(box.close());
      em.emit('ping');
      seen.emitter = {
        closed,
        outcome: box.outcome?.status,
        listeners: em.listenerCount('ping'),
        onTheEarlySignal: getEventListeners(early.signal, 'abort').length,
        calls,
      };
    }
    // EventTargets whose addEventListener aborts the registering node, then registers: one reads `once` only (a ws
    // `WebSocket`), so the listener is registered on an aborted node; one honours `{ signal }`, already aborted.
    for (const honoursSignal of [false, true]) {
      const box = app().child({ name: 'box' });
      class Aborting extends EventTarget {
        override addEventListener(
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          opts?: boolean | AddEventListenerOptions,
        ): void {
          box.abort(new Error('aborted while registering'));
          const once = typeof opts === 'object' ? opts.once : undefined;
          super.addEventListener(type, listener, honoursSignal ? opts : { once });
        }
      }
      const target = new Aborting();
      const early = new AbortController();
      let calls = 0;
      box.run(() => listen(target, 'ping', () => void calls++, { signal: early.signal }));
      const closed = await settledWith(box.close());
      target.dispatchEvent(new Event('ping'));
      seen[honoursSignal ? 'EventTarget honouring { signal }' : 'EventTarget ignoring { signal }'] = {
        closed,
        outcome: box.outcome?.status,
        listeners: getEventListeners(target, 'ping').length,
        onTheEarlySignal: getEventListeners(early.signal, 'abort').length,
        calls,
      };
    }
    const clean = { closed: 'resolved(undefined)', outcome: 'aborted', listeners: 0, onTheEarlySignal: 0, calls: 0 };
    expect(seen).toEqual({
      emitter: clean,
      'EventTarget ignoring { signal }': clean,
      'EventTarget honouring { signal }': clean,
    });
  });
});

describe('A.4: all and settle keep a promise a generator body returns', () => {
  it('the member value of all([p()]), all([p]), settle([p()]) and settle([p]) is the promise p’s body returned, unflattened; promised’s real promise flattens it', async () => {
    const made: Promise<number>[] = [];
    const p = task(function* p() {
      yield* sleep(0);
      const promise = Promise.resolve(1); // a value: `return promise`, never `return yield* wait(promise)`
      made.push(promise);
      return promise;
    });
    const seen = await within(
      app().call(function* () {
        const [viaOp] = yield* all([p()]);
        const [viaTask] = yield* all([p]);
        const [outcome] = yield* settle([p()]);
        const [taskOutcome] = yield* settle([p]);
        const viaPromised: unknown = yield* wait(promised(p)()); // a real promise: resolved with p's promise, it adopts it
        return {
          viaOp: viaOp as unknown,
          viaTask: viaTask as unknown,
          viaSettle: outcome.status === 'success' ? (outcome.value as unknown) : outcome,
          viaSettleTask: taskOutcome.status === 'success' ? (taskOutcome.value as unknown) : taskOutcome,
          viaPromised,
        };
      }),
    );
    expect({
      viaOp: seen.viaOp === made[0],
      viaTask: seen.viaTask === made[1],
      viaSettle: seen.viaSettle === made[2],
      viaSettleTask: seen.viaSettleTask === made[3],
      viaPromised: seen.viaPromised,
      resolved: await Promise.all(made),
    }).toEqual({ viaOp: true, viaTask: true, viaSettle: true, viaSettleTask: true, viaPromised: 1, resolved: [1, 1, 1, 1, 1] });
  });
});

describe('B.1: one grant per halt (D45)', () => {
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

describe('B.2: a halted finally’s throw is a release failure (D45)', () => {
  it('a halted finally that throws e is defect(e), the outcome a halted finally whose yield* cleanup() fails with e gives; one that returns a value stays aborted', async () => {
    const reason = new Error('hang up');
    const cleanupFailed = new Error('cleanup failed');
    const cleanup = task(function* cleanup(): Generator<Instruction, never, unknown> {
      yield* sleep(0);
      throw cleanupFailed;
    });
    const root = app();
    const halted = async (body: () => Generator<Instruction, unknown, unknown>): Promise<string> => {
      const f = root.fork(task(body, { name: 'halted', ...quiet }));
      await tick();
      f.abort(reason);
      return show(await within(root.result(f)), { reason, cleanupFailed });
    };
    const threw = await halted(function* () {
      try {
        yield* never();
      } finally {
        throw cleanupFailed;
      }
    });
    const cleanupThrew = await halted(function* () {
      try {
        yield* never();
      } finally {
        yield* cleanup();
      }
    });
    const returned = await halted(function* () {
      try {
        yield* never();
      } finally {
        return 'from the finally'; // a lost halt (dev mode reports it); the value is discarded
      }
    });
    expect({ threw, cleanupThrew, same: threw === cleanupThrew, returned }).toEqual({
      threw: 'defect(cleanupFailed)',
      cleanupThrew: 'defect(cleanupFailed)',
      same: true,
      returned: 'aborted(reason)',
    });
  });

  it('a throw of what a wait handed the finally is recorded unless something else reports it: ramme’s FiberAbortedError for an aborted fiber, and a failure an earlier consumer took, are recorded, inline as in a task, halted as in the plain flow, and in the finally a fail runs', async () => {
    const reason = new Error('hang up');
    const theFail = new Error('the fail');
    const failedEarlier = new Error('failed earlier');
    const expectedEarlier = new Error('expected earlier');
    const root = app();
    // An aborted fiber of another node: a join of it throws ramme's FiberAbortedError, which no failure record holds.
    const victim = root.fork(
      task(function* victim() {
        yield* never();
      }, quiet),
    );
    victim.abort(reason);
    await within(root.result(victim));
    const cleanup = task(function* cleanup(w: typeof victim) {
      yield* join(w);
    });
    const known: Known = { reason, theFail, failedEarlier, expectedEarlier };
    /** An error named by identity among the test's own, else by class; a SuppressedError by its two parts. */
    const name = (e: unknown): string => {
      if (typeof e === 'object' && e !== null && 'suppressed' in e && 'error' in e)
        return `SuppressedError(${name(e.error)}, ${name(e.suppressed)})`;
      return Object.entries(known).find(([, v]) => v === e)?.[0] ?? (e instanceof Error ? e.constructor.name : String(e));
    };
    const run = async (body: () => Generator<Instruction | Fail<Error>, unknown, unknown>, halt: boolean): Promise<string> => {
      const f = root.fork(task(body, { name: 'body', ...quiet }));
      if (halt) {
        await bare(5); // past the body's first waits: the halt finds it in never()
        f.abort(reason);
      }
      const o = await within(root.result(f));
      return o.status === 'success' ? 'success' : `${o.status}(${name(o.status === 'aborted' ? o.reason : o.error)})`;
    };
    const inline = await run(function* () {
      try {
        yield* never();
      } finally {
        yield* join(victim);
      }
    }, true);
    const inTask = await run(function* () {
      try {
        yield* never();
      } finally {
        yield* cleanup(victim);
      }
    }, true);
    const plain = await run(function* () {
      yield* join(victim);
    }, false);
    const failPath = await run(function* () {
      try {
        yield* fail(theFail);
      } finally {
        yield* join(victim);
      }
    }, false);
    // A failure an earlier consumer took: its record is consumed, so only the finally's throw can report it again.
    const takenEarlier = await run(function* () {
      const w = fork(function* () {
        throw failedEarlier;
      });
      try {
        yield* join(w);
      } catch {
        // handled: the record is consumed
      }
      try {
        yield* never();
      } finally {
        yield* join(w);
      }
    }, true);
    const takenEarlierPlain = await run(function* () {
      const w = fork(function* () {
        throw failedEarlier;
      });
      try {
        yield* join(w);
      } catch {
        // handled
      }
      yield* join(w);
    }, false);
    // The same for an expected failure: result(w) took it, and the finally's join re-yields it.
    const expectedTaken = await run(function* () {
      const w = fork(function* () {
        return yield* fail(expectedEarlier);
      });
      yield* result(w);
      try {
        yield* never();
      } finally {
        yield* join(w);
      }
    }, true);
    expect({ inline, inTask, plain, failPath, takenEarlier, takenEarlierPlain, expectedTaken }).toEqual({
      inline: 'defect(FiberAbortedError)',
      inTask: 'defect(FiberAbortedError)',
      plain: 'defect(FiberAbortedError)',
      failPath: 'defect(SuppressedError(FiberAbortedError, theFail))',
      takenEarlier: 'defect(failedEarlier)',
      takenEarlierPlain: 'defect(failedEarlier)',
      expectedTaken: 'defect(expectedEarlier)',
    });
  });

  it('a throw of a failure its record still holds is reported once, by that record: a callee’s defect rethrown from the finally a fail runs is not an AggregateError of itself twice', async () => {
    const theFail = new Error('the fail');
    const cleanupFailed = new Error('cleanup failed');
    const cleanup = task(function* cleanup(): Generator<Instruction, never, unknown> {
      yield* sleep(0);
      throw cleanupFailed;
    });
    const root = app();
    const f = root.fork(
      task(function* () {
        try {
          yield* fail(theFail);
        } finally {
          yield* cleanup(); // its defect: held by its record on the unwind fiber, and rethrown here
        }
      }, quiet),
    );
    const o = await within(root.result(f));
    const e = (o.status === 'defect' ? o.error : undefined) as { error?: unknown; suppressed?: unknown } | undefined;
    expect({ status: o.status, primary: show({ status: 'defect', error: e?.error }, { cleanupFailed }), suppressed: e?.suppressed === theFail }).toEqual({
      status: 'defect',
      primary: 'defect(cleanupFailed)',
      suppressed: true,
    });
  });
});

describe('C: pools: maxPending', () => {
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

describe('A.4: the types', () => {
  it('all([p()]) with p: Task<[], Promise<number>> is Op<[Promise<number>]>, settle([p()]) and settle([p]) Op<[Outcome<Promise<number>, never>]>; AllResult and SettleResult apply no Awaited, to an op member or a task member; join, result and attempt carry none; then and promised’s real promise flatten', () => {
    // Never run: the bodies below are only type-checked (`pnpm typecheck`; vitest's expectTypeOf is a no-op).
    function types(): void {
      const p = task(function* p() {
        yield* sleep(0);
        return Promise.resolve(1);
      });
      const viaOp = all([p()]);
      const viaTask = all([p]);
      const viaSettle = settle([p()]);
      const viaSettleTask = settle([p]);
      const viaPromised = promised(p);
      type _SettleTask = Expect<Equal<typeof viaSettleTask, Op<[Outcome<Promise<number>, never>], never>>>;
      // promised's function returns a real promise, which adopts the one the body returned.
      type _Promised = Expect<Equal<typeof viaPromised, () => Promise<number>>>;
      function* verbs() {
        const f = fork(p);
        const joined = yield* join(f);
        const resulted = yield* result(f);
        const attempted = yield* attempt(p());
        type _Join = Expect<Equal<typeof joined, Promise<number>>>;
        type _Result = Expect<Equal<typeof resulted, Outcome<Promise<number>, never>>>;
        type _Attempt = Expect<Equal<typeof attempted, Outcome<Promise<number>, never>>>;
        return [joined, resulted, attempted];
      }
      type _P = Expect<Equal<typeof p, Task<[], Promise<number>, never>>>;
      type _All = Expect<Equal<typeof viaOp, Op<[Promise<number>], never>>>;
      type _AllTask = Expect<Equal<typeof viaTask, Op<[Promise<number>], never>>>;
      type _Settle = Expect<Equal<typeof viaSettle, Op<[Outcome<Promise<number>, never>], never>>>;
      type _AllResult = Expect<Equal<AllResult<readonly [Op<Promise<number>>, Task<[], Promise<string>>]>, [Promise<number>, Promise<string>]>>;
      type _SettleResult = Expect<
        Equal<
          SettleResult<readonly [Op<Promise<number>>, Task<[], Promise<string>>]>,
          [Outcome<Promise<number>, never>, Outcome<Promise<string>, never>]
        >
      >;
      // The two legitimate Awaited: a promise consumer of an op, and promised's real promise (above), since a promise
      // resolving with a promise flattens.
      type _Then = Expect<Equal<Awaited<Op<Promise<number>>>, number>>;
      expect([typeof verbs, viaOp, viaTask, viaSettle, viaSettleTask, viaPromised].length).toBe(6);
    }
    expect(typeof types).toBe('function');
  });
});
