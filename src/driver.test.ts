// driver.test.ts — the op protocol and the driver's subscription (DESIGN.md §4.2, D41), what managed.test.ts pinned
// for managed promises restated for ops: a work op's `then` (run once per object, each consumer resumed in the
// source's reaction with promise-handler semantics), a lifecycle op's promise (`.catch` and `.finally` through `then`,
// derived promises plain, the resume step once per consumer), I10 for ops nobody consumes, A1 for a halted body's
// dropped subscription, and decision 7's resumption in the source's reaction. The halt rows themselves are pinned in
// generator-pin.test.ts and stage2-pin.test.ts.
import { describe, expect, it } from 'vitest';
import { current, join, never, wait } from './ambient.js';
import { peekCurrentNode } from './context-storage.js';
import type { Instruction } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { LifecycleOp, WorkOp } from './managed.js';
import { NodeCompletedError } from './resource.js';
import { deferred, gcUntil, hasGc, tick, trace, unhandledRejectionGuard, within } from './test/util.js';
import type { UnhandledRejectionGuard } from './test/util.js';

/** The setup file's unhandled-rejection guard (src/test/setup.ts). */
function guard(): UnhandledRejectionGuard {
  const g = unhandledRejectionGuard();
  if (g === undefined) throw new Error('src/test/setup.ts is not installed (vitest.config.ts setupFiles)');
  return g;
}

describe('a work op’s then (DESIGN.md §4.2, decisions 3, 4)', () => {
  it('runs the op once, on the first then, and resumes every consumer in the source’s reaction: a non-callable handler passes the outcome through (a failure as a rejection), a throwing one rejects its derived promise, and a then after it settled is never synchronous', async () => {
    const root = createRootContext();
    let runs = 0;
    const gate = deferred<number>();
    const op = root.call(function* () {
      runs++;
      return yield* wait(gate.promise);
    });
    expect(runs).toBe(0); // lazy: nothing ran
    const first = op.then((v) => v * 10);
    const passThrough = op.then(); // no handlers: the value as it is
    const throwing = op.then(() => {
      throw new Error('handler threw');
    });
    expect(runs).toBe(1); // the first then ran it, synchronously; the others joined that run
    gate.resolve(4);
    const settledValues = await Promise.all([first, passThrough, throwing.then(undefined, (e: Error) => e.message)]);
    let syncLate = 'not yet';
    const late = op.then((v) => (syncLate = `late ${v}`));
    const atCall = syncLate; // a then after the op settled resumes in a job, as a settled promise's then
    await late;
    const failing = root.call(function* () {
      throw new Error('boom');
    });
    // No onRejected: the failure passes through as a rejection of the derived promise, consumed by the one run (D13′).
    const failedThrough = await failing.then(() => 'fulfilled').then(undefined, (e: Error) => `rejected: ${e.message}`);
    expect({ runs, settledValues, atCall, syncLate, failedThrough }).toEqual({
      runs: 1,
      settledValues: [40, 4, 'handler threw'],
      atCall: 'not yet',
      syncLate: 'late 4',
      failedThrough: 'rejected: boom',
    });
    await root.close();
  });

  it('then is a foreign awaiter: called inside a step, it runs the op under no frame, so wait’s function sees no current node there, where the step’s yield* of the same op runs it in the body’s frame', async () => {
    const root = createRootContext();
    const seen = await root.call(function* () {
      const me = current() as unknown;
      const seen: string[] = [];
      const op = wait(() => {
        const n = peekCurrentNode() as unknown;
        seen.push(n === undefined ? 'no node' : n === me ? 'the body' : 'another node');
        return Promise.resolve();
      });
      yield* op; // the driver runs it in the body's frame
      const viaThen = op.then(); // run by then, synchronously, inside this step
      yield* wait(viaThen);
      return seen;
    });
    expect(seen).toEqual(['the body', 'no node']);
    await root.close();
  });

  it('guards run when the op is made (decision 17); what fails when it runs (wait’s function returning no promise, a receiver completed since it was made) lands at the yield*, where a catch sees it, or rejects then', async () => {
    const root = createRootContext();
    const done = root.child({ name: 'done' });
    const madeOpen = done.call(function* () {
      return 1;
    }); // made while done is open: its guards pass
    await done.close();
    expect(() => done.call(function* () {})).toThrow(NodeCompletedError); // made on a completed node: refused at once
    const inBody = await root.call(function* () {
      const seen: string[] = [];
      try {
        yield* wait(() => 42 as unknown as Promise<number>); // the function form's value is checked when it runs
      } catch (e) {
        seen.push((e as Error).name);
      }
      try {
        yield* madeOpen; // runs now, on a completed node
      } catch (e) {
        seen.push((e as Error).name);
      }
      return seen;
    });
    expect(inBody).toEqual(['TypeError', 'NodeCompletedError']);
    await expect(madeOpen).rejects.toBeInstanceOf(NodeCompletedError); // and through then
    await root.close();
  });
});

