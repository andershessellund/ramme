// Tests for tasks / group failures.
import { afterEach, describe, expect, it } from 'vitest';
import { all, fail, never, race, settle, sleep } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { within } from '../support/util.js';
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

describe('all, race and settle', () => {
  it("all fails on a member's fail as on a defect (D28: the sibling runs to its end either way), and re-yields it: the caller ends failure(e), no catch run", async () => {
    const root = app();
    const e = new Boom('expected');
    const d = new Error('defect');
    const known = { e, d };
    async function once(kind: 'fail' | 'defect'): Promise<{ outcome: string; caller: string[]; sibling: string[] }> {
      const caller: string[] = [];
      const sibling: string[] = [];
      const member = task(
        function* () {
          yield* sleep(0);
          if (kind === 'fail') yield* fail(e);
          else throw d;
          return 1;
        },
        { name: 'member' },
      );
      const other = task(
        function* () {
          try {
            sibling.push('start');
            yield* sleep(5);
            sibling.push('end');
          } finally {
            sibling.push('finally');
          }
          return 2;
        },
        { name: 'sibling' },
      );
      const o = await within(
        root.attempt(function* () {
          try {
            yield* all([member, other]);
            caller.push('after all');
          } catch (x) {
            caller.push(`catch ${label(x, known)}`);
          } finally {
            caller.push('finally');
          }
          return 'returned';
        }),
      );
      return { outcome: show(o, known), caller, sibling };
    }
    const onDefect = await once('defect');
    const onFail = await once('fail');
    expect({ onDefect, onFail }).toEqual({
      onDefect: { outcome: 'success("returned")', caller: ['catch AggregateError(d)', 'finally'], sibling: ['start', 'end', 'finally'] },
      onFail: { outcome: 'failure(e)', caller: ['finally'], sibling: ['start', 'end', 'finally'] },
    });
    await within(root.close());
  });

  it("race: a member's fail does not beat a later success (as a defect does not, D28); a race with no success re-yields its member's fail: the caller ends failure(e)", async () => {
    const root = app();
    const e = new Boom('expected');
    const won = await within(
      root.attempt(function* () {
        return yield* race([
          task(
            function* () {
              yield* fail(e);
              return 'fast';
            },
            { name: 'fast' },
          ),
          task(
            function* () {
              yield* sleep(5);
              return 'won';
            },
            { name: 'slow' },
          ),
        ]);
      }),
    );
    const lost = await within(
      root.attempt(function* () {
        try {
          return yield* race([
            task(
              function* () {
                yield* sleep(0);
                yield* fail(e);
                return 'never';
              },
              { name: 'only' },
            ),
          ]);
        } catch (x) {
          return `caught ${label(x, { e })}`;
        }
      }),
    );
    expect({ won: show(won, { e }), lost: show(lost, { e }) }).toEqual({ won: 'success("won")', lost: 'failure(e)' });
    await within(root.close()); // the loser's failure is not the race's, and is consumed
  });

  it('settle resolves with the four-way outcomes in order, never failing the caller: failure(e), defect(d), aborted, success', async () => {
    const root = app();
    const e = new Boom('expected');
    const d = new Error('defect');
    const stop = new Error('stop');
    const known = { e, d, stop };
    const seen = await within(
      root.call(function* () {
        const ac = new AbortController();
        setTimeout(() => ac.abort(stop), 5);
        const outcomes = yield* settle([
          task(function* () {
            yield* sleep(0);
            yield* fail(e);
            return 1;
          }),
          task(function* () {
            yield* sleep(0);
            throw d;
          }),
          task(
            function* () {
              yield* never();
            },
            { signal: ac.signal },
          ),
          task(function* () {
            yield* sleep(0);
            return 1;
          }),
        ]);
        return outcomes.map((o) => show(o, known));
      }),
    );
    expect(seen).toEqual(['failure(e)', 'defect(d)', 'aborted(stop)', 'success(1)']);
    await within(root.close()); // settle consumed every member's failure
  });
});
