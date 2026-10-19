// ---------------------------------------------------------------------------
// NodeImpl — every node of the tree (DESIGN.md §2, §4).
//
// One class is the root, a `child()`, a fiber, a pool, a release fiber and a
// DI value's node; kinds differ by three bits (has a body, subscribed,
// interrupt mode) plus a `kind` tag used for errors, events and the two
// kind-specific behaviours (pool intake, the fiber `then` trap).
//
// The pieces, in this order:
//
// - construction and delivery (DESIGN.md §4.1): two-pass delivery marks the
//   whole subscribed subtree before any listener runs (I9), then fires signals
//   and cuts in-flight managed awaits (the freeze, DESIGN.md §4.2);
// - body start, body exit and the release loop (DESIGN.md §2.4): the outcome
//   is fixed at settling (DESIGN.md §4.12), subscribers are interrupted, then
//   the explicit stack and the provided stack are released LIFO, re-reading
//   the top every step (an entry pushed during release is released next);
// - one release (DESIGN.md §2.4): every release runs in a release fiber that
//   is the current node while it runs (I14);
// - completion (DESIGN.md §4.12): release and unconsumed errors amend the
//   outcome once; the final failure is routed to its destination
//   (DESIGN.md §4.7);
// - awaiting (DESIGN.md §4.5, §2.7): every await ramme offers is a
//   ManagedPromise whose freeze decision is made for the awaiting body's node
//   (DESIGN.md §4.2) and whose `deliver` step is the only place a failure is
//   consumed (D13);
// - tasks, lending, all/race (DESIGN.md §4.5, §4.9, §4.8), creation hooks
//   (DESIGN.md §4.6, §3.3, §3.4), pools' node side (DESIGN.md §4.10),
//   get/own/run/runSync (DESIGN.md §4.11, §2.6), events (DESIGN.md §5).
// ---------------------------------------------------------------------------

import { getKeyDescription } from './context-key.js';
import type { InjectionKey } from './context-key.js';
import type {
  AllResult,
  Body,
  Context,
  FailureDestination,
  Fiber,
  InterruptMode,
  LookupOptions,
  NodeOptions,
  NodeState,
  Outcome,
  Pool,
  PoolOptions,
  Provider,
  Release,
  Task,
} from './context.js';
import { NO_NODE, currentCreation, currentFrame, hasStorage, runDetached, runInFrame } from './context-storage.js';
import type { HandlerRun } from './context-storage.js';
import {
  ContextKey,
  assertProviderPlacement,
  describeNode,
  misplacedScopedProviders,
  resolveFrom,
  resolveReceiver,
} from './inject.js';
import { TASK, toTask } from './internal-context.js';
import type { BodyInfo, CacheEntry, FailureRecord, NodeInit, NodeKind, TaskLike } from './internal-context.js';
import type { NodeEvent, NodeEventInput } from './lifecycle-events.js';
import { managedFor, managedNever, managedSignal, thenAsHandler } from './managed.js';
import type { AwaitWatch, WaitsFor } from './managed.js';
import { PoolState, poolChildComplete, poolChildSettled, poolDelivered, poolFork } from './pool.js';
import {
  AlreadyOwnedError,
  AsyncRunError,
  CreationViolationError,
  FiberAbortedError,
  FiberNotAwaitableError,
  NodeCompletedError,
  NotOwnedError,
  OwnerInterrupt,
  PendingNodeError,
  SuppressedErrorCtor,
  UnawaitedCallError,
  toDispose,
} from './resource.js';
import type { Scope } from './scope.js';
import { Stack } from './stack.js';
import type { Entry } from './stack.js';
import type { TopicReceiver } from './topic.js';

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

/** One process-wide counter for every node kind. */
let nextId = 0;
/** NodeEvent.seq (observability only). */
let seq = 0;

/** One shared empty set; `scopeSet` is never mutated after construction. */
const EMPTY_SCOPES: ReadonlySet<Scope> = new Set<Scope>();

function noop(): void {}

/** `x != null && typeof x.then === 'function'`. Never call it on a fiber: its `then` getter throws (DESIGN.md §4.5). */
function isPromise(x: unknown): x is PromiseLike<unknown> {
  return x != null && typeof (x as { then?: unknown }).then === 'function';
}

