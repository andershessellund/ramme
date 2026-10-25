// ---------------------------------------------------------------------------
// The `ramme/platform` subpath (DESIGN.md §4.9, D43; D41, decisions 19–26): the
// platform's waits and callbacks, spelled in ramme.
//
// The rule DESIGN carries: **every platform primitive that waits or calls back
// needs a ramme spelling**, because waiting is where interruption attaches and
// calling back is where context is lost. A wait the driver cannot see is one
// no halt can stop (the body's node is held until the platform is done), and a
// callback the platform makes runs outside every frame, where `current()`,
// `lookup`, `own` and `fork` have no node (D41, decision 18). So:
//
// - a **wait is an op**: `fetch` and `nextFrame` are `wait`s over the
//   platform's own call, handed the yielding body's signal, so a halt aborts
//   the request or cancels the frame (`yield*` of a bare promise is TS2488);
// - a **callback re-enters its node**: `listen` runs a handler synchronously
//   inside the registering node, as `node.run` does, and removes it when the
//   node ends (an `own` entry, beside the native `{ signal }`);
// - an **async iteration is `each`**: `for await` is TS1103 in a generator,
//   and a halt or a `break` closes the source as release work.
//
// The lints refuse the bare forms (eslint-plugin-ramme: `no-bare-fetch`,
// `no-bare-listener`, `no-bare-async-iteration`, and `no-timers` for
// `requestAnimationFrame`). Timers are the core's `sleep`; a library's
// callback that expects a promise is the core's `promised`.
//
// A layer over the core: this module imports the public API only (`./index.js`,
// and types), so it can do nothing a user could not, and it imports no Node
// module (decision 19): the browser is a target. Nothing here is read when the
// module loads: each primitive reads the platform's global (`fetch`,
// `requestAnimationFrame`) when its op runs.
// ---------------------------------------------------------------------------

import type { Context, Instruction, Op, Operation } from './index.js';
import { CreationViolationError, NoCurrentNodeError, current, wait } from './index.js';

/**
 * `op` named `name`: the fiber it runs in when `fork`, `attempt`, a group or a pool is handed it is named after the
 * primitive (`fetch`, `nextFrame`), not after the core's `wait` under it (D44, decision 4). The core reads an op's
 * `name` property when it runs one so; writing it is open to any code, so the layer still does nothing a user could not.
 */
function named<T>(op: Op<T>, name: string): Op<T> {
  (op as { name?: string }).name = name;
  return op;
}

/**
 * `make()`, the core's verb `verb` under the primitive `primitive`: its guards' errors (`NoCurrentNodeError` outside
 * any node, `CreationViolationError` during a creation) are thrown again naming the primitive the caller wrote.
 */
function guarded<T>(primitive: string, verb: string, make: () => T): T {
  try {
    return make();
  } catch (e) {
    const named = (m: string): string => `${primitive}()${m.slice(verb.length + 2)}`;
    if (e instanceof NoCurrentNodeError && e.message.startsWith(`${verb}()`)) throw new NoCurrentNodeError(named(e.message));
    if (e instanceof CreationViolationError && e.message.startsWith(`${verb}()`)) throw new CreationViolationError(named(e.message));
    throw e;
  }
}

// --- fetch -----------------------------------------------------------------------

/**
 * `globalThis.fetch(input, init)` as a wait (D43, decision 20), with the global's own parameters: `yield* fetch(url)`
 * in a body. Lazy, as every work op: the request is made when the op is yielded (or awaited through a node), through
 * the `fetch` the platform has then. `init` is passed on, with a signal that combines a `Request` input's own signal
 * and `init.signal` with the signal `wait((signal) => …)` hands the op (the yielding body's `signal()`; in a halted
 * `finally` the unwind fiber's release deadline, so cleanup can still make a request). A `Request` input also keeps
 * its `referrer` and `referrerPolicy` unless `init` sets them: a non-empty `init` resets both (the Fetch standard's
 * `Request(input, init)`), and this one always carries the signal. A halt aborts the request through that signal, and
 * the wait finishes, by the request's rejection, before the body is returned (DESIGN.md §4.2's third row); the
 * `AbortError` is the halt's echo, never reported. The caller's own signal firing (the `Request`'s, `init.signal`) is
 * the request's failure, thrown at the `yield*`. Read the body with `yield* wait(res.json())`.
 *
 * @throws NoCurrentNodeError outside any node; CreationViolationError during a creation (when the op is made).
 */
