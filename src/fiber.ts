// ---------------------------------------------------------------------------
// Tasks (DESIGN.md §4.5).
//
// A task is a body plus options. It is an object, not a function, so it can
// never be invoked as a bare promise (I27): each `fork`/`call` runs the body
// in a new fiber, a child of the current node. `t.fork(...args)` is
// `fork(t, ...args)`, `t.call(...args)` is `call(t, ...args)` and
// `t.attempt(...args)` is `attempt(t, ...args)`: the same free functions of
// ambient.ts, so `t.call()` in a creation frame throws `CreationViolationError`
// before touching any node, as `call` does (DESIGN.md §3.5).
//
// `E`, the task's expected failures, is inferred from the body's yield union
// (D42): `task` takes the whole union as one type parameter and reads `E` off
// its `Fail` members, D38's pattern, so a body that yields two failure types
// infers their union.
// ---------------------------------------------------------------------------

import { attempt, call, fork } from './ambient.js';
import type { Body, Fiber, Op, Outcome, Task, TaskOptions } from './context.js';
import { TASK } from './internal-context.js';
import type { BodyOf, FailedWith, TaskLike, Yields } from './internal-context.js';

class TaskImpl<A extends unknown[], T, E> implements Task<A, T, E>, TaskLike<A, T> {
  readonly [TASK] = true as const;

  constructor(
    readonly body: Body<T, A>,
    readonly opts: TaskOptions,
    readonly name: string,
  ) {}

  /** Run in a new child of the current node, concurrently; the body starts in a microtask (I20). */
  fork(...args: A): Fiber<T, E> {
    return fork<T, A, never, E>(this, ...args);
  }

  /** Run in a new child of the current node and wait for it: `yield* t.call(…)` (DESIGN.md §4.5). Lazy, as `call` is. */
  call(...args: A): Op<T, E> {
    return call<T, A, never, E>(this, ...args);
  }

  /** `call`, resolving with the four-way outcome instead of propagating the failure (DESIGN.md §4.5). */
  attempt(...args: A): Op<Outcome<T, E>> {
    return attempt<T, A, never, E>(this, ...args);
  }

  /** Per-use overrides: the options merged over the definition's, and the name if given. */
  with(o: TaskOptions): Task<A, T, E> {
    return new TaskImpl<A, T, E>(this.body, { ...this.opts, ...o }, o.name ?? this.name);
  }

  /** Partial application: a task of no arguments, which is what `all`, `race`, `settle` and pools take. */
  bind(...args: A): Task<[], T, E> {
    const body = this.body;
    return new TaskImpl<[], T, E>(() => body(...args), this.opts, this.name);
  }
}

/**
 * Define a task: a body that can only be `fork`ed or `call`ed, never invoked
 * as a plain function. Options live at the definition and are overridden per
 * use with `with`. The body is a generator function, stepped by the driver
 * (DESIGN.md §4.14), or a synchronous function; an `async` function is no body
 * (D41, decision 5). `yield* fail(e)` in the body ends it with the expected
 * failure `e`, and the task's `E` is the union of what it yields, a callee's
 * re-yielded failures included (D42).
 *
 * @example
 * const handle = task(function* (req: Request) {
 *   const db = lookup(Db);
 *   const row = yield* wait(db.query(req));
 *   if (row === undefined) return yield* fail(new NotFound(req.url)); // Task<[req: Request], Row, NotFound>
 *   return row;
 * });
 * yield* handle.call(req); // a new child node, joined: its value, or its NotFound re-yielded
 * handle.fork(req);        // a new child node, concurrent
 */
export function task<A extends unknown[], T, Y extends Yields = never>(body: BodyOf<T, A, Y>, opts: TaskOptions = {}): Task<A, T, FailedWith<Y>> {
  // `E` is read off the body's yield union alone (`BodyOf`), never off a contextual type (an array of `Task<[], unknown, unknown>`).
  if (typeof body !== 'function') throw new TypeError('task(body): body must be a function');
  return new TaskImpl<A, T, FailedWith<Y>>(body as Body<T, A>, opts, opts.name ?? (body.name || 'anonymous'));
}
