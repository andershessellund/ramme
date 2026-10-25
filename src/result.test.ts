// result.test.ts — `ramme/result`: expected failures as plain `Result` values, and `gen`/`$`, the `?`
// operator (DESIGN.md §4.12, §4.13, D38). The helpers are free functions over any object of the shape; `$`
// is a hand-written async iterator whose `yield*` evaluates to the success value itself, unawaited, or
// yields the failure, which ends `gen`'s run as its result. `gen` is plain async code, which a body waits for
// with `yield* wait(gen(…))`; the await in `$` runs an op through its `then` (DESIGN.md §4.14). Stage 3 of D41
// retires `gen`. The type-level half is src/test/surface.check.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { call, fork, join, own, pool, sleep, wait } from './ambient.js';
import type { Context, Failure, Fiber, Result } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { PoolFullError } from './resource.js';
import {
  $,
  andThen,
  collect,
  failure,
  fromThrowing,
  gen,
  isFailure,
  isSuccess,
  map,
  mapFailure,
  orElse,
  success,
  unwrap,
  unwrapOr,
} from './result.js';
import { deferred, neverSettles, tick, unhandledRejectionGuard, within } from './test/util.js';
import type { UnhandledRejectionGuard } from './test/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// Each error class has a distinct literal member: TypeScript compares classes by structure, so two bare
// `class X extends Error {}` are one type and an inferred union would collapse to one of them.
class UserNotFound extends Error {
  readonly name = 'UserNotFound' as const;
}
class OrderNotFound extends Error {
  readonly name = 'OrderNotFound' as const;
}
interface User {
  readonly id: string;
}
interface Order {
  readonly user: User;
  readonly total: number;
}

const users = new Map<string, User>([
  ['42', { id: '42' }],
  ['5', { id: '5' }], // a short id, so a gen body's returned failure is reachable; it has no orders
]);

async function getUser(id: string): Promise<Result<User, UserNotFound>> {
  const user = users.get(id);
  return user === undefined ? failure(new UserNotFound(id)) : success(user);
}

async function getOrder(user: User): Promise<Result<Order, OrderNotFound>> {
  return user.id === '42' ? success({ user, total: 7 }) : failure(new OrderNotFound(user.id));
}

/** The setup file's unhandled-rejection guard (src/test/setup.ts). */
function guard(): UnhandledRejectionGuard {
  const g = unhandledRejectionGuard();
  if (g === undefined) throw new Error('src/test/setup.ts is not installed (vitest.config.ts setupFiles)');
  return g;
}

