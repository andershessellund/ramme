// result.test.ts — `ramme/result`: expected failures as plain `Result` values, and `gen`/`$`, the `?`
// operator (DESIGN.md §4.12, §4.13, D38). The helpers are free functions over any object of the shape; `$`
// is a hand-written async iterator whose `yield*` evaluates to the success value itself, unawaited, or
// yields the failure, which ends `gen`'s run as its result. `gen` is an async function, not a managed await:
// inside a body, the await in `$` is the body's own direct await, so an interruption rejects it as it rejects
// `await call(t)`, and the `InterruptedError` propagates out of `$`, the generator and `gen` (DESIGN.md §4.2,
// D39). The type-level half is src/test/surface.check.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import './node.js';
import { call, fork, join, own, pool, sleep } from './ambient.js';
import type { Context, Failure, Fiber, Result } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { InterruptedError, PoolFullError } from './resource.js';
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
    const got = await app.call(async () => {
      const r = fromThrowing(() => fork(async () => 3)); // a fiber's `then` getter throws (DESIGN.md §4.5)
      expect(r.status).toBe('success');
      if (r.status === 'failure') throw r.error;
      return join(r.value);
    });
    expect(got).toBe(3);
    await app.close();
  });

  it('fromThrowing fences pool intake: an admitted fork is its fiber as a success, a refused one PoolFullError as a failure', async () => {
    const app = createRootContext();
    let ran = 0;
    const job = task(async () => {
      ran++;
      return 'ran';
    });
    const got = await app.call(async () => {
      const p = pool({ name: 'p', concurrency: 1, whenFull: 'reject', onFailure: () => {} });
      const admitted = fromThrowing(() => p.fork(job)); // admitted: it holds the one slot until it completes
      const refused = fromThrowing(() => p.fork(job));
      expect(refused.status === 'failure' && refused.error).toBeInstanceOf(PoolFullError);
      if (admitted.status === 'failure') throw admitted.error;
      return join(admitted.value);
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
    const got = await app.call(async () => {
      const fb = fork(async () => 7);
      const r = await gen(async function* () {
        const f = yield* $(success(fb));
        return success({ f });
      });
      expect(r.status === 'success' && r.value.f).toBe(fb);
      return join(fb);
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
    const t = task(async (): Promise<Result<number, never>> => {
      throw err;
    });
    const app = createRootContext();
    const failures: unknown[] = [];
    const gate = deferred();
    const f = app.fork(
      task(
        async () => {
          void gen(async function* () {
            const v = yield* $(call(t));
            return success(v);
          });
          await gate.promise; // bare: the dropped gen is reported meanwhile
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
// The interplay with interruption (DESIGN.md §4.2, D39): in a body, `yield* $(call(t))` awaits a managed
// promise inside `$`'s `next()` while the body is suspended on `await gen(…)`. The generator runs in the body's
// frame, so the managed promise is armed for the body's node and rejected after its delivery (once the call's
// child has completed), as `await call(t)` is; the rejection propagates out of `$`'s `next()`, through
// `yield*`, out of the generator and out of `gen`, which never turns it into a `Result`.
// ---------------------------------------------------------------------------

/** Waits on a managed await, so a delivery rejects it and its caller's release does not wait on a bare promise. */
const slowResultTask = task(
  async (): Promise<Result<number, OrderNotFound>> => {
    await sleep(10_000);
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
      async () => {
        own(() => {
          released = true;
        });
        try {
          const r = await gen(() => body(mark));
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

/**
 * The rejection assertions (DESIGN.md §4.2, D39): nothing settles inside abort(); `gen` rejects with the body's
 * `InterruptedError`, never a `Result`; `aborted`, released, never resumed past the rejected step, no warning.
 */
async function expectRejectedByAbort(run: Run): Promise<void> {
  const { app, f } = run;
  await tick(); // the body is suspended inside `$`, its managed await in flight
  f.abort();
  expect(f.state).toBe('running'); // the body unwinds first; its call child completes a few microtasks later
  expect(await within(app.result(f), 1000)).toEqual({ status: 'aborted', reason: expect.any(DOMException) });
  expect(run.caught).toHaveLength(1);
  expect(run.caught[0]).toBeInstanceOf(InterruptedError);
  expect(run.released()).toBe(true);
  expect(run.resumed()).toBe(false);
  expect(run.failures).toEqual([]);
  expect(run.warn).not.toHaveBeenCalled();
  await app.close();
}

describe('gen and $ under interruption (DESIGN.md §4.2, D39)', () => {
  for (const mode of ['freeze', 'restore'] as const)
    it(`${mode}: a body awaiting gen over an in-flight $(call(t)) is rejected after its abort: the InterruptedError propagates out of $, the generator and gen`, async () => {
      await expectRejectedByAbort(
        runGen(mode, async function* (resumed) {
          const v = yield* $(call(slowResultTask));
          resumed();
          return success(v);
        }),
      );
    });

  it('settled Result: yield* $(success(1)) costs a microtask, and the next $(call(t)) is rejected as above', async () => {
    await expectRejectedByAbort(
      runGen('freeze', async function* (resumed) {
        const one = yield* $(success(1));
        const v = yield* $(call(slowResultTask));
        resumed();
        return success(one + v);
      }),
    );
  });

  it('observe: the body is not rejected; its call child is not delivered, runs its full duration, and gen’s Result is the outcome', async () => {
    const brief = task(async (): Promise<Result<number, never>> => {
      await sleep(30);
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

  it('plain promise: $ over an in-flight plain promise is a bare await and is not rejected; the next $(call(t)), made after the delivery, is, once its child has completed', async () => {
    const plain = deferred<Result<number, never>>();
    let afterPlain = false;
    const run = runGen('freeze', async function* (resumed) {
      const v = yield* $(plain.promise);
      afterPlain = true; // plain code after delivery (I8)
      const w = yield* $(call(slowResultTask)); // applied: the child is born delivered, and the call rejects (DESIGN.md §4.2)
      resumed();
      return success(v + w);
    });
    await tick();
    run.f.abort();
    expect(run.f.state).toBe('running');
    plain.resolve(success(1));
    expect(await within(run.app.result(run.f), 1000)).toEqual({ status: 'aborted', reason: expect.any(DOMException) });
    expect([afterPlain, run.released()]).toEqual([true, true]);
    expect(run.caught[0]).toBeInstanceOf(InterruptedError);
    expect(run.resumed()).toBe(false);
    expect(run.failures).toEqual([]);
    expect(run.warn).not.toHaveBeenCalled();
    await run.app.close();
  });

  // The "(6)" convention of managed.test.ts: a shape whose hazard is documented (DESIGN.md §4.4), pinned.
  it('(6) hazard (DESIGN.md §4.4): a stored gen(…) arms the managed await inside $ at once; a delivery during a bare await rejects it, so the stored gen rejects unhandled until the body awaits it, and the node completes after the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createRootContext();
    const bare = deferred();
    let released = false;
    let reached = false;
    let resumed = false;
    let ownError: unknown;
    let caught: unknown;
    const f = app.fork(
      task(
        async () => {
          own(() => {
            released = true;
          });
          const p = gen(async function* () {
            const v = yield* $(call(slowResultTask));
            reached = true;
            return success(v);
          });
          await bare.promise; // bare: the body is suspended here, not on p
          resumed = true;
          try {
            own(() => {}); // the node waits for the body: still open
          } catch (e) {
            ownError = e;
          }
          try {
            return await p;
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
    await tick(3); // the call's child has completed, $'s await rejected, and p with it
    const guard = unhandledRejectionGuard()!;
    const unhandled = guard.seen.splice(0); // what the setup hook would fail this test with (I10 covers ramme's own promises only)
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0]).toBeInstanceOf(InterruptedError);
    expect([f.state, released, resumed]).toEqual(['running', false, false]);
    bare.resolve();
    expect(await within(app.result(f), 1000)).toEqual({ status: 'aborted', reason: expect.any(DOMException) });
    expect([released, resumed, reached]).toEqual([true, true, false]);
    expect(ownError).toBeUndefined();
    expect(caught).toBe(unhandled[0]);
    expect(warn).not.toHaveBeenCalled();
    await app.close();
  });

  // fromThrowing's promise form is an async function whose `await` calls `then` on a managed promise as soon as
  // fromThrowing is called (DESIGN.md §4.2, §4.13): stored, it is the stored gen's shape, not the stored managed
  // promise's, which arms nothing until it is awaited.
  it('(6) hazard (DESIGN.md §4.4): a stored fromThrowing(join(f)) consumes f’s failure at once, and an interruption elsewhere loses it; a stored join(f) keeps it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shapes = {
      'stored join(f), supported': (p: Promise<never>): unknown => p,
      'stored fromThrowing(join(f))': (p: Promise<never>): unknown => fromThrowing(p),
    };
    for (const [shape, store] of Object.entries(shapes)) {
      const err = new Error(`f failed (${shape})`);
      const app = createRootContext();
      const failures: unknown[] = [];
      const f = app.fork(
        task(
          async () => {
            const fb = fork(async (): Promise<never> => {
              throw err;
            });
            const p = store(join(fb));
            await sleep(10_000); // rejected here at the abort, so the body never returns p
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

  it('(6) hazard (DESIGN.md §4.13): a stored fromThrowing(join(f)) arms the managed await at once; a delivery during a bare await turns the body’s own interruption into failure(InterruptedError), a swallow no lint sees, and the node completes after the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createRootContext();
    const bare = deferred();
    let released = false;
    let resumed = false;
    let ownError: unknown;
    let seen: Result<unknown, unknown> | undefined;
    const f = app.fork(
      task(
        async () => {
          own(() => {
            released = true;
          });
          const p = fromThrowing(join(fork(slowResultTask)));
          await bare.promise; // bare: the body is suspended here, not on p
          resumed = true;
          try {
            own(() => {}); // the node waits for the body: still open
          } catch (e) {
            ownError = e;
          }
          seen = await p; // never rejects (I10 holds for fromThrowing's promise)
          return seen;
        },
        { onFailure: () => {} },
      ),
    );
    await tick();
    f.abort();
    expect(f.state).toBe('running');
    bare.resolve();
    expect(await within(app.result(f), 1000)).toEqual({ status: 'aborted', reason: expect.any(DOMException) }); // by state (D24)
    expect([released, resumed]).toEqual([true, true]);
    expect(ownError).toBeUndefined();
    expect(seen?.status).toBe('failure');
    expect((seen as Failure<unknown>).error).toBeInstanceOf(InterruptedError);
    expect(warn).not.toHaveBeenCalled();
    await app.close();
  });
});
