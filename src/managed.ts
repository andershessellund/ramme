// ---------------------------------------------------------------------------
// Ops (DESIGN.md §4.14, D41): what every waiting verb returns.
//
// An op is iterable: `yield* op` in a body yields a private `InstructionImpl`
// once to the driver (driver.ts), which runs the op for the yielding body and
// resumes the body with the op's value, or throws its failure in at the
// `yield*`. Two kinds:
//
// - a **work op** (`WorkOp`: `call`, `attempt`, `all`, `race`, `settle`,
//   `shield`, `unshield`, `join`, `result`, `sleep`, `interrupted`, `never`,
//   `wait`) is lazy (decision 2): making it runs nothing; its consumer runs it,
//   the driver at each `yield*` (afresh, as a description: decision 3) or its
//   `then` once (a plain thenable, decision 4), as a child of the node it was
//   made through, settling by the child's outcome;
// - a **lifecycle op** (`LifecycleOp`: `release`, `releaseAll`, `close`,
//   `[Symbol.asyncDispose]`) is eager: the verb starts its work, and the op, a
//   `Promise` subclass whose `then` is overridden, only waits for it; every
//   consumption waits for the same completion (C7, D16).
//
// Running an op makes a `Run`: a source that never rejects (I10) unless it is
// a user promise (`wait(p)`), the resume step that runs only when a consumer
// is resumed and is where a failure is consumed (D13), and the run's shape at
// a halt (PROPOSAL.md §2.3): `abandon` (returned at once: `sleep`, `never`, an
// unrelated wait), `call` (returned once the awaited fiber has completed; the
// shape delivers a fiber the delivery missed) or `release` (release work and
// `wait(p)`, which the halt lets finish). The driver reads the shape; this
// module only subscribes (`Sub`) and resumes.
//
// The reactions ramme registers on a source hold only a `Sub`, which a
// settlement or a drop empties, so a halted body's generator and node are not
// retained by a source that stays pending (A2).
//
// An expected failure (D42) is the other thing a body yields: `yield* fail(e)`
// yields a `Fail` record, which the driver tells apart from an instruction and
// ends the body with. A resume step that finds a child ended `failure(e)` throws
// `Expected(e)`, which a consumer turns back into that `Fail`: the driver ends
// the waiting body with it (the re-yield of `yield* call(t)`), and a `then`
// rejects with `e`.
// ---------------------------------------------------------------------------

import type { Instruction, Op, Operation } from './context.js';
import { currentCreation, currentFrame, runDetached } from './context-storage.js';
import type { Frame } from './context-storage.js';
import type { NodeImpl } from './node-impl.js';
import { CreationViolationError } from './resource.js';

/** Whether a wait waits for node `n`'s completion (DESIGN.md §4.7; D41 decision 12). Never throws. */
export type WaitsFor = (n: NodeImpl) => boolean;

/** How the halt of the waiting body meets a wait (PROPOSAL.md §2.3, decision 8; DESIGN.md §4.14). */
export type HaltShape = 'abandon' | 'call' | 'release';

/**
 * Runs only when a consumer is resumed: turns the source's value into the op's value, may throw, and is where a
 * failure is consumed (D13). `applied` is true for a consumer that consumes nothing: an unwind fiber (U3), or a halted
 * body resumed by release work: the step throws the failure it would deliver and leaves it to its holder's
 * completion (D39, A.3; DESIGN.md §4.14).
 */
export type Deliver<S, T> = (value: S, applied: boolean) => T;

/**
 * Told when a consumer starts waiting on a lifecycle op and when it stops (resumed, after the resume step ran, or
 * dropped by a halt): one call of each per subscription. An early release's owner reads it, so a failure about to be
 * delivered to a consumer is not also folded into the owner's outcome (D16).
 */
export interface AwaitWatch {
  awaiting(): void;
  settled(): void;
}

