// ---------------------------------------------------------------------------
// Internal shared types (DESIGN.md §7). Not part of the public
// surface. Runtime content is limited to the task brand and its two helpers,
// so this module stays a leaf.
// ---------------------------------------------------------------------------

import type { InjectionKey } from './context-key.js';
import type { Body, Fail, FailureDestination, Instruction, NodeOptions, Task, TaskOptions } from './context.js';
import type { NodeImpl } from './node-impl.js';
import type { PoolState } from './pool.js';
import type { Scope } from './scope.js';

// --- The type machinery of expected failures (D42), shared by context.ts, fiber.ts and ambient.ts -----------------
//
// `Fails<E>`, the distribution of `E` over `Fail`, is not here: context.ts declares it unexported, so a consumer's
// declaration emit writes it out inline instead of naming this module, which the package's `exports` do not expose.

/** The expected failures a yield union carries: `E` of each `Fail<E>` member; `never` for `Instruction`. */
export type FailedWith<Y> = Y extends Fail<infer E> ? E : never;

/** A body's value that is no deferred thing: `never` for a thenable or an async iterator (D41, decision 5). */
export type Plain<T> = T extends PromiseLike<unknown> | AsyncIterator<unknown, unknown, never> ? never : T;

/** What a body's generator may yield: ops' instructions and its expected failures. */
export type Yields = Instruction | Fail<unknown>;

/**
 * An op as the verbs infer a body that returns one: its iterator's yield union `Y`, an `Op<T, E>`'s `Instruction |
 * Fail<E>`, read as a generator's is. One object type with `then`, so an array or a string, whose iterator would
 * otherwise be read as an op's, is unrelated to it and infers as a plain value.
 */
export interface OpYielding<T, Y> extends PromiseLike<T> {
  [Symbol.iterator](): Iterator<Y, T, unknown>;
}

/**
 * `Body` as the verbs that take one infer it (D42): `Y` is the whole yield union of the generator, or of the op the
 * body returns, and the verbs read `E` off it (`FailedWith<Y>`). One parameter for the union, as D38's helpers take the
 * whole `Result`: an `E` read from `Generator<Instruction | Fail<E>, …>` takes one inference candidate and refuses a
 * second failure type. `E` appears only under `FailedWith`, a conditional type, which inference from a contextual
 * return type does not reach: a `task(…)` inside the array `all` takes keeps its body's `E` rather than inferring
 * `unknown` from `Task<[], unknown, unknown>`. No `NoInfer` either: over an object type it stays in the type, so each
 * level of propagation would wrap `E` once more, and the union would no longer be exact.
 */
export type BodyOf<T, A extends unknown[], Y> = (...args: A) => Generator<Y, T, unknown> | OpYielding<T, Y> | Plain<T>;

/** Any task of no arguments, whatever its value and its expected failures: what `all`, `race` and `settle` take. */
export type AnyTask = Task<[], unknown, unknown>;

/** The value type of a task (each member of a union of tasks). */
export type ValueOf<X> = X extends Task<[], infer V, unknown> ? V : never;

/** The expected failures of a task (each member of a union of tasks): what `all` and `race` re-yield (D42). */
export type ErrorOf<X> = X extends Task<[], unknown, infer E> ? E : never;

/** `'value'`: a DI value's node (DESIGN.md §5, D10′). */
export type NodeKind = 'context' | 'fiber' | 'pool' | 'release' | 'value';

/** Which of its parent's stacks a node is pushed on at construction. */
export type StackKind = 'explicit' | 'provided' | 'none';

/**
 * One failure. The same object is the failing node's `failure` (or the
 * entry's, for an early release) and a member of the parent's `unconsumed`;
 * `consumed` flips when a continuation is delivered or the parent surfaces it
 * (D16).
 */
export interface FailureRecord {
  readonly error: unknown;
  consumed: boolean;
}

