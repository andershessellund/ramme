// ---------------------------------------------------------------------------
// fiber-exec — low-level fiber execution primitive
//
// This module provides the shared infrastructure for all fiber kinds:
//   - Regular fibers (Fiber.call, Fiber.spawn)
//   - Lifecycle fibers (drain, flush, dispose of individual resources)
//
// It owns the global fiber ID counter and the execute-and-report logic.
// Both fiber.ts and context-impl.ts import from here — no circular deps.
// ---------------------------------------------------------------------------

import type { ContextImpl } from './context-impl.js';
import { getContextStorage } from './context-storage.js';
import { FiberTopic, type FiberEvent } from './lifecycle-events.js';

// ---------------------------------------------------------------------------
// Fiber ID generation (shared across all fiber kinds)
// ---------------------------------------------------------------------------

let _nextFiberId = 0;

/** Allocate the next global fiber ID. */
export function nextFiberId(): number {
  return ++_nextFiberId;
}

// ---------------------------------------------------------------------------
// Fiber receiver resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the FiberTopic receiver from a root context.
 * Returns undefined if no receiver is provided (zero overhead path).
 */
export function resolveFiberReceiver(root: ContextImpl): ((event: FiberEvent) => void) | undefined {
  return root.get(FiberTopic, { optional: true });
}

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

/** Emit a fiber:started event. */
export function emitFiberStarted(
  receiver: (event: FiberEvent) => void,
  id: number,
  name: string,
  contextId: number,
  mode: 'call' | 'spawn' | 'fork' | 'lifecycle',
  extra?: { phase?: 'drain' | 'flush' | 'dispose'; resourceName?: string },
): void {
  receiver({
    type: 'fiber:started',
    id,
    name,
    contextId,
    mode,
    ...(extra?.phase !== undefined ? { phase: extra.phase } : {}),
    ...(extra?.resourceName !== undefined ? { resourceName: extra.resourceName } : {}),
  } as FiberEvent);
}

/** Emit a fiber:settled event. */
export function emitFiberSettled(
  receiver: (event: FiberEvent) => void,
  id: number,
  startTime: number,
  error: unknown | undefined,
): void {
  const durationMs = performance.now() - startTime;
  if (error !== undefined) {
    receiver({
      type: 'fiber:settled',
      id,
      outcome: 'error',
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
  } else {
    receiver({
      type: 'fiber:settled',
      id,
      outcome: 'success',
      durationMs,
    });
  }
}

// ---------------------------------------------------------------------------
// Call event helpers (for Fiber.call scoped spans)
// ---------------------------------------------------------------------------

/** Emit a call:enter event. */
export function emitCallEnter(
  receiver: (event: FiberEvent) => void,
  callId: number,
  name: string,
  contextId: number,
): void {
  receiver({
    type: 'call:enter',
    callId,
    name,
    contextId,
  });
}

/** Emit a call:leave event. */
export function emitCallLeave(
  receiver: (event: FiberEvent) => void,
  callId: number,
  startTime: number,
  error: unknown | undefined,
): void {
  const durationMs = performance.now() - startTime;
  if (error !== undefined) {
    receiver({
      type: 'call:leave',
      callId,
      outcome: 'error',
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
  } else {
    receiver({
      type: 'call:leave',
      callId,
      outcome: 'success',
      durationMs,
    });
  }
}

// ---------------------------------------------------------------------------
// Join event helpers (for Fiber.join / Fiber.result)
// ---------------------------------------------------------------------------

/** Emit a join:enter event. */
export function emitJoinEnter(
  receiver: (event: FiberEvent) => void,
  joinedFiberId: number,
  contextId: number,
): void {
  receiver({
    type: 'join:enter',
    joinedFiberId,
    contextId,
  });
}

/** Emit a join:leave event. */
export function emitJoinLeave(
  receiver: (event: FiberEvent) => void,
  joinedFiberId: number,
  startTime: number,
  error: unknown | undefined,
): void {
  const durationMs = performance.now() - startTime;
  if (error !== undefined) {
    receiver({
      type: 'join:leave',
      joinedFiberId,
      outcome: 'error',
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
  } else {
    receiver({
      type: 'join:leave',
      joinedFiberId,
      outcome: 'success',
      durationMs,
    });
  }
}

// ---------------------------------------------------------------------------
// fiberExec — core execute-and-report primitive
// ---------------------------------------------------------------------------

/**
 * Execute `fn` within `context`, emitting fiber:started / fiber:settled
 * events. No child context creation, no resource registration.
 *
 * This is the primitive shared by Fiber.call, Fiber.spawn, and lifecycle
 * fibers. Each caller adds its own structural semantics on top.
 *
 * @param fn       - The function to execute.
 * @param context  - The context to run within (pushed via storage.runAsync).
 * @param id       - Pre-allocated fiber ID.
 * @param name     - Human-readable fiber name.
 * @param mode     - 'call' | 'spawn' | 'fork' | 'lifecycle'.
 * @param receiver - FiberTopic receiver (or undefined for zero-overhead path).
 * @param extra    - Extra fields to include on the fiber:started event.
 * @returns The return value of `fn`.
 */
export async function fiberExec<T>(
  fn: () => Promise<T> | T,
  context: ContextImpl,
  id: number,
  name: string,
  mode: 'call' | 'spawn' | 'fork' | 'lifecycle',
  receiver: ((event: FiberEvent) => void) | undefined,
  extra?: { phase?: 'drain' | 'flush' | 'dispose'; resourceName?: string },
): Promise<T> {
  const storage = getContextStorage();

  if (receiver) {
    emitFiberStarted(receiver, id, name, context.id, mode, extra);
  }

  const startTime = receiver ? performance.now() : 0;
  let caughtError: unknown;

  try {
    return await storage.runAsync(context, fn);
  } catch (error) {
    caughtError = error;
    throw error;
  } finally {
    if (receiver) {
      emitFiberSettled(receiver, id, startTime, caughtError);
    }
  }
}
