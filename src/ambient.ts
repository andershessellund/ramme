// ---------------------------------------------------------------------------
// The ambient surface (DESIGN.md §6, law 2, I21).
//
// Each free function is `current().<method>(...)`: it acts on the current
// node, read from the synchronous slot (law 3; D41 decision 18). The current
// node is a body's own fiber while it steps, the release fiber during a
// release, the node `ctx.run(fn)` entered, or, in a creation frame, the
// value's node, created on demand (DESIGN.md §3.3). Nothing carries it across
// an `await`.
//
// Two groups differ in a creation frame:
//
// - `own`, `release`, `releaseAll`, `fork`, `pool`, `child`, `current` and
//   `signal` materialise the value's (pending or live) node and act on it.
// - The body-shaped ones, `lookup`, `call`, `attempt`, `all`, `race`,
//   `settle`, `shield`, `unshield`, `join`, `result`, `interrupted`, `never`,
//   `sleep`, `wait` and `runSync`, throw `CreationViolationError` first,
//   before touching any node (DESIGN.md §3.2, §3.5, I16): a refused call never
//   creates the value's node. `promised` is in the first group: it runs
//   nothing when it is made.
//
// Outside any node every one of them throws `NoCurrentNodeError`, whose
// message names the cause (no async context) and the three entry points.
//
// Every waiting verb returns an `Op` (DESIGN.md §4.14): `yield*` it in a body.
// A work op reads the slot when it is made (decision 17), so its receiver and
// guards are fixed then, and runs only when it is consumed (decision 2). In a
// halted generator body's `finally` the synchronous verbs still address the
// body's node (U3), while the ops it runs there run on its unwind fiber.
//
// `fail(e)` is the one verb that reads no node: it only makes the `Fail` a body
// yields to end with an expected failure (D42), so it may be made anywhere.
// ---------------------------------------------------------------------------

import type { InjectionKey } from './context-key.js';
import type {
  AllResult,
  Context,
  Fiber,
  LookupOptions,
  NodeOptions,
  Op,
  Operation,
  Outcome,
  Pool,
  PoolOptions,
  Release,
  SettleResult,
  Task,
} from './context.js';
import { currentCreation, currentFrame } from './context-storage.js';
import type { AnyTask, BodyOf, ErrorOf, FailedWith, ValueOf, Yields } from './internal-context.js';
import { failOp } from './managed.js';
import type { NodeImpl } from './node-impl.js';
import { CreationViolationError, NoCurrentNodeError } from './resource.js';

/**
 * @internal The current node for a free function: a body frame's node, or the value node of a creation
 * frame, materialised on first use (DESIGN.md §3.3). Throws `NoCurrentNodeError` outside any node, naming the
 * cause and the three entry points of plain async code (DESIGN.md §6; D41 §4).
 */
export function requireCurrent(op: string): NodeImpl {
  const f = currentFrame();
  if (f === undefined)
    throw new NoCurrentNodeError(
      `${op}() called with no current node. ramme has no async context: the current node is set only while a body ` +
        'steps (and in what it calls synchronously), in a release, a factory, a failure handler, or node.run(fn), so ' +
        'plain async code (an async function, an async release or handler) has none after its first await. Reach ramme ' +
        'from there through an explicit receiver (await app.call(t), or node.fork(t) on a node taken before the first ' +
        'await), promised(function* …) for a library’s async callback, or node.run(fn) for a synchronous callback',
    );
  return f.node ?? f.creation!.node();
}

/** The body-shaped free functions refuse a creation frame before touching any node (I16, DESIGN.md §3.2, §3.5). */
function requireBodyShaped(op: string): NodeImpl {
  if (currentCreation() !== undefined)
    throw new CreationViolationError(op === 'lookup' ? 'lookup() during creation; use inject()' : `${op}() during creation`);
  return requireCurrent(op);
}

// --- identity -----------------------------------------------------------------

/**
 * The current node: the running body's fiber, the release fiber during a
 * release, or the value's node during creation (created on first use).
 *
 * @throws NoCurrentNodeError outside any node.
 */
export function current(): Context {
  return requireCurrent('current');
}

/** `current().signal`: pass it on to anything that takes an `AbortSignal`. In a release it is the deadline. */
export function signal(): AbortSignal {
  return requireCurrent('signal').signal;
}

// --- resolution -----------------------------------------------------------------

/**
 * Resolve a borrow for the current node: `current().get(key, options)`. The
 * result must not be stored on anything that outlives the current node.
 *
 * @throws CreationViolationError during creation; use `inject()` there (DESIGN.md §3.2).
 */