/** One run of an op's work: what a consumer subscribes to. */
export interface Run<S = unknown, T = unknown> {
  /** Never rejects (I10), except a user promise's (`user`). */
  readonly source: PromiseLike<S>;
  /** The resume step (`Deliver`); a method, so a run over any source is a `Run` (its parameter is bivariant). */
  deliver?(value: S, applied: boolean): T;
  /**
   * At the delivery of the body that waits (or when an applied body yields a started op): how its halt meets this
   * wait. Called at most once per subscription; a `call` shape delivers the awaited fiber the delivery did not reach
   * (D39, A.2).
   */
  readonly shape: (awaiter: NodeImpl) => HaltShape;
  /** The node completions the wait waits for: a failure handler's hold (DESIGN.md §4.7), a halted finally (decision 12). */
  readonly waitsFor?: WaitsFor;
  readonly watch?: AwaitWatch;
  /** The source is a user promise: its rejection is its own failure, which a halted finally records (DESIGN.md §4.14). */
  readonly user?: boolean;
  /** Dropped before it settled (a halt that does not wait): a sleep clears its timer (D34). */
  readonly cancel?: () => void;
}

/**
 * What a resumed consumer gets. `failed`: the error is a child's expected failure, which a body re-yields as its own
 * `Fail` (D42), and a `then` rejects with.
 */
export type Resumed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown; readonly user: boolean; readonly failed?: boolean };

/**
 * The run-time brand of a yielded `Fail` (D42, DESIGN.md §4.13): a registered symbol, so `ramme/result`'s `$`, a leaf
 * that imports nothing at run time (DESIGN.md §7), makes the same record without importing this module. The record is
 * `{ [FAIL]: error }`, the shape `Fail<E>` declares under its declared-only brand.
 */
export const FAIL: unique symbol = Symbol.for('ramme.fail');

/** @internal A yielded expected failure: what `fail(e)` and `$` yield, and what the driver ends a body with (D42). */
export interface FailYield {
  readonly [FAIL]: unknown;
}

/** A re-yielded `Fail` (D42): the callee's failure record still holds the error (D13), so a halted `finally` records nothing. */
const HELD: unique symbol = Symbol('ramme.held');

/**
 * @internal The brand test the driver makes after the instruction test, an own property under the registered symbol,
 * and the error under it; `held` for a callee's failure re-yielded (`heldFailYield`). Never throws: a proxy whose trap
 * throws is no fail, and the driver throws its `TypeError` back.
 */
export function readFail(x: unknown): { readonly error: unknown; readonly held: boolean } | undefined {
  if (typeof x !== 'object' || x === null) return undefined;
  try {
    if (!Object.prototype.hasOwnProperty.call(x, FAIL)) return undefined;
    return { error: (x as FailYield)[FAIL], held: Object.prototype.hasOwnProperty.call(x, HELD) };
  } catch {
    return undefined;
  }
}

/** @internal The record a `yield* fail(error)` yields. */
export function failYield(error: unknown): FailYield {
  return { [FAIL]: error };
}

/**
 * @internal A callee's expected failure as the driver re-yields it (D42): a `Fail` marked as still held by the callee's
 * failure record, which its holder reports, so a halted `finally` does not record it a second time.
 */
export function heldFailYield(error: unknown): FailYield {
  return { [FAIL]: error, [HELD]: true } as FailYield;
}

/** `fail(e)`'s iterator: yields its `Fail` once; resumed, which no driver does, it throws. */
function* failSteps(error: unknown): Generator<FailYield, never, unknown> {
  yield failYield(error);
  throw new TypeError('ramme: a fail was resumed: yield* fail(e) ends the body, and nothing resumes it');
}

/**
 * What `fail(error)` makes (D42): an operation whose iterator yields one `Fail` record and never returns. An instance
 * of this module's class, so a body, a release or a failure handler that returns `fail(e)` instead of yielding it is
 * driven as its own `yield*` of it, as a returned op is (decision 28, `isFailOp`): it ends with `failure(e)` there.
 */
class FailOp {
  readonly #error: unknown;

  constructor(error: unknown) {
    this.#error = error;
  }

