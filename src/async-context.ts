/**
 * TC39 AsyncContext context storage for ramme.
 *
 * Import this module once at startup in environments that provide
 * `AsyncContext.Variable` (natively or through a polyfill). The current
 * node reaches across `await` only through the platform's async context
 * (law 3).
 *
 * Usage:
 *   import 'ramme/async-context';
 *   import { createRootContext, task } from 'ramme';
 *
 * @see https://github.com/tc39/proposal-async-context
 */
import { registerContextStorage } from './context-storage.js';
import type { Frame } from './context-storage.js';

interface AsyncContextVariable<T> {
  get(): T | undefined;
  run<R>(value: T, fn: () => R): R;
}

interface AsyncContextSnapshot {
  run<R>(fn: () => R): R;
}

interface AsyncContextNamespace {
  Variable: new <T>() => AsyncContextVariable<T>;
  /** Optional here: a polyfill without it falls back to the `NO_NODE` frame (D-84). */
  Snapshot?: new () => AsyncContextSnapshot;
}

const AsyncContext = (globalThis as { AsyncContext?: AsyncContextNamespace }).AsyncContext;

if (!AsyncContext?.Variable) {
  throw new Error(
    'AsyncContext.Variable is not available on globalThis. ' +
      'Provide a polyfill or use ramme/node for Node.js environments.',
  );
}

const variable = new AsyncContext.Variable<Frame>();

const Snapshot = AsyncContext.Snapshot;

function runnerOf(snap: AsyncContextSnapshot): <R>(fn: () => R) => R {
  return (fn) => snap.run(fn);
}

/** The context at import, where no variable is set (D-84). */
const detached = Snapshot !== undefined ? new Snapshot() : undefined;

registerContextStorage({
  get: () => variable.get(),
  run: (frame, fn) => variable.run(frame, fn),
  snapshot: Snapshot !== undefined ? () => runnerOf(new Snapshot()) : undefined,
  runDetached: detached !== undefined ? runnerOf(detached) : undefined,
});
