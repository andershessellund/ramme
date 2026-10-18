// ---------------------------------------------------------------------------
// ManagedResource — unified lifecycle protocol for ramme contexts
// ---------------------------------------------------------------------------

/**
 * Well-known symbols for the ManagedResource protocol.
 *
 * Using symbols avoids naming conflicts — any object can implement the
 * protocol (e.g., a context passes *itself* as a resource on its parent).
 */
export const Drain = Symbol.for('ramme.drain.v1');
export const Flush = Symbol.for('ramme.flush.v1');
export const Dispose = Symbol.for('ramme.dispose.v1');
export const Abort = Symbol.for('ramme.abort.v1');

/**
 * A resource managed by a ramme context.
 *
 * Resources participate in the context's three-phase shutdown:
 *
 * 1. **Drain** — stop accepting new work, wait for in-flight work to finish.
 *    Called in parallel on all resources.
 * 2. **Flush** — finish delayed work (log buffers, metric batches).
 *    Called sequentially in reverse registration order.
 * 3. **Dispose** — release underlying resources (close connections, file handles).
 *    Called sequentially in reverse registration order.
 *
 * Additionally, `[Abort]()` propagates an abort signal down the tree as a
 * synchronous method call. It does NOT initiate disposal — the parent
 * orchestrates drain/flush/dispose separately.
 *
 * All methods are optional — implement only what you need.
 */
export interface ManagedResource {
  /** Stop intake, wait for in-flight work. Called in parallel. */
  [Drain]?(): Promise<void> | void;
  /** Finish delayed work (buffers, batches). Called in reverse order. */
  [Flush]?(): Promise<void> | void;
  /** Release underlying resources. Called in reverse order. */
  [Dispose]?(): Promise<void> | void;
  /** Propagate abort signal. Synchronous, does not initiate disposal. */
  [Abort]?(): void;
}

/**
 * Handle returned by `registerResource()`. Allows the resource to
 * unregister itself from the owning context before disposal.
 */
export interface ResourceHandle {
  /** Remove this resource from the context's resource list. */
  unregister(): void;
}

/**
 * Register a `ManagedResource` on the current creation context.
 *
 * Only available during value creation (class field initializers,
 * factory functions, function keys) — same places where `inject()` works.
 *
 * The resource participates in the owning context's drain/flush/dispose
 * lifecycle. Returns a `ResourceHandle` that can be used to unregister
 * the resource early (e.g. when a fiber completes normally).
 *
 * @throws If called outside a creation context.
 */
export type RegisterResourceFunction = (resource: ManagedResource) => ResourceHandle;
