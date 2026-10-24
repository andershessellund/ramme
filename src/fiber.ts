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
// ---------------------------------------------------------------------------

import { attempt, call, fork } from './ambient.js';
import type { Body, Fiber, Outcome, Task, TaskOptions } from './context.js';
import { TASK } from './internal-context.js';
import type { TaskLike } from './internal-context.js';

class TaskImpl<A extends unknown[], T> implements Task<A, T>, TaskLike<A, T> {
  readonly [TASK] = true as const;

  constructor(
    readonly body: Body<T, A>,
    readonly opts: TaskOptions,
    readonly name: string,
  ) {}

  /** Run in a new child of the current node, concurrently; the body starts in a microtask (I20). */
  fork(...args: A): Fiber<T> {
    return fork<T, A>(this, ...args);
  }

  /** Run in a new child of the current node and await it; lends the current node until it settles (DESIGN.md §4.9). */
  call(...args: A): Promise<T> {
    return call<T, A>(this, ...args);
  }

  /** `call`, resolving with the outcome instead of throwing the failure (DESIGN.md §4.5). */
  attempt(...args: A): Promise<Outcome<T>> {
    return attempt<T, A>(this, ...args);
  }

  /** Per-use overrides: the options merged over the definition's, and the name if given. */
  with(o: TaskOptions): Task<A, T> {
    return new TaskImpl(this.body, { ...this.opts, ...o }, o.name ?? this.name);
  }

  /** Partial application: a task of no arguments, which is what `all`, `race`, `settle` and pools take. */
  bind(...args: A): Task<[], T> {
    const body = this.body;
    return new TaskImpl<[], T>(() => body(...args), this.opts, this.name);
  }
}

/**
 * Define a task: a body that can only be `fork`ed or `call`ed, never invoked
 * as a plain async function. Options live at the definition and are
 * overridden per use with `with`.
 *
 * @example
 * const handle = task(async (req: Request) => {
 *   const db = lookup(Db);
 *   return db.query(req);
 * });
 * await handle.call(req); // a new child node, joined
 * handle.fork(req);       // a new child node, concurrent
 */
export function task<A extends unknown[], T>(body: Body<T, A>, opts: TaskOptions = {}): Task<A, T> {
  if (typeof body !== 'function') throw new TypeError('task(body): body must be a function');
  return new TaskImpl(body, opts, opts.name ?? (body.name || 'anonymous'));
}
