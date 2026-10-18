import type { ContextImpl } from './context-impl.js';

// ---------------------------------------------------------------------------
// ContextStorage — pluggable context tracking
//
// The storage maintains a stack of contexts. enterSync/leaveSync push/pop
// synchronously. runAsync creates a new async scope (e.g. ALS) with a
// fresh stack containing a single context.
//
// The built-in implementation uses a plain module-level array — no ALS.
// Context is intentionally lost after the first await without ALS.
// Register a real implementation (e.g. Node ALS) via registerContextStorage().
// ---------------------------------------------------------------------------

export interface ContextStorage {
  /** Read the current (top-of-stack) context. */
  current(): ContextImpl | undefined;

  /** Push a context onto the stack. */
  enterSync(ctx: ContextImpl): void;

  /** Pop a context from the stack. */
  leaveSync(): void;

  /**
   * Create a new async scope with `ctx` as the sole stack entry.
   * Without a real ALS, this falls back to sync push/pop — context
   * will be lost after the first await.
   */
  runAsync<R>(ctx: ContextImpl, fn: () => R): R;
}

// ---------------------------------------------------------------------------
// Built-in (default) storage — sync-only, no ALS
// ---------------------------------------------------------------------------

const syncStack: ContextImpl[] = [];

const builtinStorage: ContextStorage = {
  current() {
    return syncStack[syncStack.length - 1];
  },
  enterSync(ctx) {
    syncStack.push(ctx);
  },
  leaveSync() {
    syncStack.pop();
  },
  runAsync(ctx, fn) {
    syncStack.push(ctx);
    try {
      return fn();
    } finally {
      syncStack.pop();
    }
  },
};

// ---------------------------------------------------------------------------
// Active storage — defaults to built-in, can be replaced once
// ---------------------------------------------------------------------------

let storage: ContextStorage = builtinStorage;

/**
 * Register a context storage implementation (e.g. Node ALS-backed).
 * Call once at application startup.
 *
 * @example
 * import 'ramme/node'; // auto-registers ALS storage
 */
export function registerContextStorage(impl: ContextStorage): void {
  storage = impl;
}

/**
 * Get the active context storage.
 * @internal — used by ContextImpl, FiberImpl, gen.ts
 */
export function getContextStorage(): ContextStorage {
  return storage;
}

/**
 * Get the current execution context.
 * Reads from the active storage (ALS or sync stack).
 */
export function getCurrentContext(): ContextImpl | undefined {
  return storage.current();
}
