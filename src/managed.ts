// ---------------------------------------------------------------------------
// Managed awaits (DESIGN.md §4.2, D13, D39).
//
// A managed await is a `ManagedPromise`: a `Promise` subclass whose `then` is
// the whole protocol. `await`, `Promise.all/race/resolve`, an async `return`,
// `.catch` and `.finally` all reach the override, so:
//
// - "the body is suspended on this managed await" is the local fact "`then`
//   was called" (a stored, un-awaited managed promise is never rejected);
// - "a failure was consumed" is the local fact "a continuation was
//   resumed": `deliver` runs only in `then`'s fulfilment path, and never for
//   an awaiter that is rejected instead;
// - a rejection empties the cells it rejects, so nothing in ramme references
//   the awaiting continuation once it has run (A2), nor, since source
//   reactions are registered outside the awaiter's async context, its node
//   or context.
//
// Interruption is sticky rejection (D39): on a delivered `freeze` or
// `restore` node every managed await its body makes rejects with
// `InterruptedError(reason)`, one in flight at the delivery and every one
// made afterwards. Three shapes differ:
//
// - call-shaped awaits (`call`, `attempt`, `unshield`, `all`, `race`,
//   `settle`, and a `join` or `result` of a fiber subscribed below the
//   awaiter) reject only
//   when the awaited fiber completes: a call's awaiting node is lent to it
//   until then (D11), and a foreign `finally` around either must not run
//   while that work is still unwinding. The wrapper is *marked* at the
//   delivery, or at a `then` made after it, and the mark delivers a fiber the
//   delivery did not reach;
// - exempt awaits, release work (`release`, `releaseAll`, `close()` and
//   `[Symbol.asyncDispose]()` of a node below the awaiter, `shield`; A.3 of
//   D39), are never rejected, and their resume step consumes nothing when
//   the awaiter it resumes is an applied body;
// - every other managed await rejects at the delivery, or as soon as it is
//   awaited after it.
//
// A rejection is never delivered synchronously inside `then()` or inside the
// delivery: it is queued as a job under no frame and runs the cell's
// callbacks in the awaiter's captured context. When it comes is decided by
// the node the wrapper was made for; its class by the awaiter: the creating
// body, and top-level code (a `then` under no current node), get
// `InterruptedError`; any other awaiter gets `FiberAbortedError`, as for
// awaiting other work that was aborted. ramme's own subscriptions under no
// frame (`startBody`'s to a synchronous body's returned promise,
// `managed(p)`'s to a managed source) name the awaiter they act for
// (`thenFor`), so they are classified as that awaiter's own await.
//
// Every source ramme wraps never rejects, and the instance itself never
// settles, so no ramme-internal promise is an unhandled rejection (I10); a
// promise derived from a managed one by `then` does reject, as any promise
// does. The one user source, `managed(p)`, is left alone until it is awaited;
// from then on `p` is handled on every path, rejected or not, as `await p`
// would have handled it (D13).
//
// A failure handler is no body: every await made in its frame is
// untargeted, whichever node made the wrapper, and is delivered when the
// source settles (DESIGN.md §4.7). A rejection keeps the wrapper's source,
// resume step, `waitsFor` and sleep deadline, so a handler's await of a
// wrapper its parent's body was rejected on is still delivered.
//
// `sleep(ms)` is the managed await over a timer (DESIGN.md §4.2, D34). Its
// target's delivery clears the timer, whether the sleep is awaited or only
// stored, and rejects the awaiter; a target already applied arms no timer
// and rejects at once. A failure handler's await of such a sleep waits on a
// timer of its own, to the same deadline, so the delivery that clears the
// body's timer does not strand the handler.
// ---------------------------------------------------------------------------

import { NO_NODE, captureContext, currentFrame, hasStorage, peekCurrentNode, runDetached, runInFrame } from './context-storage.js';
import type { ContextRunner, HandlerRun } from './context-storage.js';
import { FiberAbortedError, InterruptedError } from './resource.js';

