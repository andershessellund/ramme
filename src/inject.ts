import {
  InjectionKey,
  createInjectionKey,
  getKeyDescription,
  hasDefaultFactory,
  invokeDefaultFactory,
  getKeyScope,
  getDependencies,
} from './context-key.js';
import { NotFoundPeekResult, ResolveResult } from './internal-context.js';
import type { ContextImpl } from './context-impl.js';
import { LookupOptions, Provider, Created } from './context.js';
import { getCurrentContext } from './context-storage.js';
import { ManagedResource, ResourceHandle, RegisterResourceFunction, Dispose } from './resource.js';
import { SelfScope } from './scope.js';
import type { Context } from './context.js';

/**
 * Injection key for `registerResource()`.
 *
 * When injected during value creation, returns a function that registers
 * a `ManagedResource` on the owning context and returns a `ResourceHandle`.
 * Only available during creation.
 */
export const RegisterResource = createInjectionKey<RegisterResourceFunction>('RegisterResource');

// ---------------------------------------------------------------------------
// ContextRef — deferred reference to the storage context
// ---------------------------------------------------------------------------

/**
 * A deferred reference to the storage context of a DI value.
 *
 * Available during **any** creation, including auto-scoped factories where
 * the storage context is determined after the factory runs. The reference
 * resolves once the DI system assigns the value to a context.
 *
 * **Do not** read {@link context} synchronously during factory execution for
 * auto-scoped values — it is not yet resolved. Use {@link whenResolved} to
 * defer work until the context is known, or read at runtime (event handlers,
 * fiber callbacks) where it is guaranteed to be resolved.
 */
export interface ContextRef {
  /** The storage context. Throws if read before the ref is resolved. */
  readonly context: Context;
  /** Whether the storage context has been determined. */
  readonly isResolved: boolean;
  /**
   * Register a callback for when the context is resolved.
   * If already resolved, fires synchronously.
   */
  whenResolved(fn: (context: Context) => void): void;
}

class ContextRefImpl implements ContextRef {
  private _context: Context | undefined;
  private _callbacks: ((context: Context) => void)[] | undefined;

  constructor(context?: Context) {
    this._context = context;
  }

  get context(): Context {
    if (!this._context) {
      throw new Error(
        'ContextRef.context accessed before creation completed. ' +
        'Do not read the context synchronously during factory execution for auto-scoped values. ' +
        'Use contextRef.whenResolved() to defer, or read at runtime.',
      );
    }
    return this._context;
  }

  get isResolved(): boolean {
    return this._context !== undefined;
  }

  whenResolved(fn: (context: Context) => void): void {
    if (this._context) {
      fn(this._context);
    } else {
      (this._callbacks ??= []).push(fn);
    }
  }

  /** @internal — called by the DI system after auto-scope determination. */
  resolve(context: Context): void {
    this._context = context;
    if (this._callbacks) {
      const cbs = this._callbacks;
      this._callbacks = undefined;
      for (const fn of cbs) fn(context);
    }
  }
}

/**
 * Injection key that provides a deferred reference to the storage context.
 *
 * Available during **any** value creation — including auto-scoped factories.
 * For explicitly scoped or provider-targeted values, the ref is pre-resolved
 * and `.context` is available immediately.
 *
 * @example
 * ```ts
 * class EmailService {
 *   private ref = inject(ContextRef);
 *   send(to: string, subject: string) {
 *     Fiber.spawn(async () => { ... }, { context: this.ref.context });
 *   }
 * }
 * ```
 */
export const ContextRefKey = createInjectionKey<ContextRef>('ContextRef');

let activeCreationCtx: CreationContext | undefined = undefined;
const creationStack = new Set<InjectionKey<unknown>>();
const resourceStorageHandles = new WeakMap<ManagedResource, ResourceHandle>();

function withCreationContext<R>(ctx: CreationContext, fn: () => R): R {
  const previous = activeCreationCtx;
  try {
    activeCreationCtx = ctx;
    return fn();
  } finally {
    activeCreationCtx = previous;
  }
}

function formatCreationStack(key: InjectionKey<unknown>): string {
  return [...creationStack, key].map((k) => getKeyDescription(k)).join(' → ');
}

