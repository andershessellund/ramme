// Tests for tasks / failure routing.
import { afterEach, describe, expect, it } from 'vitest';
import { fail, fork, never, signal, sleep } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { trace, within } from '../support/util.js';
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

describe('routing an unjoined fork’s expected failure (D14, D23, D28, D42)', () => {
  it("a linked child's fail aborts its parent, which surfaces it as its own defect(e) (a parent cannot be given a typed failure it did not declare): halted, no catch run, its finally run", async () => {
    const root = app();
    const e = new Boom('expected');
    const t = trace();
    const o = await within(
      root.attempt(function* () {
        fork(
          task(
            function* () {
              yield* sleep(0);
              yield* fail(e);
            },
            { name: 'linked', onFailure: 'link' },
          ),
        );
        try {
          yield* never();
          t.push('after never');
        } catch (x) {
          t.push(`catch ${label(x, { e })}`);
        } finally {
          t.push(`finally, reason ${label(signal().reason, { e })}`);
        }
      }),
    );
    expect({ outcome: show(o, { e }), log: t.log }).toEqual({ outcome: 'defect(e)', log: ['finally, reason e'] });
    await within(root.close());
  });

  it('a failure handler receives the error of a fail, with the fiber; the fiber’s outcome is failure(e)', async () => {
    const root = app();
    const e = new Boom('expected');
    const handled: string[] = [];
    const f = root.fork(
      task(
        function* () {
          yield* sleep(0);
          yield* fail(e);
        },
        {
          name: 'supervised',
          onFailure: (err, fiber) => void handled.push(`${label(err, { e })} from ${fiber === f ? 'the fiber' : 'another node'}`),
        },
      ),
    );
    const o = await within(root.result(f));
    expect({ handled, outcome: show(o, { e }) }).toEqual({ handled: ['e from the fiber'], outcome: 'failure(e)' });
    await within(root.close()); // the handler consumed it
  });

  it("a pooled fiber's fail reaches the pool's onFailure, as a defect does (D15)", async () => {
    const root = app();
    const e = new Boom('expected');
    const handled: string[] = [];
    const p = root.pool({
      name: 'jobs',
      onFailure: (err, fiber) => void handled.push(`${label(err, { e })} from ${fiber === f ? 'the fiber' : 'another node'}`),
    });
    const f = p.fork(function* () {
      yield* sleep(0);
      yield* fail(e);
    });
    await within(p.close());
    expect({ handled, outcome: show(f.outcome, { e }) }).toEqual({ handled: ['e from the fiber'], outcome: 'failure(e)' });
    await within(root.close());
  });
});
