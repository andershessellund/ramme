// ---------------------------------------------------------------------------
// The `ramme/result` subpath (DESIGN.md §4.13, D38, D42).
//
// `Result` is the interchange type of expected failures: plain data a function
// returns, a library hands over, or JSON carries. Inside a body an expected
// failure is yielded instead (`yield* fail(e)`, D42), and `$` is the bridge
// between the two: `yield* $(r)` is a `Result`'s success value, or ends the
// body with its failure, which joins the task's `E`. This module is free
// functions over plain `Result` objects: no class, no methods, no symbol-keyed
// members, so a hand-rolled `{ status, value | error }` object of the same
// shape works with every one of them (D38).
//
// A leaf: it imports only types from context.ts, never the core at runtime
// (DESIGN.md §7), so `$` makes the `Fail` record itself, under the registered
// symbol the driver tests (managed.ts `FAIL`). Every function over a `Result`
// takes the whole `Result` as one type parameter and reads the value and error
// types off it (`SuccessOf`, `ErrorOf`). A `Result<T, E>` parameter would take
// one inference candidate for `E`, so it would refuse `Failure<A> | Failure<B>
// | Success<T>`, the inferred return type of an unannotated fallible function.
// A `Success`-only argument has error `never`, and a `Failure`-only one value
// `never`, never `unknown`, so one `yield* $(success(1))` does not widen a
// body's error union (D38).
//
// `SuccessOf`, `ErrorOf`, `Fails` and `Fenced` are deliberately unexported,
// and never tagged internal: the published signatures name them, so
// stripInternal must keep them in dist/result.d.ts. stripInternal drops a declaration whose
// leading comment holds the tag in any comment form, so this header must not
// spell it either: it leads the import below.
// ---------------------------------------------------------------------------

import type { Fail, Failure, Result, Success } from './context.js';

/** The value type of a `Result`'s success members; `never` for a `Failure`. */
type SuccessOf<R> = R extends Success<infer T> ? T : never;

/** The error type of a `Result`'s failure members; `never` for a `Success`. */
type ErrorOf<R> = R extends Failure<infer E> ? E : never;

/** `Fail<e>` for each error `e` (D42); `never` for none, so `$` over a `Success` yields nothing a body's `E` reads. */
type Fails<E> = E extends unknown ? Fail<E> : never;

/**
 * The run-time brand of a yielded `Fail` (D42): the registered symbol the core's driver tests, made here, since this
 * module imports nothing at run time (DESIGN.md §7).
 */
const FAIL: unique symbol = Symbol.for('ramme.fail');

/**
 * What `fromThrowing(f)` gives for a function whose return type is `T` and not a promise type (D38): the
 * `Result`, or, when `T` has a thenable member (`number | Promise<number>`), the `Result` or a promise of it, as
 * the runtime chains a returned thenable. `any` stays synchronous (`() => JSON.parse(s)`); so does `unknown`, which
 * says nothing about a thenable.
 */
type Fenced<T> = 0 extends 1 & T
  ? Result<T, unknown>
  : [Extract<T, PromiseLike<unknown>>] extends [never]
    ? Result<T, unknown>
    : Result<Exclude<T, PromiseLike<unknown>>, unknown> | Promise<Result<Awaited<Extract<T, PromiseLike<unknown>>>, unknown>>;

/**
 * `x != null && typeof x.then === 'function'`. A `then` that cannot be read is not a thenable: a fiber's getter
 * throws (DESIGN.md §4.5), and a returned fiber is a value, as the core never probes one either.
 */
function isThenable(x: unknown): x is PromiseLike<unknown> {
  if (x == null) return false;
  try {
    return typeof (x as { then?: unknown }).then === 'function';
  } catch {
    return false;
  }
}

/** A plain, unfrozen `{ status: 'success', value }`. */
export function success<T>(value: T): Success<T> {
  return { status: 'success', value };
}

/** A plain, unfrozen `{ status: 'failure', error }`. */
export function failure<E>(error: E): Failure<E> {
  return { status: 'failure', error };
}

/** `r.status === 'success'`, as a type guard. */
export function isSuccess<R extends Result<unknown, unknown>>(r: R): r is Extract<R, Success<unknown>> {
  return r.status === 'success';
}

/** `r.status === 'failure'`, as a type guard. */
export function isFailure<R extends Result<unknown, unknown>>(r: R): r is Extract<R, Failure<unknown>> {
  return r.status === 'failure';
}

/** `f` over the value of a success; a failure is returned as it is. */
export function map<R extends Result<unknown, unknown>, U>(r: R, f: (v: SuccessOf<R>) => U): Result<U, ErrorOf<R>> {
  const x: Result<unknown, unknown> = r;
  return x.status === 'success' ? success(f(x.value as SuccessOf<R>)) : (x as Failure<ErrorOf<R>>);
}

/** `f` over the error of a failure; a success is returned as it is. */
export function mapFailure<R extends Result<unknown, unknown>, F>(r: R, f: (e: ErrorOf<R>) => F): Result<SuccessOf<R>, F> {
  const x: Result<unknown, unknown> = r;
  return x.status === 'success' ? (x as Success<SuccessOf<R>>) : failure(f(x.error as ErrorOf<R>));
}

/** The next fallible step: `f`'s result for a success; a failure is returned as it is. */
export function andThen<R extends Result<unknown, unknown>, S extends Result<unknown, unknown>>(
  r: R,
  f: (v: SuccessOf<R>) => S,
): Result<SuccessOf<S>, ErrorOf<R> | ErrorOf<S>> {
  const x: Result<unknown, unknown> = r;
  return x.status === 'success'
    ? (f(x.value as SuccessOf<R>) as Result<SuccessOf<S>, ErrorOf<S>>)
    : (x as Failure<ErrorOf<R>>);
}

