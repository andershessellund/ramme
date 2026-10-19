// ---------------------------------------------------------------------------
// Error types (DESIGN.md §4.12, D17) and entry wrapping for `own`.
//
// A leaf module: no runtime imports, so every other module can throw these.
// Every class sets `name` to its class name; DESIGN.md §4.12 lists
// exactly when each is thrown.
// ---------------------------------------------------------------------------

import type { Context } from './context.js';

/** A free function was called outside any node, or no context storage is registered. */
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

/** A body-shaped operation on a node that is lent to a `call` (DESIGN.md §4.9): the call was not awaited. */
export class UnawaitedCallError extends Error {
  override name = 'UnawaitedCallError';
  constructor(
    /** The call fiber the node is lent to. */
    readonly child: Context,
    message?: string,
  ) {
    super(message ?? `the node is lent to ${label(child)}: a call() was not awaited`);
  }
}

/** `await fiber`: fibers are not awaitable; use `join(f)` or `result(f)` (I27). */
export class FiberNotAwaitableError extends Error {
  override name = 'FiberNotAwaitableError';
}

/** The awaited fiber was aborted, and the awaiter is not frozen (DESIGN.md §4.2). */
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

/** `ctx.run(fn)` returned a promise (development mode; DESIGN.md §4.11, §4.4). */
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
 * `childrenOnExit: 'interrupt'`, or an entry was released at its turn by an
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
// SuppressedError — global on Node >= 24; a minimal shim on Node 22 (A3).
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
// toDispose — the three `own` overloads as one dispose function (DESIGN.md §2.6)
// ---------------------------------------------------------------------------

/**
 * Wraps what `own` was given into the function the release loop calls.
 * Throws `TypeError` synchronously when nothing applies, so `own` fails at
 * the call site (C1).
 *
 * - `release` given → `() => release(target)`
 * - `target[Symbol.asyncDispose]` is a function → `() => target[Symbol.asyncDispose]()`
 * - `target[Symbol.dispose]` is a function → `() => target[Symbol.dispose]()`
 * - `target` is a function → `target` (the defer overload)
 */
export function toDispose(target: object, release?: (value: any) => void | Promise<void>): () => void | Promise<void> {
  if (release !== undefined) {
    if (typeof release !== 'function') throw new TypeError('own(value, release): release must be a function');
    return () => release(target);
  }
  const t = target as Partial<AsyncDisposable & Disposable>;
  // The lib types asyncDispose as PromiseLike; the release loop treats any thenable as pending (isPromise is duck-typed).
  if (typeof t[Symbol.asyncDispose] === 'function') return () => t[Symbol.asyncDispose]!() as Promise<void>;
  if (typeof t[Symbol.dispose] === 'function') return () => t[Symbol.dispose]!();
  if (typeof target === 'function') return target as () => void | Promise<void>;
  throw new TypeError('own(): value is neither Disposable nor AsyncDisposable; pass a release function');
}
