// ---------------------------------------------------------------------------
// Managed awaits (DESIGN.md §4.2, D13).
//
// A managed await is a `ManagedPromise`: a `Promise` subclass whose `then` is
// the whole protocol. `await`, `Promise.all/race/resolve`, an async `return`,
// `.catch` and `.finally` all reach the override, so:
//
// - "the body is suspended on this managed await" is the local fact "`then`
//   was called" (a stored, un-awaited managed promise freezes nothing);
// - "a failure was consumed" is the local fact "a continuation was
//   delivered": `deliver` runs only in `then`'s non-cut fulfilment path;
// - a cut empties every cell, so nothing in ramme references a frozen
//   body's continuation (A2), nor, since source reactions are registered
//   outside the awaiter's async context, its node or context.
//
// The instance itself never settles, and every source ramme wraps never
// rejects, so no ramme-internal promise can be an unhandled rejection (I10).
// The one user source, `managed(p)`, is left alone until it is awaited; from
// then on `p` is handled on every path, frozen or not, as `await p` would
// have handled it (D13).
//
// "Suspended" is "`then` was called and its continuation is not yet
// delivered". That is exact for a direct await, ramme's `all`/`race`, and a
// `Promise.all` that fulfils over managed wrappers whose `deliver` consumes
// nothing unless it throws. Unsupported in a freeze body (DESIGN.md §4.2, §4.4):
// `Promise.race`/`any`, a `Promise.all` that rejects, `Promise.allSettled`, a
// `result()` member of a combinator, a bare member, a `.then`/`.catch`/
// `.finally` attached to a managed promise without awaiting the result at
// once (await the wrapper directly and transform the value afterwards), and
// a managed promise awaited by any body but the one that created it.
//
// A failure handler is no body: every await made in its frame is
// untargeted, whichever node made the wrapper, and is delivered when the
// source settles (DESIGN.md §4.7).
// ---------------------------------------------------------------------------

import { NO_NODE, captureContext, currentFrame, hasStorage, peekCurrentNode, runDetached, runInFrame } from './context-storage.js';
import type { ContextRunner, HandlerRun } from './context-storage.js';

/** The subset of `NodeImpl` the freeze decision reads; `managed.test.ts` fakes it. */
export interface FreezeTarget {
  readonly hasBody: boolean;
  readonly mode: 'freeze' | 'observe' | 'restore';
  readonly kind: string;
  /** Delivered and not `observe`: managed awaits requested now never settle. */
  readonly applied: boolean;
  /** Cut functions of in-flight managed awaits; delivery runs and clears them. */
  readonly onApplied: Set<() => void>;
  /** The body counts as frozen (idempotent). */
  markFrozen(): void;
  /** Read only to name the node in the dev-mode foreign-awaiter warning (DESIGN.md §4.4). */
  readonly id?: number;
  readonly name?: string | undefined;
}

/** Runs only in `then`'s delivered path: turns the source's value into the awaiter's value, may throw, and is where a failure is consumed (D13). */
export type Deliver<S, T> = (value: S) => T;

/** Whether a managed await waits for a node's completion; read only by a failure handler's await (DESIGN.md §4.7). */
export type WaitsFor = Parameters<HandlerRun['awaits']>[0];

/**
 * Told when an awaiting continuation starts waiting on a managed promise (`then` made a live cell) and
 * when it stops: it was delivered (after `deliver` ran) or a cut emptied it. One call of each per cell.
 * An early release's owner reads it, so a failure about to be delivered to an awaiter is not also folded
 * into the owner's outcome (D16).
 */
export interface AwaitWatch {
  awaiting(): void;
  settled(): void;
}

type OnFulfilled = ((value: any) => unknown) | null | undefined;
type OnRejected = ((reason: any) => unknown) | null | undefined;

/**
 * One awaiting continuation; emptied on delivery and on a cut. `run` re-enters
 * the async context `then` was called in (A2): the source's reaction is
 * registered outside it, so the cell is the only holder of the awaiter's
 * context, and a cut that empties the cell frees it with the callbacks.
 */
interface Cell {
  live: boolean;
  onF: OnFulfilled;
  onR: OnRejected;
  res: ((value: unknown) => void) | undefined;
  rej: ((reason: unknown) => void) | undefined;
  run: ContextRunner | undefined;
}