/** Dev mode (DESIGN.md §4.4) is `process.env.NODE_ENV !== 'production'`, and always on where `process` is absent. */
function dev(): boolean {
  return (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV !== 'production';
}

/** Run `fn` outside any frame (DESIGN.md §6): timers and microtasks ramme registers carry no node. */
function outsideFrames<R>(fn: () => R): R {
  return hasStorage() ? runInFrame(NO_NODE, fn) : fn();
}

/**
 * Mark a promise ramme received but hands to nobody as handled (I10), outside every frame (A2): `onRejected`
 * is all that ever sees its rejection. A native promise is handled through `Promise.prototype.then`, never a
 * subclass's override: calling a ManagedPromise's `then` would count as awaiting it (DESIGN.md §4.2). Never throws.
 */
function handleRejection(x: PromiseLike<unknown>, onRejected: (reason: unknown) => void): void {
  runDetached(() => {
    try {
      if (x instanceof Promise) void Promise.prototype.then.call(x, undefined, onRejected);
      else x.then(undefined, onRejected);
    } catch (e) {
      onRejected(e); // a thenable whose `then` throws
    }
  });
}

function reportReceiverError(err: unknown): void {
  console.error('ramme: a NodeTopic receiver threw or rejected; the event was dropped', err); // never breaks the tree's bookkeeping
}

/**
 * What a failure handler may do on its own parent while the parent's body is lent (DESIGN.md §4.7, §4.9): resolve,
 * fork and make children. None of them awaits, enters the parent or lends it, so none of them is a forgotten
 * await (I26). `call`, `all`, `race`, `run` and the managed awaits through the parent stay refused, so
 * `lentTo` is never touched. Through any other node a handler is checked as the receiver only.
 */
const HANDLER_MAY_WHILE_LENT: ReadonlySet<string> = new Set(['get', 'fork', 'child', 'pool', 'runSync']);

function unref<T>(t: T): T {
  (t as { unref?: () => void }).unref?.();
  return t;
}

/** The longest delay `setTimeout` and `AbortSignal.timeout` honour: a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A millisecond option (DESIGN.md §2.1) is `undefined`, `Infinity` (no timer), or a number in
 * [0, 2^31 - 1]. Checked when the node is built, so a bad value is a TypeError at
 * the call site rather than a timer that fires at once or an exception escaping a
 * release loop.
 */
function checkMs(opts: NodeOptions): void {
  for (const k of ['timeoutMs', 'releaseTimeoutMs', 'stallWarningMs'] as const) {
    const v: unknown = opts[k];
    if (v === undefined || v === Infinity) continue;
    if (typeof v !== 'number' || !(v >= 0 && v <= MAX_TIMER_MS))
      throw new TypeError(`${k} must be a number of milliseconds in [0, ${MAX_TIMER_MS}], or Infinity for none (got ${String(v)})`);
  }
}

/**
 * A release fiber's deadline (DESIGN.md §2.4): none for `undefined` or `Infinity`. Never throws on a value `checkMs`
 * accepted. Created outside any frame (DESIGN.md §6): the timer dispatches its abort in the async context
 * of its creation, which for release(x) in a factory is the creation frame.
 */
function releaseDeadline(ms: number | undefined): AbortSignal | undefined {
  return ms === undefined || ms === Infinity ? undefined : outsideFrames(() => AbortSignal.timeout(Math.ceil(ms)));
}

/** Names any value for an error message; `release(null)` must reach its NotOwnedError. */
function describe(value: unknown): string {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return String(value);
  if (isNodeImpl(value)) return describeNode(value);
  if (typeof value === 'function') return `function ${value.name || 'anonymous'}`;
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  return ctor?.name ? `a ${ctor.name}` : 'an object';
}

/**
 * `String(x)` that never throws, for event payloads: an error whose `toString` or `Symbol.toPrimitive`
 * throws, or that has no prototype (`Object.create(null)`), must not break the release it reports
 * (DESIGN.md §2.4; I10).
 */
function errorText(x: unknown): string {
  try {
    return String(x);
  } catch {
    try {
      return Object.prototype.toString.call(x);
    } catch {
      return '[unprintable error]'; // a revoked proxy
    }
  }
}

/** The name of a passive entry: a defer function's name, or the value's constructor name. */
function nameOf(target: object): string {
  if (typeof target === 'function') return target.name || 'defer';
  const ctor = (target as { constructor?: { name?: string } }).constructor;
  return ctor?.name && ctor !== Object ? ctor.name : 'entry';
}

type BodyResult =
  | { kind: 'returned'; value: unknown }
  | { kind: 'threw'; error: unknown }
  | { kind: 'frozen' }
  | { kind: 'bodiless' }
  | { kind: 'unstarted' };

/** DESIGN.md §4.12: classification by node state, never by inspecting the error (I13). */
function classify(n: NodeImpl, r: BodyResult): Outcome<unknown> {
  switch (r.kind) {
    case 'unstarted':
    case 'frozen':
      return { status: 'aborted', reason: n.abortReason };
    case 'bodiless':
      return n.delivered ? { status: 'aborted', reason: n.abortReason } : { status: 'success', value: undefined };
    case 'returned':
    case 'threw':
      if (n.applied) return { status: 'aborted', reason: n.abortReason }; // freeze/restore delivered before settling
      return r.kind === 'returned' ? { status: 'success', value: r.value } : { status: 'failure', error: r.error };
  }
}

/** `join` semantics; runs as a `deliver` step (D13): only for an awaiter that is actually resumed. */
function take<T>(f: NodeImpl): T {
  const o = f.outcome!;
  if (o.status === 'success') return o.value as T;
  f.consumeFailure(); // idempotent (DESIGN.md §4.12); a no-op for an aborted fiber
  if (o.status === 'failure') throw o.error;
  throw new FiberAbortedError(o.reason, `fiber ${describeNode(f)} was aborted`);
}

function asFiber(f: unknown, op: string): NodeImpl {
  if (!isNodeImpl(f) || f.kind !== 'fiber') throw new TypeError(`${op}(): expected a fiber`);
  return f;
}

/** `all`/`race` members run as `'join'` fibers of the group (DESIGN.md §4.8). */
function asJoinMember(t: unknown): TaskLike {
  const tl = toTask(t as TaskLike);
  return { [TASK]: true, name: tl.name, body: tl.body, opts: { ...tl.opts, onFailure: 'join' } };
}

/**
 * Turn a live entry into a release in flight until the returned function runs. An owner loop
 * that reaches it meanwhile waits on `e.done`, as for an early release (C7, D16), so the owner cannot
 * complete while a completed child's failure handler is still running, and no failure is lost (I11).
 * It covers the handler's synchronous part; a promise the handler returns holds the owner through
 * `handlerHolds` (DESIGN.md §4.7).
 */
function holdEntry(e: Entry): () => void {
  const { promise, resolve } = Promise.withResolvers<void>();
  e.state = 'releasing';
  e.done = promise;
  return () => {
    e.state = 'released'; // completed on its own (C5 "removed")
    e.stack.unlink(e);
    resolve();
  };
}

/** The first of `n` and its ancestors for which `pred` holds. */
function firstUp(n: NodeImpl, pred: (c: NodeImpl) => boolean): NodeImpl | undefined {
  for (let c: NodeImpl | undefined = n; c; c = c.parent) if (pred(c)) return c;
  return undefined;
}

/** `a` is `n` or one of its ancestors. */
function isAncestorOrSelf(a: NodeImpl, n: NodeImpl): boolean {
  return firstUp(n, (c) => c === a) !== undefined;
}

/** An await on `n`'s completion waits for every node at or below `n`, a handler's parent included (DESIGN.md §4.7). */
function completionOf(n: NodeImpl): WaitsFor {
  return (p) => isAncestorOrSelf(n, p);
}

/**
 * One run of a child's failure handler on `parent` (DESIGN.md §4.7). `hold` is the never-rejecting
 * promise in `parent.handlerHolds` while the run holds its parent open. A run that awaits the completion
 * of its parent or of an ancestor (close, [Symbol.asyncDispose], join, result, release, releaseAll) holds
 * nothing from then on: that completion waits for the parent's, which would wait for the run.
 */
class HandlerHold implements HandlerRun {
  hold: Promise<void> | undefined = undefined;
  detached = false;
  constructor(readonly parent: NodeImpl) {}

  awaits(waitsFor: WaitsFor): void {
    if (this.detached || !waitsFor(this.parent)) return;
    this.detached = true;
    this.parent.dropHandlerHold(this);
  }
}

/**
 * D16: the awaiters of one `release(x)` or `releaseAll()` call. While at least one is waiting (its
 * `then` made a live cell that is neither delivered nor cut), the call is in `owner.earlyAwaits`, and
 * the owner's release loop does not fold an early failure the call will deliver into the owner's
 * outcome: it waits until the awaiter is delivered, which consumes the failure, or cut, which leaves it
 * to the owner's completion (DESIGN.md §4.12, D16, I11). It holds what its `deliver` step
 * already holds: the owner and the entries it delivers.
 *
 * D16: the call also counts as awaited from its creation until an immediate `await` or combinator has
 * had its chance to call `then`, which they do one microtask after they are evaluated. A call nobody
 * awaits leaves the set within two microtasks, and its failure is then the owner's.
 */
class EarlyAwait implements AwaitWatch {
  #live = 0;
  /** D16: the count `hold()` made, not yet taken over by a real awaiter or dropped. */
  #provisional = false;
  constructor(
    readonly owner: NodeImpl,
    readonly entries: readonly Entry[],
  ) {}

  /**
   * D16: called once, before the call releases anything. The drop is two hops away, queued under no
   * frame (DESIGN.md §6): the first hop runs before the job the caller's `await` or combinator queues after the
   * call returns, and queues the drop behind that job, so a `then` made there always comes first.
   */
  hold(): this {
    this.#provisional = true;
    if (this.#live++ === 0) this.owner.earlyAwaits.add(this);
    outsideFrames(() => void Promise.resolve().then(() => queueMicrotask(() => this.#drop())));
    return this;
  }

  #drop(): void {
    if (!this.#provisional) return;
    this.#provisional = false;
    this.settled();
  }

  awaiting(): void {
    if (this.#live++ === 0) this.owner.earlyAwaits.add(this);
    this.#drop(); // D16: the first real awaiter takes over from the provisional count
  }

  settled(): void {
    if (--this.#live > 0) return;
    this.owner.earlyAwaits.delete(this);
    this.owner.wakeReleaseLoop?.(); // a loop waiting for this awaiter re-reads (the record is consumed now, or left)
  }

  /** This call will deliver a failure that nobody has consumed yet. */
  get owes(): boolean {
    return this.entries.some((e) => e.failure !== undefined && !e.failure.consumed);
  }
}

/**
 * The restore birth rule's source (D12): the nearest delivered node on the subscription path
 * up from `parent`. The walk stops after the first unsubscribed node it checks, because that node's
 * own parent never forwards to it (I4, D12): nothing below an undelivered pool, value node or release
 * fiber hears before that node's turn, whether it was forked before or after the owner's abort.
 */
function deliveredOnSubscriptionPath(parent: NodeImpl): NodeImpl | undefined {
  for (let c: NodeImpl | undefined = parent; c; c = c.parent) {
    if (c.delivered) return c;
    if (!c.subscribed) return undefined;
  }
  return undefined;
}

/**
 * Pass 2 of a delivery, in collection order (top-down): every signal fires
 * before any body is frozen or settled (I9), then in-flight managed awaits are
 * cut and bodiless nodes exit.
 */
function fire(marked: NodeImpl[]): void {
  for (const n of marked) {
    n.controller.abort(n.abortReason); // user abort listeners run here; the whole subtree is already marked
    n.deliveredResolvers?.resolve(n.abortReason);
    n.emit({ type: 'node:delivered', reason: n.abortReason });
  }
  // Only now, for every marked node at once: an abort() or close() from ANY listener of this pass, of a
  // node fired before or after the listener's own, waits for 2b, so no node of the delivery releases
  // before every signal of the delivery has fired (DESIGN.md §2.4, §4.1).
  for (const n of marked) n.firePending = false;
  for (const n of marked) {
    if (n.applied && n.onApplied.size > 0) {
      const cuts = [...n.onApplied];
      n.onApplied.clear();
      for (const cut of cuts) cut(); // in-flight managed awaits → markFrozen → the release starts now (law 4)
    }
    if (n.state === 'running' && !n.bodyDone) {
      if (!n.hasBody) {
        n.exitKind = 'interrupt';
        n.onBodyExit({ kind: 'bodiless' }); // a child() dies with its parent's interrupt
      } else if (n.bodyStarted) n.armStallTimer(); // node:stalled for any delivered body still running, observe included (DESIGN.md §4.4)
      else if (n.cancelOnFire) {
        n.exitKind = 'interrupt';
        n.onBodyExit({ kind: 'unstarted' }); // abort() reached it during 2a (DESIGN.md §4.6, §4.1)
      }
    }
    // D15: a delivered pool starts nothing more. Its loop has settled the waiters it reached; the rest
    // (behind an async entry, or already passed by a close()'s loop) settle now.
    if (n.poolState !== undefined) poolDelivered(n);
  }
}

export function isNodeImpl(x: unknown): x is NodeImpl {
  return x instanceof NodeImpl;
}

// ---------------------------------------------------------------------------
// NodeImpl
// ---------------------------------------------------------------------------

export class NodeImpl implements Context {
  // --- identity ---
  readonly id: number;
  readonly kind: NodeKind;
  /** opts.name; fibers default to the task name; release nodes `release:<entryName>`. */
  readonly name: string | undefined;

  // --- tree ---
  /** Written once by placeAt() for a pending value node; otherwise set in the constructor. */
  parent: NodeImpl | undefined;
  depth: number;
  root: NodeImpl;
  autoScopeRoot: NodeImpl;
  readonly captureAutoScoped: boolean;

  // --- the three bits (DESIGN.md §2.2) and options ---
  readonly hasBody: boolean;
  /** Nulled at completion, so nothing of the body is retained (A2). */
  body: BodyInfo | undefined;
  /** Flipped to false by owner.own(node). */
  subscribed: boolean;
  /** Created by poolFork: counted in the pool's running/pending; cleared when a waiter settles unstarted (D15). */
  pooled = false;
  readonly mode: InterruptMode;
  readonly childrenOnExit: 'interrupt' | 'await';
  /** opts ?? parent's (inherited); recomputed by placeAt. */
  releaseTimeoutMs: number | undefined;
  /** opts ?? parent's ?? 5000. */
  stallWarningMs: number;
  readonly ownReleaseTimeoutMs: number | undefined;
  readonly ownStallWarningMs: number | undefined;

  // --- state ---
  state: NodeState;
  /** This node's entry on its parent's stack (undefined: root, release node, pending value node). */
  entryOnOwner: Entry | undefined = undefined;

  // --- the two stacks and subscribers ---
  readonly explicit = new Stack('explicit');
  readonly provided = new Stack('provided');
  readonly subscribers = new Set<NodeImpl>();

  // --- interruption ---
  readonly controller = new AbortController();
  delivered = false;
  applied = false;
  /** Marked by a two-pass delivery whose pass 2a has not finished firing every node it marked (DESIGN.md §4.1). */
  firePending = false;
  /** abort() reached this unstarted body while firePending: pass 2b settles it 'unstarted' (DESIGN.md §4.6, §4.1). */
  cancelOnFire = false;
  abortReason: unknown = undefined;
  /** For interrupted(); created lazily; resolved when the delivery fires. */
  deliveredResolvers: PromiseWithResolvers<unknown> | undefined = undefined;
  /** ManagedPromise cut functions; run and cleared by fire(). */
  readonly onApplied = new Set<() => void>();
  stallTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  timeoutTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  linkedSignal: AbortSignal | undefined = undefined;
  onLinkedAbort: (() => void) | undefined = undefined;

  // --- lending (DESIGN.md §4.9) ---
  lentTo: NodeImpl | undefined = undefined;
  lender: NodeImpl | undefined = undefined;

  // --- body and outcome ---
  bodyStarted = false;
  bodyDone = false;
  /** The body was counted frozen (a later settle is reported, not applied; DESIGN.md §4.4). */
  frozen = false;
  closeRequested = false;
  exitKind: 'interrupt' | 'await' | undefined = undefined;
  /** Fixed at settling; amended once at completion (DESIGN.md §4.12). */
  outcome: Outcome<unknown> | undefined = undefined;
  /** The owner's loop's passive release failures and handler exceptions, in order. */
  readonly extraErrors: unknown[] = [];
  /**
   * One never-rejecting promise per async failure handler of a child, run with this node current and
   * not yet settled; a promise leaves the set when it settles. The release loop completes this node only
   * when the set is empty (DESIGN.md §4.7). Created on first use.
   */
  handlerHolds: Set<Promise<void>> | undefined = undefined;
  /**
   * Set only while the release loop waits for `handlerHolds` or `earlyAwaits`; an attached node entry,
   * a dropped hold and an early awaiter that stops waiting wake it (DESIGN.md §2.4, D16).
   */
  wakeReleaseLoop: (() => void) | undefined = undefined;
  /** D16: the `release(x)`/`releaseAll()` calls on this node with an awaiter still waiting; see `EarlyAwait`. */
  readonly earlyAwaits = new Set<EarlyAwait>();
  /** The error built from extraErrors + unconsumed at completion; what close() rejects with. */
  aggregatedExtra: unknown = undefined;
  /** Failures held for this node (I11, D16); a record leaves the set when delivered. */
  readonly unconsumed = new Set<FailureRecord>();
  /** This node's own final failure, created at completion; the same object sits in parent.unconsumed. */
  failure: FailureRecord | undefined = undefined;
  readonly completionResolvers: PromiseWithResolvers<void> = Promise.withResolvers<void>();

  // --- creation bookkeeping (value nodes) ---
  inCreation = false;
  readonly creationForks: NodeImpl[] = [];

  // --- pool ---
  /** A pool's queue and intake state, named `poolState` because `pool` is the `pool(opts)` method. */
  readonly poolState: PoolState | undefined;

  // --- resolution (read and written by inject.ts) ---
  providers: Map<InjectionKey<unknown>, Provider<unknown>> | undefined = undefined;
  readonly cache = new Map<InjectionKey<unknown>, CacheEntry>();
  readonly decided = new Set<InjectionKey<unknown>>();
  readonly scopeSet: Set<Scope> | undefined;
  /** Root only: keys whose creation is in progress in this tree; created on first use (DESIGN.md §3.3). */
  creating: Set<InjectionKey<unknown>> | undefined = undefined;
  /** An abandoned value node: the key of its failed creation, until it completes (DESIGN.md §3.3). */
  failedCreation: InjectionKey<unknown> | undefined = undefined;

  // --- observability (root only) ---
  /** null = not yet resolved. */
  receiver: TopicReceiver<NodeEvent> | undefined | null | 'resolving' = null;
  /** Keys already reported by the once-per-key dev warning on a late read (DESIGN.md §3.5, §4.4). */
  warnedKeys: Set<InjectionKey<unknown>> | undefined = undefined;

  // =========================================================================
  // Construction and delivery (DESIGN.md §4.1)
  // =========================================================================

  constructor(init: NodeInit) {
    init.parent?.assertOpen('attach'); // C3/I7 first: nothing is emitted or attached for a child of a complete node
    const opts = init.opts;
    checkMs(opts); // before anything is emitted or attached (DESIGN.md §2.1)
    this.id = ++nextId;
    this.kind = init.kind;
    this.parent = init.parent;
    this.hasBody = init.body !== undefined;
    this.body = init.body;
    this.poolState = init.pool;
    this.subscribed = init.subscribed;
    this.mode = opts.interrupt ?? 'freeze';
    this.childrenOnExit = opts.childrenOnExit ?? 'interrupt';
    this.name = opts.name ?? init.body?.taskName;
    this.captureAutoScoped = opts.captureAutoScoped ?? false;
    this.scopeSet = opts.scopes !== undefined && opts.scopes.length > 0 ? new Set(opts.scopes) : undefined;
    this.ownReleaseTimeoutMs = opts.releaseTimeoutMs;
    this.ownStallWarningMs = opts.stallWarningMs;
    const basis = init.parent ?? init.basis; // a pending value node borrows the requester
    if (basis !== undefined) {
      this.depth = basis.depth + 1;
      this.root = basis.root;
      this.autoScopeRoot = this.captureAutoScoped ? this : basis.autoScopeRoot;
      this.releaseTimeoutMs = opts.releaseTimeoutMs ?? basis.releaseTimeoutMs;
      this.stallWarningMs = opts.stallWarningMs ?? basis.stallWarningMs;
    } else {
      this.depth = 0;
      this.root = this;
      this.autoScopeRoot = this;
      this.releaseTimeoutMs = opts.releaseTimeoutMs;
      this.stallWarningMs = opts.stallWarningMs ?? 5000;
    }
    this.state = init.pending ? 'pending' : 'running';
    if (opts.providers !== undefined && opts.providers.length > 0) {
      this.providers = new Map();
      for (const p of opts.providers) {
        assertProviderPlacement(this, p, /* atConstruction */ true);
        this.providers.set(p.key, p);
      }
    }
    // Every node's FIRST event (DESIGN.md §5): before entry:registered, node:delivered, node:complete.
    this.emit({
      type: 'node:created',
      name: this.name,
      task: init.body?.taskName,
      stack: init.stack,
      subscribed: init.subscribed,
      mode: this.mode,
    });
    const parent = init.parent;
    if (parent !== undefined) {
      if (init.stack !== 'none') this.entryOnOwner = parent.attachNode(this, init.stack); // I15: synchronous
      if (init.subscribed) {
        parent.subscribers.add(this);
        // Birth rule (DESIGN.md §4.3, D12): delivered at birth iff the parent would have forwarded to
        // it. Only subscribers are forwarded to, so unsubscribed nodes hear at their turn (I4), and
        // a restore node's walk up stops at the first unsubscribed edge.
        const src =
          this.mode === 'restore'
            ? deliveredOnSubscriptionPath(parent)
            : this.mode === 'freeze' && parent.delivered && parent.mode !== 'observe'
              ? parent
              : undefined;
        if (src !== undefined) this.markDelivered(src.abortReason);
      }
    }
    if (opts.timeoutMs !== undefined && opts.timeoutMs !== Infinity) {
      const ms = opts.timeoutMs; // at most 2^31 - 1, so Node never clamps it to 1 ms (DESIGN.md §2.1)
      this.timeoutTimer = outsideFrames(() =>
        unref(setTimeout(() => this.abortIfOpen(new DOMException('Timed out', 'TimeoutError')), ms)),
      );
    }
    const signal = opts.signal;
    if (signal !== undefined) {
      this.linkedSignal = signal;
      if (signal.aborted) this.abortInternal(signal.reason); // settles an unstarted fiber without running it (DESIGN.md §4.6)
      else {
        this.onLinkedAbort = () => this.abortIfOpen(signal.reason);
        signal.addEventListener('abort', this.onLinkedAbort, { once: true });
      }
    }
  }

  /** The node's entry on `stackKind` of this node. I24: the only path onto `provided` is a value node's construction or placeAt. */
  attachNode(child: NodeImpl, stackKind: 'explicit' | 'provided'): Entry {
    this.assertOpen('attach');
    const stack = stackKind === 'explicit' ? this.explicit : this.provided;
    const e = stack.push({
      target: child,
      name: child.name ?? `${child.kind}#${child.id}`,
      node: child,
      dispose: noop,
      state: 'live',
      done: undefined,
      failure: undefined,
      early: false,
    });
    this.emit({ type: 'entry:registered', entryName: e.name, stack: stackKind });
    if (stackKind === 'explicit') this.wakeReleaseLoop?.(); // released next, even while handlers hold this node (DESIGN.md §2.4)
    return e;
  }

  abort(reason?: unknown): void {
    if (this.state === 'complete') return; // idempotent (DESIGN.md §2.7)
    if (this.state === 'pending') throw new PendingNodeError(`abort() on pending node ${describeNode(this)}`);
    this.abortInternal(reason === undefined ? new DOMException('This operation was aborted', 'AbortError') : reason);
  }

  /** abort() without the I7/pending checks; used by release loops, destinations, timers and linked signals. */
  abortInternal(reason: unknown): void {
    if (this.state === 'complete') return; // nothing to deliver to: no node:delivered after node:complete
    if (!this.delivered) {
      const marked: NodeImpl[] = [];
      this.deliver(reason, /* restoreOnly */ false, marked); // pass 1: mark the whole subscribed subtree (I9)
      fire(marked); // pass 2: signals, cuts, bodiless exits
    } else if (this.firePending) {
      // Marked by a delivery whose pass 2a is still running (an abort listener re-entering; DESIGN.md §4.1).
      // That pass fires every signal of the delivery, this node's and its subscribers', and then 2b exits
      // this node, so its releases never run before those signals.
      if (this.hasBody && !this.bodyStarted) this.cancelOnFire = true; // an unstarted body still never runs on a direct abort (DESIGN.md §4.6)
      return;
    }
    // A body that never started is cancelled before it runs (DESIGN.md §4.6); a bodiless node exits on abort (DESIGN.md §2.4).
    if (this.state === 'running' && (!this.hasBody || !this.bodyStarted)) {
      this.exitKind = 'interrupt';
      this.onBodyExit(this.hasBody ? { kind: 'unstarted' } : { kind: 'bodiless' });
    }
  }

  /**
   * Deliver whenever the node is still open (I7: running, settling or releasing): own-signal
   * sources (timeoutMs, a linked signal) and the 'link'/C5 escalation (DESIGN.md §2.6, §4.7). On a
   * releasing node the delivery reaches its remaining subtree, as a later abort() does (DESIGN.md §2.7).
   */
  abortIfOpen(reason: unknown): void {
    if (this.state !== 'complete' && this.state !== 'pending') this.abortInternal(reason);
  }

  /** Pass 1 — no user code runs here. */
  deliver(reason: unknown, restoreOnly: boolean, marked: NodeImpl[]): void {
    if (restoreOnly && this.mode !== 'restore') {
      for (const s of this.subscribers) s.deliver(reason, true, marked); // pass-through, unmarked
      return;
    }
    if (this.delivered) return;
    this.markDelivered(reason, /* deferFire */ true);
    this.firePending = true; // until fire() pass 2a has fired every node it marked (DESIGN.md §4.1)
    marked.push(this);
    // Once the body has exited there is no observe body to decide for the subtree, so the delivery is
    // the interrupt DESIGN.md §2.4 step 1 fires on abort(): every subscriber, as a normal delivery. A later
    // abort also wins over a close()/'await' exit (DESIGN.md §2.7): node entries still ahead in the loop
    // are aborted.
    if (this.bodyDone && this.exitKind === 'await') this.exitKind = 'interrupt';
    const nextRestoreOnly = this.mode === 'observe' && !this.bodyDone;
    for (const s of this.subscribers) s.deliver(reason, nextRestoreOnly, marked);
  }

  markDelivered(reason: unknown, deferFire = false): void {
    this.delivered = true;
    this.abortReason = reason;
    this.applied = this.mode !== 'observe';
    if (!deferFire) {
      // Born-delivered nodes (DESIGN.md §5); two-pass deliveries do this in fire().
      this.controller.abort(reason);
      this.deliveredResolvers?.resolve(reason);
      this.emit({ type: 'node:delivered', reason });
    }
  }

  // =========================================================================
  // Body start, body exit, the release loop (DESIGN.md §2.4)
  // =========================================================================

  /** Fibers and release nodes: run the body under this node's frame; settles synchronously for a synchronous body. */
  startBody(): void {
    if (this.bodyDone || this.bodyStarted) return; // cancelled before start (DESIGN.md §4.6), or already running
    this.bodyStarted = true;
    this.emit({ type: 'node:started' });
    if (this.kind === 'release' || this.delivered) this.armStallTimer(); // a release fiber, or a body born delivered (DESIGN.md §4.4)
    const body = this.body!;
    let r: unknown;
    let settlesLater = false;
    try {
      r = runInFrame({ node: this, creation: undefined }, () => body.fn(...body.args));
      if (isNodeImpl(r) && r.kind === 'fiber')
        throw new FiberNotAwaitableError(
          `the body of ${describeNode(this)} returned a fiber; return join(f), or a value`,
        ); // a returned fiber is refused: the thenable probe below must never reach its `then` trap (DESIGN.md §4.5)
      // Any other node is a value, as an async body's `return ctx` makes it (DESIGN.md §4.5); run, too,
      // skips the thenable probe for a node.
      settlesLater = !isNodeImpl(r) && isPromise(r); // inside the try: a hostile `then` getter is a body failure (I10)
    } catch (e) {
      this.onBodyExit({ kind: 'threw', error: e });
      return;
    }
    if (settlesLater) {
      const p = r as PromiseLike<unknown>;
      r = undefined; // no reference to the body's promise is kept on the node
      // The settle reactions are registered under no frame, so onBodyExit → releaseLoop →
      // finishCompletion inherit neither the forker's nor a creation frame (DESIGN.md §6).
      try {
        runInFrame(NO_NODE, () =>
          p.then(
            (v) => this.onBodyExit({ kind: 'returned', value: v }),
            (e) => this.onBodyExit({ kind: 'threw', error: e }),
          ),
        );
      } catch (e) {
        this.onBodyExit({ kind: 'threw', error: e }); // a thenable whose `then` throws is a body failure, never an escape (I10)
      }
    } else this.onBodyExit({ kind: 'returned', value: r });
  }

  /** I20: never in the forker's frame. Forks under a node in creation start after placement (DESIGN.md §4.6). */
  scheduleStart(): void {
    const owner = this.creationOwner();
    if (owner !== undefined) owner.creationForks.push(this);
    else runInFrame(NO_NODE, () => queueMicrotask(() => this.startBody())); // under no frame (DESIGN.md §6)
  }

  /** The body is frozen: it never resumes (I6). Idempotent. */
  markFrozen(): void {
    this.onBodyExit({ kind: 'frozen' });
  }

  onBodyExit(r: BodyResult): void {
    if (this.bodyDone) {
      this.reportSettleAfterFrozen(r);
      return; // I2: once
    }
    this.bodyDone = true;
    if (r.kind === 'frozen') this.frozen = true;
    this.clearTimers();
    this.outcome = classify(this, r); // fixed NOW, readable by every release (DESIGN.md §2.8, §2.6)
    this.state = 'settling';
    if (this.pooled && r.kind === 'unstarted') poolChildSettled(this.parent!, this); // D15: a waiter leaves the queue now
    this.emit(r.kind === 'frozen' ? { type: 'node:frozen' } : { type: 'node:settled', outcome: this.outcome.status });
    // The immediate half of the destination: 'link' aborts the parent at once (DESIGN.md §4.7); so does an owned fiber (C5).
    // While the parent is open, not only while its body runs (DESIGN.md §2.6) — a parent closing or awaiting
    // its children is interrupted too, as a later abort() would (DESIGN.md §2.7).
    const parent = this.parent;
    if (
      this.kind === 'fiber' &&
      this.outcome.status === 'failure' &&
      parent !== undefined &&
      (this.body!.destination === 'link' || !this.subscribed)
    )
      parent.abortIfOpen(this.outcome.error);
    // 1. Signal (DESIGN.md §2.4): always after abort(); at a natural exit only under 'interrupt'; never under close().
    if (this.exitKind === undefined)
      this.exitKind = this.delivered ? 'interrupt' : this.closeRequested ? 'await' : this.childrenOnExit;
    if (this.exitKind === 'interrupt' && this.subscribers.size > 0) {
      // The exiting node is the origin of a new interrupt; it is not itself marked (DESIGN.md §2.4).
      const reason = this.delivered ? this.abortReason : new OwnerInterrupt(this);
      const marked: NodeImpl[] = [];
      for (const s of [...this.subscribers]) s.deliver(reason, false, marked);
      fire(marked);
    }
    // 2 + 3. Stacks.
    this.state = 'releasing';
    this.releaseLoop(); // synchronous while every release is synchronous; completes the node itself (I7)
  }

  /** A body that settles after it was counted frozen ran an unsupported await shape (DESIGN.md §4.2, §4.4). Reported, never applied (I6). */
  private reportSettleAfterFrozen(r: BodyResult): void {
    if (!this.frozen || (r.kind !== 'returned' && r.kind !== 'threw') || !dev()) return;
    console.warn(
      `ramme: the body of ${describeNode(this)} ${r.kind === 'returned' ? 'returned' : 'threw'} after it was counted frozen; ` +
        'its node was already released, so the result is ignored. The body awaited in an unsupported shape: ' +
        'Promise.race or Promise.any, a Promise.all that rejects, Promise.allSettled, a result() member of a combinator, ' +
        'a bare member of a combinator, a .then/.catch/.finally attached to a managed promise without awaiting it at once, ' +
        "or a managed promise awaited by a body other than the one that created it. Use ramme's all()/race(), " +
        'or await each managed promise directly.',
    );
  }

  private clearTimers(): void {
    if (this.timeoutTimer !== undefined) clearTimeout(this.timeoutTimer);
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
    this.timeoutTimer = undefined;
    this.stallTimer = undefined;
  }

  /**
   * Explicit stack, then provided stack, each LIFO; the top is re-read every
   * step, so an entry pushed during release is released next (DESIGN.md §2.4).
   * The node completes in the same step that finds both stacks empty (I7).
   */
  releaseLoop(): void {
    let phase: 'explicit' | 'provided' | undefined;
    // Both stacks were found empty while a child's async failure handler still held this node (DESIGN.md §4.7).
    // Until every hold settles, only node entries on the explicit stack are released: a fork, call, child
    // or pool the handler attaches has its turn as soon as it is attached (DESIGN.md §2.4), so a handler awaiting it
    // cannot hold this node forever, while the handler's passive entries and provided values stay its own.
    let holding = false;
    const step = (): void => {
      for (;;) {
        const holds = this.handlerHolds;
        const held = holds !== undefined && holds.size > 0;
        if (!held) holding = false;
        const e = holding ? this.explicit.topPendingNode() : (this.explicit.topPending() ?? this.provided.topPending());
        if (e === undefined) {
          if (held) {
            // The handler may still own, fork or fail here: wait for it, under no frame, then re-read.
            holding = true;
            this.waitForHolds(holds, step);
            return;
          }
          if (this.owesEarlyDelivery()) {
            // D16: an awaiter of release(x)/releaseAll() is about to be delivered a failure; it is that
            // call's alone (DESIGN.md §4.12). Wait until it is delivered or cut, under no frame, then re-read.
            this.waitForHolds(undefined, step);
            return;
          }
          this.finishCompletion();
          return;
        }
        if (phase !== e.stack.kind) {
          phase = e.stack.kind;
          this.emit({ type: 'node:releasing', stack: phase });
        }
        if (e.state === 'releasing') {
          // An early release(x) is in flight: wait for the shared promise (C7, D16). The continuation runs
          // under no frame, whatever frame started the loop (DESIGN.md §6).
          const done = e.done!;
          outsideFrames(() => void done.then(step));
          return;
        }
        const r = this.releaseEntry(e, /* early */ false); // never throws
        if (r !== undefined) {
          outsideFrames(() => void r.then(step));
          return;
        }
      }
    };
    step();
  }

  /**
   * `step` runs when every hold of the snapshot has settled, or earlier when a node entry is
   * attached or a hold is dropped (DESIGN.md §2.4). D16: without `holds`, it runs at the first wake, which an early
   * awaiter that stops waiting also gives.
   */
  private waitForHolds(holds: Set<Promise<void>> | undefined, step: () => void): void {
    const woken = Promise.withResolvers<void>();
    this.wakeReleaseLoop = woken.resolve;
    const wait = holds === undefined ? woken.promise : Promise.race([Promise.all(holds), woken.promise]);
    outsideFrames(
      () =>
        void wait.then(() => {
          this.wakeReleaseLoop = undefined;
          step();
        }),
    );
  }

  /** D16: an awaiter of an early release on this node is still waiting, and its call owes a failure nobody consumed. */
  private owesEarlyDelivery(): boolean {
    for (const w of this.earlyAwaits) if (w.owes) return true;
    return false;
  }

  // =========================================================================
  // One release — every release is a fiber (I14; DESIGN.md §2.4)
  // =========================================================================

  /** Never throws. Returns undefined when the release completed synchronously, else the entry's `done`. */
  releaseEntry(e: Entry, early: boolean): Promise<void> | undefined {
    if (e.state !== 'live') return e.state === 'released' ? undefined : e.done; // once (I2/C4/C7, D16)
    const deadline = releaseDeadline(this.releaseTimeoutMs); // before the entry changes (DESIGN.md §2.1)
    const { promise, resolve } = Promise.withResolvers<void>();
    e.state = 'releasing';
    e.early = early;
    e.done = promise; // exists BEFORE any dispose code runs (D16)
    const n = e.node;
    const action: () => void | Promise<void> = n !== undefined ? () => this.releaseNodeEntry(n) : e.dispose;
    const rf = new NodeImpl({
      kind: 'release',
      parent: this,
      subscribed: false,
      stack: 'none',
      opts: { name: `release:${e.name}`, interrupt: 'observe', signal: deadline },
      body: { fn: action, args: [], destination: noop, taskName: `release:${e.name}` },
    });
    rf.startBody(); // synchronous up to the first await; rf is current inside `action`
    // Never throws (I2, I10): it runs inside releaseLoop, fire() and settle reactions, where an exception
    // would strand the loop, skip the rest of a delivery or reject unhandled. The event text cannot
    // throw (errorText), the entry is released before any of it is built, and e.done settles whatever
    // happens: a loop that finds the entry 'releasing' waits on e.done, so the two must change together.
    const finish = (): void => {
      try {
        const o = rf.outcome!;
        if (o.status === 'failure') {
          if (e.early) {
            // D16: delivered to release()/releaseAll()'s awaiter, or surfaced by the owner's completion.
            e.failure = { error: o.error, consumed: false };
            this.unconsumed.add(e.failure);
          } else this.extraErrors.push(o.error); // C6: continue (DESIGN.md §4.12)
        }
        e.state = 'released';
        e.stack.unlink(e); // physical removal: no retention after unlink
        this.emit({
          type: 'entry:released',
          entryName: e.name,
          stack: e.stack.kind,
          error: o.status === 'failure' ? errorText(o.error) : undefined,
        });
      } finally {
        resolve();
      }
    };
    if (rf.state === 'complete') {
      finish(); // all-synchronous release (DESIGN.md §2.4)
      return undefined;
    }
    outsideFrames(() => void rf.completion.then(finish)); // not in a creation frame that started the release (DESIGN.md §6)
    return promise;
  }

  /** A node entry's release (DESIGN.md §2.4 step 2): close it under 'await' if subscribed, otherwise abort it; then await its completion. */
  private releaseNodeEntry(n: NodeImpl): Promise<void> | undefined {
    if (this.exitKind === 'await' && n.subscribed) void n.closeInternal(); // close()/'await': a recursive close that waits for the subtree (DESIGN.md §2.7)
    else n.abortInternal(this.delivered ? this.abortReason : new OwnerInterrupt(this));
    // A child whose subtree completed synchronously keeps the owner's loop synchronous (DESIGN.md §2.4).
    // `completion` never rejects: the child's failure reaches this node through `unconsumed`
    // (DESIGN.md §4.12, D16).
    return n.state === 'complete' ? undefined : n.completion;
  }

  // =========================================================================
  // Early release and releaseAll (DESIGN.md §2.6, §4.12)
  // =========================================================================

  release(value: object): Promise<void> {
    this.assertOpen('release'); // C3; pending allowed; lent allowed (DESIGN.md §4.9)
    const e = (typeof value === 'object' && value !== null) || typeof value === 'function' ? this.explicit.find(value) : undefined;
    if (e === undefined) throw new NotOwnedError(`release(): ${describe(value)} is not owned by ${describeNode(this)}`);
    // D16: the owner does not also surface what this call's awaiter is delivered, and the call is held from now,
    // since a synchronous release records its failure before an `await` of this call can call `then`.
    const watch = new EarlyAwait(this, [e]).hold();
    this.releaseEntry(e, /* early */ true); // runs now, in a release fiber; joins one in flight (D16)
    return managedFor(
      e.done!,
      () => {
        const f = e.failure;
        if (f !== undefined) {
          consume(this, f);
          throw f.error;
        }
      },
      e.node !== undefined ? completionOf(e.node) : undefined, // a node entry's release waits for its completion (DESIGN.md §4.7)
      watch,
    );
  }

  releaseAll(): Promise<void> {
    this.assertOpen('releaseAll');
    const entries = this.explicit.snapshotTopDown();
    const watch = new EarlyAwait(this, entries).hold(); // D16: before `run` releases the first entry
    const run = async (): Promise<FailureRecord[]> => {
      // never rejects
      for (const e of entries) {
        if (e.state === 'released') continue; // finished meanwhile by release(x) or by the owner's loop (I2)
        this.releaseEntry(e, true); // starts it, or joins the release in flight
        await e.done;
      }
      return entries.filter((e) => e.failure !== undefined).map((e) => e.failure!);
    };
    // The loop's continuations start later releases: they run under no frame, not the caller's (a factory's
    // creation frame; DESIGN.md §6). The managed await is still made here, for the caller (DESIGN.md §4.2).
    return managedFor(
      outsideFrames(run),
      (records) => {
        for (const r of records) consume(this, r);
        if (records.length === 1) throw records[0].error;
        if (records.length > 1)
          throw new AggregateError(
            records.map((r) => r.error),
            'releaseAll(): some releases failed',
          );
      },
      (p) => entries.some((e) => e.node !== undefined && isAncestorOrSelf(e.node, p)), // a handler awaiting one of them holds nothing (DESIGN.md §4.7)
      watch,
    );
  }

  // =========================================================================
  // Completion (DESIGN.md §4.12)
  // =========================================================================

  finishCompletion(): void {
    // Amend the outcome once with what the release phase produced (DESIGN.md §4.12).
    const extra = [...this.extraErrors];
    for (const rec of this.unconsumed)
      if (!rec.consumed) {
        extra.push(rec.error); // I11: surfaced once
        rec.consumed = true;
      }
    this.unconsumed.clear();
    if (extra.length > 0) {
      const agg = extra.length === 1 ? extra[0] : new AggregateError(extra, 'Errors during release');
      this.aggregatedExtra = agg;
      this.outcome =
        this.outcome!.status === 'failure'
          ? {
              status: 'failure',
              error: new SuppressedErrorCtor(agg, this.outcome!.error, 'Release failed after the body failed'),
            } // release-primary SuppressedError (DESIGN.md §4.12)
          : { status: 'failure', error: agg }; // success/aborted/bodiless + release failures → failure
    }
    this.state = 'complete';
    this.cache.clear();
    this.providers = undefined;
    this.decided.clear();
    this.failedCreation = undefined; // nothing below a complete node resolves (DESIGN.md §3.3)
    this.clearTimers();
    if (this.linkedSignal !== undefined && this.onLinkedAbort !== undefined)
      this.linkedSignal.removeEventListener('abort', this.onLinkedAbort);
    this.linkedSignal = undefined;
    this.onLinkedAbort = undefined;
    // Whichever side of a call completes first clears the lending pair, so nothing is retained (A2).
    const lender = this.lender;
    if (lender !== undefined) {
      if (lender.lentTo === this) {
        lender.lentTo = undefined;
        lender.emit({ type: 'node:returned', childId: this.id });
      }
      this.lender = undefined;
    }
    if (this.lentTo !== undefined) {
      this.lentTo.lender = undefined;
      this.lentTo = undefined;
    }
    const p = this.parent;
    const o = this.outcome!;
    p?.subscribers.delete(this); // a delivery the routing below starts never reaches this complete node
    // D15: a pooled fiber gives its slot back before its handler runs, so the pool's onFailure can
    // restart it; queued waiters are admitted first (their start is a microtask, and nothing completes here).
    if (this.pooled) poolChildComplete(p!, this);
    // Route this node's FINAL failure (DESIGN.md §4.7, §4.12, §2.8 "routed or collected"). Nothing below
    // can complete the parent before the routing is recorded on it, so no failure is lost (I11). The record is in p.unconsumed and this
    // node is off p's stack before the 'link'/C5 escalation, which runs last; a handler runs while this
    // node's entry holds p's release loop, so its exception lands on an open parent.
    const own = this.entryOnOwner;
    let escalate: { error: unknown } | undefined;
    if (p !== undefined && o.status === 'failure' && this.kind !== 'release') {
      const err = o.error;
      const record: FailureRecord = { error: err, consumed: false };
      this.failure = record;
      const d = this.kind === 'fiber' ? this.body!.destination : undefined;
      if (typeof d === 'function') {
        // The handler: called once, with the final failure, with the PARENT current, in a frame
        // marked as a handler's (DESIGN.md §4.7). A promise it returns holds the parent until it settles,
        // unless the handler awaits the parent's own completion or an ancestor's.
        record.consumed = true;
        const release = own !== undefined && own.state === 'live' ? holdEntry(own) : undefined;
        const run = new HandlerHold(p);
        try {
          const r: unknown = runInFrame({ node: p, creation: undefined, handler: run }, () =>
            d(err, this as unknown as Fiber<unknown>),
          );
          // A returned fiber is a value, never probed: its `then` getter throws (DESIGN.md §4.5). Inside the try:
          // a hostile `then` getter is a handler exception.
          if (!isNodeImpl(r) && isPromise(r)) p.holdForHandler(r, run);
        } catch (he) {
          p.extraErrors.push(he);
        }
        release?.();
      } else {
        p.unconsumed.add(record); // surfaces from the parent's completion unless delivered first (D16)
        if (d === 'link' || (this.kind === 'fiber' && !this.subscribed)) escalate = o;
      }
    }
    if (own !== undefined && own.state === 'live') {
      own.state = 'released'; // completed on its own (C5 "removed")
      own.stack.unlink(own);
    }
    this.body = undefined; // nothing of a completed node's body is retained (A2)
    this.emit({ type: 'node:complete', outcome: o.status });
    this.completionResolvers.resolve(); // never rejects (I10)
    if (escalate !== undefined) p!.abortIfOpen(escalate.error); // idempotent with the settle-time abort (DESIGN.md §4.7, §2.6; I11)
  }

  /** Never rejects; resolves at state 'complete'. */
  get completion(): Promise<void> {
    return this.completionResolvers.promise;
  }

  /**
   * `r` is what a child's failure handler returned. This node stays open until it settles (its
   * release loop waits on `handlerHolds`), so the handler's code after an await still runs on an open
   * parent (DESIGN.md §4.7), and a rejection is a handler exception (DESIGN.md §4.12), like a synchronous
   * throw. It is subscribed to outside every frame (A2); a managed promise is awaited as the handler's
   * own await, which nothing cuts, whichever body made it. A run that awaits this node's completion or an
   * ancestor's holds nothing: its rejection lands here while this node is open, else on the
   * console. Never throws.
   */
  holdForHandler(r: PromiseLike<unknown>, run: HandlerHold): void {
    runDetached(() => {
      const { promise, resolve } = Promise.withResolvers<void>();
      const fail = (he: unknown): void => {
        // A held run settles while the node is open (the loop waits for it); the console is a backstop
        // for a detached run.
        if (this.state !== 'complete') this.extraErrors.push(he);
        else console.error(`ramme: a failure handler on ${describeNode(this)} rejected after it completed`, he);
        resolve();
      };
      try {
        thenAsHandler(r, run, () => resolve(), fail);
      } catch (he) {
        fail(he); // a thenable whose `then` throws
      }
      if (run.detached) return; // it awaits this node's completion or an ancestor's
      const holds = (this.handlerHolds ??= new Set());
      run.hold = promise;
      holds.add(promise);
      // Before any waiter's reaction: the loop then sees the set without it.
      void promise.then(() => {
        holds.delete(promise);
        if (run.hold === promise) run.hold = undefined;
      });
    });
  }

  /** `run` awaits this node's completion or an ancestor's (DESIGN.md §4.7). It stops holding this node, and a loop waiting for it re-reads. */
  dropHandlerHold(run: HandlerHold): void {
    const h = run.hold;
    run.hold = undefined;
    if (h === undefined) return; // not held yet: holdForHandler sees `detached`
    this.handlerHolds?.delete(h);
    this.wakeReleaseLoop?.();
  }

  /** failure.consumed = true and out of the parent's set; idempotent; a no-op without a failure (DESIGN.md §4.12). */
  consumeFailure(): void {
    const r = this.failure;
    if (r === undefined) return;
    r.consumed = true;
    this.parent?.unconsumed.delete(r);
  }

  // =========================================================================
  // Awaiting: join, result, interrupted, never, managed, close, dispose (DESIGN.md §4.5, §4.2, §2.7)
  // =========================================================================

  /**
   * The node `join:enter`/`join:leave` name (DESIGN.md §5). DESIGN.md §4.2: the managed await belongs to
   * the AWAITING body's node (current()), not the receiver, as `callTask` lends it (DESIGN.md §4.9); with
   * no body awaiting (top level, a creation frame, a failure handler's frame), the receiver.
   */
  private awaiterNode(): NodeImpl {
    const frame = currentFrame();
    return (frame?.handler === undefined ? frame?.node : undefined) ?? this;
  }

  join<T>(fiber: Fiber<T>): Promise<T> {
    this.assertAwaitShaped('join');
    const f = asFiber(fiber, 'join');
    const awaiter = this.awaiterNode(); // the awaiting body's node, not the receiver (DESIGN.md §5)
    awaiter.emit({ type: 'join:enter', joinedId: f.id });
    return managedFor<void, T>(
      f.completion,
      () => {
        awaiter.emit({ type: 'join:leave', joinedId: f.id, outcome: f.outcome!.status }); // a frozen joiner never gets here
        return take<T>(f);
      },
      completionOf(f), // a handler awaiting it holds nothing (DESIGN.md §4.7)
    );
  }

  result<T>(fiber: Fiber<T>): Promise<Outcome<T>> {
    this.assertAwaitShaped('result');
    const f = asFiber(fiber, 'result');
    // result() is a join that reports the outcome instead of throwing it, so it emits the join events
    // too: the event stream shows what the awaiter waits on, on the awaiter (DESIGN.md §5).
    const awaiter = this.awaiterNode();
    awaiter.emit({ type: 'join:enter', joinedId: f.id });
    return managedFor<void, Outcome<T>>(
      f.completion,
      () => {
        awaiter.emit({ type: 'join:leave', joinedId: f.id, outcome: f.outcome!.status }); // a frozen awaiter never gets here
        f.consumeFailure();
        return f.outcome as Outcome<T>;
      },
      completionOf(f), // a handler awaiting it holds nothing (DESIGN.md §4.7)
    );
  }

  interrupted(): Promise<unknown> {
    this.assertAwaitShaped('interrupted');
    const d = (this.deliveredResolvers ??= Promise.withResolvers<unknown>());
    if (this.delivered) d.resolve(this.abortReason);
    return managedSignal(d.promise, this); // cut-only only when the awaiting body is this node, so a loop over it retains nothing (A2)
  }

  never(): Promise<never> {
    this.assertAwaitShaped('never');
    return managedNever();
  }

  managed<T>(promise: Promise<T>): Promise<T> {
    this.assertAwaitShaped('managed');
    return managedFor(promise); // the one wrapper over a user promise: its rejection is delivered as it is
  }

  close(): Promise<void> {
    if (this.state === 'pending') throw new PendingNodeError(`close() on pending node ${describeNode(this)}`);
    this.requestClose();
    return managedFor(this.completion, () => this.deliverClose(), completionOf(this)); // a handler awaiting it holds nothing (DESIGN.md §4.7)
  }

  /**
   * A bodiless node settles now, outcome success, no signal. A fiber waits for its body; exitKind is
   * decided at body exit ('await' unless abort() arrives first; DESIGN.md §2.7). A node marked by a
   * delivery whose pass 2a is still running is exited by that pass: the abort wins, after its signal
   * (DESIGN.md §4.1). An
   * abort that came first wins for a bodiless node too: a delivered one (born delivered, or reached from
   * 2b before its own turn) exits with the interrupt, as a fiber's body exit would (DESIGN.md §2.7, §4.1).
   */
  private requestClose(): void {
    if (this.state !== 'running' || this.closeRequested) return;
    this.closeRequested = true;
    if (!this.hasBody && !this.firePending) {
      this.exitKind = this.delivered ? 'interrupt' : 'await';
      this.onBodyExit({ kind: 'bodiless' });
    }
  }

  /** close()'s deliver step: rejects with the unconsumed failures; consumes a non-fiber's failure (D13, D16). */
  deliverClose(): void {
    if (this.aggregatedExtra === undefined) return;
    if (this.kind !== 'fiber') this.consumeFailure(); // a context/pool/value node: its failure IS aggregatedExtra
    throw this.aggregatedExtra; // a fiber: release/unconsumed errors only — its own body failure is join's (DESIGN.md §4.12)
  }

  /** close semantics for the release loop: returns `completion` (never rejects). */
  closeInternal(): Promise<void> {
    this.requestClose();
    return this.completion;
  }

  [Symbol.dispose](): void {
    if (this.state === 'pending') throw new PendingNodeError(`[Symbol.dispose]() on pending node ${describeNode(this)}`);
    if (this.parent === undefined)
      throw new TypeError('A root context has no owner to wait for its completion; use `await using` or close()');
    this.abort();
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.abort(); // the synchronous prefix delivers the signal (DESIGN.md §2.8); PendingNodeError on a pending node
    return managedFor(
      this.completion,
      () => {
        if (this.kind === 'fiber') take(this); // acts as join
        else if (this.outcome!.status === 'failure') {
          this.consumeFailure();
          throw (this.outcome as { error: unknown }).error;
        }
      },
      completionOf(this), // a handler awaiting it holds nothing (DESIGN.md §4.7)
    );
  }

  // =========================================================================
  // fork / call, lending, all / race (DESIGN.md §4.8, §4.9)
  // =========================================================================

  /** A subscribed fiber child of this node on its explicit stack (fork, call, pool.fork). Not started. */
  makeFiber(task: TaskLike, args: unknown[], destination: FailureDestination): NodeImpl {
    return new NodeImpl({
      kind: 'fiber',
      parent: this,
      subscribed: true,
      stack: 'explicit',
      opts: task.opts,
      body: { fn: task.body as Body<unknown, unknown[]>, args, destination, taskName: task.name },
    });
  }

  fork<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Fiber<T> {
    this.assertOpen('fork'); // pending allowed; a creation frame allowed (DESIGN.md §3.5)
    this.assertNotLent('fork');
    const task = toTask(t as unknown as TaskLike);
    if (this.poolState !== undefined) return poolFork(this, task, args) as unknown as Fiber<T>;
    const dest = task.opts.onFailure ?? 'join';
    if (dest === 'join' && !this.hasBody && this.creationOwner() === undefined)
      // Nothing would join it (D14): checked synchronously for live bodiless nodes; forks under a node in creation are checked at the end of creation.
      throw new TypeError(
        `fork(${task.name}) onto bodiless node ${describeNode(this)} with the default 'join' destination: nothing would join it. ` +
          'Pass onFailure (a handler or \'link\'), fork from a body, or use pool().',
      );
    const child = this.makeFiber(task, args, dest);
    if (child.state !== 'complete') child.scheduleStart(); // I20: never in the forker's frame
    return child as unknown as Fiber<T>;
  }

  call<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Promise<T> {
    this.assertBodyShaped('call');
    return this.callTask<T>('call', toTask(t as unknown as TaskLike), args);
  }

  /** `call`, and the group fiber of `all` and `race`: `op` is the method the user called, for the lending error. */
  private callTask<T>(op: 'call' | 'all' | 'race', task: TaskLike, args: unknown[]): Promise<T> {
    // DESIGN.md §4.9: `call` lends the CURRENT node (the awaiting body), not the receiver (D11). A current
    // node that is already lent has a call it did not await. A failure handler's frame is not its parent's
    // body, so a call made there lends nothing and checks nothing on the parent (DESIGN.md §4.7).
    const frame = currentFrame();
    const lender = frame?.handler !== undefined ? undefined : frame?.node;
    lender?.assertNotLent(op);
    const child = this.makeFiber(task, args, 'join');
    // A child settled at birth (an already-aborted signal; DESIGN.md §4.6) already ran finishCompletion, so
    // nothing would ever clear lentTo; it lends nothing.
    if (lender !== undefined && child.state !== 'complete') {
      child.lender = lender;
      lender.lentTo = child;
      lender.emit({ type: 'node:lent', childId: child.id });
    }
    child.startBody(); // DESIGN.md §4.6: synchronous, with the child current
    // The freeze decision is for current(), not for `this`; take runs only when the caller is resumed (D13).
    return managedFor<void, T>(child.completion, () => take<T>(child));
  }

  all<const T extends readonly Task<[], unknown>[]>(tasks: T, opts?: NodeOptions): Promise<AllResult<T>> {
    this.assertBodyShaped('all');
    const members = tasks.map(asJoinMember);
    const name = opts?.name ?? 'all';
    const group: TaskLike<[], unknown[]> = {
      [TASK]: true,
      name,
      opts: { ...opts, name },
      body: async () => {
        const g = currentFrame()!.node!; // the group fiber
        const fibers = members.map((m) => g.fork(m as unknown as Task<[], unknown>) as unknown as NodeImpl);
        // One managed await over never-rejecting sources (DESIGN.md §4.8, D13): the group freezes as a whole, and no
        // member's failure is consumed before every member has completed.
        await managedFor(Promise.all(fibers.map((f) => f.completion)));
        const failures: unknown[] = [];
        let aborted: { reason: unknown } | undefined;
        for (const f of fibers) {
          const o = f.outcome!;
          if (o.status === 'failure') {
            f.consumeFailure();
            failures.push(o.error);
          } else if (o.status === 'aborted') aborted ??= o;
        }
        if (failures.length > 0)
          throw new AggregateError(failures, `${failures.length} of ${fibers.length} tasks failed`); // every real failure (DESIGN.md §4.8)
        if (aborted !== undefined) throw new FiberAbortedError(aborted.reason, 'a task was aborted'); // an aborted member and no failure (DESIGN.md §4.8)
        return fibers.map((f) => (f.outcome as { value: unknown }).value);
      },
    };
    return this.callTask<unknown[]>('all', group, []) as unknown as Promise<AllResult<T>>;
  }

  race<T>(tasks: readonly Task<[], T>[], opts?: NodeOptions): Promise<T> {
    this.assertBodyShaped('race');
    if (tasks.length === 0) throw new TypeError('race() needs at least one task');
    const members = tasks.map(asJoinMember);
    const name = opts?.name ?? 'race';
    const group: TaskLike<[], T> = {
      [TASK]: true,
      name,
      opts: { ...opts, name },
      body: async () => {
        const g = currentFrame()!.node!;
        const fibers = members.map((m) => g.fork(m as unknown as Task<[], unknown>) as unknown as NodeImpl);
        const first = Promise.withResolvers<void>();
        let winner: NodeImpl | undefined;
        let remaining = fibers.length;
        for (const f of fibers)
          void f.completion.then(() => {
            if (winner === undefined && f.outcome!.status === 'success') {
              winner = f;
              first.resolve();
            }
            if (--remaining === 0) first.resolve();
          });
        await managedFor(first.promise); // one managed await; never rejects (DESIGN.md §4.8)
        const all = Promise.all(fibers.map((f) => f.completion));
        if (winner !== undefined) {
          for (const f of fibers) if (f !== winner && f.state === 'running') f.abort(); // abort and await the rest (DESIGN.md §4.8)
          await managedFor(all);
          for (const f of fibers) f.consumeFailure(); // a loser's failure is not the race's (DESIGN.md §4.8)
          return (winner.outcome as { value: T }).value;
        }
        await managedFor(all);
        const failures = fibers.filter((f) => f.outcome!.status === 'failure');
        for (const f of failures) f.consumeFailure();
        if (failures.length > 0)
          throw new AggregateError(
            failures.map((f) => (f.outcome as { error: unknown }).error),
            'every task failed',
          );
        throw new FiberAbortedError((fibers[0].outcome as { reason: unknown }).reason, 'every task was aborted'); // every member aborted (DESIGN.md §4.8)
      },
    };
    return this.callTask<T>('race', group, []);
  }

  pool(opts: PoolOptions): Pool {
    this.assertOpen('pool'); // pending allowed; a creation frame allowed
    this.assertNotLent('pool');
    const st = new PoolState(opts);
    return new NodeImpl({ kind: 'pool', parent: this, subscribed: false, stack: 'explicit', opts, pool: st }) as unknown as Pool;
  }

  child(opts?: NodeOptions): Context {
    this.assertOpen('child'); // pending allowed; a creation frame allowed
    this.assertNotLent('child');
    return new NodeImpl({ kind: 'context', parent: this, subscribed: true, stack: 'explicit', opts: opts ?? {} });
  }

  // =========================================================================
  // Creation hooks: value nodes and placement (DESIGN.md §3.3, §3.4)
  // =========================================================================

  /** `this` is the requester R. Pending (placement undefined) or live on placement.provided (DESIGN.md §3.3). */
  createValueNode(name: string, placement: NodeImpl | undefined): NodeImpl {
    const n =
      placement !== undefined
        ? new NodeImpl({ kind: 'value', parent: placement, subscribed: false, stack: 'provided', opts: { name } })
        : new NodeImpl({
            kind: 'value',
            parent: undefined,
            basis: this,
            subscribed: false,
            stack: 'none',
            opts: { name },
            pending: true,
          });
    n.inCreation = true;
    return n;
  }

  /** pending → running: parent, tree fix-up, the tail of S.provided (released next if S is releasing; DESIGN.md §3.3). */
  placeAt(S: NodeImpl): void {
    if (this.state !== 'pending') throw new Error(`placeAt on non-pending node ${describeNode(this)}`);
    S.assertOpen('place');
    if (S.root !== this.root) throw new Error(`placeAt: ${describeNode(S)} is not in the requester's tree`); // a pending node is born with its requester's root
    this.parent = S;
    this.fixTree(S);
    this.entryOnOwner = S.attachNode(this, 'provided');
    this.state = 'running';
    this.emit({ type: 'node:placed', storageId: S.id });
  }

  /**
   * A failed creation or a refused placement: the value is never cached, and its node is aborted like
   * any live node (DESIGN.md §3.3): one two-pass delivery to its subtree (I9), then both stacks. A pending node is
   * first placed at the requester R, or at the nearest open node above it when the factory completed R, so
   * that its owner waits for its releases (DESIGN.md §2.8), surfaces their failures (DESIGN.md §4.12) and
   * is the resolution parent of its release fibers (DESIGN.md §2.4). Its creation is over: forks its releases make from now on start
   * normally, and the forks queued during the creation are scheduled as finishCreation schedules them; the
   * abort's release loop settles those it reaches first without running them (DESIGN.md §4.6). With no open node
   * left (the factory completed the whole tree) it is released unowned.
   */
  abandon(error: unknown, requester: NodeImpl): void {
    const queued = this.creationForks.splice(0);
    this.inCreation = false;
    if (this.state === 'pending') {
      const host = firstUp(requester, (c) => c.state !== 'complete' && c.state !== 'pending');
      if (host !== undefined) {
        // A provider built under this node that the scoped-provider rule (DESIGN.md §3.4) refuses at host is dropped, so the
        // releases below never build its value at the scope owner.
        for (const m of misplacedScopedProviders(this, host)) m.node.providers?.delete(m.provider.key);
        this.placeAt(host);
      } else this.state = 'running';
    }
    if (this.state === 'running') this.abortInternal(error); // unlinked from its owner's stack by its completion
    if (queued.length > 0)
      outsideFrames(() => {
        for (const f of queued) queueMicrotask(() => f.startBody()); // under no frame (DESIGN.md §6); startBody skips a settled fork (DESIGN.md §4.6)
      });
  }

  /** A live declared value node moves to the tail of its storage context's provided stack when its creation ends (G3; DESIGN.md §3.3). */
  moveToProvidedTail(): void {
    const e = this.entryOnOwner;
    if (e !== undefined && e.state === 'live') e.stack.moveToTail(e);
  }

  /** Recompute depth, autoScopeRoot and inherited timeouts for this node and everything on its stacks. */
  fixTree(parent: NodeImpl): void {
    this.depth = parent.depth + 1;
    this.autoScopeRoot = this.captureAutoScoped ? this : parent.autoScopeRoot;
    this.releaseTimeoutMs = this.ownReleaseTimeoutMs ?? parent.releaseTimeoutMs;
    this.stallWarningMs = this.ownStallWarningMs ?? parent.stallWarningMs;
    for (const e of this.explicit) if (e.node !== undefined) e.node.fixTree(this);
    for (const e of this.provided) if (e.node !== undefined) e.node.fixTree(this);
  }

  /** The nearest ancestor-or-self with inCreation === true. */
  creationOwner(): NodeImpl | undefined {
    return firstUp(this, (c) => c.inCreation);
  }

  // =========================================================================
  // get, addProvider, own, run, runSync (DESIGN.md §3.2, §3.4, §2.6, §4.11)
  // =========================================================================

  get<T>(key: InjectionKey<T>): T;
  get<T>(key: InjectionKey<T>, options?: LookupOptions & { optional?: false | undefined }): T;
  get<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;
  get<T>(key: InjectionKey<T>, options?: LookupOptions): T | undefined {
    this.assertBodyShaped('get');
    if (key === (ContextKey as InjectionKey<unknown>))
      throw new CreationViolationError(
        'ContextKey can only be injected during creation; use current() at runtime',
      ); // only inject reads ContextKey (DESIGN.md §4.12)
    if (options?.skipSelf) {
      // The internal walk from the parent, not parent.get(): its guards are not this node's concern (DESIGN.md §3.2).
      if (this.parent === undefined) {
        if (options.optional) return undefined;
        throw new Error(`Cannot skipSelf for key '${getKeyDescription(key)}': no parent context exists.`);
      }
      const r = resolveFrom(this.parent, key);
      if (r.resolved) return r.value;
      if (options.optional) return undefined;
      throw new Error(`No provider found for key: ${getKeyDescription(key)}`);
    }
    const r = resolveFrom(this, key);
    if (r.resolved) {
      if (r.created && this.kind === 'value' && dev())
        this.warnOnce(
          key,
          `ramme: ${getKeyDescription(key)} was created by a late read on ${describeNode(this)}; declare it with inject() in the constructor`,
        ); // once per key per root, in development (DESIGN.md §3.5, §4.4)
      return r.value;
    }
    if (options?.optional) return undefined;
    throw new Error(`No provider found for key: ${getKeyDescription(key)}`);
  }

  private warnOnce(key: InjectionKey<unknown>, message: string): void {
    const seen = (this.root.warnedKeys ??= new Set());
    if (seen.has(key)) return;
    seen.add(key);
    console.warn(message);
  }

  addProvider<T>(provider: Provider<T>): void {
    this.assertOpen('addProvider');
    this.assertNotPending('addProvider');
    assertProviderPlacement(this, provider as Provider<unknown>, false);
    (this.providers ??= new Map()).set(provider.key, provider as Provider<unknown>);
  }

  own<T extends Disposable | AsyncDisposable>(resource: T): T;
  own<T extends object>(value: T, release: Release<T>): T;
  own<T extends object>(defer: T & (() => void | Promise<void>)): T;
  own(target: object, release?: Release<any>): object {
    this.assertOpen('own'); // C3; pending, delivered (C2) and lent (DESIGN.md §4.9) allowed
    if (isNodeImpl(target)) {
      // The first overload with a node: a brand check moves it from subscriber to non-subscriber (DESIGN.md §2.3).
      if (release !== undefined) throw new TypeError('own(node, release): a node releases itself');
      if (target.parent !== this || target.entryOnOwner === undefined || target.entryOnOwner.stack !== this.explicit)
        throw new NotOwnedError(`${describeNode(target)} is not owned by ${describeNode(this)} (not on its explicit stack)`); // no transfer of an entry between owners (DESIGN.md §9)
      if (!target.subscribed) throw new AlreadyOwnedError(`${describeNode(target)} is already owned`);
      target.subscribed = false;
      this.subscribers.delete(target); // its stack entry stays where it is
      return target;
    }
    if ((typeof target !== 'object' && typeof target !== 'function') || target === null)
      throw new TypeError('own(): attached values must be objects');
    const present = this.explicit.find(target);
    if (present !== undefined) {
      if (release === undefined) return target; // D16: one argument on an object this node owns is a no-op by identity
      throw new AlreadyOwnedError(
        `${describe(target)} is already owned by ${describeNode(this)}: own(x, release) would register a second release`,
      ); // C8
    }
    const dispose = toDispose(target, release); // TypeError if nothing applies (C1: synchronous)
    const name = nameOf(target);
    this.explicit.push({ target, name, node: undefined, dispose, state: 'live', done: undefined, failure: undefined, early: false });
    this.emit({ type: 'entry:registered', entryName: name, stack: 'explicit' });
    return target;
  }

  run<R>(fn: () => R): R {
    this.assertBodyShaped('run');
    const r = runInFrame({ node: this, creation: undefined }, fn);
    if (dev() && !isNodeImpl(r) && isPromise(r)) {
      // The caller never receives the promise, so its rejection could reach nobody: one misuse is one
      // error, the AsyncRunError, not also an unhandled rejection (I10).
      handleRejection(r, noop);
      throw new AsyncRunError(
        'run(fn) returned a promise: the node is current only for the synchronous part of fn; use call(fn) for async work',
      ); // development mode only (DESIGN.md §4.11, §4.4)
    }
    return r;
  }

  runSync<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R {
    this.assertBodyShaped('runSync');
    const c = this.child({ name: 'runSync' });
    try {
      return c.run(() => fn(...args));
    } finally {
      c.abort(); // releases synchronously when every entry is synchronous (DESIGN.md §2.4)
    }
  }

  // =========================================================================
  // Identity, state and kind-specific surface
  // =========================================================================

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get scopes(): ReadonlySet<Scope> {
    return this.scopeSet ?? EMPTY_SCOPES;
  }

  /** Pools: started and not complete. 0 for other kinds. */
  get running(): number {
    return this.poolState?.running ?? 0;
  }

  /** Pools: created and waiting for a slot. 0 for other kinds. */
  get pending(): number {
    return this.poolState?.pending ?? 0;
  }

  /** Fibers are not thenable (DESIGN.md §4.5); other nodes are not thenables at all. */
  get then(): undefined {
    if (this.kind === 'fiber') throw new FiberNotAwaitableError('Fibers are not awaitable; use join(f) or result(f)');
    return undefined;
  }

  findScopedContext(scope: Scope): NodeImpl | undefined {
    return firstUp(this, (c) => c.scopeSet?.has(scope) === true);
  }

  // =========================================================================
  // Guards (assertOpen → assertNotPending → assertNotCreating → assertNotLent)
  // =========================================================================

  assertOpen(op: string): void {
    if (this.state === 'complete') throw new NodeCompletedError(`${op}() on completed ${describeNode(this)}`);
  }

  assertNotPending(op: string): void {
    if (this.state === 'pending')
      throw new PendingNodeError(`${op}() on pending node ${describeNode(this)}: a value's node is placed when its creation ends`);
  }

  assertNotCreating(op: string): void {
    if (currentCreation() !== undefined) throw new CreationViolationError(`${op}() during creation`); // body-shaped operations refuse a creation frame (DESIGN.md §3.5)
  }

  /**
   * The current node runs inside a creation without its frame: a release the factory started
   * (release(x), releaseAll(), or a release of the value node's subtree) runs synchronously under its own
   * frame, below the value node, while the creation is still running. Resolving or entering a node from
   * there would re-enter resolution unseen by the cycle check and creation purity (DESIGN.md §3.3, §3.5, I16). Awaits
   * enter nothing and stay allowed.
   */
  private assertNotUnderCreation(op: string): void {
    const cur = currentFrame()?.node;
    const owner = cur?.creationOwner();
    if (owner !== undefined)
      throw new CreationViolationError(
        `${op}() in ${describeNode(cur!)} during the creation of ${describeNode(owner)}: ` +
          'a release started by a factory cannot resolve or enter a node while the factory runs',
      );
  }

  assertNotLent(op: string): void {
    const child = this.lentTo;
    if (child === undefined) return;
    const f = currentFrame();
    if (f?.handler !== undefined && f.node === this) {
      // A failure handler of this node runs while this node's body awaits a call (DESIGN.md §4.7). No await was
      // forgotten; the handler may do what neither waits on, enters nor lends this node.
      if (HANDLER_MAY_WHILE_LENT.has(op)) return;
      throw new UnawaitedCallError(
        child,
        `${op}() in a failure handler of ${describeNode(this)} while its body awaits ${describeNode(child)}: ` +
          'a handler may lookup, own, release, fork, child, pool and runSync there, but not await or call through it; fork the work instead',
      );
    }
    throw new UnawaitedCallError(
      child,
      `${op}() on ${describeNode(this)} while it is lent to ${describeNode(child)}: the call was not awaited ` +
        (op === 'all' || op === 'race'
          ? `(await it before this ${op}(), or put both in one all())` // all() and race() name themselves in the lending error
          : '(two concurrent calls on one node? use all())'),
    );
  }

  /** The four guards every body-shaped method shares (DESIGN.md §4.9, §3.5). */
  private assertBodyGuards(op: string): void {
    this.assertOpen(op);
    this.assertNotPending(op);
    this.assertNotCreating(op);
    this.assertNotLent(op);
  }

  /** get, call, all, race, run, runSync: the four guards, and nothing that runs inside a creation (DESIGN.md §3.3). */
  private assertBodyShaped(op: string): void {
    this.assertBodyGuards(op);
    this.assertNotUnderCreation(op);
  }

  /**
   * A managed await made through this node (join, result, interrupted, never, managed): the receiver's
   * guards, then the AWAITING node's lending. The await belongs to current(), whose freeze decision it is
   * (DESIGN.md §4.2), so a current node that is lent has a call it did not await (DESIGN.md §4.9, I26),
   * whichever node receives the method. own, release, abort and close stay exempt. In a
   * failure handler's frame the await is the handler's, not its parent's body's: nothing freezes and
   * nothing was forgotten, so only the receiver is checked, as for `call` there (DESIGN.md §4.7).
   */
  private assertAwaitShaped(op: string): void {
    this.assertBodyGuards(op);
    const f = currentFrame();
    if (f?.handler === undefined) f?.node?.assertNotLent(op);
  }

  // =========================================================================
  // Diagnostics and events (DESIGN.md §4.4, §5)
  // =========================================================================

  /** node:stalled after stallWarningMs unless settled or frozen first; unref'd; 0/Infinity disables (DESIGN.md §2.1, §4.4). */
  armStallTimer(): void {
    if (this.stallTimer !== undefined || this.bodyDone) return;
    const ms = this.stallWarningMs;
    if (!(ms > 0) || ms === Infinity) return;
    if (this.root.receiver === undefined) return; // nobody could hear node:stalled: no timer (DESIGN.md §5: no receiver, no cost)
    const since = Date.now();
    this.stallTimer = outsideFrames(() =>
      unref(
        setTimeout(() => {
          this.stallTimer = undefined;
          if (!this.bodyDone) this.emit({ type: 'node:stalled', sinceMs: Date.now() - since });
        }, ms),
      ),
    );
  }

  /** No-op without a receiver. A receiver is a sink: it runs in the emitting frame and must not use ambient operations (DESIGN.md §5). */
  emit(event: NodeEventInput): void {
    const root = this.root;
    const r = root.receiver === null ? resolveReceiver(root) : root.receiver;
    if (typeof r !== 'function') return;
    const full = {
      ...event,
      seq: ++seq,
      id: this.id,
      kind: event.type.startsWith('entry:') ? 'entry' : this.kind,
      parentId: this.parent?.id ?? null,
    } as NodeEvent;
    try {
      const ret: unknown = r(full);
      // An async receiver's rejection is reported like a throw (DESIGN.md §5), never left unhandled (I10).
      if (ret != null && !isNodeImpl(ret) && isPromise(ret)) handleRejection(ret, reportReceiverError);
    } catch (err) {
      reportReceiverError(err);
    }
  }
}

function consume(owner: NodeImpl, r: FailureRecord): void {
  r.consumed = true;
  owner.unconsumed.delete(r);
}