/** The recovery: `f`'s result for a failure; a success is returned as it is. */
export function orElse<R extends Result<unknown, unknown>, S extends Result<unknown, unknown>>(
  r: R,
  f: (e: ErrorOf<R>) => S,
): Result<SuccessOf<R> | SuccessOf<S>, ErrorOf<S>> {
  const x: Result<unknown, unknown> = r;
  return x.status === 'success'
    ? (x as Success<SuccessOf<R>>)
    : (f(x.error as ErrorOf<R>) as Result<SuccessOf<S>, ErrorOf<S>>);
}

/**
 * The value of a success, or the error of a failure **thrown**: the named moment an expected failure becomes a
 * defect (Rust's `.unwrap()`; DESIGN.md §4.12).
 */
export function unwrap<R extends Result<unknown, unknown>>(r: R): SuccessOf<R> {
  const x: Result<unknown, unknown> = r;
  if (x.status === 'success') return x.value as SuccessOf<R>;
  throw x.error;
}

/** The value of a success, or `fallback`. */
export function unwrapOr<R extends Result<unknown, unknown>, U>(r: R, fallback: U): SuccessOf<R> | U {
  const x: Result<unknown, unknown> = r;
  return x.status === 'success' ? (x.value as SuccessOf<R>) : fallback;
}

/**
 * Fence foreign code that throws: `f()`'s value as a success, or what it threw as a failure. The error type is
 * `unknown`, because a throw has no type. A function that returns a promise (an `async` function) or the
 * promise itself gives a promise of the `Result`, which never rejects; a function whose return type may or may
 * not be a promise gives either, as its value turns out (`Fenced`). A returned fiber is a value: its `then` getter
 * throws (DESIGN.md §4.5), so it is not chained, and `fromThrowing(() => pool.fork(job))` is the fiber, or the
 * intake's `PoolFullError` or `PoolClosedError`. Over ramme work use `attempt`, which keeps the four statuses: over
 * an op this runs it through its `then` (DESIGN.md §4.14), a promise awaiter that nothing halts, and reports its
 * child's expected failure, its defect and its abort alike, as `failure(error)` (`FiberAbortedError` for the abort;
 * DESIGN.md §4.13). The promise forms await at once, when `fromThrowing` is called.
 */
export function fromThrowing<T>(f: () => PromiseLike<T>): Promise<Result<Awaited<T>, unknown>>;
export function fromThrowing<T>(f: () => T): Fenced<T>;
export function fromThrowing<T>(p: PromiseLike<T>): Promise<Result<Awaited<T>, unknown>>;
export function fromThrowing(x: unknown): Result<unknown, unknown> | Promise<Result<unknown, unknown>> {
  if (typeof x !== 'function') return settled(x as PromiseLike<unknown>);
  let v: unknown;
  try {
    v = x();
  } catch (e) {
    return failure(e);
  }
  return isThenable(v) ? settled(v) : success(v); // f returned: a `then` that cannot be read is no thenable
}

/**
 * The promise form of `fromThrowing`: a direct `await` in an async function, never `p.then(success, failure)`.
 * The `await` calls `then` on `p` a job after `fromThrowing` is called; over an op that runs it (DESIGN.md §4.14).
 * The `catch` takes every error, so this promise never rejects.
 */
async function settled<T>(p: PromiseLike<T>): Promise<Result<Awaited<T>, unknown>> {
  try {
    return success(await p);
  } catch (e) {
    return failure(e);
  }
}

/** The first failure, or every value in order. */
export function collect<R extends Result<unknown, unknown>>(rs: readonly R[]): Result<SuccessOf<R>[], ErrorOf<R>> {
  const values: SuccessOf<R>[] = [];
  for (const r of rs as readonly Result<unknown, unknown>[]) {
    if (r.status !== 'success') return r as Failure<ErrorOf<R>>;
    values.push(r.value as SuccessOf<R>);
  }
  return success(values);
}

/**
 * Unwrap a `Result` you hold, inside a body (DESIGN.md §4.13, D42): `yield* $(r)` evaluates to the success value, or
 * yields `r`'s error as a `Fail`, which ends the body at once with the expected failure `failure(r.error)`, as
 * `yield* fail(r.error)` does: no `catch` sees it, and its `finally` blocks run. So a `Result` that a function returned
 * or a library handed over joins the body's task's `E`.
 *
 * A generator helper: the success value is returned as it is, never awaited (a promise or a fiber included). It takes
 * a `Result`, not a promise of one: wait for that first, `yield* $(yield* wait(p))`; anything that is no `Result` is a
 * `TypeError` at the `yield*`. Typed by the argument as a whole: `$(charge(n))` over an unannotated function's
 * `Failure<A> | Failure<B> | Success<T>` evaluates to `T` and adds both errors to the body's union, and a `Success`
 * adds none.
 */
export function* $<R extends Result<unknown, unknown>>(r: R): Generator<Fails<ErrorOf<R>>, SuccessOf<R>, unknown> {
  const x = r as Result<unknown, unknown> | null | undefined;
  if (typeof x !== 'object' || x === null || (x.status !== 'success' && x.status !== 'failure'))
    throw new TypeError(
      '$(r): r must be a Result ({ status: "success", value } or { status: "failure", error }); ' +
        'wait for a promise of one first: yield* $(yield* wait(p))',
    );
  if (x.status === 'success') return x.value as SuccessOf<R>;
  yield { [FAIL]: x.error } as unknown as Fails<ErrorOf<R>>; // the driver ends the body here, and never resumes it
  throw new TypeError('ramme/result: $ was resumed after its failure ended the body');
}
