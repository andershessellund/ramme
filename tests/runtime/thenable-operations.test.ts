// Tests for runtime / thenable operations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FiberAbortedError, createRootContext, current, never, sleep, task } from '../../src/index.js';
import type { Context, Op } from '../../src/index.js';
import { tick, trace, within } from '../support/util.js';

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

/** A handler for forks onto the bodiless root (D14). */
const quiet = { onFailure: () => {} } as const;

describe('the thenable (decisions 4, 16)', () => {
  it('await op with an explicit receiver: the value; the failure, consumed; FiberAbortedError when the child ended aborted', async () => {
    const boom = new Error('boom');
    const ok = task(
      function* () {
        yield* sleep(1);
        return 'v';
      },
      { name: 'ok' },
    );
    const fails = task(
      function* () {
        yield* sleep(1);
        throw boom;
      },
      { name: 'fails' },
    );
    const slow = task(
      function* () {
        yield* never();
      },
      { name: 'slow' },
    );
    const root = app();
    const value = await within(root.call(ok));
    const failure = await within(root.call(fails).then(() => 'resolved', (e: unknown) => e));
    const aborted = await within(root.call(slow.with({ timeoutMs: 5 })).then(() => 'resolved', (e: unknown) => e));
    const closed = await within(root.close().then(() => 'closed clean', (e: unknown) => e)); // nothing left unconsumed
    expect({ value, failure, aborted: aborted instanceof FiberAbortedError ? 'FiberAbortedError' : aborted, closed }).toEqual({
      value: 'v',
      failure: boom,
      aborted: 'FiberAbortedError',
      closed: 'closed clean',
    });
  });

  it('an op made in a step and handed out is run by then as a child of its node, only when then is called: its value; and when that node is aborted, FiberAbortedError with its reason, never an interruption of the awaiter', async () => {
    const t = trace();
    const reason = new Error('hang up');
    let parentOfWork: Context | undefined;
    const handedWork = task(
      function* () {
        parentOfWork = current().parent;
        t.push('work ran');
        return 'w';
      },
      { name: 'work' },
    );
    let slowNode: Context | undefined;
    const slow = task(
      function* () {
        slowNode = current();
        t.push('slow running');
        yield* never();
      },
      { name: 'slow' },
    );
    const handed: { work?: Op<string>; slow?: Op<void> } = {};
    let workHost: Context | undefined;
    let slowHost: Context | undefined;
    const root = app();
    const f = root.fork(
      task(
        function* () {
          workHost = current();
          handed.work = handedWork(); // made in the step, never yielded: runs nothing yet
          yield* never();
        },
        { name: 'hands out work', ...quiet },
      ),
    );
    const g = root.fork(
      task(
        function* () {
          slowHost = current();
          handed.slow = slow();
          yield* never();
        },
        { name: 'hands out slow', ...quiet },
      ),
    );
    await tick();
    const ranBeforeThen = [...t.log];
    const value = await within(handed.work!);
    const slowRun = handed.slow!.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await tick();
    const slowRunning = t.log.includes('slow running');
    g.abort(reason);
    const rejection = await within(slowRun);
    f.abort(reason);
    const outcomes = await within(Promise.all([root.result(f), root.result(g)]));
    /** An error or reason as a short string: the diff must not print a node an `OwnerInterrupt` carries. */
    const named = (x: unknown): unknown => (x === reason ? 'the abort reason' : x instanceof Error ? `${x.name}: ${x.message}` : x);
    expect({
      ranBeforeThen,
      value,
      workIsChildOfHost: parentOfWork !== undefined && parentOfWork === workHost,
      slowRunning,
      slowIsChildOfHost: slowNode?.parent !== undefined && slowNode.parent === slowHost,
      rejection: rejection instanceof Error ? rejection.name : rejection,
      rejectionReason: named((rejection as { reason?: unknown }).reason),
      outcomes: outcomes.map((o) => (o.status === 'defect' ? `defect: ${String(named(o.error))}` : o.status)),
    }).toEqual({
      ranBeforeThen: [],
      value: 'w',
      workIsChildOfHost: true,
      slowRunning: true,
      slowIsChildOfHost: true,
      rejection: 'FiberAbortedError',
      rejectionReason: 'the abort reason',
      outcomes: ['aborted', 'aborted'],
    });
  });

  it('a work op is a plain thenable: then only, no catch or finally, not a Promise', async () => {
    const root = app();
    const op = root.call(function* () {
      return 1;
    });
    const shape = {
      then: typeof op.then,
      iterable: typeof op[Symbol.iterator],
      catch: 'catch' in op,
      finally: 'finally' in op,
      promise: op instanceof Promise,
    };
    const value = await within(op);
    expect({ shape, value }).toEqual({
      shape: { then: 'function', iterable: 'function', catch: false, finally: false, promise: false },
      value: 1,
    });
  });
});
