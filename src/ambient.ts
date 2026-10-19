// ---------------------------------------------------------------------------
// The ambient surface (DESIGN.md §6, law 2, I21).
//
// Each free function is `current().<method>(...)`: it acts on the current
// node, which the platform's async context carries across `await` (law 3).
// The current node is a body's own fiber, the release fiber during a release,
// the node `ctx.run(fn)` entered, or, in a creation frame, the value's node,
// created on demand (DESIGN.md §3.3).
//
// Two groups differ in a creation frame:
//
// - `own`, `release`, `releaseAll`, `fork`, `pool`, `child`, `current` and
//   `signal` materialise the value's (pending or live) node and act on it.
// - The body-shaped ones, `lookup`, `call`, `all`, `race`, `join`, `result`,
//   `interrupted`, `never`, `managed` and `runSync`, throw
//   `CreationViolationError` first, before touching any node (DESIGN.md §3.2,
//   §3.5, I16): a refused call never creates the value's node.
//
// Outside any node every one of them throws `NoCurrentNodeError`; when no
// context storage is registered the message names `import 'ramme/node'`.
// ---------------------------------------------------------------------------

import type { InjectionKey } from './context-key.js';
import type {
  AllResult,
  Body,
  Context,
  Fiber,
  LookupOptions,
  NodeOptions,
  Outcome,
  Pool,
  PoolOptions,
  Release,
  Task,
} from './context.js';
import { NO_STORAGE_MESSAGE, currentCreation, currentFrame, hasStorage } from './context-storage.js';
import type { NodeImpl } from './node-impl.js';
import { CreationViolationError, NoCurrentNodeError } from './resource.js';

/**
 * @internal The current node for a free function: a body frame's node, or the value node of a creation
 * frame, materialised on first use (DESIGN.md §3.3). Throws `NoCurrentNodeError` outside any node, naming the
 * adapter import when no storage is registered (DESIGN.md §6, D9′).
 */
export function requireCurrent(op: string): NodeImpl {
  const f = currentFrame();
  if (f === undefined)
    throw new NoCurrentNodeError(
      hasStorage()
        ? `${op}() called with no current node: run it inside a body (call/fork), a release, a factory, or ctx.run(fn)`
        : NO_STORAGE_MESSAGE,
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
export function own<T extends object>(defer: T & (() => void | Promise<void>)): T;
export function own(target: object, release?: Release<any>): object {
  const n = requireCurrent('own');
  return release === undefined ? n.own(target as Disposable) : n.own(target, release);
}

/** Release `value`, which the current node owns, now and exactly once (C7). A managed await. */
export function release(value: object): Promise<void> {
  return requireCurrent('release').release(value);
}

/** Release everything on the current node's explicit stack, top down. A managed await. */
export function releaseAll(): Promise<void> {
  return requireCurrent('releaseAll').releaseAll();
}

// --- running bodies in a child of the current node (DESIGN.md §4.5) -----------------

/** Run `t` concurrently in a new child of the current node; the body starts in a microtask (I20). */
export function fork<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Fiber<T> {
  return requireCurrent('fork').fork(t, ...args);
}

/** Run `t` in a new child of the current node and await it; lends the current node until it settles (DESIGN.md §4.9). */
export function call<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Promise<T> {
  return requireBodyShaped('call').call(t, ...args);
}

/**
 * Run the tasks as subscribers of a fresh child and await every one: the
 * tuple of their values, or an `AggregateError` of every real failure (DESIGN.md §4.8).
 * `const T` keeps an array literal a tuple.
 */
export function all<const T extends readonly Task<[], unknown>[]>(tasks: T, opts?: NodeOptions): Promise<AllResult<T>> {
  return requireBodyShaped('all').all(tasks, opts);
}

/** The first success among the tasks; the rest are aborted and awaited (DESIGN.md §4.8). */
export function race<T>(tasks: readonly Task<[], T>[], opts?: NodeOptions): Promise<T> {
  return requireBodyShaped('race').race(tasks, opts);
}

/** An unsubscribed pool on the current node; its forks report to `onFailure` (DESIGN.md §4.10). */
export function pool(opts: PoolOptions): Pool {
  return requireCurrent('pool').pool(opts);
}

/** A subscribed bodiless child of the current node: a block scope (DESIGN.md §2.3). */
export function child(opts?: NodeOptions): Context {
  return requireCurrent('child').child(opts);
}

// --- awaiting; the freeze decision is the current node's (DESIGN.md §4.2) ------------

/** The fiber's value, or its failure thrown. A managed await. */
export function join<T>(fiber: Fiber<T>): Promise<T> {
  return requireBodyShaped('join').join(fiber);
}

/** The fiber's outcome; never rejects. A managed await. */
export function result<T>(fiber: Fiber<T>): Promise<Outcome<T>> {
  return requireBodyShaped('result').result(fiber);
}

/** Resolves with the reason when the current node is delivered; in a `freeze` body it never resumes (DESIGN.md §4.3). */
export function interrupted(): Promise<unknown> {
  return requireBodyShaped('interrupted').interrupted();
}

/** A managed await that never settles. */
export function never(): Promise<never> {
  return requireBodyShaped('never').never();
}

/** Make a bare promise a managed await: in a delivered `freeze` body it never settles (DESIGN.md §4.2). */
export function managed<T>(promise: Promise<T>): Promise<T> {
  return requireBodyShaped('managed').managed(promise);
}

// --- synchronous frames -------------------------------------------------------------

/** `current().runSync(fn, ...args)`: `child()` + `run` + `abort()` on exit (DESIGN.md §4.11). */
export function runSync<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R {
  return requireBodyShaped('runSync').runSync(fn, ...args);
}