  [Symbol.iterator](): Generator<FailYield, never, unknown> {
    return failSteps(this.#error);
  }
}

/**
 * `fail(error)` (D42): an operation whose iterator yields one `Fail` record, branded disjointly from an instruction,
 * and never returns. Pure: it reads no node, so it may be made anywhere, and each `yield*` yields afresh, as a
 * description (decision 3).
 */
export function failOp<E>(error: E): Operation<never, E> {
  return new FailOp(error) as unknown as Operation<never, E>;
}

/**
 * @internal A `fail(e)` returned rather than yielded (D42): what a body, a release or a failure handler returned that
 * the driver steps as its own `yield*` of it, as it does a returned op (decision 28). Recognized by what it is, never
 * by `Symbol.iterator`.
 */
export function isFailOp(x: unknown): x is Iterable<unknown> {
  return x instanceof FailOp;
}

/**
 * @internal What a resume step throws for a child that ended `failure(e)` (D42): not an error a body sees, since
 * `Sub.resume` turns it into a `Resumed` with `failed`, which the driver re-yields as the body's own `Fail` and a
 * `then` rejects with `e`. `unwrapExpected` gives a direct caller the error itself.
 */
export class Expected {
  constructor(readonly error: unknown) {}
}

/** The error a resume step threw, an expected failure's own included. */
export function unwrapExpected(e: unknown): unknown {
  return e instanceof Expected ? e.error : e;
}

type OnFulfilled = ((value: any) => unknown) | null | undefined;
type OnRejected = ((reason: any) => unknown) | null | undefined;

/**
 * A resumed promise consumer: promise-handler semantics, in the source's reaction itself, so `await op` resumes one
 * job after the source settles (a non-callable handler passes the outcome through; a throwing one rejects).
 */
function settleWith(r: Resumed<unknown>, onF: OnFulfilled, onR: OnRejected, res: (v: unknown) => void, rej: (e: unknown) => void): void {
  const handler = r.ok ? onF : onR;
  const x = r.ok ? r.value : r.error;
  if (typeof handler !== 'function') return r.ok ? res(x) : rej(x);
  try {
    res(handler(x));
  } catch (e) {
    rej(e);
  }
}

/** An awaiter that consumes nothing: an unwind fiber, or a halted (`freeze`/`restore`, delivered) body (D39, A.3). */
export function consumesNothing(awaiter: NodeImpl | undefined): boolean {
  return awaiter !== undefined && (awaiter.unwinding || haltedBody(awaiter));
}

/**
 * A halted body: a delivered `freeze` or `restore` node with a body, whose own throw, and so a rejection its `wait(p)`
 * is handed, is discarded (D24). A `then` whose op was made in one of its steps leaves the failure it delivers with
 * its holder, as `promised` does for a halted host (D39, A.3; DESIGN.md §4.14).
 */
export function haltedBody(n: NodeImpl | undefined): boolean {
  return n !== undefined && n.hasBody && n.applied;
}

/**
 * The node of the step an op is made in, read when it is made: the unwind fiber in a halted `finally` (U3), else the
 * frame's node; none at top level. A `then` cannot see who awaits it (the slot is synchronous and a combinator calls
 * `then` in a later job), so this node stands for its consumer (DESIGN.md §4.14 "The thenable").
 */
function makerNode(f: Frame | undefined = currentFrame()): NodeImpl | undefined {
  return f?.unwind ?? f?.node;
}

function noop(): void {}

/**
 * One consumer's subscription to a run. The source's reaction holds this object only; `resume` and `drop` empty it,
 * so nothing of the consumer is retained after it (A2). `onSettled` runs in the source's reaction, never inside the
 * subscription, and never after a `drop`.
 */
export class Sub<S = unknown, T = unknown> {
  #run: Run<S, T> | undefined;
  #onSettled: ((ok: boolean, x: unknown) => void) | undefined;

  constructor(run: Run<S, T>, onSettled: (ok: boolean, x: unknown) => void) {
    this.#run = run;
    this.#onSettled = onSettled;
    run.watch?.awaiting();
    const source = run.source;
    try {
      // Registered under no frame: a reaction registered in a step carries nothing of it anyway (the slot is
      // synchronous), and one registered from a creation must not run inside it (DESIGN.md §6).
      runDetached(() =>
        source.then(
          (v) => this.#fire(true, v),
          (e) => this.#fire(false, e),
        ),
      );
    } catch (e) {
      // A source whose `then` throws (a `Promise` subclass that overrides it): nothing is subscribed and nothing
      // waits; the caller answers its consumer with the throw, a failure of the wait, never an escape (I10).
      this.#run = undefined;
      this.#onSettled = undefined;
      run.watch?.settled();
      throw e;
    }
  }

