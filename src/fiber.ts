// ---------------------------------------------------------------------------
// Fiber — structured async execution for ramme
//
// Fiber.call   — scoped sequential async (must be awaited immediately)
// Fiber.spawn  — concurrent async unit, may outlive caller (returns Fiber<T>)
// Fiber.fork   — structured concurrent unit, ambient context (returns Fiber<T>)
// Fiber.join   — await a fiber with observability (throws on error)
// Fiber.result — await a fiber with observability (never throws)
// withAbortSignal — bridge to AbortSignal-based APIs
// ---------------------------------------------------------------------------

import { ContextImpl } from './context-impl.js';
import { getCurrentContext, getContextStorage } from './context-storage.js';
import type { Context, Provider } from './context.js';
import { createInjectionKey } from './context-key.js';
import { valueProvider } from './provider-util.js';
import type { ManagedResource } from './resource.js';
import { Drain, Abort } from './resource.js';
import type { Scope } from './scope.js';
import {
  nextFiberId,
  resolveFiberReceiver,
  fiberExec,
  emitCallEnter,
  emitCallLeave,
  emitJoinEnter,
  emitJoinLeave,
} from './fiber-exec.js';

// ---------------------------------------------------------------------------
// Internal — ambient fiber tracking
// ---------------------------------------------------------------------------

/** Injection key for the current fiber. Provided on fiber child contexts. */
const FIBER_KEY = createInjectionKey<FiberImpl<unknown>>('Fiber');

// ---------------------------------------------------------------------------
// FiberOptions / ForkOptions
// ---------------------------------------------------------------------------

export interface FiberOptions {
  /** Human-readable name for debugging. Defaults to fn.name or 'anonymous'. */
  name?: string;
  /** Explicit parent context. Defaults to the current ambient context. */
  context?: Context;
  /** Additional providers for the fiber's child context. */
  providers?: Provider<unknown>[];
  /** Scopes to attach to the fiber's child context. */
  scopes?: Scope[];
}

/** Options for Fiber.fork — no explicit context (always uses ambient). */
export interface ForkOptions {
  /** Human-readable name for debugging. Defaults to fn.name or 'anonymous'. */
  name?: string;
  /** Additional providers for the fiber's child context. */
  providers?: Provider<unknown>[];
  /** Scopes to attach to the fiber's child context. */
  scopes?: Scope[];
}

// ---------------------------------------------------------------------------
// FiberResult<T> — settled outcome (used by Fiber.result)
// ---------------------------------------------------------------------------

/** Discriminated union returned by `Fiber.result()`. Never throws. */
export type FiberResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'error'; readonly error: unknown };

// ---------------------------------------------------------------------------
// Fiber<T> — public interface (returned by Fiber.spawn / Fiber.fork)
// ---------------------------------------------------------------------------

/**
 * A lightweight concurrent unit.
 *
 * Not directly awaitable — use `Fiber.join(fiber)` (throws on error)
 * or `Fiber.result(fiber)` (never throws) for observable awaiting.
 *
 * `.promise` provides the raw Promise for interop (Promise.all, etc.)
 * but bypasses observability.
 *
 * `.abort()` interrupts the fiber by aborting its context.
 */
export interface Fiber<T> {
  /** Unique numeric ID for observability. */
  readonly id: number;
  /** Human-readable name for debugging. */
  readonly name: string;
  /** The underlying Promise — escape hatch for Promise.all / interop. */
  readonly promise: Promise<T>;
  /** Abort this fiber. Triggers context abort + disposal. */
  abort(): void;
}

// ---------------------------------------------------------------------------
// FiberImpl<T> — internal implementation
// ---------------------------------------------------------------------------

class FiberImpl<T> implements ManagedResource {
  readonly id = nextFiberId();
  readonly name: string;

  /** Context stack for Fiber.call stack-top enforcement. */
  _contextStack: ContextImpl[] = [];

  /** The fiber's own child context (set for spawn fibers). */
  _rootContext: ContextImpl | undefined;

  /** Whether the fiber's promise has settled. */
  _settled = false;

  /** The execution promise. Set immediately after construction. */
  _promise!: Promise<T>;

  constructor(name: string, rootContext?: ContextImpl) {
    this.name = name;
    this._rootContext = rootContext;
  }

  get stackTop(): ContextImpl | undefined {
    return this._contextStack[this._contextStack.length - 1];
  }

  get promise(): Promise<T> {
    return this._promise;
  }

  abort(): void {
    if (this._rootContext) {
      this._rootContext[Abort]();
      this._rootContext.dispose();
    }
  }

  // --- ManagedResource protocol ---

  /**
   * Drain: wait for the fiber to complete.
   * Called during parent drain — ensures the parent doesn't proceed
   * to flush until this fiber has finished.
   */
  [Drain](): Promise<void> | void {
    if (this._settled) return;
    return this._promise.then(
      () => {},
      () => {},
    );
  }

