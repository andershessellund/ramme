// ---------------------------------------------------------------------------
// Public types of the node tree (DESIGN.md §2.1, §4.5, §4.7, §4.8, §4.10), the
// operations a generator body runs with `yield*` (DESIGN.md §4.2, D41), the
// `Fail` a body yields to end with an expected failure (D42), and `Result`,
// which `Outcome` extends with `defect` and `aborted` (DESIGN.md §4.12).
//
// `E`, a task's expected failures, is inferred, never declared: a body's
// generator yields `Instruction`s and `Fail<E>`s, and `task` reads `E` off the
// whole yield union (D42, D38's pattern), so two failure types are a union where
// a separate `E` parameter would take one inference candidate and refuse the
// other. `yield* t(…)` re-yields `t`'s `Fail<E>` into the caller's union.
//
// Types only: the one implementation of every interface here is `NodeImpl`
// (node-impl.ts); a task is the callable fiber.ts makes; a work op is a
// `WorkOp` and a lifecycle op a `LifecycleOp` (managed.ts).
// ---------------------------------------------------------------------------

import type { InjectionKey } from './context-key.js';
import type { AnyMember, BodyOf, ErrorOf, FailedWith, Plain, TASK, ValueOf, Yields } from './internal-context.js';
import type { Scope } from './scope.js';

/** The brand of an `Instruction`. Declared only: no value outside ramme carries it. */
declare const INSTRUCTION: unique symbol;

/**
 * What an op yields to the driver that steps a generator body (DESIGN.md §4.2, D41): an opaque record, never the op
 * itself, so `yield op` without the star is a type error in a body and a `TypeError` thrown back at run time. Exported
 * so that a library's generator helper can name its type (`Generator<Instruction, T, unknown>`).
 */
export interface Instruction {
  readonly [INSTRUCTION]: true;
}

/** The brand of a `Fail`. Declared only: at run time a `Fail` is a record under a registered symbol (D42). */
declare const FAIL: unique symbol;

/**
 * What `yield* fail(e)` yields to the driver (D42, DESIGN.md §4.13): an expected failure, the fourth way a body ends,
 * under a brand disjoint from `Instruction`'s, so `task` reads `E` off a body's yield union and an ordinary op adds
 * nothing to it. Exported so that a library's generator helper can name its type
 * (`Generator<Instruction | Fail<NotFound>, T, unknown>`), which its declaration emit needs as it needs `Instruction`.
 */
export interface Fail<E> {
  readonly [FAIL]: E;
}

/**
 * `Fail<e>` for each member `e` of `E`; `never` for `E = never`, so an op that cannot fail yields `Instruction` only.
 * Deliberately unexported, and never tagged internal, as `ramme/result`'s helpers are: the published signatures name
 * it, so stripInternal keeps it in dist/context.d.ts, and a library's declaration emit over a generic `E`
 * (`function* orFail<T, E>(x: T | undefined, e: E)`) writes it out inline, `E extends unknown ? Fail<E> : never`,
 * where a name from a module the package's `exports` do not expose would fail it (TS2883).
 */
type Fails<E> = E extends unknown ? Fail<E> : never;

/**
 * Anything a generator body runs with `yield*` to get a `T` (DESIGN.md §4.2): an op, or a generator helper, since a
 * `Generator<Instruction, T, unknown>` is an `Operation<T>`. `E` is what it may end the body with, re-yielded as
 * `Fail<E>` (D42): `yield* t(…)` is `t`'s value, or ends the caller with `t`'s expected failure. The type to annotate
 * a helper that is only `yield*`ed with. `Body` has no `Operation<T>` arm (D41), so a helper a body returns
 * (`task(() => helper(x))`), and a body that needs an annotation, is typed `Generator<Instruction | Fail<E>, T, unknown>`.
 */
export interface Operation<T, E = never> {
  [Symbol.iterator](): Iterator<Instruction | Fails<E>, T, unknown>;
}

