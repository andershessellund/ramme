// ---------------------------------------------------------------------------
// The one ambient mechanism (DESIGN.md §6, §4.2, law 3; D41 decision 18).
//
// The current node is a `Frame` in a synchronous module slot. `runInFrame`
// sets it for the duration of a synchronous `fn` and restores the previous
// value in a `finally` (re-entrant): the driver around every step of a body,
// creation around a factory, a release fiber around its release, a failure
// handler, `node.run(fn)` and a `promised` body. ramme uses no async context,
// on any platform: nothing carries the slot across an `await`, so plain async
// code has no current node after its first `await`. There is no module-level
// creation variable: a creation frame carries the `CreationState`, whose
// value node is created on demand.
// ---------------------------------------------------------------------------

import type { CreationState } from './inject.js';
import type { NodeImpl } from './node-impl.js';

/** The value the slot holds. Immutable; a creation frame's node lives on `creation.slot`. */
export interface Frame {
  /** Body frame: the fiber, release node, or the node `run` entered. Creation frame: `undefined`. */
  readonly node: NodeImpl | undefined;
  /**
   * Set only while a factory, constructor or default factory runs (A4: synchronous). Once `creation.ended` it
   * reads as no frame (DESIGN.md §3.5).
   */
  readonly creation: CreationState | undefined;
  /**
   * @internal Set only on the frame a halted generator body's `finally` is stepped in (U3, DESIGN.md §4.2): the
   * body's unwind fiber, with the body's node as `node`. Every synchronous verb still addresses `node`; the ops the
   * body runs there run on the unwind fiber, which the tree never delivers (only its release deadline does).
   */
  readonly unwind?: NodeImpl;
}

/** The slot: the current frame, or `undefined` between steps, in a microtask, and under `NO_NODE`. */
let slot: Frame | undefined;

/**
 * @internal The frame that means "no current node". Installed around the reactions, microtasks and timers
 * ramme registers inside a step or a creation, so they run under no node whatever frame was current when they
 * were registered (DESIGN.md §6).
 */
export const NO_NODE: Frame = Object.freeze({ node: undefined, creation: undefined });

/**
 * @internal The current frame; `undefined` outside any frame, under `NO_NODE`, and in a creation frame whose
 * creation has ended (DESIGN.md §3.5, §6). Never throws.
 */
export function currentFrame(): Frame | undefined {
  const f = slot;
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
 * @internal Run `fn` with `frame` in the slot, and restore the previous frame when `fn` returns or throws, so
 * frames nest (a `call`'s first step inside its caller's, `node.run` inside a step) and none is ever left set.
 */
export function runInFrame<R>(frame: Frame, fn: () => R): R {
  const prev = slot;
  slot = frame;
  try {
    return fn();
  } finally {
    slot = prev;
  }
}

/**
 * @internal Run `fn` under `NO_NODE`: what ramme runs on behalf of no node inside a step or a creation (a timer it
 * arms, a reaction it registers, a release loop's continuation) reads no frame. The slot is synchronous, so a
 * reaction never inherits a frame anyway; this keeps synchronous work ramme starts there (a release run from a
 * factory) out of the caller's frame (DESIGN.md §6).
 */
export function runDetached<R>(fn: () => R): R {
  return runInFrame(NO_NODE, fn);
}
