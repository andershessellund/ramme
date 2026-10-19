// ---------------------------------------------------------------------------
// The one ambient mechanism (DESIGN.md §6, law 3).
//
// The current node is a `Frame` held in the platform's async context, which
// an adapter registers: `import 'ramme/node'` (AsyncLocalStorage) or
// `import 'ramme/async-context'` (TC39 AsyncContext). There is no built-in
// synchronous fallback (D9′) and no module-level creation variable: a
// creation frame carries the `CreationState`, whose value node is created on
// demand.
// ---------------------------------------------------------------------------

import type { CreationState } from './inject.js';
import type { NodeImpl } from './node-impl.js';
import { NoCurrentNodeError } from './resource.js';

/** The value stored in the platform async context. Immutable; a creation frame's node lives on `creation.slot`. */
export interface Frame {
  /** Body frame: the fiber, release node, or the node `run` entered. Creation frame: `undefined`. */
  readonly node: NodeImpl | undefined;
  /**
   * Set only while a factory, constructor or default factory runs (A5: synchronous). A continuation the
   * factory scheduled may still carry the frame later; once `creation.ended` it reads as no frame (DESIGN.md §3.5).
   */
  readonly creation: CreationState | undefined;
  /**
   * @internal Set only on the frame a failure handler runs in, with the failed fiber's parent as `node`
   * (DESIGN.md §4.7). The handler is not the parent's body: it may resolve, fork and attach on the parent
   * while the parent's body is lent (DESIGN.md §4.9), its managed awaits never freeze anything and never count
   * as the parent's (DESIGN.md §4.2, §4.7), and its calls lend nothing. Carried across the handler's own awaits
   * like any frame; the record is the run's hold on its parent (DESIGN.md §4.7).
   */
  readonly handler?: HandlerRun;
}

/**
 * One run of a failure handler (DESIGN.md §4.7). A managed await the handler makes on a node's completion
 * reports it here: when that node is the handler's parent or an ancestor of it, the parent's completion
 * would wait for the handler and the handler for it, so the run stops holding the parent. Not part of the
 * package surface (index.ts does not export it), yet kept in the declarations, which `managed.ts` and
 * `node-impl.ts` name it from: they must compile without `skipLibCheck` (stripInternal would drop it).
 */
export interface HandlerRun {
  /** `waitsFor(n)`: whether the await waits for node `n`'s completion. Never throws. */
  awaits(waitsFor: (node: NodeImpl) => boolean): void;
}

/** Runs `fn` in an async context captured earlier. */
export type ContextRunner = <R>(fn: () => R) => R;

/** What an adapter provides: read the current frame, and run `fn` with `frame` current (propagated across `await`). */
export interface ContextStorage {
  get(): Frame | undefined;
  run<R>(frame: Frame, fn: () => R): R;
  /**
   * Optional: a runner that re-enters the whole current async context later, every variable
   * included (`AsyncLocalStorage.snapshot()`, `AsyncContext.Snapshot`). Without it, `captureContext`
   * re-enters ramme's frame only.
   */
  snapshot?(): ContextRunner;
  /**
   * Optional (A2): run `fn` in the async context the adapter was loaded in, where no variable is set
   * (a snapshot taken at import). A promise reaction registered inside then retains nothing of the
   * caller's context, ramme's frame or the user's own variables. Without it, `runDetached` falls back
   * to `run(NO_NODE, fn)`.
   */
  runDetached?<R>(fn: () => R): R;
}

let storage: ContextStorage | undefined;

/** @internal The `NoCurrentNodeError` message when no adapter has been imported. */
export const NO_STORAGE_MESSAGE =
  "No context storage is registered: import 'ramme/node' (Node, Bun, Deno, Workers) or 'ramme/async-context' once at startup";

/**
 * Register the context storage. Adapters call this once, at import; there is
 * no unregister API.
 *
 * @example
 * import 'ramme/node'; // registers AsyncLocalStorage-backed storage
 */
export function registerContextStorage(impl: ContextStorage): void {
  storage = impl;
}

/** @internal */
export function hasStorage(): boolean {
  return storage !== undefined;
}

/**
 * @internal The frame that means "no current node". Installed around a body's
 * settle reactions and around every microtask ramme queues, so a continuation
 * inherits neither the forker's frame nor a finished creation frame (DESIGN.md §6).
 */
export const NO_NODE: Frame = Object.freeze({ node: undefined, creation: undefined });

/**
 * @internal The current frame; `undefined` without storage, outside any frame, under `NO_NODE`, and in a
 * creation frame whose creation has ended: a callback a factory scheduled (`queueMicrotask`, `then`,
 * `setTimeout`) runs outside the creation, as ramme's own continuations do (DESIGN.md §3.5, §6). Never throws.
 */
export function currentFrame(): Frame | undefined {
  const f = storage?.get();
  return f === undefined || (f.node === undefined && (f.creation === undefined || f.creation.ended)) ? undefined : f;
}

/** @internal The creation state of the current creation frame, if any. */
export function currentCreation(): CreationState | undefined {
  return currentFrame()?.creation;
}

/** @internal The current node without materialising a pending value node: `frame.node ?? frame.creation?.nodeIfCreated`. */
export function peekCurrentNode(): NodeImpl | undefined {
  const f = currentFrame();
  return f === undefined ? undefined : (f.node ?? f.creation?.nodeIfCreated);
}

/** @internal The current node, materialising the value node in a creation frame (DESIGN.md §3.3): `frame.node ?? frame.creation?.node()`. */
export function currentNode(): NodeImpl | undefined {
  const f = currentFrame();
  return f === undefined ? undefined : (f.node ?? f.creation?.node());
}

/**
 * @internal Run `fn` outside the caller's async context (A2): in the adapter's load-time context,
 * or under `NO_NODE` when the adapter offers none. ramme registers reactions on promises it does not
 * control (a foreign fiber's completion, a user promise) here, so a frozen body's node and context are
 * not retained until that promise settles. Runs `fn` directly when no storage is registered.
 */
export function runDetached<R>(fn: () => R): R {
  if (storage === undefined) return fn();
  return storage.runDetached !== undefined ? storage.runDetached(fn) : storage.run(NO_NODE, fn);
}

function runDirectly<R>(fn: () => R): R {
  return fn();
}

/**
 * @internal A runner for the current async context, for code that must run there later
 * without a promise reaction registered here: the adapter's snapshot, else ramme's current frame
 * (`NO_NODE` outside any), else a direct call when no storage is registered.
 */
export function captureContext(): ContextRunner {
  const s = storage;
  if (s === undefined) return runDirectly;
  if (s.snapshot !== undefined) return s.snapshot();
  const frame = s.get() ?? NO_NODE;
  return (fn) => s.run(frame, fn);
}

/** @internal Run `fn` with `frame` current. Throws `NoCurrentNodeError` naming the adapter import when no storage is registered. */
export function runInFrame<R>(frame: Frame, fn: () => R): R {
  if (storage === undefined) throw new NoCurrentNodeError(NO_STORAGE_MESSAGE);
  return storage.run(frame, fn);
}
