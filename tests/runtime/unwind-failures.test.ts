// Tests for runtime / unwind failures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, fork, join, never, result, sleep } from '../../src/ambient.js';
import type { Context, Fail, Instruction } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { tick, within } from '../support/util.js';
import { showError as show, type Known } from '../support/observations.js';

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

/** A handler for forks onto the bodiless root (D14). */
const quiet = { onFailure: () => {} } as const;

/** A platform timer: a foreign promise, which no delivery touches. */
function bare(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('a halted finally’s throw is a release failure (D45)', () => {
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
