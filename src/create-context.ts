import { Context, Provider } from './context.js';
import { ContextImpl } from './context-impl.js';
import { Scope, RootScope } from './scope.js';
import { getCurrentContext } from './context-storage.js';
import { installContractResolver } from './contract-bridge.js';

export interface CreateContextOptions {
  parent?: Context;
  providers?: Provider<unknown>[];
  scopes?: Scope[];
  captureAutoScoped?: boolean;
  /** Human-readable name for this context (shown in debug UI). */
  name?: string;
}

export interface CreateRootContextOptions {
  providers?: Provider<unknown>[];
  scopes?: Scope[];
  captureAutoScoped?: boolean;
  /** Human-readable name for this context (shown in debug UI). */
  name?: string;
}

/**
 * Ensure root structural contexts (no parent) always have RootScope.
 */
function ensureRootScope(scopes: Scope[] | undefined): Scope[] {
  if (scopes && scopes.includes(RootScope)) return scopes;
  return [RootScope, ...(scopes ?? [])];
}

/**
 * Create a root context — the top of a context hierarchy.
 *
 * Root contexts always include {@link RootScope} automatically.
 * This is the only way to create a context with no parent.
 */
export function createRootContext({
  providers,
  scopes,
  captureAutoScoped,
  name,
}: CreateRootContextOptions = {}): Context {
  // A root context is the natural composition point, so serving lookup-api
  // contracts needs no import-order ceremony. Idempotent and conditional:
  // the resolver answers only when a ramme context is ambient.
  installContractResolver();
  providers ??= [];
  return new ContextImpl(
    providers,
    undefined,
    ensureRootScope(scopes),
    captureAutoScoped,
    name,
  ) as any as Context;
}

/**
 * Create a child context.
 *
 * The parent is resolved in this order:
 * 1. Explicit `parent` option
 * 2. The current ambient context (from `Fiber.run`, `ctx.run`, `ctx.enterSync`, etc.)
 *
 * Throws if no parent is available. Use {@link createRootContext} to create
 * a root context.
 */
export function createContext({
  providers,
  parent,
  scopes,
  captureAutoScoped,
  name,
}: CreateContextOptions = {}): Context {
  const resolvedParent = parent ?? (getCurrentContext() as unknown as Context | undefined);
  if (!resolvedParent) {
    throw new Error(
      'createContext() requires a parent — either pass { parent } or call from within an active context. ' +
        'Use createRootContext() to create a root context.',
    );
  }
  providers ??= [];
  return new ContextImpl(
    providers,
    resolvedParent as unknown as ContextImpl,
    scopes ?? [],
    captureAutoScoped,
    name,
  ) as any as Context;
}
