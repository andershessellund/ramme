// Tests for lifecycle / failure outcomes.
import { afterEach, describe, expect, it } from 'vitest';
import { attempt, fail, never, own, sleep } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { within } from '../support/util.js';
import { show } from '../support/observations.js';

// Each error class has a distinct literal member: TypeScript compares classes by structure, so two bare
// `class X extends Error {}` are one type and an inferred union would collapse to one of them (tests/result/results.test.ts).
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

describe('the release amendment, four-way (DESIGN.md §4.12)', () => {
  it('success + release failure → defect(r); failure + release failure → the release-primary SuppressedError(r, e), a defect; defect + release failure → defect(SuppressedError(r, d)); aborted + release failure → defect(r)', async () => {
    const root = app();
    const e = new Boom('expected');
    const d = new Error('defect');
    const r = new Error('release');
    const stop = new Error('stop');
    const known = { e, d, r, stop };
    /** An entry whose release throws `r`, on the current node. */
    const failingRelease = (): void => {
      own(() => {
        throw r;
      });
    };
    const rows = await within(
      root.call(function* () {
        const onSuccess = show(
          yield* attempt(function* () {
            failingRelease();
            yield* sleep(0);
            return 1;
          }),
          known,
        );
        const onFailure = show(
          yield* attempt(function* () {
            failingRelease();
            yield* sleep(0);
            yield* fail(e);
          }),
          known,
        );
        const onDefect = show(
          yield* attempt(function* () {
            failingRelease();
            yield* sleep(0);
            throw d;
          }),
          known,
        );
        const ac = new AbortController();
        setTimeout(() => ac.abort(stop), 1);
        const onAborted = show(
          yield* attempt(
            task(
              function* () {
                failingRelease();
                yield* never();
              },
              { signal: ac.signal },
            ),
          ),
          known,
        );
        return { success: onSuccess, failure: onFailure, defect: onDefect, aborted: onAborted };
      }),
    );
    expect(rows).toEqual({
      success: 'defect(r)',
      failure: 'defect(SuppressedError(error: r, suppressed: e))',
      defect: 'defect(SuppressedError(error: r, suppressed: d))',
      aborted: 'defect(r)',
    });
    await within(root.close());
  });
});