describe('a lifecycle op is a promise (DESIGN.md §4.2, decision 2)', () => {
  it('close() starts now and is a Promise subclass: .catch and .finally go through its then, derived promises are plain Promises, and each then is its own consumer, through the resume step once', async () => {
    const root = createRootContext();
    const n = root.child({ name: 'n' });
    const err = new Error('release failed');
    n.own(() => {
      throw err;
    });
    const closing = n.close(); // eager: the close has run already (a synchronous release)
    expect(n.state).toBe('complete');
    const caught = closing.catch((e: unknown) => e);
    const finallyRan: string[] = [];
    const fin = closing.finally(() => void finallyRan.push('finally'));
    expect({
      lifecycleIsPromise: closing instanceof Promise,
      lifecycleIsOp: closing instanceof LifecycleOp,
      derivedPlain: [caught.constructor === Promise, fin.constructor === Promise],
      iterable: typeof closing[Symbol.iterator],
    }).toEqual({ lifecycleIsPromise: true, lifecycleIsOp: true, derivedPlain: [true, true], iterable: 'function' });
    expect(await caught).toBe(err);
    await expect(fin).rejects.toBe(err);
    await expect(closing).rejects.toBe(err); // a third consumer: delivered again, never consumed into nothing
    expect(finallyRan).toEqual(['finally']);
    await expect(root.close()).resolves.toBeUndefined(); // the close's consumers consumed it: nothing surfaces
  });

  it('a work op is no Promise and no LifecycleOp: then only', async () => {
    const root = createRootContext();
    const op = root.sleep(0);
    expect({ work: op instanceof WorkOp, promise: op instanceof Promise, lifecycle: op instanceof LifecycleOp }).toEqual({
      work: true,
      promise: false,
      lifecycle: false,
    });
    await op;
    await root.close();
  });
});

describe('I10 and A1 for ops (DESIGN.md §10)', () => {
  it('ops nobody consumes are never an unhandled rejection: a work op runs nothing, and a lifecycle op whose release fails surfaces from its owner instead', async () => {
    const before = guard().seen.length;
    const root = createRootContext();
    const err = new Error('release failed, nobody waits');
    let ran = false;
    const out = await root.attempt(function* () {
      void root.call(function* () {
        ran = true;
        throw new Error('never runs');
      });
      const x = root.own({}, () => {
        throw err;
      });
      void root.release(x); // eager: it runs now; nobody waits for it
      yield* wait(tick(2)); // the provisional hold (D16) ends: the failure is the owner's
      return 'returned';
    });
    expect({ out, ran }).toEqual({ out: { status: 'success', value: 'returned' }, ran: false });
    await expect(root.close()).rejects.toBe(err); // the owner, root, surfaces it once
    await tick(2);
    expect(guard().seen.length).toBe(before);
  });

  it.skipIf(!hasGc)('a body halted on a join of a fiber in another tree is not retained by that fiber: its subscription is dropped and emptied, so the generator and what it held are collectable while the fiber runs on (A1)', async () => {
    const other = createRootContext({ name: 'other' });
    const long = other.fork(
      task(
        function* () {
          yield* never();
        },
        { onFailure: () => {} },
      ),
    );
    const root = createRootContext();
    const refs: WeakRef<object>[] = [];
    const f = root.fork(
      task(
        function* (): Generator<Instruction, void, unknown> {
          const held = { big: new Array<number>(100_000).fill(1) };
          refs.push(new WeakRef(held));
          yield* join(long); // not subscribed below this body: the halt returns it at once
          void held.big.length;
        },
        { onFailure: () => {} },
      ),
    );
    await tick();
    f.abort();
    await within(root.result(f));
    await gcUntil(() => refs.every((r) => r.deref() === undefined));
    expect(long.state).toBe('running'); // the source, long's completion, is still pending
    long.abort();
    await other.close();
    await root.close();
  });
});

describe('decision 7: a body resumes in its source’s reaction (DESIGN.md §4.2)', () => {
  it('a wait(p) resumes the body in p’s reaction, before a microtask queued after p settled, and never inside the step that made the op', async () => {
    const t = trace();
    const root = createRootContext();
    const gate = deferred<string>();
    const f = root.fork(
      task(
        function* () {
          const v = yield* wait(gate.promise);
          t.push(`resumed with ${v}`);
        },
        { onFailure: () => {} },
      ),
    );
    await tick();
    gate.resolve('v');
    queueMicrotask(() => t.push('a microtask queued after p settled'));
    t.push('after resolve, synchronously');
    await within(root.result(f));
    expect(t.log).toEqual(['after resolve, synchronously', 'resumed with v', 'a microtask queued after p settled']);
    await root.close();
  });
});

describe('the unhandled-rejection guard (I10, src/test/setup.ts)', () => {
  // A real unhandled rejection would also fail the run through vitest's own reporter, so the probe drives the
  // guard's listener directly and checks that it is the one Node calls.
  it('is installed on the process and records what it hears', () => {
    const g = guard();
    expect(process.listeners('unhandledRejection')).toContain(g.listener);
    const probe = new Error('guard probe');
    g.listener(probe);
    expect(g.seen).toContain(probe);
    g.seen.splice(g.seen.indexOf(probe), 1); // consumed here, so the after-each check passes
  });
});
