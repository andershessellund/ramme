// ---------------------------------------------------------------------------
// Pools (PROPOSAL.md §7.7; IMPLEMENTATION.md §1.10, §4.12, D-16, D-47).
//
// A pool is an unsubscribed bodiless node whose forks are its subscribers and
// always report to its `onFailure`. This module holds the concurrency queue
// and the intake rules; the node side (stacks, delivery, release) is NodeImpl.
// NodeImpl is a type-only import: fibers are built through `pool.makeFiber`.
// ---------------------------------------------------------------------------

import type { PoolOptions } from './context.js';
import type { TaskLike } from './internal-context.js';
import type { NodeImpl } from './node-impl.js';
import { PoolClosedError, PoolFullError } from './resource.js';

export class PoolState {
  /** Started and not complete (pooled fibers only, D-47). */
  running = 0;
  /** Created, attached, neither started nor settled (`whenFull: 'wait'`; D-81). */
  readonly waiting: NodeImpl[] = [];

  constructor(readonly opts: PoolOptions) {
    if (opts === null || typeof opts !== 'object') throw new TypeError('pool(opts): opts is required');
    if (typeof opts.name !== 'string') throw new TypeError('pool(opts): name must be a string');
    if (typeof opts.onFailure !== 'function') throw new TypeError('pool(opts): onFailure must be a function');
    const c = opts.concurrency;
    if (c !== undefined && !(Number.isInteger(c) && c >= 1))
      throw new TypeError(`pool(opts): concurrency must be an integer >= 1 (got ${String(c)})`);
    if (opts.whenFull !== undefined && opts.whenFull !== 'wait' && opts.whenFull !== 'reject')
      throw new TypeError(`pool(opts): whenFull must be 'wait' or 'reject'`);
  }

  get pending(): number {
    return this.waiting.length;
  }
}

function label(pool: NodeImpl): string {
  return `${pool.name ?? pool.kind}#${pool.id}`;
}

/** `pool.fork(t, ...args)`: intake rules (D-16), then create and admit or queue. */
export function poolFork(pool: NodeImpl, task: TaskLike, args: unknown[]): NodeImpl {
  const st = pool.poolState!;
  if (pool.delivered || pool.closeRequested) throw new PoolClosedError(`pool ${label(pool)} is closed`);
  const full = st.opts.concurrency !== undefined && st.running >= st.opts.concurrency;
  if (full && (st.opts.whenFull ?? 'wait') === 'reject')
    throw new PoolFullError(`pool ${label(pool)} is full (${st.opts.concurrency})`);
  const child = pool.makeFiber(task, args, st.opts.onFailure);
  // Settled at birth (an already-aborted opts.signal, D-13): it completed before `pooled` was set, so
  // poolChildComplete never sees it, and it is neither running nor waiting.
  if (child.state === 'complete') return child;
  child.pooled = true; // D-47: the only nodes poolChildComplete accounts for
  if (full) st.waiting.push(child);
  else {
    st.running++;
    child.scheduleStart();
  }
  return child;
}

/**
 * Called from `onBodyExit` when a pooled fiber settles without starting (D-13). A waiter leaves the
 * queue now, not at its completion, and stops counting (D-81): its own releases may still be in
 * flight, and a waiter that is neither queued nor started must never decrement `running`. A fiber that
 * was admitted but had not started yet stays in `running` until its completion.
 */
export function poolChildSettled(pool: NodeImpl, child: NodeImpl): void {
  const st = pool.poolState!;
  const i = st.waiting.indexOf(child);
  if (i < 0) return;
  st.waiting.splice(i, 1);
  child.pooled = false; // D-47: accounted for; poolChildComplete never sees it
}

/**
 * Called from `fire()` pass 2b when the pool itself is delivered, after its own exit (D-81). A
 * delivered pool starts nothing more (D-47), so a waiter still queued would never start: its loop has
 * already passed it (a close() that then gets an abort) or is parked behind an async entry. Each
 * settles `aborted` without running (D-13), newest first as the loop would.
 */
export function poolDelivered(pool: NodeImpl): void {
  const st = pool.poolState!;
  for (const w of [...st.waiting].reverse()) w.abortInternal(pool.abortReason); // delivered with the pool: settles it 'unstarted'
}

/** Called from `finishCompletion` for pooled fibers only (D-47): admitted ones, since a waiter that settles unstarted is unpooled (D-81). */
export function poolChildComplete(pool: NodeImpl, _child: NodeImpl): void {
  const st = pool.poolState!;
  st.running--;
  if (pool.delivered) return; // D-47: an aborted pool starts nothing more; its queue settled at the delivery (D-81)
  while (st.waiting.length > 0 && (st.opts.concurrency === undefined || st.running < st.opts.concurrency)) {
    const next = st.waiting.shift()!; // queued waiters have not settled: a settled one already left (D-81)
    st.running++;
    next.scheduleStart();
  }
}
