// ---------------------------------------------------------------------------
// Public types of the node tree (DESIGN.md §2.1, §4.5, §4.7, §4.8, §4.10), and
// `Result`, which `Outcome` extends with `aborted` (DESIGN.md §4.12, D38).
//
// Types only: the one implementation of every interface here is `NodeImpl`
// (node-impl.ts); tasks are `TaskImpl` (fiber.ts).
// ---------------------------------------------------------------------------

import type { InjectionKey } from './context-key.js';
import type { Scope } from './scope.js';

/** `pending` exists only for a DI value's node before placement (DESIGN.md §3.3). */
export type NodeState = 'pending' | 'running' | 'settling' | 'releasing' | 'complete';

/**
 * How a node reacts to interruption (DESIGN.md §4.3).
 *
 * - `freeze` (default): delivered → applied; managed awaits never settle; forwards to subscribers.
 * - `observe`: delivered only; the body sees the signal and settles on its own; forwards only to `restore` subscribers.
 * - `restore`: delivered whenever any ancestor is; re-opens a cancellable window inside an `observe` region.
 */
export type InterruptMode = 'freeze' | 'observe' | 'restore';

export interface NodeOptions {
  name?: string;
  providers?: Provider<unknown>[];
  scopes?: Scope[];
  /** Default `'freeze'`. */
  interrupt?: InterruptMode;
  /** Default `'interrupt'`: subscribers are interrupted when the body exits. */
  childrenOnExit?: 'interrupt' | 'await';
  /** Deliver to this node's own signal after this many milliseconds; `Infinity` means never. At most 2^31 - 1 (TypeError otherwise). */
  timeoutMs?: number;
  /** Deliver to this node when this signal fires. */
  signal?: AbortSignal;
  /** Deadline for this node's release fibers; inherited; `Infinity` means none. No default (DESIGN.md §2.1). At most 2^31 - 1. */
  releaseTimeoutMs?: number;
  /** `node:stalled` after a delivered body has not settled for this long. Default 5000; inherited; 0 or Infinity disables. At most 2^31 - 1. */
  stallWarningMs?: number;
  /**
   * Clamp auto-hoisting at this node: a value whose dependencies would place
   * it above here is cached here instead, so nothing created under this node
   * leaks upward (D7). For harnesses and isolation boundaries; default false.
   */
  captureAutoScoped?: boolean;
}

/** An async function run in a node. Run in the current node by calling it, or in a new node through a task. */
export type Body<T, A extends unknown[] = []> = (...args: A) => Promise<T> | T;

/** The release half of `own(value, release)`; runs with the release fiber current (DESIGN.md §2.4). */
export type Release<T> = (value: T) => void | Promise<void>;

export interface Provider<T> {
  key: InjectionKey<T>;
  provide(): T;
  /**
   * Optional scope override. When set, the value produced by this provider
   * is stored on the context that owns this scope, regardless of where the
   * provider was registered. Takes precedence over a scope set on the key.
   */
  scope?: Scope;
}

export interface LookupOptions {
  /** Return `undefined` instead of throwing when nothing provides the key. */
  optional?: boolean;
  /** Skip this node and resolve from its parent. */
  skipSelf?: boolean;
}

/** The success member of a `Result` (DESIGN.md §4.12). */
export type Success<T> = { readonly status: 'success'; readonly value: T };

/** The failure member of a `Result` (DESIGN.md §4.12). */
export type Failure<E = unknown> = { readonly status: 'failure'; readonly error: E };

/**
 * An expected failure as a return value: a plain object, never a class, so any `{ status, value | error }` of
 * this shape is one (DESIGN.md §4.12, D38). The helpers are in `ramme/result`.
 */
export type Result<T, E = unknown> = Success<T> | Failure<E>;

/**
 * A node's outcome, fixed at settling (DESIGN.md §4.12): a `Result` plus `aborted`, which is decided by state, never
 * by inspecting an error. An outcome whose `status` is not `'aborted'` is a `Result<T, unknown>`.
 */
export type Outcome<T> = Result<T, unknown> | { readonly status: 'aborted'; readonly reason: unknown };

/**
 * Where a fiber's `failure` goes (DESIGN.md §4.7). An `aborted` outcome fires no destination.
 *
 * A handler is called once, with the parent current: it may `lookup`, `own`, `fork`, `child` and
 * `pool` there, even while the parent's body awaits a call. If it returns a promise, the parent stays open
 * until that settles, and a rejection, like a throw, surfaces from the parent's completion. A
 * handler that awaits the parent's own completion or an ancestor's (`app.close()`, `join`) does not hold
 * the parent open, so `onFailure: () => app.close()` shuts the app down.
 */
export type FailureDestination = 'join' | 'link' | ((error: unknown, fiber: Fiber<unknown>) => void);

export interface TaskOptions extends NodeOptions {
  /** Default `'join'`. */
  onFailure?: FailureDestination;
}

/** One run of a task: a node with a body, yielding an outcome (DESIGN.md §4.5). */
export interface Fiber<T> extends Context {
  /** Narrowed for inference: `join<T>(f: Fiber<T>)` reads T from here. Not thenable; a runtime `then` getter throws FiberNotAwaitableError. */
  readonly outcome: Outcome<T> | undefined;
}

/**
 * A body plus options (DESIGN.md §4.5). Not callable: each `fork`/`call` runs the body
 * in a new fiber, a child of the current node.
 */