/**
 * What every waiting verb returns (DESIGN.md §4.2, D41): an `Operation<T, E>`, run by `yield* op` in a body, and a
 * plain thenable (`then` only: no `catch` or `finally`, and no `Promise`), which `await` reaches from plain async code.
 * A work op (a task's call `t(…)`, `attempt`, `all`, `race`, `settle`, `shield`, `unshield`, `join`, `result`, `sleep`,
 * `interrupted`, `never`, `wait`) is lazy: making it runs nothing; `yield*` runs it for the yielding body, afresh each
 * time, and `then` runs it once, as a child of the node it was made through, settling with its value or its failure
 * (an expected failure's error as the rejection, D42), or `FiberAbortedError` when that child ended `aborted`. The
 * lifecycle verbs (`release`, `releaseAll`, `close`, `[Symbol.asyncDispose]`) start their work when called and return
 * an `Op<void> & Promise<void>`.
 */
export interface Op<T, E = never> extends Operation<T, E>, PromiseLike<T> {}

/** `pending` exists only for a DI value's node before placement (DESIGN.md §3.3). */
export type NodeState = 'pending' | 'running' | 'settling' | 'releasing' | 'complete';

/**
 * How a node reacts to interruption (DESIGN.md §4.3).
 *
 * - `freeze` (default): delivered → applied; the body is halted (`return()`) at its wait, as the wait's shape decides (DESIGN.md §4.2); forwards to subscribers.
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
 * What a node runs (DESIGN.md §4.5, §4.2): a generator function, stepped by the driver, every wait a `yield*` of an
 * op; or a synchronous function, whose returned generator or op is driven as the body (D41, decision 28). `E` is the
 * expected failures it may end with, yielded as `Fail<E>` (D42). An `async` function is no body (D41, decision 5): its
 * promise matches no member (the last one is `never` for a thenable), so it is a type error, and at run time a
 * `TypeError` naming `function*`; so is an `async function*`, whose async iterator the last member refuses too
 * (D41's settled note on `Body`). One function type with a union return: the generator and op members are matched first, so a
 * generator that only throws infers `never` and a plain value, an array included, infers itself (an `Operation<T>`
 * member would read an array's iterator as an operation's, so the member is `Op<T>`). A generator's return value is a
 * value: `return yield* op`, never `return op`.
 */
export type Body<T, A extends unknown[] = [], E = never> = (
  ...args: A
) => Generator<Instruction | Fails<E>, T, unknown> | Op<T, E> | Plain<T>;

/**
 * The release half of `own(value, release)`; runs with the release fiber current (DESIGN.md §2.4). A generator
 * function, or a function returning an op or a `fail(e)`, is driven in the release fiber (DESIGN.md §4.5). One returning a promise
 * (an `async` release) is waited for as a bare wait: the release fiber is current only until its first `await`, after
 * which ramme throws `NoCurrentNodeError`; write a release that waits for ramme work as `function*`. Any `E`: a
 * release's expected failure, its own `yield* fail(e)` or a callee's re-yielded, is a release failure of its owner,
 * which amends the owner's outcome to a `defect` (D42).
 */
export type Release<T> = (value: T) => void | Promise<void> | Operation<void, unknown>;

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
 * A node's outcome, fixed at settling (DESIGN.md §4.12, D42), four-way: `success`, the body's value; `failure`, an
 * expected failure the body yielded (`yield* fail(e)`), typed `E`; `defect`, what it threw, untyped; and `aborted`,
 * decided by state, never by inspecting an error. A release failure amends it once, to a `defect`. An outcome whose
 * `status` is neither `'defect'` nor `'aborted'` is a `Result<T, E>`.
 */
export type Outcome<T, E = unknown> =
  | Result<T, E>
  | { readonly status: 'defect'; readonly error: unknown }
  | { readonly status: 'aborted'; readonly reason: unknown };

