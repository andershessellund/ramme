export type Scope = { readonly name: string };

/**
 * Every scope `createScope` made: what a key's `scope` property must be to count as a declaration
 * (D32). Identity, not shape: every function has a string `name`, so a structural test would take a
 * static method named `scope` for a `Scope`.
 */
const made = new WeakSet<object>();

export function createScope(name: string): Scope {
  const scope = { name };
  made.add(scope);
  return scope;
}

/** @internal `x` is a `Scope` made by `createScope` (D32). */
export function isScope(x: unknown): x is Scope {
  return typeof x === 'object' && x !== null && made.has(x);
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
 * you attach it explicitly, to the request's fiber
 * (`task(async (req) => …, { scopes: [RequestScope] })`, or
 * `handle.with({ scopes: [RequestScope] })` for an existing task `handle`)
 * or to a bodiless `child({ scopes: [RequestScope] })` (DESIGN.md §3.1).
 */
export const RequestScope: Scope = createScope('request');