export function lookup<T>(key: InjectionKey<T>): T;
export function lookup<T>(key: InjectionKey<T>, options: LookupOptions & { optional?: false | undefined }): T;
export function lookup<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;
export function lookup<T>(key: InjectionKey<T>, options?: LookupOptions): T | undefined {
  return requireBodyShaped('lookup').get(key, options as LookupOptions);
}

// --- attachment: the current node's explicit stack (DESIGN.md §2.6) ---------------------

/**
 * Attach to the current node; it is released when the node completes, or
 * earlier with `release(x)`. Returns what it attached. `own(x)` with one
 * argument on an object the node already owns returns it (D16).
 */
export function own<T extends Disposable | AsyncDisposable>(resource: T): T;
export function own<T extends object>(value: T, release: Release<T>): T;
export function own<T extends object>(defer: T & (() => void | Promise<void> | Operation<void, unknown>)): T;
export function own(target: object, release?: Release<any>): object {
  const n = requireCurrent('own');
  return release === undefined ? n.own(target as Disposable) : n.own(target, release);
}

/** Release `value`, which the current node owns, now and exactly once (C7). Eager: the release starts now, and the op waits for it. */
export function release(value: object): Op<void> & Promise<void> {
  return requireCurrent('release').release(value);
}

/** Release everything on the current node's explicit stack, top down. Eager: the releases start now, and the op waits for them. */
export function releaseAll(): Op<void> & Promise<void> {
  return requireCurrent('releaseAll').releaseAll();
}

// --- running bodies in a child of the current node (DESIGN.md §4.5) -----------------

/** Run `t` concurrently in a new child of the current node; the body starts in a microtask (I20). */
export function fork<T, A extends unknown[], Y extends Yields = never, E = never>(
  t: Task<A, T, E> | BodyOf<T, A, Y>,
  ...args: A
): Fiber<T, FailedWith<Y> | E> {
  return requireCurrent('fork').fork(t, ...args);
}

/**
 * Run `t` in a new child of the current node and wait for it: `yield* call(t, …)` is its value, or re-yields its
 * expected failure into this body, which ends with it (D42); its defect is thrown at the `yield*`. Lazy: the child is
 * made, and its body starts synchronously, when the op is yielded (D22); an op nobody yields runs nothing
 * (DESIGN.md §4.14).
 */
export function call<T, A extends unknown[], Y extends Yields = never, E = never>(
  t: Task<A, T, E> | BodyOf<T, A, Y>,
  ...args: A
): Op<T, FailedWith<Y> | E> {
  return requireBodyShaped('call').call(t, ...args);
}

/**
 * `call`, resolving with the child's four-way outcome (D42): `success`, `failure` (its `fail`), `defect` (its throw)
 * or `aborted`; a failure or a defect is delivered as a value and consumed, never thrown. A `freeze` or `restore` caller that is itself interrupted is halted here, as on `call`, once the child
 * has completed, and sees no outcome, so `aborted` is the child's own abort (its `timeoutMs`, its `signal`, an
 * explicit abort). A `restore` child is the exception: it also hears an `observe` caller's interruption, and an
 * `observe` ancestor's that a `freeze` caller below it does not, and reports either as `aborted`. The `observe`
 * caller sees its own in `signal().aborted`; the `freeze` caller's signal has not fired, so a deadline fallback
 * there tests the reason, the `TimeoutError` `DOMException` that `timeoutMs` delivers (DESIGN.md §4.5).
 */
export function attempt<T, A extends unknown[], Y extends Yields = never, E = never>(
  t: Task<A, T, E> | BodyOf<T, A, Y>,
  ...args: A
): Op<Outcome<T, FailedWith<Y> | E>> {
  return requireBodyShaped('attempt').attempt(t, ...args);
}

/**
 * Run the tasks as subscribers of a fresh child and await every one (D28): the tuple of their values; with one
 * member failed, and that by an expected failure, its failure re-yielded, so `E` is the union of the members' (D42);
 * with a defect, or two failures or more, an `AggregateError` of every real failure in task order (DESIGN.md §4.8).
 * `const T` keeps an array literal a tuple.
 */
export function all<const T extends readonly AnyTask[]>(tasks: T, opts?: NodeOptions): Op<AllResult<T>, ErrorOf<T[number]>> {
  return requireBodyShaped('all').all(tasks, opts);
}

/**
 * The first success among the tasks; the rest are aborted and awaited (DESIGN.md §4.8). With no success, `all`'s rule:
 * a lone expected failure re-yielded (D42), else the `AggregateError` of every failure, else `FiberAbortedError`.
 */
export function race<const T extends readonly AnyTask[]>(tasks: T, opts?: NodeOptions): Op<ValueOf<T[number]>, ErrorOf<T[number]>> {
  return requireBodyShaped('race').race(tasks, opts);
}

