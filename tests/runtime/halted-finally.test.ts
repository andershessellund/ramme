// Tests for runtime / halted finally.
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { all, attempt, current, fork, interrupted, join, lookup, never, own, promised, result, signal, sleep, wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import type { Context, Fiber, Instruction, Op, Operation, Outcome, Task } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { valueProvider } from '../../src/provider-util.js';
import { deferred, impl, tick, trace, unhandledRejectionGuard, within } from '../support/util.js';
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

/** A platform timer: a foreign promise, which no delivery touches. */
function bare(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `f`'s outcome, read from top level. It pushes `complete` to `t` when it arrives, which is a microtask or two after the node completed. */
function completion<T>(root: Context, f: Fiber<T>, t: Trace): PromiseLike<Outcome<T>> {
  return root.result(f).then((o) => {
    t.push('complete');
    return o;
  });
}

/** The work in flight when the body is halted: a `call` that never ends on its own; `state()` reads its node's state. */
function slowTask(t?: Trace) {
  let node: Context | undefined;
  const slow = task(
    function* () {
      node = current();
      t?.push('slow running');
      yield* never();
    },
    { name: 'slow' },
  );
  return { slow, state: () => node?.state };
}

/** A generator function that yields something other than an op, typed as a body: what untyped code can pass. */
function untyped<T>(g: () => Generator<unknown, T, unknown>): () => Generator<Instruction, T, unknown> {
  return g as unknown as () => Generator<Instruction, T, unknown>;
}

describe('generator bodies: the halted finally, and the halt’s other shapes', () => {
  it('a finally in the body may yield*: after a call-shaped halt has completed, its call and its sleep run to their end as release work, under an unwind fiber of the node, while the synchronous verbs address the node (U3)', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const K = createInjectionKey<string>('K');
    const { slow, state } = slowTask(t);
    let cleanupNode: Context | undefined;
    const cleanup = task(
      function* () {
        cleanupNode = current();
        yield* sleep(5); // not halted: its parent, the unwind fiber, is never delivered
        t.push('cleanup slept');
        return 'ok';
      },
      { name: 'cleanup' },
    );
    let inFinally: Record<string, unknown> = {};
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    roots.push(root);
    const f = root.fork(
      task(
        function* () {
          const body = current();
          try {
            yield* slow();
          } finally {
            t.push(`finally; slow ${String(state())}`);
            inFinally = { currentIsBody: current() === body, signalAborted: signal().aborted, lookup: lookup(K) };
            const v = yield* cleanup();
            t.push(`cleanup returned ${v}`);
            yield* sleep(5);
            t.push('slept in the finally');
          }
        },
        { name: 'tx', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    const unwind = cleanupNode?.parent;
    expect({
      log: t.log,
      outcome: o,
      inFinally,
      cleanup: { delivered: cleanupNode?.signal.aborted, outcome: cleanupNode?.outcome },
      unwindFiber: {
        kind: unwind === undefined ? undefined : impl(unwind).kind,
        mode: unwind === undefined ? undefined : impl(unwind).mode,
        ownedByBody: unwind?.parent === f,
      },
    }).toEqual({
      log: ['slow running', 'finally; slow complete', 'cleanup slept', 'cleanup returned ok', 'slept in the finally', 'complete'],
      outcome: { status: 'aborted', reason },
      inFinally: { currentIsBody: true, signalAborted: true, lookup: 'k' },
      cleanup: { delivered: false, outcome: { status: 'success', value: 'ok' } },
      unwindFiber: { kind: 'release', mode: 'observe', ownedByBody: true },
    });
    await root.close();
  });

  it('decision 29: a yield* in a helper’s finally loses the halt; the body runs on past it, as release work, and the dev mode reports the lost halt', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const { slow } = slowTask(t);
    const charge = task(
      function* () {
        yield* sleep(1); // run to its end: a child of the unwind fiber, not born delivered
        t.push('charge ran to its end');
      },
      { name: 'charge' },
    );
    /** A helper whose finally waits: by the yield* algorithm its caller is resumed normally once that finally ends. */
    function* withCleanup(): Generator<Instruction, string, unknown> {
      try {
        yield* slow();
        return 'done';
      } finally {
        yield* wait(tick());
        t.push('helper cleanup done');
      }
    }
    const root = app();
    const f = root.fork(
      task(
        function* () {
          yield* withCleanup();
          t.push('body continued past the halt');
          yield* charge();
          return 'lost';
        },
        { name: 'lossy', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({
      log: t.log,
      outcome: o,
      warnings: rammeWarnings().map((w) => /halt/i.test(w) && w.includes('lossy')),
    }).toEqual({
      log: ['slow running', 'helper cleanup done', 'body continued past the halt', 'charge ran to its end', 'complete'],
      outcome: { status: 'aborted', reason }, // by state (D24), whatever the generator returned
      warnings: [true], // one report, naming the body
    });
    await root.close();
  });

  it('decision 29: after a lost halt the helper’s yield* gives the body the halt’s sentinel, and in dev mode any use of it reports the lost halt, once: rows.map, whose throw is a release failure (D45), and String(rows) followed by return rows', async () => {
    const t = trace();
    const reason = new Error('hang up');
    /** A helper whose finally waits: its caller gets the halt's sentinel as the value of the yield*. */
    function* query(): Generator<Instruction, string[], unknown> {
      try {
        yield* never();
        return ['a'];
      } finally {
        yield* wait(bare(5));
      }
    }
    const root = app();
    const mapper = root.fork(
      task(
        function* () {
          const rows = yield* query();
          t.push('mapper ran more work');
          return rows.map((r) => r.toUpperCase()); // a TypeError, thrown in the unwind: a release failure (D45)
        },
        { name: 'mapper', ...quiet },
      ),
    );
    const passer = root.fork(
      task(
        function* () {
          const rows = yield* query();
          t.push(`passer continued with a ${typeof String(rows)}`);
          yield* sleep(1);
          t.push('passer ran more work');
          return rows; // the sentinel itself: no other value to report
        },
        { name: 'passer', ...quiet },
      ),
    );
    await tick();
    mapper.abort(reason);
    passer.abort(reason);
    const outcomes = await within(Promise.all([root.result(mapper), root.result(passer)]));
    expect({
      log: [...t.log].sort(),
      outcomes: outcomes.map((o) => o.status),
      warned: ['mapper#', 'passer#'].map((n) => rammeWarnings().filter((w) => /halt .* was lost/.test(w) && w.includes(n)).length),
      warnings: rammeWarnings().length,
    }).toEqual({
      log: ['mapper ran more work', 'passer continued with a string', 'passer ran more work'],
      outcomes: ['defect', 'aborted'], // aborted by state (D24), the mapper's amended by its release failure
      warned: [1, 1],
      warnings: 2,
    });
  });

  it('decision 12: a yield* in the halted finally whose wait includes the node itself or an ancestor returns the generator there, with a dev-mode warning, instead of deadlocking the unwind', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const { slow } = slowTask();
    const root = app();
    const shape = (owner: Context, name: string, op: () => Op<void>) =>
      owner.fork(
        task(
          function* () {
            try {
              yield* slow();
            } finally {
              t.push(`${name}: finally starts`);
              yield* op();
              t.push(`${name}: unreachable`);
            }
          },
          { name, ...quiet },
        ),
      );
    const self = shape(root, 'self-dispose', () => current()[Symbol.asyncDispose]()); // current() is the node (U3)
    const entry = shape(root, 'own-entry', () => root.release(current())); // its own entry on root
    const svc = root.child({ name: 'svc' });
    const ancestor = shape(svc, 'ancestor-close', () => svc.close()); // its owner's completion waits for it
    const fibers = [self, entry, ancestor];
    await tick();
    for (const x of fibers) x.abort(reason);
    const outcomes = await within(Promise.all(fibers.map((x) => root.result(x))));
    expect({
      log: [...t.log].sort(),
      outcomes: outcomes.map((o) => o.status),
      warned: ['self-dispose', 'own-entry', 'ancestor-close'].map((n) => rammeWarnings().filter((w) => w.includes(n)).length),
      warnings: rammeWarnings().length,
    }).toEqual({
      log: ['ancestor-close: finally starts', 'own-entry: finally starts', 'self-dispose: finally starts'],
      outcomes: ['aborted', 'aborted', 'aborted'],
      warned: [1, 1, 1],
      warnings: 3,
    });
    await within(svc.close());
    expect(svc.state).toBe('complete');
  });

  it('decision 12: in the halted finally a join or result of a fork the node owns, which no delivery reaches and only the node’s own release ends, returns the generator there with the warning instead of deadlocking every owner; an owned fork that has completed gives its value', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const root = app();
    const server = task(
      function* () {
        yield* never(); // ends only when its owner releases it
      },
      { name: 'server' },
    );
    const shape = (name: string, waitFor: (srv: Fiber<void>) => Op<unknown>) =>
      root.fork(
        task(
          function* () {
            const srv = own(fork(server)); // owned: unsubscribed, released with the node, after its finally
            try {
              yield* never();
            } finally {
              t.push(`${name}: finally`);
              try {
                yield* waitFor(srv);
              } catch {
                t.push(`${name}: caught`);
              }
              t.push(`${name}: unreachable`);
            }
          },
          { name, ...quiet },
        ),
      );
    const joiner = shape('joiner', (srv) => join(srv));
    const resulter = shape('resulter', (srv) => result(srv));
    const flusher = root.fork(
      task(
        function* () {
          const flush = own(
            fork(
              task(function* () {
                return 'flushed'; // completes on its own, before the halt
              }),
            ),
          );
          try {
            yield* never();
          } finally {
            t.push(`flusher: ${yield* join(flush)}`);
          }
        },
        { name: 'flusher', ...quiet },
      ),
    );
    const fibers = [joiner, resulter, flusher];
    await tick();
    for (const f of fibers) f.abort(reason);
    const outcomes = await within(Promise.all(fibers.map((f) => root.result(f))));
    expect({
      log: [...t.log].sort(),
      outcomes: outcomes.map((o) => o.status),
      warned: ['joiner#', 'resulter#', 'flusher#'].map((n) => rammeWarnings().filter((w) => w.includes(n)).length),
    }).toEqual({
      log: ['flusher: flushed', 'joiner: finally', 'resulter: finally'],
      outcomes: ['aborted', 'aborted', 'aborted'],
      warned: [1, 1, 0],
    });
  });

  it('wait((signal) => p) hands the work the body’s signal(): the halt aborts it, its rejection ends the body with no catch run, and it is never an unhandled rejection', async () => {
    const t = trace();
    const reason = new Error('navigated away');
    let handed: AbortSignal | undefined;
    let caught: unknown = 'nothing caught';
    /** A fetch-like driver: answers after 10 s, or rejects with the signal's reason when it aborts. */
    const fetchLike = (url: string, s: AbortSignal): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        handed = s;
        t.push(`fetch ${url}`);
        const timer = setTimeout(() => resolve('body'), 10_000);
        s.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            t.push('fetch aborted');
            reject(s.reason);
          },
          { once: true },
        );
      });
    const root = app();
    const f = root.fork(
      task(
        function* () {
          try {
            const body = yield* wait((s) => fetchLike('/search?q=x', s));
            t.push(`got ${body}`);
          } catch (e) {
            caught = e;
          } finally {
            t.push('finally');
          }
        },
        { name: 'search', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({ log: t.log, outcome: o, caught, handedIsBodySignal: handed === f.signal }).toEqual({
      log: ['fetch /search?q=x', 'fetch aborted', 'finally', 'complete'],
      outcome: { status: 'aborted', reason },
      caught: 'nothing caught',
      handedIsBodySignal: true,
    });
    await root.close();
  });

  it('a body born delivered is stepped to its first yield*: a wait(p, { abandon: true }) there, started when made, returns it at once, p left running and its later rejection handled; a call yielded after the delivery is not run (decision 9, row 5)', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const p = deferred<string>();
    let runs = 0;
    let bornNode: Context | undefined;
    let bornDelivered: boolean | undefined;
    const born = task(
      function* () {
        runs++;
        bornNode = current();
        bornDelivered = signal().aborted;
        t.push('born: first step');
        try {
          yield* wait(p.promise, { abandon: true }); // started: subscribed, so p is handled, and returned at once
          t.push('born: unreachable');
        } finally {
          t.push('born: finally');
        }
      },
      { name: 'born' },
    );
    const root = app();
    const f = root.fork(
      task(
        function* () {
          yield* wait(bare(20)); // halted meanwhile: p finishes and the body is resumed, its node delivered
          t.push('resumed');
          fork(born); // a freeze child of a delivered node: born delivered (D12); fork is eager
          yield* born(); // not started: the parent is returned here, and born runs once
          t.push('unreachable');
        },
        { name: 'parent', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    p.reject(new Error('late')); // handled: the abandoned wait subscribed to p before it was returned
    await tick(3);
    expect({
      log: t.log,
      outcome: o,
      runs,
      bornDelivered,
      born: bornNode?.outcome,
      unhandled: (unhandledRejectionGuard()?.seen ?? []).length,
    }).toEqual({
      log: ['resumed', 'born: first step', 'born: finally', 'complete'],
      outcome: { status: 'aborted', reason },
      runs: 1,
      bornDelivered: true,
      born: { status: 'aborted', reason },
      unhandled: 0,
    });
    await root.close();
  });

  it('modes: an observe generator body is never halted, hears the delivery through interrupted() and settles with its own result; a restore body is halted as a freeze one is', async () => {
    const t = trace();
    const reason = new Error('hang up');
    let window: Outcome<void> | undefined;
    const root = app();
    const observer = root.fork(
      task(
        function* () {
          window = yield* attempt(
            task(
              function* () {
                try {
                  yield* never();
                  t.push('restore child: went on past the halt'); // a halt runs nothing after the yield*
                } catch (e) {
                  t.push(`restore child: caught ${(e as Error).name}`); // nor any catch: the halt is no error
                } finally {
                  t.push('restore child: finally');
                }
              },
              { name: 'window', interrupt: 'restore' }, // hears every delivery on its subscription path
            ),
          );
          const why = yield* interrupted(); // already delivered: resolves at once
          t.push(`observer heard ${String(why === reason)}; signal ${String(signal().aborted)}`);
          yield* sleep(5); // runs its full duration
          t.push('observer slept');
          return 'observed';
        },
        { name: 'observer', interrupt: 'observe', ...quiet },
      ),
    );
    await tick();
    observer.abort(reason);
    const o = await within(root.result(observer));
    expect({ log: t.log, outcome: o, window }).toEqual({
      log: ['restore child: finally', 'observer heard true; signal true', 'observer slept'],
      outcome: { status: 'success', value: 'observed' },
      window: { status: 'aborted', reason },
    });
  });

  it('a yielded value that is not an op (`yield op` without the star, or any other value) is a TypeError thrown into the generator at that yield', async () => {
    const caught: string[] = [];
    const root = app();
    const v = await within(
      root.call(
        task(
          untyped(function* () {
            for (const x of [42, sleep(1)]) {
              try {
                yield x;
              } catch (e) {
                caught.push(e instanceof TypeError ? 'TypeError' : String(e));
              }
            }
            return 'went on';
          }),
          { name: 'yields-values' },
        ),
      ),
    );
    expect({ v, caught }).toEqual({ v: 'went on', caught: ['TypeError', 'TypeError'] });
  });

  it('a generator release runs in its release fiber, current across its yields, its sleep the full duration; a generator failure handler runs with the parent current across its yields and holds the parent until it ends: the parent’s body returns and its entries are released meanwhile, and it completes after the handler', async () => {
    const t = trace();
    const err = new Error('worker failed');
    const handled: unknown[] = [];
    const handlerStarted = deferred();
    const root = app();
    const f = root.fork(
      task(
        function* () {
          const parent = current();
          own({ name: 'conn' }, function* (c) {
            const n = current();
            yield* wait(tick());
            t.push(`release of ${c.name} in ${impl(n).kind}; still current ${String(current() === n)}`);
            yield* sleep(5); // a release fiber's sleep runs its full duration
            t.push('release slept');
          });
          yield* result(fork(
            task(
              function* (): Generator<Instruction, never, unknown> {
                yield* sleep(1);
                throw err;
              },
              {
                name: 'worker',
                onFailure: function* (e) {
                  handled.push(e);
                  t.push(`handler: parent current ${String(current() === parent)}`);
                  handlerStarted.resolve(); // the body returns now: only the hold keeps the parent open from here on
                  yield* sleep(30); // a handler's sleep runs its full duration, outlasting the conn's release
                  t.push(`handler slept; parent current ${String(current() === parent)}`);
                  t.push(
                    yield* task(function* () {
                      return 'handler called'; // a call from a handler, which nothing halts
                    })(),
                  );
                },
              },
            ),
          ));
          yield* wait(handlerStarted.promise);
          t.push('body returns');
          return 'done';
        },
        { name: 'owner', ...quiet },
      ),
    );
    const o = await within(completion(root, f, t));
    expect({ log: t.log, outcome: o, handled }).toEqual({
      log: [
        'handler: parent current true',
        'body returns',
        'release of conn in release; still current true', // the hold delays the completion, not the entries' release
        'release slept',
        'handler slept; parent current true',
        'handler called',
        'complete',
      ],
      outcome: { status: 'success', value: 'done' },
      handled: [err],
    });
  });

  it('attempt of a generator task resolves with its outcome, a failure consumed; an interrupted caller is returned once the child has completed and never sees one', async () => {
    const boom = new Error('boom');
    const double = task(
      function* (n: number) {
        yield* sleep(1);
        return n * 2;
      },
      { name: 'double' },
    );
    const failing = task(
      function* (): Generator<Instruction, number, unknown> {
        yield* sleep(1);
        throw boom;
      },
      { name: 'failing' },
    );
    const stuck = task(
      function* (): Generator<Instruction, number, unknown> {
        return yield* never();
      },
      { name: 'stuck', timeoutMs: 10 },
    );
    const root = app();
    const outcomes = await within(
      root.call(function* () {
        return [yield* attempt(double, 21), yield* attempt(failing()), yield* attempt(stuck)];
      }),
    );
    const timedOut = (o: Outcome<number>): unknown => (o.status === 'aborted' ? `aborted: ${(o.reason as Error).name}` : o);
    expect(outcomes.map(timedOut)).toEqual([{ status: 'success', value: 42 }, { status: 'defect', error: boom }, 'aborted: TimeoutError']);
    await expect(root.close()).resolves.toBeUndefined(); // attempt's resume step consumed the failure

    const t = trace();
    const reason = new Error('hang up');
    const { slow, state } = slowTask(t);
    let seen: unknown = 'no outcome';
    const root2 = app();
    const f = root2.fork(
      task(
        function* () {
          try {
            seen = yield* attempt(slow);
          } finally {
            t.push(`finally; slow ${String(state())}`);
          }
        },
        { name: 'caller', ...quiet },
      ),
    );
    await tick();
    f.abort(reason);
    const o = await within(root2.result(f));
    expect({ log: t.log, seen, outcome: o }).toEqual({
      log: ['slow running', 'finally; slow complete'],
      seen: 'no outcome', // aborted would describe the child; the caller's own interruption is never a value (D31)
      outcome: { status: 'aborted', reason },
    });
  });

  it('types: yield* infers through verbs, generator helpers and tasks; a generator is an Operation; an op is awaitable; promised keeps the arguments', () => {
    // Never run: the generators below are only type-checked (vitest's expectTypeOf is a no-op at run time).
    function* double(n: number) {
      yield* sleep(0);
      return n * 2;
    }
    const byLength = task(function* (id: string) {
      const n = yield* double(id.length);
      return `${id}:${n}`;
    });
    const returnsOp = task(() => byLength('x')); // a synchronous body returning an op (decision 28)
    const asyncBody = task(function* (n: number) { return n + 1; });
    const throws = task(function* (): Generator<Instruction, never, unknown> {
      throw new Error('never returns'); // T is never, not the generator object
    });
    expectTypeOf(double).returns.toEqualTypeOf<Generator<Instruction, number, unknown>>();
    expectTypeOf(throws).toEqualTypeOf<Task<[], never>>();
    expectTypeOf(double(1)).toExtend<Operation<number>>();
    expectTypeOf(byLength).toEqualTypeOf<Task<[id: string], string>>();
    expectTypeOf(returnsOp).toEqualTypeOf<Task<[], string>>();
    expectTypeOf(asyncBody).toEqualTypeOf<Task<[n: number], number>>();
    expectTypeOf<Awaited<Op<number>>>().toEqualTypeOf<number>();
    // Operation<T> annotates a helper that is only yield*ed: Body has no Operation<T> arm (D41's settled note), so a
    // helper a body returns, or a body that needs an annotation, is typed Generator<Instruction, T, unknown>.
    function* annotated(n: number): Operation<string> {
      yield* sleep(n);
      return String(n);
    }
    function* typed(n: number): Generator<Instruction, string, unknown> {
      return yield* annotated(n); // yield* of an Operation-annotated helper infers its T
    }
    // @ts-expect-error an Operation-annotated helper returned by a body
    task(() => annotated(1));
    // @ts-expect-error a body annotated Operation<T>
    task(function* (): Operation<number> {
      yield* sleep(0);
      return 1;
    });
    expectTypeOf(task(() => typed(1))).toEqualTypeOf<Task<[], string>>();
    expectTypeOf(
      task(function* (): Generator<Instruction, number, unknown> {
        yield* sleep(0);
        return 1;
      }),
    ).toEqualTypeOf<Task<[], number>>();
    function* probe() {
      expectTypeOf(byLength('x')).toEqualTypeOf<Op<string>>();
      expectTypeOf(yield* byLength('x')).toEqualTypeOf<string>();
      expectTypeOf(yield* attempt(byLength, 'x')).toEqualTypeOf<Outcome<string, never>>(); // E = never: byLength yields no fail (D42)
      expectTypeOf(yield* all([byLength('x'), asyncBody(1)])).toEqualTypeOf<[string, number]>();
      expectTypeOf(yield* wait(Promise.resolve(1))).toEqualTypeOf<number>();
      expectTypeOf(yield* wait((s: AbortSignal) => Promise.resolve(String(s.aborted)))).toEqualTypeOf<string>();
      const cb = promised(function* (tx: string) {
        yield* sleep(0);
        return tx.length;
      });
      expectTypeOf(cb).parameters.toEqualTypeOf<[tx: string]>();
      expectTypeOf(cb).returns.toEqualTypeOf<Promise<number>>();
    }
    expect(typeof probe).toBe('function');
  });
});
