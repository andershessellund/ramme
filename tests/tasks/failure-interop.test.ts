// Tests for tasks / failure interop.
import { afterEach, describe, expect, it } from 'vitest';
import { fail, promised, sleep, wait } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { $, failure, success } from '../../src/result.js';
import { trace, within } from '../support/util.js';
import { label, show } from '../support/observations.js';

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

describe('promised and $', () => {
  it('promised of a body that fails rejects with e, which it consumes', async () => {
    const root = app();
    const e = new Boom('expected');
    const seen = await within(
      root.call(function* () {
        const cb = promised(function* () {
          yield* sleep(0);
          yield* fail(e);
          return 1;
        });
        return yield* wait(
          cb().then(
            (v) => `resolved with ${label(v, { e })}`,
            (x: unknown) => `rejected with ${label(x, { e })}`,
          ),
        );
      }),
    );
    expect(seen).toBe('rejected with e');
    await within(root.close()); // consumed by the promise: nothing surfaces from the node
  });

  it("yield* $(r) in a body is a success's value, and ends the body with a failure's error: failure(e), no catch run, its finally run", async () => {
    const root = app();
    const e = new Boom('expected');
    const t = trace();
    const o = await within(
      root.attempt(function* () {
        const v = yield* $(success(1));
        t.push(`value ${v}`);
        try {
          yield* $(failure(e));
          t.push('after $');
        } catch (x) {
          t.push(`catch ${label(x, { e })}`);
        } finally {
          t.push('finally');
        }
        return v;
      }),
    );
    expect({ outcome: show(o, { e }), log: t.log }).toEqual({ outcome: 'failure(e)', log: ['value 1', 'finally'] });
  });
});
