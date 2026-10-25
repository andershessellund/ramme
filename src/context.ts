// ---------------------------------------------------------------------------
// Public types of the node tree (DESIGN.md §2.1, §4.5, §4.7, §4.8, §4.10), the
// operations a generator body runs with `yield*` (DESIGN.md §4.14, D41), and
// `Result`, which `Outcome` extends with `aborted` (DESIGN.md §4.12, D38).
//
// Types only: the one implementation of every interface here is `NodeImpl`
// (node-impl.ts); tasks are `TaskImpl` (fiber.ts); a work op is a `WorkOp`
// and a lifecycle op a `LifecycleOp` (managed.ts).
// ---------------------------------------------------------------------------

import type { InjectionKey } from './context-key.js';
import type { Scope } from './scope.js';

/** The brand of an `Instruction`. Declared only: no value outside ramme carries it. */
declare const INSTRUCTION: unique symbol;

/**
 * What an op yields to the driver that steps a generator body (DESIGN.md §4.14, D41): an opaque record, never the op
 * itself, so `yield op` without the star is a type error in a body and a `TypeError` thrown back at run time. Exported
 * so that a library's generator helper can name its type (`Generator<Instruction, T, unknown>`).
 */
export interface Instruction {
  readonly [INSTRUCTION]: true;
}

/**
 * Anything a generator body runs with `yield*` to get a `T` (DESIGN.md §4.14): an op, or a generator helper, since a
 * `Generator<Instruction, T, unknown>` is an `Operation<T>`. The type to annotate a helper that is only `yield*`ed
 * with. `Body` has no `Operation<T>` arm (D41), so a helper a body returns (`task(() => helper(x))`), and a body that
 * needs an annotation, is typed `Generator<Instruction, T, unknown>`.
 */
export interface Operation<T> {
  [Symbol.iterator](): Iterator<Instruction, T, unknown>;
}

/**
 * What every waiting verb returns (DESIGN.md §4.14, D41): an `Operation<T>`, run by `yield* op` in a body, and a plain
 * thenable (`then` only: no `catch` or `finally`, and no `Promise`), which `await` reaches from plain async code. A
 * work op (`call`, `attempt`, `all`, `race`, `settle`, `shield`, `unshield`, `join`, `result`, `sleep`,
 * `interrupted`, `never`, `wait`) is lazy: making it runs nothing; `yield*` runs it for the yielding body, afresh each
 * time, and `then` runs it once, as a child of the node it was made through, settling with its value or its failure,
 * or `FiberAbortedError` when that child ended `aborted`. The lifecycle verbs (`release`, `releaseAll`, `close`,
 * `[Symbol.asyncDispose]`) start their work when called and return an `Op<void> & Promise<void>`.
 */
export interface Op<T> extends Operation<T>, PromiseLike<T> {}

/** `pending` exists only for a DI value's node before placement (DESIGN.md §3.3). */
export type NodeState = 'pending' | 'running' | 'settling' | 'releasing' | 'complete';

/**
 * How a node reacts to interruption (DESIGN.md §4.3).
 *
 * - `freeze` (default): delivered → applied; the body is halted (`return()`) at its wait, as the wait's shape decides (DESIGN.md §4.14); forwards to subscribers.
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

/**
 * What a node runs (DESIGN.md §4.5, §4.14): a generator function, stepped by the driver, every wait a `yield*` of an
 * op; or a synchronous function, whose returned generator or op is driven as the body (D41, decision 28). An `async`
 * function is no body (D41, decision 5): its promise matches no member (the last one is `never` for a thenable), so it
 * is a type error, and at run time a `TypeError` naming `function*`; so is an `async function*`, whose async iterator
 * the last member refuses too (PROPOSAL.md §6). One function type with a union return: the
 * generator and op members are matched first, so a generator that only throws infers `never` and a plain value, an
 * array included, infers itself (an `Operation<T>` member would read an array's iterator as an operation's, so the
 * member is `Op<T>`). A generator's return value is a value: `return yield* op`, never `return op`.
 */
export type Body<T, A extends unknown[] = []> = (
  ...args: A
) => Generator<Instruction, T, unknown> | Op<T> | (T extends PromiseLike<unknown> | AsyncIterator<unknown, unknown, never> ? never : T);