/** A cell's continuation, taken out of the cell before any user code runs. */
interface Taken {
  readonly onF: OnFulfilled;
  readonly onR: OnRejected;
  readonly res: (value: unknown) => void;
  readonly rej: (reason: unknown) => void;
  readonly run: ContextRunner;
}

function noop(): void {}

/**
 * Cut-only wrappers (`never()`, and `interrupted()` through `managedSignal`)
 * hold no cells, so cutting one is only counting the body frozen: they share
 * one cut per target, and `Set` deduplication keeps `onApplied` at one entry
 * however many of them a loop races (A2; DESIGN.md §4.2, §4.4). The value captures its own
 * key, which a `WeakMap` does not keep alive.
 */
const cutOnlyByTarget = new WeakMap<FreezeTarget, () => void>();

function cutOnlyFor(t: FreezeTarget): () => void {
  let cut = cutOnlyByTarget.get(t);
  if (cut === undefined) {
    cut = () => t.markFrozen();
    cutOnlyByTarget.set(t, cut);
  }
  return cut;
}

/**
 * The applied path's freeze: `markFrozen` one microtask later, queued under
 * `NO_NODE` (DESIGN.md §6). `await`, the combinators and an async `return` call `then`
 * from a job, after the body suspended, so for them this is the same freeze; a
 * `.then`/`.catch` the body attaches in its own synchronous code can then never
 * run the owner's releases inside that code (DESIGN.md §4.4).
 */
function freezeSoon(t: FreezeTarget): void {
  const freeze = (): void => t.markFrozen();
  if (hasStorage()) runInFrame(NO_NODE, () => queueMicrotask(freeze));
  else queueMicrotask(freeze);
}

