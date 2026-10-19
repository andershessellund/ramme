// ---------------------------------------------------------------------------
// NodeTopic — the node tree's lifecycle as one event stream (PROPOSAL.md §10;
// IMPLEMENTATION.md §1.14).
//
// A standard DI topic: provide a receiver on the root (at construction, D-32)
// to observe every node of that tree. Without a receiver nothing is emitted
// and nothing is allocated. Because every release is a fiber, "print the
// running tree and what each node awaits" is one query and covers shutdown.
// ---------------------------------------------------------------------------

import type { InterruptMode, Outcome } from './context.js';
import type { NodeKind, StackKind } from './internal-context.js';
import { createTopic } from './topic.js';

/** `'entry'` for `entry:*` events (their `id` is the owner's); otherwise the emitting node's kind. */
export type NodeEventKind = NodeKind | 'entry';

interface Base {
  /** A process-wide sequence number (observability only). */
  readonly seq: number;
  /** The emitting node; for `entry:*` events, the owner node. */
  readonly id: number;
  readonly kind: NodeEventKind;
  readonly parentId: number | null;
}

export type NodeEvent =
  | (Base & {
      type: 'node:created';
      name?: string;
      task?: string;
      stack: StackKind;
      subscribed: boolean;
      mode: InterruptMode;
    })
  | (Base & { type: 'node:placed'; storageId: number })
  | (Base & { type: 'node:started' })
  | (Base & { type: 'node:delivered'; reason: unknown })
  | (Base & { type: 'node:frozen' })
  | (Base & { type: 'node:settled'; outcome: Outcome<unknown>['status'] })
  | (Base & { type: 'node:lent'; childId: number })
  | (Base & { type: 'node:returned'; childId: number })
  | (Base & { type: 'node:releasing'; stack: 'explicit' | 'provided' })
  | (Base & { type: 'entry:registered'; entryName: string; stack: 'explicit' | 'provided' })
  | (Base & { type: 'entry:released'; entryName: string; stack: 'explicit' | 'provided'; error?: string })
  | (Base & { type: 'node:complete'; outcome: Outcome<unknown>['status'] })
  | (Base & { type: 'node:stalled'; sinceMs: number })
  | (Base & { type: 'join:enter'; joinedId: number })
  | (Base & { type: 'join:leave'; joinedId: number; outcome: Outcome<unknown>['status'] });

/** What `NodeImpl.emit` is given: the event without the fields it fills in. */
export type NodeEventInput = NodeEvent extends infer E
  ? E extends NodeEvent
    ? Omit<E, keyof Base>
    : never
  : never;

/**
 * The topic of node lifecycle events.
 *
 * ```ts
 * createRootContext({
 *   providers: [valueProvider(NodeTopic, (e) => console.log(e))],
 * });
 * ```
 */
export const NodeTopic = createTopic<NodeEvent>('node');