/**
 * The release half of `own(value, release)`; runs with the release fiber current (DESIGN.md §2.4). A generator
 * function, or a function returning an op, is driven in the release fiber (DESIGN.md §4.14). One returning a promise
 * (an `async` release) is waited for as a bare wait: the release fiber is current only until its first `await`, after
 * which ramme throws `NoCurrentNodeError`; write a release that waits for ramme work as `function*`.
 */
export type Release<T> = (value: T) => void | Promise<void> | Operation<void>;

/**
 * A binding of `key` on the node it is registered on (`providers`, `addProvider`). Its value is stored on that
 * node, whatever the key declares as its scope: a key's scope places only the key's own default. The exception is
 * an `aliasProvider`, a redirect that stores nothing under `key`: its target is placed by the target's own rules
 * (D36, DESIGN.md §3.1).
 */
export interface Provider<T> {
  key: InjectionKey<T>;
  provide(): T;
}

/**
 * What a consumer of `inject(T)` can reach: `T`'s public members (`keyof` leaves out `private` and `#private`
 * ones), the contract a provider's value is checked against (D37). Functions, topic receivers and classes pass
 * through unchanged, and so do `any` and `unknown`, so a call signature keeps its contextual typing.
 */
export type Public<T> = 0 extends 1 & T
  ? T // any
  : unknown extends T
    ? T // unknown
    : T extends ((...args: any[]) => any) | (abstract new (...args: any[]) => any)
      ? T // functions, topics, classes
      : { [K in keyof T]: T[K] };

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
 * A handler is called once, with the parent current: it may `lookup`, `own`, `fork`, `child` and `pool` there. A
 * generator function handler is driven with the parent current at every step, and holds the parent until it ends; one
 * that returns an op is driven as its own `yield*` of it (DESIGN.md §4.14). A handler that waits for the parent's own
 * completion or an ancestor's (`yield* app.close()`, a `join`) does not hold the parent open, so
 * `onFailure: () => app.close()` shuts the app down. One that returns a promise (an `async` handler) holds the parent
 * until it settles, a bare wait whose rejection, like a throw, surfaces from the parent's completion; it has no current
 * node after its first `await`.
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
  /** Run in a new child of the current node and wait for it: `yield* t.call(…)` (DESIGN.md §4.5). */
  call(...args: A): Op<T>;
  /** `call`, resolving with the outcome: a failure is delivered as a value, never thrown (DESIGN.md §4.5). */
  attempt(...args: A): Op<Outcome<T>>;
  /** Per-use option overrides. */
  with(opts: TaskOptions): Task<A, T>;
  /** Partial application; what `all`, `race`, `settle` and pools take. */
  bind(...args: A): Task<[], T>;
}

/** The tuple of the tasks' values, in order; `all([a.bind(1), b.bind('x')])` is `Op<[A, B]>`. */
export type AllResult<T extends readonly Task<[], unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends Task<[], infer U> ? Awaited<U> : never;
};

