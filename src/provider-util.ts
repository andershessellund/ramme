import { InjectionKey } from './context-key.js';
import { inject, RegisterResource } from './inject.js';
import { Provider } from './context.js';
import { ManagedResource } from './resource.js';
import { Scope } from './scope.js';

export interface ProviderOptions {
  scope?: Scope;
}

/**
 * Creates a provider for a class, using the class as both key and implementation.
 */
export function classProvider<T>(ClassConstructor: new (...args: any[]) => T): Provider<T>;
/**
 * Creates a provider for a class with an explicit key.
 */
export function classProvider<T>(
  key: InjectionKey<T>,
  ClassConstructor: new (...args: any[]) => T,
): Provider<T>;
/**
 * Creates a provider for a class with options (including scope).
 */
export function classProvider<T>(
  key: InjectionKey<T>,
  ClassConstructor: new (...args: any[]) => T,
  options: ProviderOptions,
): Provider<T>;
export function classProvider<T>(
  keyOrClass: InjectionKey<T> | (new (...args: any[]) => T),
  ClassConstructor?: new (...args: any[]) => T,
  options?: ProviderOptions,
): Provider<T> {
  if (ClassConstructor) {
    // Two-parameter version: explicit key + class
    return {
      key: keyOrClass as InjectionKey<T>,
      provide: () => new ClassConstructor(),
      scope: options?.scope,
    };
  } else {
    // One-parameter version: class as both key and implementation
    const Constructor = keyOrClass as new (...args: any[]) => T;
    return {
      key: Constructor as any,
      provide: () => new Constructor(),
    };
  }
}

/**
 * Creates a provider using a factory function.
 */
export function factoryProvider<T>(
  key: InjectionKey<T>,
  factory: () => T,
  options?: ProviderOptions,
): Provider<T> {
  return {
    key,
    provide: factory,
    scope: options?.scope,
  };
}

/**
 * Creates a provider that returns a constant value.
 */
export function valueProvider<T>(
  key: InjectionKey<T>,
  value: T,
  options?: ProviderOptions,
): Provider<T> {
  return {
    key,
    provide: () => value,
    scope: options?.scope,
  };
}

/**
 * Creates a provider that aliases one key to another (looks up the target key).
 */
export function aliasProvider<T>(
  aliasKey: InjectionKey<T>,
  targetKey: InjectionKey<T>,
  options?: ProviderOptions,
): Provider<T> {
  return {
    key: aliasKey,
    provide: () => inject(targetKey),
    scope: options?.scope,
  };
}

/**
 * Creates a provider that returns a constant value **and** registers a
 * {@link ManagedResource} on the owning context.
 *
 * Use this when the value you're providing holds a resource lease (a
 * connection, file handle, subscription, etc.) that should participate in
 * the context's lifecycle and appear in the debug-ui resource view.
 *
 * ```ts
 * resourceProvider(PgClient, client, {
 *   [Dispose]: () => client.release(),
 * })
 * ```
 */
export function resourceProvider<T>(
  key: InjectionKey<T>,
  value: T,
  resource: ManagedResource,
  options?: ProviderOptions,
): Provider<T> {
  return {
    key,
    provide: () => {
      inject(RegisterResource)(resource);
      return value;
    },
    scope: options?.scope,
  };
}
