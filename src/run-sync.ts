import { getCurrentContext } from './context-storage.js';
import type { Context, RunSyncOptions } from './context.js';

/**
 * Run a synchronous function in a temporary child of the current ambient context.
 *
 * Creates a child context with the given providers/scopes, runs `fn` inside it,
 * disposes the child, and returns the result.
 *
 * This is the sync equivalent of `Fiber.run()`. Use it when you need a short-lived
 * child context for synchronous work.
 *
 * Throws if no ambient context is active. Throws if async disposal operations
 * are registered on the child (use `Fiber.run()` for async work).
 */
export function runSync<R>(fn: (ctx: Context) => R, options?: RunSyncOptions): R {
  const current = getCurrentContext();
  if (!current) {
    throw new Error(
      'runSync() requires an active context. Call from within Fiber.run(), ctx.run(), or ctx.enterSync().',
    );
  }
  return (current as unknown as Context).runSync(fn, options);
}
