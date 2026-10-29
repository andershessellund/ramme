// ---------------------------------------------------------------------------
// The provider functions (DESIGN.md §3.1).
//
// - A provider's value is stored on the node it is registered on, whatever the
//   key or the implementation class declares as its scope: scope places only a
//   key's own default (D36).
// - `aliasProvider` is a redirect, not a factory: resolution reads its target
//   from `markAlias`'s map and never calls its `provide` (D36).
// - The value, factory result, class or alias target is checked against
//   `Public<T>`, the members a consumer of `inject(T)` can reach, so a test fake
//   of a class with `#private` members needs no cast. `NoInfer` keeps `T`
//   inferred from the key alone (D37).
// ---------------------------------------------------------------------------

import { refuseTask } from './context-key.js';
import type { ExplicitInjectionKey, InjectionKey } from './context-key.js';
import type { Provider, Public } from './context.js';
import { inject, markAlias, resolveDependencies } from './inject.js';

/**
 * What `aliasProvider` redirects to: a class, a function, or a token whose value is `U`. The token branch refuses
 * functions (`call?: never`), since every function has a `name` and would otherwise pass as a token of any type.
 */
type AliasTarget<U> =
  | (new (...args: any[]) => U)
  | ((...args: any[]) => U)
  | (ExplicitInjectionKey<U> & { call?: never });

/**
 * A provider for a class, the class as both key and implementation, constructed on the providing node.
 */
export function classProvider<T>(Impl: new (...args: any[]) => T): Provider<T>;
/**
 * A provider of `key` that constructs `Impl` on the providing node, whatever `Impl`'s own `static scope` says: to
 * let `Impl`'s declaration govern placement, use `aliasProvider(key, Impl)` (D36). `Impl` need only have `key`'s
 * public members (D37).
 */
export function classProvider<T, U extends Public<T>>(key: InjectionKey<T>, Impl: new (...args: any[]) => U): Provider<T>;
export function classProvider<T>(
  keyOrClass: InjectionKey<T> | (new (...args: any[]) => T),
  Impl?: new (...args: any[]) => unknown,
): Provider<T> {
  // Constructor arguments declared with `setDependencies(Class, ...keys)` are resolved with `inject`,
  // exactly as a class used as its own default factory resolves them.
  const C = (Impl ?? keyOrClass) as new (...args: any[]) => T;
  return { key: keyOrClass as InjectionKey<T>, provide: () => new C(...(resolveDependencies(C) ?? [])) };
}

/**
 * A provider of `key` whose factory runs on the providing node, at the first resolution through it.
 */
export function factoryProvider<T>(key: InjectionKey<T>, factory: () => NoInfer<Public<T>>): Provider<T> {
  return { key, provide: factory as unknown as () => T };
}

/**
 * A provider of `key` that serves a constant value from the providing node.
 */
export function valueProvider<T>(key: InjectionKey<T>, value: NoInfer<Public<T>>): Provider<T> {
  return { key, provide: () => value as unknown as T };
}

/**
 * A redirect (D36): from the providing node down, resolving `key` resolves `target` instead, from the base of the
 * walk that found the alias (the requester; the storage node in a declared-placement creation; the parent for
 * `skipSelf`), by `target`'s own rules (its providers, its declared scope, auto-hoisting), and caches nothing
 * under `key`. So a root alias to a session-scoped implementation gives each session its own, and a fake bound
 * this way keeps the lifetime it declares. `target` need only have `key`'s public members (D37).
 */
export function aliasProvider<T, U extends Public<T>>(key: InjectionKey<T>, target: AliasTarget<U>): Provider<T> {
  const targetKey = target as InjectionKey<unknown>;
  refuseTask(targetKey); // no registration reads the target; `key` is refused where the provider is registered (D44, decision 7)
  const p: Provider<T> = { key, provide: () => inject(targetKey) as T }; // only for a caller of p.provide(): resolution redirects
  markAlias(p, targetKey);
  return p;
}