export interface CacheEntry {
  readonly value: unknown;
  /** S, the storage context. */
  readonly node: NodeImpl;
  readonly autoHoisted: boolean;
  /** deps(V), the closure the shadow checks and the decided markers read; `undefined` for declared placement. */
  readonly deps: ReadonlySet<InjectionKey<unknown>> | undefined;
  /**
   * The keys V's factory injected itself (its own reads, misses and `skipSelf` reads; not their deps, nor the reads
   * of a per-creation SelfScope dependency, which run through V's creation): what a re-creation forced by placement
   * by view must inject again (D7). `undefined` for declared placement.
   */
  readonly direct: ReadonlySet<InjectionKey<unknown>> | undefined;
  /** The value's node, if it attached anything. */
  readonly valueNode: NodeImpl | undefined;
  /**
   * The key's scope a default was stored under (`getKeyScope(key)`); `undefined` for every provider's value,
   * which is stored where the provider is registered (D36), and for auto-hoisted values. A hit is served only to
   * a requester whose nearest owner of this scope is the storage context (DESIGN.md §3.1).
   */
  readonly scope: Scope | undefined;
  /**
   * An auto-hoisted value built from a requester-relative read: a per-creation SelfScope value, a
   * `skipSelf` read, or a pinned dependency. It is served only to a requester at its storage context;
   * any other requester re-creates it from its own view (DESIGN.md §3.4).
   */
  readonly pinned: boolean;
}

export type ResolvedResult<T> = {
  resolved: true;
  value: T;
  node: NodeImpl;
  autoHoisted: boolean;
  deps: ReadonlySet<InjectionKey<unknown>> | undefined;
  /** A factory ran for this result; drives the development warning for a late read through a value's own node (DESIGN.md §3.5, §4.4). */
  created: boolean;
  /** Requester-relative (DESIGN.md §3.4): a per-creation SelfScope result, or a pinned auto-hoisted value. Pins the tracking creation. */
  pinned: boolean;
  /** Present iff the key was answered by an `aliasProvider` redirect (D36). */
  via?: Redirected;
};

export type ResolveResult<T> = ResolvedResult<T> | { resolved: false; via?: Redirected };

/**
 * What an `aliasProvider` redirect followed, resolved or not (D36, DESIGN.md §3.4): a value that injects the
 * key records `keys` in deps(V) and is never stored above `node`.
 */
export interface Redirected {
  /** The alias keys on the redirect chain, in order, then the final target. */
  readonly keys: readonly InjectionKey<unknown>[];
  /** The deepest node on the chain that holds one of its aliases. */
  readonly node: NodeImpl;
}

/** The brand of a task definition (fiber.ts `TaskImpl`, or an inline body made anonymous by `toTask`). */
export const TASK: unique symbol = Symbol('ramme.task');

export interface TaskLike<A extends unknown[] = unknown[], T = unknown> {
  readonly [TASK]: true;
  readonly name: string;
  readonly body: Body<T, A>;
  readonly opts: TaskOptions;
}

export function isTask(x: unknown): x is TaskLike {
  return typeof x === 'object' && x !== null && (x as { readonly [TASK]?: unknown })[TASK] === true;
}

/** A task as is; an inline body becomes an anonymous task `{ name: body.name || 'anonymous', opts: {} }` (D8′). */
export function toTask<A extends unknown[], T>(t: TaskLike<A, T> | Body<T, A>): TaskLike<A, T> {
  if (isTask(t)) return t as TaskLike<A, T>;
  if (typeof t !== 'function') throw new TypeError('expected a task or a function');
  return { [TASK]: true, name: t.name || 'anonymous', body: t, opts: {} };
}

export interface BodyInfo {
  readonly fn: Body<unknown, unknown[]>;
  readonly args: unknown[];
  readonly destination: FailureDestination;
  readonly taskName: string;
}

export interface NodeInit {
  kind: NodeKind;
  /** `undefined`: a root, or a pending value node. */
  parent: NodeImpl | undefined;
  /**
   * Pending value node only: the requester R, which supplies `root` (for
   * events) and provisional depth/autoScopeRoot/inherited timeouts until
   * `placeAt`.
   */
  basis?: NodeImpl;
  opts: NodeOptions;
  subscribed: boolean;
  /** Which of `parent`'s stacks the node is pushed on at construction. */
  stack: StackKind;
  body?: BodyInfo;
  pool?: PoolState;
  /** A value node awaiting placement (state `'pending'`, parent `undefined`). */
  pending?: boolean;
}
