import { InjectionKey } from './context-key.js';
import { Scope } from './scope.js';
import type { ManagedResource, ResourceHandle } from './resource.js';

export interface Provider<T> {
  key: InjectionKey<T>;
  provide(): T;
  /**
   * Optional scope override. When set, the value produced by this provider
   * is stored on the context that owns this scope — regardless of where
   * the provider was registered.
   *
   * Takes precedence over any scope set on the key itself.
   */
  scope?: Scope;
}

export interface LookupOptions {
  optional?: boolean; // Return undefined instead of throwing
  skipSelf?: boolean; // Skip the current context, resolve from parent
}

/**
 * Handle returned by `context.create()`. Holds the created value
 * and a dispose function that tears down the child context.
 */
export interface Created<T> {
  readonly value: T;
  dispose(): void | Promise<void>;
  // Promise<void> (not void | Promise<void>): `await using` requires the
  // method's return to be awaitable, and every implementation is async.
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Lifecycle status of a context.
 *
 * Transitions: active → draining → drained → flushing → flushed → disposing → disposed
 */
export type ContextStatus =
  | 'active'
  | 'draining'
  | 'drained'
  | 'flushing'
  | 'flushed'
  | 'disposing'
  | 'disposed';

/**
 * Options for `context.runSync()` — creates a temporary child context.
 */
export interface RunSyncOptions {
  providers?: Provider<unknown>[];
  scopes?: Scope[];
  captureAutoScoped?: boolean;
  /** Human-readable name for the temporary child context. */
  name?: string;
}

export interface Context {
  get<T>(key: InjectionKey<T>): T;
  get<T>(key: InjectionKey<T>, options?: LookupOptions & { optional?: false | undefined }): T;
  get<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;
  addProvider<T>(provider: Provider<T>): void;

  /**
   * Register a `ManagedResource` on this context.
   *
   * The resource participates in this context's drain/flush/dispose/abort
   * lifecycle. Returns a `ResourceHandle` that can be used to unregister
   * the resource early (e.g. when a stream completes or a fiber settles).
   *
   * @param resource - The resource to register.
   * @param name - Optional human-readable name for observability (debug timeline).
   */
  registerResource(resource: ManagedResource, name?: string): ResourceHandle;

  /**
   * Create a fresh instance of `key` without storing it in the resolution map.
   *
   * Dependencies are resolved normally from this context. The created value's
   * disposal is wired to this context — when the context is disposed, the
   * created value is torn down too. The returned `Created<T>` handle also
   * allows early explicit disposal.
   */
  create<T>(key: InjectionKey<T>): Created<T>;

  /** The current lifecycle status of this context. */
  readonly status: ContextStatus;

  /** Whether this context has been aborted. */
  readonly aborted: boolean;

  /**
   * Abort this context.
   *
   * Propagates `abort()` to all registered resources (including child contexts),
   * then initiates graceful disposal (drain → flush → dispose).
   *
   * This is the public "I want this context gone" signal. For resources,
   * abort is just a signal — the parent orchestrates the actual lifecycle.
   */
  abort(): void | Promise<void>;

  /**
   * Dispose this context gracefully.
   *
   * Three-phase shutdown:
   * 1. **Drain** — calls `drain()` on all resources in parallel.
   *    Resources stop intake and wait for in-flight work to finish.
   * 2. **Flush** — calls `flush()` on resources in reverse registration order.
   *    Resources finish delayed work (log buffers, metric batches).
   * 3. **Dispose** — calls `dispose()` on resources in reverse registration order.
   *    Resources release underlying handles (connections, file descriptors).
   */
  dispose(): void | Promise<void>;

  /**
   * Run a synchronous function with this context as the current context.
   *
   * Pushes this context onto the context stack, runs `fn`, pops it,
   * and returns the result. Equivalent to `enterSync` + `try/finally` + `leaveSync`.
   */
  run<R>(fn: () => R): R;

  /**
   * Create a temporary child context with the given providers/scopes,
   * run `fn` synchronously inside it, and dispose the child on return.
   *
   * The child context is passed to `fn` for further nesting.
   */
  runSync<R>(fn: (ctx: Context) => R, options?: RunSyncOptions): R;

  /**
   * Push this context onto the context storage stack.
   *
   * For imperative use (e.g. test hooks, middleware). Must be paired with
   * `leaveSync()` in a `finally` block. Prefer `run()` for scoped work.
   */
  enterSync(): void;

  /**
   * Pop this context from the context storage stack.
   *
   * Must be called after a matching `enterSync()` — typically in a `finally` block.
   */
  leaveSync(): void;

  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}