/**
 * `all` that resolves with every four-way outcome instead of rejecting: run the tasks as subscribers of a fresh
 * child, wait for every one (as `all` does; neither aborts a sibling), and resolve with the tuple of their outcomes
 * in order. Failures, defects and aborts are values; it never rejects on a member's account (DESIGN.md §4.8). `const T`
 * keeps an array literal a tuple.
 */
export function settle<const T extends readonly AnyTask[]>(tasks: T, opts?: NodeOptions): Op<SettleResult<T>> {
  return requireBodyShaped('settle').settle(tasks, opts);
}

/**
 * A non-cancellable region (D39, D41 decision 13, DESIGN.md §4.14): run `t` in a release fiber of the current node
 * and wait for it. Its `signal()` is the release deadline (`releaseTimeoutMs`), `own` attaches to it and `lookup`
 * resolves through the current node, and a halt lets it finish (release work): the body is returned at its next
 * `yield*` after it (`yield* shield(function* () { yield* call(charge); yield* call(record); })`). Cleanup after a
 * halt belongs in the body's own `finally`, which may wait. The current node completes after every shield it ran; a
 * shield's failure is the waiter's, or surfaces from the current node (I11).
 */
export function shield<T, A extends unknown[], Y extends Yields = never, E = never>(
  t: Task<A, T, E> | BodyOf<T, A, Y>,
  ...args: A
): Op<T, FailedWith<Y> | E> {
  return requireBodyShaped('shield').shield(t, ...args);
}

/**
 * A hole in the enclosing shield (D39, DESIGN.md §4.2): `shield` and `unshield` are Effect's `uninterruptibleMask`
 * and its `restore`. It runs `t` as `attempt` does, in a new child of the current node, started synchronously when
 * the op is yielded, and resolves with its outcome. The child is also linked to the signal of the
 * shield's owner, the node the nearest `shield` at or above the current node runs on (its release fiber's parent: the
 * node current at the free `shield`, `ctx` for `ctx.shield`), found from a call made in the shield too. The owner's
 * interruption delivers the hole: a `freeze` or `restore` hole is halted and ends `aborted` with the owner's reason;
 * an `observe` hole hears it through `signal()`. An interruption that already came skips the hole, and
 * the shield's body goes on either way. A `failure` is a value, consumed on resume. A shield inside a shield, or inside
 * a call made under one, runs on that shield or call, so its holes follow only that node's own signal: the outer
 * shield's release deadline, or the call's own delivery.
 *
 * @throws TypeError outside any shield, before anything runs: there is no owner to link to; use `attempt` there.
 */
export function unshield<T, A extends unknown[], Y extends Yields = never, E = never>(
  t: Task<A, T, E> | BodyOf<T, A, Y>,
  ...args: A
): Op<Outcome<T, FailedWith<Y> | E>> {
  return requireBodyShaped('unshield').unshield(t, ...args);
}

/** An unsubscribed pool on the current node; its forks report to `onFailure` (DESIGN.md §4.10). */
export function pool(opts: PoolOptions): Pool {
  return requireCurrent('pool').pool(opts);
}

/** A subscribed bodiless child of the current node: a block scope (DESIGN.md §2.3). */
export function child(opts?: NodeOptions): Context {
  return requireCurrent('child').child(opts);
}

// --- waiting; the yielding body's halt decides (DESIGN.md §4.14) -------------------------

/**
 * The fiber's value; its expected failure re-yielded into this body (D42), its defect thrown. A delivered `freeze` or
 * `restore` body waiting on it is halted once the fiber has completed when it is subscribed below the body, at once for
 * any other fiber, such as an owned one (DESIGN.md §4.14).
 */
export function join<T, E = never>(fiber: Fiber<T, E>): Op<T, E> {
  return requireBodyShaped('join').join(fiber);
}

/** The fiber's four-way outcome, never its failure propagated. A delivered body waiting on it is halted when `join` would be (DESIGN.md §4.14). */
export function result<T, E = never>(fiber: Fiber<T, E>): Op<Outcome<T, E>> {
  return requireBodyShaped('result').result(fiber);
}

/**
 * Resolves with the reason when the current node is delivered, for `observe` bodies (DESIGN.md §4.3); a `freeze` or
 * `restore` body waiting on it is halted by that delivery instead.
 */
export function interrupted(): Op<unknown> {
  return requireBodyShaped('interrupted').interrupted();
}

/** A wait that never resolves: a `freeze` or `restore` body waiting on it is halted by its node's delivery. */
export function never(): Op<never> {
  return requireBodyShaped('never').never();
}