export interface Task<A extends unknown[], T> {
  readonly name: string;
  /** Run in a new child of the current node, concurrently. */
  fork(...args: A): Fiber<T>;
  /** Run in a new child of the current node and await it; lends the current node until it settles (DESIGN.md §4.9). */
  call(...args: A): Promise<T>;
  /** `call`, resolving with the outcome: a failure is delivered as a value, never thrown (DESIGN.md §4.5). */
  attempt(...args: A): Promise<Outcome<T>>;
  /** Per-use option overrides. */
  with(opts: TaskOptions): Task<A, T>;
  /** Partial application; what `all`, `race`, `settle` and pools take. */
  bind(...args: A): Task<[], T>;
}

/** The tuple of the tasks' values, in order; `all([a.bind(1), b.bind('x')])` is `Promise<[A, B]>`. */
export type AllResult<T extends readonly Task<[], unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends Task<[], infer U> ? Awaited<U> : never;
};

/** The tuple of the tasks' outcomes, in order; `settle([a.bind(1), b.bind('x')])` is `Promise<[Outcome<A>, Outcome<B>]>` (DESIGN.md §4.8). */
export type SettleResult<T extends readonly Task<[], unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends Task<[], infer U> ? Outcome<Awaited<U>> : never;
};

export interface PoolOptions extends NodeOptions {
  name: string;
  /** Required: a pool's forks always report here; run like a task's handler, with the pool current (DESIGN.md §4.7). */
  onFailure: (error: unknown, fiber: Fiber<unknown>) => void;
  /** Default unbounded. */
  concurrency?: number;
  /** Default `'wait'`. */
  whenFull?: 'wait' | 'reject';
}

/** An unsubscribed bodiless node whose forks are its subscribers (DESIGN.md §4.10). */
export interface Pool extends Context {
  /** The destination is always the pool's `onFailure`. */
  fork<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Fiber<T>;
  readonly running: number;
  readonly pending: number;
}

/** A node of the tree (DESIGN.md §2.1). Every node is a `Context`. */
export interface Context {
  // --- identity & state ---
  readonly id: number;
  readonly name: string | undefined;
  readonly state: NodeState;
  readonly scopes: ReadonlySet<Scope>;
  readonly signal: AbortSignal;
  /** `undefined` while running. */
  readonly outcome: Outcome<unknown> | undefined;
  /**
   * The resolution parent (DESIGN.md §2.1): `undefined` on a root; a value's storage node; a release fiber's
   * owner; the node a fork, call, child or pool was made on. Throws `PendingNodeError` on a value's node before
   * placement (DESIGN.md §3.3).
   */
  readonly parent: Context | undefined;

  // --- resolution ---
  get<T>(key: InjectionKey<T>): T;
  get<T>(key: InjectionKey<T>, options?: LookupOptions & { optional?: false | undefined }): T;
  get<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;
  addProvider<T>(provider: Provider<T>): void;

  // --- attachment: the explicit stack (DESIGN.md §2.6) ---
  /** The contract: attach a resource; it is released by this node (C1: before `own` returns). */
  own<T extends Disposable | AsyncDisposable>(resource: T): T;
  /** Sugar: attach `value` with a release function. */
  own<T extends object>(value: T, release: Release<T>): T;
  /** Sugar: attach a deferred function, run at release. */
  own<T extends object>(defer: T & (() => void | Promise<void>)): T;
  /** Release `value` now, exactly once (C7). */
  release(value: object): Promise<void>;
  releaseAll(): Promise<void>;

  // --- running bodies in a child of THIS node (DESIGN.md §4.5) ---
  fork<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Fiber<T>;
  call<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Promise<T>;
  /**
   * `call` with the outcome delivered as a value: the child's failure is consumed, never thrown. An interrupted
   * `freeze` or `restore` caller freezes here as on `call`, so `aborted` describes the child's own abort, unless
   * the child is `restore`: it also hears an `observe` caller's interruption, and an `observe` ancestor's that a
   * `freeze` caller below it does not, and reports either as `aborted` (DESIGN.md §4.5).
   */
  attempt<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Promise<Outcome<T>>;
  /** `const T` makes an array literal infer as a tuple, so `all([a.bind(1), b.bind('x')])` is `Promise<[A, B]>` (DESIGN.md §4.8). */
  all<const T extends readonly Task<[], unknown>[]>(tasks: T, opts?: NodeOptions): Promise<AllResult<T>>;
  race<T>(tasks: readonly Task<[], T>[], opts?: NodeOptions): Promise<T>;
  /** `all` resolving with every outcome instead of rejecting: waits for every task, as `all` does, and resolves with their outcomes in order; never rejects on a member's account (DESIGN.md §4.8). */
  settle<const T extends readonly Task<[], unknown>[]>(tasks: T, opts?: NodeOptions): Promise<SettleResult<T>>;
  pool(opts: PoolOptions): Pool;
  child(opts?: NodeOptions): Context;

  // --- awaiting; the freeze decision is made for the awaiting body's node, current(), if any (DESIGN.md §4.2) ---
  join<T>(fiber: Fiber<T>): Promise<T>;
  result<T>(fiber: Fiber<T>): Promise<Outcome<T>>;
  interrupted(): Promise<unknown>;
  never(): Promise<never>;
  /**
   * Resolves after `ms` milliseconds, in [0, 2^31 − 1] (`RangeError` otherwise). A managed await: a delivered
   * `freeze` or `restore` body awaiting it is frozen and its timer cleared; with no current node it is a plain
   * delay (DESIGN.md §4.2).
   */
  sleep(ms: number): Promise<void>;
  managed<T>(promise: Promise<T>): Promise<T>;

  // --- synchronous frames ---
  /** Make this node current for a synchronous `fn`. */
  run<R>(fn: () => R): R;
  /** `child()` + `run` + `abort()` on exit: synchronous block scoping. */
  runSync<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R;

  // --- lifecycle (DESIGN.md §2.7) ---
  abort(reason?: unknown): void;
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}