  #fire(ok: boolean, x: unknown): void {
    const f = this.#onSettled;
    this.#onSettled = undefined;
    f?.(ok, x);
  }

  /**
   * The source settled and the consumer is resumed: the resume step runs (D13), `use` gets what it gave, and only
   * then is the watch told (D16), so a failure the step consumes is consumed, and the consumer resumed, before the
   * owner's release loop re-reads. A rejection of a user promise is handed on as it is, and marked as the user
   * promise's own failure. `use` must not throw.
   */
  resume(ok: boolean, x: unknown, applied: boolean, use: (r: Resumed<T>) => void): void {
    const run = this.#run!;
    this.#run = undefined;
    let r: Resumed<T>;
    if (!ok) r = { ok: false, error: x, user: run.user === true };
    else
      try {
        r = { ok: true, value: run.deliver !== undefined ? run.deliver(x as S, applied) : (x as T) }; // DELIVERY: the only place a failure is consumed (D13)
      } catch (e) {
        // A child's expected failure is re-yielded by a body, and rejects a `then` with its error (D42).
        r = e instanceof Expected ? { ok: false, error: e.error, user: false, failed: true } : { ok: false, error: e, user: false };
      }
    try {
      use(r);
    } finally {
      run.watch?.settled();
    }
  }

  /** The consumer stops waiting unresumed: nothing is consumed, the failure stays with its holder (D16); a sleep's timer is cleared. */
  drop(): void {
    const run = this.#run;
    this.#run = undefined;
    this.#onSettled = undefined;
    if (run === undefined) return;
    run.watch?.settled();
    run.cancel?.();
  }

  /** The source settled and the consumer is not resumed (a call-shaped wait of a halted body): nothing is consumed. */
  finish(): void {
    const run = this.#run;
    this.#run = undefined;
    this.#onSettled = undefined;
    run?.watch?.settled();
  }
}

/**
 * @internal What an op's iterator yields to the driver (D41, decision 1): the op behind a brand no value outside ramme
 * carries (`instanceof`, a class of this module), so `yield op` without the star, or any other yielded value, is told
 * apart and answered with a `TypeError`. `sub` is the driver's subscription, which the iterator's `return()` drops.
 */
export class InstructionImpl {
  sub: Sub | undefined = undefined;
  constructor(readonly op: AnyOp) {}
}

/** @internal The brand test the driver makes on every yielded value. */
export function isInstruction(x: unknown): x is InstructionImpl {
  return x instanceof InstructionImpl;
}

/**
 * An op's iterator (DESIGN.md §4.14): `next()` yields the op's instruction once, then returns what the driver resumed
 * it with; `throw(e)` rethrows `e`, so `yield*` hands the awaited work's failure to the body at the `yield*`;
 * `return(v)`, which `yield*` forwards on a halt, drops the driver's subscription and returns `v`. One iterator per
 * `yield*`, and one run per iterator.
 */
class OpIterator<T> implements Iterator<Instruction, T, unknown> {
  #op: AnyOp | undefined;
  #ins: InstructionImpl | undefined = undefined;

  constructor(op: AnyOp) {
    this.#op = op;
  }

  next(...[value]: [] | [unknown]): IteratorResult<Instruction, T> {
    const op = this.#op;
    if (op !== undefined) {
      this.#op = undefined;
      const ins = new InstructionImpl(op);
      this.#ins = ins;
      return { done: false, value: ins as unknown as Instruction };
    }
    this.#ins = undefined;
    return { done: true, value: value as T };
  }

  throw(error?: unknown): IteratorResult<Instruction, T> {
    this.#drop();
    throw error;
  }

  return(value?: unknown): IteratorResult<Instruction, T> {
    this.#drop();
    return { done: true, value: value as T };
  }

  [Symbol.iterator](): this {
    return this;
  }

  #drop(): void {
    this.#op = undefined;
    const ins = this.#ins;
    this.#ins = undefined;
    ins?.sub?.drop();
  }
}

