// Tests for runtime / promised callbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { current, fork, never, own, promised, result, sleep, wait } from '../../src/ambient.js';
import type { Context, Fiber, Instruction, Outcome } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { FiberAbortedError, NoCurrentNodeError } from '../../src/resource.js';
import { tick, trace, within } from '../support/util.js';
import type { Trace } from '../support/util.js';

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

/** The development-mode warnings ramme printed during this test. */
function rammeWarnings(): string[] {
  return warnings.filter((w) => w.startsWith('ramme:'));
}

/** `.reason` of an error (FiberAbortedError) or of an outcome; `undefined` for anything else. */
function reasonOf(x: unknown): unknown {
  return typeof x === 'object' && x !== null ? (x as { reason?: unknown }).reason : undefined;
}

/** `f`'s outcome, read from top level. It pushes `complete` to `t` when it arrives, which is a microtask or two after the node completed. */
function completion<T>(root: Context, f: Fiber<T>, t: Trace): PromiseLike<Outcome<T>> {
  return root.result(f).then((o) => {
    t.push('complete');
    return o;
  });
}

describe('generator bodies: promised', () => {
  it('promised: a real Promise per call, a call-shaped child of the node captured at creation, started synchronously; its value, its failure consumed, NoCurrentNodeError outside any node', async () => {
    const boom = new Error('boom');
    let outside: unknown;
    try {
      promised(function* () {
        return 1;
      });
    } catch (e) {
      outside = e;
    }
    const root = app();
    const inc = root.promised(function* (x: number) {
      // ctx.promised names the node explicitly, for a module-level entry point
      yield* sleep(1);
      return x + 1;
    });
    const p = inc(1);
    const fails = root.promised(function* (): Generator<Instruction, never, unknown> {
      yield* sleep(1);
      throw boom;
    });
    const failure = await within(fails().then(() => 'resolved', (e: unknown) => e));
    let inBody: Record<string, unknown> = {};
    await within(
      root.call(function* () {
        const node = current();
        let started = false;
        let childParent: Context | undefined;
        const cb = promised(function* (n: number) {
          started = true;
          childParent = current().parent;
          yield* wait(tick());
          return n * 2;
        });
        const q = cb(21);
        const startedSync = started; // synchronous start
        let forked = 'not forked';
        try {
          yield* result(fork(function* () {
            return 'x';
          }));
          forked = 'forked'; // nothing lent
        } catch (e) {
          forked = (e as Error).name;
        }
        inBody = {
          startedSync,
          childOfCapturedNode: childParent === node,
          forked,
          real: Object.getPrototypeOf(q) === Promise.prototype,
          value: yield* wait(q),
        };
      }),
    );
    expect({
      outside: outside instanceof NoCurrentNodeError,
      real: Object.getPrototypeOf(p) === Promise.prototype,
      value: await within(p),
      failure,
      inBody,
    }).toEqual({
      outside: true,
      real: true,
      value: 2,
      failure: boom,
      inBody: { startedSync: true, childOfCapturedNode: true, forked: 'forked', real: true, value: 42 },
    });
    await expect(root.close()).resolves.toBeUndefined(); // the failure was the promise's: consumed, nothing surfaces
  });

  it('promised inside a foreign transaction helper, halted mid-way: the library’s finally runs once the callback’s work has stopped, the callback’s promise rejects with FiberAbortedError, and the body ends aborted after it', async () => {
    const t = trace();
    const reason = new Error('client hung up');
    type Tx = { readonly id: number };
    let insertNode: Context | undefined;
    let callbackNode: Context | undefined;
    let libraryCaught: unknown;
    /** A driver's `transaction(fn)`: plain async code around the callback, as Prisma's, Knex's and Drizzle's are. */
    const db = {
      async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
        t.push('BEGIN');
        try {
          const v = await fn({ id: 1 });
          t.push('COMMIT');
          return v;
        } catch (e) {
          libraryCaught = e;
          t.push(`ROLLBACK; insert ${String(insertNode?.state)}`);
          throw e;
        } finally {
          t.push('connection returned');
        }
      },
    };
    const insert = task(
      function* (tx: Tx) {
        insertNode = current();
        t.push(`insert in tx ${tx.id}`);
        yield* never();
      },
      { name: 'insert' },
    );
    const root = app();
    const f = root.fork(
      task(
        function* () {
          own(t.at('entry released'));
          return yield* wait(
            db.transaction(
              promised(function* (tx: Tx) {
                callbackNode = current();
                yield* insert(tx);
                return 'saved';
              }),
            ),
          );
        },
        { name: 'save', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['BEGIN', 'insert in tx 1']);
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({
      log: t.log,
      outcome: o,
      callback: callbackNode?.outcome,
      callbackParentIsBody: callbackNode?.parent === f,
      libraryCaught: reasonOf(libraryCaught),
      warnings: rammeWarnings(),
    }).toEqual({
      log: ['BEGIN', 'insert in tx 1', 'ROLLBACK; insert complete', 'connection returned', 'entry released', 'complete'],
      outcome: { status: 'aborted', reason },
      callback: { status: 'aborted', reason },
      callbackParentIsBody: true,
      libraryCaught: reason,
      warnings: [],
    });
    expect(libraryCaught).toBeInstanceOf(FiberAbortedError);
    await root.close();
  });
});
