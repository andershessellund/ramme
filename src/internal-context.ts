// ---------------------------------------------------------------------------
// Internal shared types (IMPLEMENTATION.md §1.6). Not part of the public
// surface. Runtime content is limited to the task brand and its two helpers,
// so this module stays a leaf.
// ---------------------------------------------------------------------------

import type { InjectionKey } from './context-key.js';
import type { Body, FailureDestination, NodeOptions, TaskOptions } from './context.js';
import type { NodeImpl } from './node-impl.js';
import type { PoolState } from './pool.js';
import type { Scope } from './scope.js';

/** `'value'`: a DI value's node; an addition to §10's list (D-52). */
export type NodeKind = 'context' | 'fiber' | 'pool' | 'release' | 'value';

/** Which of its parent's stacks a node is pushed on at construction. */
export type StackKind = 'explicit' | 'provided' | 'none';

/**
 * One failure. The same object is the failing node's `failure` (or the
 * entry's, for an early release) and a member of the parent's `unconsumed`;
 * `consumed` flips when a continuation is delivered or the parent surfaces it
 * (D-40, D-41).
 */
export interface FailureRecord {
  readonly error: unknown;
  consumed: boolean;
}

export interface CacheEntry {
  readonly value: unknown;
  /** S, the storage context. */
  readonly node: NodeImpl;
  readonly autoHoisted: boolean;
  /** deps(V); `undefined` for declared placement. */
  readonly deps: ReadonlySet<InjectionKey<unknown>> | undefined;
  /** The value's node, if it attached anything. */
  readonly valueNode: NodeImpl | undefined;
  /**
   * The effective scope a scoped value was stored under (`p.scope ?? getKeyScope(key)`); `undefined`
   * for an unscoped provider and for auto-hoisted values. A hit is served only to a requester whose
   * nearest owner of this scope is the storage context (D-92).
   */
  readonly scope: Scope | undefined;
  /**
   * An auto-hoisted value built from a requester-relative read: a per-creation SelfScope value, a
   * `skipSelf` read, or a pinned dependency. It is served only to a requester at its storage context;
   * any other requester re-creates it from its own view (D-97).
   */
  readonly pinned: boolean;
}

export type ResolvedResult<T> = {
  resolved: true;
  value: T;
  node: NodeImpl;
  autoHoisted: boolean;
  deps: ReadonlySet<InjectionKey<unknown>> | undefined;
  /** A factory ran for this result (Q4 warning). */
  created: boolean;
  /** Requester-relative (D-97): a per-creation SelfScope result, or a pinned auto-hoisted value. Pins the tracking creation. */
  pinned: boolean;
};

export type ResolveResult<T> = ResolvedResult<T> | { resolved: false };

/** The brand of a task definition (fiber.ts `TaskImpl`, or an inline body made anonymous by `toTask`). */
export const TASK: unique symbol = Symbol('ramme.task');

export interface TaskLike<A extends unknown[] = unknown[], T = unknown> {
  readonly [TASK]: true;
  readonly name: string;
  readonly body: Body<T, A>;
  readonly opts: TaskOptions;
}

export function isTask(x: unknown): x is TaskLike {
  return typeof x === 'object' && x !== null && (x as { readonly [TASK]?: unknown })[TASK] === true;
}

/** A task as is; an inline body becomes an anonymous task `{ name: body.name || 'anonymous', opts: {} }` (Q17). */
export function toTask<A extends unknown[], T>(t: TaskLike<A, T> | Body<T, A>): TaskLike<A, T> {
  if (isTask(t)) return t as TaskLike<A, T>;
  if (typeof t !== 'function') throw new TypeError('expected a task or a function');
  return { [TASK]: true, name: t.name || 'anonymous', body: t, opts: {} };
}

export interface BodyInfo {
  readonly fn: Body<unknown, unknown[]>;
  readonly args: unknown[];
  readonly destination: FailureDestination;
  readonly taskName: string;
}

export interface NodeInit {
  kind: NodeKind;
  /** `undefined`: a root, or a pending value node. */
  parent: NodeImpl | undefined;
  /**
   * Pending value node only: the requester R, which supplies `root` (for
   * events) and provisional depth/autoScopeRoot/inherited timeouts until
   * `placeAt` (D-42).
   */
  basis?: NodeImpl;
  opts: NodeOptions;
  subscribed: boolean;
  /** Which of `parent`'s stacks the node is pushed on at construction. */
  stack: StackKind;
  body?: BodyInfo;
  pool?: PoolState;
  /** A value node awaiting placement (state `'pending'`, parent `undefined`). */
  pending?: boolean;
}
