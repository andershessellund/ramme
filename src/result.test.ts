// result.test.ts — `ramme/result`: `Result`, the interchange type of expected failures, as plain values, and `$`,
// which unwraps one inside a body (DESIGN.md §4.12, §4.13, D38, D42). The helpers are free functions over any object
// of the shape; `$` is a generator helper whose `yield*` evaluates to the success value itself, unawaited, or yields
// the failure's error as a `Fail`, which ends the body with that expected failure, as `yield* fail(e)` does. `gen`,
// the async `?` operator of D38, is retired: a body is the scope (D42). The type-level half is
// src/test/surface.check.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, fork, join, never, pool, sleep, wait } from './ambient.js';
import type { Failure, Result } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { PoolFullError } from './resource.js';
import {
  $,
  andThen,
  collect,
  failure,
  fromThrowing,
  isFailure,
  isSuccess,
  map,
  mapFailure,
  orElse,
  success,
  unwrap,
  unwrapOr,
} from './result.js';
import { deferred, tick, within } from './test/util.js';

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
  ['5', { id: '5' }], // a short id, so a task's returned failure is reachable; it has no orders
]);

async function getUser(id: string): Promise<Result<User, UserNotFound>> {
  const user = users.get(id);
  return user === undefined ? failure(new UserNotFound(id)) : success(user);
}

