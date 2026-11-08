// Tests for tasks / expected failures.
import { afterEach, describe, expect, it } from 'vitest';
import { attempt, fail, fork, join, never, result, sleep } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { events, trace, within } from '../support/util.js';
import type { EventLog } from '../support/util.js';
import { label, show } from '../support/observations.js';

// Each error class has a distinct literal member: TypeScript compares classes by structure, so two bare
// `class X extends Error {}` are one type and an inferred union would collapse to one of them (src/result.test.ts).
class Boom extends Error {
  readonly name = 'Boom' as const;
}

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

afterEach(async () => {
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

describe('yield* fail(e), the fourth exit', () => {
  it('yield* fail(e) ends the body at once with failure(e): no catch sees it, nothing after it runs, and its finally runs, and may wait, as on a halt', async () => {
    const root = app();
    const e = new Boom('expected');
    const t = trace();
    const o = await within(
      root.attempt(function* () {
        try {
          t.push('before');
          yield* fail(e);
          t.push('after fail');
        } catch (x) {
          t.push(`catch ${label(x, { e })}`);
        } finally {
          t.push('finally');
          yield* sleep(1);
          t.push('finally waited');
        }
        t.push('after try');
        return 'returned';
      }),
    );
    expect({ outcome: show(o, { e }), log: t.log }).toEqual({
      outcome: 'failure(e)',
      log: ['before', 'finally', 'finally waited'],
    });
    await within(root.close()); // attempt consumed the failure
  });

  it('a fail in a halted finally is a release failure: the body settles aborted by state (D24), the fail ends that finally, and the release failure amends the outcome to defect(e)', async () => {
    const ev = recorded();
    const e = new Boom('in the halted finally');
    const stop = new Error('stop');
    const t = trace();
    const seen = await within(
      ev.root.call(function* () {
        const f = fork(
          task(
            function* () {
              try {
                t.push('body');
                yield* never();
              } finally {
                t.push('finally');
                yield* fail(e);
                t.push('after fail');
              }
            },
            { name: 'halted' },
          ),
        );
        yield* sleep(1);
        f.abort(stop);
        return { id: f.id, outcome: yield* result(f) };
      }),
    );
    expect({
      log: t.log,
      settled: ev.of('node:settled').filter((x) => x.id === seen.id).map((x) => x.outcome),
      outcome: show(seen.outcome, { e, stop }),
    }).toEqual({
      log: ['body', 'finally'],
      settled: ['aborted'], // the classification at settling: the fail cannot change aborted
      outcome: 'defect(e)', // aborted + a release failure → defect (the amendment table)
    });
  });

  it('attempt returns the four-way outcome: failure(e) for a fail, defect(d) for a throw, aborted for an abort, success otherwise', async () => {
    const root = app();
    const e = new Boom('expected');
    const d = new Error('defect');
    const stop = new Error('stop');
    const known = { e, d, stop };
    const seen = await within(
      root.call(function* () {
        const failed = show(
          yield* attempt(function* () {
            yield* sleep(0);
            yield* fail(e);
            return 1;
          }),
          known,
        );
        const threw = show(
          yield* attempt(function* () {
            yield* sleep(0);
            throw d;
          }),
          known,
        );
        const ac = new AbortController();
        setTimeout(() => ac.abort(stop), 1);
        const aborted = show(
          yield* attempt(
            task(
              function* () {
                yield* never();
              },
              { signal: ac.signal },
            ),
          ),
          known,
        );
        const succeeded = show(
          yield* attempt(function* () {
            yield* sleep(0);
            return 1;
          }),
          known,
        );
        return { fail: failed, throw: threw, abort: aborted, success: succeeded };
      }),
    );
    expect(seen).toEqual({ fail: 'failure(e)', throw: 'defect(d)', abort: 'aborted(stop)', success: 'success(1)' });
    await within(root.close()); // every failure was consumed by its attempt
  });
});

describe('propagation through call and join', () => {
  it("call and join re-yield a child's fail: the caller ends failure(e), no catch run, its finally run; a child's defect is thrown into the caller, which catches it", async () => {
    const root = app();
    const e = new Boom('expected');
    const d = new Error('defect');
    const known = { e, d };
    const failing = task(
      function* () {
        yield* sleep(0);
        yield* fail(e);
      },
      { name: 'failing' },
    );
    const throwing = task(
      function* () {
        yield* sleep(0);
        throw d;
      },
      { name: 'throwing' },
    );
    const logs = { callFail: [] as string[], callDefect: [] as string[], joinFail: [] as string[], joinDefect: [] as string[] };
    const callFail = await within(
      root.attempt(function* () {
        try {
          yield* failing();
          logs.callFail.push('after call');
        } catch (x) {
          logs.callFail.push(`catch ${label(x, known)}`);
        } finally {
          logs.callFail.push('finally');
        }
        return 'returned';
      }),
    );
    const callDefect = await within(
      root.attempt(function* () {
        try {
          yield* throwing();
          logs.callDefect.push('after call');
        } catch (x) {
          logs.callDefect.push(`catch ${label(x, known)}`);
        } finally {
          logs.callDefect.push('finally');
        }
        return 'returned';
      }),
    );
    const joinFail = await within(
      root.attempt(function* () {
        const f = fork(failing);
        try {
          yield* join(f);
          logs.joinFail.push('after join');
        } catch (x) {
          logs.joinFail.push(`catch ${label(x, known)}`);
        } finally {
          logs.joinFail.push('finally');
        }
        return 'returned';
      }),
    );
    const joinDefect = await within(
      root.attempt(function* () {
        const f = fork(throwing);
        try {
          yield* join(f);
          logs.joinDefect.push('after join');
        } catch (x) {
          logs.joinDefect.push(`catch ${label(x, known)}`);
        } finally {
          logs.joinDefect.push('finally');
        }
        return 'returned';
      }),
    );
    expect({
      callFail: { outcome: show(callFail, known), log: logs.callFail },
      callDefect: { outcome: show(callDefect, known), log: logs.callDefect },
      joinFail: { outcome: show(joinFail, known), log: logs.joinFail },
      joinDefect: { outcome: show(joinDefect, known), log: logs.joinDefect },
    }).toEqual({
      // exactly failure(e): the re-yield consumed the child's failure, or the caller's completion would amend it
      callFail: { outcome: 'failure(e)', log: ['finally'] },
      callDefect: { outcome: 'success("returned")', log: ['catch d', 'finally'] },
      joinFail: { outcome: 'failure(e)', log: ['finally'] },
      joinDefect: { outcome: 'success("returned")', log: ['catch d', 'finally'] },
    });
    await within(root.close());
  });
});