/**
 * Where a fiber's `failure` or `defect` goes (DESIGN.md §4.7, D42). An `aborted` outcome fires no destination.
 *
 * A handler is called once, with the parent current: it may `lookup`, `own`, `fork`, `child` and `pool` there. A
 * generator function handler is driven with the parent current at every step, and holds the parent until it ends; one
 * that returns an op, or a `fail(e)`, is driven as its own `yield*` of it (DESIGN.md §4.5). A handler that waits for the parent's own
 * completion or an ancestor's (`yield* app.close()`, a `join`) does not hold the parent open, so
 * `onFailure: () => app.close()` shuts the app down. One that returns a promise (an `async` handler) holds the parent
 * until it settles, a bare wait whose rejection, like a throw, surfaces from the parent's completion; it has no current
 * node after its first `await`.
 *
 * A handler's `error` is the fiber's `E` or a defect (`E | unknown`, which is `unknown`): branch on
 * `fiber.outcome.status`, `'failure'` or `'defect'`. A `'link'` child's expected failure aborts the parent and
 * surfaces as the parent's `defect`: the parent did not declare it (D42).
 */
export type FailureDestination = 'join' | 'link' | ((error: unknown, fiber: Fiber<unknown, unknown>) => void);

export interface TaskOptions extends NodeOptions {
  /** Default `'join'`. */
  onFailure?: FailureDestination;
}

/** One run of a task: a node with a body, yielding an outcome (DESIGN.md §4.5); `E` is its task's (D42). */
export interface Fiber<T, E = never> extends Context {
  /** Narrowed for inference: `join<T, E>(f: Fiber<T, E>)` reads T and E from here. Not thenable; a runtime `then` getter throws FiberNotAwaitableError. */
  readonly outcome: Outcome<T, E> | undefined;
}

/**
 * A body plus options (DESIGN.md §4.5), and a function (D44): `t(…args)` is the lazy op of one run of the body in a
 * new fiber, a child of the node it is made through, as every work op is (D41, decision 2). Making it reads the slot,
 * so outside any node it throws `NoCurrentNodeError` and in a factory `CreationViolationError`; `yield* t(…)` is the
 * body's value, or re-yields its `Fail<E>`. `fork(t(…))` and `attempt(t(…))` run it concurrently or for its outcome.
 * `call`, `bind` and `apply` are `Function.prototype`'s. `E` is inferred from the body: the expected failures it
 * yields (D42). A task is no injection key (decision 7): the brand lets the key types exclude it.
 */
export interface Task<A extends unknown[], T, E = never> {
  /** One run of the body, lazy: a new child of the node it is made through, made when the op is yielded. */
  (...args: A): Op<T, E>;
  readonly name: string;
  /** Per-use option overrides; a bound task keeps its receiver. */
  with(opts: TaskOptions): Task<A, T, E>;
  readonly [TASK]: true;
}

/** The tuple of the members' values, in order; `all([a(1), b('x')])` is `Op<[A, B], EA | EB>`. */
export type AllResult<T extends readonly AnyMember[]> = {
  -readonly [K in keyof T]: T[K] extends Op<infer U, unknown> ? Awaited<U> : T[K] extends Task<[], infer U, unknown> ? Awaited<U> : never;
};

/**
 * The tuple of the members' four-way outcomes, in order; `settle([a(1), b('x')])` is
 * `Op<[Outcome<A, EA>, Outcome<B, EB>]>` (DESIGN.md §4.8).
 */
export type SettleResult<T extends readonly AnyMember[]> = {
  -readonly [K in keyof T]: T[K] extends Op<infer U, unknown>
    ? Outcome<Awaited<U>, ErrorOf<T[K]>>
    : T[K] extends Task<[], infer U, unknown>
      ? Outcome<Awaited<U>, ErrorOf<T[K]>>
      : never;
};

export interface PoolOptions extends NodeOptions {
  name: string;
  /** Required: a pool's forks always report here, a fork's expected failure as its defect does; run like a task's handler, with the pool current (DESIGN.md §4.7). */
  onFailure: (error: unknown, fiber: Fiber<unknown, unknown>) => void;
  /** Default unbounded. */
  concurrency?: number;
  /** Default `'wait'`. */
  whenFull?: 'wait' | 'reject';
}

