// Tests for lifecycle / thrown values.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attempt, fork, join, own, release, result, sleep, wait } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { within } from '../support/util.js';
import { labelError as label, showError as show, type Known } from '../support/observations.js';

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

/** How `p` settled, read from top level: `resolved(…)` or `rejected(…)`; a deadlock rejects after a second. */
async function settledWith(p: PromiseLike<unknown>, known: Known = {}): Promise<string> {
  try {
    return `resolved(${label(await within(p), known)})`;
  } catch (e) {
    return `rejected(${label(e, known)})`;
  }
}

describe('a thrown undefined or null is the error it is, never “no error”', () => {
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
