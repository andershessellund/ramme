// Tests for runtime / lazy operations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, attempt, createRootContext, fork, join, race, result, settle, shield, sleep, task, unshield, wait } from '../../src/index.js';
import type { Context, Instruction } from '../../src/index.js';
import { events, tick, within } from '../support/util.js';
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

describe('work ops are lazy (decisions 2, 3)', () => {
  it('a work op made and dropped runs nothing: no child, no group, no member, no join, no timer, no call of the work function (call, attempt, all, race, settle, shield, unshield, join, result, sleep, wait)', async () => {
    const ran: string[] = [];
    const ev = recorded();
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    /** What making the op did in the step that made it: the events emitted and the timers armed meanwhile. */
    const seen: Record<string, { events: string[]; timers: number }> = {};
    function drop(name: string, make: () => unknown): void {
      const e0 = ev.log.length;
      const t0 = timeouts.mock.calls.length;
      make(); // made, never yielded nor awaited
      seen[name] = { events: ev.log.slice(e0).map((e) => e.type), timers: timeouts.mock.calls.length - t0 };
    }
    const target = task(function* () {}, { name: 'target' }); // a fiber to join; it records nothing
    const thenable = {
      then() {
        ran.push('thenable.then'); // what Promise.resolve(thenable) calls, a job after it is made
      },
    } as unknown as Promise<number>;
    const cases: Record<string, () => Generator<Instruction, void, unknown>> = {
      call: function* () {
        drop('call', () => work(ran, 'call')());
      },
      attempt: function* () {
        drop('attempt', () => attempt(work(ran, 'attempt')));
      },
      all: function* () {
        drop('all', () => all([work(ran, 'all member')]));
      },
      race: function* () {
        drop('race', () => race([work(ran, 'race member')]));
      },
      settle: function* () {
        drop('settle', () => settle([work(ran, 'settle member')]));
      },
      shield: function* () {
        drop('shield', () => shield(work(ran, 'shield')));
      },
      unshield: function* () {
        yield* shield(function* () {
          drop('unshield', () => unshield(work(ran, 'unshield'))); // inside a shield: its guard passes
        });
      },
      join: function* () {
        const f = fork(target);
        drop('join', () => join(f));
        f.abort();
      },
      result: function* () {
        const f = fork(target);
        drop('result', () => result(f));
        f.abort();
      },
      sleep: function* () {
        drop('sleep', () => sleep(50));
      },
      'wait(fn)': function* () {
        drop('wait(fn)', () =>
          wait(() => {
            ran.push('wait fn');
            return new Promise<number>(() => {});
          }),
        );
      },
      'wait(thenable)': function* () {
        drop('wait(thenable)', () => wait(thenable));
      },
    };
    const fibers = Object.entries(cases).map(([name, body]) => ev.root.fork(task(body, { name: `drops ${name}`, ...quiet })));
    const outcomes = await within(Promise.all(fibers.map((f) => ev.root.result(f))));
    await tick(3); // a member, a fork or a thenable's then would run by now
    const nothing = { events: [], timers: 0 };
    expect({ seen, ran: [...ran].sort(), outcomes: outcomes.map((o) => o.status) }).toEqual({
      seen: Object.fromEntries(Object.keys(cases).map((name) => [name, nothing])),
      ran: [],
      outcomes: Object.keys(cases).map(() => 'success'),
    });
  });

  it('decision 3: yield* of one op object runs it afresh each time, as a description; then runs it once per object, as a promise must, and nothing runs before then is called', async () => {
    let runs = 0;
    const count = task(
      function* () {
        return ++runs;
      },
      { name: 'count' },
    );
    let calls = 0;
    const root = app();
    const yielded = await within(
      root.call(function* () {
        const op = count();
        const first = yield* op;
        const second = yield* op;
        const w = wait(() => Promise.resolve(++calls));
        const third = yield* w;
        const fourth = yield* w;
        return { call: [first, second], runs, wait: [third, fourth], calls };
      }),
    );
    runs = 0;
    const op = root.call(count); // an explicit receiver: thenable
    const beforeThen = runs;
    const a = await op;
    const b = await op;
    expect({ yielded, then: { beforeThen, values: [a, b], runs } }).toEqual({
      yielded: { call: [1, 2], runs: 2, wait: [1, 2], calls: 2 },
      then: { beforeThen: 0, values: [1, 1], runs: 1 },
    });
  });
});