/** An unsubscribed bodiless node whose forks are its subscribers (DESIGN.md §4.10). */
export interface Pool extends Context {
  /** The destination is always the pool's `onFailure`. */
  fork<T, A extends unknown[], Y extends Yields = never, E = never>(
    t: Task<A, T, E> | BodyOf<T, A, Y>,
    ...args: A
  ): Fiber<T, FailedWith<Y> | E>;
  /** An op forked into the pool (D44, decision 4): a task's call `t(…)` as the task itself, any other op in a fiber named after it. */
  fork<T, E = never>(op: Op<T, E>): Fiber<T, E>;
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
  /** Sugar: attach a deferred function, run at release; a generator function is driven there (DESIGN.md §4.5). */
  own<T extends object>(defer: T & (() => void | Promise<void> | Operation<void, unknown>)): T;
  /** Release `value` now, exactly once (C7): eager, so its op only waits; a promise as well (DESIGN.md §4.2). */
  release(value: object): Op<void> & Promise<void>;
  releaseAll(): Op<void> & Promise<void>;

  // --- running bodies in a child of THIS node (DESIGN.md §4.5); E is the body's expected failures (D42) ---
  fork<T, A extends unknown[], Y extends Yields = never, E = never>(t: Task<A, T, E> | BodyOf<T, A, Y>, ...args: A): Fiber<T, FailedWith<Y> | E>;
  /**
   * The child's value, or its expected failure re-yielded into this body (D42); its defect is thrown. `ctx.call(t, …args)`
   * is `t(…args)` made through `ctx`: the explicit receiver plain async code names (`await app.call(profile, '42')`).
   * It takes a task or a body, never an op, and so does `fork`: an op is made through the current node, so where code
   * has an op it has a current node, and the free `fork(op)` and `yield*` serve it; outside every node no op can be
   * made at all (D44, decision 1).
   */
  call<T, A extends unknown[], Y extends Yields = never, E = never>(t: Task<A, T, E> | BodyOf<T, A, Y>, ...args: A): Op<T, FailedWith<Y> | E>;
  /**
   * `call` with the four-way outcome delivered as a value: the child's failure or defect is consumed, never thrown. An interrupted
   * `freeze` or `restore` caller is halted once the child has completed and never sees an outcome, so `aborted`
   * describes the child's own abort, unless the child is `restore`: it also hears an `observe` caller's interruption,
   * and an `observe` ancestor's that a `freeze` caller below it does not, and reports either as `aborted`
   * (DESIGN.md §4.5).
   */
  attempt<T, A extends unknown[], Y extends Yields = never, E = never>(
    t: Task<A, T, E> | BodyOf<T, A, Y>,
    ...args: A
  ): Op<Outcome<T, FailedWith<Y> | E>>;
  /**
   * Run `t` in a release fiber of this node and wait for it: release work, which a halt lets finish (D39,
   * DESIGN.md §4.2). This node completes after every shield it started, and is the owner an `unshield` inside it
   * follows.
   */
  shield<T, A extends unknown[], Y extends Yields = never, E = never>(t: Task<A, T, E> | BodyOf<T, A, Y>, ...args: A): Op<T, FailedWith<Y> | E>;
  /**
   * A hole in the enclosing shield (D39, DESIGN.md §4.2): `attempt` on this node, whose child is also linked to the
   * signal of the shield's owner, the node the nearest `shield` at or above this node runs on (its release fiber's
   * parent). That node's interruption delivers the hole: a `freeze` or `restore` hole is halted and ends `aborted`; an
   * `observe` hole hears it through `signal()`. One that already came skips the hole, and the outcome is a value.
   * `TypeError` outside any shield.
   */
  unshield<T, A extends unknown[], Y extends Yields = never, E = never>(
    t: Task<A, T, E> | BodyOf<T, A, Y>,
    ...args: A
  ): Op<Outcome<T, FailedWith<Y> | E>>;
  /**
   * `const T` makes an array literal infer as a tuple, so `all([a(1), b('x')])` is `Op<[A, B], EA | EB>`
   * (DESIGN.md §4.8): a lone member's expected failure is re-yielded; two failures or more, or a defect, throw the
   * `AggregateError` of every failure (D28, D42). A member is an op or a task of no arguments (D44, decision 4).
   */
  all<const T extends readonly AnyMember[]>(tasks: T, opts?: NodeOptions): Op<AllResult<T>, ErrorOf<T[number]>>;
  /** The first success; with none, `all`'s rule: a lone expected failure re-yielded, else the `AggregateError` of every failure (D42). */
  race<const T extends readonly AnyMember[]>(tasks: T, opts?: NodeOptions): Op<ValueOf<T[number]>, ErrorOf<T[number]>>;
  /** `all` resolving with every four-way outcome instead of rejecting: waits for every member, as `all` does, and resolves with their outcomes in order; never rejects on a member's account (DESIGN.md §4.8). */
  settle<const T extends readonly AnyMember[]>(tasks: T, opts?: NodeOptions): Op<SettleResult<T>>;
  pool(opts: PoolOptions): Pool;
  child(opts?: NodeOptions): Context;