/** The subset of `NodeImpl` the interruption decision reads; `managed.test.ts` fakes it. */
export interface FreezeTarget {
  readonly hasBody: boolean;
  readonly mode: 'freeze' | 'observe' | 'restore';
  readonly kind: string;
  /**
   * Delivered and not `observe`: managed awaits made now reject (a call-shaped one when the awaited fiber completes).
   * Read on an awaiter too: an exempt await resumed in an applied body consumes nothing (D39, A.3).
   */
  readonly applied: boolean;
  /** The delivery's reason, read for the rejection's `.reason`. */
  readonly abortReason: unknown;
  /** The interrupt functions of in-flight managed awaits; delivery runs and clears them. */
  readonly onApplied: Set<() => void>;
  /** Read only to name the node in the dev-mode foreign-awaiter warning (DESIGN.md §4.4) and in a rejection's message. */
  readonly id?: number;
  readonly name?: string | undefined;
}

/**
 * Runs only when an awaiter is resumed: turns the source's value into the awaiter's value, may throw, and is where
 * a failure is consumed (D13). `applied` is true only for an exempt await resumed in an applied body (a `freeze` or
 * `restore` body delivered before it settled, whose throw the classification discards): the step then throws the
 * failure it would deliver but consumes nothing, so the holder's completion folds it in (D39, A.3). The awaiter
 * read is the one being resumed, which for a cross-body await is not the node the promise was made for.
 */
export type Deliver<S, T> = (value: S, applied: boolean) => T;

/**
 * How a managed await meets its target's delivery (D39). Absent: it rejects at the delivery, or as soon as it is
 * awaited after it.
 */
export interface Shape {
  /** Release work (DESIGN.md §4.2): never rejected; its resume step runs with `applied` set when the awaiter resumed is an applied body. */
  readonly exempt?: boolean;
  /**
   * Call-shaped: rejects only when the source, the awaited fiber's completion, settles. Called once, with the target,
   * when the wrapper is first marked, at the target's delivery or at a `then` made after it: it delivers a fiber
   * that delivery did not reach (A.2 of D39). It returns false when the await is not deferred after all (a `join` of
   * a fiber that is not subscribed below the target), and the wrapper then rejects as any other managed await.
   */
  readonly onMark?: (target: FreezeTarget) => boolean;
}

/** Whether a managed await waits for a node's completion; read only by a failure handler's await (DESIGN.md §4.7). */
export type WaitsFor = Parameters<HandlerRun['awaits']>[0];

/**
 * Told when an awaiting continuation starts waiting on a managed promise (`then` made a live cell) and
 * when it stops: it was delivered (after `deliver` ran) or rejected at its node's delivery. One call of
 * each per cell. An early release's owner reads it, so a failure about to be delivered to an awaiter is
 * not also folded into the owner's outcome (D16).
 */
export interface AwaitWatch {
  awaiting(): void;
  settled(): void;
}

type OnFulfilled = ((value: any) => unknown) | null | undefined;
type OnRejected = ((reason: any) => unknown) | null | undefined;

/**
 * One awaiting continuation; emptied when it is delivered or rejected. `run` re-enters the async context `then`
 * was called in (A2): the source's reaction is registered outside it, so the cell is the only holder of the
 * awaiter's context, and emptying the cell frees it with the callbacks.
 */