/**
 * What runs a work op: `awaiter` is the node whose halt decides (the yielding body's node, or its unwind fiber in a
 * halted `finally`; `undefined` for a failure handler and for `then`, which nothing halts, except that a `then` of an
 * op made in a halted `finally` through the body's own node passes that unwind fiber, so the op runs on it as the
 * driver runs it there: U3), `events` the node its join events go on (the yielding body's; `undefined`: the receiver).
 * May throw: the error lands at the `yield*`, or rejects `then`.
 */
export type Start<T> = (awaiter: NodeImpl | undefined, events: NodeImpl | undefined) => Run<unknown, T>;

/**
 * A lazy op (decision 2): the verb ran its guards when it was made (decision 17), and its work runs at each `yield*`
 * and at most once through `then`. A plain thenable (decision 4): `then` only, no `catch` or `finally`, and not a
 * `Promise`. `started` marks a wait whose work began before the op was made (`wait(p)` over a promise): a halted body
 * that yields it still subscribes, as PROPOSAL.md §2.3's fifth row says. `receiver` is the node the verb was called
 * on, for U3's host when the op is made in a halted `finally` (`then` only; the driver passes its own awaiter).
 */
export class WorkOp<T> implements Op<T> {
  readonly #start: Start<T>;
  /** @internal */
  readonly started: boolean;
  /** @internal */
  readonly waitsFor: WaitsFor | undefined;
  /** The node of the step that made the op (`makerNode`), which `then` reads when the op's work settles. */
  readonly #maker: NodeImpl | undefined;
  /** Made in a halted `finally` through the body's own node: the unwind fiber, which `then` runs the op on (U3). */
  readonly #unwind: NodeImpl | undefined;
  /** `then`'s one run: its consumers while it runs, then its outcome. */
  #then: { consumers: ((r: Resumed<T>) => void)[] } | { result: Resumed<T> } | undefined = undefined;

  constructor(start: Start<T>, opts?: { readonly started?: boolean; readonly waitsFor?: WaitsFor; readonly receiver?: NodeImpl }) {
    this.#start = start;
    this.started = opts?.started === true;
    this.waitsFor = opts?.waitsFor;
    const f = currentFrame();
    this.#maker = makerNode(f);
    this.#unwind = f?.unwind !== undefined && f.node === opts?.receiver ? f.unwind : undefined;
  }

  /** @internal Run the work for a consumer (see `Start`). */
  start(awaiter: NodeImpl | undefined, events: NodeImpl | undefined): Run<unknown, T> {
    return this.#start(awaiter, events);
  }

  /** `yield* op`: one run per `yield*`, for the yielding body (DESIGN.md §4.14). */
  [Symbol.iterator](): Iterator<Instruction, T, unknown> {
    return new OpIterator<T>(this);
  }

  /**
   * `await op` from plain async code (D41 §4.1): the op runs once, on the first `then`, as a child of the node it was
   * made through (of its unwind fiber when made in that node's halted `finally`, U3), under no frame: a promise awaiter
   * is a foreign frame, which nothing halts. It settles with the value, or the failure, or `FiberAbortedError` when the
   * child ended `aborted`. The failure is consumed unless the step that made the op is a halted body's when the work
   * settles: that body's wait discards the rejection, so the record stays with its holder and surfaces from its
   * completion (D39, A.3), as `promised`'s does. A `then` that would run the op during a creation is refused with
   * `CreationViolationError` and runs nothing (I16); the op stays unrun.
   */
  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return new Promise<R1 | R2>((res, rej) => {
      const consumer = (r: Resumed<T>): void => settleWith(r, onFulfilled, onRejected, res as (v: unknown) => void, rej);
      const state = this.#then;
      if (state === undefined) {
        if (currentCreation() !== undefined) {
          // As a promised callback called there: no body, and no other work, is entered from a creation (I16).
          const refused: Resumed<T> = { ok: false, error: new CreationViolationError('then() of a work op during creation'), user: false };
          return queueMicrotask(() => consumer(refused)); // as a settled promise's then: never synchronously
        }
        const consumers = [consumer];
        this.#then = { consumers };
        const settled = (r: Resumed<T>): void => {
          this.#then = { result: r };
          for (const c of consumers) c(r);
        };
        try {
          const run = runDetached(() => this.#start(this.#unwind, undefined));
          const maker = this.#maker;
          // `applied` read when the work settles: a halted maker consumes nothing (D39, A.3).
          const sub: Sub = new Sub(run, (ok, x) => sub.resume(ok, x, haltedBody(maker), (r) => settled(r as Resumed<T>)));
        } catch (e) {
          settled({ ok: false, error: e, user: false });
        }
      } else if ('consumers' in state) state.consumers.push(consumer);
      else {
        const r = state.result;
        queueMicrotask(() => consumer(r)); // as a settled promise's then: never synchronously
      }
    });
  }
}

