import {
  InjectionKey,
  ExplicitInjectionKey,
  createInjectionKey,
  setScope,
  getKeyScope,
} from './context-key.js';
import { inject, create, RegisterResource } from './inject.js';
import { Created, Provider } from './context.js';
import { Dispose } from './resource.js';
import { SelfScope, Scope } from './scope.js';

// ---------------------------------------------------------------------------
// RefCountHolder — the shared object that lives at the scoped context
// ---------------------------------------------------------------------------

class RefCountHolder<T> {
  private created?: Created<T>;
  private count = 0;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private _disposed = false;

  constructor(
    private readonly valueKey: InjectionKey<T>,
    private readonly gracePeriodMs: number,
  ) {
    // Eager creation — called during the holder's own factory execution,
    // so the ambient creation context is active. This lets the DepTracker
    // see the value's transitive deps for auto-hoisting.
    this.created = create(this.valueKey);
  }

  get refCount(): number {
    return this.count;
  }
  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Increment the ref count and return the shared value.
   */
  acquire(): T {
    this.cancelGrace();
    if (!this.created || this._disposed) {
      // Re-create after full disposal. This is always called from within
      // a new consumer's inject(), so the ambient create() works.
      this.created = create(this.valueKey);
      this._disposed = false;
    }
    this.count++;
    return this.created.value;
  }

  release(): void {
    if (this.count <= 0) {
      throw new Error('release() called with refCount already at 0');
    }
    this.count--;
    if (this.count === 0) {
      if (this.gracePeriodMs > 0) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = undefined;
          if (this.count === 0) {
            void this.doDispose();
          }
        }, this.gracePeriodMs);
      } else {
        void this.doDispose();
      }
    }
  }

  private cancelGrace(): void {
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  private async doDispose(): Promise<void> {
    if (this._disposed || !this.created) return;
    this._disposed = true;
    const handle = this.created;
    this.created = undefined;
    await handle.dispose();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RefCountedKeyOptions<T> {
  /** Factory that creates the value. Same as `CreateInjectionKeyOptions.factory`. */
  factory?: () => T;
  /**
   * Scope where the ref-count holder lives. This determines *where*
   * the shared instance is stored. The reference key itself always
   * uses `SelfScope` so each consumer gets its own acquire/release.
   */
  scope?: Scope;
  /**
   * Grace period in milliseconds. After the ref count hits zero,
   * disposal is delayed by this amount. If a new consumer acquires
   * during the grace period, the existing value is reused.
   *
   * Defaults to 0 (dispose immediately).
   */
  gracePeriodMs?: number;
}

/**
 * Create a ref-counted injection key.
 *
 * Returns a `InjectionKey<T>` that consumers inject normally. Under the
 * hood, two hidden keys manage the lifecycle:
 *
 * 1. A **holder key** (scoped to the caller's scope) that owns the
 *    ref-count state and uses `context.create()` to manage the value.
 * 2. A **value key** that carries the user's factory (used by the
 *    holder inside `context.create()`).
 *
 * The returned key has `SelfScope` — each consumer context gets its
 * own reference. On creation it increments the ref count; on dispose
 * (via `OnDispose`) it decrements. When the count hits zero the value
 * is torn down.
 *
 * @example
 * ```ts
 * const WS = createRefCountedKey<WebSocket>('WebSocket', {
 *   factory: () => new WebSocket('wss://...'),
 *   scope: appScope,
 * });
 *
 * // In a component's child context:
 * const ws = inject(WS);           // acquire — refCount++
 * // ... on context dispose ...     // release — refCount--
 * ```
 */
export function createRefCountedKey<T>(
  name: string,
  options?: RefCountedKeyOptions<T>,
): ExplicitInjectionKey<T> {
  const gracePeriodMs = options?.gracePeriodMs ?? 0;

  // Hidden value key — carries the user's factory
  const valueKey = createInjectionKey<T>(`${name}::value`, {
    factory: options?.factory,
  });

  // Hidden holder key — scoped to the caller's scope.
  // The factory calls create(valueKey) during creation, which makes
  // the DepTracker see the value's transitive deps, ensuring the
  // holder auto-hoists to the correct level.
  const holderKey = createInjectionKey<RefCountHolder<T>>(`${name}::holder`, {
    factory: () => new RefCountHolder<T>(valueKey, gracePeriodMs),
  });
  if (options?.scope) {
    setScope(holderKey, options.scope);
  }

  // Returned reference key — SelfScope, each consumer gets own ref.
  const refKey = createInjectionKey<T>(name, {
    factory: () => {
      const holder = inject(holderKey);
      const value = holder.acquire();
      const register = inject(RegisterResource);
      register({ [Dispose]: () => holder.release() });
      return value;
    },
    scope: SelfScope,
  });

  return refKey;
}

/**
 * Create a ref-counted provider for an existing key.
 *
 * This is useful when a key already exists (e.g. a class or explicit key)
 * and you want to make it ref-counted at a specific scope via an explicit
 * provider rather than via the key's default factory.
 *
 * Returns a **single** `Provider<T>` with `scope: SelfScope`. Internally it
 * creates hidden holder and value keys, just like `createRefCountedKey`.
 *
 * @example
 * ```ts
 * class WebSocket { ... }
 *
 * const root = createContext({
 *   scopes: [appScope],
 *   providers: [
 *     refCountedProvider(WebSocket, {
 *       factory: () => new WebSocket('wss://...'),
 *       scope: appScope,
 *     }),
 *   ],
 * });
 * ```
 */
export function refCountedProvider<T>(
  key: InjectionKey<T>,
  options?: RefCountedKeyOptions<T>,
): Provider<T> {
  const gracePeriodMs = options?.gracePeriodMs ?? 0;
  const name = (key as any).name ?? 'Anonymous';

  // Determine factory: explicit option > key's default factory > throw
  const factory = options?.factory;

  // Hidden value key — carries the factory
  const valueKey = createInjectionKey<T>(`${name}::value`, {
    factory,
  });

  // Hidden holder key — scoped to the user's scope.
  const holderKey = createInjectionKey<RefCountHolder<T>>(`${name}::holder`, {
    factory: () => new RefCountHolder<T>(valueKey, gracePeriodMs),
  });
  const scope = options?.scope ?? getKeyScope(key);
  if (scope) {
    setScope(holderKey, scope);
  }

  // Return a provider for the original key, SelfScope
  return {
    key,
    scope: SelfScope,
    provide: () => {
      const holder = inject(holderKey);
      const value = holder.acquire();
      const register = inject(RegisterResource);
      register({ [Dispose]: () => holder.release() });
      return value;
    },
  };
}
