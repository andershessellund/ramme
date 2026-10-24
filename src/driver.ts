// ---------------------------------------------------------------------------
// The driver (DESIGN.md §4.14, D41): steps a generator body.
//
// A body that returns a generator object, or an op (D41, decision 28), is
// driven: each step is one `next(v)`, `throw(e)` or `return()` on its
// iterator, run in the body's frame (`runInFrame`), so `current()`, `own`,
// `lookup` and `fork` in a step see the node, and so do the ops the step
// makes. A yielded value that is not an op's instruction gets a `TypeError`
// thrown back at that `yield`.
//
// An instruction is subscribed at the `yield*` that yielded it, through the
// op's `drive`, which is `ManagedPromise.thenFor` with the body's node as the
// awaiter. The managed-await predicates of PR #4 (D39) therefore decide when a
// generator body is halted: where an async body's await would reject with its
// own interruption, the awaiter is applied when the rejection arrives, and the
// driver calls the generator's `return(HALT)` there instead (decision 8). A
// failure of awaited work is thrown in with `throw(error)`, consumed as the
// op's resume step consumes it; the body's own interruption never is. The body
// resumes in the source's reaction (decision 7), never inside the step that
// made the op, so `return()` never meets a running generator.
//
// After the halt every `yield*` is inside a `finally` (decision 11, U3): the
// driver makes the body's unwind fiber, a release fiber of the node that no
// delivery reaches, and steps the generator in a frame that still names the
// node, so every synchronous verb addresses the node, while the ops it makes
// there run on the unwind fiber, as release work: none is interrupted, and
// none of their resume steps consumes a failure; only a user promise's own
// failure there is recorded as a release failure. A finally-yield whose wait
// includes the unwind itself is returned there, with a warning (decision 12).
// An op the body made before its halt is waited for there as release work
// (transitional: ops are eager). The generator's completion is the node's body
// exit: a halted body is `aborted` by state whatever its `finally` did (D24). A
// generator that ends with any value other than the halt's sentinel lost the
// halt, through a `yield*` in a helper's `finally` or a `return` in a
// `finally`, and so did one that uses the sentinel, which that helper's
// `yield*` gave it; dev mode reports either (decision 29).
//
// A failure handler's generator is driven in the handler's frame and never
// halted; its waits are the handler's own (`thenAsHandler`), as an async
// handler's are (DESIGN.md §4.7).
// ---------------------------------------------------------------------------

import { runDetached, runInFrame } from './context-storage.js';
import type { Frame, HandlerRun } from './context-storage.js';
import { describeNode } from './inject.js';
import { isInstruction } from './managed.js';
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

type Driven = Iterator<unknown, unknown, unknown>;
type Resume = (it: Driven) => IteratorResult<unknown, unknown>;

/** Dev mode is `process.env.NODE_ENV !== 'production'`, and always on where `process` is absent (DESIGN.md §4.4). */
function dev(): boolean {
  return (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV !== 'production';
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

/** One driven body: a fiber's, a release fiber's (an entry's release, a shield) or one returning an op. */
class BodyDriver {
  readonly #node: NodeImpl;
  #it: Driven | undefined;
  #frame: Frame;
  /** Made at the halt (U3): the parent of the ops the `finally` runs, and its completion's trigger. */
  #unwind: { readonly fiber: NodeImpl; readonly done: () => void } | undefined = undefined;
  /** From the halt on: its sentinel (HALT, or dev mode's reporting one) and the once-only report of its loss. */
  #halted: { readonly sentinel: unknown; readonly report: () => void } | undefined = undefined;

  constructor(node: NodeImpl, it: Driven, frame: Frame) {
    this.#node = node;
    this.#it = it;
    this.#frame = frame;
  }

  /**
   * Run steps until the generator yields an op, which is subscribed, or ends. A synchronous throw from the step is
   * the body's throw; a yielded non-op, or a finally-yield that would deadlock the unwind, is answered at once.
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
      let op = ins.op;
      const unwind = this.#unwind?.fiber;
      if (unwind !== undefined) {
        // Decision 12: a wait for the completion of the node, an ancestor, or the unwind itself never ends, since that
        // completion waits for this unwind, nor does a join of a fiber only such a completion ends (a fork the node
        // owns, which no delivery reaches). Returned there, as an uncaught interruption ended an async body's `finally`.
        const waitsFor = op.waitsFor;
        if (waitsFor !== undefined && waitsFor(unwind)) {
          if (dev())
            console.warn(
              `ramme: ${describeNode(this.#node)} yields, in the finally its halt runs, an op that waits for its own ` +
                'completion or an ancestor’s (its own [Symbol.asyncDispose](), its entry’s release, an owner’s close()), ' +
                'or for a fiber that only such a completion ends (a join of a fork it owns: yield* release(f) stops it ' +
                'first), which waits for this finally: the generator is returned there instead of waiting forever',
            );
          resume = this.#returnHalt();
          continue;
        }
        if (op.target === this.#node) {
          // Transitional (eager ops): an op this body made before its halt was its own wait, which the halt has
          // interrupted. Here it is release work, waited for as a failure handler waits for it, never rejected with the
          // body's own interruption (DESIGN.md §4.14). One nothing can settle any more is returned there.
          const work = op.asReleaseWork();
          if (work === undefined) {
            if (dev())
              console.warn(
                `ramme: ${describeNode(this.#node)} yields, in the finally its halt runs, an op made before its halt that ` +
                  'nothing settles any more (never()): the generator is returned there instead of waiting forever',
              );
            resume = this.#returnHalt();
            continue;
          }
          op = work;
        }
      }
      const awaiter = unwind ?? this.#node;
      const driven = op;
      ins.sub = runDetached(() =>
        driven.drive(
          awaiter,
          (v) => this.step(next(v)),
          (e, userFailure) => this.#rejected(e, userFailure),
        ),
      );
      return;
    }
  }

  /**
   * A rejected wait: the halt when the body's node is applied (its own interruption, a failure of release work or of
   * `wait(p)` that the halt let finish), else the failure thrown in. A user promise's own failure (`userFailure`, never
   * an interruption nor a ramme op's failure, which its holder reports) in the halted `finally` is also recorded on the
   * unwind fiber, so it is reported as a release failure, caught or not.
   */
  #rejected(error: unknown, userFailure: boolean): void {
    const unwind = this.#unwind?.fiber;
    if (unwind === undefined && this.#node.applied) return this.#halt();
    if (unwind !== undefined && userFailure) unwind.extraErrors.push(error);
    this.step(throwInto(error));
  }

  /** `return(sentinel)` at the `yield*` that waited; the `finally` blocks run from here on under the unwind fiber (U3). */
  #halt(): void {
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
 * Drive a failure handler's generator in its frame (DESIGN.md §4.7, §4.14): every wait is the handler's own, which no
 * delivery rejects and which reports a wait for a node's completion to `run`, and nothing halts it. The first step runs
 * now. The promise settles when the generator ends, rejected with its throw; the parent holds it as a returned promise.
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
      runDetached(
        () =>
          void op.thenAsHandler(
            run,
            (v) => step(next(v)),
            (e: unknown) => step(throwInto(e)),
          ),
      );
      return;
    }
  };
  step(next());
  return promise;
}
