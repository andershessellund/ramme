// ---------------------------------------------------------------------------
// Error types (DESIGN.md §4.12, D17) and entry wrapping for `own`.
//
// Depends only on the task brand, so every other module can throw these.
// Every class sets `name` to its class name; DESIGN.md §4.12 lists
// exactly when each is thrown.
// ---------------------------------------------------------------------------

import type { Context, Resource, TaskOptions } from './context.js';
import { isTask } from './internal-context.js';
import type { TaskLike } from './internal-context.js';

/**
 * A free function, or an op through one, was called outside any node: at top level, or in plain async code after its
 * first `await`, where ramme has no current node (DESIGN.md §6).
 */
export class NoCurrentNodeError extends Error {
  override name = 'NoCurrentNodeError';
}

/** An operation on a node that has completed (I7). */
export class NodeCompletedError extends Error {
  override name = 'NodeCompletedError';
}

/** A body-shaped operation on a DI value's node before placement (DESIGN.md §3.3). */
export class PendingNodeError extends Error {
  override name = 'PendingNodeError';
}

/** `release(x)` of something this node does not own (C7). */
export class NotOwnedError extends Error {
  override name = 'NotOwnedError';
}

/** A second release registered for one object on one node (C8). */
export class AlreadyOwnedError extends Error {
  override name = 'AlreadyOwnedError';
}


/** `await fiber`: fibers are not awaitable; use `join(f)` or `result(f)` (I26). */
export class FiberNotAwaitableError extends Error {
  override name = 'FiberNotAwaitableError';
}

/** A body returned successfully without joining or explicitly aborting every fork it owns. */
export class UnjoinedFiberError extends Error {
  override name = 'UnjoinedFiberError';
}

/**
 * The awaited work was aborted: a fiber joined, called or awaited through an op's `then` ended `aborted`
 * (DESIGN.md §4.12). A halted body never sees it for its own interruption, which is `return()`, never an error.
 */
export class FiberAbortedError extends Error {
  override name = 'FiberAbortedError';
  constructor(
    /** The abort reason. */
    readonly reason: unknown,
    message?: string,
  ) {
    super(message ?? 'the fiber was aborted');
  }
}


/** `pool.fork` after the pool was delivered or close() was requested (D15). */
export class PoolClosedError extends Error {
  override name = 'PoolClosedError';
}

/** A creation-time rule was broken: `lookup`/`call`/`run` during creation, `inject` outside it (DESIGN.md §3.2, §3.5). */
export class CreationViolationError extends Error {
  override name = 'CreationViolationError';
}

/** `ctx.run(fn)` returned a promise or a generator (development mode; DESIGN.md §4.11, §4.4). */
export class AsyncRunError extends Error {
  override name = 'AsyncRunError';
}

/** A provider registered where the key has already been decided, or below its scope's owner (DESIGN.md §3.4). */
export class PlacementError extends Error {
  override name = 'PlacementError';
}

// --- The three error types beyond the core set (D17) ---

/** `pool.fork` on a full pool with `whenFull: 'reject'`. */
export class PoolFullError extends Error {
  override name = 'PoolFullError';
}

/**
 * The abort reason ramme itself produces: a parent's body exited under
 * `childrenOnExit: 'interrupt'` or with an unjoined-fork defect, or an entry was released at its turn by an
 * owner that was not itself aborted. Never thrown.
 */
export class OwnerInterrupt extends Error {
  override name = 'OwnerInterrupt';
  constructor(
    /** The node whose exit or release produced the interrupt. */
    readonly owner: Context,
  ) {
    super(`${label(owner)} is exiting`);
  }
}

/** A factory, constructor, `provide()` or default factory returned `undefined` (DESIGN.md §3.3). */
export class FactoryReturnedUndefinedError extends CreationViolationError {
  override name = 'FactoryReturnedUndefinedError';
}

/** `${name ?? kind}#${id}`, the same label `describeNode` (inject.ts) produces; inlined to keep this module a leaf. */
function label(node: Context): string {
  return `${node.name ?? (node as { readonly kind?: string }).kind ?? 'node'}#${node.id}`;
}

// ---------------------------------------------------------------------------
// SuppressedError — global on Node >= 24; a minimal shim on Node 22 (A2).
// ---------------------------------------------------------------------------

export type SuppressedErrorLike = Error & { error: unknown; suppressed: unknown };

class SuppressedErrorShim extends Error {
  override name = 'SuppressedError';
  constructor(
    readonly error: unknown,
    readonly suppressed: unknown,
    message?: string,
  ) {
    super(message ?? 'An error was suppressed during disposal.');
  }
}

/** `globalThis.SuppressedError` where it exists, otherwise a shim with `.error`, `.suppressed` and `name === 'SuppressedError'`. */
export const SuppressedErrorCtor: new (error: unknown, suppressed: unknown, message?: string) => SuppressedErrorLike =
  (globalThis as { SuppressedError?: SuppressedErrorConstructor }).SuppressedError ?? SuppressedErrorShim;

// ---------------------------------------------------------------------------
// toDispose — native resources and foreign adapters as one release action.
// ---------------------------------------------------------------------------

/** A task body or foreign adapter, with native task options and optional retirement. */
export interface ReleaseAction {
  readonly dispose: () => unknown;
  readonly options?: TaskOptions;
  readonly released?: AbortSignal;
}

function action(fn: TaskLike | ((value: any) => unknown), args: unknown[]): ReleaseAction {
  // Run tasks directly in the protected fiber, including their bound receiver. Calling the task normally would
  // introduce a child with its own interrupt policy and could halt cleanup before it finishes.
  if (isTask(fn)) return { dispose: () => Reflect.apply(fn.body, fn.self, args), options: fn.opts };
  return { dispose: () => Reflect.apply(fn, undefined, args) };
}

/**
 * Normalize explicit cleanup, a native resource, a standard disposable, or a deferred body, in that order.
 * Throws synchronously for an invalid resource. Generators and operations are driven in the release fiber;
 * foreign promises are bare waits whose ambient frame ends at the first await.
 */
export function toDispose(target: object, release?: (value: any) => unknown): ReleaseAction {
  if (release !== undefined) {
    if (typeof release !== 'function') throw new TypeError('own(value, release): release must be a function');
    return action(release, [target]);
  }
  const native = target as Partial<Resource>;
  const task = native.release;
  if (isTask(task)) {
    const released = native.released;
    if (released !== undefined && (typeof released.aborted !== 'boolean' ||
      typeof released.addEventListener !== 'function' || typeof released.removeEventListener !== 'function'))
      throw new TypeError('own(): resource.released must be an AbortSignal');
    return { ...action(task, []), released };
  }
  const t = target as Partial<AsyncDisposable & Disposable>;
  // The lib types asyncDispose as PromiseLike; the release loop treats any thenable as pending (isPromise is duck-typed).
  if (typeof t[Symbol.asyncDispose] === 'function') return { dispose: () => t[Symbol.asyncDispose]!() };
  if (typeof t[Symbol.dispose] === 'function') return { dispose: () => t[Symbol.dispose]!() };
  if (typeof target === 'function') return action(target as () => unknown, []);
  throw new TypeError('own(): value is not a Resource, Disposable or AsyncDisposable; pass a release function');
}