export function fetch(input: string | URL | Request, init?: RequestInit): Op<Response> {
  const op = guarded('fetch', 'wait', () =>
    wait((signal) => {
      // Read structurally: `Request` is no global this module names (the browser check), and a URL has no signal.
      const request = typeof input === 'object' && 'signal' in input ? input : undefined;
      const signals = [request?.signal, init?.signal ?? undefined, signal].filter((s): s is AbortSignal => s !== undefined);
      const kept = request === undefined ? {} : { referrer: request.referrer, referrerPolicy: request.referrerPolicy };
      return globalThis.fetch(input, { ...kept, ...init, signal: signals.length === 1 ? signal : AbortSignal.any(signals) });
    }),
  );
  return named(op, 'fetch');
}

// --- listen ------------------------------------------------------------------------

/** What `listen` registers on: Node's `EventEmitter` read structurally (no `node:` import), or any object with both. */
export interface EventEmitterLike {
  on(type: string | symbol, listener: (...args: any[]) => void): unknown;
  off(type: string | symbol, listener: (...args: any[]) => void): unknown;
}

const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor as abstract new () => unknown;
const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor as abstract new () => unknown;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as abstract new () => unknown;

/**
 * The options `listen` takes on an `EventTarget`: the DOM's `AddEventListenerOptions`, declared here, since that name
 * is no global without the DOM library (Node's types keep it module-local), and a consumer on Node compiles this file.
 */
interface ListenOptions {
  readonly capture?: boolean;
  readonly once?: boolean;
  readonly passive?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * One registration, the entry `listen` owns on the registering node (decision 22): its release removes the listener,
 * and fails with what the handler threw (decision 21), so a throw surfaces from the node's completion.
 */
class Listener {
  #remove: (() => void) | undefined = undefined;
  readonly #errors: unknown[] = [];
  #released = false;
  /** Handler calls on the stack (a handler can dispatch its own event). */
  #calls = 0;
  /** A release that ran during a handler call: settled when the outermost call has returned, with what the calls threw. */
  #held: PromiseWithResolvers<void> | undefined = undefined;

  constructor(readonly node: Context) {}

  /** Registered: neither removed nor released. The wrapper reads it, since an emitter still calls a listener removed during the same `emit`. */
  get live(): boolean {
    return this.#remove !== undefined;
  }

  attach(remove: () => void): void {
    this.#remove = remove;
  }

  /** Remove the listener now, once. */
  remove(): void {
    const remove = this.#remove;
    this.#remove = undefined;
    remove?.();
  }

