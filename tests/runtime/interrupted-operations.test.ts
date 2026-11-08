// Tests for runtime / interrupted operations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRootContext, current, fork, never, signal, sleep, task, wait } from '../../src/index.js';
import type { Context, Fiber, Outcome } from '../../src/index.js';
import { events, tick, trace, within } from '../support/util.js';
import type { EventLog, Trace } from '../support/util.js';

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

/** `f`'s outcome, read from top level; pushes `complete` to `t` when it arrives. */
function completion<T>(root: Context, f: Fiber<T>, t: Trace): PromiseLike<Outcome<T>> {
  return root.result(f).then((o) => {
    t.push('complete');
    return o;
  });
}

/** The `node:created` events of nodes running the task named `name`. */
function created(ev: EventLog, name: string): number {
  return ev.of('node:created').filter((e) => e.task === name).length;
}

/** A task that records its run in `ran` and returns its name. */
function work(ran: string[], name: string) {
  return task(
    function* () {
      ran.push(name);
      return name;
    },
    { name },
  );
}

describe('the halt with lazy ops (decisions 8, 9; DESIGN.md §4.2)', () => {
  it('row 1: a sleep arms its timer at its yield*, not when made, and the halt returns the body at once and clears it; wait(fn, { abandon: true }) calls fn at its yield*', async () => {
    const sleeperLog = trace();
    const abandonsLog = trace();
    const reason = new Error('hang up');
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const clears = vi.spyOn(globalThis, 'clearTimeout');
    /** The timers armed for 10 s, by the id setTimeout returned. */
    const armed = (): unknown[] =>
      timeouts.mock.calls.flatMap((c, i) => (c[1] === 10_000 ? [timeouts.mock.results[i]?.value as unknown] : []));
    const timers: Record<string, number> = {};
    const root = app();
    const sleeper = root.fork(
      task(
        function* () {
          const pause = sleep(10_000);
          timers.made = armed().length;
          try {
            yield* pause; // armed here; returned here at once
            sleeperLog.push('unreachable');
          } finally {
            timers.atHalt = armed().length;
            sleeperLog.push('finally');
          }
        },
        { name: 'sleeper', ...quiet },
      ),
    );
    const abandons = root.fork(
      task(
        function* () {
          const w = wait(
            (s) => {
              abandonsLog.push('fn called');
              return new Promise<string>((_, reject) => s.addEventListener('abort', () => reject(s.reason), { once: true }));
            },
            { abandon: true },
          );
          abandonsLog.push('made');
          try {
            yield* w; // fn is called here; returned here at once
            abandonsLog.push('unreachable');
          } finally {
            abandonsLog.push('finally');
          }
        },
        { name: 'abandons', ...quiet },
      ),
    );
    await tick();
    for (const log of [sleeperLog, abandonsLog]) log.push('aborting');
    sleeper.abort(reason);
    abandons.abort(reason);
    const outcomes = await within(Promise.all([root.result(sleeper), root.result(abandons)]), 500); // not after 10 s
    const ids = armed();
    expect({
      sleeper: sleeperLog.log,
      abandons: abandonsLog.log,
      timers,
      cleared: ids.length > 0 && ids.every((id) => clears.mock.calls.some(([c]) => c === id)),
      outcomes,
    }).toEqual({
      sleeper: ['aborting', 'finally'],
      abandons: ['made', 'fn called', 'aborting', 'finally'],
      timers: { made: 0, atHalt: 1 },
      cleared: true,
      outcomes: [
        { status: 'aborted', reason },
        { status: 'aborted', reason },
      ],
    });
  });

  it('row 2: a call starts at its yield*, synchronously, not when made; halted, the body is returned once the callee has completed: no catch runs, its finally after the callee’s', async () => {
    const t = trace();
    const reason = new Error('hang up');
    let slowNode: Context | undefined;
    const slow = task(
      function* () {
        slowNode = current();
        t.push('slow running');
        try {
          yield* never();
        } finally {
          t.push('slow finally');
        }
      },
      { name: 'slow' },
    );
    const root = app();
    const f = root.fork(
      task(
        function* () {
          const c = slow();
          t.push('made');
          try {
            yield* c; // slow starts here
            t.push('unreachable');
          } catch {
            t.push('caught');
          } finally {
            t.push(`finally; slow ${String(slowNode?.state)}`);
          }
        },
        { name: 'caller', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({ log: t.log, outcome: o }).toEqual({
      log: ['made', 'slow running', 'slow finally', 'finally; slow complete', 'complete'],
      outcome: { status: 'aborted', reason },
    });
  });

  it('row 3: a halted wait(p) lets p finish, the body runs on to its next yield*, and is returned there without running that op', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const ran: string[] = [];
    const ev = recorded();
    const f = ev.root.fork(
      task(
        function* () {
          t.push('waiting');
          const v = yield* wait(bare(20).then(() => 'driver value'));
          t.push(`bare work with ${v}`); // runs: the halt let p finish (decision 10)
          yield* work(ran, 'late call')(); // returned here: not run
          t.push('unreachable');
        },
        { name: 'bare-after-halt', ...quiet },
      ),
    );
    await tick();
    const done = completion(ev.root, f, t);
    f.abort(reason);
    await tick(2);
    const meanwhile = [...t.log]; // not returned at the halt: still waiting for p
    const o = await within(done);
    expect({ meanwhile, log: t.log, outcome: o, ran, created: created(ev, 'late call') }).toEqual({
      meanwhile: ['waiting'],
      log: ['waiting', 'bare work with driver value', 'complete'],
      outcome: { status: 'aborted', reason },
      ran: [],
      created: 0,
    });
  });

  it('row 4: a body that delivers its own node inside its step is returned at its next yield*, without running that op', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const ran: string[] = [];
    const ev = recorded();
    const f = ev.root.fork(
      task(
        function* () {
          try {
            current().abort(reason); // delivered inside its own step
            t.push('after the abort');
            yield* work(ran, 'after own abort')(); // returned here: not run
            t.push('unreachable');
          } finally {
            t.push('finally');
          }
        },
        { name: 'self-abort', ...quiet },
      ),
    );
    const o = await within(completion(ev.root, f, t));
    expect({ log: t.log, outcome: o, ran, created: created(ev, 'after own abort') }).toEqual({
      log: ['after the abort', 'finally', 'complete'],
      outcome: { status: 'aborted', reason },
      ran: [],
      created: 0,
    });
  });

  it('decision 9: a body born delivered is stepped to its first yield* of an op not yet started and returned there without running it; a wait(p) on the way finishes first (row 5)', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const ran: string[] = [];
    const ev = recorded();
    let bornNode: Context | undefined;
    let bornDelivered: boolean | undefined;
    const born = task(
      function* () {
        bornNode = current();
        bornDelivered = signal().aborted;
        t.push('born: first step');
        const v = yield* wait(bare(5).then(() => 'v')); // a wait(p) on the way: subscribed, and it finishes
        t.push(`born: resumed with ${v}`);
        try {
          yield* work(ran, 'born’s call')(); // returned here: not run
          t.push('born: unreachable');
        } finally {
          t.push('born: finally');
        }
      },
      { name: 'born' },
    );
    const f = ev.root.fork(
      task(
        function* () {
          yield* wait(bare(20)); // halted meanwhile: p finishes and the body is resumed, its node delivered
          t.push('parent resumed');
          fork(born); // a freeze child of a delivered node: born delivered (D12); fork is eager
          yield* sleep(1); // returned here
          t.push('unreachable');
        },
        { name: 'parent', ...quiet },
      ),
    );
    await tick();
    const done = completion(ev.root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({
      log: t.log,
      outcome: o,
      bornDelivered,
      born: bornNode?.outcome,
      ran,
      created: created(ev, 'born’s call'),
    }).toEqual({
      log: ['parent resumed', 'born: first step', 'born: resumed with v', 'born: finally', 'complete'],
      outcome: { status: 'aborted', reason },
      bornDelivered: true,
      born: { status: 'aborted', reason },
      ran: [],
      created: 0,
    });
  });
});