interface Cell {
  live: boolean;
  onF: OnFulfilled;
  onR: OnRejected;
  res: ((value: unknown) => void) | undefined;
  rej: ((reason: unknown) => void) | undefined;
  run: ContextRunner | undefined;
  /**
   * The node the awaiting continuation belongs to: the frame's node when `then` ran, or the node `thenFor` names;
   * `undefined` at top level. Its applied state is read when it is resumed (A.3). It adds nothing to what `run`
   * already retains, and goes with it.
   */
  awaiter: FreezeTarget | undefined;
  /** The awaiter is a node other than the target: a rejection is `FiberAbortedError`, not `InterruptedError` (D39). */
  readonly foreign: boolean;
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
 * Dev mode (DESIGN.md §4.4): a wrapper targeted at one node awaited by a different node's body is reported once per
 * creating node. A delivery to the creator rejects that await with `FiberAbortedError`, and the awaiter's own
 * delivery does not reject it (DESIGN.md §4.2). `await` and the combinators call `then` from a job queued in the
 * awaiter's frame, and ramme's own subscriptions under no frame name their awaiter (`thenFor`), so the check is exact
 * for them. Top-level code (no awaiter) is not reported.
 */
function checkAwaiter(t: FreezeTarget, cur: FreezeTarget | undefined): void {
  if (cur === undefined || cur === t || !cur.hasBody || reportedForeign.has(t) || !devMode()) return;
  reportedForeign.add(t);
  console.warn(
    `ramme: a managed promise created in the body of ${describeTarget(t)} is awaited by ${describeTarget(cur)}. ` +
      'Await a managed promise (join, result, call, managed(p), never(), sleep(ms), interrupted(), close(), release(x)) only in the body that created it: ' +
      `a delivery to its creator rejects this await with FiberAbortedError, and a delivery to ${describeTarget(cur)} does not reject it.`,
  );
}

/** An awaiter whose throw the classification discards (D24): a `freeze` or `restore` body delivered before it settled. */
function discardsThrow(a: FreezeTarget | undefined): boolean {
  return a !== undefined && a.hasBody && a.applied;
}

/** What a rejected awaiter receives (D39): its own interruption, or, for an awaiter other than the creator, another node's abort. */
function interruption(t: FreezeTarget, foreign: boolean): Error {
  return foreign
    ? new FiberAbortedError(t.abortReason, `${describeTarget(t)} was interrupted while this awaited its managed promise`)
    : new InterruptedError(t.abortReason);
}

/**
 * Reject a continuation in a job queued now under no frame (DESIGN.md §6), never inside the `then()` or the delivery
 * that decided it; the callbacks run in the awaiter's captured context, as a source reaction's do (A2).
 */
function rejectSoon(c: Taken, reason: unknown): void {
  runDetached(() => queueMicrotask(() => c.run(() => rejectWith(c, reason))));
}

function empty(c: Cell): void {
  c.live = false;
  c.onF = undefined;
  c.onR = undefined;
  c.res = undefined;
  c.rej = undefined;
  c.run = undefined;
  c.awaiter = undefined;
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

/**
 * A settled source reaches a continuation: `deliver` first on fulfilment, then the callbacks (D13). `applied`: an
 * exempt await whose awaiting node is applied, whose step consumes nothing (D39).
 */
function deliverTo<S>(c: Taken, deliver: Deliver<S, unknown> | undefined, fulfilled: boolean, x: unknown, applied: boolean): void {
  if (!fulfilled) return rejectWith(c, x); // only managed(p) can get here: ramme's own sources never reject
  let out: unknown = x;
  if (deliver !== undefined) {
    try {
      out = deliver(x as S, applied); // DELIVERY: the only place a failure is consumed (D13)
    } catch (e) {
      return rejectWith(c, e);
    }
  }
  fulfilWith(c, out);
}

/**
 * A managed await over `source`.
 *
 * - `target` undefined: nothing can be interrupted (no current node, an `observe` body, a release fiber). `then`
 *   chains at once; delivery still happens only in `then`.
 * - `source` undefined: `never()`, `interrupted()` on a body awaiting its own node's delivery, or a sleep on an
 *   applied target, which armed no timer. Only the target's delivery settles it, by rejecting it.
 * - `then` on an applied target rejects in a job queued at once (D39); a call-shaped wrapper is marked instead and
 *   rejects when the awaited fiber completes; an exempt one is never rejected.
 * - `then` in a failure handler's frame ignores the target (DESIGN.md §4.7).
 * - `thenFor(awaiter, …)` is `then` for a named awaiter, for ramme's own subscriptions under no frame.
 */
export class ManagedPromise<S, T = S> extends Promise<T> {
  /** Promises derived by the inherited `catch`/`finally` machinery are plain. */
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  readonly #target: FreezeTarget | undefined;
  readonly #source: Promise<S> | undefined;
  readonly #deliver: Deliver<S, T> | undefined;
  /** The node completions this await waits for (DESIGN.md §4.7). */
  readonly #waitsFor: WaitsFor | undefined;
  /** Told about each live cell (D16). */
  readonly #watch: AwaitWatch | undefined;
  /** Release work (D39, A.3): never rejected. */
  readonly #exempt: boolean;
  /** Call-shaped (D39, A.2): set until the wrapper is first marked, then dropped. */
  #onMark: ((target: FreezeTarget) => boolean) | undefined;
  /** A call-shaped wrapper whose target was delivered and whose mark deferred it: its cells reject when the awaited fiber completes, unresumed. */
  #marked = false;
  /** `interrupted()` on the awaiter's own node: the delivery source, read only by a failure handler's await (DESIGN.md §4.7). */
  #signalSource: Promise<S> | undefined = undefined;
  /**
   * A targeted `sleep(ms)`'s deadline (`Date.now()` based) and duration, read only by a failure handler's await,
   * which waits on a timer of its own (DESIGN.md §4.7, D34). Two numbers: nothing of the body.
   */
  #sleep: { readonly end: number; readonly ms: number } | undefined = undefined;
  /** A `then` after the delivery has marked the source handled (I10). */
  #handled = false;
  readonly #cells: Cell[] = [];
  readonly #onDeliveryFn = (): void => this.#onDelivery();

  constructor(
    target: FreezeTarget | undefined,
    source: Promise<S> | undefined,
    deliver?: Deliver<S, T>,
    waitsFor?: WaitsFor,
    watch?: AwaitWatch,
    shape?: Shape,
  ) {
    super(noop); // the instance itself never settles: `then` is the whole protocol
    this.#target = target;
    this.#source = source;
    this.#deliver = deliver;
    this.#waitsFor = waitsFor;
    this.#watch = watch;
    this.#exempt = shape?.exempt === true;
    this.#onMark = shape?.onMark;
  }

  /** `interrupted()` on a body awaiting its own node's delivery: no source for the body, `source` kept for a handler's await (DESIGN.md §4.7). */
  static signalFor<S>(target: FreezeTarget, source: Promise<S>): ManagedPromise<S, S> {
    const mp = new ManagedPromise<S, S>(target, undefined);
    mp.#signalSource = source;
    return mp;
  }

  /**
   * `sleep(ms)` with a target (D34): `source` is the target's timer, which its delivery clears, or `undefined` when
   * the target was already applied and no timer was armed.
   */
  static sleep(target: FreezeTarget, source: Promise<void> | undefined, ms: number): ManagedPromise<void, void> {
    const mp = new ManagedPromise<void, void>(target, source);
    mp.#sleep = { end: Date.now() + ms, ms };
    return mp;
  }

  override then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    const run = currentFrame()?.handler;
    if (run !== undefined) return this.thenAsHandler(run, onFulfilled, onRejected);
    return this.#subscribe(peekCurrentNode(), onFulfilled, onRejected);
  }

  /**
   * @internal `then` for `awaiter`, named rather than read from the frame: ramme's own subscriptions run under no
   * frame (DESIGN.md §6) on behalf of a node, `startBody`'s to a synchronous body's returned promise and `managed(p)`'s
   * to a managed source. The rejection's class and the applied-awaiter rule then follow that node, as they would for
   * its own `await` (D39, A.7, A.3); `undefined` is top-level code.
   */
  thenFor<R1 = T, R2 = never>(
    awaiter: FreezeTarget | undefined,
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#subscribe(awaiter, onFulfilled, onRejected);
  }

  #subscribe<R1, R2>(
    cur: FreezeTarget | undefined,
    onFulfilled: ((value: T) => R1 | PromiseLike<R1>) | null | undefined,
    onRejected: ((reason: any) => R2 | PromiseLike<R2>) | null | undefined,
  ): Promise<R1 | R2> {
    const t = this.#target;
    if (t !== undefined) checkAwaiter(t, cur);
    // The callbacks go into the cell and nowhere else: the only closure made
    // here is the executor, which is not retained, and the source's reactions
    // are made in #listen (V8 closures share their function's context), so
    // emptying the cell leaves them unreachable from ramme. The cell also
    // keeps the awaiter's async context, which the callbacks and `deliver`
    // run in, as they would in a reaction registered here (A2).
    const cell: Cell = {
      live: true,
      onF: onFulfilled,
      onR: onRejected,
      res: undefined,
      rej: undefined,
      run: captureContext(),
      awaiter: cur,
      foreign: cur !== undefined && cur !== t,
    };
    const derived = new Promise<R1 | R2>((res, rej) => {
      cell.res = res as (value: unknown) => void;
      cell.rej = rej;
    });
    const src = this.#source;
    const interruptible = this.#exempt ? undefined : t;
    if (interruptible?.applied === true) {
      if (!this.#defers(interruptible)) {
        // DESIGN.md §4.2: requested after delivery → rejects, in a job queued now; nothing is delivered. An awaited
        // managed(p) still marks p handled, once, with a reaction that holds nothing of the body; ramme's own
        // sources never reject, so for them it is inert (D13, I10).
        if (src !== undefined && !this.#handled) {
          this.#handled = true;
          runDetached(() => src.then(undefined, noop)); // outside the awaiter's context (A2)
        }
        rejectSoon(take(cell), interruption(interruptible, cell.foreign));
        return derived;
      }
      // call-shaped: the awaited fiber is delivered, and the cell rejects when it completes (D39, A.2)
    } else interruptible?.onApplied.add(this.#onDeliveryFn); // armed: an in-flight await meets the delivery
    this.#cells.push(cell);
    this.#watch?.awaiting(); // settled() follows at delivery or at the rejection (D16)
    if (src !== undefined) this.#listen(src, cell);
    return derived;
  }

  /**
   * @internal A failure handler's await (DESIGN.md §4.7): its own `await`, `.then` or combinator, or the parent's
   * hold on the promise the handler returned. The handler is not the creating body, and its parent waits for it,
   * so the await is untargeted whatever the wrapper's target: it arms nothing, is never rejected by a delivery, and
   * is delivered when the source settles. Its cell is its own, so a delivery that rejects the creating body's await
   * of the same wrapper leaves it, and the rejection kept the source and resume step it needs. An await on a node's
   * completion is reported to the run first. A targeted sleep's timer is the creating body's, which its delivery
   * clears (D34), so the handler waits on a timer of its own, to the same deadline, whether the body's is armed,
   * cleared or was never armed (an applied target).
   */
  thenAsHandler<R1 = T, R2 = never>(
    run: HandlerRun,
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    const waitsFor = this.#waitsFor;
    if (waitsFor !== undefined) run.awaits(waitsFor);
    const sl = this.#sleep;
    const src = sl !== undefined ? (timerUntil(sl.end, sl.ms) as Promise<unknown> as Promise<S>) : (this.#source ?? this.#signalSource);
    if (src === undefined) return neverPromise(); // never(): a wait nothing settles
    const deliver = this.#deliver as Deliver<S, unknown> | undefined;
    const watch = this.#watch;
    const cell: Cell = {
      live: true,
      onF: onFulfilled,
      onR: onRejected,
      res: undefined,
      rej: undefined,
      run: captureContext(),
      awaiter: undefined, // a handler is no body: never applied, and never rejected
      foreign: false,
    };
    const derived = new Promise<R1 | R2>((res, rej) => {
      cell.res = res as (value: unknown) => void;
      cell.rej = rej;
    });
    watch?.awaiting(); // never rejected, so settled() follows at delivery (D16)
    const settle = (fulfilled: boolean, x: unknown): void => {
      const c = take(cell);
      try {
        c.run(() => deliverTo(c, deliver, fulfilled, x, false)); // in the handler's context (A2)
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
   * keep the awaiting body's node and every async-context value it ran with alive until the source settles.
   * A managed source (`managed(p)` over another managed promise) is awaited for the cell's awaiter, so its
   * rejection is classified as that awaiter's own await of it would be (D39, A.7).
   */
  #listen(src: Promise<S>, cell: Cell): void {
    const onF = (v: S): void => this.#settle(cell, true, v);
    const onR = (e: unknown): void => this.#settle(cell, false, e);
    const awaiter = cell.awaiter;
    runDetached(() => (src instanceof ManagedPromise ? (src as ManagedPromise<unknown, S>).thenFor(awaiter, onF, onR) : src.then(onF, onR)));
  }

  #settle(cell: Cell, fulfilled: boolean, x: unknown): void {
    this.#forget(cell);
    if (!cell.live) return; // rejected at the delivery: the reaction holds an empty cell and does nothing
    const foreign = cell.foreign;
    // An exempt await resumed in an applied body consumes nothing (A.3). The awaiter is the one resumed, never the
    // node the promise was made for: a cross-body awaiter decides by its own state, whatever the creator's.
    const applied = this.#exempt && discardsThrow(cell.awaiter);
    const c = take(cell);
    const t = this.#target;
    const watch = this.#watch;
    try {
      if (this.#marked) {
        // Call-shaped and interrupted (D39, A.2): the awaited fiber has completed, so a call's lending has ended. The
        // resume step does not run: nothing is consumed, and the fiber's failure surfaces from its holder (D13).
        c.run(() => rejectWith(c, interruption(t!, foreign)));
        return;
      }
      c.run(() => deliverTo(c, this.#deliver as Deliver<S, unknown> | undefined, fulfilled, x, applied)); // in the awaiter's context (A2)
    } finally {
      watch?.settled(); // after `deliver`, so a failure it consumes is consumed by then (D16)
    }
  }

  #forget(cell: Cell): void {
    const i = this.#cells.indexOf(cell);
    if (i >= 0) this.#cells.splice(i, 1);
    if (this.#cells.length === 0) this.#target?.onApplied.delete(this.#onDeliveryFn);
  }

  /**
   * Call-shaped (D39, A.2): decided once, at the target's delivery or the first `then` after it, whichever comes
   * first. True when the cells reject only once the awaited fiber completes; the mark has then delivered that fiber
   * if the target's delivery did not reach it. False for every other wrapper.
   */
  #defers(t: FreezeTarget): boolean {
    const onMark = this.#onMark;
    if (onMark !== undefined) {
      this.#onMark = undefined;
      this.#marked = onMark(t);
    }
    return this.#marked;
  }

  /** The target's delivery (fire() pass 2b): every live cell is rejected in a queued job, or, call-shaped, the wrapper is marked. */
  #onDelivery(): void {
    const t = this.#target!;
    if (this.#defers(t)) return;
    const cells = this.#cells.splice(0);
    const watch = this.#watch;
    for (const cell of cells) {
      const foreign = cell.foreign;
      rejectSoon(take(cell), interruption(t, foreign));
    }
    for (let i = 0; i < cells.length; i++) watch?.settled(); // nothing was delivered; the failure stays unconsumed (D16)
  }
}

/**
 * DESIGN.md §4.2: the AWAITING body's node, never the receiver of a method call; `undefined` when nothing can be
 * interrupted. A failure handler's frame names the parent but is not its body (DESIGN.md §4.7): an await made there is
 * never rejected by the parent's delivery, so a handler the parent waits for resumes when its sources settle.
 */
function awaitTarget(): FreezeTarget | undefined {
  const f = currentFrame();
  if (f === undefined || f.handler !== undefined) return undefined;
  const cur: FreezeTarget | undefined = f.node ?? f.creation?.nodeIfCreated; // peekCurrentNode(), one frame read
  return cur !== undefined && cur.hasBody && cur.mode !== 'observe' && cur.kind !== 'release' ? cur : undefined;
}

/**
 * Every managed await ends here. The target is decided now, for `peekCurrentNode()` (top level, platform callbacks,
 * `ctx.run` frames, `observe` bodies, release fibers and failure handlers are never interrupted). `source` must never
 * reject, except for `managed(p)`, the one wrapper over a user promise.
 */
export function managedFor<S, T = S>(
  source: Promise<S>,
  deliver?: Deliver<S, T>,
  waitsFor?: WaitsFor,
  watch?: AwaitWatch,
): Promise<T> {
  return new ManagedPromise<S, T>(awaitTarget(), source, deliver, waitsFor, watch);
}

/**
 * A call-shaped managed await (D39, A.2): `source` is the awaited fiber's completion, and an interrupted awaiter is
 * rejected only when it settles. `onMark` delivers the fiber when the awaiter's delivery did not reach it, and
 * returns false when the await is not deferred after all (it then rejects at once).
 */
export function managedCall<S, T>(
  source: Promise<S>,
  deliver: Deliver<S, T>,
  onMark: (target: FreezeTarget) => boolean,
  waitsFor?: WaitsFor,
): Promise<T> {
  return new ManagedPromise<S, T>(awaitTarget(), source, deliver, waitsFor, undefined, { onMark });
}

/**
 * Release work (D39, A.3): exempt from the stickiness when `exempt(awaiter)` holds for the awaiting body's node,
 * decided now, as the target is. Otherwise an ordinary managed await.
 */
export function managedRelease<S, T = S>(
  exempt: (awaiter: FreezeTarget) => boolean,
  source: Promise<S>,
  deliver?: Deliver<S, T>,
  waitsFor?: WaitsFor,
  watch?: AwaitWatch,
): Promise<T> {
  const t = awaitTarget();
  return new ManagedPromise<S, T>(t, source, deliver, waitsFor, watch, { exempt: t !== undefined && exempt(t) });
}

/**
 * @internal The parent's hold on what a failure handler returned (DESIGN.md §4.7): a managed promise is
 * awaited as the handler's own await, anything else through its `then`. Call it outside every frame
 * (A2). May throw (a hostile `then`).
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

/**
 * The `never()` shape (DESIGN.md §4.2): with a target, a wrapper with no source, which only the target's delivery
 * settles, by rejecting it; a fresh pending promise otherwise.
 */
export function managedNever(): Promise<never> {
  const t = awaitTarget();
  return t !== undefined ? new ManagedPromise<never, never>(t, undefined) : neverPromise();
}

/** Run `fn` under `NO_NODE` (DESIGN.md §6): a timer ramme arms carries no node. */
function outsideFrames<R>(fn: () => R): R {
  return hasStorage() ? runInFrame(NO_NODE, fn) : fn();
}

/**
 * The `sleep(ms)` shape (DESIGN.md §4.2, D34); `ms` is already checked. The target is decided now, as for every
 * managed await. A target already applied (a body running after delivery, a fork born delivered) arms no timer,
 * and the sleep rejects as soon as it is awaited. Otherwise the timer is armed outside every frame and is not
 * unref'd: a sleep keeps the process alive like any timer, so a top-level `await app.sleep(n)` resolves. With a
 * target, a clear-only entry in its `onApplied` (the awaiter's own entry is what rejects it) clears the timer at
 * the target's delivery, awaited or only stored, and the timer removes that entry when it fires, so a long-lived
 * node accumulates nothing (A2). A failure handler that awaits a targeted sleep waits on a timer of its own to the
 * same deadline (`thenAsHandler`), which that delivery does not clear. Without a target (an `observe` body, a
 * release fiber, a failure handler, a `run` frame on a bodiless node, top level) the sleep runs its full duration.
 */
export function managedSleep(ms: number): Promise<void> {
  const t = awaitTarget();
  if (t !== undefined && t.applied) return ManagedPromise.sleep(t, undefined, ms);
  const { promise, resolve } = Promise.withResolvers<void>();
  if (t === undefined) {
    outsideFrames(() => setTimeout(resolve, ms));
    return new ManagedPromise<void, void>(undefined, promise);
  }
  const clear = (): void => clearTimeout(timer);
  const timer = outsideFrames(() =>
    setTimeout(() => {
      t.onApplied.delete(clear);
      resolve();
    }, ms),
  );
  t.onApplied.add(clear);
  return ManagedPromise.sleep(t, promise, ms);
}

/**
 * A failure handler's own wait for a targeted sleep (DESIGN.md §4.7, D34): resolves at `end`, and after at most `ms`
 * however the wall clock moves. Armed outside every frame and not unref'd, like the sleep's own timer; nothing
 * clears it. A module function, so the timer's closure shares no context with a target (A2).
 */
function timerUntil(end: number, ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  outsideFrames(() => setTimeout(resolve, Math.min(ms, Math.max(0, end - Date.now()))));
  return promise;
}

/**
 * The `interrupted()` shape (DESIGN.md §4.2). `source` is `receiver`'s delivery. When the awaiter is a `freeze` or
 * `restore` body and is the receiver itself, the body's await has no source: the delivery that would settle `source`
 * rejects the awaiter instead (D39), and must win over the source's reaction, which runs later. For any other
 * awaiter it is the sourced wrapper `managedFor` builds: an `observe` body, a release fiber or top level sees the
 * reason, and a body awaiting another node's interrupt is resumed by that node's delivery and rejected only by its
 * own. `source` must never reject.
 */
export function managedSignal<S>(source: Promise<S>, receiver: FreezeTarget): Promise<S> {
  const t = awaitTarget();
  return t !== undefined && t === receiver ? ManagedPromise.signalFor(t, source) : new ManagedPromise<S, S>(t, source);
}

/** A fresh promise that never settles; no shared constant is ever `.then`ed, so nothing is retained (A2). */
export function neverPromise(): Promise<never> {
  return new Promise<never>(noop);
}