describe('Result values (DESIGN.md §4.12, D38)', () => {
  it('success and failure are plain, unfrozen literals: no class, no methods, no symbol-keyed members', () => {
    const err = new Error('e');
    const shapes = [success(1), failure(err)];
    expect(shapes).toEqual([
      { status: 'success', value: 1 },
      { status: 'failure', error: err },
    ]);
    for (const r of shapes) {
      expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
      expect(Object.isFrozen(r)).toBe(false);
      expect(Object.getOwnPropertySymbols(r)).toEqual([]);
      expect(Object.keys(r)).toHaveLength(2);
    }
    expect((failure(err) as Failure<Error>).error).toBe(err);
  });

  it('isSuccess and isFailure read status', () => {
    expect([isSuccess(success(0)), isSuccess(failure(0)), isFailure(success(0)), isFailure(failure(0))]).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it('map and mapFailure transform one side and return the other object as it is', () => {
    const f = failure('e');
    const s = success(2);
    const never = vi.fn();
    expect(map(s, (v) => v * 10)).toEqual(success(20));
    expect(map(f, never)).toBe(f);
    expect(mapFailure(f, (e) => `${e}!`)).toEqual(failure('e!'));
    expect(mapFailure(s, never)).toBe(s);
    expect(never).not.toHaveBeenCalled();
  });

  it('andThen chains a success into the next step; orElse recovers a failure; the other side passes through', () => {
    const f: Result<number, string> = failure('e');
    const s: Result<number, string> = success(2);
    const never = vi.fn();
    expect(andThen(s, (v) => success(v + 1))).toEqual(success(3));
    expect(andThen(s, (v) => failure(`no ${v}`))).toEqual(failure('no 2'));
    expect(andThen(f, never)).toBe(f);
    expect(orElse(f, (e) => success(e.length))).toEqual(success(1));
    expect(orElse(f, (e) => failure([e]))).toEqual(failure(['e']));
    expect(orElse(s, never)).toBe(s);
    expect(never).not.toHaveBeenCalled();
  });

  it('unwrap returns the value or throws the error itself: the named conversion to a defect', () => {
    const err = new UserNotFound('7');
    expect(unwrap(success('v'))).toBe('v');
    expect(() => unwrap(failure(err))).toThrow(err);
    let thrown: unknown;
    try {
      unwrap(failure(err));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err); // the same object, not wrapped
    expect([unwrapOr(success(1), 'x'), unwrapOr(failure(new Error()), 'x')]).toEqual([1, 'x']);
  });

  it('collect returns the first failure itself, or every value in order', () => {
    const first = failure('first');
    expect(collect([success(1), success(2), success(3)])).toEqual(success([1, 2, 3]));
    expect(collect([])).toEqual(success([]));
    expect(collect([success(1), first, failure('second')])).toBe(first);
  });

  it('fromThrowing fences a throwing function: the value as a success, the thrown object as a failure', () => {
    const err = new Error('boom');
    expect(fromThrowing(() => JSON.parse('{"a":1}'))).toEqual(success({ a: 1 }));
    // A return type, because a function typed `() => never` matches the promise overload, which comes first.
    const r = fromThrowing((): number => {
      throw err;
    });
    expect(r).not.toBeInstanceOf(Promise);
    expect(r.status === 'failure' && r.error).toBe(err);
  });

  it('fromThrowing over an async function that throws resolves failure(x) with the same object, and no unhandled rejection', async () => {
    const x = new Error('async boom');
    const p = fromThrowing(async () => {
      throw x;
    });
    expect(p).toBeInstanceOf(Promise); // not a Success holding an unfenced promise
    const r = await p;
    expect(r).toEqual(failure(x));
    expect(r.status === 'failure' && r.error).toBe(x);
    expect(await fromThrowing(async () => 5)).toEqual(success(5));
    await tick(); // the setup's guard fails this test on an unhandled rejection
  });

  it('fromThrowing over a promise, or a function returning a thenable, chains it: a rejection is a failure', async () => {
    const x = new Error('rejected');
    expect(await fromThrowing(Promise.resolve('ok'))).toEqual(success('ok'));
    const rejected = await fromThrowing(Promise.reject(x));
    expect(rejected.status === 'failure' && rejected.error).toBe(x);
    const thenable = {
      then(onFulfilled: (v: number) => void): void {
        onFulfilled(9);
      },
    } as unknown as PromiseLike<number>; // a thenable that is not a Promise
    expect(await fromThrowing(() => thenable)).toEqual(success(9));
    expect(await fromThrowing(thenable)).toEqual(success(9));
  });

  it('fromThrowing over a function that may return a promise: the Result, or a promise of it, as the value turns out', async () => {
    const maybe = (later: boolean): number | Promise<number> => (later ? Promise.resolve(2) : 1);
    const now = fromThrowing(() => maybe(false)); // typed as either (src/test/surface.check.ts)
    const later = fromThrowing(() => maybe(true));
    expect(now).toEqual(success(1));
    expect(later).toBeInstanceOf(Promise);
    expect(await later).toEqual(success(2));
  });

  it('fromThrowing over a function returning a fiber: the fiber is the success, never probed, and can be joined', async () => {
    const app = createRootContext();
    const got = await app.call(function* () {
      const r = fromThrowing(() => fork(function* () { return 3; })); // a fiber's `then` getter throws (DESIGN.md §4.5)
      expect(r.status).toBe('success');
      if (r.status === 'failure') throw r.error;
      return yield* join(r.value);
    });
    expect(got).toBe(3);
    await app.close();
  });

  it('fromThrowing fences pool intake: an admitted fork is its fiber as a success, a refused one PoolFullError as a failure', async () => {
    const app = createRootContext();
    let ran = 0;
    const job = task(function* () {
      ran++;
      return 'ran';
    });
    const got = await app.call(function* () {
      const p = pool({ name: 'p', concurrency: 1, whenFull: 'reject', onFailure: () => {} });
      const admitted = fromThrowing(() => p.fork(job)); // admitted: it holds the one slot until it completes
      const refused = fromThrowing(() => p.fork(job));
      expect(refused.status === 'failure' && refused.error).toBeInstanceOf(PoolFullError);
      if (admitted.status === 'failure') throw admitted.error;
      return yield* join(admitted.value);
    });
    expect([got, ran]).toEqual(['ran', 1]);
    await app.close();
  });

  it('every helper works on a hand-rolled object of the shape, not only on what success and failure make', async () => {
    const s = JSON.parse('{"status":"success","value":3}') as Result<number, string>;
    const f = { status: 'failure', error: 'e', extra: true } as Result<number, string>;
    expect([isSuccess(s), isFailure(f), unwrap(s), unwrapOr(f, 0)]).toEqual([true, true, 3, 0]);
    expect(map(s, (v) => v + 1)).toEqual(success(4));
    expect(map(f, (v) => v + 1)).toBe(f);
    expect(mapFailure(f, (e) => e.toUpperCase())).toEqual(failure('E'));
    expect(andThen(s, (v) => success(v * 2))).toEqual(success(6));
    expect(orElse(f, () => success(0))).toEqual(success(0));
    expect(collect([s, f])).toBe(f);
    const r = await gen(async function* () {
      const v = yield* $(s);
      yield* $(Promise.resolve(f));
      return success(v);
    });
    expect(r).toBe(f);
  });
});

describe('gen and $: the ? operator (DESIGN.md §4.13, D38)', () => {
  it('yield* $(…) evaluates to the success value; the body returns a Result', async () => {
    const r = await gen(async function* () {
      const user = yield* $(getUser('42'));
      const order = yield* $(getOrder(user));
      return success(order);
    });
    expect(r).toEqual(success({ user: { id: '42' }, total: 7 }));
  });

  it('a yielded failure ends the run as data and is the result itself; nothing after it runs, and no catch sees it', async () => {
    let after = false;
    let caught = false;
    const r = await gen(async function* () {
      try {
        const user = yield* $(getUser('nobody'));
        after = true;
        return success(user);
      } catch {
        caught = true;
        return failure(new Error('caught'));
      }
    });
    expect(r.status).toBe('failure');
    expect(r.status === 'failure' && r.error).toBeInstanceOf(UserNotFound);
    expect([after, caught]).toEqual([false, false]);
    const known = failure(new OrderNotFound('x'));
    expect(
      await gen(async function* () {
        yield* $(known);
        return success(1);
      }),
    ).toBe(known);
  });

  it('a body may return failure(e) beside yield*, and gens nest: the inner gen is a Result the outer $ consumes', async () => {
    const tooShort = failure('too short' as const);
    const tooLong = failure(new OrderNotFound('42'));
    const inner = (id: string) =>
      gen(async function* () {
        const user = yield* $(getUser(id));
        if (user.id.length < 2) return tooShort; // returned beside the yield*
        return success(user.id.length);
      });
    const outer = (id: string, max: number) =>
      gen(async function* () {
        const n = yield* $(inner(id));
        if (n > max) return tooLong;
        return success(n * 100);
      });
    expect(await outer('42', 2)).toEqual(success(200));
    expect(await outer('42', 1)).toBe(tooLong); // the body's returned failure is gen's result itself
    expect(await outer('5', 2)).toBe(tooShort); // the inner body's returned failure, yielded by the outer $
    const missing = await outer('7', 2);
    expect(missing.status === 'failure' && missing.error).toBeInstanceOf(UserNotFound);
  });

  it('yield* $(success(p)) evaluates to the promise p itself, never awaited', async () => {
    const p = deferred<number>().promise; // never settles: an awaited value would hang the run
    const r = await within(
      gen(async function* () {
        const got = yield* $(success(p));
        return success({ got });
      }),
    );
    expect(r.status === 'success' && r.value.got).toBe(p);
  });

  it('yield* $(success(fiber)) evaluates to the fiber, whose then trap is never reached', async () => {
    const app = createRootContext();
    const got = await app.call(function* () {
      const fb = fork(function* () { return 7; });
      const r = yield* wait(gen(async function* () {
        const f = yield* $(success(fb));
        return success({ f });
      }));
      expect(r.status === 'success' && r.value.f).toBe(fb);
      return yield* join(fb);
    });
    expect(got).toBe(7);
    await app.close();
  });

  it('$ is its own async iterator: the first next() unwraps once, a later one never settles, return() is done', async () => {
    const f = failure('e');
    const s = $(success(1));
    const it = s[Symbol.asyncIterator]();
    expect(it).toBe(s);
    expect(await it.next()).toEqual({ done: true, value: 1 });
    await neverSettles(it.next());
    expect(await it.return!()).toEqual({ done: true, value: undefined });
    const fi = $(Promise.resolve(f))[Symbol.asyncIterator]();
    const step = await fi.next();
    expect(step).toEqual({ done: false, value: f });
    expect(step.value).toBe(f);
  });

  it('gen does not call return() on the suspended generator: a finally in the body never runs', async () => {
    let finallyRan = false;
    const r = await gen(async function* () {
      try {
        yield* $(failure('stop'));
        return success(1);
      } finally {
        finallyRan = true; // banned in ramme bodies (A7); here it shows the generator is never resumed
      }
    });
    await tick();
    expect(r).toEqual(failure('stop'));
    expect(finallyRan).toBe(false);
  });

  it('gen rejects at once with what the body throws: a defect is not a Result', async () => {
    const defect = new TypeError('a bug');
    await expect(
      gen(async function* () {
        yield* $(success(1));
        throw defect;
      }),
    ).rejects.toBe(defect);
    const rejecting = new Error('rejected source');
    await expect(
      gen(async function* () {
        yield* $(Promise.reject<Result<number, never>>(rejecting));
        return success(1);
      }),
    ).rejects.toBe(rejecting);
  });

  it('gen(thisArg, body) runs a generator in a method with this bound', async () => {
    class Repo {
      readonly #prefix = '4';
      readonly name = 'repo';
      load(rest: string): Promise<Result<string, UserNotFound>> {
        return gen(this, async function* () {
          const user = yield* $(getUser(this.#prefix + rest));
          return success(`${this.name}:${user.id}`);
        });
      }
    }
    expect(await new Repo().load('2')).toEqual(success('repo:42'));
    const missing = await new Repo().load('3');
    expect(missing.status === 'failure' && missing.error).toBeInstanceOf(UserNotFound);
  });

  // gen is an async function (DESIGN.md §4.13, D38's cost): its promise rejects with whatever the body throws, and a
  // failure thrown by a `call` inside `$` was consumed by `$`'s await, its resume step (D13).
  it('a dropped gen(…) over $(call(t)) where t throws is an unhandled rejection, and the body’s node does not surface it', async () => {
    const err = new Error('t threw');
    const t = task(function* () {
      throw err;
    });
    const app = createRootContext();
    const failures: unknown[] = [];
    const gate = deferred();
    const f = app.fork(
      task(
        function* () {
          void gen(async function* () {
            const v = yield* $(call(t));
            return success(v);
          });
          yield* wait(gate.promise); // bare: the dropped gen is reported meanwhile
          return 'done';
        },
        { onFailure: (e) => void failures.push(e) },
      ),
    );
    await tick(2);
    const seen = guard().seen;
    expect(seen).toContain(err);
    seen.splice(seen.indexOf(err), 1); // consumed here, so the after-each check passes
    gate.resolve();
    expect(await within(app.result(f))).toEqual({ status: 'success', value: 'done' });
    expect(failures).toEqual([]);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// The interplay with interruption (DESIGN.md §4.13, §4.14): `gen` is plain async code, which a body waits for with
// `yield* wait(gen(…))`. The generator runs in the body's step until its first `await`, so a `$(call(t))` there
// makes its op for the body's node, and `$`'s `await` runs it through its `then`: a child of the node, which nothing
// halts but its own delivery. The body's `wait(p)` lets `p` finish (row 3): the child, a subscriber of the node, is
// delivered and halted, `gen` rejects with its `FiberAbortedError`, and the body is returned there, the failure
// discarded, never thrown into a `catch`.
// ---------------------------------------------------------------------------

/** Waits on a sleep, so a delivery halts it at once and its caller's release does not wait on a bare promise. */
const slowResultTask = task(
  function* () {
    yield* sleep(10_000);
    return success(1);
  },
  { name: 'slowResultTask' },
);

type GenBody = (resumed: () => void) => AsyncGenerator<Failure<unknown>, Result<unknown, unknown>, unknown>;

interface Run {
  readonly app: Context;
  readonly f: Fiber<unknown>;
  readonly released: () => boolean;
  readonly resumed: () => boolean;
  /** What `await gen(…)` threw in the body. */
  readonly caught: unknown[];
  readonly failures: unknown[];
  readonly warn: MockInstance<typeof console.warn>;
}

/** A fiber that owns a resource and runs `await gen(body)`; `resumed` is set after the gen and by the body's own flag. */
function runGen(mode: 'freeze' | 'restore' | 'observe', body: GenBody): Run {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const app = createRootContext();
  const failures: unknown[] = [];
  const caught: unknown[] = [];
  let released = false;
  let resumed = false;
  const mark = (): void => {
    resumed = true;
  };
  const f = app.fork(
    task(
      function* () {
        own(() => {
          released = true;
        });
        try {
          const r = yield* wait(gen(() => body(mark)));
          mark();
          return r;
        } catch (e) {
          caught.push(e);
          throw e;
        }
      },
      { interrupt: mode, onFailure: (e) => void failures.push(e) },
    ),
  );
  return { app, f, released: () => released, resumed: () => resumed, caught, failures, warn };
}

describe('gen and $ under interruption (DESIGN.md §4.13, §4.14)', () => {
  for (const mode of ['freeze', 'restore'] as const)
    it(`${mode}: a body waiting on gen over an in-flight $(call(t)) is returned once gen settles: the call's child, delivered with the body, is halted, gen rejects with its FiberAbortedError, and no catch runs; aborted, released, never resumed past the wait`, async () => {
      const run = runGen(mode, async function* (resumed) {
        const v = yield* $(call(slowResultTask));
        resumed();
        return success(v);
      });
      await tick(); // the body is waiting on gen, gen on $'s await of the call
      run.f.abort();
      expect(run.f.state).toBe('running'); // release-shaped: the body waits for gen to settle
      expect(await within(run.app.result(run.f), 1000)).toEqual({ status: 'aborted', reason: expect.any(DOMException) });
      expect({ caught: run.caught, released: run.released(), resumed: run.resumed(), failures: run.failures }).toEqual({
        caught: [], // the halt discards gen's rejection: no catch sees it
        released: true,
        resumed: false,
        failures: [],
      });
      expect(run.warn).not.toHaveBeenCalled();
      await run.app.close();
    });

  it('observe: the body is not rejected; its call child is not delivered, runs its full duration, and gen’s Result is the outcome', async () => {
    const brief = task(function* () {
      yield* sleep(30);
      return success(21);
    });
    let after = false;
    const run = runGen('observe', async function* () {
      const v = yield* $(call(brief));
      after = true;
      return success(v * 2);
    });
    await tick();
    run.f.abort();
    expect(await within(run.app.result(run.f), 1000)).toEqual({ status: 'success', value: success(42) });
    expect([after, run.released()]).toEqual([true, true]);
    expect(run.caught).toEqual([]);
    expect(run.failures).toEqual([]);
    expect(run.warn).not.toHaveBeenCalled();
    await run.app.close();
  });

  // The "(6)" convention: a shape whose hazard is documented (DESIGN.md §4.4, §4.13), pinned. gen is plain async code:
  // its `$` runs the op through its `then` at once, so a stored gen's op runs before the body waits for it.
  it('(6) hazard (DESIGN.md §4.4): a stored gen(…) runs the op inside $ at once; a delivery while the body waits on something else halts the call’s child, so the stored gen rejects with FiberAbortedError, unhandled until the body’s yield* wait(p) handles it late, and the node completes aborted after the body, no catch run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lateHandled: Promise<unknown>[] = [];
    // A listener stands in for Node's PromiseRejectionHandledWarning, which it prints only when nothing listens.
    const onHandled = (p: Promise<unknown>): void => void lateHandled.push(p);
    process.on('rejectionHandled', onHandled);
    try {
      const app = createRootContext();
      const plain = deferred();
      let stored: Promise<unknown> | undefined;
      let released = false;
      let reached = false;
      let resumed = false;
      let caught: unknown = 'nothing caught';
      const f = app.fork(
        task(
          function* () {
            own(() => {
              released = true;
            });
            const p = gen(async function* () {
              const v = yield* $(call(slowResultTask)); // runs the call now, a child of this body's node
              reached = true;
              return success(v);
            });
            stored = p;
            yield* wait(plain.promise); // the body waits here, not on p
            resumed = true;
            try {
              return yield* wait(p);
            } catch (e) {
              caught = e;
              throw e;
            }
          },
          { onFailure: () => {} },
        ),
      );
      await tick();
      f.abort();
      await tick(3); // the call's child was delivered with the body and halted; $'s await rejected, and p with it
      const unhandled = unhandledRejectionGuard()!.seen.splice(0); // what the setup hook would fail this test with
      expect({ unhandled: unhandled.map((e) => (e as Error).name), state: f.state, released, resumed }).toEqual({
        unhandled: ['FiberAbortedError'],
        state: 'running', // row 3: the halt lets the wait on the plain promise finish
        released: false,
        resumed: false,
      });
      plain.resolve();
      expect(await within(app.result(f), 1000)).toEqual({ status: 'aborted', reason: expect.any(DOMException) });
      await tick();
      expect({ released, resumed, reached, caught, lateHandled: lateHandled.length, isStored: lateHandled[0] === stored }).toEqual({
        released: true,
        resumed: true, // resumed by the plain promise, then returned at the wait(p), its rejection discarded
        reached: false,
        caught: 'nothing caught',
        lateHandled: 1,
        isStored: true,
      });
      expect(warn).not.toHaveBeenCalled();
      await app.close();
    } finally {
      process.off('rejectionHandled', onHandled);
    }
  });

  // fromThrowing's promise form is an async function whose `await` calls an op's `then` a job after fromThrowing is
  // called, which runs the op (DESIGN.md §4.13, §4.14): stored, it has consumed the failure, where a stored op runs
  // nothing until it is consumed.
  it('(6) hazard (DESIGN.md §4.4): a stored fromThrowing(join(f)) consumes f’s failure at once, and an interruption elsewhere loses it; a stored join(f) keeps it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shapes = {
      'stored join(f), supported': (p: PromiseLike<never>): unknown => p,
      'stored fromThrowing(join(f))': (p: PromiseLike<never>): unknown => fromThrowing(p),
    };
    for (const [shape, store] of Object.entries(shapes)) {
      const err = new Error(`f failed (${shape})`);
      const app = createRootContext();
      const failures: unknown[] = [];
      const f = app.fork(
        task(
          function* () {
            const fb = fork(function* () {
              throw err;
            });
            const p = store(join(fb));
            yield* sleep(10_000); // rejected here at the abort, so the body never returns p
            return p;
          },
          { onFailure: (e) => void failures.push(e) },
        ),
      );
      await tick(); // fb has failed: held for the stored join, consumed into data by fromThrowing's await
      f.abort();
      const outcome = await within(app.result(f), 1000);
      if (shape === 'stored join(f), supported') {
        expect(outcome).toEqual({ status: 'failure', error: err }); // surfaced from the parent (I11)
        expect(failures).toEqual([err]);
      } else {
        expect(outcome).toEqual({ status: 'aborted', reason: expect.any(DOMException) });
        expect(failures).toEqual([]); // lost: the Result holding it is never read, and nothing reports it
      }
      await app.close();
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
