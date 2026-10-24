/**
 * Node.js context storage for ramme (also Bun, Deno and Cloudflare Workers
 * with `nodejs_compat`).
 *
 * Import this module once at startup. The current node reaches across
 * `await` only through the platform's async context (law 3); without an
 * adapter every ambient operation throws `NoCurrentNodeError`.
 *
 * Usage:
 *   import 'ramme/node';
 *   import { createRootContext, task } from 'ramme';
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerContextStorage } from './context-storage.js';
import type { Frame } from './context-storage.js';

const als = new AsyncLocalStorage<Frame>();

/**
 * The context at import, where no variable is set. Source reactions are registered under it,
 * outside the awaiting body's async context, so a frozen node is collectable (A2).
 */
const detached = AsyncLocalStorage.snapshot();

registerContextStorage({
  get: () => als.getStore(),
  run: (frame, fn) => als.run(frame, fn),
  snapshot: () => AsyncLocalStorage.snapshot(),
  runDetached: (fn) => detached(fn),
});