  /**
   * Abort: propagate abort to the fiber's context.
   * The child context is also registered on the parent directly,
   * so this is belt-and-suspenders.
   */
  [Abort](): void {
    this._rootContext?.[Abort]();
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveParent(label: string, opts?: FiberOptions): ContextImpl {
  const ctx = opts?.context ? (opts.context as unknown as ContextImpl) : getCurrentContext();
  if (!ctx) {
    throw new Error(
      `${label} requires a context — either pass { context } or call from within an active context.`,
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Fiber.call — scoped sequential async execution
// ---------------------------------------------------------------------------

async function fiberCall<T>(fn: () => Promise<T>, opts?: FiberOptions): Promise<T> {
  const parentCtx = resolveParent('Fiber.call()', opts);
  const name = opts?.name ?? (fn.name || 'anonymous');

  // Look for an ambient fiber (nested call within call or spawn)
  const ambientFiber = parentCtx.get(FIBER_KEY, { optional: true }) as
    | FiberImpl<unknown>
    | undefined;

  if (ambientFiber) {
    const ambient = getCurrentContext();
    // Stack-top enforcement: ambient must match the fiber's stack top.
    // A mismatch means a previous Fiber.call was not awaited.
    if (ambientFiber.stackTop !== undefined && ambientFiber.stackTop !== ambient) {
      throw new Error(
        `Fiber.call() detected an unawaited call — ambient context does not match ` +
          `the fiber's stack top. Always await Fiber.call(). ` +
          `(fiber: '${ambientFiber.name}')`,
      );
    }
  }

  // Build providers for the child context
  const providers: Provider<unknown>[] = opts?.providers ? [...opts.providers] : [];

  let fiber: FiberImpl<unknown>;
  if (ambientFiber) {
    fiber = ambientFiber;
  } else {
    // First call in this chain — create a tracking fiber
    fiber = new FiberImpl(name);
    providers.push(valueProvider(FIBER_KEY, fiber) as Provider<unknown>);
  }

  const child = new ContextImpl(providers, parentCtx, opts?.scopes, undefined, name);

  fiber._contextStack.push(child);

  // Emit call:enter / call:leave events (each call gets a unique callId)
  const receiver = resolveFiberReceiver(parentCtx.root);
  const callId = nextFiberId();
  const storage = getContextStorage();

  if (receiver) {
    emitCallEnter(receiver, callId, name, child.id);
  }

  const startTime = receiver ? performance.now() : 0;
  let caughtError: unknown;

  try {
    return await storage.runAsync(child, fn);
  } catch (error) {
    caughtError = error;
    throw error;
  } finally {
    if (receiver) {
      emitCallLeave(receiver, callId, startTime, caughtError);
    }
    fiber._contextStack.pop();
    await child.dispose();
  }
}

// ---------------------------------------------------------------------------
// Fiber.spawn — concurrent fiber
// ---------------------------------------------------------------------------

function fiberSpawn<T>(fn: () => Promise<T>, opts?: FiberOptions): Fiber<T> {
  const parentCtx = resolveParent('Fiber.spawn()', opts);
  const name = opts?.name ?? (fn.name || 'anonymous');

  // Create fiber first (rootContext set after child creation)
  const fiber = new FiberImpl<T>(name);

  // Include FIBER_KEY so nested Fiber.call() inside the body can find this fiber
  const providers: Provider<unknown>[] = [
    ...(opts?.providers ?? []),
    valueProvider(FIBER_KEY, fiber as FiberImpl<unknown>) as Provider<unknown>,
  ];

  const child = new ContextImpl(providers, parentCtx, opts?.scopes, undefined, name);
  fiber._rootContext = child;

  // Register fiber as a ManagedResource on the parent context.
  // The child context is also registered on the parent (via ContextImpl constructor).
  // The fiber handles drain (wait for completion); the child handles abort propagation.
  const resourceHandle = parentCtx.registerResource(fiber, `fiber:${name}`);

  // Emit events + execute via fiberExec
  const receiver = resolveFiberReceiver(parentCtx.root);

  // Start execution concurrently
  fiber._promise = (async () => {
    try {
      return await fiberExec(fn, child, fiber.id, name, 'spawn', receiver);
    } finally {
      fiber._settled = true;
      await child.dispose();
      resourceHandle.unregister();
    }
  })();

  return fiber as unknown as Fiber<T>;
}

// ---------------------------------------------------------------------------
// Fiber.fork — structured concurrent fiber (ambient context)
// ---------------------------------------------------------------------------

function fiberFork<T>(fn: () => Promise<T>, opts?: ForkOptions): Fiber<T> {
  const ambient = getCurrentContext();
  if (!ambient) {
    throw new Error(
      'Fiber.fork() requires an active ambient context. ' +
        'Call from within Fiber.call(), Fiber.spawn(), ctx.run(), etc.',
    );
  }
  const parentCtx = ambient;
  const name = opts?.name ?? (fn.name || 'anonymous');

  // Create fiber first (rootContext set after child creation)
  const fiber = new FiberImpl<T>(name);

  // Include FIBER_KEY so nested Fiber.call() inside the body can find this fiber
  const providers: Provider<unknown>[] = [
    ...(opts?.providers ?? []),
    valueProvider(FIBER_KEY, fiber as FiberImpl<unknown>) as Provider<unknown>,
  ];

  const child = new ContextImpl(providers, parentCtx, opts?.scopes, undefined, name);
  fiber._rootContext = child;

  // Register fiber as a ManagedResource on the parent context
  const resourceHandle = parentCtx.registerResource(fiber, `fiber:${name}`);

  // Emit events + execute via fiberExec
  const receiver = resolveFiberReceiver(parentCtx.root);

  // Start execution concurrently
  fiber._promise = (async () => {
    try {
      return await fiberExec(fn, child, fiber.id, name, 'fork', receiver);
    } finally {
      fiber._settled = true;
      await child.dispose();
      resourceHandle.unregister();
    }
  })();

  return fiber as unknown as Fiber<T>;
}

// ---------------------------------------------------------------------------
// Fiber.join — await a fiber with observability (throws on error)
// ---------------------------------------------------------------------------

async function fiberJoin<T>(fiber: Fiber<T>): Promise<T> {
  const ctx = getCurrentContext();

  // If we have a context with a receiver, emit join events
  if (ctx) {
    const receiver = resolveFiberReceiver(ctx.root);
    if (receiver) {
      emitJoinEnter(receiver, fiber.id, ctx.id);
      const startTime = performance.now();
      let caughtError: unknown;
      try {
        return await fiber.promise;
      } catch (error) {
        caughtError = error;
        throw error;
      } finally {
        emitJoinLeave(receiver, fiber.id, startTime, caughtError);
      }
    }
  }

  // No context or no receiver — just await the promise directly
  return await fiber.promise;
}

// ---------------------------------------------------------------------------
// Fiber.result — await a fiber with observability (never throws)
// ---------------------------------------------------------------------------

async function fiberResult<T>(fiber: Fiber<T>): Promise<FiberResult<T>> {
  const ctx = getCurrentContext();

  // If we have a context with a receiver, emit join events
  if (ctx) {
    const receiver = resolveFiberReceiver(ctx.root);
    if (receiver) {
      emitJoinEnter(receiver, fiber.id, ctx.id);
      const startTime = performance.now();
      try {
        const value = await fiber.promise;
        emitJoinLeave(receiver, fiber.id, startTime, undefined);
        return { outcome: 'success', value };
      } catch (error) {
        emitJoinLeave(receiver, fiber.id, startTime, error);
        return { outcome: 'error', error };
      }
    }
  }

  // No context or no receiver — just await the promise directly
  try {
    const value = await fiber.promise;
    return { outcome: 'success', value };
  } catch (error) {
    return { outcome: 'error', error };
  }
}

// ---------------------------------------------------------------------------
// Fiber.all — join multiple fibers concurrently (like Promise.all)
// ---------------------------------------------------------------------------

function fiberAll<T extends readonly Fiber<any>[]>(
  fibers: T,
): Promise<{ -readonly [K in keyof T]: T[K] extends Fiber<infer U> ? U : never }> {
  return Promise.all(fibers.map((f) => fiberJoin(f))) as any;
}

// ---------------------------------------------------------------------------
// withAbortSignal — bridge to AbortSignal-based APIs
// ---------------------------------------------------------------------------

/**
 * Run `fn` with an AbortSignal that fires when the current context is aborted.
 *
 * Registers a lightweight abort-only resource on the ambient context.
 * The resource is unregistered when `fn` completes.
 *
 * @example
 * ```ts
 * await Fiber.call(async () => {
 *   const data = await withAbortSignal(signal =>
 *     fetch('/api/data', { signal }).then(r => r.json())
 *   );
 * }, { context: app });
 * ```
 */
export async function withAbortSignal<T>(fn: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
  const ctx = getCurrentContext();
  if (!ctx) {
    throw new Error(
      'withAbortSignal() requires an active context. ' +
        'Call from within Fiber.call(), Fiber.spawn(), ctx.run(), etc.',
    );
  }

  const controller = new AbortController();

  // If the context is already aborted, pre-abort the signal
  if (ctx.aborted) {
    controller.abort();
  }

  const handle = ctx.registerResource(
    {
      [Abort]: () => controller.abort(),
    },
    'AbortSignal',
  );

  try {
    return await fn(controller.signal);
  } finally {
    handle.unregister();
  }
}

// ---------------------------------------------------------------------------
// linkAbortSignal — bridge external signal to fiber cancellation
// ---------------------------------------------------------------------------

/**
 * Link an external `AbortSignal` to a fiber — when the signal fires,
 * the fiber is aborted.
 *
 * This is the inverse of `withAbortSignal` (context → signal).
 * `linkAbortSignal` goes signal → fiber.
 *
 * Intended for glue code (HTTP servers, framework adapters) where you
 * receive a platform signal (e.g. `req.signal`) and want it to control
 * fiber cancellation. Not added as an option on every fiber to avoid
 * paying for it on every creation.
 *
 * The link is automatically cleaned up when the fiber settles.
 *
 * @example
 * ```ts
 * server.on('request', (req, res) => {
 *   const fiber = Fiber.spawn(async () => {
 *     return lookup(OrderService).handle(req);
 *   }, { context: app });
 *   linkAbortSignal(req.signal, fiber);
 *   fiber.promise.then(result => res.end(result));
 * });
 * ```
 */
export function linkAbortSignal(signal: AbortSignal, fiber: Fiber<unknown>): void {
  if (signal.aborted) {
    fiber.abort();
    return;
  }
  const onAbort = () => fiber.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  // Clean up the listener when the fiber settles (avoid leak)
  fiber.promise.then(
    () => signal.removeEventListener('abort', onAbort),
    () => signal.removeEventListener('abort', onAbort),
  );
}

// ---------------------------------------------------------------------------
// Fiber namespace — public API
// ---------------------------------------------------------------------------

/**
 * Fiber namespace.
 *
 * - `Fiber.call(fn, opts?)` — scoped sequential async. Creates a child context,
 *   runs fn, awaits, disposes. Must be awaited immediately.
 * - `Fiber.spawn(fn, opts?)` — concurrent async. Creates a child context,
 *   starts fn, returns `Fiber<T>`. May outlive the caller.
 * - `Fiber.fork(fn, opts?)` — structured concurrent async. Uses ambient context,
 *   returns `Fiber<T>`. Intended for fork/join patterns.
 * - `Fiber.join(fiber)` — await a fiber with observability. Throws on error.
 * - `Fiber.result(fiber)` — await a fiber with observability. Never throws.
 */
export const Fiber = {
  call: fiberCall,
  spawn: fiberSpawn,
  fork: fiberFork,
  join: fiberJoin,
  result: fiberResult,
  all: fiberAll,
} as {
  /**
   * Run an async function in a scoped child context.
   *
   * Creates a child context, runs `fn` inside it, awaits the result,
   * disposes the child, and returns the value. Must be awaited immediately —
   * unawaited calls are detected via stack-top enforcement.
   */
  call<T>(fn: () => Promise<T>, opts?: FiberOptions): Promise<T>;

  /**
   * Spawn a concurrent fiber.
   *
   * Creates a child context, starts `fn` concurrently, and returns a
   * `Fiber<T>` immediately. The fiber is registered as a ManagedResource
   * on the parent — parent drain waits for fiber completion.
   *
   * Use for background work that may outlive the caller.
   * Accepts an explicit `context` option.
   */
  spawn<T>(fn: () => Promise<T>, opts?: FiberOptions): Fiber<T>;

  /**
   * Fork a structured concurrent fiber.
   *
   * Like `spawn`, but always uses the ambient context (no explicit `context`
   * option). Intended for fork/join patterns where the caller will
   * `Fiber.join()` the result.
   */
  fork<T>(fn: () => Promise<T>, opts?: ForkOptions): Fiber<T>;

  /**
   * Await a fiber with observability. Throws on error.
   *
   * Emits `join:enter` / `join:leave` events so the timeline can show
   * which fiber is waiting on which.
   */
  join<T>(fiber: Fiber<T>): Promise<T>;

  /**
   * Await a fiber with observability. Never throws.
   *
   * Returns a `FiberResult<T>` discriminated union:
   * `{ outcome: 'success'; value: T }` or `{ outcome: 'error'; error: unknown }`.
   *
   * Emits `join:enter` / `join:leave` events.
   */
  result<T>(fiber: Fiber<T>): Promise<FiberResult<T>>;

  /**
   * Join multiple fibers concurrently, like `Promise.all`.
   *
   * Each fiber is joined via `Fiber.join` for observability.
   * Returns a tuple of resolved values matching the input array.
   *
   * ```ts
   * const [user, orders] = await Fiber.all([
   *   client.fork(getUser, { id: '1' }),
   *   client.fork(getOrders, { userId: '1' }),
   * ]);
   * ```
   */
  all<T extends readonly Fiber<any>[]>(
    fibers: T,
  ): Promise<{ -readonly [K in keyof T]: T[K] extends Fiber<infer U> ? U : never }>;
};
