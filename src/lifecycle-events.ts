// ---------------------------------------------------------------------------
// Lifecycle events — observable context and fiber lifecycle via topics
//
// These topics carry structured events about context creation/disposal,
// resource registration, and fiber start/settle. They are standard
// DI-based topics — provide a receiver to start observing.
// ---------------------------------------------------------------------------

import { createTopic } from './topic.js';
import type { ContextStatus } from './context.js';

// ---------------------------------------------------------------------------
// ContextEvent — context and resource lifecycle events
// ---------------------------------------------------------------------------

export type ContextEvent =
  | {
      type: 'context:created';
      id: number;
      parentId: number | null;
      depth: number;
      scopes: string[];
      name?: string;
    }
  | { type: 'context:status'; id: number; status: ContextStatus }
  | { type: 'context:aborted'; id: number }
  | { type: 'resource:registered'; contextId: number; resourceIndex: number; resourceName?: string }
  | {
      type: 'resource:unregistered';
      contextId: number;
      resourceIndex: number;
      resourceName?: string;
    };

/**
 * Topic for context lifecycle events.
 *
 * Emits events when contexts are created, change status, are aborted,
 * or when resources are registered/unregistered.
 *
 * Provide a receiver on the root context to observe all context activity:
 * ```ts
 * createRootContext({
 *   providers: [valueProvider(ContextTopic, (e) => console.log(e))],
 * });
 * ```
 */
export const ContextTopic = createTopic<ContextEvent>('context');

// ---------------------------------------------------------------------------
// FiberEvent — fiber lifecycle events
// ---------------------------------------------------------------------------

export type FiberEvent =
  | {
      type: 'fiber:started';
      id: number;
      name: string;
      contextId: number;
      mode: 'call' | 'spawn' | 'fork' | 'lifecycle';
      phase?: 'drain' | 'flush' | 'dispose';
      resourceName?: string;
    }
  | {
      type: 'fiber:settled';
      id: number;
      outcome: 'success' | 'error';
      durationMs: number;
      error?: string;
    }
  | {
      type: 'call:enter';
      callId: number;
      name: string;
      contextId: number;
    }
  | {
      type: 'call:leave';
      callId: number;
      outcome: 'success' | 'error';
      durationMs: number;
      error?: string;
    }
  | {
      type: 'join:enter';
      joinedFiberId: number;
      contextId: number;
    }
  | {
      type: 'join:leave';
      joinedFiberId: number;
      outcome: 'success' | 'error';
      durationMs: number;
      error?: string;
    };

/**
 * Topic for fiber lifecycle events.
 *
 * Emits events when fibers start and settle.
 *
 * Provide a receiver on the root context to observe all fiber activity:
 * ```ts
 * createRootContext({
 *   providers: [valueProvider(FiberTopic, (e) => console.log(e))],
 * });
 * ```
 */
export const FiberTopic = createTopic<FiberEvent>('fiber');