/** The tuple of the tasks' outcomes, in order; `settle([a.bind(1), b.bind('x')])` is `Op<[Outcome<A>, Outcome<B>]>` (DESIGN.md §4.8). */
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
  /** Sugar: attach a deferred function, run at release; a generator function is driven there (DESIGN.md §4.14). */
  own<T extends object>(defer: T & (() => void | Promise<void> | Operation<void>)): T;
  /** Release `value` now, exactly once (C7): eager, so its op only waits; a promise as well (DESIGN.md §4.14). */
  release(value: object): Op<void> & Promise<void>;
  releaseAll(): Op<void> & Promise<void>;

  // --- running bodies in a child of THIS node (DESIGN.md §4.5) ---
  fork<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Fiber<T>;
  call<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Op<T>;
  /**
   * `call` with the outcome delivered as a value: the child's failure is consumed, never thrown. An interrupted
   * `freeze` or `restore` caller is halted once the child has completed and never sees an outcome, so `aborted`
   * describes the child's own abort, unless the child is `restore`: it also hears an `observe` caller's interruption,
   * and an `observe` ancestor's that a `freeze` caller below it does not, and reports either as `aborted`
   * (DESIGN.md §4.5).
   */
  attempt<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Op<Outcome<T>>;
  /**
   * Run `t` in a release fiber of this node and wait for it: release work, which a halt lets finish (D39,
   * DESIGN.md §4.14). This node completes after every shield it started, and is the owner an `unshield` inside it
   * follows.
   */
  shield<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Op<T>;
  /**
   * A hole in the enclosing shield (D39, DESIGN.md §4.14): `attempt` on this node, whose child is also linked to the
   * signal of the shield's owner, the node the nearest `shield` at or above this node runs on (its release fiber's
   * parent). That node's interruption delivers the hole: a `freeze` or `restore` hole is halted and ends `aborted`; an
   * `observe` hole hears it through `signal()`. One that already came skips the hole, and the outcome is a value.
   * `TypeError` outside any shield.
   */
  unshield<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Op<Outcome<T>>;
  /** `const T` makes an array literal infer as a tuple, so `all([a.bind(1), b.bind('x')])` is `Op<[A, B]>` (DESIGN.md §4.8). */
  all<const T extends readonly Task<[], unknown>[]>(tasks: T, opts?: NodeOptions): Op<AllResult<T>>;
  race<T>(tasks: readonly Task<[], T>[], opts?: NodeOptions): Op<T>;
  /** `all` resolving with every outcome instead of rejecting: waits for every task, as `all` does, and resolves with their outcomes in order; never rejects on a member's account (DESIGN.md §4.8). */
  settle<const T extends readonly Task<[], unknown>[]>(tasks: T, opts?: NodeOptions): Op<SettleResult<T>>;
  pool(opts: PoolOptions): Pool;
  child(opts?: NodeOptions): Context;

  // --- waiting; the yielding body is the awaiter whose halt decides (DESIGN.md §4.14) ---
  join<T>(fiber: Fiber<T>): Op<T>;
  result<T>(fiber: Fiber<T>): Op<Outcome<T>>;
  interrupted(): Op<unknown>;
  never(): Op<never>;
  /**
   * Resolves after `ms` milliseconds, in [0, 2^31 − 1] (`RangeError` when made). The timer is armed when the op runs:
   * a delivered `freeze` or `restore` body waiting on it is halted and its timer cleared; awaited from plain async code
   * it is a plain delay (DESIGN.md §4.14, D34).
   */
  sleep(ms: number): Op<void>;
  /**
   * Wait for a foreign promise (DESIGN.md §4.14): `wait(p)` lets `p` finish when the waiting body is halted, so a
   * halted body is resumed with its value and returned at its next `yield*` (a failure of `p` then is discarded, as a
   * halted body's throw is; in its halted `finally` it is a release failure); with `{ abandon: true }` the wait stops
   * at the halt. `wait((signal) => p)` calls the function when the op runs, handing it this node's signal (the unwind
   * fiber's deadline in a halted `finally`). A ramme op as `p` is that op's own wait.
   */
  wait<T>(promise: PromiseLike<T> | ((signal: AbortSignal) => PromiseLike<T>), opts?: { abandon?: boolean }): Op<T>;
  /**
   * A library's async callback as a body (DESIGN.md §4.14): each call of the returned function runs `t` as a
   * call-shaped child of this node, started synchronously, and returns a real promise of its value; it rejects with
   * the child's failure, which it consumes unless this node is a halted body (the failure then surfaces at this
   * node's completion), or with `FiberAbortedError` when the child ended `aborted`, with `NodeCompletedError` once
   * this node has completed, and with `CreationViolationError` when called during a creation.
   */
  promised<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>): (...args: A) => Promise<T>;

  // --- synchronous frames ---
  /** Make this node current for a synchronous `fn`. */
  run<R>(fn: () => R): R;
  /** `child()` + `run` + `abort()` on exit: synchronous block scoping. */
  runSync<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R;

  // --- lifecycle (DESIGN.md §2.7): eager, so each op only waits, and is a promise as well ---
  abort(reason?: unknown): void;
  close(): Op<void> & Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Op<void> & Promise<void>;
}
