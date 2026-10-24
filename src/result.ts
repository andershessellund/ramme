// ---------------------------------------------------------------------------
// The `ramme/result` subpath (DESIGN.md §4.13, D38).
//
// A failure a caller is meant to branch on is a return value, a `Result`; a
// throw is a defect, translated at task boundaries (DESIGN.md §4.12). This
// module is free functions over plain `Result` objects: no class, no methods,
// no symbol-keyed members, so a hand-rolled `{ status, value | error }` object
// of the same shape works with every one of them (D38).
//
// `gen` and `$` are the `?` operator: `yield* $(r)` evaluates to the success
// value, or ends `gen`'s run with the failure as its result, as data, never as
// an exception. `gen` infers the error union from the yields.
//
// A leaf: it imports only types from context.ts, never the core at runtime
// (DESIGN.md §7). Every function over a `Result` takes the whole `Result` as
// one type parameter and reads the value and error types off it (`SuccessOf`,
// `ErrorOf`), as `gen` does. A `Result<T, E>` parameter would take one
// inference candidate for `E`, so it would refuse `Failure<A> | Failure<B> |
// Success<T>`, the inferred return type of an unannotated fallible function.
// A `Success`-only argument has error `never`, and a `Failure`-only one value
// `never`, never `unknown`, so one `yield* $(success(1))` does not widen a
// `gen`'s error union (D38).
//
// `SuccessOf`, `ErrorOf`, `Unwrap` and `Fenced` are deliberately unexported,
// and never tagged internal: the published signatures name them, so
// stripInternal must keep them in dist/result.d.ts. stripInternal drops a declaration whose
// leading comment holds the tag in any comment form, so this header must not
// spell it either: it leads the import below.
// ---------------------------------------------------------------------------

import type { Failure, Result, Success } from './context.js';

/** The value type of a `Result`'s success members; `never` for a `Failure`. */
type SuccessOf<R> = R extends Success<infer T> ? T : never;

/** The error type of a `Result`'s failure members; `never` for a `Success`. */
type ErrorOf<R> = R extends Failure<infer E> ? E : never;

/**
 * What `yield* $(x)` delegates to (DESIGN.md §4.13). Its iterator is typed as the global `AsyncIterator`, not
 * `AsyncIterable`, `AsyncIterableIterator` or `AsyncGenerator`: TypeScript types a `yield*` over those as
 * `Awaited<T>`, while the runtime evaluates to `T` itself (a promise or a fiber included).
 */
interface Unwrap<T, E> {
  [Symbol.asyncIterator](): AsyncIterator<Failure<E>, T, unknown>;
}

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

function noop(): void {}

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
 * intake's `PoolFullError` or `PoolClosedError`. Over ramme work use `attempt`, which keeps `aborted`: over a
 * `call` this reports another node's abort as `failure(FiberAbortedError)`, and the caller's own interruption as
 * `failure(InterruptedError)`, a swallow no lint sees (DESIGN.md §4.13). The promise forms await at once, when
 * `fromThrowing` is called: over a managed promise, await or return `fromThrowing(…)` at once (DESIGN.md §4.2).
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
 * The `await` calls `then` on `p` as soon as `fromThrowing` is called, in the caller's async context. Over a
 * managed promise that is the body's own direct await only when the caller awaits (or returns) `fromThrowing(…)`
 * at once (DESIGN.md §4.2). Stored, dropped or used as a combinator member, its managed await is armed although
 * the body is suspended elsewhere, and can consume a failure nothing reads. The `catch` takes every error, the
 * caller's own `InterruptedError` included, so this promise never rejects.
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
 * The `?` operator's step: inside a `gen` body, `yield* $(x)` evaluates to the success value of `x` (a `Result`
 * or a promise of one), or yields its failure, which ends the run with that failure as `gen`'s result
 * (DESIGN.md §4.13, D38).
 *
 * A hand-written async iterator, not an `async function*`, whose `return` would await the value: a thenable
 * success value would be unwrapped, and a fiber's `then` throws (DESIGN.md §4.5). Its first `next()` awaits `x`
 * once, always, so a promise is handled and a settled `Result` costs one microtask; over a managed promise that
 * is the body's own direct await, made in its async context (DESIGN.md §4.2), and over a bare promise it is a
 * bare await (DESIGN.md §4.4). Then it resolves `{ done: true, value }` for a success, without awaiting the
 * value, or `{ done: false, value: failure }` for a failure. A later `next()` never settles; `return()`
 * resolves `{ done: true, value: undefined }`.
 *
 * Typed by the argument as a whole, awaited: `$(charge(n))` over an unannotated function's
 * `Promise<Failure<A> | Failure<B> | Success<T>>`, and `$(c ? getUser(id) : getAdmin(id))` over a union of
 * promises, evaluate to the union of the values and yield the union of the errors.
 */