/** Dev mode is `process.env.NODE_ENV !== 'production'`, and always on where `process` is absent (DESIGN.md §4.4). */
function devMode(): boolean {
  return (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV !== 'production';
}

function describeTarget(t: FreezeTarget): string {
  return `${t.kind}${t.id !== undefined ? ` #${t.id}` : ''}${t.name !== undefined ? ` '${t.name}'` : ''}`;
}

/** Creating nodes already reported by the foreign-awaiter warning: once per node. */
const reportedForeign = new WeakSet<FreezeTarget>();

/**
 * Dev mode (DESIGN.md §4.4): a wrapper targeted at one node is awaited by a different
 * node's body. A delivery to the creator would cut that body's continuation
 * without counting it frozen, and count the creator frozen although it is not
 * suspended here (DESIGN.md §4.2). `await` and the combinators call `then` from a job
 * queued in the awaiter's frame, so the check is exact for them. A `then`
 * under no node is not reported: `startBody` subscribes to a synchronous
 * body's returned wrapper under `NO_NODE` (DESIGN.md §6), which is the creator's own await.
 */
function checkAwaiter(t: FreezeTarget): void {
  const cur: FreezeTarget | undefined = peekCurrentNode();
  if (cur === undefined || cur === t || !cur.hasBody || reportedForeign.has(t) || !devMode()) return;
  reportedForeign.add(t);
  console.warn(
    `ramme: a managed promise created in the body of ${describeTarget(t)} is awaited by ${describeTarget(cur)}. ` +
      'Await a managed promise (join, result, call, managed(p), never(), interrupted(), close(), release(x)) only in the body that created it: ' +
      `a delivery to its creator cuts this await without freezing ${describeTarget(cur)}, which then never resumes, ` +
      'and counts the creator frozen although it is not suspended on it.',
  );
}

function empty(c: Cell): void {
  c.live = false;
  c.onF = undefined;
  c.onR = undefined;
  c.res = undefined;
  c.rej = undefined;
  c.run = undefined;
}

function take(c: Cell): Taken {
  const t: Taken = { onF: c.onF, onR: c.onR, res: c.res!, rej: c.rej!, run: c.run! };
  empty(c);
  return t;
}

/** Promise-handler semantics: a non-callable handler passes the value through; a throwing one rejects. */
function fulfilWith(c: Taken, value: unknown): void {
  if (typeof c.onF !== 'function') return c.res(value);
  let out: unknown;
  try {
    out = c.onF(value);
  } catch (e) {
    return c.rej(e);
  }
  c.res(out);
}

function rejectWith(c: Taken, reason: unknown): void {
  if (typeof c.onR !== 'function') return c.rej(reason);
  let out: unknown;
  try {
    out = c.onR(reason);
  } catch (e) {
    return c.rej(e);
  }
  c.res(out);
}

/** A settled source reaches a continuation: `deliver` first on fulfilment, then the callbacks (D13). */
function deliverTo<S>(c: Taken, deliver: Deliver<S, unknown> | undefined, fulfilled: boolean, x: unknown): void {
  if (!fulfilled) return rejectWith(c, x); // only managed(p) can get here: ramme's own sources never reject
  let out: unknown = x;
  if (deliver !== undefined) {
    try {
      out = deliver(x as S); // DELIVERY: the only place a failure is consumed (D13)
    } catch (e) {
      return rejectWith(c, e);
    }
  }
  fulfilWith(c, out);
}

function warnSpentInHandler(): void {
  if (!devMode()) return;
  console.warn(
    'ramme: a failure handler awaits a managed promise whose creating body was already counted frozen on it; ' +
      'it never settles, and the handler holds its parent open. Await the source in the handler instead, ' +
      'or make the managed promise in the handler.',
  );
}

/**
 * A managed await over `source`.
 *
 * - `target` undefined: nothing can freeze (no current node, an `observe`
 *   body, a release fiber). `then` chains at once; delivery still happens
 *   only in `then`.
 * - `source` undefined: cut-only (`never()`, or `interrupted()` through
 *   `managedSignal`, on a freeze node awaiting its own interrupt). The callbacks are dropped in `then`;
 *   delivery freezes the body through the target's shared cut-only function
 *   (A2; DESIGN.md §4.2, §4.4).
 * - `then` on an applied target never settles and counts the body frozen one
 *   microtask later (DESIGN.md §4.4); a cut at delivery counts it frozen at once.
 * - `then` in a failure handler's frame ignores the target (DESIGN.md §4.7).
 */
export class ManagedPromise<S, T = S> extends Promise<T> {
  /** Promises derived by the inherited `catch`/`finally` machinery are plain. */
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  /** Dropped by a cut: a cut wrapper never needs its target again, and must not retain it (A2). */
  #target: FreezeTarget | undefined;
  #source: Promise<S> | undefined;
  #deliver: Deliver<S, T> | undefined;
  /** The node completions this await waits for; dropped with `#deliver` (DESIGN.md §4.7). */
  #waitsFor: WaitsFor | undefined;
  /** Told about each live cell (D16); dropped with `#deliver`. */
  #watch: AwaitWatch | undefined;
  /** A cut-only `interrupted()`'s delivery source, read only by a failure handler's await (DESIGN.md §4.7). */
  #signalSource: Promise<S> | undefined = undefined;
  readonly #cells: Cell[] = [];
  #cut = false;
  /** The creating body was counted frozen on this wrapper (a cut, or `then` after delivery). */
  #spent = false;
  readonly #cutFn = (): void => this.#onCut();

  constructor(
    target: FreezeTarget | undefined,
    source: Promise<S> | undefined,
    deliver?: Deliver<S, T>,
    waitsFor?: WaitsFor,
    watch?: AwaitWatch,
  ) {
    super(noop); // the instance itself never settles: `then` is the whole protocol
    this.#target = target;
    this.#source = source;
    this.#deliver = deliver;
    this.#waitsFor = waitsFor;
    this.#watch = watch;
  }

  /** `interrupted()` on a freeze body awaiting its own interrupt: cut-only (A2), `source` kept for a handler's await (DESIGN.md §4.7). */
  static cutOnlySignal<S>(target: FreezeTarget, source: Promise<S>): ManagedPromise<S, S> {
    const mp = new ManagedPromise<S, S>(target, undefined);
    mp.#signalSource = source;
    return mp;
  }

  override then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    const run = currentFrame()?.handler;
    if (run !== undefined) return this.thenAsHandler(run, onFulfilled, onRejected);
    const t = this.#target;
    if (t !== undefined) {
      checkAwaiter(t);
      if (t.applied) {
        // DESIGN.md §4.2: requested after delivery → never settles; nothing retained, nothing delivered.
        // An awaited managed(p) still marks p handled, once, with a reaction that holds nothing
        // of the body; ramme's own sources never reject, so for them it is inert (D13, I10).
        // A live cell means #listen already subscribed, and its pending cut still needs #deliver.
        const src = this.#source;
        if (src !== undefined && this.#cells.length === 0) {
          this.#source = undefined;
          this.#deliver = undefined;
          this.#waitsFor = undefined;
          this.#watch = undefined;
          runDetached(() => src.then(undefined, noop)); // outside the frozen body's context (A2)
        }
        this.#spent = true;
        freezeSoon(t); // never inside the body's synchronous code (DESIGN.md §4.4)
        return neverPromise();
      }
    }
    // A cut implies an earlier `then` whose #listen subscribed to the source, so it is already handled.
    if (this.#cut) return neverPromise();
    const src = this.#source;
    if (src === undefined) {
      if (t !== undefined) t.onApplied.add(cutOnlyFor(t)); // cut-only: the body is suspended here, and delivery freezes it
      return neverPromise();
    }
    // The callbacks go into the cell and nowhere else: the only closure made
    // here is the executor, which is not retained, and the source's reactions
    // are made in #listen (V8 closures share their function's context), so a
    // cut that empties the cell leaves them unreachable from ramme. The cell
    // also keeps the awaiter's async context, which the callbacks and `deliver`
    // run in, as they would in a reaction registered here (A2).
    const cell: Cell = { live: true, onF: onFulfilled, onR: onRejected, res: undefined, rej: undefined, run: captureContext() };
    const derived = new Promise<R1 | R2>((res, rej) => {
      cell.res = res as (value: unknown) => void;
      cell.rej = rej;
    });
    this.#cells.push(cell);
    t?.onApplied.add(this.#cutFn); // arm: an in-flight await is cut at delivery (D13)
    this.#watch?.awaiting(); // settled() follows at delivery or at the cut (D16)
    this.#listen(src, cell);
    return derived;
  }

  /**
   * @internal A failure handler's await (DESIGN.md §4.7): its own `await`, `.then` or combinator, or the parent's
   * hold on the promise the handler returned. The handler is not the creating body, and its
   * parent waits for it, so the await is untargeted whatever the wrapper's target: it arms no cut, takes
   * neither the applied path nor the cut-only one, and is delivered when the source settles. Its cell is
   * its own and never cut, so a delivery that cuts the creating body's await of the same wrapper leaves
   * it. An await on a node's completion is reported to the run first.
   */
  thenAsHandler<R1 = T, R2 = never>(
    run: HandlerRun,
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    const waitsFor = this.#waitsFor;
    if (waitsFor !== undefined) run.awaits(waitsFor);
    const src = this.#source ?? this.#signalSource;
    if (src === undefined) {
      // never(), or a wrapper the creating body was frozen on: its source and deliver step are gone (A2).
      if (this.#spent) warnSpentInHandler();
      return neverPromise();
    }
    const deliver = this.#deliver as Deliver<S, unknown> | undefined;
    const watch = this.#watch;
    const cell: Cell = { live: true, onF: onFulfilled, onR: onRejected, res: undefined, rej: undefined, run: captureContext() };
    const derived = new Promise<R1 | R2>((res, rej) => {
      cell.res = res as (value: unknown) => void;
      cell.rej = rej;
    });
    watch?.awaiting(); // never cut, so settled() follows at delivery (D16)
    const settle = (fulfilled: boolean, x: unknown): void => {
      const c = take(cell);
      try {
        c.run(() => deliverTo(c, deliver, fulfilled, x)); // in the handler's context (A2)
      } finally {
        watch?.settled();
      }
    };
    runDetached(() =>
      src.then(
        (v) => settle(true, v),
        (e) => settle(false, e),
      ),
    );
    return derived;
  }

  /**
   * Registered outside the awaiting body's async context (A2). The source can outlive the awaiter (a
   * foreign fiber's completion, a slow `managed(p)`); a reaction registered in the body's context would
   * keep the frozen body's node and every async-context value it ran with alive until the source settles.
   */
  #listen(src: Promise<S>, cell: Cell): void {
    runDetached(() =>
      src.then(
        (v) => this.#settle(cell, true, v),
        (e) => this.#settle(cell, false, e),
      ),
    );
  }

  #settle(cell: Cell, fulfilled: boolean, x: unknown): void {
    this.#forget(cell);
    if (!cell.live) return; // cut: the reaction holds an empty cell and does nothing
    const c = take(cell);
    const deliver = this.#deliver as Deliver<S, unknown> | undefined;
    const watch = this.#watch;
    try {
      c.run(() => deliverTo(c, deliver, fulfilled, x)); // in the awaiter's context (A2)
    } finally {
      watch?.settled(); // after `deliver`, so a failure it consumes is consumed by then (D16)
    }
  }

  #forget(cell: Cell): void {
    const i = this.#cells.indexOf(cell);
    if (i >= 0) this.#cells.splice(i, 1);
    if (this.#cells.length === 0) this.#target?.onApplied.delete(this.#cutFn);
  }

  #onCut(): void {
    this.#cut = true;
    this.#spent = true;
    const watch = this.#watch;
    const live = this.#cells.length;
    for (const c of this.#cells) empty(c);
    this.#cells.length = 0;
    this.#source = undefined;
    this.#deliver = undefined;
    this.#waitsFor = undefined;
    this.#watch = undefined;
    for (let i = 0; i < live; i++) watch?.settled(); // nothing was delivered; the failure stays unconsumed (D16)
    const t = this.#target;
    this.#target = undefined; // the source's pending reaction still holds `this` (A2)
    t?.markFrozen();
  }
}

/**
 * DESIGN.md §4.2: the AWAITING body's node, never the receiver of a method call; `undefined` when nothing can freeze.
 * A failure handler's frame names the parent but is not its body (DESIGN.md §4.7): an await made there is never cut
 * by the parent's delivery and never counts the parent frozen, so a handler the parent waits for resumes
 * when its sources settle.
 */
function freezeTarget(): FreezeTarget | undefined {
  const f = currentFrame();
  if (f === undefined || f.handler !== undefined) return undefined;
  const cur: FreezeTarget | undefined = f.node ?? f.creation?.nodeIfCreated; // peekCurrentNode(), one frame read
  return cur !== undefined && cur.hasBody && cur.mode !== 'observe' && cur.kind !== 'release' ? cur : undefined;
}

/**
 * Every managed await ends here. The freeze decision is made now, for
 * `peekCurrentNode()` (top level, platform callbacks, `ctx.run` frames,
 * `observe` bodies, release fibers and failure handlers cannot freeze). `source` must never
 * reject, except for `managed(p)`, the one wrapper over a user promise.
 */
export function managedFor<S, T = S>(
  source: Promise<S>,
  deliver?: Deliver<S, T>,
  waitsFor?: WaitsFor,
  watch?: AwaitWatch,
): Promise<T> {
  return new ManagedPromise<S, T>(freezeTarget(), source, deliver, waitsFor, watch);
}

/**
 * @internal The parent's hold on what a failure handler returned (DESIGN.md §4.7): a managed promise is
 * awaited as the handler's own await, anything else through its `then`. Call it outside
 * every frame (A2). May throw (a hostile `then`).
 */
export function thenAsHandler(
  r: PromiseLike<unknown>,
  run: HandlerRun,
  onFulfilled: () => void,
  onRejected: (reason: unknown) => void,
): void {
  if (r instanceof ManagedPromise) void r.thenAsHandler(run, onFulfilled, onRejected);
  else void r.then(onFulfilled, onRejected);
}

/** The `never()` shape: cut-only on a freeze awaiter, a fresh pending promise otherwise (A2; DESIGN.md §4.2). */
export function managedNever(): Promise<never> {
  const t = freezeTarget();
  return t !== undefined ? new ManagedPromise<never, never>(t, undefined) : neverPromise();
}

/**
 * The `interrupted()` shape (A2; DESIGN.md §4.2). `source` is `receiver`'s
 * delivery. When the awaiter is a freeze body and is the receiver itself, it
 * is cut-only: delivery is what settles `source`, and that same delivery cuts
 * the awaiter instead, so the shared cut-only path is exact and keeps
 * `onApplied` at one entry however many of them a loop races. For any
 * other awaiter it is the sourced wrapper `managedFor` builds: an `observe`
 * body, a release fiber or top level sees the reason, and a freeze body
 * awaiting another node's interrupt is resumed by that node's delivery and cut
 * only by its own. `source` must never reject.
 */
export function managedSignal<S>(source: Promise<S>, receiver: FreezeTarget): Promise<S> {
  const t = freezeTarget();
  return t !== undefined && t === receiver ? ManagedPromise.cutOnlySignal(t, source) : new ManagedPromise<S, S>(t, source);
}

/** A fresh promise that never settles; no shared constant is ever `.then`ed, so nothing is retained (A2). */
export function neverPromise(): Promise<never> {
  return new Promise<never>(noop);
}
