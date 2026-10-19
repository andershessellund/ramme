// ---------------------------------------------------------------------------
// The public surface, checked by the compiler (IMPLEMENTATION.md §1.15, §7 S3,
// D-58, D-110, I27). Never run: it is not a test file, and every check is a
// type.
//
// It imports the package by its own name and is compiled twice:
//
// - `pnpm typecheck`: tsconfig.tests.json maps 'ramme' to src/index.ts, so a
//   change to the source surface fails at once;
// - `pnpm check:surface` (part of `check:package`): scripts/tsconfig.surface.json
//   has no mapping, so 'ramme' resolves through package.json "exports" to
//   dist/index.d.ts, what a consumer compiles against.
//
// scripts/check-surface.mjs then compares the export clauses of
// dist/index.d.ts with §1.15 name by name.
// ---------------------------------------------------------------------------

import { all, current } from 'ramme';
import type { Context, Task } from 'ramme';
import * as ramme from 'ramme';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

/** D-58: the free `all`, the method `all` on a named node, and `current().all` all infer the tuple (§7.2). */
export function d58(ctx: Context, a: Task<[number], number>, b: Task<[string], string>): void {
  const _viaFree = all([a.bind(1), b.bind('x')]);
  const _viaMethod = ctx.all([a.bind(1), b.bind('x')]);
  const _viaCurrent = current().all([b.bind('x'), a.bind(1)]);
  type _Free = Expect<Equal<typeof _viaFree, Promise<[number, string]>>>;
  type _Method = Expect<Equal<typeof _viaMethod, Promise<[number, string]>>>;
  type _Current = Expect<Equal<typeof _viaCurrent, Promise<[string, number]>>>;
}

/** I27: a task is an object, never a callable bare promise. */
export function i27(t: Task<[number], number>): void {
  // @ts-expect-error -- I27: a Task has no call signature
  t(1);
  // @ts-expect-error -- I27: nor has one made by bind()
  t.bind(1)();
}

/** §7.2: `Fiber` is an interface only; there is no `Fiber` namespace object. */
// @ts-expect-error -- Fiber is a type, never a value
export const fiberNamespace = ramme.Fiber;

/** `runSync` is the ambient function of §7.8, `current().runSync(fn, ...args)`. */
type _RunSync = Expect<Equal<typeof ramme.runSync, <R, A extends unknown[]>(fn: (...args: A) => R, ...args: A) => R>>;

// Removed from the surface (§1.15): one import per name, which fails if the
// name comes back as a value or as a type. Then the internal names that
// must never leak (D-110, D-111).

// @ts-expect-error -- removed (§1.15)
import { createContext as _createContext } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { withAbortSignal as _withAbortSignal } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { linkAbortSignal as _linkAbortSignal } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { createFiberSet as _createFiberSet } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { RegisterResource as _RegisterResource } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { ContextRefKey as _ContextRefKey } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { create as _create } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { registerResource as _registerResource } from 'ramme';
// @ts-expect-error -- removed (§1.15): the free addProvider; ctx.addProvider stays
import { addProvider as _addProvider } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { createRefCountedKey as _createRefCountedKey } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { refCountedProvider as _refCountedProvider } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { Drain as _Drain } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { Flush as _Flush } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { Dispose as _Dispose } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { Abort as _Abort } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { resourceProvider as _resourceProvider } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { ContextTopic as _ContextTopic } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import { FiberTopic as _FiberTopic } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { FiberType as _FiberType } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { FiberOptions as _FiberOptions } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { ForkOptions as _ForkOptions } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { FiberResult as _FiberResult } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { FiberSet as _FiberSet } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { FiberSetOptions as _FiberSetOptions } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { FiberSetSpawnOptions as _FiberSetSpawnOptions } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { RefCountedKeyOptions as _RefCountedKeyOptions } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { ContextRef as _ContextRef } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { ManagedResource as _ManagedResource } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { ResourceHandle as _ResourceHandle } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { RegisterResourceFunction as _RegisterResourceFunction } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { ContextEvent as _ContextEvent } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { FiberEvent as _FiberEvent } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { Created as _Created } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { ContextStatus as _ContextStatus } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { RunSyncOptions as _RunSyncOptions } from 'ramme';
// @ts-expect-error -- removed (§1.15)
import type { CreateContextOptions as _CreateContextOptions } from 'ramme';
// @ts-expect-error -- internal (D-111): ambient.ts's current-node lookup
import { requireCurrent as _requireCurrent } from 'ramme';
// @ts-expect-error -- internal: NodeImpl is never public; nodes are Contexts
import { NodeImpl as _NodeImpl } from 'ramme';
// @ts-expect-error -- internal: the frame marker is a context-storage detail
import { NO_NODE as _NO_NODE } from 'ramme';