  /** Removed before the node ends (`opts.signal`, `once`): the entry goes too, so a long-lived node keeps none per registration. */
  end(): void {
    this.remove();
    if (!this.#released) void this.node.release(this);
  }

  /**
   * The handler threw (decision 21): never into the emitter. The error aborts the node and is the entry's release
   * failure, so it surfaces from the node's completion, as a `'link'` child's failure does: `defect(e)`.
   */
  fail(error: unknown): void {
    this.#errors.push(error);
    try {
      this.node.abort(error);
    } catch {
      // A value's node still in its creation cannot be aborted (PendingNodeError): its release reports the error.
    }
  }

  /** A handler call starts. */
  enter(): void {
    this.#calls++;
  }

  /**
   * A handler call has returned, or thrown `thrown` (decision 21), which fails the entry first: off the stack, so a
   * release the abort starts runs at once. The outermost call settles a release held meanwhile (see `release`).
   */
  exit(thrown: { readonly error: unknown } | undefined): void {
    this.#calls--;
    if (thrown !== undefined) this.fail(thrown.error);
    const held = this.#held;
    if (this.#calls > 0 || held === undefined) return;
    this.#held = undefined;
    const errors = this.#errors.splice(0);
    if (errors.length === 0) held.resolve();
    else held.reject(failureOf(errors));
  }

  /**
   * The entry's release: remove the listener, then fail with what the handler threw. During a handler call (it ran
   * `close()`, `abort()` or `releaseAll()`, or fired its `opts.signal`) the handler can still throw, which is this
   * release's failure all the same: the release waits for the call to return, so the node's completion does too.
   */
  release(): Promise<void> | undefined {
    this.#released = true;
    this.remove();
    if (this.#calls > 0) return (this.#held ??= Promise.withResolvers<void>()).promise;
    const errors = this.#errors.splice(0);
    if (errors.length > 0) throw failureOf(errors);
    return undefined;
  }
}

/** What a listener's release fails with: the handler's one throw, or all of them. */
function failureOf(errors: readonly unknown[]): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, 'listen(): the handler threw');
}

/**
 * Whether `x` is an op, read by its shape as the layer can read it (the core's own test is internal): an `Operation`
 * (`[Symbol.iterator]`) that is a thenable. A promise has no `Symbol.iterator` and an array no `then`.
 */
function isOpLike(x: unknown): boolean {
  if ((typeof x !== 'object' && typeof x !== 'function') || x === null) return false;
  const o = x as { then?: unknown; [Symbol.iterator]?: unknown };
  return typeof o.then === 'function' && typeof o[Symbol.iterator] === 'function';
}

function isEventTarget(x: unknown): x is EventTarget {
  return typeof (x as { addEventListener?: unknown } | null | undefined)?.addEventListener === 'function';
}

function isEmitter(x: unknown): x is EventEmitterLike {
  const e = x as { on?: unknown; off?: unknown } | null | undefined;
  return typeof e?.on === 'function' && typeof e?.off === 'function';
}

/**
 * Register `handler` for `type` on `target` (D43, decision 21): an `EventTarget`, or by the second overload an
 * emitter with `on`/`off` (Node's `EventEmitter`). Each event runs the handler synchronously inside the node current
 * at registration, as `node.run(fn)` does, so `current()`, `lookup`, `own`, `fork`, `child` and `signal()` act on that
 * node, `preventDefault()` works, and nothing waits: a handler that has work to wait for forks a task, which reports
 * by the node's own destination rules (a body's default `'join'`, a bodiless node's `onFailure`; `listen` takes no
 * `onFailure`). The handler is synchronous: a generator function or an `async` function is refused with a `TypeError`
 * and nothing is registered. A handler that returns an op (a task as the handler, `(e) => save(e)`) made work that
 * nothing runs: its call throws a `TypeError`, which aborts the node as any throw from it does.
 *
 * The listener is removed when the node ends: at its delivery, through the native `{ signal }` (on an emitter, or a
 * target that ignores `signal` as ws's `WebSocket` does, `remove` at the signal's `abort`), and at an end without one
 * (`close()`, a body's natural exit), through an entry the node owns (decision 22). An event that still reaches it
 * after the delivery (an emitter's call of a listener removed during the same `emit`, an earlier listener of the
 * node's signal dispatching) is dropped. `opts.signal` removes it early. A node already delivered registers nothing.
 * Every call is its own registration, as an emitter's `on` is: the same handler listened twice runs twice per event,
 * where `addEventListener` would register it once.
 *
 * A throw from the handler is never rethrown into the target: it aborts the node and surfaces from its completion
 * (decision 21), also when the handler ended its own registration first (`close()`, `abort()`, `releaseAll()`, its
 * `opts.signal`): the entry's release then waits for the handler to return. An event dispatched during a creation (a
 * factory that emits, or aborts a signal listened to) runs no handler: `node.run` refuses the creation's frame (I16),
 * and its `CreationViolationError` is thrown to the dispatcher, as a bare listener's `node.run` would throw it, so the
 * creation fails, never the registering node.
 *
 * @throws NoCurrentNodeError outside any node; TypeError for a handler that is not a synchronous function, or a target
 * that is neither an `EventTarget` nor an emitter.
 */
export function listen<E extends Event = Event>(
  target: EventTarget,
  type: string,
  handler: (event: E) => void,
  opts?: ListenOptions,
): void;
export function listen(
  target: EventEmitterLike,
  type: string | symbol,
  handler: (...args: any[]) => void,
  opts?: { readonly signal?: AbortSignal },
): void;
export function listen(
  target: EventTarget | EventEmitterLike,
  type: string | symbol,
  handler: (...args: any[]) => void,
  opts?: ListenOptions | { readonly signal?: AbortSignal },
): void {
  if (typeof handler !== 'function') throw new TypeError('listen(): the handler must be a function');
  if (handler instanceof GeneratorFunction || handler instanceof AsyncGeneratorFunction || handler instanceof AsyncFunction)
    throw new TypeError(
      'listen(): the handler must be a synchronous function: it runs once per event inside its node, where nothing ' +
        'waits; fork a task from it for work that waits',
    );
  const onTarget = isEventTarget(target);
  if (!onTarget && !isEmitter(target))
    throw new TypeError('listen(target): target must be an EventTarget, or an emitter with on() and off()');
  const node = guarded('listen', 'current', current);
  const early = opts?.signal;
  if (node.signal.aborted || early?.aborted === true) return; // removed at the delivery: a delivered node registers nothing
  const listener = new Listener(node);
  node.own(listener, (l) => l.release());
  const once = onTarget && (opts as ListenOptions | undefined)?.once === true;
  const wrapped = (...args: unknown[]): void => {
    // Removed, or due to be: an emitter still calls a listener removed during the same `emit`, and the node's signal
    // fires its own listeners (one may dispatch here) before the dependent signal handed as `{ signal }` fires.
    if (!listener.live || node.signal.aborted || early?.aborted === true) return;
    let entered = false;
    let thrown: { readonly error: unknown } | undefined;
    listener.enter();
    try {
      node.run(() => {
        entered = true;
        const r: unknown = Reflect.apply(handler, target, args);
        // A task as the handler, or `(e) => save(e)`: the op is made and nothing runs it (D44, decision 1).
        if (isOpLike(r))
          throw new TypeError(
            'listen(): the handler returned an op, which nothing runs: a handler is synchronous and nothing waits on ' +
              'what it returns; fork the work instead, (e) => void fork(save(e))',
          );
        return r;
      });
    } catch (e) {
      // Refused before the handler ran (a dispatch during a creation, I16): the dispatcher's error, not the handler's.
      if (!entered) throw e;
      thrown = { error: e };
    } finally {
      listener.exit(thrown);
      if (once) listener.end(); // the platform removed it already
    }
  };
  const onEarly = early === undefined ? undefined : (): void => listener.end();
  if (onTarget) {
    const capture = (opts as ListenOptions | undefined)?.capture === true;
    // Decision 22's `AbortSignal.any([signal(), opts.signal])`, a dependent signal even alone: the platform keeps what it
    // registers for `{ signal }` after the listener is removed, on that signal, so the node's own stays clean.
    const signal = AbortSignal.any(early === undefined ? [node.signal] : [node.signal, early]);
    target.addEventListener(type as string, wrapped, { ...opts, signal });
    // For a target that ignores `signal` (ws's `WebSocket` reads `once` only), as an emitter's removal is made.
    const onDelivery = (): void => listener.remove();
    signal.addEventListener('abort', onDelivery, { once: true });
    listener.attach(() => {
      target.removeEventListener(type as string, wrapped, { capture });
      signal.removeEventListener('abort', onDelivery);
      if (onEarly !== undefined) early!.removeEventListener('abort', onEarly);
    });
  } else {
    const emitter = target as EventEmitterLike;
    emitter.on(type, wrapped);
    const onDelivery = (): void => listener.remove();
    node.signal.addEventListener('abort', onDelivery, { once: true });
    listener.attach(() => {
      emitter.off(type, wrapped);
      node.signal.removeEventListener('abort', onDelivery);
      if (onEarly !== undefined) early!.removeEventListener('abort', onEarly);
    });
  }
  if (onEarly !== undefined) early!.addEventListener('abort', onEarly, { once: true });
}

// --- nextFrame ---------------------------------------------------------------------

interface FrameGlobals {
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
}

/** The next frame, cancelled when `signal` fires; the platform's globals are read now, when the op runs. */
function frame(signal: AbortSignal): Promise<number> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const g = globalThis as FrameGlobals;
  let cancel: () => void;
  const onAbort = (): void => {
    reject(signal.reason); // first: the wait finishes even if cancelling throws
    cancel();
  };
  const fired = (time: number): void => {
    signal.removeEventListener('abort', onAbort);
    resolve(time);
  };
  const request = g.requestAnimationFrame;
  if (typeof request === 'function') {
    const id = request(fired);
    cancel = () => g.cancelAnimationFrame?.(id);
  } else {
    // No frames (Node): a 16 ms timer, so code written for a browser runs, and tests do.
    const id = setTimeout(() => fired(performance.now()), 16);
    cancel = () => clearTimeout(id);
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
}

/**
 * The next animation frame as a wait (D43): `yield* nextFrame()` is the frame's timestamp. `requestAnimationFrame` is
 * read and called when the op is yielded; where it is absent (Node) a 16 ms timer stands in, resolving with
 * `performance.now()`. A halted body is returned at once and its frame cancelled (`cancelAnimationFrame`), as a halt
 * clears `sleep`'s timer (D34): the frame is handed the body's signal, whose firing cancels it and ends the wait. A
 * body that is not halted at its delivery (an `observe` body) has the wait rejected with the signal's reason, as a
 * `fetch` is.
 *
 * @throws NoCurrentNodeError outside any node; CreationViolationError during a creation (when the op is made).
 */
export function nextFrame(): Op<number> {
  return named(
    guarded('nextFrame', 'wait', () => wait(frame)),
    'nextFrame',
  );
}

// --- each ----------------------------------------------------------------------------

/**
 * One `for (const x of yield* each(source))` loop: the source's iterator, its last read, whether the loop body has
 * been handed that item, and how the iteration ended. It is the entry `each` owns on the node (decision 29: the
 * loop iterator's own `return()` releases it, an eager release that calls the source's `return()` at once as release
 * work; nothing waits inside that `return()`, and the driver's node waits for the release).
 */
class EachLoop<T> {
  #last: IteratorResult<T> | undefined = undefined;
  /** The loop body has the last item: the next one needs `yield* each.next()`. */
  #served = false;
  /** The iteration is over, however it ended: the loop's iterator is done. */
  over = false;
  /** The source needs no `return()`: it was exhausted, or a read failed. */
  #closed = false;
  /** The entry's release has run. */
  #released = false;

