// ---------------------------------------------------------------------------
// Error types (DESIGN.md §4.12, D17), the native release protocol
// (`Resource`, DESIGN.md §2.6, D47) and entry wrapping for `own`.
//
// A leaf module: no runtime imports, so every other module can throw these.
// Every class sets `name` to its class name; DESIGN.md §4.12 lists
// exactly when each is thrown.
// ---------------------------------------------------------------------------

import type { Context, Operation } from './context.js';

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
// Resource — the native release protocol (DESIGN.md §2.6, D47)
// ---------------------------------------------------------------------------

/**
 * The key of the native release protocol (D47): a value whose class defines a `[Resource.release]()` method says how
 * it is released, and `own(value)` needs no second argument. A symbol, as the platform's `Symbol.asyncDispose` is, so
 * that no member a class happens to name `release` is ever taken for one, and no caller reaches the method by a name.
 * It is the registered symbol `Symbol.for('ramme.release')`, as a yielded `Fail`'s is (D42), so two copies of ramme
 * read each other's resources.
 *
 * The symbol's type is declared here, as the property itself, and not as a constant of its own that the property
 * names: a declaration that spells an inferred type (`export const lease = { *[Resource.release]() { … } }`) writes
 * the member's key as `[Resource.release]`, through the `Resource` its file imports, where a constant this module
 * does not export could not be named (TS4023). scripts/check-surface.mjs compiles such a library.
 */
export const Resource = Object.freeze({ release: Symbol.for('ramme.release') }) as { readonly release: unique symbol };

/**
 * A value that says how it is released (DESIGN.md §2.6, D47). `own(value)` is `own(value, (v) => v[Resource.release]())`:
 * the method is the entry's release, run once, with the value as `this`, in a release fiber of the owner (DESIGN.md
 * §2.4), which no interruption of the owner cuts and whose `signal()` is the owner's release deadline. Written as a
 * generator method it is driven there, so `yield*`, `own` and `signal()` work across its waits:
 *
 * ```ts
 * class Connection implements Resource {
 *   *[Resource.release]() {
 *     yield* wait(this.socket.end());
 *   }
 * }
 * ```
 *
 * It may also return an op, which is driven the same way, or a promise, a bare wait as an `async` release is. A
 * release has no expected failures (`Release`): what it throws is a defect of the owner. Nothing calls the method but
 * the owner: release early with `yield* release(value)`, which runs it now, exactly once (C7). The native method is
 * taken before `[Symbol.asyncDispose]` and `[Symbol.dispose]`, which a class may keep for `using` outside ramme.
 */
export interface Resource {
  [Resource.release](): void | Promise<void> | Operation<void>;
}

// ---------------------------------------------------------------------------
// toDispose — the `own` overloads as one dispose function (DESIGN.md §2.6)
// ---------------------------------------------------------------------------

/**
 * Wraps what `own` was given into the function the release loop calls.
 * Throws `TypeError` synchronously when nothing applies, so `own` fails at
 * the call site (C1).
 *
 * - `release` given → `() => release(target)`
 * - `target[Resource.release]` is a function → `() => target[Resource.release]()`: the native protocol (D47)
 * - `target[Symbol.asyncDispose]` is a function → `() => target[Symbol.asyncDispose]()`
 * - `target[Symbol.dispose]` is a function → `() => target[Symbol.dispose]()`
 * - `target` is a function → `target` (the defer overload)
 *
 * What the function returns is the release fiber's body result (DESIGN.md §2.4, §4.5): a generator object or an op
 * is driven in the release fiber; a promise (a foreign `[Symbol.asyncDispose]()`, an `async` release) is waited for
 * as a bare wait, and the release fiber is current only until its first `await`; anything else is done.
 */
export function toDispose(target: object, release?: (value: any) => unknown): () => unknown {
  if (release !== undefined) {
    if (typeof release !== 'function') throw new TypeError('own(value, release): release must be a function');
    return () => release(target);
  }
  const t = target as Partial<Resource & AsyncDisposable & Disposable>;
  // Native before standard (D47): a class may keep the platform's methods for `using` outside ramme.
  if (typeof t[Resource.release] === 'function') return () => t[Resource.release]!();
  // The lib types asyncDispose as PromiseLike; the release loop treats any thenable as pending (isPromise is duck-typed).
  if (typeof t[Symbol.asyncDispose] === 'function') return () => t[Symbol.asyncDispose]!();
  if (typeof t[Symbol.dispose] === 'function') return () => t[Symbol.dispose]!();
  if (typeof target === 'function') return target as () => unknown;
  throw new TypeError('own(): value is not a Resource, Disposable or AsyncDisposable; pass a release function');
}