/**
 * A wait of `ms` milliseconds, a number in [0, 2^31 − 1] (`RangeError` when made). The timer is armed when the op is
 * yielded; a delivered `freeze` or `restore` body waiting on it is halted and its timer cleared; an `observe` body, a
 * release and a failure handler wait the full `ms` (DESIGN.md §4.14, D34). Make it where it is yielded: at module
 * level there is no current node.
 */
export function sleep(ms: number): Op<void> {
  return requireBodyShaped('sleep').sleep(ms);
}

/**
 * Wait for a foreign promise in a body (DESIGN.md §4.14, D41 decision 10): `yield* wait(p)`. A halted body's `wait(p)`
 * lets `p` finish: the body is resumed with its value and returned at its next `yield*`, so
 * `own(yield* wait(pool.connect()), …)` attaches what an acquisition in flight produced; a failure of `p` then ends
 * the body there and is discarded, as a halted body's throw is (in its halted `finally` it is a release failure). With
 * `{ abandon: true }` it stops waiting at the halt instead, and `p` runs on, marked handled.
 * `wait((signal) => driver.query(sql, { signal }))` calls the function when the op is yielded, handing it the current
 * node's `signal()`, so the halt aborts it (`fetch` from `ramme/platform` is this wait over the global's); in a halted `finally` that is the unwind fiber's release deadline. A ramme op as
 * `p`, or as what the function returns, is that op's own wait, its expected failures included, so either is typed by
 * the op's `E`.
 */
export function wait<T, E = never>(op: Op<T, E>, opts?: { abandon?: boolean }): Op<T, E>;
export function wait<T, E = never>(fn: (signal: AbortSignal) => Op<T, E>, opts?: { abandon?: boolean }): Op<T, E>;
export function wait<T>(promise: PromiseLike<T> | ((signal: AbortSignal) => PromiseLike<T>), opts?: { abandon?: boolean }): Op<T>;
export function wait<T>(promise: PromiseLike<T> | ((signal: AbortSignal) => PromiseLike<T>), opts?: { abandon?: boolean }): Op<T> {
  return requireBodyShaped('wait').wait(promise, opts);
}

/**
 * A library's async callback written as a body (DESIGN.md §4.14, D41 decision 30), one of the three entry points of
 * plain async code: `db.transaction(promised(function* (tx) { … }))`. It captures the current node now; each call of
 * the returned function runs `t` as a call-shaped child of that node, started synchronously, and returns a real
 * promise: the value, the child's failure (consumed,
 * unless the node is a halted body: then it surfaces at the node's completion), or `FiberAbortedError` when the child
 * ended `aborted`. The node's interruption reaches the child as it reaches a callee: halted, its `finally` run, its
 * promise rejected, before the library's own `finally`. Called during a creation, it rejects with
 * `CreationViolationError` and runs nothing. `ctx.promised(t)` names the node, for a module-level entry point
 * (`app.get('/x', root.promised(handle))`). A child's expected failure rejects the promise with its error (D42).
 *
 * @throws NoCurrentNodeError outside any node.
 */
export function promised<T, A extends unknown[], Y extends Yields = never, E = never>(
  t: Task<A, T, E> | BodyOf<T, A, Y>,
): (...args: A) => Promise<T> {
  return requireCurrent('promised').promised(t);
}

// --- the fourth exit (D42) -------------------------------------------------------------

/**
 * An expected failure, the fourth way a body ends (D42): `yield* fail(e)` ends the body at once with the outcome
 * `failure(e)`, typed `E` on its task (`Task<A, T, E>`, inferred from what it yields), and returns its generator as a
 * halt does, so its `finally` blocks run, and may wait, as release work; no `catch` sees it. A caller's
 * `yield* call(t)` re-yields it, so it ends the caller too, and joins its `E`; `attempt`, `result` and `settle` deliver
 * it as an outcome. In a halted `finally` it is a release failure, which amends `aborted` to `defect`. Pure: it reads
 * no node, so it may be made anywhere.
 *
 * @example
 * const getUser = task(function* (id: string) {
 *   const user = yield* wait(db.find(id));
 *   if (user === undefined) return yield* fail(new UserNotFound(id)); // Task<[id: string], User, UserNotFound>
 *   return user; // `return yield* fail(e)` narrows `user` to `User` here; a bare `yield*` does not
 * });
 */
export function fail<E>(error: E): Operation<never, E> {
  return failOp(error);
}

// --- synchronous frames -------------------------------------------------------------

/** `current().runSync(fn, ...args)`: `child()` + `run` + `abort()` on exit (DESIGN.md §4.11). */
export function runSync<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R {
  return requireBodyShaped('runSync').runSync(fn, ...args);
}