/**
 * An eager op (decision 2): `release`, `releaseAll`, `close` and `[Symbol.asyncDispose]` started their work when
 * called, and this only waits for it. A `Promise` subclass, so `.catch` and `.finally` work and a platform callback's
 * `void app.close()` runs the close; the instance itself never settles: `then` subscribes to the run, each consumer
 * resumed through the resume step (D13), and `yield*` subscribes to the same run.
 */
export class LifecycleOp<S, T = void> extends Promise<T> implements Op<T> {
  /** Promises derived by the inherited `catch`/`finally` machinery are plain. */
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  readonly #run: Run<S, T>;
  /** The node of the step that made the op (`makerNode`), which `then` reads when the work settles, as a work op's. */
  readonly #maker: NodeImpl | undefined;

  constructor(run: Run<S, T>) {
    super(noop); // the instance itself never settles: `then` is the whole protocol
    this.#run = run;
    this.#maker = makerNode();
  }

  /** @internal Started when made: a halted body that yields it still subscribes, and its shape decides (PROPOSAL.md §2.3). */
  get started(): boolean {
    return true;
  }

  /** @internal */
  get waitsFor(): WaitsFor | undefined {
    return this.#run.waitsFor;
  }

  /** @internal The run the verb started. */
  start(): Run<S, T> {
    return this.#run;
  }

  [Symbol.iterator](): Iterator<Instruction, T, unknown> {
    return new OpIterator<T>(this);
  }

  /**
   * A promise consumer: a foreign frame, which nothing halts; resumed with the value, or the failure, consumed (D13)
   * unless the step that made the op is a halted body's when the work settles (as a work op's `then`), each consumer
   * through the resume step once, in the source's reaction.
   */
  override then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    const maker = this.#maker;
    return new Promise<R1 | R2>((res, rej) => {
      const sub = new Sub<S, T>(this.#run, (ok, x) =>
        sub.resume(ok, x, haltedBody(maker), (r) => settleWith(r, onFulfilled, onRejected, res as (v: unknown) => void, rej)),
      );
    });
  }
}

/** Either kind of op. */
export type AnyOp = WorkOp<any> | LifecycleOp<any, unknown>;

/** @internal An op of this ramme (decision 28): recognized by what it is, never by `then` or `Symbol.iterator`. */
export function isOp(x: unknown): x is AnyOp {
  return x instanceof WorkOp || x instanceof LifecycleOp;
}

/** A fresh promise that never settles; no shared constant is ever `.then`ed, so nothing is retained (A2). */
export function neverPromise(): Promise<never> {
  return new Promise<never>(noop);
}

/**
 * The sources of `sleep`, `never`, `interrupted` and the groups' internal waits (DESIGN.md §4.14): sources that never
 * reject (I10), each a wait the halt returns at once.
 */
export function abandoning<S>(source: PromiseLike<S>, cancel?: () => void): Run<S, S> {
  return { source, shape: () => 'abandon', cancel };
}

/**
 * `sleep(ms)`'s run (D34, amended by D41): the timer is armed now, when the op runs, outside every frame, and is not
 * unref'd, so a top-level `await app.sleep(n)` resolves. A halt clears it (`cancel`): the body is returned, nothing
 * rejects. A body that is never halted (an `observe` body, a release, a failure handler, `then`) sleeps the full `ms`.
 */
export function sleepRun(ms: number): Run<void, void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = runDetached(() => setTimeout(resolve, ms));
  return abandoning(promise, () => clearTimeout(timer));
}
