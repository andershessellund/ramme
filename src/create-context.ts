// ---------------------------------------------------------------------------
// createRootContext — the only free constructor (DESIGN.md §2.3, §7).
//
// No global side effect (DESIGN.md §8): a root is a node with no parent, carrying
// RootScope. Children are made with `child()`, fibers with `fork`/`call`.
// ---------------------------------------------------------------------------

import type { Context, NodeOptions } from './context.js';
import { NodeImpl } from './node-impl.js';
import { RootScope } from './scope.js';
import type { Scope } from './scope.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- a named options type for the root, part of the public surface (DESIGN.md §7)
export interface CreateRootContextOptions extends NodeOptions {}

/** Root contexts always carry RootScope. */
function ensureRootScope(scopes: Scope[] | undefined): Scope[] {
  if (scopes !== undefined && scopes.includes(RootScope)) return scopes;
  return [RootScope, ...(scopes ?? [])];
}

/**
 * Create a root context — the top of a tree, and where shutdown lives:
 * `await using app = createRootContext()`. Its `[Symbol.dispose]` throws:
 * nobody owns a root, so nobody would wait for its completion.
 */
export function createRootContext(opts?: CreateRootContextOptions): Context {
  return new NodeImpl({
    kind: 'context',
    parent: undefined,
    subscribed: false,
    stack: 'none',
    opts: { ...opts, scopes: ensureRootScope(opts?.scopes) },
  });
}
