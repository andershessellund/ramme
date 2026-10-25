// ---------------------------------------------------------------------------
// The driver (DESIGN.md §4.14, D41): steps a body's generator.
//
// A body that returns a generator object, or an op (decision 28), is driven:
// each step is one `next(v)`, `throw(e)` or `return()` on its iterator, run
// with the body's frame in the slot (`runInFrame`), so `current()`, `own`,
// `lookup` and `fork` in a step see the node, and the ops a step makes read it
// (decision 17). A yielded value that is not an op's instruction gets a
// `TypeError` thrown back at that `yield`.
//
// Each yielded op is run here, for the yielding body, synchronously at its
// `yield*` (so `yield* call(t)` starts `t` before the step returns, D22), and
// subscribed to; the body resumes in the source's reaction (decision 7): with
// the op's value, or with its failure thrown in at the `yield*`, consumed as
// the op's resume step consumes it. The body's own interruption is never
// thrown in: the driver **halts** the body, calling its generator's
// `return(HALT)`, at the wait the delivery finds it on, as that wait's shape
// says (PROPOSAL.md §2.3, decision 8):
//
// 1. `abandon` (`sleep`, `never`, its own `interrupted()`, a join of a fiber
//    not subscribed below it, `wait(p, { abandon: true })`, a lifecycle op
//    whose wait includes the body or is not below it): returned at once, the
//    subscription dropped (a sleep's timer cleared);
// 2. `call` (`call`, `attempt`, `unshield`, the groups, a join of a fiber
//    subscribed below it): returned once the awaited fiber has completed,
//    without its resume step, so nothing is consumed; the shape delivers a
//    fiber the delivery missed;
// 3. `release` (release work, `wait(p)`): not at the delivery; resumed on
//    success, and returned at its next `yield*`; on failure returned there, the
//    failure unconsumed (a release failure surfaces at completion; `p`'s own is
//    discarded, as a halted body's throw is).
//
// The driver reads the node's state, not a signal: a body that finds its node
// applied at a `yield*` of an op that has not started (rows 4 and 5, a body
// born delivered: decision 9) does not run it and is returned there; a started
// one (`wait(p)` over a promise, a lifecycle op) is subscribed and its shape
// decides. A return at the delivery, or at such a `yield*`, is a job queued
// under no frame, never inside `abort()` nor inside the step, so no body code
// runs inside a delivery, and a fork made just before the halt starts first.
//
// After the halt every `yield*` is inside a `finally` (decision 11, U3): the
// driver makes the body's unwind fiber, a release fiber of the node that no
// delivery reaches, and steps the generator in a frame that still names the
// node, so every synchronous verb addresses the node, while the ops it yields
// there run on the unwind fiber (an op made through the node runs on it
// instead), as release work: none is halted, and none of their resume steps
// consumes a failure; a user promise's own failure there is also recorded as a
// release failure. A finally-yield whose wait includes the unwind itself is
// returned there, with a warning (decision 12). The generator's completion is
// the node's body exit: a halted body is `aborted` by state whatever its
// `finally` did (D24). A generator that ends with any value other than the
// halt's sentinel lost the halt, through a `yield*` in a helper's `finally` or a
// `return` in a `finally`, and so did one that uses the sentinel, which that
// helper's `yield*` gave it; dev mode reports either (decision 29).
//
// A failure handler's generator is driven in the handler's frame and never
// halted; each op it yields is reported to its run first, so one that waits
// for its parent's completion holds nothing (DESIGN.md §4.7).
// ---------------------------------------------------------------------------

import { runDetached, runInFrame } from './context-storage.js';
import type { Frame } from './context-storage.js';
import { describeNode } from './inject.js';
import { Sub, consumesNothing, isInstruction } from './managed.js';
import type { Run, WaitsFor } from './managed.js';
import type { NodeImpl } from './node-impl.js';

/** The private sentinel the driver halts a generator with: a body that keeps the halt finishes with it (D41, decision 29). */
const HALT: unique symbol = Symbol('ramme.halt');

/**
 * Dev mode's sentinel for one halt (decision 29). After a lost halt the helper's `yield*` gives the body the sentinel
 * as its value, so any use of it (reading a property, converting it, calling it, iterating it) calls `report`, which
 * reports the lost halt once. The driver tests it by identity only, so a kept halt never touches it. A function
 * target, so a call is a use too; `report` holds the body's description, never the node (A2).
 */
function lostHaltSentinel(report: () => void): object {
  return new Proxy(() => {}, {
    get: (_, key) => {
      report();
      return key === Symbol.toPrimitive ? () => 'ramme: a lost halt' : undefined;
    },
    has: () => {
      report();
      return false;
    },
    set: () => {
      report();
      return true;
    },
    apply: () => {
      report();
      return undefined;
    },
  });
}