  constructor(
    readonly node: Context,
    readonly iterator: AsyncIterator<T>,
  ) {}

  /** Read the next item; a halt stops waiting at once (and the release then closes the source). */
  *advance(): Generator<Instruction, void, unknown> {
    let r: IteratorResult<T>;
    try {
      r = yield* wait(() => Promise.resolve(this.iterator.next()), { abandon: true });
    } catch (e) {
      this.#closed = true; // a failed read ends the iteration and is never followed by return(), as in `for await`
      this.finish();
      throw e;
    }
    this.#last = r;
    this.#served = false;
    if (r.done === true) {
      this.#closed = true; // exhausted: never sent return()
      this.finish();
    }
  }

  /**
   * The iteration is over: off the node's loop stack, and its entry released, which returns the source unless it is
   * closed. Twice is harmless (a failed read inside the loop, then the loop's `return()`): the entry is released once.
   */
  finish(): void {
    this.over = true;
    const loops = active.get(this.node);
    const i = loops?.lastIndexOf(this as EachLoop<unknown>) ?? -1;
    if (i >= 0) loops!.splice(i, 1);
    if (!this.#released) void this.node.release(this);
  }

  /** The entry's release (once): the source's `return()`, unless it is closed. */
  close(): Promise<void> | undefined {
    this.#released = true;
    if (this.#closed) return undefined;
    const r = this.iterator.return?.();
    return r === undefined ? undefined : Promise.resolve(r).then(() => undefined);
  }

  /** What `yield* each(source)` gives the loop: a synchronous iterator over the item read last. */
  items(): IterableIterator<T> {
    return {
      next: (): IteratorResult<T> => {
        if (this.over) return { done: true, value: undefined };
        if (this.#served) {
          this.finish(); // the loop is broken off: the source is returned
          throw new TypeError(
            'each(): the loop went on without yield* each.next(): end every pass of ' +
              'for (const x of yield* each(source)) { …; yield* each.next(); } with it, a `continue` included',
          );
        }
        this.#served = true;
        return { done: false, value: this.#last!.value as T };
      },
      // break, return, a throw, a halt or a fail: the body left the loop.
      return: (): IteratorResult<T> => {
        this.finish();
        return { done: true, value: undefined };
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  }
}

/** Each node's loops in progress, innermost last: `each.next()` advances the innermost. */
const active = new WeakMap<Context, EachLoop<unknown>[]>();

function* begin<T>(source: AsyncIterable<T>): Generator<Instruction, Iterable<T>, unknown> {
  const node = current();
  const loop = new EachLoop<T>(node, source[Symbol.asyncIterator]());
  node.own(loop, (l) => l.close());
  yield* loop.advance();
  if (!loop.over) {
    let loops = active.get(node);
    if (loops === undefined) active.set(node, (loops = []));
    loops.push(loop as EachLoop<unknown>);
  }
  return loop.items();
}

function* advanceInnermost(): Generator<Instruction, void, unknown> {
  const loops = active.get(current());
  const loop = loops?.[loops.length - 1];
  if (loop === undefined)
    throw new TypeError('each.next() outside a for (const x of yield* each(source)) loop of this body');
  yield* loop.advance();
}

/**
 * Managed iteration over an async iterable (D43, decision 24), the spelling of `for await`, which a generator body
 * cannot write (TS1103):
 *
 * ```ts
 * for (const chunk of yield* each(stream)) {
 *   handle(chunk);
 *   yield* each.next(); // every pass, a `continue` included
 * }
 * ```
 *
 * `yield* each(source)` waits for the first item and gives a synchronous iterable over the current one; `yield*
 * each.next()` waits for the next. The body owns the iteration: when it leaves the loop early (`break`, `return`, a
 * throw, a `fail`) or is halted in it, the source's `return()` is called once, as release work: the node completes
 * only after it has settled, and its failure is the node's release failure. An exhausted source, or one whose read
 * failed, is never sent `return()`. A halt stops waiting for a read at once. A pass that skips `each.next()` throws a
 * `TypeError` at the loop's head, and the source is closed.
 */
export const each: {
  <T>(source: AsyncIterable<T>): Operation<Iterable<T>>;
  /** Wait for the next item of the innermost `each` loop of the current body. */
  next(): Operation<void>;
} = Object.assign(
  <T>(source: AsyncIterable<T>): Operation<Iterable<T>> => {
    if (typeof (source as { [Symbol.asyncIterator]?: unknown } | null | undefined)?.[Symbol.asyncIterator] !== 'function')
      throw new TypeError('each(source): source must be an async iterable');
    return { [Symbol.iterator]: () => begin(source) };
  },
  { next: (): Operation<void> => ({ [Symbol.iterator]: () => advanceInnermost() }) },
);