  // --- waiting; the yielding body is the awaiter whose halt decides (DESIGN.md §4.2) ---
  /** The fiber's value; its expected failure re-yielded (D42), its defect thrown. */
  join<T, E = never>(fiber: Fiber<T, E>): Op<T, E>;
  result<T, E = never>(fiber: Fiber<T, E>): Op<Outcome<T, E>>;
  interrupted(): Op<unknown>;
  never(): Op<never>;
  /**
   * Resolves after `ms` milliseconds, in [0, 2^31 − 1] (`RangeError` when made). The timer is armed when the op runs:
   * a delivered `freeze` or `restore` body waiting on it is halted and its timer cleared; awaited from plain async code
   * it is a plain delay (DESIGN.md §4.2, D34).
   */
  sleep(ms: number): Op<void>;
  /**
   * Wait for a foreign promise (DESIGN.md §4.2): `wait(p)` lets `p` finish when the waiting body is halted, so a
   * halted body is resumed with its value and returned at its next `yield*` (a failure of `p` then is discarded, as a
   * halted body's throw is; in its halted `finally` it is a release failure); with `{ abandon: true }` the wait stops
   * at the halt. `wait((signal) => p)` calls the function when the op runs, handing it this node's signal (the unwind
   * fiber's deadline in a halted `finally`). A ramme op as `p`, or as what the function returns, is that op's own wait,
   * its expected failures included, so either is typed by the op's `E`.
   */
  wait<T, E = never>(op: Op<T, E>, opts?: { abandon?: boolean }): Op<T, E>;
  wait<T, E = never>(fn: (signal: AbortSignal) => Op<T, E>, opts?: { abandon?: boolean }): Op<T, E>;
  wait<T>(promise: PromiseLike<T> | ((signal: AbortSignal) => PromiseLike<T>), opts?: { abandon?: boolean }): Op<T>;
  /**
   * A library's async callback as a body (DESIGN.md §4.5): each call of the returned function runs `t` as a
   * call-shaped child of this node, started synchronously, and returns a real promise of its value; it rejects with
   * the child's failure, which it consumes unless this node is a halted body (the failure then surfaces at this
   * node's completion), or with `FiberAbortedError` when the child ended `aborted`, with `NodeCompletedError` once
   * this node has completed, and with `CreationViolationError` when called during a creation. A child's expected
   * failure rejects it with its error (D42).
   */
  promised<T, A extends unknown[], Y extends Yields = never, E = never>(t: Task<A, T, E> | BodyOf<T, A, Y>): (...args: A) => Promise<T>;

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