/** How a generator body ended, for the node's classification (DESIGN.md §4.12). */
export type DriverExit = { kind: 'returned'; value: unknown } | { kind: 'threw'; error: unknown };

/** One run of a failure handler (DESIGN.md §4.7): told of every op it waits on, before the op runs. */
export interface HandlerRun {
  /** `waitsFor(n)`: whether the wait waits for node `n`'s completion. Never throws. */
  awaits(waitsFor: WaitsFor): void;
}

type Driven = Iterator<unknown, unknown, unknown>;
type Resume = (it: Driven) => IteratorResult<unknown, unknown>;

/** Dev mode is `process.env.NODE_ENV !== 'production'`, and always on where `process` is absent (DESIGN.md §4.4). */
function dev(): boolean {
  return (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV !== 'production';
}

/** Decision 12's development-mode warning: `body` yielded, in its halted `finally`, a wait that waits for that finally. */
function warnWaitsForItself(body: NodeImpl): void {
  if (dev())
    console.warn(
      `ramme: ${describeNode(body)} yields, in the finally its halt runs, an op that waits for its own ` +
        'completion or an ancestor’s (its own [Symbol.asyncDispose](), its entry’s release, an owner’s close()), ' +
        'or for a fiber that only such a completion ends (a join of a fork it owns: yield* release(f) stops it ' +
        'first), which waits for this finally: the generator is returned there instead of waiting forever',
    );
}

/** The `TypeError` for a yielded value that is not an op's instruction (decision 1). */
function notAnOp(where: string, value: unknown): TypeError {
  const what = value === null || (typeof value !== 'object' && typeof value !== 'function') ? String(value) : 'an object that is not an op';
  return new TypeError(`${where} yielded ${what}: run an op with yield*, as in yield* sleep(1) or yield* call(t)`);
}

function next(value?: unknown): Resume {
  return (it) => it.next(value);
}

function throwInto(error: unknown): Resume {
  return (it) => {
    if (typeof it.throw === 'function') return it.throw(error);
    throw error;
  };
}

/** `return(sentinel)`: an iterator without `return` has no `finally` to run, and ends at once. */
function returnWith(sentinel: unknown): Resume {
  return (it) => (typeof it.return === 'function' ? it.return(sentinel) : { done: true, value: sentinel });
}

/** The wait a driven body is suspended on: its subscription, and the halt hook in its node's `onApplied`. */
interface Waiting {
  readonly sub: Sub;
  readonly run: Run;
  /** Call-shaped and delivered: returned when the source settles, unresumed (PROPOSAL.md §2.3, row 2). */
  marked: boolean;
  hook: (() => void) | undefined;
}

/** One driven body: a fiber's, a release fiber's (an entry's release, a shield) or one returning an op. */
class BodyDriver {
  readonly #node: NodeImpl;
  #it: Driven | undefined;
  #frame: Frame;
  #waiting: Waiting | undefined = undefined;
  /** A return queued as a job (the delivery, or an applied body's yield* of an op not yet started). */
  #haltQueued = false;
  /** Made at the halt (U3): the parent of the ops the `finally` runs, and its completion's trigger. */
  #unwind: { readonly fiber: NodeImpl; readonly done: () => void } | undefined = undefined;
  /** From the halt on: its sentinel (HALT, or dev mode's reporting one) and the once-only report of its loss. */
  #halted: { readonly sentinel: unknown; readonly report: () => void } | undefined = undefined;

  constructor(node: NodeImpl, it: Driven, frame: Frame) {
    this.#node = node;
    this.#it = it;
    this.#frame = frame;
  }

  /** Whether the body's node halts at all: a delivered `freeze` or `restore` body is applied; `observe` and release fibers never are. */
  #halts(): boolean {
    return this.#unwind === undefined && this.#node.applied;
  }

  /**
   * Run steps until the generator yields an op, which is run and subscribed, or ends. A synchronous throw from the
   * step is the body's throw; a yielded non-op, a throw from running the op, or a finally-yield that would deadlock
   * the unwind, is answered at once.
   */
  step(resume: Resume): void {
    for (;;) {
      const it = this.#it;
      if (it === undefined) return; // ended: a late reaction does nothing
      let r: IteratorResult<unknown, unknown>;
      try {
        r = runInFrame(this.#frame, () => resume(it));
      } catch (e) {
        return this.#exit({ kind: 'threw', error: e });
      }
      if (r.done === true) return this.#exit({ kind: 'returned', value: r.value });
      const ins = r.value;
      if (!isInstruction(ins)) {
        resume = throwInto(notAnOp(`the body of ${describeNode(this.#node)}`, ins));
        continue;
      }
      const op = ins.op;
      // Rows 4 and 5, decision 9: delivered before this yield* (in its own step, born delivered, or resumed by release
      // work), the body does not run an op that has not started; it is returned here.
      if (this.#halts() && !op.started) return this.#queueHalt();
      const unwind = this.#unwind?.fiber;
      if (unwind !== undefined) {
        // Decision 12: a wait for the completion of the node, an ancestor, or the unwind itself never ends, since that
        // completion waits for this unwind, nor does a join of a fiber only such a completion ends (a fork the node
        // owns, which no delivery reaches). Returned there instead of waiting forever.
        const waitsFor = op.waitsFor;
        if (waitsFor !== undefined && waitsFor(unwind)) {
          warnWaitsForItself(this.#node);
          resume = this.#returnHalt();
          continue;
        }
      }
      const awaiter = unwind ?? this.#node;
      let run: Run;
      try {
        // In the body's frame: user code the op runs now (wait's function) sees the node, a call's first step nests.
        run = runInFrame(this.#frame, () => op.start(awaiter, this.#node));
      } catch (e) {
        resume = throwInto(e); // a guard of the run, or wait's TypeError, lands at the yield*
        continue;
      }
      // Decision 12 for a wait known only once it ran: `wait(fn)` whose `fn` returned a ramme op waits as that op, with
      // its `waitsFor` (`wait(() => current()[Symbol.asyncDispose]())`). Nothing is subscribed yet.
      if (unwind !== undefined && op.waitsFor === undefined && run.waitsFor?.(unwind) === true) {
        warnWaitsForItself(this.#node);
        resume = this.#returnHalt();
        continue;
      }
      try {
        this.#wait(ins, run, awaiter);
      } catch (e) {
        // The source's `then` threw (a `Promise` subclass that overrides it): a failure of the wait, never an escape
        // from the driver (I10); answered as the source's own rejection would be.
        if (this.#halts()) return this.#queueHalt(); // row 3: a halted body's failed wait returns it, discarded
        if (unwind !== undefined && run.user === true) unwind.extraErrors.push(e); // p's own failure in the halted finally
        resume = throwInto(e);
        continue;
      }
      return;
    }
  }

  /** Subscribe to `run` for `awaiter`, and arm the halt hook while the body can be halted. Throws what the source's `then` throws, having changed nothing. */
  #wait(ins: { sub: Sub | undefined }, run: Run, awaiter: NodeImpl): void {
    const w: Waiting = { sub: undefined as unknown as Sub, run, marked: false, hook: undefined };
    (w as { sub: Sub }).sub = new Sub(run, (ok, x) => this.#settled(w, ok, x));
    ins.sub = w.sub;
    this.#waiting = w;
    if (this.#unwind !== undefined || awaiter.mode === 'observe') return; // nothing halts it
    if (this.#node.applied) this.#onDelivery(w); // delivered while the op ran, or a started op yielded after it
    else {
      const hook = (): void => this.#onDelivery(w);
      w.hook = hook;
      this.#node.onApplied.add(hook);
    }
  }

  /** The node's delivery (fire() pass 2b), or a wait made after it: the wait's shape decides (PROPOSAL.md §2.3). Runs no body code. */
  #onDelivery(w: Waiting): void {
    w.hook = undefined; // fire() cleared the set
    if (this.#waiting !== w) return;
    const shape = w.run.shape(this.#node);
    if (shape === 'abandon') {
      this.#waiting = undefined;
      w.sub.drop();
      this.#queueHalt();
    } else if (shape === 'call') w.marked = true;
    // 'release': nothing now; the settlement decides
  }

  /** The source of the wait settled, in its reaction. */
  #settled(w: Waiting, ok: boolean, x: unknown): void {
    if (this.#waiting !== w) return; // dropped by a halt
    this.#waiting = undefined;
    if (w.hook !== undefined) {
      this.#node.onApplied.delete(w.hook);
      w.hook = undefined;
    }
    if (w.marked) {
      // Row 2: the awaited fiber has completed; the resume step does not run, so nothing is consumed and the fiber's
      // failure surfaces from its holder (D13).
      w.sub.finish();
      return this.#halt();
    }
    const unwind = this.#unwind?.fiber;
    w.sub.resume(ok, x, consumesNothing(unwind ?? this.#node), (r) => {
      if (r.ok) return this.step(next(r.value));
      // Row 3: release work or wait(p) failed after the halt: returned, the failure unconsumed (or discarded: p's own).
      if (this.#halts()) return this.#halt();
      if (unwind !== undefined && r.user) unwind.extraErrors.push(r.error); // p's own failure in the halted finally
      this.step(throwInto(r.error));
    });
  }

  /** A return as a job under no frame: never inside a delivery nor inside the step that found the node applied. */
  #queueHalt(): void {
    if (this.#haltQueued) return;
    this.#haltQueued = true;
    runDetached(() => queueMicrotask(() => this.#halt()));
  }

  /** `return(sentinel)` at the `yield*` that waited; the `finally` blocks run from here on under the unwind fiber (U3). */
  #halt(): void {
    if (this.#it === undefined || this.#unwind !== undefined) return;
    const unwind = this.#node.makeUnwindFiber();
    this.#unwind = unwind;
    this.#frame = { node: this.#node, creation: undefined, unwind: unwind.fiber };
    const report = lostHaltReport(describeNode(this.#node));
    this.#halted = { sentinel: dev() ? lostHaltSentinel(report) : HALT, report };
    this.step(this.#returnHalt());
  }

  /** The resume that halts: `return()` with this halt's sentinel. */
  #returnHalt(): Resume {
    return returnWith(this.#halted?.sentinel ?? HALT);
  }

  #exit(r: DriverExit): void {
    this.#it = undefined;
    const unwind = this.#unwind;
    if (unwind !== undefined) {
      if (r.kind === 'returned') {
        const halted = this.#halted;
        if (halted !== undefined && r.value !== halted.sentinel) halted.report(); // the identity test touches no sentinel
        r = { kind: 'returned', value: undefined }; // the value is discarded: the outcome is aborted by state (D24)
      }
      unwind.done(); // the unwind fiber completes after its last op; the node's release loop waits for it
    }
    this.#node.exitDrivenBody(r);
  }
}

/** Dev mode's report of a lost halt (decision 29), once per halt; it holds the body's description, never its node (A2). */
function lostHaltReport(body: string): () => void {
  let reported = false;
  return () => {
    if (reported || !dev()) return;
    reported = true;
    console.warn(
      `ramme: the halt of ${body} was lost: its generator went on after the driver returned it, and finished with a ` +
        'value or used the one a yield* gave it. A yield* in the finally of a helper it called (or a return in a ' +
        'finally) resumes the body past the halt; wait in the body’s own finally, in an entry (own(value, function* …)), ' +
        'or run the helper as yield* call(helper). The node is aborted all the same',
    );
  };
}

/** Drive `it` as `node`'s body in `frame`, starting now, synchronously, up to its first `yield*` (DESIGN.md §4.6). */
export function driveBody(node: NodeImpl, it: Driven, frame: Frame): void {
  new BodyDriver(node, it, frame).step(next());
}

/**
 * Drive a failure handler's generator in its frame (DESIGN.md §4.7, §4.14): nothing halts it, each op it yields runs
 * for no awaiter (its failures consumed on resume, a sleep its full duration) after being reported to `run`, so a
 * wait for the parent's completion holds nothing. The first step runs now. The promise settles when the generator
 * ends, rejected with its throw; the parent holds it as a returned promise.
 */
export function driveHandler(it: Driven, frame: Frame, run: HandlerRun): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const step = (resume: Resume): void => {
    for (;;) {
      let r: IteratorResult<unknown, unknown>;
      try {
        r = runInFrame(frame, () => resume(it));
      } catch (e) {
        return reject(e);
      }
      if (r.done === true) return resolve();
      const ins = r.value;
      if (!isInstruction(ins)) {
        resume = throwInto(notAnOp('a failure handler', ins));
        continue;
      }
      const op = ins.op;
      const waitsFor = op.waitsFor;
      if (waitsFor !== undefined) run.awaits(waitsFor);
      let src: Run;
      try {
        src = runInFrame(frame, () => op.start(undefined, undefined));
      } catch (e) {
        resume = throwInto(e);
        continue;
      }
      // `wait(fn)` whose `fn` returned a ramme op waits as that op: its `waitsFor` is known only now, before any wait.
      if (waitsFor === undefined && src.waitsFor !== undefined) run.awaits(src.waitsFor);
      let sub: Sub;
      try {
        sub = new Sub(src, (ok, x) => sub.resume(ok, x, false, (res) => step(res.ok ? next(res.value) : throwInto(res.error))));
      } catch (e) {
        resume = throwInto(e); // the source's `then` threw: the handler's failed wait (I10)
        continue;
      }
      ins.sub = sub;
      return;
    }
  };
  step(next());
  return promise;
}