function withCreationStack<R>(key: InjectionKey<unknown>, fn: () => R): R {
  if (creationStack.has(key)) {
    throw new Error(`Circular dependency detected: ${formatCreationStack(key)}`);
  }
  creationStack.add(key);
  try {
    return fn();
  } finally {
    creationStack.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Public API: inject — creation-time only
// ---------------------------------------------------------------------------

/**
 * Declare a dependency during value creation (class field initializers,
 * factory functions, function keys).
 *
 * - Tracks the dependency for auto-scoping.
 * - Wires lifecycle (disposal cascading).
 * - **Throws** if called outside a creation context.
 *
 * For reading values at runtime (inside method bodies, fiber callbacks,
 * event handlers), use `lookup()` instead.
 */
export function inject<T>(key: InjectionKey<T>): T;
export function inject<T>(
  key: InjectionKey<T>,
  options: LookupOptions & { optional?: false | undefined },
): T;
export function inject<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;
export function inject<T>(key: InjectionKey<T>, options?: LookupOptions): T | undefined {
  options ??= {};
  if (!activeCreationCtx) {
    throw new Error(
      `inject(${getKeyDescription(key)}) called outside of value creation. ` +
        'inject() can only be used in class field initializers, factory functions, ' +
        'and function keys. Use lookup() to read values at runtime ' +
        '(in method bodies, fiber callbacks, context.run() callbacks, etc.).',
    );
  }
  const result = activeCreationCtx.inject(key, options);
  if (result === undefined && !options?.optional) {
    throw new Error(`No provider found for ${key.name}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API: lookup — runtime value access
// ---------------------------------------------------------------------------

/**
 * Read a value from the current context at runtime.
 *
 * Works in method bodies, `context.run()` callbacks,
 * `context.enterSync()` scopes, and event handlers — anywhere a context is active.
 *
 * Also works during creation, but **does not** affect auto-scoping or
 * lifecycle wiring. Use `inject()` during creation to declare dependencies.
 *
 * `RegisterResource` is creation-time only — use `inject(RegisterResource)`.
 */
export function lookup<T>(key: InjectionKey<T>): T;
export function lookup<T>(
  key: InjectionKey<T>,
  options: LookupOptions & { optional?: false | undefined },
): T;
export function lookup<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;
export function lookup<T>(key: InjectionKey<T>, options?: LookupOptions): T | undefined {
  options ??= {};
  if (key === (RegisterResource as unknown)) {
    throw new Error(
      'RegisterResource can only be used with inject() during value creation (inside a factory or constructor).',
    );
  }
  if (key === (ContextRefKey as unknown)) {
    throw new Error(
      'ContextRef can only be used with inject() during value creation (inside a factory or constructor).',
    );
  }
  // During creation: read from the creation context's resolve chain,
  // but without tracking the dependency (no auto-scoping effect).
  if (activeCreationCtx) {
    const result = activeCreationCtx.lookup(key, options);
    return result;
  }
  // At runtime: read from the current execution context.
  const executionContext = getCurrentContext();
  if (!executionContext) {
    throw new Error(
      `lookup(${getKeyDescription(key)}) called outside of any context. ` +
        'Use context.run(), context.enterSync(), or Fiber.run() to establish an execution context.',
    );
  }
  return executionContext.get(key, options);
}

// ---------------------------------------------------------------------------
// Public API: ambient create
// ---------------------------------------------------------------------------

/**
 * Create a fresh instance of `key` without storing it in the context hierarchy.
 *
 * - Inside a creation context (factory/constructor): the created value's
 *   disposal is wired to the outer value's disposer (cascading).
 * - Outside a creation context: delegates to `context.create()` on the
 *   current execution context.
 *
 * Returns a `Created<T>` handle with the value and a dispose function.
 */
export function create<T>(key: InjectionKey<T>): Created<T> {
  if (activeCreationCtx) {
    return activeCreationCtx.createValue(key);
  }
  const executionContext = getCurrentContext();
  if (!executionContext) {
    throw new Error(
      'create() used outside of any context. Use context.run() or Fiber.run() to create an execution context.',
    );
  }
  return executionContext.create(key);
}

// ---------------------------------------------------------------------------
// Internal resolution (called from ContextImpl.resolve)
// ---------------------------------------------------------------------------

export function resolveKey<T>(
  key: InjectionKey<T>,
  context: ContextImpl,
  peekResult: NotFoundPeekResult<T>,
): ResolveResult<T> {
  const scope = getKeyScope(key);
  const providerScope = peekResult.provider?.scope;
  const effectiveScope = providerScope ?? scope;

  if (effectiveScope) {
    // --- SelfScope ---
    if (effectiveScope === SelfScope) {
      // Inside a creation context: per-creation cached, unstored
      if (activeCreationCtx) {
        return resolveSelf(activeCreationCtx, key, context, peekResult.provider);
      }
      // Outside a creation context: fall through to normal scope resolution.
      // A context with scopes: [SelfScope] acts as the SelfScope boundary.
    }

    // --- Scoped resolution: find the context that owns this scope ---
    const scopedContext = context.findScopedContext(effectiveScope);
    if (!scopedContext) {
      if (effectiveScope === SelfScope) {
        throw new Error(
          `SelfScope key '${getKeyDescription(key)}' can only be injected during value creation ` +
            `or from a context with scopes: [SelfScope].`,
        );
      }
      throw new Error(
        `No context found for scope '${effectiveScope.name}' when resolving key: ${getKeyDescription(key)}`,
      );
    }

    if (peekResult.providingContext) {
      return createExplicit(scopedContext, peekResult.provider!);
    }
    if (!hasDefaultFactory(key)) {
      return { resolved: false };
    }
    const provider: Provider<T> = {
      key,
      provide: () => invokeDefaultFactory(key, resolveDependencies(key)),
    };
    return createExplicit(scopedContext, provider);
  }

  if (peekResult.providingContext) {
    return createExplicit(peekResult.providingContext as ContextImpl, peekResult.provider!);
  }
  if (!hasDefaultFactory(key)) {
    return { resolved: false };
  }
  return createAutoHoisted(context, key);
}

function resolveDependencies(key: InjectionKey<unknown>): unknown[] | undefined {
  const deps = getDependencies(key);
  if (!deps) return undefined;
  return deps.map((k) => inject(k));
}

// ---------------------------------------------------------------------------
// Unified CreationContext
// ---------------------------------------------------------------------------

type ResolveFn = (key: InjectionKey<unknown>) => ResolveResult<unknown>;

/**
 * Dependency tracker for auto-hoisting. Tracks the deepest
 * context seen during factory resolution.
 */
class DepTracker {
  deepestDep: ContextImpl;

  constructor(root: ContextImpl) {
    this.deepestDep = root;
  }

  track(result: ResolveResult<unknown>): void {
    if (!result.resolved) return;
    if (result.context.depth > this.deepestDep.depth) {
      this.deepestDep = result.context as ContextImpl;
    }
  }
}

/**
 * A single creation context class that handles all creation scenarios.
 *
 * Behaviour is parameterised by:
 * - `resolveFn` — how to resolve dependencies (from a context, or delegated to outer)
 * - `tracker`   — optional auto-hoisting dep tracker (only for default factories)
 *
 * Collects sync disposal callbacks via `inject(OnSyncDispose)` (now replaced
 * by registerResource) and builds a ManagedResource to wire into the storage context.
 */
class CreationContext {
  /** Resources registered via inject(RegisterResource) during creation */
  readonly resources: ManagedResource[] = [];
  private readonly selfCache = new Map<InjectionKey<unknown>, unknown>();
  private readonly resolveFn: ResolveFn;
  private readonly resolveContext: ContextImpl;
  private readonly tracker?: DepTracker;
  /** Deferred reference to the storage context (pre-resolved for explicit, deferred for auto-hoisted) */
  private readonly contextRef?: ContextRefImpl;

  constructor(
    resolveFn: ResolveFn,
    resolveContext: ContextImpl,
    tracker?: DepTracker,
    contextRef?: ContextRefImpl,
  ) {
    this.resolveFn = resolveFn;
    this.resolveContext = resolveContext;
    this.tracker = tracker;
    this.contextRef = contextRef;
  }

  private _resolve<T>(
    key: InjectionKey<T>,
    options: LookupOptions | undefined,
    track: boolean,
  ): T | undefined {
    if (options?.skipSelf) {
      const parent = this.resolveContext.parent;
      if (!parent) return undefined;
      const wasInStack = creationStack.has(key as InjectionKey<unknown>);
      if (wasInStack) creationStack.delete(key as InjectionKey<unknown>);
      try {
        const result = parent.resolve(key as InjectionKey<unknown>);
        if (result.resolved) {
          if (track) this.tracker?.track(result);
          return result.value as T;
        }
        return undefined;
      } finally {
        if (wasInStack) creationStack.add(key as InjectionKey<unknown>);
      }
    }
    const result = this.resolveFn(key as InjectionKey<unknown>);
    if (result.resolved) {
      if (track) this.tracker?.track(result);
      return result.value as T;
    }
    return undefined;
  }

  inject<T>(key: InjectionKey<T>, options?: LookupOptions): T | undefined {
    if (key === (RegisterResource as unknown)) {
      return ((resource: ManagedResource): ResourceHandle => {
        this.resources.push(resource);
        return {
          unregister: () => {
            const idx = this.resources.indexOf(resource);
            if (idx >= 0) this.resources.splice(idx, 1);
            resourceStorageHandles.get(resource)?.unregister();
          },
        };
      }) as T;
    }
    if (key === (ContextRefKey as unknown)) {
      if (!this.contextRef) {
        throw new Error(
          'inject(ContextRef) is not available in this creation context.',
        );
      }
      return this.contextRef as unknown as T;
    }
    return this._resolve(key, options, true);
  }

  lookup<T>(key: InjectionKey<T>, options?: LookupOptions): T | undefined {
    return this._resolve(key, options, false);
  }

  /**
   * Create a fresh value. The inner creation context delegates inject()
   * through this context's inject() so dep-tracking flows transitively.
   */
  createValue<T>(key: InjectionKey<T>): Created<T> {
    const inner = new CreationContext((k) => {
      const value = this.inject(k as InjectionKey<unknown>);
      if (value !== undefined) {
        return { resolved: true, value, context: this.resolveContext } as ResolveResult<unknown>;
      }
      return { resolved: false };
    }, this.resolveContext);

    const peekResult = this.resolveContext.peek(key);
    const provider = peekResult.found ? undefined : (peekResult as NotFoundPeekResult<T>).provider;

    const value = withCreationStack(key, () =>
      withCreationContext(inner, () => {
        if (provider) {
          const result = provider.provide();
          if (result === undefined) {
            throw new Error(`Provider for ${key.name} returned undefined`);
          }
          return result;
        }
        if (hasDefaultFactory(key)) {
          return invokeDefaultFactory(key, resolveDependencies(key));
        }
        throw new Error(`No provider found for key: ${getKeyDescription(key)}`);
      }),
    ) as T;

    // Promote inner resources to outer
    if (inner.resources.length > 0) {
      this.resources.push(...inner.resources);
    }

    const dispose = async () => {
      for (const r of [...inner.resources].reverse()) {
        await r[Dispose]?.();
      }
    };
    return {
      value,
      dispose,
      [Symbol.asyncDispose]() {
        return dispose();
      },
    };
  }
}

// ---------------------------------------------------------------------------
// SelfScope resolution
// ---------------------------------------------------------------------------

function resolveSelf<T>(
  outer: CreationContext,
  key: InjectionKey<T>,
  resolveContext: ContextImpl,
  provider?: Provider<T>,
): ResolveResult<T> {
  const cached = outer['selfCache'].get(key);
  if (cached !== undefined) {
    return { resolved: true, value: cached as T, context: resolveContext };
  }

  const inner = new CreationContext((k) => {
    const value = outer.inject(k);
    if (value !== undefined) {
      return { resolved: true, value, context: resolveContext } as ResolveResult<unknown>;
    }
    return { resolved: false };
  }, resolveContext);

  const value = withCreationStack(key, () =>
    withCreationContext(inner, () => {
      if (provider) {
        const result = provider.provide();
        if (result === undefined) {
          throw new Error(`Provider for ${key.name} returned undefined`);
        }
        return result;
      }
      if (!hasDefaultFactory(key)) {
        throw new Error(`No provider found for SelfScope key: ${getKeyDescription(key)}`);
      }
      return invokeDefaultFactory(key, resolveDependencies(key));
    }),
  ) as T;

  // Promote inner resources to outer
  if (inner.resources.length > 0) {
    outer.resources.push(...inner.resources);
  }

  outer['selfCache'].set(key, value);
  return { resolved: true, value, context: resolveContext };
}

// ---------------------------------------------------------------------------
// Explicit creation (scoped or provider-targeted)
// ---------------------------------------------------------------------------

function createExplicit<T>(storageContext: ContextImpl, provider: Provider<T>): ResolveResult<T> {
  const ctx = new CreationContext(
    (k) => storageContext.resolve(k),
    storageContext,
    undefined,
    new ContextRefImpl(storageContext as unknown as Context),
  );

  return withCreationStack(provider.key, () =>
    withCreationContext(ctx, () => {
      const result = provider.provide();
      if (result === undefined) {
        throw new Error(`Provider for ${provider.key.name} returned undefined`);
      }
      storageContext.store(provider.key, result);
      for (const r of ctx.resources) {
        resourceStorageHandles.set(
          r,
          storageContext.registerResource(r, getKeyDescription(provider.key)),
        );
      }
      return { resolved: true, value: result, context: storageContext } as ResolveResult<T>;
    }),
  );
}

// ---------------------------------------------------------------------------
// Auto-hoisted creation (default factories)
// ---------------------------------------------------------------------------

function createAutoHoisted<T>(context: ContextImpl, key: InjectionKey<T>): ResolveResult<T> {
  const tracker = new DepTracker(context.autoScopeRoot);
  const ref = new ContextRefImpl();
  const ctx = new CreationContext((k) => context.resolve(k), context, tracker, ref);

  return withCreationStack(key, () =>
    withCreationContext(ctx, () => {
      const result = invokeDefaultFactory(key, resolveDependencies(key));

      let storageContext: ContextImpl = tracker.deepestDep;

      const captureBoundary = context.autoScopeRoot;
      if (captureBoundary.depth > storageContext.depth) {
        storageContext = captureBoundary;
      }

      // Resolve the ContextRef BEFORE registering resources —
      // resources may have queued callbacks via whenResolved().
      ref.resolve(storageContext as unknown as Context);

      storageContext.store(key, result);
      for (const r of ctx.resources) {
        resourceStorageHandles.set(r, storageContext.registerResource(r, getKeyDescription(key)));
      }
      const resolveResult: ResolveResult<T> = {
        resolved: true,
        value: result,
        context: storageContext,
      };

      const autoRoot = context.autoScopeRoot;
      if (storageContext !== autoRoot) {
        autoRoot.memoizeResolution(key, { resolved: false });
      }

      if (storageContext.captureAutoScoped && storageContext.parent) {
        storageContext.parent.memoizeResolution(key, { resolved: false });
      }

      return resolveResult;
    }),
  );
}

// ---------------------------------------------------------------------------
// Unstored creation helper (used by context.create() and createValue)
// ---------------------------------------------------------------------------

/**
 * Create a fresh value for `key` without storing it in any context.
 * Returns Created<T> with the value and a dispose handle.
 */
export function createValueFromContext<T>(context: ContextImpl, key: InjectionKey<T>): Created<T> {
  const ctx = new CreationContext((k) => context.resolve(k), context);

  const peekResult = context.peek(key);
  const provider = peekResult.found ? undefined : (peekResult as NotFoundPeekResult<T>).provider;

  const value = withCreationStack(key, () =>
    withCreationContext(ctx, () => {
      if (provider) {
        const result = provider.provide();
        if (result === undefined) {
          throw new Error(`Provider for ${key.name} returned undefined`);
        }
        return result;
      }
      if (hasDefaultFactory(key)) {
        return invokeDefaultFactory(key, resolveDependencies(key));
      }
      throw new Error(`No provider found for key: ${getKeyDescription(key)}`);
    }),
  ) as T;

  const dispose = async () => {
    for (const r of [...ctx.resources].reverse()) {
      await r[Dispose]?.();
    }
  };
  return {
    value,
    dispose,
    [Symbol.asyncDispose]() {
      return dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// addProvider
// ---------------------------------------------------------------------------

/**
 * Add a provider to the current execution context.
 *
 * This is a convenience function that calls `context.addProvider()`
 * on the currently active context. Useful in test setup hooks
 * (e.g. `beforeAll`, `beforeEach`) after a context has been entered
 * via `context.enterSync()`.
 *
 * @throws If called outside of an execution context.
 */
export function addProvider<T>(provider: Provider<T>): void {
  const context = getCurrentContext();
  if (!context) {
    throw new Error(
      'addProvider called outside of an active context. ' +
        'Use context.enterSync(), context.run(), or Fiber.run() to create one first.',
    );
  }
  context.addProvider(provider);
}

/**
 * Register a `ManagedResource` on the current ambient context.
 *
 * The resource participates in the context's drain/flush/dispose/abort
 * lifecycle. Returns a `ResourceHandle` for early unregistration.
 *
 * Returns `undefined` when there is no ambient context, allowing
 * callers to gracefully degrade in context-free environments.
 *
 * @param resource - The resource to register.
 * @param name - Optional human-readable name for observability.
 */
export function registerResource(resource: ManagedResource, name?: string): ResourceHandle | undefined {
  const context = getCurrentContext();
  if (!context) return undefined;
  return context.registerResource(resource, name);
}

/**
 * Read a key from the ambient creation or execution context, or `undefined`
 * when neither exists. The untracked read the lookup-api bridge is built on.
 * @internal
 */
export function _ambientLookup<T>(key: InjectionKey<T>): T | undefined {
  if (activeCreationCtx) {
    return activeCreationCtx.lookup(key, { optional: true });
  }
  return getCurrentContext()?.get(key, { optional: true });
}
