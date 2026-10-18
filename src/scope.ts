export type Scope = { readonly name: string };

export function createScope(name: string): Scope {
  return { name };
}

/**
 * A sentinel scope that means "store where resolved" — the value is
 * created and cached on the consuming context itself, never hoisted.
 *
 * Useful for keys whose instances should be unique per-context rather
 * than shared via auto-hoisting or scope lookup.
 */
export const SelfScope: Scope = createScope('self');

/**
 * Built-in scope automatically attached to root contexts (created via
 * `createRootContext()`). Use to scope fibers or values to the application root.
 */
export const RootScope: Scope = createScope('root');

/**
 * Conventional scope for per-request lifecycles. Not auto-attached —
 * you attach it explicitly via `createContext({ scopes: [RequestScope] })`
 * or `runSync(fn, { scopes: [RequestScope] })`.
 */
export const RequestScope: Scope = createScope('request');
