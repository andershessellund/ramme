// Tests for tasks / operation members.
import { afterEach, describe, expect, it } from 'vitest';
import { all, attempt, current, fail, fork, join, never, pool, race, settle, sleep, wait } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { task } from '../../src/fiber.js';
import { events, trace, within } from '../support/util.js';
import type { EventLog } from '../support/util.js';
import { labelError as label, showError as show } from '../support/observations.js';

// Each error class has a distinct literal member: TypeScript compares classes by structure, so two bare
// `class X extends Error {}` are one type and an inferred union would collapse to one of them (tests/result/results.test.ts).
class Boom extends Error {
  readonly name = 'Boom' as const;
}

class NotFound extends Error {
  readonly name = 'NotFound' as const;
}

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

afterEach(async () => {
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

/** A root that records its tree's events (test/util.ts `events`), closed after the test. */
function recorded(): EventLog {
  const ev = events();
  roots.push(ev.root);
  return ev;
}

/** A node in `subtree`'s picture: `'<kind> <name>'`, with its children when it has any. */
type Shape = string | { readonly [node: string]: Shape[] };

/**
 * The nodes created under node `id`, in creation order, each as `'<kind> <name>'`, its own children nested. Release
 * fibers are left out (a halted or failed body's `unwind:` fiber, an entry's `release:` fiber): they are release
 * work, made by the halt and by the owner's completion whatever made the node, not the tree of calls the picture is of.
 */
function subtree(ev: EventLog, id: number): Shape[] {
  return ev
    .of('node:created')
    .filter((e) => e.parentId === id && e.kind !== 'release')
    .map((e) => {
      const below = subtree(ev, e.id);
      const node = `${e.kind} ${e.name ?? '(unnamed)'}`;
      return below.length === 0 ? node : { [node]: below };
    });
}

/** The `node:settled` outcomes of the nodes named `name`, in settling order. */
function settledAs(ev: EventLog, name: string): string[] {
  const ids = new Set(ev.of('node:created').filter((e) => e.name === name).map((e) => e.id));
  return ev.of('node:settled').filter((e) => ids.has(e.id)).map((e) => e.outcome);
}

describe('all, race, settle, fork, attempt and pool.fork take ops (decision 4)', () => {
  const double = task(function* double(n: number) {
    yield* sleep(0);
    return n * 2;
  });
  const shout = task(function* shout(s: string) {
    yield* sleep(0);
    return s.toUpperCase();
  });
  const zero = task(function* zero() {
    return 0;
  });
  const missing = task(function* missing(id: string) {
    yield* sleep(0);
    return yield* fail(new NotFound(id));
  });
  const boom = new Boom('boom');
  const broken = task(function* broken() {
    yield* sleep(0);
    throw boom;
  });

  it('all([t(1), u(‘x’)]) forks the two tasks directly under the group: two fibers named after the tasks, no node for the ops; a task of no arguments is taken as itself, and any other op runs in a fiber named after it', async () => {
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const pair = yield* all([double(1), shout('x')]);
        const mixed = yield* all([zero, double(2), sleep(1)]);
        return { pair, mixed, me: current().id };
      }),
      2000,
    );
    expect({ pair: seen.pair, mixed: seen.mixed, tree: subtree(ev, seen.me) }).toEqual({
      pair: [2, 'X'],
      mixed: [0, 4, undefined],
      tree: [{ 'fiber all': ['fiber double', 'fiber shout'] }, { 'fiber all': ['fiber zero', 'fiber double', 'fiber sleep'] }],
    });
  });

  it('race([t(x), sleep(5)]): the sleep wins, and t is aborted and awaited, its finally run before race returns, as D28 loses a loser (the timeout idiom); t winning aborts the sleep', async () => {
    const t = trace();
    const slow = task(function* slow(id: string) {
      t.push(`slow(${id}) started`);
      try {
        yield* never();
        return id;
      } finally {
        t.push(`slow(${id}) finally`);
      }
    });
    const fast = task(function* fast(id: string) {
      yield* sleep(0);
      return id;
    });
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const timedOut = yield* race([slow('x'), sleep(5)]);
        t.push('race returned');
        const won = yield* race([fast('y'), sleep(10_000)]); // its timer is cleared by the abort: no 10 s wait
        return { timedOut, won, me: current().id };
      }),
      2000,
    );
    expect({
      log: t.log,
      values: { timedOut: seen.timedOut, won: seen.won },
      tree: subtree(ev, seen.me),
      settled: { slow: settledAs(ev, 'slow'), fast: settledAs(ev, 'fast'), sleep: settledAs(ev, 'sleep') },
    }).toEqual({
      log: ['slow(x) started', 'slow(x) finally', 'race returned'],
      values: { timedOut: undefined, won: 'y' },
      tree: [{ 'fiber race': ['fiber slow', 'fiber sleep'] }, { 'fiber race': ['fiber fast', 'fiber sleep'] }],
      settled: { slow: ['aborted'], fast: ['success'], sleep: ['success', 'aborted'] },
    });
  });

  it('settle of ops resolves with the four-way outcomes in order, a non-task op among them, each member a fiber of the group', async () => {
    const hang = task(
      function* hang() {
        yield* never();
      },
      { timeoutMs: 5 },
    );
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const outcomes = yield* settle([double(1), missing('u1'), broken(), hang(), sleep(1)]);
        return { outcomes: outcomes.map((o) => show(o, { boom })), me: current().id };
      }),
      2000,
    );
    expect({ outcomes: seen.outcomes, tree: subtree(ev, seen.me) }).toEqual({
      outcomes: ['success(2)', 'failure(NotFound: u1)', 'defect(boom)', 'aborted(TimeoutError: Timed out)', 'success(undefined)'],
      tree: [{ 'fiber settle': ['fiber double', 'fiber missing', 'fiber broken', 'fiber hang', 'fiber sleep'] }],
    });
  });

  it('fork(op) runs the op in a new child of the current node, a task-call op as the task itself; attempt(op) resolves with its four-way outcome', async () => {
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const f = fork(double(21));
        const g = fork(sleep(1));
        const forked = { names: [f.name, g.name], values: [yield* join(f), yield* join(g)] };
        const attempted = [
          show(yield* attempt(double(2))),
          show(yield* attempt(missing('u2'))),
          show(yield* attempt(wait(() => Promise.reject(boom))), { boom }),
        ];
        return { forked, attempted, me: current().id };
      }),
      2000,
    );
    expect({ forked: seen.forked, attempted: seen.attempted, forks: subtree(ev, seen.me).slice(0, 2) }).toEqual({
      forked: { names: ['double', 'sleep'], values: [42, undefined] },
      attempted: ['success(4)', 'failure(NotFound: u2)', 'defect(boom)'],
      forks: ['fiber double', 'fiber sleep'],
    });
  });

  it('pool.fork(op) forks the op into the pool, a task-call op as the task itself; a failure reaches the pool’s onFailure', async () => {
    const failures: string[] = [];
    const reported = Promise.withResolvers<void>();
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const jobs = pool({
          name: 'jobs',
          onFailure: (e) => {
            failures.push(label(e, { boom }));
            reported.resolve();
          },
        });
        const f = jobs.fork(double(5));
        const g = jobs.fork(sleep(1));
        jobs.fork(broken());
        const values = [yield* join(f), yield* join(g)];
        yield* wait(reported.promise); // the body's exit releases the pool, which would abort broken before it throws
        return { names: [f.name, g.name], values, me: current().id };
      }),
      2000,
    );
    expect({ names: seen.names, values: seen.values, failures, tree: subtree(ev, seen.me) }).toEqual({
      names: ['double', 'sleep'],
      values: [10, undefined],
      failures: ['boom'],
      tree: [{ 'pool jobs': ['fiber double', 'fiber sleep', 'fiber broken'] }],
    });
  });
});