async function getOrder(user: User): Promise<Result<Order, OrderNotFound>> {
  return user.id === '42' ? success({ user, total: 7 }) : failure(new OrderNotFound(user.id));
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
    const app = createRootContext();
    const seen: number[] = [];
    const o = await within(
      app.attempt(function* () {
        seen.push(yield* $(s));
        yield* $(f);
        return 'unreached';
      }),
    );
    expect({ o, seen }).toEqual({ o: { status: 'failure', error: 'e' }, seen: [3] });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// `$` unwraps a `Result` you hold, inside a body (DESIGN.md §4.13, D42): the success value, or the failure's error
// yielded as a `Fail`, which ends the body with the expected failure, as `yield* fail(e)` does. `Result` is the
// interchange type: a function or a task returns one as data, a body's `$` turns it back into its `E`.
// ---------------------------------------------------------------------------

describe('$: a Result unwrapped in a body (DESIGN.md §4.13, D42)', () => {
  it('yield* $(r) evaluates to the success value, so a body unwraps the Results its fallible steps return', async () => {
    const app = createRootContext();
    const order = await within(
      app.call(function* () {
        const user = yield* $(yield* wait(getUser('42')));
        return yield* $(yield* wait(getOrder(user)));
      }),
    );
    expect(order).toEqual({ user: { id: '42' }, total: 7 });
    await app.close();
  });

  it('a failure ends the body at once with failure(error), the same object: nothing after it runs, no catch sees it, its finally runs; call re-yields it into the caller', async () => {
    const app = createRootContext();
    const log: string[] = [];
    const lookUp = task(function* (id: string) {
      try {
        const user = yield* $(yield* wait(getUser(id)));
        log.push('after $');
        return user;
      } catch {
        log.push('caught');
        return { id: 'caught' };
      } finally {
        log.push('finally');
      }
    });
    const direct = await within(app.attempt(lookUp, 'nobody'));
    const viaCall = await within(
      app.attempt(function* () {
        const user = yield* lookUp('nobody');
        log.push('caller after call');
        return user;
      }),
    );
    const known = failure(new OrderNotFound('x'));
    const same = await within(
      app.attempt(function* () {
        yield* $(known);
      }),
    );
    expect({
      direct: direct.status === 'failure' && direct.error instanceof UserNotFound,
      viaCall: viaCall.status === 'failure' && viaCall.error instanceof UserNotFound,
      same: same.status === 'failure' && same.error === known.error,
      log,
    }).toEqual({ direct: true, viaCall: true, same: true, log: ['finally', 'finally'] });
    await app.close(); // every attempt consumed its failure
  });

  it('Result is the interchange type: a task returns one as data, which is its success, and the caller’s $ turns it into the caller’s own failure', async () => {
    const app = createRootContext();
    const tooShort = failure('too short' as const);
    const inner = task(function* (id: string) {
      const user = yield* $(yield* wait(getUser(id)));
      if (user.id.length < 2) return tooShort; // returned as data: the task succeeds with a Result
      return success(user.id.length);
    });
    const outer = task(function* (id: string) {
      const n = yield* $(yield* inner(id));
      return n * 100;
    });
    const outcomes = await within(
      Promise.all([app.result(app.fork(inner.with({ onFailure: () => {} }), '5')), app.attempt(outer, '42'), app.attempt(outer, '5'), app.attempt(outer, '7')]),
    );
    expect({
      innerData: outcomes[0],
      ok: outcomes[1],
      short: outcomes[2],
      missing: outcomes[3].status === 'failure' && outcomes[3].error instanceof UserNotFound,
    }).toEqual({
      innerData: { status: 'success', value: tooShort },
      ok: { status: 'success', value: 200 },
      short: { status: 'failure', error: 'too short' },
      missing: true,
    });
    await app.close();
  });

  it('yield* $(success(p)) evaluates to the promise p itself, never awaited', async () => {
    const app = createRootContext();
    const p = deferred<number>().promise; // never settles: an awaited value would hang the body
    const got = await within(
      app.call(function* () {
        return { got: yield* $(success(p)) };
      }),
    );
    expect(got.got).toBe(p);
    await app.close();
  });

  it('yield* $(success(fiber)) evaluates to the fiber, whose then trap is never reached', async () => {
    const app = createRootContext();
    const got = await app.call(function* () {
      const fb = fork(function* () { return 7; });
      const f = yield* $(success(fb));
      expect(f).toBe(fb);
      return yield* join(f);
    });
    expect(got).toBe(7);
    await app.close();
  });

  it('$ is a generator helper: a success is its return value, a failure is yielded once as a Fail record under the registered brand, a resumed one throws, and anything that is no Result is a TypeError', () => {
    const err = new Error('e');
    const ok = $(success(1)).next();
    const it = $(failure(err));
    const yielded = it.next();
    const brand = Symbol.for('ramme.fail');
    let resumed: unknown;
    try {
      it.next();
    } catch (e) {
      resumed = e;
    }
    let notAResult: unknown;
    try {
      $(Promise.resolve(success(1)) as unknown as Result<number, never>).next();
    } catch (e) {
      notAResult = e;
    }
    expect({
      ok,
      done: yielded.done,
      carries: (yielded.value as unknown as Record<symbol, unknown>)[brand] === err,
      own: Object.getOwnPropertySymbols(yielded.value as object).includes(brand),
      resumed: resumed instanceof TypeError,
      notAResult: notAResult instanceof TypeError && /must be a Result/.test(notAResult.message),
    }).toEqual({ ok: { done: true, value: 1 }, done: false, carries: true, own: true, resumed: true, notAResult: true });
  });

  it('a throw beside $ is a defect, not a failure, and so is a rejection the body waited for', async () => {
    const app = createRootContext();
    const bug = new TypeError('a bug');
    const rejecting = new Error('rejected source');
    const thrown = await within(
      app.attempt(function* () {
        yield* $(success(1));
        throw bug;
      }),
    );
    const rejected = await within(
      app.attempt(function* () {
        return yield* $(yield* wait(Promise.reject<Result<number, never>>(rejecting)));
      }),
    );
    expect({ thrown, rejected }).toEqual({ thrown: { status: 'defect', error: bug }, rejected: { status: 'defect', error: rejecting } });
    await app.close();
  });

  it('a generator method helper keeps its this, and its $ ends the body that yield*s it', async () => {
    class Repo {
      readonly #prefix = '4';
      readonly name = 'repo';
      *load(rest: string) {
        const user = yield* $(yield* wait(getUser(this.#prefix + rest)));
        return `${this.name}:${user.id}`;
      }
    }
    const app = createRootContext();
    const repo = new Repo();
    const found = await within(app.call(function* () { return yield* repo.load('2'); }));
    const missing = await within(app.attempt(function* () { return yield* repo.load('3'); }));
    expect({ found, missing: missing.status === 'failure' && missing.error instanceof UserNotFound }).toEqual({ found: 'repo:42', missing: true });
    await app.close();
  });

  it('a $ failure in a halted finally is a release failure: the body stays aborted by state and its outcome is amended to defect(error)', async () => {
    const app = createRootContext();
    const err = new OrderNotFound('in the halted finally');
    const log: string[] = [];
    const f = app.fork(
      task(
        function* () {
          try {
            yield* never();
          } finally {
            log.push('finally');
            yield* $(failure(err));
            log.push('after $');
          }
        },
        { onFailure: () => {} },
      ),
    );
    await tick();
    f.abort('stop');
    const o = await within(app.result(f));
    expect({ o, log }).toEqual({ o: { status: 'defect', error: err }, log: ['finally'] });
    await app.close();
  });
});

describe('fromThrowing over ramme work (DESIGN.md §4.13, §4.2)', () => {
  it('over an op, an expected failure and a defect are alike a failure of the Result: the op’s then rejects with the error (D42)', async () => {
    const app = createRootContext();
    const expected = new UserNotFound('7');
    const bug = new TypeError('a bug');
    const failed = await fromThrowing(app.call(function* () {
      yield* sleep(0);
      yield* fail(expected);
    }));
    const threw = await fromThrowing(app.call(function* () {
      yield* sleep(0);
      throw bug;
    }));
    expect({ failed, threw }).toEqual({ failed: failure(expected), threw: failure(bug) });
    await app.close(); // each then consumed its failure
  });

  // fromThrowing's promise form is an async function whose `await` calls an op's `then` a job after fromThrowing is
  // called, which runs the op (DESIGN.md §4.13, §4.2): stored, it has consumed the failure, where a stored op runs
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
        expect(outcome).toEqual({ status: 'defect', error: err }); // surfaced from the parent (I11): a defect (D42)
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