export function $<X extends Result<unknown, unknown> | Promise<Result<unknown, unknown>>>(
  x: X,
): Unwrap<SuccessOf<Awaited<X>>, ErrorOf<Awaited<X>>> {
  let started = false;
  const step: Unwrap<unknown, unknown> & AsyncIterator<Failure<unknown>, unknown, unknown> = {
    [Symbol.asyncIterator]: () => step, // itself
    next: (): Promise<IteratorResult<Failure<unknown>, unknown>> => {
      if (started) return new Promise(noop); // the run already ended on the failure this step yielded
      started = true;
      return unwrapStep(x);
    },
    return: async (): Promise<IteratorResult<Failure<unknown>, unknown>> => ({ done: true, value: undefined }),
  };
  return step as Unwrap<SuccessOf<Awaited<X>>, ErrorOf<Awaited<X>>>;
}

/** `$`'s first `next()`: one `await` of the source, then the success value as the delegation's return value, unawaited. */
async function unwrapStep(
  x: Result<unknown, unknown> | Promise<Result<unknown, unknown>>,
): Promise<IteratorResult<Failure<unknown>, unknown>> {
  const r = await x;
  return r.status === 'success' ? { done: true, value: r.value } : { done: false, value: r };
}

/**
 * Drive a `gen` body: `yield* $(…)` per fallible step, and a `Result` returned (DESIGN.md §4.13, D38). A yielded
 * failure ends the run and is the result; otherwise the body's return value is. The error type is the union of
 * the errors of the yielded and the returned failures.
 *
 * An async function, not a managed await: its promise rejects with whatever the body throws (a defect), so await
 * or return `gen(…)` at once. A dropped `gen(…)` whose body throws is an unhandled rejection, and a failure a
 * `call` inside `$` threw is consumed by that await, so the node does not surface it (DESIGN.md §4.13). The
 * caller's own `InterruptedError` propagates out of `$`, the generator and `gen` as a rejection, never as a
 * `Result` (D39), so a stored `gen(…)` rejects unhandled on interruption. On a yielded failure the generator is
 * left suspended, never resumed: `gen` does not call its `return()`, which would run the body's `finally`
 * blocks, which are not where a body's cleanup belongs (A7: what must hold after the body ends is an entry).
 * `gen(thisArg, body)` runs the body with `this` bound, for a generator in a method.
 */
export function gen<Y extends Failure<unknown>, R extends Result<unknown, unknown>>(
  body: () => AsyncGenerator<Y, R, unknown>,
): Promise<Result<SuccessOf<R>, ErrorOf<Y> | ErrorOf<R>>>;
export function gen<This, Y extends Failure<unknown>, R extends Result<unknown, unknown>>(
  thisArg: This,
  body: (this: This) => AsyncGenerator<Y, R, unknown>,
): Promise<Result<SuccessOf<R>, ErrorOf<Y> | ErrorOf<R>>>;
export async function gen(...args: unknown[]): Promise<Result<unknown, unknown>> {
  const [thisArg, body] = args.length >= 2 ? args : [undefined, args[0]];
  const it = (body as (this: unknown) => AsyncGenerator<Failure<unknown>, Result<unknown, unknown>, unknown>).call(thisArg);
  // Every yield is a failure, and the first ends the run; so does the return. The generator runs in the
  // caller's frame up to its first await: the managed await inside `$` is the caller's own (DESIGN.md §4.2).
  const step = await it.next();
  return step.value;
}
