// Tests for runtime / generator driver.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { current, fork, interrupted, join, lookup, never, own, promised, signal, sleep, wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import type { Context, Fiber, Instruction } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { Sub, isInstruction } from '../../src/managed.js';
import type { InstructionImpl, WorkOp } from '../../src/managed.js';
import { AsyncRunError, FiberAbortedError, FiberNotAwaitableError, NoCurrentNodeError, NodeCompletedError } from '../../src/resource.js';
import { deferred, impl, tick, within } from '../support/util.js';

const warnings: string[] = [];

const roots: Context[] = [];

beforeEach(() => {
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(opts: { releaseTimeoutMs?: number } = {}): Context {
  const root = createRootContext(opts);
  roots.push(root);
  return root;
}

/** A platform timer: a foreign promise. */
function bare(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const failing = (name: string, ms = 1) =>
  task(
    function* (): Generator<Instruction, never, unknown> {
      yield* sleep(ms);
      throw new Error(`${name} failed`);
    },
    { name },
  );

describe('the driver: returned ops, handlers, refusals', () => {
  it('an async release or failure handler is a bare wait: current until its first await, and one that uses ramme after it fails with NoCurrentNodeError naming the cause, reported as a release failure and a handler exception (D41, decision 5)', async () => {
    const root = app();
    const seen: string[] = [];
    const n = root.child({ name: 'n' });
    n.own({}, async () => {
      seen.push(`release before its await: ${current().parent === n ? 'its fiber' : 'another node'}`);
      await Promise.resolve();
      lookup(createInjectionKey<string>('K')); // no current node after the first await
    });
    const released = await n.close().then(
      () => 'closed clean',
      (e: unknown) => e,
    );
    root.fork(
      task(
        function* (): Generator<Instruction, never, unknown> {
          throw new Error('fails');
        },
        {
          name: 'fails',
          onFailure: async () => {
            await Promise.resolve();
            current(); // the handler has no current node here either
          },
        },
      ),
    );
    const handled = await root.close().then(
      () => 'closed clean',
      (e: unknown) => e,
    );
    const describe = (e: unknown): string =>
      e instanceof NoCurrentNodeError && /no async context/.test(e.message) && /async release or handler/.test(e.message)
        ? 'NoCurrentNodeError naming the cause'
        : String(e);
    expect({ seen, released: describe(released), handled: describe(handled) }).toEqual({
      seen: ['release before its await: its fiber'],
      released: 'NoCurrentNodeError naming the cause',
      handled: 'NoCurrentNodeError naming the cause',
    });
  });

  it('a handler returning an op, or a generator handler, that waits for its parent’s close() does not hold the parent; a body or a release returning an op is driven', async () => {
    const closed: Record<string, string> = {};
    for (const shape of ['returns an op', 'generator'] as const) {
      const root = createRootContext({ name: 'app' });
      root.fork(
        task(
          function* (): Generator<Instruction, never, unknown> {
            throw new Error('boom');
          },
          {
            name: 'boom',
            onFailure:
              shape === 'returns an op'
                ? () => root.close()
                : function* () {
                    yield* root.close();
                  },
          },
        ),
      );
      closed[shape] = await Promise.race([impl(root).completion.then(() => 'completed'), bare(300).then(() => 'still open')]);
    }
    const root = app();
    const leaf = task(function* () {
      return 'leaf';
    });
    const returned = await root.attempt(task(() => leaf()));
    const released = await root.attempt(
      task(function* () {
        own({}, () => sleep(5));
      }),
    );
    expect({ closed, returned, released: released.status }).toEqual({
      closed: { 'returns an op': 'completed', generator: 'completed' },
      returned: { status: 'success', value: 'leaf' },
      released: 'success',
    });
  });

  it('a body that aborts itself mid-step is halted at its next yield*; an op yielded twice gives its value twice', async () => {
    const log: string[] = [];
    const root = app();
    const o = await root.attempt(function* () {
      current().abort(new Error('self'));
      log.push('after abort');
      try {
        yield* sleep(1000);
        log.push('unreachable');
      } finally {
        log.push('finally');
      }
    });
    const twice = await root.call(function* () {
      const p = task(function* () {
        yield* sleep(1);
        return 7;
      })();
      return [yield* p, yield* p];
    });
    expect({ o: o.status, log, twice }).toEqual({ o: 'aborted', log: ['after abort', 'finally'], twice: [7, 7] });
  });

  it('a body born delivered owns what its wait(p) produced: p finishes, the value is attached, and released with the node; a synchronous throw from making an op lands at its yield*', async () => {
    const log: string[] = [];
    const openTemp = (): Promise<{ name: string } & Disposable> =>
      bare(5).then(() => ({ name: 'tmp-1', [Symbol.dispose]: () => void log.push('temp file removed') }));
    const handle = task(
      function* () {
        const file = own(yield* wait(openTemp())); // started when evaluated: the halt lets it finish (decision 9, row 5)
        log.push(`owns ${file.name}; delivered ${String(signal().aborted)}`);
        yield* sleep(1); // halted here
        log.push('unreachable');
      },
      { name: 'handle' },
    );
    const root = app();
    let caught = '';
    const parent = root.fork(
      task(
        function* () {
          try {
            yield* sleep(-1); // RangeError from making the op, in this step
          } catch (e) {
            caught = (e as Error).name;
          }
          current().abort(new Error('hang up'));
          yield* join(fork(handle)); // a freeze fork of a delivered node: born delivered (D12); call-shaped join
        },
        { name: 'parent', onFailure: () => {} },
      ),
    );
    const o = await within(root.result(parent));
    expect({ o: o.status, caught, log }).toEqual({
      o: 'aborted',
      caught: 'RangeError',
      log: ['owns tmp-1; delivered true', 'temp file removed'],
    });
  });

  it('a generator failure handler’s failed wait is thrown into it, where its catch runs, and an observe body’s real failure is thrown in after its delivery, never a halt', async () => {
    const log: string[] = [];
    const root = app();
    const parent = root.fork(
      task(
        function* () {
          fork(
            task(
              function* (): Generator<Instruction, never, unknown> {
                throw new Error('child failed');
              },
              {
                name: 'child',
                onFailure: function* () {
                  try {
                    yield* wait(Promise.reject(new Error('report failed')));
                  } catch (e) {
                    log.push(`handler caught ${(e as Error).message}`);
                  }
                },
              },
            ),
          );
          yield* sleep(5);
        },
        { name: 'parent', onFailure: () => {} },
      ),
    );
    const observer = root.fork(
      task(
        function* () {
          yield* interrupted(); // delivered: an observe body runs on
          try {
            yield* failing('step')();
          } catch (e) {
            return `observer caught ${(e as Error).message}`;
          }
        },
        { name: 'observer', interrupt: 'observe', onFailure: () => {} },
      ),
    );
    await tick();
    observer.abort(new Error('hang up'));
    const outcomes = await within(Promise.all([root.result(parent), root.result(observer)]));
    expect({ log, outcomes }).toEqual({
      log: ['handler caught report failed'],
      outcomes: [
        { status: 'success', value: undefined },
        { status: 'success', value: 'observer caught step failed' },
      ],
    });
  });

  it('an op’s iterator: next() yields an instruction once, then returns what it is resumed with; return() drops the driver’s subscription, so a later settlement resumes nothing', async () => {
    const src = deferred<number>();
    const root = app();
    const op = root.wait(src.promise) as unknown as WorkOp<number>;
    const it = op[Symbol.iterator]();
    const first = it.next();
    const ins = first.value as unknown as InstructionImpl;
    const resumed: unknown[] = [];
    const owner = impl(root);
    ins.sub = new Sub(op.start(owner, owner), (ok, x) => void resumed.push(ok, x)); // as the driver subscribes
    const returned = it.return!(99);
    src.resolve(1);
    await tick();
    const again = op[Symbol.iterator]();
    expect({
      first: { done: first.done, isInstruction: isInstruction(first.value), isTheOp: (first.value as unknown) === op },
      returned,
      resumed,
      fresh: again.next(5).done === false && again.next(5).value === 5,
    }).toEqual({
      first: { done: false, isInstruction: true, isTheOp: false },
      returned: { done: true, value: 99 },
      resumed: [],
      fresh: true,
    });
  });

  it('refusals: a generator returning a fiber, an async generator body, wait of a non-promise, and run(fn) returning a generator', async () => {
    const root = app();
    const names: Record<string, string> = {};
    const fiber = await root.attempt(function* () {
      return current().fork(function* () {}) as unknown as Fiber<void>;
    });
    names.returnsFiber = fiber.status === 'defect' && fiber.error instanceof FiberNotAwaitableError ? 'FiberNotAwaitableError' : fiber.status;
    const asyncGen = await root.attempt(task(async function* () {} as unknown as () => Generator<Instruction, void, unknown>));
    names.asyncGenerator =
      asyncGen.status === 'defect' && asyncGen.error instanceof TypeError && /async generator/.test(asyncGen.error.message) ? 'TypeError' : asyncGen.status;
    const notAPromise = await root.attempt(function* () {
      yield* wait(42 as unknown as Promise<number>);
    });
    names.waitOfANumber = notAPromise.status === 'defect' && notAPromise.error instanceof TypeError ? 'TypeError' : notAPromise.status;
    const aFiber = await root.attempt(function* () {
      const f = fork(function* () {});
      yield* wait(f as unknown as Promise<void>); // never probes the fiber's `then` trap
    });
    names.waitOfAFiber = aFiber.status === 'defect' ? (aFiber.error as Error).name : aFiber.status;
    try {
      root.run(function* () {} as unknown as () => void);
      names.runGenerator = 'nothing thrown';
    } catch (e) {
      names.runGenerator = e instanceof AsyncRunError ? 'AsyncRunError' : String(e);
    }
    expect(names).toEqual({
      returnsFiber: 'FiberNotAwaitableError',
      asyncGenerator: 'TypeError',
      waitOfANumber: 'TypeError',
      waitOfAFiber: 'TypeError',
      runGenerator: 'AsyncRunError',
    });
  });

  it('refusals: an async generator failure handler, which nothing can step, is a handler exception naming function*, so the failure it was handed is not lost', async () => {
    const ran: string[] = [];
    const root = app();
    const o = await within(
      root.attempt(function* () {
        fork(
          task(
            function* (): Generator<Instruction, never, unknown> {
              throw new Error('worker failed');
            },
            {
              name: 'worker',
              onFailure: async function* (e: unknown) {
                ran.push((e as Error).message); // never runs: an async generator object is neither driven nor a thenable
              },
            },
          ),
        );
        yield* sleep(5);
        return 'owner done';
      }),
    );
    expect({
      status: o.status,
      error: o.status === 'defect' && o.error instanceof TypeError && /async generator/.test(o.error.message) && /function\*/.test(o.error.message),
      ran,
    }).toEqual({ status: 'defect', error: true, ran: [] });
  });

  it('promised: a call after the captured node completed rejects with NodeCompletedError; ctx.wait at top level is a bare wait', async () => {
    const root = createRootContext();
    const late = root.promised(function* () {
      return 1;
    });
    const bareWait = await root.wait(Promise.resolve('bare'));
    await root.close();
    const settled = await late().then(
      () => 'resolved',
      (e: unknown) => (e instanceof NodeCompletedError ? 'NodeCompletedError' : String(e)),
    );
    expect({ bareWait, settled }).toEqual({ bareWait: 'bare', settled: 'NodeCompletedError' });
  });

  it('a promised callback’s aborted child rejects its promise with FiberAbortedError, its reason the delivery’s', async () => {
    const reason = new Error('hang up');
    const root = app();
    let p: Promise<string> | undefined;
    const f = root.fork(
      task(
        function* () {
          const cb = promised(function* () {
            yield* never();
            return 'unreachable';
          });
          p = cb();
          yield* never();
        },
        { onFailure: () => {} },
      ),
    );
    await tick();
    f.abort(reason);
    const e = await within(p!.then(() => undefined, (x: unknown) => x));
    expect({ fiberAborted: e instanceof FiberAbortedError, reason: (e as FiberAbortedError).reason === reason }).toEqual({
      fiberAborted: true,
      reason: true,
    });
  });
});
