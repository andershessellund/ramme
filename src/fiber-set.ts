// ---------------------------------------------------------------------------
// FiberSet — managed pool of concurrent fibers
//
// Creates a child context (owned by the creator's storage context) and spawns
// all fibers into it.  The child context auto-registers on the parent, so
// parent drain waits for all spawned fibers to complete.
//
// Requires `inject(ContextRefKey)` — must be called during value creation
// (field initializers, constructor bodies, factory functions).
// ---------------------------------------------------------------------------

import { ContextImpl } from './context-impl.js';
import { inject, ContextRefKey } from './inject.js';
import type { Context, Provider } from './context.js';
import type { Fiber } from './fiber.js';
import { Fiber as FiberNs } from './fiber.js';
import type { Scope } from './scope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FiberSetOptions {
  /** Human-readable name for the pool context (appears in debug UI). */
  name: string;
  /** Called when a spawned fiber rejects. Required — no silent swallowing. */
  onError: (error: unknown, fiber: Fiber<unknown>) => void;
}

export interface FiberSetSpawnOptions {
  /** Human-readable name for the individual fiber. */
  name?: string;
  /** Additional providers for the fiber's child context. */
  providers?: Provider<unknown>[];
  /** Scopes to attach to the fiber's child context. */
  scopes?: Scope[];
}

export interface FiberSet {
  /** Spawn a concurrent fiber into the pool. */
  spawn<T>(fn: () => Promise<T>, opts?: FiberSetSpawnOptions): Fiber<T>;
  /** Abort all fibers in the pool (aborts the pool context). */
  abort(): void;
  /** The underlying pool context. */
  readonly context: Context;
}

// ---------------------------------------------------------------------------
// createFiberSet — creation-time factory
// ---------------------------------------------------------------------------

/**
 * Create a managed pool of concurrent fibers.
 *
 * Must be called during value creation (uses `inject(ContextRefKey)` internally).
 * The pool context is a child of the creator's storage context and participates
 * in its lifecycle automatically.
 *
 * @example
 * ```ts
 * class EmailService {
 *   private pool = createFiberSet({
 *     name: 'email-pool',
 *     onError: (err) => console.error('[Email] send failed:', err),
 *   });
 *
 *   send(to: string, subject: string): void {
 *     this.pool.spawn(async () => {
 *       await sendEmail(to, subject);
 *     }, { name: `email: ${subject}` });
 *   }
 * }
 * setScope(EmailService, RootScope);
 * ```
 */
export function createFiberSet(opts: FiberSetOptions): FiberSet {
  const contextRef = inject(ContextRefKey);

  // Defer pool creation until first use — during auto-scoped factory
  // execution, the storage context is not yet known.
  let pool: ContextImpl | undefined;
  let poolCtx: Context | undefined;

  function ensurePool(): Context {
    if (!poolCtx) {
      const owner = contextRef.context; // safe at runtime — ref is resolved
      pool = new ContextImpl(
        [],
        owner as unknown as ContextImpl,
        undefined,
        undefined,
        opts.name,
      );
      poolCtx = pool as unknown as Context;
    }
    return poolCtx;
  }

  return {
    spawn<T>(fn: () => Promise<T>, spawnOpts?: FiberSetSpawnOptions): Fiber<T> {
      const fiber = FiberNs.spawn(fn, {
        ...spawnOpts,
        context: ensurePool(),
      });
      fiber.promise.catch((err) => opts.onError(err, fiber as unknown as Fiber<unknown>));
      return fiber;
    },
    abort() {
      pool?.abort();
    },
    get context(): Context {
      return ensurePool();
    },
  };
}
