// ---------------------------------------------------------------------------
// Tasks (DESIGN.md §4.5, D44).
//
// A task is a body plus options, and a function: `t(...args)` is the lazy op
// of one run, a new fiber, a child of the node it is made through (D44,
// decision 1). It is `current().call(t, ...args)`, made by ambient.ts's
// `taskCall`, so making it reads the slot: outside any node it throws
// `NoCurrentNodeError`, in a creation frame `CreationViolationError`, before
// touching any node (DESIGN.md §3.5). Nothing runs until the op is yielded, so
// the reason D8′ kept a task uncallable (a bare call ran as an untracked
// promise) is gone; "this is a node" is still decided once, at `task`.
//
// The callable is an arrow (it has no `prototype` and cannot be `new`ed) whose
// prototype is `TASK_PROTOTYPE`: `with`, over `Function.prototype`, so `call`,
// `bind` and `apply` are the platform's (decisions 3, 8). Its own properties
// are the brand, the task's `name`, `body`, `opts` and, for `task(self, body)`,
// the receiver `self` the body runs with (decision 2); `instanceof` is no part
// of the contract. The brand is an own property because `bind` copies the
// prototype and nothing else: `t.bind(null, x)` is a plain function, whose
// call returns `t(x)`'s op, so `fork`, `attempt` and the groups take it as an
// inline body, which runs the op it returns (D41, decision 28), and its
// inherited `with` is a `TypeError`.
//
// `E`, the task's expected failures, is inferred from the body's yield union
// (D42): `task` takes the whole union as one type parameter and reads `E` off
// its `Fail` members, D38's pattern, so a body that yields two failure types
// infers their union.
// ---------------------------------------------------------------------------

import { taskCall } from './ambient.js';
import type { Body, Task, TaskOptions } from './context.js';
import { TASK, isTask } from './internal-context.js';
import type { BodyWith, FailedWith, TaskLike, Yields } from './internal-context.js';

/** A task as fiber.ts makes it: the callable, with the fields every `TaskLike` has. */
type TaskFunction = Task<unknown[], unknown, unknown> & TaskLike;

/** Per-use overrides: the options merged over the definition's, the name if given, and the receiver kept. */
function withOptions(this: TaskFunction, o: TaskOptions): Task<unknown[], unknown, unknown> {
  // `t.bind(…)` inherits `with` and none of the task's own properties: it is a function, not a task (see the header).
  if (!isTask(this))
    throw new TypeError(
      `with() on ${typeof this === 'function' ? `'${(this as { name: string }).name}'` : String(this)}, which is no task: a ` +
        'bound copy of a task (t.bind(…)) is a plain function; call with() on the task itself',
    );
  return makeTask(this.body, this.self, { ...this.opts, ...o }, o.name ?? this.name);
}

/** The prototype of every task: `with`, over `Function.prototype`, whose `call`, `bind` and `apply` a task keeps. */
const TASK_PROTOTYPE: object = Object.create(Function.prototype, {
  with: { value: withOptions, writable: true, configurable: true },
});

function makeTask<A extends unknown[], T, E>(body: Body<T, A>, self: unknown, opts: TaskOptions, name: string): Task<A, T, E> {
  const t: TaskFunction = Object.setPrototypeOf((...args: unknown[]) => taskCall(t, args), TASK_PROTOTYPE) as TaskFunction;
  Object.defineProperties(t, {
    [TASK]: { value: true }, // own, so that a bound copy, which shares the prototype, is no task (see the header)
    name: { value: name, configurable: true },
    body: { value: body },
    opts: { value: opts },
    self: { value: self },
  });
  return t as unknown as Task<A, T, E>;
}

/**
 * Define a task: a body plus options, called to make the lazy op of one run (`yield* t(…)`), or forked
 * (`fork(t(…))`, `fork(t, …)`). Options live at the definition and are overridden per use with `with`. The body is a
 * generator function, stepped by the driver (DESIGN.md §4.5), or a synchronous function; an `async` function is no
 * body (D41, decision 5). `yield* fail(e)` in the body ends it with the expected failure `e`, and the task's `E` is
 * the union of what it yields, a callee's re-yielded failures included (D42).
 *
 * `task(self, body)` binds a receiver (D44, decision 2): the body runs as `body.call(self, …args)`, so a class field
 * `readonly get = task(this, function* get(path: string) { … this.#base … })` reads the instance; `with` keeps it.
 * The free form types `this` as `void`, so a stray `this` is a type error. The second argument being a function
 * makes the first the receiver; otherwise the first is the body and the second the options. The node is named
 * `opts.name`, else the body's name, else `anonymous`.
 *
 * @example
 * const handle = task(function* handle(req: Request) {
 *   const db = lookup(Db);
 *   const row = yield* wait(db.query(req));
 *   if (row === undefined) return yield* fail(new NotFound(req.url)); // Task<[req: Request], Row, NotFound>
 *   return row;
 * });
 * yield* handle(req);     // a new child node, joined: its value, or its NotFound re-yielded
 * fork(handle(req));      // a new child node, concurrent
 */
export function task<S, A extends unknown[], T, Y extends Yields = never>(
  self: S,
  body: BodyWith<S, T, A, Y>,
  opts?: TaskOptions,
): Task<A, T, FailedWith<Y>>;
export function task<A extends unknown[], T, Y extends Yields = never>(body: BodyWith<void, T, A, Y>, opts?: TaskOptions): Task<A, T, FailedWith<Y>>;
export function task(...args: unknown[]): Task<unknown[], unknown, unknown> {
  // `E` is read off the body's yield union alone (`BodyWith`), never off a contextual type (an array of `AnyMember`).
  const bound = typeof args[1] === 'function';
  const [self, body, opts] = bound ? args : [undefined, args[0], args[1]];
  if (typeof body !== 'function') throw new TypeError('task(body): body must be a function');
  const o = (opts ?? {}) as TaskOptions;
  return makeTask(body as Body<unknown, unknown[]>, self, o, o.name ?? (body.name || 'anonymous'));
}
