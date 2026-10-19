# ramme — implementation plan for PROPOSAL.md revision 6.2

**Status:** the single plan implementers code against. It is derived from
the "risk first" plan with the judges' grafts applied and the shared
mistakes fixed. Where PROPOSAL.md decides, this document follows it (open
decisions Q1–Q20 resolve as their bold recommendations). Where it is
silent or ambiguous, §8 of this document records the decision and the
reason; the body of the plan already applies it.

Revision 2 closes the gaps of the second readiness review. The structural
changes: a failure is consumed only when an awaiting continuation is
actually delivered, in `ManagedPromise.then` (§2.4, D-38); every source a
managed promise wraps is a non-rejecting promise (`completion`, `e.done`),
so no internal promise can reject unhandled (D-38); `unconsumed` holds
`FailureRecord`s shared with the failing child, early-release errors and
non-fiber children included (D-40, D-41); a release is idempotent by
`Entry.state` and `e.done` exists before any dispose code runs (D-36); a
pending value node is born with the requester's `root` so it can emit
(D-42); `deps(V)` records optional misses (D-43); `own(x)` with one
argument is a no-op on an object this node already owns (D-37); handlers
and settle continuations run under stated frames (D-45, D-46). D-36 to
D-57 in §8 record each decision; the pseudocode cites them where it
applies them.

Section references of the form **§4.3** point into PROPOSAL.md; references
of the form **D-nn** point into §8 of this document (the decisions log);
**I1..I27** are the proposal's invariants (§11), **C1..C8** its ownership
contracts (§6.3), **G1..G4** its order guarantees (§5.3), **P1..P23** the
review probes.

Reading order for an implementer: §1 (module map) → §2 (the frame) → §3
(node data) → §4 (pseudocode for the piece being built) → §6 (the tests
that must go green) → §7 (the stage's definition of done). §5 and §8 are
reference.

Verified against the toolchain in this repository before writing:
TypeScript 6.0.3, vitest 5.0.1, Node 26 locally with `engines >= 22`,
`@types/node` 22. Facts the plan depends on, checked:

- `SuppressedError` is typed only by the `ESNext.Disposable` lib (not by
  ES2024 or `@types/node`), and the runtime global does not exist on Node
  22. The lib is added to both tsconfigs; a constructor shim is used.
- `await x`, `Promise.all([x])` and `return x` from an `async` function all
  invoke an overridden `then` on a `Promise` subclass. This is what makes
  "the body is suspended on this managed await" a local, checkable fact
  (§2.4).
- A continuation whose `then` callbacks are dropped is collected under
  `--expose-gc`; vitest 5 passes worker flags through `test.execArgv`.
- `AbortSignal.any`, `AbortSignal.timeout`, `Promise.withResolvers` exist
  on Node ≥ 22.

---

## 0. Shape of the implementation in one page

One class, `NodeImpl` (`src/node-impl.ts`), is every node: root, `child()`,
fiber, pool, release fiber and a DI value's node. Kinds differ by three
bits (§3.2) plus a `kind` tag used only for errors, events and the two
kind-specific behaviours (pool intake, fiber `then` trap). There is no
subclassing, so there is no module-evaluation-order hazard.

The one ambient mechanism is a `Frame` stored in the platform async context
(`src/context-storage.ts`, adapters `src/node.ts` / `src/async-context.ts`).
A body frame carries the fiber; a creation frame carries the
`CreationState`, whose value node is materialised on demand. There is no
module-level creation variable and no synchronous fallback stack (law 3).

Seven semantics are built as data structures with a local, checkable
property and a test that fails under the obvious wrong implementation:

| Semantics | Structure | Checkable property | Test |
|---|---|---|---|
| Freeze, delivery and GC of abandoned promises (§4.2, §7.4, A2) | `ManagedPromise` (a `Promise` subclass whose `then` is the only place a body can attach to it, and whose `deliver` step is the only place a failure is consumed) and the node's `onApplied` cut set | a body counts as suspended on a managed await iff `then` was called; a failure counts as consumed iff a continuation was delivered; after a cut, nothing in ramme references the continuation | `managed.test.ts`, `freeze-gc.test.ts`, `outcome.test.ts › frozen awaiter` |
| Release fibers as the current node (§5.2, I14) | every release constructs a `kind: 'release'` node and runs the dispose under its frame | `current()` inside any release is that node; `signal()` is its deadline | `node-core.test.ts › release fiber` |
| Placement by view with decided markers (§8.2) | `decided: Set<Key>` per node; `deps` on each cache entry; `shadowBetween(R, S, deps)` | a hit is served iff no dep is provided on `[R, S)`; `addProvider` throws iff decided | `placement-view.test.ts` |
| Lending (§7.11) | `lentTo` on the awaiting node, set by `call`, cleared synchronously at the child's completion | body-shaped methods throw iff `lentTo` is set | `lending.test.ts` |
| Pending node and placement, incl. into a releasing storage context (§6.2) | `state: 'pending'`, `parent` set once by `placeAt`; the release loop always takes the current top of the stack | an entry pushed during release is released next | `creation.test.ts`, `node-core.test.ts › push during release` |
| Outcome classification by state (§7.6, §9) | `outcome` fixed at settling from `(delivered, mode, body result)`; amended once at completion with release/unconsumed errors | the body's error is never inspected; `owner.outcome` is readable in every release | `outcome.test.ts` |
| Interrupt modes and the birth rule (§4.4) | two-pass delivery (`deliver` marks and collects, `fire` aborts controllers and cuts) plus one `bornDelivered` predicate | every subscriber in the subtree is marked before any listener runs | `node-core.test.ts › delivery` |

Everything else (tasks, free functions, pools, `all`/`race`, topics, the
DI port) is filled in around those structures.

---

## 1. Module map

Legend: **kept** = unchanged; **changed** = same file, new content;
**new**; **renamed from**; **deleted**. Signatures are the ones
implementers must export; internal helpers are listed under
"internals" and may be reshaped.

### 1.1 Files after the change

| File | Status | Responsibility |
|---|---|---|
| `src/context-key.ts` | kept | `InjectionKey`, default factories, key scopes, `setDependencies` |
| `src/scope.ts` | kept | `Scope`, `createScope`, `SelfScope`, `RootScope`, `RequestScope` |
| `src/topic.ts` | kept | `createTopic`, `TopicReceiver` |
| `src/provider-util.ts` | changed | `classProvider`, `factoryProvider`, `valueProvider`, `aliasProvider`; `resourceProvider` removed |
| `src/context.ts` | changed | public types only: §3.1, §7.1, §7.2, §7.7, `Provider`, `LookupOptions` |
| `src/resource.ts` | changed | the §9.6 error classes (+ the three additions in D-01), `SuppressedErrorCtor`, `toDispose` |
| `src/context-storage.ts` | changed | the `Frame` type and the `NO_NODE` frame, the storage contract, `currentFrame`/`runInFrame`/`currentNode`/`peekCurrentNode`/`currentCreation`, `registerContextStorage`, `hasStorage` |
| `src/node.ts` | changed | side-effect entry `ramme/node`: `AsyncLocalStorage<Frame>` adapter. **Not** the node implementation. |
| `src/async-context.ts` | changed | side-effect entry `ramme/async-context`: TC39 `AsyncContext.Variable<Frame>` adapter |
| `src/internal-context.ts` | changed | internal shared types: `NodeKind`, `StackKind`, `CacheEntry`, `ResolveResult`, `TaskLike`/`TASK`/`isTask`, `BodyInfo`, `FailureRecord`, `NodeInit` |
| `src/stack.ts` | new | `Entry`, `Stack`: the two-stack data structure with fixed positions and a cursor-free LIFO release order |
| `src/managed.ts` | new | `ManagedPromise`, `managedFor`, `managedNever`, `managedSignal` (D-66), `neverPromise`: the freeze decision (§4.3) and failure delivery (§7.4) |
| `src/node-impl.ts` | renamed from `context-impl.ts` | `NodeImpl`: anatomy, delivery, body, release loop, release fibers, lending, pending/placement hooks, close/abort/dispose, run/runSync, outcome, event emission, `fork`/`call`/`all`/`race`/`join`/`result`/`interrupted`/`never`/`managed`, pools' node side |
| `src/pool.ts` | renamed from `fiber-set.ts` | `PoolState`, `poolFork`, `poolChildComplete`: concurrency queue and intake rules |
| `src/inject.ts` | changed | `inject`, `ContextKey`, `CreationState`, `DepTracker`, `resolveFrom`, `createAutoHoisted`/`createExplicit`/`resolveSelf`, decided markers, placement by view, pending node lifecycle, `assertProviderPlacement`, `resolveReceiver` |
| `src/fiber.ts` | changed | `task()`, `TaskImpl` |
| `src/ambient.ts` | new | the free functions of §3.1 as `current().<method>()`; `current()`, `signal()`, `lookup()` |
| `src/lifecycle-events.ts` | changed | `NodeEvent`, `NodeTopic` (§10) |
| `src/create-context.ts` | changed | `createRootContext` only |
| `src/index.ts` | changed | the public surface |
| `src/test/util.ts`, `src/test/setup.ts` | new (tests only) | helpers; the unhandled-rejection guard |
| `src/context-impl.ts` | deleted | → `node-impl.ts` |
| `src/fiber-exec.ts` | deleted | body start and event emission are `NodeImpl` methods |
| `src/fiber-set.ts` | deleted | → `pool.ts` |
| `src/ref-count.ts` | deleted | out of core (§6.6) |
| `src/run-sync.ts` | deleted | `runSync` is a `Context` method and a free function in `ambient.ts` |
| `src/maybe-async.ts` | deleted | `isPromise` is inlined in `node-impl.ts`; the maybe-async *style* survives in the release loop |
| `src/contract-bridge.ts` | already deleted | — |

Runtime import graph (no evaluation-order cycles; `type`-only imports are
not shown):

```
context-key, scope, topic, resource ─┐ (leaves)
context-storage ◀── node, async-context (register)
stack, managed, lifecycle-events, internal-context (leaves over the above)
inject ──▶ context-storage, context-key, scope, resource, lifecycle-events      (NodeImpl: type only; nodes are built through methods on the requester)
pool ───▶ resource                                                              (NodeImpl: type only)
node-impl ▶ inject (resolveFrom, assertProviderPlacement, resolveReceiver, abandonCreation), pool, stack, managed, resource, context-storage, lifecycle-events, context-key, scope
ambient ──▶ context-storage, resource, inject (ContextKey)                      (NodeImpl: type only)
fiber ────▶ ambient, internal-context
create-context ▶ node-impl, scope
index ────▶ everything public
```

`inject.ts` never imports `node-impl.ts` at runtime: it creates nodes with
`requester.createValueNode(...)`, places them with `node.placeAt(S)`, and
abandons them with `node.abandon(err)`.

### 1.2 `src/context.ts` — public types

```ts
import type { InjectionKey } from './context-key.js';
import type { Scope } from './scope.js';

export type NodeState = 'pending' | 'running' | 'settling' | 'releasing' | 'complete';
export type InterruptMode = 'freeze' | 'observe' | 'restore';

export interface NodeOptions {
  name?: string;
  providers?: Provider<unknown>[];
  scopes?: Scope[];
  interrupt?: InterruptMode;                        // default 'freeze'
  childrenOnExit?: 'interrupt' | 'await';           // default 'interrupt'
  timeoutMs?: number;                               // deliver to this node's own signal after
  signal?: AbortSignal;                             // deliver to this node when it fires
  releaseTimeoutMs?: number;                        // deadline for this node's release fibers; inherited
  stallWarningMs?: number;                          // default 5000; inherited; 0 or Infinity disables
  /** @internal Harness clamp for auto-hoisting (D7); kept until the suite says otherwise (§8.2). Stripped from .d.ts. */
  captureAutoScoped?: boolean;
}

export type Body<T, A extends unknown[] = []> = (...args: A) => Promise<T> | T;
export type Release<T> = (value: T) => void | Promise<void>;

export interface Provider<T> { key: InjectionKey<T>; provide(): T; scope?: Scope }
export interface LookupOptions { optional?: boolean; skipSelf?: boolean }

export type Outcome<T> =
  | { readonly status: 'success'; readonly value: T }
  | { readonly status: 'failure'; readonly error: unknown }
  | { readonly status: 'aborted'; readonly reason: unknown };

export type FailureDestination = 'join' | 'link' | ((error: unknown, fiber: Fiber<unknown>) => void);
export interface TaskOptions extends NodeOptions { onFailure?: FailureDestination }   // default 'join'

export interface Fiber<T> extends Context {
  /** Narrowed for inference: `join<T>(f: Fiber<T>)` reads T from here. Not thenable; a runtime `then` getter throws FiberNotAwaitableError. */
  readonly outcome: Outcome<T> | undefined;
}

export interface Task<A extends unknown[], T> {
  readonly name: string;
  fork(...args: A): Fiber<T>;
  call(...args: A): Promise<T>;
  with(opts: TaskOptions): Task<A, T>;
  bind(...args: A): Task<[], T>;
}

export type AllResult<T extends readonly Task<[], unknown>[]> =
  { -readonly [K in keyof T]: T[K] extends Task<[], infer U> ? Awaited<U> : never };

export interface PoolOptions extends NodeOptions {
  name: string;
  onFailure: (error: unknown, fiber: Fiber<unknown>) => void;
  concurrency?: number;                             // default unbounded
  whenFull?: 'wait' | 'reject';                     // default 'wait'
}
export interface Pool extends Context {
  fork<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Fiber<T>;
  readonly running: number;
  readonly pending: number;
}

export interface Context {
  readonly id: number;
  readonly name: string | undefined;
  readonly state: NodeState;
  readonly scopes: ReadonlySet<Scope>;
  readonly signal: AbortSignal;
  readonly outcome: Outcome<unknown> | undefined;

  get<T>(key: InjectionKey<T>): T;
  get<T>(key: InjectionKey<T>, options?: LookupOptions & { optional?: false | undefined }): T;
  get<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;
  addProvider<T>(provider: Provider<T>): void;

  own<T extends Disposable | AsyncDisposable>(resource: T): T;
  own<T extends object>(value: T, release: Release<T>): T;
  own<T extends object>(defer: T & (() => void | Promise<void>)): T;
  release(value: object): Promise<void>;
  releaseAll(): Promise<void>;

  fork<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Fiber<T>;
  call<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Promise<T>;
  all<T extends readonly Task<[], unknown>[]>(tasks: T, opts?: NodeOptions): Promise<AllResult<T>>;
  race<T>(tasks: readonly Task<[], T>[], opts?: NodeOptions): Promise<T>;
  pool(opts: PoolOptions): Pool;
  child(opts?: NodeOptions): Context;

  join<T>(fiber: Fiber<T>): Promise<T>;
  result<T>(fiber: Fiber<T>): Promise<Outcome<T>>;
  interrupted(): Promise<unknown>;
  never(): Promise<never>;
  managed<T>(promise: Promise<T>): Promise<T>;

  run<R>(fn: () => R): R;
  runSync<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R;

  abort(reason?: unknown): void;
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}
```

The third `get` overload (`options?: … & { optional?: false }`) is kept
from today so ported tests type-check; it is a superset of §3.1.

### 1.3 `src/resource.ts` — errors and entry wrapping

```ts
import type { Context } from './context.js';

export class NoCurrentNodeError extends Error {}      // free function outside any node; message names `import 'ramme/node'` when no storage is registered
export class NodeCompletedError extends Error {}
export class PendingNodeError extends Error {}
export class NotOwnedError extends Error {}
export class AlreadyOwnedError extends Error {}
export class UnawaitedCallError extends Error { constructor(readonly child: Context, message?: string) }
export class FiberNotAwaitableError extends Error {}
export class FiberAbortedError extends Error { constructor(readonly reason: unknown, message?: string) }
export class PoolClosedError extends Error {}
export class CreationViolationError extends Error {}
export class AsyncRunError extends Error {}
export class PlacementError extends Error {}
// Additions to §9.6 (D-01):
export class PoolFullError extends Error {}                                   // pool.fork with whenFull: 'reject' when full
export class OwnerInterrupt extends Error { constructor(readonly owner: Context) }   // the abort reason ramme itself produces: a parent's body exit, or an entry's turn in the release loop
export class FactoryReturnedUndefinedError extends CreationViolationError {} // factory/provider returned undefined (§8.3); subclass so `instanceof CreationViolationError` holds

/** `globalThis.SuppressedError` where it exists (Node ≥ 24), otherwise a minimal shim with `.error`, `.suppressed`, `.name === 'SuppressedError'`. */
export const SuppressedErrorCtor: new (error: unknown, suppressed: unknown, message?: string) => Error & { error: unknown; suppressed: unknown };

/** Wraps the three `own` overloads into one dispose function. Throws TypeError synchronously when nothing applies (C1). */
export function toDispose(target: object, release?: (value: any) => void | Promise<void>): () => void | Promise<void>;
//   release given            → () => release(target)
//   target[Symbol.asyncDispose] is a function → () => target[Symbol.asyncDispose]()
//   target[Symbol.dispose] is a function      → () => target[Symbol.dispose]()
//   typeof target === 'function'              → target            (the defer overload)
//   otherwise → throw new TypeError('own(): value is neither Disposable nor AsyncDisposable; pass a release function')
```

Every class sets `this.name` to its class name. Messages are stable
enough for tests to match on a word (see §5 for the exact texts).

### 1.4 `src/context-storage.ts` — the one ambient mechanism

```ts
import type { NodeImpl } from './node-impl.js';
import type { CreationState } from './inject.js';

/** The value stored in the platform async context. Immutable; a creation frame's node lives on `creation.slot`. */
export interface Frame {
  readonly node: NodeImpl | undefined;            // body frame: the fiber / release node / the node `run` entered; creation frame: undefined
  readonly creation: CreationState | undefined;   // set only while a factory, constructor or default factory runs (A5: synchronous); once creation.ended, the frame reads as none (D-107)
}
export type ContextRunner = <R>(fn: () => R) => R;                 // D-84
export interface ContextStorage {
  get(): Frame | undefined;
  run<R>(frame: Frame, fn: () => R): R;
  snapshot?(): ContextRunner;                                       // D-84: re-enter the whole current async context later
  runDetached?<R>(fn: () => R): R;                                  // D-84: run in the adapter's load-time context (no variable set)
}
export function registerContextStorage(impl: ContextStorage): void;
export function hasStorage(): boolean;
/** The frame that means "no current node". Installed around a body's settle reactions and around every microtask ramme queues, so a continuation inherits neither the forker's frame nor a finished creation frame (D-46). */
export const NO_NODE: Frame;                                       // Object.freeze({ node: undefined, creation: undefined })
export function currentFrame(): Frame | undefined;                 // never throws, never materialises; returns `undefined` for NO_NODE and for a creation frame whose creation has ended (D-107)
export function currentCreation(): CreationState | undefined;      // currentFrame()?.creation
export function peekCurrentNode(): NodeImpl | undefined;           // frame.node ?? frame.creation?.nodeIfCreated — never materialises
export function currentNode(): NodeImpl | undefined;               // frame.node ?? frame.creation?.node()      — materialises the value node in a creation frame
export function runInFrame<R>(frame: Frame, fn: () => R): R;       // throws NoCurrentNodeError naming the import when no storage is registered
export function captureContext(): ContextRunner;                   // D-84: storage.snapshot(), else a runner over the current frame, else a direct call
export function runDetached<R>(fn: () => R): R;                    // D-84: storage.runDetached, else run(NO_NODE, fn), else fn()
```

Internals: `let storage: ContextStorage | undefined`. There is **no**
built-in synchronous stack (law 3; D-02) and no unregister API: a storage
is registered once per process. `runInFrame` without storage throws
`NoCurrentNodeError("No context storage is registered: import 'ramme/node' (Node, Bun, Deno, Workers) or 'ramme/async-context' once at startup")`.
`storage.test.ts` is the one test file that omits the adapter import so
that it can exercise this path (D-57).

### 1.5 `src/node.ts`, `src/async-context.ts` — adapters

```ts
// node.ts (side effect only)
const als = new AsyncLocalStorage<Frame>();
registerContextStorage({ get: () => als.getStore(), run: (frame, fn) => als.run(frame, fn),
  snapshot: () => AsyncLocalStorage.snapshot(), runDetached: (fn) => detached(fn) });   // detached = AsyncLocalStorage.snapshot() at import (D-84)

// async-context.ts (side effect only; throws at import when globalThis.AsyncContext?.Variable is missing — message kept)
const variable = new AsyncContext.Variable<Frame>();
registerContextStorage({ get: () => variable.get(), run: (frame, fn) => variable.run(frame, fn),
  snapshot / runDetached: from AsyncContext.Snapshot when present (D-84) });
```

Both lose their `syncStack` fallbacks.

### 1.6 `src/internal-context.ts` — shared internal types

```ts
import type { InjectionKey } from './context-key.js';
import type { Body, FailureDestination, NodeOptions, TaskOptions } from './context.js';
import type { NodeImpl } from './node-impl.js';
import type { PoolState } from './pool.js';

export type NodeKind = 'context' | 'fiber' | 'pool' | 'release' | 'value';   // 'value': a DI value's node; an addition to §10's list (D-52)
export type StackKind = 'explicit' | 'provided' | 'none';

/** One failure. The same object is the failing node's `failure` (or the entry's, for an early release) and a member of the parent's `unconsumed`; `consumed` flips when a continuation is delivered or the parent surfaces it (D-40, D-41). */
export interface FailureRecord { readonly error: unknown; consumed: boolean }

export interface CacheEntry {
  readonly value: unknown;
  readonly node: NodeImpl;                                   // S, the storage context
  readonly autoHoisted: boolean;
  readonly deps: ReadonlySet<InjectionKey<unknown>> | undefined;   // deps(V); undefined for declared placement
  readonly valueNode: NodeImpl | undefined;                  // the value's node, if it attached anything
  readonly scope: Scope | undefined;                         // D-92: the effective scope a scoped value was stored under; undefined for unscoped providers and auto-hoisted values
  readonly pinned: boolean;                                  // D-97: an auto-hoisted value built from a requester-relative read; served only to a requester at its storage context
}
export type ResolvedResult<T> = {
  resolved: true; value: T; node: NodeImpl; autoHoisted: boolean;
  deps: ReadonlySet<InjectionKey<unknown>> | undefined;
  created: boolean;                                          // a factory ran for this result (Q4 warning)
  pinned: boolean;                                           // D-97: a per-creation SelfScope result, or a pinned auto-hoisted value; pins the tracking creation
};
export type ResolveResult<T> = ResolvedResult<T> | { resolved: false };

export const TASK: unique symbol;
export interface TaskLike<A extends unknown[] = unknown[], T = unknown> {
  readonly [TASK]: true; readonly name: string; readonly body: Body<T, A>; readonly opts: TaskOptions;
}
export function isTask(x: unknown): x is TaskLike;
export function toTask<A extends unknown[], T>(t: TaskLike<A, T> | Body<T, A>): TaskLike<A, T>;   // an inline body becomes an anonymous TaskLike {name: body.name || 'anonymous', opts: {}}

export interface BodyInfo {
  readonly fn: Body<unknown, unknown[]>;
  readonly args: unknown[];
  readonly destination: FailureDestination;
  readonly taskName: string;
}
export interface NodeInit {
  kind: NodeKind;
  parent: NodeImpl | undefined;      // undefined: root, or a pending value node
  basis?: NodeImpl;                  // pending value node only: the requester R, which supplies `root` (for events) and provisional depth/autoScopeRoot/inherited timeouts until placeAt (D-42)
  opts: NodeOptions;
  subscribed: boolean;
  stack: StackKind;                  // which of parent's stacks the node is pushed on at construction
  body?: BodyInfo;
  pool?: PoolState;
  pending?: boolean;                 // a value node awaiting placement (state 'pending', parent undefined)
}
```

### 1.7 `src/stack.ts`

```ts
import type { NodeImpl } from './node-impl.js';

export type EntryState = 'live' | 'releasing' | 'released';
export interface Entry {
  readonly target: object;                     // identity for release(x); for a node entry, the node itself
  readonly name: string;
  readonly node: NodeImpl | undefined;         // set for node entries
  readonly dispose: () => void | Promise<void>; // passive entries; node entries use the loop's node path (§4.3 of this doc)
  state: EntryState;
  done: Promise<void> | undefined;             // created with Promise.withResolvers when the release starts, BEFORE any dispose code runs; settles (never rejects) when it ends; defined whenever state !== 'live' (D-36)
  failure: FailureRecord | undefined;          // the release's own error when it threw; for an early release the record is also in owner.unconsumed until release()/releaseAll() delivers it (D-41)
  early: boolean;                              // release started by release(x)/releaseAll(), not by the owner's loop
  prev: Entry | undefined; next: Entry | undefined;
  readonly stack: Stack;
}
export class Stack {
  constructor(readonly kind: 'explicit' | 'provided');
  size: number;                                // live + releasing entries
  push(e: Omit<Entry, 'prev' | 'next' | 'stack'>): Entry;   // throws AlreadyOwnedError if `target` is already present (own() consults find() first for the one-argument no-op, D-37)
  find(target: object): Entry | undefined;     // identity map; released entries are absent
  unlink(e: Entry): void;                      // physical removal at release end (P1)
  topPending(): Entry | undefined;             // from the tail: first entry whose state !== 'released'
  hasPending(): boolean;
  [Symbol.iterator](): IterableIterator<Entry>;  // head → tail
  snapshotTopDown(): Entry[];                  // for releaseAll()
  moveToTail(e: Entry): void;                  // D-100: a declared value's live node entry moves after its dependencies when its creation ends; no-op for the tail or an unlinked entry
}
```

Positions never move (I5), with one exception at the end of a declared
value's creation (D-100). Because the loop always takes `topPending()`
afresh, an entry pushed during release is simply the new tail and is
therefore released next (§6.2) — no cursor.

### 1.8 `src/managed.ts`

```ts
import type { NodeImpl } from './node-impl.js';

/** The subset of NodeImpl the freeze decision reads; `managed.test.ts` fakes it. */
export interface FreezeTarget {
  readonly hasBody: boolean; readonly mode: 'freeze' | 'observe' | 'restore'; readonly kind: string;
  readonly applied: boolean;
  readonly onApplied: Set<() => void>;
  markFrozen(): void;
}
/** Runs only in `then`'s delivered path: turns the source's value into the awaiter's value, may throw, and is where a failure is consumed (D-38). */
export type Deliver<S, T> = (value: S) => T;
export class ManagedPromise<S, T = S> extends Promise<T> {
  constructor(target: FreezeTarget | undefined, source: Promise<S> | undefined, deliver?: Deliver<S, T>);
  //   target undefined → nothing can freeze (no current node, observe body, release fiber): `then` chains at once, delivery still happens only in `then`
  //   source undefined → cut-only (never(), or interrupted() through managedSignal, on a freeze node; D-66)
  then<R1 = T, R2 = never>(onFulfilled?, onRejected?): Promise<R1 | R2>;   // the override; see §2.4
  static readonly [Symbol.species]: PromiseConstructor;                   // derived promises are plain
}
export function managedFor<S, T = S>(source: Promise<S>, deliver?: Deliver<S, T>): Promise<T>;   // decides for peekCurrentNode(); see §2.4
export function managedNever(): Promise<never>;                                                   // never() shape: cut-only on a freeze awaiter, a fresh pending promise otherwise
export function managedSignal<S>(source: Promise<S>, receiver: FreezeTarget): Promise<S>;          // interrupted() shape (D-66, D-86): cut-only, with the target's shared cut, when the freeze awaiter is the receiver; the managedFor wrapper over `source` otherwise
export function neverPromise(): Promise<never>;                                                   // a fresh `new Promise(() => {})`; no shared constant
```

### 1.9 `src/node-impl.ts`

```ts
export class NodeImpl implements Context {
  constructor(init: NodeInit);
  // --- Context surface: every member of §3.1 (see §1.2) ---
  // --- fiber/pool surface (kind-specific) ---
  get then(): never | undefined;                 // prototype getter: throws FiberNotAwaitableError when kind === 'fiber', else undefined
  get running(): number; get pending(): number;  // pools; 0 for other kinds
  // --- internal API used by inject.ts / pool.ts / ambient.ts (all public on the class, @internal in docs) ---
  readonly kind: NodeKind; parent: NodeImpl | undefined; depth: number; root: NodeImpl; autoScopeRoot: NodeImpl;
  readonly captureAutoScoped: boolean; readonly mode: InterruptMode; readonly childrenOnExit: 'interrupt' | 'await';
  readonly hasBody: boolean; body: BodyInfo | undefined; readonly pool: PoolState | undefined;   // body is nulled at completion (D-53)
  delivered: boolean; applied: boolean; abortReason: unknown; readonly onApplied: Set<() => void>;
  firePending: boolean; cancelOnFire: boolean;   // D-82: marked, pass 2a not yet run; abort() reached an unstarted body meanwhile
  lentTo: NodeImpl | undefined; lender: NodeImpl | undefined;
  failure: FailureRecord | undefined; readonly unconsumed: Set<FailureRecord>; pooled: boolean;
  readonly cache: Map<InjectionKey<unknown>, CacheEntry>; providers: Map<InjectionKey<unknown>, Provider<unknown>> | undefined;
  readonly decided: Set<InjectionKey<unknown>>; readonly scopeSet: Set<Scope> | undefined;
  inCreation: boolean; creationForks: NodeImpl[]; creating: Set<InjectionKey<unknown>> | undefined;   // creating: root only, keys whose creation is in progress in this tree (D-101, D-106)
  failedCreation: InjectionKey<unknown> | undefined;                     // an abandoned value node's key until it completes (D-105)
  readonly completion: Promise<void>;            // never rejects; resolves at state 'complete'
  findScopedContext(scope: Scope): NodeImpl | undefined;
  createValueNode(name: string, placement: NodeImpl | undefined): NodeImpl;   // pending (placement undefined; `root` = this.root for events, D-42) or live on placement.provided
  placeAt(storage: NodeImpl): void;              // pending → running; parent, tree fix-up, push on storage.provided
  abandon(error: unknown, requester: NodeImpl): void;   // failed creation: a pending node is placed at the requester (or the nearest open node above it), then aborted like a live one; never cached (D-99)
  moveToProvidedTail(): void;                    // D-100: a live declared value node moves to the tail of S.provided when its creation ends
  startBody(): void;                             // run the body under this node's frame; maybe-async settle
  scheduleStart(): void;                         // creationForks when an ancestor is in creation, else queueMicrotask(startBody)
  markFrozen(): void;                            // onBodyExit({kind:'frozen'}), idempotent
  consumeFailure(): void;                        // failure.consumed = true; parent.unconsumed.delete(failure); no-op without a failure; idempotent (D-50)
  abortInternal(reason: unknown): void;          // abort() without the I7 throw (used by release loops)
  closeInternal(): Promise<void>;                // close semantics returning `completion` (never rejects)
  deliverClose(): void;                          // close()'s deliver step: throws aggregatedExtra, consuming a non-fiber's failure (D-38, D-40)
  attachNode(child: NodeImpl, stack: 'explicit' | 'provided'): Entry;
  emit(event: Omit<NodeEvent, 'seq'>): void;     // no-op without a receiver
  // guards and small helpers used throughout §4 of this document
  assertOpen(op: string): void;                  // NodeCompletedError (I7)
  assertNotPending(op: string): void;            // PendingNodeError
  assertNotCreating(op: string): void;           // CreationViolationError when currentCreation() is set (D-17)
  assertNotLent(op: string): void;               // UnawaitedCallError when lentTo is set (§7.11)
  abortIfOpen(reason: unknown): void;            // abortInternal unless state is 'pending' or 'complete' (D-79; replaces abortIfRunning)
  creationOwner(): NodeImpl | undefined;         // nearest ancestor-or-self with inCreation === true
  fixTree(parent: NodeImpl): void;               // recompute depth/root/autoScopeRoot/inherited timeouts for this node and the nodes on its stacks (placeAt)
  armStallTimer(): void;                         // node:stalled after stallWarningMs unless settled/frozen first; unref'd; 0/Infinity disables
}
export function isNodeImpl(x: unknown): x is NodeImpl;
```

### 1.10 `src/pool.ts`

```ts
import type { NodeImpl } from './node-impl.js';
import type { PoolOptions } from './context.js';
import type { TaskLike } from './internal-context.js';

export class PoolState {
  constructor(readonly opts: PoolOptions);      // validates: name is a string, onFailure is a function (TypeError otherwise), concurrency undefined or integer ≥ 1
  running: number;                              // started and not complete
  readonly waiting: NodeImpl[];                 // created, not started (whenFull: 'wait')
  get pending(): number;                        // waiting.length
}
export function poolFork<T>(pool: NodeImpl, task: TaskLike, args: unknown[]): NodeImpl;   // PoolClosedError / PoolFullError / create + admit
export function poolChildComplete(pool: NodeImpl, child: NodeImpl): void;                 // running--, start the next waiter unless the pool is delivered; called only for admitted pooled fibers (D-47, D-81)
export function poolChildSettled(pool: NodeImpl, child: NodeImpl): void;                  // D-81: from onBodyExit on an 'unstarted' settle: a waiter leaves `waiting` and is unpooled
export function poolDelivered(pool: NodeImpl): void;                                      // D-81: from fire() 2b: every waiter still queued is aborted, i.e. settles 'unstarted' (D-13)
```

### 1.11 `src/inject.ts`

```ts
export const ContextKey: InjectionKey<Context>;                        // createInjectionKey('Context'); inject-only

export function inject<T>(key: InjectionKey<T>): T;
export function inject<T>(key: InjectionKey<T>, options: LookupOptions & { optional?: false | undefined }): T;
export function inject<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;

export class DepTracker {
  constructor(start: NodeImpl);
  deepest: NodeImpl;
  readonly deps: Set<InjectionKey<unknown>>;
  pinned: boolean;                                                         // D-97: V read something requester-relative
  track(key: InjectionKey<unknown>, r: ResolveResult<unknown>): void;    // deps ∪= {key} always, a miss included (D-43); when resolved: deepest by depth, deps ∪= r.deps if r.autoHoisted, pinned ||= r.pinned (D-97)
  pin(at: NodeImpl): void;                                                 // D-97: a skipSelf read pins V at its requester (pinned = true; deepest = at if deeper)
}
export interface CreationState {
  readonly key: InjectionKey<unknown>;
  readonly requester: NodeImpl;              // R
  readonly base: NodeImpl;                   // resolution base for inject: R (auto-hoisted) or S (declared placement)
  readonly placement: NodeImpl | undefined;  // S when declared, else undefined
  readonly tracker: DepTracker | undefined;  // present iff auto-hoisted
  readonly outer: CreationState | undefined; // enclosing creation (cycle detection; SelfScope nesting)
  cycleExempt: boolean;                      // true while a skipSelf resolve of the same key runs
  ended: boolean;                            // set by runCreation when the factory returns or throws (D-107)
  readonly selfCache: Map<InjectionKey<unknown>, unknown>;
  readonly slot: { node: NodeImpl | undefined };   // the value's node; shared with SelfScope inner creations
  readonly ownsSlot: boolean;                // false for SelfScope inner creations
  node(): NodeImpl;                          // materialise: slot.node ??= requester.createValueNode(name, placement)
  readonly nodeIfCreated: NodeImpl | undefined;
  inject<T>(key: InjectionKey<T>, options: LookupOptions | undefined): T | undefined;
}
export function resolveFrom<T>(requester: NodeImpl, key: InjectionKey<T>): ResolveResult<T>;      // the §8.2 walk; called by NodeImpl.get and by inject
export function assertProviderPlacement(node: NodeImpl, provider: Provider<unknown>, atConstruction: boolean): void;  // PlacementError rules
export function misplacedScopedProviders(n: NodeImpl, S: NodeImpl): MisplacedProvider[];          // D-108: the scope rule for n's subtree once pending n is placed at S; { node, provider, owner }
export function resolveReceiver(root: NodeImpl): TopicReceiver<NodeEvent> | undefined;             // raw walk for NodeTopic; bypasses get's guards
export function describeNode(node: NodeImpl): string;                                              // `${name ?? kind}#${id}` for messages
```

Internals (kept from today and extended): `resolveDependencies(key)`,
`createAutoHoisted(R, key)`, `createExplicit(S, provider, R)`,
`resolveScoped(R, key, scope, provider?)`, `resolveSelf(outer, key, provider?)`,
`runCreation(cs, produce)`, `markDecided(from, to, keys)`,
`shadowBetween(R, S, deps)`, `defaultProvider(key)`. Removed:
`RegisterResource`, `ContextRefKey`/`ContextRefImpl`, `create`,
`createValueFromContext`, `registerResource`, `addProvider` (free),
`_ambientLookup`, `activeCreationCtx`, `withCreationContext`,
`creationStack`, `withCreationStack`, `resourceStorageHandles`,
`memoizeResolution`, `MISS_THRESHOLD`.

### 1.12 `src/fiber.ts`

```ts
export function task<A extends unknown[], T>(body: Body<T, A>, opts?: TaskOptions): Task<A, T>;
// internals
class TaskImpl<A extends unknown[], T> implements Task<A, T>, TaskLike<A, T> {
  readonly [TASK] = true; readonly name: string; readonly body: Body<T, A>; readonly opts: TaskOptions;
  fork(...args: A): Fiber<T>        { return requireCurrent('fork').fork(this, ...args); }
  call(...args: A): Promise<T>      { return requireCurrent('call').call(this, ...args); }
  with(o: TaskOptions): Task<A, T>  { return new TaskImpl(this.body, { ...this.opts, ...o }, o.name ?? this.name); }
  bind(...args: A): Task<[], T>     { return new TaskImpl(() => this.body(...args), this.opts, this.name); }
}
```

A `TaskImpl` is a class instance with no call signature: `handle(req)` is
a compile-time error and a runtime `TypeError: handle is not a function`
(I27).

### 1.13 `src/ambient.ts`

```ts
export function current(): Context;                    // throws NoCurrentNodeError
export function signal(): AbortSignal;
export function lookup<T>(key: InjectionKey<T>): T;
export function lookup<T>(key: InjectionKey<T>, options: LookupOptions & { optional?: false | undefined }): T;
export function lookup<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;   // CreationViolationError in a creation frame
export function own<T extends Disposable | AsyncDisposable>(resource: T): T;
export function own<T extends object>(value: T, release: Release<T>): T;
export function own<T extends object>(defer: T & (() => void | Promise<void>)): T;
export function release(value: object): Promise<void>;
export function releaseAll(): Promise<void>;
export function fork<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Fiber<T>;
export function call<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Promise<T>;
export function all<T extends readonly Task<[], unknown>[]>(tasks: T, opts?: NodeOptions): Promise<AllResult<T>>;
export function race<T>(tasks: readonly Task<[], T>[], opts?: NodeOptions): Promise<T>;
export function pool(opts: PoolOptions): Pool;
export function child(opts?: NodeOptions): Context;
export function join<T>(fiber: Fiber<T>): Promise<T>;
export function result<T>(fiber: Fiber<T>): Promise<Outcome<T>>;
export function interrupted(): Promise<unknown>;
export function never(): Promise<never>;
export function managed<T>(promise: Promise<T>): Promise<T>;
export function runSync<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R;
/** @internal */ export function requireCurrent(op: string): NodeImpl;
```

`requireCurrent(op)`: `const f = currentFrame(); if (!f) throw new NoCurrentNodeError(hasStorage() ? \`${op}() called with no current node…\` : \`…import 'ramme/node'…\`); return f.node ?? f.creation!.node()`. The
body-shaped free functions (`call`, `all`, `race`, `join`, `result`,
`interrupted`, `never`, `managed`, `runSync`, `lookup`) first check
`currentCreation()` and throw `CreationViolationError` (I16, §8.1) before
touching the node; `own`, `release`, `releaseAll`, `fork`, `pool`, `child`,
`current`, `signal` materialise the pending node and proceed.

### 1.14 `src/lifecycle-events.ts`

```ts
export type NodeEventKind = NodeKind | 'entry';
interface Base { readonly seq: number; readonly id: number; readonly kind: NodeEventKind; readonly parentId: number | null }
export type NodeEvent =
  | (Base & { type: 'node:created'; name?: string; task?: string; stack: StackKind; subscribed: boolean; mode: InterruptMode })
  | (Base & { type: 'node:placed'; storageId: number })
  | (Base & { type: 'node:started' })
  | (Base & { type: 'node:delivered'; reason: unknown })
  | (Base & { type: 'node:frozen' })
  | (Base & { type: 'node:settled'; outcome: Outcome<unknown>['status'] })
  | (Base & { type: 'node:lent'; childId: number })
  | (Base & { type: 'node:returned'; childId: number })
  | (Base & { type: 'node:releasing'; stack: 'explicit' | 'provided' })
  | (Base & { type: 'entry:registered'; entryName: string; stack: 'explicit' | 'provided' })
  | (Base & { type: 'entry:released'; entryName: string; stack: 'explicit' | 'provided'; error?: string })
  | (Base & { type: 'node:complete'; outcome: Outcome<unknown>['status'] })
  | (Base & { type: 'node:stalled'; sinceMs: number })
  | (Base & { type: 'join:enter'; joinedId: number })
  | (Base & { type: 'join:leave'; joinedId: number; outcome: Outcome<unknown>['status'] });
export const NodeTopic: InjectionKey<TopicReceiver<NodeEvent>>;   // createTopic<NodeEvent>('node')
```

`seq` is a module counter (observability only). For `entry:*` events `id`
is the owner node's id and `kind` is `'entry'`. `'value'` is the kind of a
DI value's node (D-52). `node:created` is every node's first event;
`node:delivered` is emitted by `markDelivered` for born-delivered and
directly aborted nodes and by `fire()` for the nodes of a two-pass
delivery (D-54). `ContextTopic` and `FiberTopic` are removed.

### 1.15 `src/create-context.ts`, `src/index.ts`, `src/provider-util.ts`

```ts
// create-context.ts
export interface CreateRootContextOptions extends NodeOptions {}
export function createRootContext(opts?: CreateRootContextOptions): Context;   // new NodeImpl({ kind: 'context', parent: undefined, subscribed: false, stack: 'none', opts: { ...opts, scopes: ensureRootScope(opts?.scopes) } })

// index.ts — the whole public surface
export type * from './context.js';
export { createRootContext } from './create-context.js';
export type { CreateRootContextOptions } from './create-context.js';
export { task } from './fiber.js';
export { current, signal, lookup, own, release, releaseAll, fork, call, all, race, pool, child, join, result, interrupted, never, managed, runSync } from './ambient.js';
export { inject, ContextKey } from './inject.js';
export { NoCurrentNodeError, NodeCompletedError, PendingNodeError, NotOwnedError, AlreadyOwnedError, UnawaitedCallError, FiberNotAwaitableError, FiberAbortedError, PoolClosedError, PoolFullError, CreationViolationError, FactoryReturnedUndefinedError, AsyncRunError, PlacementError, OwnerInterrupt } from './resource.js';
export { registerContextStorage } from './context-storage.js';
export type { ContextStorage, Frame } from './context-storage.js';
export { createInjectionKey, setScope, setDependencies } from './context-key.js';
export type { InjectionKey, CreateInjectionKeyOptions } from './context-key.js';
export { classProvider, factoryProvider, valueProvider, aliasProvider } from './provider-util.js';
export type { ProviderOptions } from './provider-util.js';
export { createScope, SelfScope, RootScope, RequestScope } from './scope.js';
export type { Scope } from './scope.js';
export { createTopic } from './topic.js';
export type { TopicReceiver } from './topic.js';
export { NodeTopic } from './lifecycle-events.js';
export type { NodeEvent } from './lifecycle-events.js';
```

Removed from the surface — S3's done-criterion greps `dist/index.d.ts`
for each name below and expects none (`Fiber` survives only as the §7.2
interface; `runSync` only as the ambient function):
values `createContext`, `Fiber` (the namespace object), `withAbortSignal`,
`linkAbortSignal`, `createFiberSet`, `RegisterResource`, `ContextRefKey`,
`create`, `registerResource`, `addProvider` (free), `createRefCountedKey`,
`refCountedProvider`, `Drain`, `Flush`, `Dispose`, `Abort`,
`resourceProvider`, `ContextTopic`, `FiberTopic`;
types `FiberType`, `FiberOptions`, `ForkOptions`, `FiberResult`,
`FiberSet`, `FiberSetOptions`, `FiberSetSpawnOptions`,
`RefCountedKeyOptions`, `ContextRef`, `ManagedResource`, `ResourceHandle`,
`RegisterResourceFunction`, `ContextEvent`, `FiberEvent`, `Created`,
`ContextStatus`, `RunSyncOptions`, `CreateContextOptions`.

`provider-util.ts`: delete `resourceProvider` and the `RegisterResource` /
`ManagedResource` imports; everything else unchanged.

### 1.16 Configuration

- `tsconfig.json`: `lib: ["ES2024", "ESNext.Disposable", "DOM"]`; `exclude: ["src/**/*.test.ts", "src/test/**"]`.
- `tsconfig.tests.json`: `lib: ["ES2024", "ESNext.Disposable", "DOM"]`; `exclude: []`.
- `vitest.config.ts`: `test: { isolate: true, pool: 'forks', execArgv: ['--expose-gc'], setupFiles: ['./src/test/setup.ts'] }`.
- `package.json`: `files` adds `"!src/test"`; `sideEffects` unchanged; description/keywords updated in S4.

---

## 2. The frame: how the current node is carried and read

### 2.1 The frame type

```ts
interface Frame {
  readonly node: NodeImpl | undefined;
  readonly creation: CreationState | undefined;
}
```

Exactly one of the two shapes is ever stored:

| Frame | When installed | `node` | `creation` |
|---|---|---|---|
| body frame `{ node: F }` | `F.startBody()` for a fiber or a release node; `ctx.run(fn)` | the fiber / release node /`ctx` | `undefined` |
| creation frame `{ node: undefined, creation: cs }` | `runCreation(cs, produce)` around a factory, constructor, `provide()` or default factory; once `produce` returns or throws, `cs.ended` and a continuation still carrying the frame reads none (D-107) | `undefined` | the creation state |
| `NO_NODE` `{ node: undefined, creation: undefined }` | around the registration of a body's settle reactions and around every `queueMicrotask` ramme issues (D-46) | `undefined` | `undefined` |

`currentFrame()` returns `undefined` for `NO_NODE`, so every reader treats
it as "no frame": `current()` throws `NoCurrentNodeError`, `managedFor`
sees no awaiting node, `inject` throws `CreationViolationError`.

A frame object is never mutated. The creation frame's node is created on
demand and kept on `cs.slot.node` (so SelfScope inner creations, which
share the outer's slot, see the same node). Reads:

```ts
currentFrame()      = storage.get()
currentCreation()   = currentFrame()?.creation
peekCurrentNode()   = f.node ?? f.creation?.nodeIfCreated          // never creates a node; used by managedFor and emit
currentNode()       = f.node ?? f.creation?.node()                 // creates the value node on first use (§6.2)
```

### 2.2 Who reads what

| Operation | Reads | Behaviour |
|---|---|---|
| `current()` | `currentNode()` | body frame → the node; creation frame → materialise the value node; no frame → `NoCurrentNodeError` |
| `signal()` | `currentNode().signal` | same |
| `lookup(K, o)` | `currentFrame()` | no frame → `NoCurrentNodeError`; `creation` set → `CreationViolationError` (§8.1); else `frame.node.get(K, o)` |
| `inject(K, o)` | `currentCreation()` | `undefined` → `CreationViolationError("inject() outside creation")`; `K === ContextKey` → `cs.node()` (untracked); else `cs.inject(K, o)` then the `No provider found for <name>` check |
| `own(x, …)`, `release(x)`, `releaseAll()` | `currentNode()` | method on that node; in a creation frame this is the value's node (pending or live) |
| `fork(t, …)`, `pool(o)`, `child(o)` | `currentNode()` | method on that node; `fork` on the value node during its creation is recorded on `creationForks` (§4.9) |
| `call`, `all`, `race`, `join`, `result`, `interrupted`, `never`, `managed`, `runSync` (free) | `currentCreation()` then `currentNode()` | creation frame → `CreationViolationError` (I16); else method on the node |
| `ctx.get` / `ctx.call` / `ctx.run` / `ctx.runSync` (method form) | `currentCreation()`, then `currentFrame().node.creationOwner()` | creation frame → `CreationViolationError` (§8.3: entering another node, or a borrow, during creation). The same when the current node lies under a value node still in creation: a release the factory started (D-101; `all`/`race` too, awaits exempt). Internal resolution never goes through `get`. |
| `ctx.fork` (method form) | nothing | allowed in a creation frame (§8.3): the body starts in a microtask under its own frame |
| `managedFor(p, deliver)` | `peekCurrentNode()` | the freeze decision is for the awaiting body's node (§4.3), never for the receiver of a method call; `deliver` runs only when a continuation is delivered (D-38) |
| `ctx.get(K, { skipSelf })` | nothing on the parent | resolves with `resolveFrom(ctx.parent, K)` directly (D-48): no guard runs on the parent, so the decorator pattern works from a body inside a `call` |
| a failure destination handler (§7.4) | — | invoked by `finishCompletion` under `{ node: parent }` (D-45): `current()` is the parent, `own()` attaches there, `lookup()` resolves from it |
| a body's settle reactions, `queueMicrotask(startBody)` | — | registered under `NO_NODE` (D-46): the continuation inherits neither the forker's frame nor a finished creation frame; a body always runs under its own frame (`startBody`) |
| `NodeImpl.emit` / a `NodeTopic` receiver | `root.receiver` | not the frame; the receiver runs in the emitting frame and must not use ambient operations (D-45); a pending value node's `root` is the requester's (D-42) |

### 2.3 Creation under the frame

```ts
function runCreation<R>(cs: CreationState, produce: () => R): R {
  // cycle check over the frame chain (replaces the module-level creationStack)
  let viaChain = false;                                                  // the key reached again through its own chain: an exempt skipSelf read (decorator)
  for (let c = cs.outer; c; c = c.outer)
    if (c.key === cs.key) {
      if (!c.cycleExempt) throw new Error(`Circular dependency detected: ${chain(cs)}`);   // "A → B → A"; cs.outer chain outermost-first, then cs.key
      viaChain = true;
    }
  let marked: Set<InjectionKey<unknown>> | undefined;
  if (cs.ownsSlot) {
    assertNotReentered(cs, viaChain);                                    // D-105, D-106: re-entry outside the frame chain
    const inProgress = (cs.requester.root.creating ??= new Set());      // D-106: in progress per tree, not per resolution base
    if (!inProgress.has(cs.key)) (marked = inProgress).add(cs.key);      // an exempt nested creation leaves the outer's mark
  }
  try {
    let value: R;
    try { value = runInFrame({ node: undefined, creation: cs }, produce); }   // factories are synchronous (A5): the frame is gone when produce returns
    finally { cs.ended = true; }                                         // D-107: a continuation the factory scheduled sees no frame
    if (value === undefined) throw new FactoryReturnedUndefinedError(`Provider for ${name(cs.key)} returned undefined`);
    if (cs.ownsSlot) refuseUnownedJoinForks(cs);                         // Q6 for forks made on the value node during creation (§4.9)
    return value;
  } catch (e) {
    if (cs.ownsSlot) abandonCreation(cs, e);                             // §8.3: release the value node's stacks, owned by the requester (D-99); nothing is cached (P23); the key stays in progress meanwhile (D-105)
    throw e;
  } finally { marked?.delete(cs.key); }                                  // after the abandon's synchronous releases, not before (D-105)
}

function assertNotReentered(cs, viaChain): void {
  for (let c = cs.requester; c; c = c.parent)                            // D-105: an abandoned node keeps its key until it completes
    if (c.failedCreation === cs.key) throw new Error(`Circular dependency detected: ${chain(cs)} re-enters the failed creation of ${name(cs.key)} at ${describeNode(c)} …`);
  if (!viaChain && cs.requester.root.creating?.has(cs.key))               // D-106: in progress anywhere in this tree, reached outside its frame chain
    throw new Error(`Circular dependency detected: ${chain(cs)} re-enters the creation of ${name(cs.key)} in progress in ${describeNode(root)}'s tree …`);
}

function abandonCreation(cs, error): void {                              // every abandon in inject.ts goes through here (D-105)
  const n = cs.nodeIfCreated; if (!n) return;
  n.failedCreation = cs.key;                                             // cleared at n's finishCompletion
  const inProgress = (cs.requester.root.creating ??= new Set()), mark = !inProgress.has(cs.key);
  if (mark) inProgress.add(cs.key);                                      // the post-runCreation refusals (§4.10) hold the mark through the abort too
  try { n.abandon(error, cs.requester); } finally { if (mark) inProgress.delete(cs.key); }
}
```

`cs.inject(K, o)`:

```ts
inject(key, options) {
  if (key === ContextKey) return this.node();                           // untracked (§8.1)
  let r: ResolveResult<unknown>;
  if (options?.skipSelf) {
    this.tracker?.pin(this.requester);                                   // D-97: requester-relative, so an auto-hoisted value is pinned at R
    const base = this.base.parent;
    if (!base) { this.tracker?.track(key, { resolved: false }); return undefined; }   // caller turns this into the optional/throw decision
    r = key === this.key ? this.exempt(() => resolveFrom(base, key)) : resolveFrom(base, key);   // only a skipSelf read of the creation's OWN key is exempt (§1.11; D-109); exempt() saves and restores the flag
  } else {
    r = this.resolve(key);              // auto-hoisted: resolveFrom(requester, key); declared: resolveFrom(placement, key); SelfScope inner: outer.inject(key) wrapped as a result
  }
  this.tracker?.track(key, r);                                           // auto-hoisted only (§8.1): deps(V) and the deepest dependency. A MISS is tracked too (D-43): "K is not provided" is part of V's view, so a later provider for K below S is a shadow
  if (!r.resolved) return undefined;
  return r.value;
}
```

Nested creation (a factory injects a key whose factory must run) pushes a
nested creation frame: `createX` reads `outer = currentCreation()`.
Because the inner `resolveFrom` is called from the outer `cs.inject`, the
outer tracker sees the inner result (`r.autoHoisted`, `r.deps`), which is
how `deps(V)` becomes transitive (§8.2).

### 2.4 The freeze decision: `managedFor` and `ManagedPromise`

Every managed await (§4.3) — `call`, `all`, `race`, `release`,
`releaseAll`, `join`, `result`, `interrupted`, `never`, `managed(p)`,
`close()`, `[Symbol.asyncDispose]()` — ends with
`return managedFor(source, deliver)` (`never()` with `managedNever()`,
`interrupted()` with `managedSignal(source)`, D-66), where `source` is a promise that
**never rejects** (`completion`, `e.done`, `deliveredResolvers.promise`, an
`async` helper that catches everything) and `deliver` is the step that
turns the settled source into the awaiter's value, throws the awaiter's
error, and consumes a failure. `deliver` runs in exactly one place: the
non-cut fulfilment path of `then` (D-38). `managed(p)` is the one wrapper
over a user promise and has no `deliver`.

```ts
function freezeTarget(): FreezeTarget | undefined {
  const cur = peekCurrentNode();                                         // §4.3: the AWAITING body's node, never `this`
  return cur && cur.hasBody && cur.mode !== 'observe' && cur.kind !== 'release' ? cur : undefined;   // undefined: nothing can freeze — top level, platform callback, ctx.run frame, observe body, release fiber
}
export function managedFor<S, T = S>(source: Promise<S>, deliver?: Deliver<S, T>): Promise<T> {
  return new ManagedPromise<S, T>(freezeTarget(), source, deliver);     // ALWAYS a ManagedPromise: with no target it chains at once in `then`, but still delivers only in `then`
}
export function managedNever(): Promise<never> {
  const t = freezeTarget();
  return t ? new ManagedPromise<never, never>(t, undefined) : neverPromise();
}
export function managedSignal<S>(source: Promise<S>, receiver: FreezeTarget): Promise<S> {   // interrupted() (D-66, D-86): the receiver's delivery settles `source` and cuts the awaiter only when the awaiter IS the receiver, so cut-only is exact only there
  const t = freezeTarget();
  return t && t === receiver ? new ManagedPromise<S, S>(t, undefined) : new ManagedPromise<S, S>(t, source);
}

interface Cell { live: boolean; onF: unknown; onR: unknown; res: unknown; rej: unknown }   // one awaiting continuation; emptied on a cut
function empty(c: Cell) { c.live = false; c.onF = c.onR = c.res = c.rej = undefined; }

export class ManagedPromise<S, T = S> extends Promise<T> {
  static [Symbol.species] = Promise;                                     // promises derived by then() are plain
  #target: FreezeTarget | undefined; #source: Promise<S> | undefined; #deliver: Deliver<S, T> | undefined;
  #cells: Cell[] = []; #cut = false; #armed = false;
  #cutFn = () => { this.#cut = true; for (const c of this.#cells) empty(c); this.#cells.length = 0; this.#target!.markFrozen(); };

  constructor(target, source, deliver) {
    super(() => {});                                                     // the subclass instance itself never settles; `then` is the whole protocol
    this.#target = target; this.#source = source; this.#deliver = deliver;
  }

  then(onFulfilled?, onRejected?) {                                      // invoked by `await`, Promise.all/race/resolve, async return, .catch, .finally
    const t = this.#target;
    if (t) {
      if (t.applied) { freezeSoon(t); return neverPromise(); }           // §4.2: requested after delivery → never settles; nothing retained, nothing delivered; markFrozen one microtask later under NO_NODE (D-68)
      if (this.#cut) return neverPromise();
      if (!this.#armed) { this.#armed = true; t.onApplied.add(this.#cutFn); }
      if (!this.#source) return neverPromise();                          // never() / interrupted() on a freeze node: cut-only; callbacks dropped now
    }
    const src = this.#source!, deliver = this.#deliver;
    return new Promise((res, rej) => {
      const cell: Cell = { live: true, onF: onFulfilled, onR: onRejected, res, rej };
      this.#cells.push(cell);
      src.then(
        (v) => { t?.onApplied.delete(this.#cutFn); if (!cell.live) return;           // cut: the reaction holds an empty cell and does nothing
                 const c = { ...cell }; empty(cell);
                 let out; try { out = deliver ? deliver(v) : v; } catch (e) { return rejectWith(c, e); }   // DELIVERY: the only place a failure is consumed (D-38)
                 fulfilWith(c, out); },
        (e) => { t?.onApplied.delete(this.#cutFn); if (!cell.live) return; const c = { ...cell }; empty(cell); rejectWith(c, e); });   // only managed(p) can get here
    });
  }
}
// fulfilWith(c, v): c.res(c.onF ? c.onF(v) : v), a throwing onF rejects via c.rej; rejectWith(c, e): c.onR ? c.res(c.onR(e)) : c.rej(e), a throwing onR rejects via c.rej.
```

Properties (each is a test in `managed.test.ts` against a fake target):

1. **Decision for the awaiting node.** The target is read when the managed
   await is *created*; the receiver of a method call is irrelevant.
   `await app.call(main)` at top level has no current node, so `then`
   chains immediately and the derived promise rejects with
   `FiberAbortedError` on `app.abort()` (§4.3); `await using` cleanup runs.
2. **Suspended means `then` was called.** A body that stores a managed
   promise and awaits a bare promise is *not* frozen at delivery (§4.2:
   plain code between delivery and the next managed await is legitimate);
   the moment it awaits the stored promise, `then` sees `applied` and
   freezes it. This closes the "stored-but-not-awaited" hazard the review
   found in every plan (D-06). A `.then`/`.catch`/`.finally` attached to the
   stored promise is a `then` call too, so it arms the cut while the body
   moves on: unsupported in a freeze body (D-67).
3. **In flight is cut.** A body suspended on a managed await when
   delivery arrives is frozen *at delivery*: `fire()` runs `#cutFn`, the
   node settles as frozen, and the owner starts releasing immediately
   (law 4; `never()`, `managed(p)`, `join` of a foreign fiber all behave).
4. **Nothing is retained (A2).** The continuation reaches ramme only
   through a `Cell`; a cut empties every cell, so a reaction that later
   runs when the source settles holds an empty cell and does nothing. For
   a cut-only promise (`never`), `onFulfilled/onRejected` are dropped in
   `then` itself. `join(f)` of a long-lived fiber, `call` of a
   long-running child and `managed(p)` of a slow `p` therefore retain
   nothing of a frozen body while the source is still pending. The GC
   test (`freeze-gc.test.ts`) fails if any path retains the body. The
   source's reaction is registered outside the awaiter's async context,
   the cell carries that context for `deliver` and the callbacks, and a
   cut also drops the target, so the frozen node itself and its async
   context are collectable too (D-84).
5. **Observe never freezes.** An `observe` body (and every release fiber)
   gets an untargeted wrapper; `interrupted()` resolves with the reason
   (`managedSignal`, D-66).
6. **Delivery is consumption (D-38).** `deliver` runs only in the non-cut
   fulfilment path, once per `then`. A `join(f)` that is stored and never
   awaited consumes nothing; a `join(f)` cut by a freeze consumes nothing;
   the first `call` of `Promise.all([call(a), call(b)])` is never
   delivered because the second `call` threw before `Promise.all` could
   call `then`. In every one of these the failure stays in the parent's
   `unconsumed` and surfaces from the parent's completion (I11).
7. **Sources never reject (D-38).** Every source ramme wraps settles
   without rejecting; the error is produced by `deliver` in the derived
   promise, which belongs to the awaiter. The `ManagedPromise` instance
   never settles. No ramme-internal promise can therefore be an unhandled
   rejection whether or not the wrapper is ever awaited (I10):
   `const p = call(x); await timer; await p` is safe, and so is dropping
   `p` entirely (attaching `p.catch(…)` without awaiting it is not, D-67). `managed(p)` leaves the user promise's handled-ness alone.
8. **Re-delivery reports again (D-50).** A second `then` on the same
   wrapper, or a second `join(f)`, runs `deliver` again and reports the
   same error to the second awaiter; `consumeFailure()` is idempotent.

`markFrozen()` is `onBodyExit({ kind: 'frozen' })`: idempotent (I6), and
the body's `finally` never runs because the body never resumes.

### 2.5 Release fibers as the current node

`releaseEntry(e)` (§4.3 of this document) constructs
`new NodeImpl({ kind: 'release', parent: owner, subscribed: false, stack: 'none', opts: { name: 'release:'+e.name, interrupt: 'observe', signal: deadline }, body: { fn: dispose, … } })`
and calls `startBody()`, which installs `{ node: releaseNode }` with
`runInFrame`. Therefore inside any release — a passive entry's
`[Symbol.asyncDispose]`, a `Release<T>` callback, a defer function, a node
entry's internal close/abort — `current()` is the release node, `signal()`
is its deadline (`AbortSignal.timeout(releaseTimeoutMs)` when set, a
never-firing signal otherwise), `own(x)` attaches to the release node and
is released when its body settles, `lookup(K)` resolves through the owner
(the release node's resolution parent), and `owner.outcome` (captured by
the author at acquisition) is readable because the outcome is fixed at
settling (§4.7 of this document).

---

## 3. Internal data structures of the node

### 3.1 `NodeImpl` fields (exact)

```ts
class NodeImpl implements Context {
  // identity
  readonly id: number;                            // one process-wide counter for every node kind
  readonly kind: NodeKind;
  readonly name: string | undefined;              // opts.name; fibers default to the task name; release nodes 'release:<entryName>'
  // tree
  parent: NodeImpl | undefined;                   // written once by placeAt() for a pending value node; otherwise set in the constructor
  depth: number; root: NodeImpl; autoScopeRoot: NodeImpl;   // a pending node is born with the requester's root and provisional depth/autoScopeRoot (D-42); placeAt() recomputes depth/autoScopeRoot for it and its descendants (fixTree); root never changes
  readonly captureAutoScoped: boolean;
  // the three bits (§3.2) and options
  readonly hasBody: boolean; body: BodyInfo | undefined;   // body is nulled at completion so a long-lived parent retains no closures of completed children (D-53)
  subscribed: boolean;                            // flipped to false by owner.own(node)
  pooled: boolean;                                // created by poolFork: counted in the pool's running/pending (D-47)
  readonly mode: InterruptMode;                   // opts.interrupt ?? 'freeze'
  readonly childrenOnExit: 'interrupt' | 'await'; // opts.childrenOnExit ?? 'interrupt'
  releaseTimeoutMs: number | undefined;           // opts ?? parent's (inherited); fixed by placeAt
  stallWarningMs: number;                         // opts ?? parent's ?? 5000
  // state
  state: NodeState;
  entryOnOwner: Entry | undefined;                // this node's entry on parent's stack (undefined: root, release node, pending)
  // the two stacks and subscribers
  readonly explicit: Stack; readonly provided: Stack;
  readonly subscribers: Set<NodeImpl>;
  // interruption
  readonly controller: AbortController;           // `signal` is controller.signal
  delivered: boolean; applied: boolean; abortReason: unknown;
  deliveredResolvers: PromiseWithResolvers<unknown> | undefined;   // for interrupted(); created lazily; resolved in fire()
  readonly onApplied: Set<() => void>;            // ManagedPromise cut functions; cleared by fire()
  stallTimer: ReturnType<typeof setTimeout> | undefined;
  timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  linkedSignal: AbortSignal | undefined; onLinkedAbort: (() => void) | undefined;
  // lending (§7.11)
  lentTo: NodeImpl | undefined;                   // the call child this node is lent to
  lender: NodeImpl | undefined;                   // (on the call child) the node lent to it; both fields are cleared by whichever side completes first (D-53)
  // body and outcome
  bodyStarted: boolean; bodyDone: boolean;
  closeRequested: boolean;                        // close() was called before the body exited
  exitKind: 'interrupt' | 'await' | undefined;    // decided at settle; drives step 1 and the per-entry dispose choice
  outcome: Outcome<unknown> | undefined;          // fixed at settling (§7.6); amended once at completion (§9.2)
  extraErrors: unknown[];                         // the owner's loop's release failures (passive entries), handler exceptions — in order of occurrence
  aggregatedExtra: unknown | undefined;           // the single error / AggregateError built from extraErrors + unconsumed at completion; what close() rejects with
  readonly unconsumed: Set<FailureRecord>;        // failures held for this node: child fibers ('join', 'link', owned), non-fiber children (context/pool/value release failures), early releases (D-40, D-41); a record leaves the set when delivered
  failure: FailureRecord | undefined;             // this node's own FINAL failure, created at completion; the same object sits in parent.unconsumed; `.consumed` flips in consumeFailure()
  readonly completionResolvers: PromiseWithResolvers<void>;   // `completion` = .promise; never rejects; every close()/asyncDispose()/join wrapper is built over it (no shared close promise is needed, D-38)
  // creation bookkeeping (value nodes)
  inCreation: boolean;                            // true from materialisation until the owning creation finishes
  creationForks: NodeImpl[];                      // fibers forked onto this node (or a descendant) while inCreation; started after placement, or after abandon (D-99)
  creating: Set<InjectionKey<unknown>> | undefined;   // root only: keys whose creation is in progress in this tree; lazily created (D-101, D-106)
  failedCreation: InjectionKey<unknown> | undefined;  // an abandoned value node: the key of its failed or refused creation, cleared at its completion (D-105)
  // pool
  readonly pool: PoolState | undefined;
  // resolution (read and written by inject.ts)
  providers: Map<InjectionKey<unknown>, Provider<unknown>> | undefined;
  readonly cache: Map<InjectionKey<unknown>, CacheEntry>;
  readonly decided: Set<InjectionKey<unknown>>;
  readonly scopeSet: Set<Scope> | undefined;
  // observability (root only)
  receiver: TopicReceiver<NodeEvent> | undefined | null | 'resolving';   // null = not yet resolved
  warnedKeys: Set<InjectionKey<unknown>> | undefined;                   // Q4 once-per-key dev warning (root only)
}
```

Allocation note: `explicit`, `provided`, `subscribers`, `onApplied`,
`cache`, `decided`, `unconsumed`, `extraErrors` are created in the
constructor (a `Stack` is two pointers and a lazily created `Map`;
a release node therefore costs one object plus one `AbortController`).

### 3.2 The three bits by constructor (binding table)

| Constructor | `kind` | `parent` | `stack` | `subscribed` | `body` | `state` at birth |
|---|---|---|---|---|---|---|
| `createRootContext(o)` | `'context'` | `undefined` | `'none'` | `false` | – | `running` |
| `n.child(o)` | `'context'` | `n` | `'explicit'` | `true` | – | `running` |
| `n.call(t)` | `'fiber'` | `n` | `'explicit'` | `true` | yes; destination `'join'` | `running`, body started synchronously |
| `n.fork(t)` | `'fiber'` | `n` | `'explicit'` | `true` | yes; `t.opts.onFailure ?? 'join'` | `running`, body starts in a microtask |
| `n.own(fiber)` | (flips) | – | – | `false` | – | – |
| `n.pool(o)` | `'pool'` | `n` | `'explicit'` | `false` | – | `running` |
| `pool.fork(t)` | `'fiber'` | `pool` | `'explicit'` | `true` | yes; destination `o.onFailure` | `running` |
| `cs.node()` auto-hoisted | `'value'` | `undefined` → `S` at `placeAt` | `'provided'` (at placement) | `false` | – | `pending` → `running` |
| `cs.node()` declared placement | `'value'` | `S` | `'provided'` | `false` | – | `running` |
| `releaseEntry(e)` | `'release'` | owner | `'none'` | `false` | yes; the dispose | `running`, body started synchronously |

### 3.3 Interrupt wiring per mode and the birth rule

Per node: `mode`, `delivered`, `applied = delivered && mode !== 'observe'`,
`abortReason`, `controller`. Delivery is two-pass (§4.1 of this document).
Forwarding rules (§4.1, §4.4 of the proposal):

| Node mode | Marks itself when delivered | Forwards to subscribers |
|---|---|---|
| `freeze` | yes, `applied` | all, as a normal delivery |
| `restore` | yes, `applied` | all, as a normal delivery |
| `observe` | yes, **not** `applied` | as a *restore-only* delivery: intermediate `freeze` nodes pass it through unmarked, `restore` nodes accept it and forward normally |

Birth rule (constructor, when `parent` is defined):

```ts
const bornDelivered =
  mode === 'restore' ? anyAncestorDelivered(parent)                       // §4.4: "whenever any ancestor is delivered"
  : mode === 'freeze' ? (parent.delivered && parent.mode !== 'observe')   // delivered iff the parent would have forwarded to it (D-05)
  : false;                                                                // observe: never at birth
if (bornDelivered) markDelivered(nearestDeliveredAncestorReason);         // delivered + applied + controller.abort(reason) — body still runs until its first managed await (§5.4)
```

Own-signal sources always deliver regardless of mode (§4.4): `abort()`,
`timeoutMs` (`setTimeout` → `abort(new DOMException('Timed out', 'TimeoutError'))`, unref'd), and
`opts.signal` (listener → `abort(signal.reason)`; an already-aborted signal
at construction → `abort()` immediately, so an unstarted fiber settles
`aborted` without running — D-13).

### 3.4 `lentTo`

One field on the lender (the node that was current when `call` ran) and
one back-pointer on the child. Set in `call` before the child's body
starts; cleared synchronously in the child's `finishCompletion()`, or in
the lender's if the lender completes first (a frozen `Y` whose
`ctx.call(...)` child lives on another node, D-53). Checked by
`assertNotLent(op)` at the public entry of: `get`, `call`, `fork`,
`child`, `pool`, `all`, `race`, `join`, `result`, `interrupted`, `never`,
`managed`, `run`, `runSync`. Never checked by `own`, `release`,
`releaseAll`, `abort`, `close`, `[Symbol.dispose]`, `[Symbol.asyncDispose]`,
nor by anything internal (the release loop, `resolveFrom`'s walk, the
`skipSelf` walk from the parent, D-48).

### 3.5 Decided markers, deps sets, per-key storage

- `decided: Set<Key>` on every node: keys this node has answered for
  (value or "not provided here"), including `deps(V)` for auto-hoisted
  answers. Cleared at completion. Read by `assertProviderPlacement`.
- `cache: Map<Key, CacheEntry>` on every node: values *stored here*
  (never negative entries, never entries for values stored elsewhere).
  `CacheEntry.deps` is `deps(V)` for auto-hoisted values, `undefined` for
  declared placement. Cleared at completion.
- `providers: Map<Key, Provider>` set at construction (`opts.providers`)
  and by `addProvider`.
- The per-context *union* of deps the proposal mentions is not kept
  (D-19): both rules are served by the hit's own `deps` and by `decided`.

### 3.6 Per-node stacks and the entry record

`explicit` holds code-attached entries (`own`, `fork`, `call`, `child`,
`pool`); `provided` holds exactly the nodes of DI values placed here
(I24: only `placeAt` / `createValueNode` push there). An `Entry` records
`target`, `name`, optional `node`, `dispose`, `state`, `done`, `failure`,
`early`. A node entry's `dispose` is unused; the loop derives the action
from `exitKind` and `node.subscribed` (§4.3 of this document).

---

## 4. Pseudocode

TypeScript-flavoured; `emit(...)` elides `seq`/`id`/`parentId`/`kind`,
which `NodeImpl.emit` fills in. `isPromise(x)` is
`x != null && typeof x.then === 'function'`. "dev" means
`typeof process === 'undefined' || process.env.NODE_ENV !== 'production'`.

### 4.1 Construction and delivery

```ts
constructor(init: NodeInit) {
  init.parent?.assertOpen('attach');                                                                       // C3/I7 first: nothing is emitted or attached for a child of a complete node
  this.id = ++nextId; this.kind = init.kind; this.parent = init.parent;
  this.hasBody = init.body !== undefined; this.body = init.body; this.pool = init.pool;
  this.subscribed = init.subscribed; this.pooled = false;
  this.mode = init.opts.interrupt ?? 'freeze'; this.childrenOnExit = init.opts.childrenOnExit ?? 'interrupt';
  this.name = init.opts.name ?? init.body?.taskName;
  this.captureAutoScoped = init.opts.captureAutoScoped ?? false;
  this.scopeSet = init.opts.scopes?.length ? new Set(init.opts.scopes) : undefined;
  const basis = init.parent ?? init.basis;                                                                 // a pending value node borrows the requester (D-42): same root, provisional depth/autoScopeRoot/timeouts until placeAt
  if (basis)       { this.depth = basis.depth + 1; this.root = basis.root;
                     this.autoScopeRoot = this.captureAutoScoped ? this : basis.autoScopeRoot;
                     this.releaseTimeoutMs = init.opts.releaseTimeoutMs ?? basis.releaseTimeoutMs;
                     this.stallWarningMs = init.opts.stallWarningMs ?? basis.stallWarningMs; }
  else             { this.depth = 0; this.root = this; this.autoScopeRoot = this;
                     this.releaseTimeoutMs = init.opts.releaseTimeoutMs; this.stallWarningMs = init.opts.stallWarningMs ?? 5000; }
  this.state = init.pending ? 'pending' : 'running';
  if (init.opts.providers?.length) {
    this.providers = new Map();
    for (const p of init.opts.providers) { assertProviderPlacement(this, p, /*atConstruction*/ true); this.providers.set(p.key, p); }
  }
  this.emit({ type: 'node:created', name: this.name, task: init.body?.taskName, stack: init.stack, subscribed: init.subscribed, mode: this.mode });   // every node's FIRST event (D-54): before entry:registered, node:delivered, node:complete
  if (init.parent && init.stack !== 'none') this.entryOnOwner = init.parent.attachNode(this, init.stack);   // I15: synchronous
  if (init.parent && init.subscribed) init.parent.subscribers.add(this);
  if (init.parent) {                                                                                      // birth rule (§3.3 of this doc)
    const src = this.mode === 'restore' ? nearestDeliveredAncestor(init.parent)
              : this.mode === 'freeze' && init.parent.delivered && init.parent.mode !== 'observe' ? init.parent : undefined;
    if (src) this.markDelivered(src.abortReason);          // delivered, applied, controller.abort(reason), node:delivered; no settle, no listeners yet
  }
  if (init.opts.timeoutMs !== undefined && init.opts.timeoutMs !== Infinity) this.timeoutTimer = unref(setTimeout(() => this.abort(new DOMException('Timed out', 'TimeoutError')), init.opts.timeoutMs));   // D-78: the three millisecond options are validated first (TypeError); Infinity arms nothing
  if (init.opts.signal) {
    this.linkedSignal = init.opts.signal;
    if (init.opts.signal.aborted) this.abortInternal(init.opts.signal.reason);     // D-13: settles an unstarted fiber without running it — node:created → node:delivered → node:settled → node:complete
    else { this.onLinkedAbort = () => this.abortInternal(this.linkedSignal!.reason); init.opts.signal.addEventListener('abort', this.onLinkedAbort, { once: true }); }
  }
}

attachNode(child, stackKind) {                     // I24: the only path onto `provided` is placeAt/createValueNode → attachNode(child, 'provided')
  this.assertOpen('attach');                       // placeAt's and the constructor's early check make this redundant in practice
  const stack = stackKind === 'explicit' ? this.explicit : this.provided;
  const e = stack.push({ target: child, name: child.name ?? `${child.kind}#${child.id}`, node: child, dispose: noop, state: 'live', done: undefined, failure: undefined, early: false });
  this.emit({ type: 'entry:registered', entryName: e.name, stack: stackKind });
  return e;
}

abort(reason?: unknown): void {
  if (this.state === 'complete') return;                                 // idempotent, part of the lifecycle quartet (D-09)
  if (this.state === 'pending') throw new PendingNodeError('abort() on a pending node');
  this.abortInternal(reason === undefined ? new DOMException('This operation was aborted', 'AbortError') : reason);
}

abortInternal(reason: unknown): void {
  if (!this.delivered) {
    const marked: NodeImpl[] = [];
    this.deliver(reason, /*restoreOnly*/ false, marked);                  // pass 1: mark the whole subscribed subtree (I9)
    fire(marked);                                                           // pass 2: signals, cuts, bodiless settles
  }
  // a node whose body never started is cancelled before it runs (D-13); bodiless nodes exit on abort (§5.1)
  if (this.state === 'running' && (!this.hasBody || !this.bodyStarted)) { this.exitKind = 'interrupt'; this.onBodyExit(this.hasBody ? { kind: 'unstarted' } : { kind: 'bodiless' }); }
}

deliver(reason, restoreOnly, marked): void {       // pass 1 — no user code runs here
  if (restoreOnly && this.mode !== 'restore') { for (const s of this.subscribers) s.deliver(reason, true, marked); return; }   // pass-through, unmarked
  if (this.delivered) return;
  this.markDelivered(reason, /*fire later*/ true); marked.push(this);
  const nextRestoreOnly = this.mode === 'observe';
  for (const s of this.subscribers) s.deliver(reason, nextRestoreOnly, marked);
}
markDelivered(reason, deferFire = false) {
  this.delivered = true; this.abortReason = reason; this.applied = this.mode !== 'observe';
  if (!deferFire) { this.controller.abort(reason); this.deliveredResolvers?.resolve(reason); this.emit({ type: 'node:delivered', reason }); }   // born-delivered nodes (D-54); two-pass deliveries do this in fire()
}

function fire(marked: NodeImpl[]): void {          // pass 2, in collection order (top-down)
  for (const n of marked) {                        // 2a: every signal fires before any body is settled or frozen
    n.controller.abort(n.abortReason);             // user abort listeners run here; every node in the subtree is already marked (I9)
    n.deliveredResolvers?.resolve(n.abortReason);
    n.emit({ type: 'node:delivered', reason: n.abortReason });
  }
  for (const n of marked) {                        // 2b: freeze and settle
    if (n.applied) { const cuts = [...n.onApplied]; n.onApplied.clear(); for (const cut of cuts) cut(); }   // in-flight managed awaits → markFrozen → release starts
    if (n.state === 'running' && !n.bodyDone) {
      if (!n.hasBody) { n.exitKind = 'interrupt'; n.onBodyExit({ kind: 'bodiless' }); }                     // a child() dies with its parent's interrupt
      else if (n.bodyStarted) n.armStallTimer();                                                              // §4.6 diagnostic for ANY delivered body that has neither settled nor frozen, observe included (D-55); an unstarted body is settled by abortInternal (D-13) or armed by startBody
    }
  }
}
```

A `pool` node is unsubscribed, so it is never in `marked` through
forwarding; it is delivered by its owner's loop at its turn
(`abortInternal` from `releaseEntry`) or by a direct `pool.abort()`.

### 4.2 Body start, body exit, the release loop

```ts
startBody(): void {                                                        // fibers and release nodes
  if (this.bodyDone || this.bodyStarted) return;                           // cancelled before start (D-13) or already running
  this.bodyStarted = true; this.emit({ type: 'node:started' });
  if (this.kind === 'release' || this.delivered) this.armStallTimer();      // a release fiber, or a body born delivered (D-55)
  let r: unknown, settlesLater = false;
  try {
    r = runInFrame({ node: this, creation: undefined }, () => this.body!.fn(...this.body!.args));
    if (isNodeImpl(r) && r.kind === 'fiber') throw new FiberNotAwaitableError(`the body of ${describeNode(this)} returned a fiber; return join(f), or a value`);   // D-49: the thenable probe below must never reach the `then` trap (D-29); any other node is a value and is not probed (D-83)
    settlesLater = isPromise(r);                                           // inside the try: a hostile `then` getter is a body failure, never an exception escaping a microtask (I10)
  } catch (e) { this.onBodyExit({ kind: 'threw', error: e }); return; }
  if (settlesLater) runInFrame(NO_NODE, () => (r as Promise<unknown>).then(      // D-46: the settle reactions are registered under NO frame, so onBodyExit → releaseLoop → finishCompletion inherit neither the forker's nor a creation frame
    (v) => this.onBodyExit({ kind: 'returned', value: v }), (e) => this.onBodyExit({ kind: 'threw', error: e })));   // no reference to `r` is kept on the node
  else this.onBodyExit({ kind: 'returned', value: r });                      // synchronous body: settles synchronously (maybe-async)
}

type BodyResult = { kind: 'returned'; value: unknown } | { kind: 'threw'; error: unknown } | { kind: 'frozen' } | { kind: 'bodiless' } | { kind: 'unstarted' };

onBodyExit(r: BodyResult): void {
  if (this.bodyDone) return;                                                // I2: once (frozen then settled; double abort; …)
  this.bodyDone = true;
  clearTimeout(this.timeoutTimer); clearTimeout(this.stallTimer);
  this.outcome = classify(this, r);                                         // §4.7 of this doc — fixed NOW, readable by every release (§5.6, §6.1)
  this.state = 'settling';
  this.emit(r.kind === 'frozen' ? { type: 'node:frozen' } : { type: 'node:settled', outcome: this.outcome.status });
  // immediate half of the destination (§7.4 'link' "aborts the parent immediately"; C5 for owned fibers)
  if (this.kind === 'fiber' && this.outcome.status === 'failure' && this.parent &&
      (this.body!.destination === 'link' || !this.subscribed)) this.parent.abortIfOpen(this.outcome.error);   // D-79: while the parent is open, a closing or awaiting parent included
  // 1. Signal (§5.1 step 1): always after abort(); at a natural body exit only under childrenOnExit 'interrupt'; never under close()
  if (this.exitKind === undefined) this.exitKind = this.delivered ? 'interrupt' : this.closeRequested ? 'await' : this.childrenOnExit;
  if (this.exitKind === 'interrupt' && this.subscribers.size) {
    const reason = this.delivered ? this.abortReason : new OwnerInterrupt(this);       // the exiting node is the origin of a new interrupt; it is not itself marked (D-04)
    const marked: NodeImpl[] = [];
    for (const s of [...this.subscribers]) s.deliver(reason, false, marked);           // every subscriber in the subtree, whatever this node's mode
    fire(marked);
  }
  // 2 + 3. Stacks
  this.state = 'releasing';
  this.releaseLoop();                                                        // stays synchronous while every release is synchronous; completes the node itself (D-69)
}

releaseLoop(): void {
  let phase: 'explicit' | 'provided' | undefined;
  const step = (): void => {
    for (;;) {
      const stack = this.explicit.hasPending() ? this.explicit : this.provided.hasPending() ? this.provided : undefined;   // re-checked every iteration:
      if (!stack) { this.finishCompletion(); return; }                                                                      // a release may own() onto this node (C2) or place a value here (§6.2); D-69: complete in the SAME step as the empty check, so no continuation can push between them
      if (phase !== stack.kind) { phase = stack.kind; this.emit({ type: 'node:releasing', stack: phase }); }
      const e = stack.topPending()!;                                        // the current tail: an entry pushed during release is released next
      if (e.state === 'releasing') { outsideFrames(() => e.done!.then(step)); return; }   // an early release(x) is in flight: wait for the shared promise (C7, §5.6 waiting); e.done is always set while 'releasing' (D-36) and never rejects; the continuation runs under NO_NODE (D-103)
      const r = this.releaseEntry(e, /*early*/ false);                       // never throws
      if (isPromise(r)) { outsideFrames(() => r.then(step)); return; }      // no promise chain to adopt: the next step runs one reaction after the release ends, under NO_NODE (D-103)
    }
  };
  step();
}
```

`close()`, `'await'` mode and `childrenOnExit` only change `exitKind`,
which decides step 1 (no signal under `'await'`) and which action a node
entry receives in step 2 (§4.3 of this document). Both stacks are always
released, LIFO, explicit first (I3, I5).

### 4.3 One release (`releaseEntry`) — every release is a fiber

```ts
releaseEntry(e: Entry, early: boolean): void | Promise<void> {
  if (e.state !== 'live') return e.state === 'released' ? undefined : e.done;   // I2/C4/C7 (D-36): a release runs at most once; a concurrent caller (release(x), releaseAll(), the owner's loop) shares the one in flight
  const { promise, resolve } = Promise.withResolvers<void>();
  e.state = 'releasing'; e.early = early; e.done = promise;                   // e.done exists BEFORE any dispose code runs: a dispose that synchronously re-enters the owner (an owned fiber's C5 abort, a callback calling owner.abort()) finds a promise to wait on
  const owner = this;
  const action: () => void | Promise<void> = e.node
    ? () => {                                                               // a NODE entry (§5.1 step 2)
        const n = e.node!;
        if (owner.exitKind === 'await' && n.subscribed) n.closeInternal();                    // close()/'await': "mostly a wait"; Q7 recursive close
        else n.abortInternal(owner.delivered ? owner.abortReason : new OwnerInterrupt(owner)); // asyncDispose semantics: abort, then await completion
        return n.state === 'complete' ? undefined : n.completion;                             // D-25: a child whose subtree completed synchronously keeps the owner's loop synchronous; otherwise wait (never rejects; the child's failure flows through owner.unconsumed, D-40)
      }
    : e.dispose;                                                            // a PASSIVE entry: toDispose(...) result; runs with the release node current
  const rf = new NodeImpl({ kind: 'release', parent: owner, subscribed: false, stack: 'none',
    opts: { name: `release:${e.name}`, interrupt: 'observe',
            signal: deadline },   // D-78: computed before the entry changes; AbortSignal.timeout(Math.ceil(ms)) for a finite releaseTimeoutMs, none for undefined/Infinity; created under NO_NODE (D-103)
    body: { fn: action, args: [], destination: noopHandler, taskName: `release:${e.name}` } });
  rf.startBody();                                                           // synchronous up to the first await; rf is current inside `action` (I14)
  const finish = () => {
    if (rf.outcome!.status === 'failure') {
      const err = rf.outcome!.error;
      if (e.early) { e.failure = { error: err, consumed: false }; owner.unconsumed.add(e.failure); }   // D-41: delivered to release()/releaseAll()'s awaiter, or surfaced by the owner's completion if that awaiter froze or never awaited
      else owner.extraErrors.push(err);                                      // C6: continue; §9.2
    }
    e.state = 'released'; e.stack.unlink(e);                                // physical removal (P1)
    owner.emit({ type: 'entry:released', entryName: e.name, stack: e.stack.kind, error: rf.outcome!.status === 'failure' ? String(rf.outcome!.error) : undefined });
    resolve();
  };
  if (rf.state === 'complete') { finish(); return; }                        // all-synchronous release: no await anywhere (runSync observes it; D-25)
  outsideFrames(() => rf.completion.then(finish));                          // D-103: never in a creation frame that started the release
  return e.done;                                                            // the loop chains on this; concurrent callers share the same promise
}
```

The release node's own explicit stack (anything `own`ed inside the
release) is released by *its* loop before `rf.completion` resolves, so
"released when the release finishes" (§6.2) holds. `rf.outcome` is
`failure` iff `action` threw or rejected; a node entry's `completion`
never rejects, so a child's failure is never double-counted as a release
error. `releaseAll()` racing `release(x)`, or an `abort()` arriving in the
middle of a `releaseAll()`, therefore releases each entry exactly once:
the second party finds `state !== 'live'` and waits on `e.done`.

### 4.4 Early release and `releaseAll`

```ts
release(value: object): Promise<void> {
  this.assertOpen('release');                                               // C3; pending nodes allowed
  const e = this.explicit.find(value);                                     // only the explicit stack is code-releasable
  if (!e) throw new NotOwnedError(`release(): ${describe(value)} is not owned by ${describeNode(this)}`);
  this.releaseEntry(e, /*early*/ true);                                     // runs now, in a release fiber; a no-op when already releasing (D-36); the owner's loop will find it 'releasing' or gone
  return managedFor(e.done!, () => { if (e.failure) { consume(this, e.failure); throw e.failure.error; } });   // C7: concurrent calls share e.done; the error is delivered to THIS caller (D-41) — a frozen caller leaves it in unconsumed
}

releaseAll(): Promise<void> {
  this.assertOpen('releaseAll');
  const entries = this.explicit.snapshotTopDown();
  const run = async (): Promise<FailureRecord[]> => {                      // never rejects
    for (const e of entries) {
      if (e.state === 'released') continue;                                 // finished meanwhile by release(x) or by the owner's loop (I2)
      this.releaseEntry(e, true);                                           // starts it, or joins the release in flight
      await e.done;
    }
    return entries.filter((e) => e.failure).map((e) => e.failure!);
  };
  return managedFor(outsideFrames(run), (records) => {                      // D-103: the loop's continuations start later releases under NO_NODE; the managed await is still the caller's
    for (const r of records) consume(this, r);
    if (records.length) throw records.length === 1 ? records[0].error : new AggregateError(records.map((r) => r.error), 'releaseAll(): some releases failed');
  });
}
function consume(owner: NodeImpl, r: FailureRecord) { r.consumed = true; owner.unconsumed.delete(r); }
```

### 4.5 Completion

```ts
finishCompletion(): void {
  // amend the outcome once with what the release phase produced (§9.2, §9.4)
  const extra = [...this.extraErrors];
  for (const rec of this.unconsumed) if (!rec.consumed) { extra.push(rec.error); rec.consumed = true; }   // I11: surfaced once — child fibers, non-fiber children, early releases whose awaiter froze or never awaited (D-40, D-41)
  this.unconsumed.clear();
  if (extra.length) {
    const agg = extra.length === 1 ? extra[0] : new AggregateError(extra, 'Errors during release');
    this.aggregatedExtra = agg;
    this.outcome = this.outcome!.status === 'failure'
      ? { status: 'failure', error: new SuppressedErrorCtor(agg, this.outcome.error, 'Release failed after the body failed') }   // Q2: release-primary
      : { status: 'failure', error: agg };                                                                                     // success/aborted/bodiless + release failures → failure
  }
  this.state = 'complete';
  this.cache.clear(); this.providers = undefined; this.decided.clear();
  clearTimeout(this.stallTimer); clearTimeout(this.timeoutTimer);
  if (this.linkedSignal && this.onLinkedAbort) this.linkedSignal.removeEventListener('abort', this.onLinkedAbort);
  // route this node's FINAL failure (§7.4, §9.4, §5.6 "routed or collected")
  // D-80 reorders what follows: lending pair and p.subscribers first; a handler runs while this node's live entry is held
  // 'releasing'; the record is added before any escalation; entry unlink, poolChildComplete, node:complete and the
  // completion resolve come next; the 'link'/C5 escalation p.abortIfOpen(err) (D-79) runs last.
  const p = this.parent;
  if (p && this.outcome!.status === 'failure' && this.kind !== 'release') {   // a release node's failure belongs to its entry (releaseEntry.finish), never to the owner's unconsumed
    const err = this.outcome!.error;
    this.failure = { error: err, consumed: false };
    const d = this.kind === 'fiber' ? this.body!.destination : undefined;
    if (typeof d === 'function') {                                          // handler: called once, with the final failure, with the PARENT current (D-45)
      this.failure.consumed = true;
      try { runInFrame({ node: p, creation: undefined }, () => d(err, this)); } catch (he) { p.extraErrors.push(he); }
    } else {
      if (d === 'link' || (this.kind === 'fiber' && !this.subscribed)) p.abortIfOpen(err);   // idempotent with the settle-time abort; LAST in finishCompletion (D-80)
      p.unconsumed.add(this.failure);                                       // 'join' fibers, child() contexts, pools, value nodes (D-40): surfaces from the parent's completion unless delivered first
    }
  }
  if (this.lender) { if (this.lender.lentTo === this) { this.lender.lentTo = undefined; this.lender.emit({ type: 'node:returned', childId: this.id }); } this.lender = undefined; }
  if (this.lentTo) { this.lentTo.lender = undefined; this.lentTo = undefined; }   // D-53: a lender completing before its call child (frozen Y, child on another node) retains nothing and is retained by nothing
  if (this.entryOnOwner && this.entryOnOwner.state === 'live') { this.entryOnOwner.state = 'released'; this.entryOnOwner.stack.unlink(this.entryOnOwner); }   // completed on its own (C5 "removed")
  p?.subscribers.delete(this);
  if (this.pooled) poolChildComplete(p!, this);                             // D-47: only fibers poolFork created — never release nodes, value nodes or passive entries under a pool
  this.body = undefined;                                                    // D-53: drop fn/args; hasBody/kind/name stay
  this.emit({ type: 'node:complete', outcome: this.outcome!.status });
  this.completionResolvers.resolve();                                       // never rejects (I10)
}
consumeFailure(): void { const r = this.failure; if (r) { r.consumed = true; this.parent?.unconsumed.delete(r); } }   // idempotent (D-50)
```

### 4.6 Awaiting: join, result, call materialisation, close, dispose

```ts
function take<T>(f: NodeImpl): T {                                          // join semantics; runs as a `deliver` (D-38): only for an awaiter that is actually resumed
  const o = f.outcome!;
  if (o.status === 'success') return o.value as T;
  f.consumeFailure();                                                       // failure.consumed = true, parent.unconsumed.delete(failure); idempotent (D-50); no-op for an aborted fiber
  if (o.status === 'failure') throw o.error;
  throw new FiberAbortedError(o.reason, `fiber ${describeNode(f)} was aborted`);   // only observable by a non-frozen awaiter (top level, observe, release fiber)
}

join(f)   { this.assertOpen('join'); this.assertNotPending('join'); this.assertNotCreating('join'); this.assertNotLent('join'); assertFiber(f);
            this.emit({ type: 'join:enter', joinedId: f.id });
            return managedFor(f.completion, () => { this.emit({ type: 'join:leave', joinedId: f.id, outcome: f.outcome!.status }); return take(f); }); }   // a frozen joiner emits node:frozen and never join:leave
result(f) { …same guards…; return managedFor(f.completion, () => { f.consumeFailure(); return f.outcome!; }); }
interrupted() { …guards…; this.deliveredResolvers ??= Promise.withResolvers(); if (this.delivered) this.deliveredResolvers.resolve(this.abortReason);
            return managedSignal(this.deliveredResolvers.promise); }           // D-66: on a freeze awaiter cut-only with the target's shared cut ≡ never() (D-07, D-64); an observe body, a release fiber or top level gets the reason
never()   { …guards…; return managedNever(); }
managed(p){ …guards…; return managedFor(p); }                                // the one wrapper over a user promise: its rejection is the user's own and is delivered as it is

close(): Promise<void> {
  if (this.state === 'pending') throw new PendingNodeError('close() on a pending node');
  if (this.state === 'running' && !this.closeRequested) {
    this.closeRequested = true;
    if (!this.hasBody) { this.exitKind = 'await'; this.onBodyExit({ kind: 'bodiless' }); }           // bodiless: settle now, outcome success, no signal
    // a fiber: wait for the body; exitKind is decided at body exit ('await' unless abort() arrives first — abort wins, D-11)
  }
  return managedFor(this.completion, () => this.deliverClose());                                      // every call wraps the same non-rejecting `completion`; nothing can reject unhandled (§9.5, D-38), so no shared promise is kept
}
deliverClose(): void {                                                                                // "rejects with unconsumed failures"
  if (this.aggregatedExtra === undefined) return;
  if (this.kind !== 'fiber') this.consumeFailure();                                                   // a context/pool/value node: its failure IS aggregatedExtra; delivering it consumes it (D-40)
  throw this.aggregatedExtra;                                                                         // a fiber: release/unconsumed errors only — its own body failure is join's (D-12)
}
closeInternal(): Promise<void> { if (this.state === 'running' && !this.closeRequested) { this.closeRequested = true; if (!this.hasBody) { this.exitKind = 'await'; this.onBodyExit({ kind: 'bodiless' }); } } return this.completion; }

[Symbol.dispose](): void { if (!this.parent) throw new TypeError('A root context has no owner to wait for its completion; use `await using` or close()'); this.abort(); }
[Symbol.asyncDispose](): Promise<void> {
  this.abort();                                                                                      // synchronous prefix delivers the signal (§5.6)
  return managedFor(this.completion, () => {
    if (this.kind === 'fiber') take(this);                                                           // acts as join: consumes and throws the fiber's own failure / FiberAbortedError
    else if (this.outcome!.status === 'failure') { this.consumeFailure(); throw this.outcome!.error; }   // contexts/pools: unconsumed failures
  });
}
```

`aggregatedExtra` is the `agg` value computed in `finishCompletion`
(`undefined` when the release phase produced no errors). A second
`join(f)`, `result(f)` or `[Symbol.asyncDispose]()` on a settled fiber
delivers again and reports the same outcome to the second awaiter
(D-50); the idempotence D-09 promises is about the lifecycle (one abort,
one release per entry, one completion), not about hiding an outcome from
a later observer.

### 4.7 Outcome classification (§7.6, §9.1)

```ts
function classify(n: NodeImpl, r: BodyResult): Outcome<unknown> {
  switch (r.kind) {
    case 'unstarted': return { status: 'aborted', reason: n.abortReason };
    case 'frozen':    return { status: 'aborted', reason: n.abortReason };
    case 'bodiless':  return n.delivered ? { status: 'aborted', reason: n.abortReason } : { status: 'success', value: undefined };   // abort() vs close()
    case 'returned':
    case 'threw':
      if (n.applied) return { status: 'aborted', reason: n.abortReason };     // freeze/restore delivered before the body settled: aborted whatever it produced (I13)
      return r.kind === 'returned' ? { status: 'success', value: r.value } : { status: 'failure', error: r.error };   // observe, or not delivered
  }
}
```

The error is never inspected. A delivery that arrives *after* settling
changes nothing (the outcome was fixed at settling).

### 4.8 task / fork / call, lending, all / race

```ts
// fiber.ts
export function task(body, opts = {}) { return new TaskImpl(body, opts, opts.name ?? (body.name || 'anonymous')); }   // parenthesised: `??` and `||` cannot be mixed

// node-impl.ts
fork(t, ...args) {
  this.assertOpen('fork'); this.assertNotLent('fork');                                      // pending allowed; creation frame allowed (§8.3)
  const task = toTask(t);
  if (this.pool) return poolFork(this, task, args);
  const dest = task.opts.onFailure ?? 'join';
  if (dest === 'join' && !this.hasBody && !this.creationOwner())                              // Q6, synchronous for live bodiless nodes (root, child()); forks under a node in creation are checked at the end of creation (§4.9)
    throw new TypeError(`fork(${task.name}) onto bodiless node ${describeNode(this)} with the default 'join' destination: nothing would join it. Pass onFailure (a handler or 'link'), fork from a body, or use pool().`);
  const child = new NodeImpl({ kind: 'fiber', parent: this, subscribed: true, stack: 'explicit', opts: task.opts, body: { fn: task.body, args, destination: dest, taskName: task.name } });
  child.scheduleStart();                                                                      // I20: never in the forker's frame
  return child;
}

call(t, ...args) {
  this.assertOpen('call'); this.assertNotPending('call'); this.assertNotCreating('call'); this.assertNotLent('call');
  const task = toTask(t);
  const lender = currentFrame()?.node;                                                        // §7.11: `call` lends the CURRENT node (the awaiting body), not the receiver (D-03)
  const child = new NodeImpl({ kind: 'fiber', parent: this, subscribed: true, stack: 'explicit', opts: task.opts, body: { fn: task.body, args, destination: 'join', taskName: task.name } });
  if (lender && lender !== child && child.state !== 'complete') { child.lender = lender; lender.lentTo = child; lender.emit({ type: 'node:lent', childId: child.id }); }   // D-85: a child settled at birth lends nothing
  child.startBody();                                                                          // §7.3: synchronous, with the child current
  return managedFor(child.completion, () => take(child));                                     // the freeze decision is for current(), not for `this`; take runs only when the caller is delivered (D-38): a caller frozen before the child settles consumes nothing and the failure surfaces from `this` (the child's parent) at completion
}

all(tasks, opts) {
  this.assertOpen('all'); …guards…;
  return this.call(task(async () => {
    const fibers = tasks.map((t) => fork(t.with({ onFailure: 'join' })));                     // subscribers of the fresh child (current()); members are forced to 'join' (D-51): a member's own 'link' would abort the group, a handler would bypass it
    const outcomes = await Promise.all(fibers.map((f) => result(f)));                         // ManagedPromises: cut together if the child is delivered
    const failures = outcomes.filter((o) => o.status === 'failure');
    if (failures.length) throw new AggregateError(failures.map((o) => o.error), `${failures.length} of ${tasks.length} tasks failed`);   // Q9: every real failure
    const aborted = outcomes.find((o) => o.status === 'aborted');
    if (aborted) throw new FiberAbortedError(aborted.reason, 'a task was aborted');          // D-14: the tuple cannot be completed; aborted outcomes never appear in the AggregateError
    return outcomes.map((o) => (o as { value: unknown }).value);
  }, { ...opts, name: opts?.name ?? 'all' }));
}

race(tasks, opts) {
  if (tasks.length === 0) throw new TypeError('race() needs at least one task');
  return this.call(task(async () => {
    const fibers = tasks.map((t) => fork(t.with({ onFailure: 'join' })));                     // D-51
    const first = Promise.withResolvers<unknown>();
    const outcomes = fibers.map((f) => result(f).then((o) => { if (o.status === 'success') first.resolve(o.value); return o; }));
    const settledAll = Promise.all(outcomes);
    const winner = await Promise.race([first.promise, settledAll.then(() => NO_WINNER)]);
    if (winner === NO_WINNER) { const os = await settledAll; const failures = os.filter(failure);
      if (failures.length) throw new AggregateError(failures.map(e => e.error), 'every task failed'); throw new FiberAbortedError(os[0].reason, 'every task was aborted'); }
    for (const f of fibers) if (f.state === 'running') f.abort();                            // §7.5: aborts and awaits the rest
    await settledAll;
    return winner;
  }, { ...opts, name: opts?.name ?? 'race' }));
}
```

`all`/`race` are `call`s of an inline task, so their members are
subscribers of a fiber (never a 'join' fork onto a bodiless node), their
awaits are managed for the caller, and lending applies as for any `call`.

### 4.9 Start scheduling, creation-time forks and the Q6 check

```ts
scheduleStart(): void {
  const owner = this.creationOwner();                                        // nearest ancestor-or-self with inCreation === true
  if (owner) owner.creationForks.push(this);                                 // started after placement / after the factory returns
  else runInFrame(NO_NODE, () => queueMicrotask(() => this.startBody()));    // D-46: the start microtask carries no frame; startBody installs the body's own. startBody skips if the fiber was settled meanwhile (D-13)
}
// inject.ts, end of a successful creation that owns the slot:
function refuseUnownedJoinForks(cs) {
  for (const f of cs.nodeIfCreated?.creationForks ?? [])
    if (f.subscribed && f.body!.destination === 'join' && !f.parent!.hasBody && f.parent!.kind !== 'pool')
      throw new TypeError(`fork(${f.name}) in the constructor of ${name(cs.key)} has the default 'join' destination and was not owned: write own(fork(…)) or pass onFailure`);
}
function finishCreation(cs) {                                                 // after placeAt (auto-hoisted) or immediately (declared placement)
  if (!cs.ownsSlot) return;                                                   // a SelfScope inner creation shares the outer's node; the outer finishes it
  const n = cs.nodeIfCreated; if (!n) return;
  if (cs.placement) n.moveToProvidedTail();                                   // D-100: a declared value's node follows the dependencies its factory created on S.provided (G3)
  n.inCreation = false;
  for (const f of n.creationForks) runInFrame(NO_NODE, () => queueMicrotask(() => f.startBody()));   // never synchronously: the requester's frame is still on the stack (I20); under NO_NODE (D-46)
  n.creationForks.length = 0;
}
```

Because factories are synchronous (A5), the whole
`get → factory → placement` is one job; a microtask queued during the
factory would in fact run after placement anyway. The explicit list exists
for the Q6 check and for `node:placed` to precede `node:started` in the
event stream.

### 4.10 Placement: the walk, creation, pending node

```ts
// inject.ts
export function resolveFrom<T>(R: NodeImpl, key: InjectionKey<T>): ResolveResult<T> {
  for (let C: NodeImpl | undefined = R; C; C = C.parent) {
    if (C.state === 'pending') throw new PendingNodeError(`resolution of ${name(key)} reached pending node ${describeNode(C)}: a value's node cannot resolve before placement`);
    if (C.state === 'complete') throw new NodeCompletedError(`resolution of ${name(key)} walked through completed node ${describeNode(C)}`);
    const hit = C.cache.get(key);
    if (hit) {                                                                     // is it R's answer (D-96, D-92, view), and only then is it alive (D-98)
      if (hit.scope === SelfScope && currentCreation()) return resolveScoped(R, key, SelfScope, providerFrom(C, key));            // D-96: in a creation SelfScope is per-creation, even where a boundary stored one
      if (hit.scope && R.findScopedContext(hit.scope) !== C) return resolveScoped(R, key, hit.scope, providerFrom(C, key));      // D-92: R's own owner of the scope lies on [R, C); R's value is made there
      if (hit.autoHoisted && ((hit.pinned && R !== C) || (hit.deps?.size && shadowBetween(R, C, hit.deps)))) return createAutoHoisted(R, key);   // placement by view (§8.2); a pinned value is served only at its own storage context (D-97)
      if (hit.valueNode && hit.valueNode.state === 'complete') throw new NodeCompletedError(`${name(key)} has been released`);   // I22: R's own answer was released; escape fails loudly
      markDecided(R, C, [key, ...(hit.deps ?? [])]);
      return { resolved: true, value: hit.value as T, node: C, autoHoisted: hit.autoHoisted, deps: hit.deps, created: false, pinned: hit.pinned };
    }
    const p = C.providers?.get(key);
    if (p) {
      const scope = p.scope ?? getKeyScope(key);
      if (scope) return resolveScoped(R, key, scope, p as Provider<T>);
      const r = createExplicit(C, p as Provider<T>, R); markDecided(R, C, [key]); return r;
    }
  }
  const scope = getKeyScope(key);
  if (scope) return resolveScoped(R, key, scope, undefined);
  if (hasDefaultFactory(key)) return createAutoHoisted(R, key);
  markDecided(R, R.root, [key]);                                                   // "not provided here" is a decision on the whole walk
  return { resolved: false };
}

function shadowBetween(R, S, deps): boolean {                                      // [R, S): a dep provided, or a dep's scope owned, strictly below S, R included (D-44)
  for (let C = R; C !== S; C = C.parent!) {
    if (C.providers) for (const d of deps) if (C.providers.has(d)) return true;
    if (C.scopeSet) for (const d of deps) { const σ = providerFrom(S, d)?.scope ?? getKeyScope(d); if (σ && σ !== SelfScope && C.scopeSet.has(σ)) return true; }   // a nested σ-context changes R's view of a σ-scoped dep as surely as a provider would; σ is the dep's effective scope (D-93), computed lazily
  }
  return false;
}
function markDecided(from, toInclusive, keys): void {
  for (let C: NodeImpl | undefined = from; C; C = C.parent) { for (const k of keys) C.decided.add(k); if (C === toInclusive) break; }
}

function resolveScoped<T>(R, key, scope, provider): ResolveResult<T> {
  if (scope === SelfScope) {
    const cs = currentCreation();
    if (cs) return resolveSelf(cs, key, provider);                                  // per-creation, unstored, unmarked
    // outside creation: a context with scopes: [SelfScope] is the boundary — fall through
  }
  const T = R.findScopedContext(scope);
  if (!T) {
    if (scope === SelfScope) throw new Error(`SelfScope key '${name(key)}' can only be injected during value creation or from a context with scopes: [SelfScope].`);
    throw new Error(`No context found for scope '${scope.name}' when resolving key: ${name(key)}`);
  }
  const hit = T.cache.get(key);
  if (hit) { markDecided(R, T, [key]); return { resolved: true, value: hit.value as T, node: T, autoHoisted: false, deps: undefined, created: false }; }
  if (!provider && !hasDefaultFactory(key)) { markDecided(R, T, [key]); return { resolved: false }; }
  const r = createExplicit(T, provider ?? defaultProvider(key), R);
  markDecided(R, T, [key]); return r;
}

function createAutoHoisted<T>(R, key): ResolveResult<T> {
  const cs = newCreationState({ key, requester: R, base: R, placement: undefined, tracker: new DepTracker(R.autoScopeRoot), outer: currentCreation() });
  const value = runCreation(cs, () => invokeDefaultFactory(key, resolveDependencies(key)));
  let S = cs.tracker!.deepest; if (R.autoScopeRoot.depth > S.depth) S = R.autoScopeRoot;               // D7 placement + captureAutoScoped clamp
  if (S.state === 'complete') { const err = new NodeCompletedError(`cannot place ${name(key)} on completed ${describeNode(S)}`); abandonCreation(cs, err); throw err; }   // §6.2; owned by R (D-99, D-105)
  const m = cs.nodeIfCreated && misplacedScopedProviders(cs.nodeIfCreated, S)[0];
  if (m) { const err = new PlacementError(`Cannot provide scoped key '${name(m.provider.key)}' at ${describeNode(m.node)}: it resolves to ${describeNode(m.owner)} above this context`); abandonCreation(cs, err); throw err; }   // D-108: §4.11's scope rule for nodes built under the pending node
  const existing = S.cache.get(key);
  if (existing) { abandonCreation(cs, new Error('duplicate placement')); devWarn(…); markDecided(R, S, [key, ...(existing.deps ?? [])]); return hitResult(existing, S); }   // D-21: a factory whose deps varied landed where an instance exists
  const deps = new Set(cs.tracker!.deps), pinned = cs.tracker!.pinned;                                  // pinned: D-97 (with deepest = R, so S = R)
  S.cache.set(key, { value, node: S, autoHoisted: true, deps, valueNode: cs.nodeIfCreated, scope: undefined, pinned });
  cs.nodeIfCreated?.placeAt(S);                                                                          // pending → running; onto S.provided (tail): if S is releasing, released next
  finishCreation(cs);
  markDecided(R, S, [key, ...deps]);
  return { resolved: true, value, node: S, autoHoisted: true, deps, created: true, pinned };
}

function createExplicit<T>(S, provider, R, scope): ResolveResult<T> {                                   // scope: the effective scope when called from resolveScoped (D-92), else undefined
  if (S.state === 'complete') throw new NodeCompletedError(`cannot place ${name(provider.key)} on completed ${describeNode(S)}`);
  const cs = newCreationState({ key: provider.key, requester: R, base: S, placement: S, tracker: undefined, outer: currentCreation() });
  const value = runCreation(cs, () => provider.provide());                                               // the value node, if touched, is live on S.provided from its first own(); it moves after its dependencies in finishCreation (D-100)
  const n = cs.nodeIfCreated;
  if (isComplete(S)) { const err = new NodeCompletedError(…); abandonCreation(cs, err); throw err; }    // D-94(a): the factory completed S
  if (n && (n.state !== 'running' || n.delivered)) { const err = new NodeCompletedError(`${name(provider.key)} was released during its own creation`); abandonCreation(cs, err); throw err; }   // D-102
  const existing = S.cache.get(provider.key);
  if (existing) { abandonCreation(cs, new Error('duplicate placement')); return hitResult(existing, S); }   // D-101: never overwrite an answer (I19); unreachable for a cycle, which runCreation refuses
  S.cache.set(provider.key, { value, node: S, autoHoisted: false, deps: undefined, valueNode: n, scope, pinned: false });
  finishCreation(cs);
  return { resolved: true, value, node: S, autoHoisted: false, deps: undefined, created: true, pinned: false };
}

function resolveSelf<T>(outer, key, provider): ResolveResult<T> {
  const cached = outer.selfCache.get(key);
  if (cached !== undefined) return { resolved: true, value: cached as T, node: outer.base, autoHoisted: false, deps: undefined, created: false, pinned: true };   // pinned: D-97
  if (!provider && !hasDefaultFactory(key)) return { resolved: false };                                 // D-94(c): inject() decides optional/throw
  const cs = newCreationState({ key, requester: outer.requester, base: outer.base, placement: outer.placement, tracker: undefined, outer,
                                delegate: outer });   // D-94(b): inject (ContextKey and skipSelf included) and node() go to the outer creation; slot and selfCache are the outer's — deps flow outward; entries land on the outer value's node
  const value = runCreation(cs, () => provider ? provider.provide() : invokeDefaultFactory(key, resolveDependencies(key)));
  outer.selfCache.set(key, value);
  return { resolved: true, value, node: outer.base, autoHoisted: false, deps: undefined, created: true, pinned: true };   // node = base places an auto-hoisted outer value at R; pinned keeps it there (D-97)
}

// helpers
function hitResult<T>(e: CacheEntry, S: NodeImpl): ResolvedResult<T> { return { resolved: true, value: e.value as T, node: S, autoHoisted: e.autoHoisted, deps: e.deps, created: false, pinned: e.pinned }; }
function newCreationState(init: { key; requester; base; placement; tracker; outer; slot?; ownsSlot?; resolve? }): CreationState {
  // defaults: slot = { node: undefined }; ownsSlot = true; cycleExempt = false; selfCache = new Map();
  // resolve = init.resolve ?? ((k) => resolveFrom(init.placement ?? init.requester, k));     // declared placement resolves from S, auto-hoisted from R
  // node() = slot.node ??= requester.createValueNode(name(key), placement); nodeIfCreated = slot.node
  …
}

// node-impl.ts
createValueNode(name: string, placement: NodeImpl | undefined): NodeImpl {        // `this` is the requester R
  const n = placement
    ? new NodeImpl({ kind: 'value', parent: placement, subscribed: false, stack: 'provided', opts: { name } })     // live from the start (§6.2)
    : new NodeImpl({ kind: 'value', parent: undefined, basis: this, subscribed: false, stack: 'none', opts: { name }, pending: true });   // D-42: root = R.root, so the node and everything created under it before placement (forks, pools, release fibers of an early release(x)) can emit; depth/autoScopeRoot/timeouts are provisional
  n.inCreation = true;
  return n;
}
placeAt(S: NodeImpl): void {
  if (this.state !== 'pending') throw new Error('placeAt on a non-pending node');
  S.assertOpen('place');                                                        // NodeCompletedError — createAutoHoisted checked already; defensive
  this.parent = S; this.fixTree(S);                                             // depth/autoScopeRoot/inherited timeouts for this node and every node on its stacks, recursively. `root` is unchanged — S is an ancestor-or-self of R, so S.root === this.root (asserted) and the root's receiver cache needs no reset (D-42)
  this.entryOnOwner = S.attachNode(this, 'provided');                           // the tail of S.provided; if S is releasing, the loop takes it next (§6.2)
  this.state = 'running';
  this.emit({ type: 'node:placed', storageId: S.id });
}
abandon(error: unknown, requester: NodeImpl): void {                           // a failed creation (P23) or a refused placement (D-99)
  const queued = this.creationForks.splice(0); this.inCreation = false;          // the creation is over: forks its releases make start normally
  if (this.state === 'pending') {                                                // owned by R, or the nearest open node above it: it waits for the releases, surfaces their failures, resolves them
    const host = firstUp(requester, (c) => c.state !== 'complete' && c.state !== 'pending');
    if (host) {
      for (const m of misplacedScopedProviders(this, host)) m.node.providers?.delete(m.provider.key);   // D-108: its releases never build a value at a scope owner through a refused provider
      this.placeAt(host);
    } else this.state = 'running';                                               // no open node left (the factory completed the tree): released unowned
  }
  if (this.state === 'running') this.abortInternal(error);                       // one two-pass delivery (I9), then both stacks; unlinked from its owner's stack by its completion
  outsideFrames(() => { for (const f of queued) queueMicrotask(() => f.startBody()); });   // as finishCreation does; the loop above settled those it reached (D-13)
}
moveToProvidedTail(): void { const e = this.entryOnOwner; if (e?.state === 'live') e.stack.moveToTail(e); }   // D-100
```

Pending-node operation table (state `'pending'`, enforced by
`assertNotPending(op)` → `PendingNodeError`):

| Allowed | Refused |
|---|---|
| `own`, `release`, `releaseAll`, `fork` (recorded on `creationForks`), `pool`, `child`, reading `id`/`name`/`state`/`scopes`/`signal` | `get`, `addProvider`, `call`, `all`, `race`, `join`, `result`, `interrupted`, `never`, `managed`, `run`, `runSync`, `abort`, `close`, `[Symbol.dispose]`, `[Symbol.asyncDispose]` |

### 4.11 `addProvider` and construction-time providers

```ts
export function assertProviderPlacement(C: NodeImpl, p: Provider<unknown>, atConstruction: boolean): void {
  if (!atConstruction && C.decided.has(p.key))
    throw new PlacementError(`Cannot provide '${name(p.key)}' at ${describeNode(C)}: the key has already been decided here. Providers must be registered before any resolution of the key through this context.`);
  const scope = p.scope ?? getKeyScope(p.key);
  if (scope && scope !== SelfScope) {
    const T = C.findScopedContext(scope);
    if (T !== undefined && T !== C)
      throw new PlacementError(`Cannot provide scoped key '${name(p.key)}' at ${describeNode(C)}: it resolves to ${describeNode(T)} above this context`);
  }
}
addProvider(p) { this.assertOpen('addProvider'); this.assertNotPending('addProvider'); assertProviderPlacement(this, p, false); (this.providers ??= new Map()).set(p.key, p); }
```

A fresh child's `providers` are checked with `atConstruction = true`
(scope rule only; it has no decisions yet). Under a pending value node the
owner walk stops at that node, which has no parent yet, so the scope rule is
checked again when the node is placed: `misplacedScopedProviders(n, S)`
walks `n`'s subtree (the node entries on its stacks, recursively) and
looks for each scoped provider's owner from the node up to `n`, then on from
`S` (D-108).

### 4.12 Pool fork with concurrency

```ts
export function poolFork(pool: NodeImpl, task: TaskLike, args: unknown[]): NodeImpl {
  const st = pool.pool!;
  if (pool.delivered || pool.closeRequested) throw new PoolClosedError(`pool ${describeNode(pool)} is closed`);   // D-16: intake stops at the signal
  const full = st.opts.concurrency !== undefined && st.running >= st.opts.concurrency;
  if (full && (st.opts.whenFull ?? 'wait') === 'reject') throw new PoolFullError(`pool ${describeNode(pool)} is full (${st.opts.concurrency})`);
  const child = new NodeImpl({ kind: 'fiber', parent: pool, subscribed: true, stack: 'explicit', opts: task.opts, body: { fn: task.body, args, destination: st.opts.onFailure, taskName: task.name } });
  child.pooled = true;                                                     // D-47: the only nodes poolChildComplete accounts for
  if (full) st.waiting.push(child);                                        // created, attached, not started; counts in `pending`
  else { st.running++; child.scheduleStart(); }
  return child;
}
export function poolChildComplete(pool: NodeImpl, child: NodeImpl): void {   // called from finishCompletion only for `pooled` fibers (D-47): admitted ones, since a waiter is unpooled when it settles (D-81)
  const st = pool.pool!;
  st.running--;
  if (pool.delivered) return;                                              // D-47: an aborted pool starts nothing more — its loop settles each waiter `aborted` without running it (D-13). A pool under close() still drains its queue: natural completion includes queued work (Q7)
  while (st.waiting.length && (st.opts.concurrency === undefined || st.running < st.opts.concurrency)) {
    const next = st.waiting.shift()!;                                      // never settled: a settled waiter already left (D-81)
    st.running++; next.scheduleStart();
  }
}
// D-81: poolChildSettled(pool, child) — from onBodyExit on an 'unstarted' settle: splice the waiter out of `waiting`, pooled = false.
// D-81: poolDelivered(pool) — from fire() 2b after the pool's own exit: abort every waiter still queued (newest first), settling it 'unstarted'.
```

`pool.running` / `pool.pending` read `st.running` / `st.waiting.length`;
only `pooled` fibers move them — a release node under the pool, a passive
`pool.own(x)` entry or a DI value placed on the pool never does (D-47).
A pool's forks are its subscribers; the pool itself is an unsubscribed
explicit entry of its owner, so its forks are delivered when the owner's
loop reaches the pool (I4). `pool.fork` never lends.

### 4.13 `get`, `own`, `run`, `runSync`

```ts
get(key, options) {
  this.assertOpen('get'); this.assertNotPending('get'); this.assertNotCreating('get'); this.assertNotLent('get');
  if (key === ContextKey) throw new CreationViolationError('ContextKey can only be injected during creation; use current() at runtime');
  if (options?.skipSelf) {
    if (!this.parent) { if (options.optional) return undefined; throw new Error(`Cannot skipSelf for key '${name(key)}': no parent context exists.`); }
    const r = resolveFrom(this.parent, key);                               // D-48: the internal walk, not parent.get(): a lent or creating parent is not this node's concern (the decorator pattern runs inside a call)
    if (r.resolved) return r.value; if (options.optional) return undefined; throw new Error(`No provider found for key: ${name(key)}`);
  }
  const r = resolveFrom(this, key);
  if (r.resolved) { if (r.created && this.kind === 'value' && dev) warnOnce(this.root, key, `${name(key)} was created by a late read on ${describeNode(this)}; declare it with inject() in the constructor`);   // Q4
                    return r.value; }
  if (options?.optional) return undefined;
  throw new Error(`No provider found for key: ${name(key)}`);
}

own(target, release?) {
  this.assertOpen('own');                                                  // C3; pending allowed; delivered allowed (C2); lent allowed (§7.11)
  if (isNodeImpl(target)) {                                                // the first overload with a node: brand check (§3.1)
    if (release !== undefined) throw new TypeError('own(node, release): a node releases itself');
    if (target.parent !== this || !target.entryOnOwner || target.entryOnOwner.stack !== this.explicit) throw new NotOwnedError(`${describeNode(target)} is not on the explicit stack of ${describeNode(this)}`);   // Q14: no transfer
    if (!target.subscribed) throw new AlreadyOwnedError(`${describeNode(target)} is already owned`);
    target.subscribed = false; this.subscribers.delete(target);            // its stack entry stays where it is
    return target;
  }
  if (typeof target !== 'object' && typeof target !== 'function') throw new TypeError('own(): attached values must be objects');
  const present = this.explicit.find(target);
  if (present) {
    if (release === undefined) return target;                              // D-37 (§6.7 line 2): ONE argument on an object this node already owns is a no-op by identity — `own(await pool.acquire())` after acquire attached the lease to current()
    throw new AlreadyOwnedError(`${describe(target)} is already owned by ${describeNode(this)}: own(x, release) would register a second release`);   // C8
  }
  const dispose = toDispose(target, release);                              // TypeError if nothing applies (C1: synchronous)
  this.explicit.push({ target, name: nameOf(target), node: undefined, dispose, state: 'live', done: undefined, failure: undefined, early: false });
  this.emit({ type: 'entry:registered', entryName: nameOf(target), stack: 'explicit' });
  return target;
}

get scopes(): ReadonlySet<Scope> { return this.scopeSet ?? EMPTY_SCOPES; }   // D-56: EMPTY_SCOPES is one shared frozen-by-convention `ReadonlySet`; scopeSet is written once in the constructor and never mutated afterwards, so exposing it under the ReadonlySet type is safe; a Set wrapper is the fallback if a consumer is caught casting

run(fn) { this.assertOpen('run'); this.assertNotPending('run'); this.assertNotCreating('run'); this.assertNotLent('run');
          const r = runInFrame({ node: this, creation: undefined }, fn);
          if (dev && isPromise(r)) throw new AsyncRunError('run(fn) returned a promise: the node is current only for the synchronous part of fn; use call(fn) for async work');   // Q8
          return r; }
runSync(fn, ...args) { this.assertOpen('runSync'); …same guards…; const c = this.child({ name: 'runSync' }); try { return c.run(() => fn(...args)); } finally { c.abort(); } }   // sync `finally` is fine; abort releases synchronously when every entry is synchronous
```

### 4.14 Events

`emit(e)` = `const r = this.root.receiver === null ? (this.root.receiver = resolveReceiver(this.root)) : this.root.receiver; if (typeof r === 'function') r({ ...e, seq: ++seq, id: this.id, kind: e.type.startsWith('entry:') ? 'entry' : this.kind, parentId: this.parent?.id ?? null });`.
`resolveReceiver(root)` sets `root.receiver = 'resolving'` first (events
emitted while the receiver's own provider runs are dropped), runs the raw
`resolveFrom(root, NodeTopic)` (not `get`, so it works inside a creation
frame and on a lent root), and stores the function or `undefined`. A
receiver must therefore be present in the root's construction-time
providers (as today). `this.root` is always a live tree root: a pending
value node is born with the requester's `root` (D-42), so `resolveFrom`
never starts from a pending node and the first `own()`/`fork()`/
`current()` in a default factory emits like any other node (`node:created`
with `stack: 'none'`, then `entry:registered`, then `node:placed`). A
receiver runs synchronously in whatever frame emitted; it is a sink and
must not call ambient operations (D-45).

---

## 5. Error types and exactly when each is thrown

| Error | Thrown by | Exact condition | Message (word tests may match) |
|---|---|---|---|
| `NoCurrentNodeError` | every free function in `ambient.ts`; `runInFrame` | no frame is current; or no storage is registered | `… no current node …` / `… import 'ramme/node' …` (the second when `hasStorage()` is false) |
| `NodeCompletedError` | every method on a node except the lifecycle quartet (`abort`, `close`, `[Symbol.dispose]`, `[Symbol.asyncDispose]`, which are idempotent no-ops); `attachNode`; `createAutoHoisted`/`createExplicit` (placement into a complete S, §6.2); `resolveFrom` (a cache hit whose value node is complete; a walk through a complete node) | `state === 'complete'` (I7) | `… completed …` / `… has been released` |
| `PendingNodeError` | `get`, `addProvider`, `call`, `all`, `race`, `join`, `result`, `interrupted`, `never`, `managed`, `run`, `runSync`, `abort`, `close`, both `Symbol` methods on a value node before placement; `resolveFrom` when the walk reaches a pending node | `state === 'pending'` | `… pending node …` |
| `NotOwnedError` | `release(x)` when `x` is not on this node's explicit stack (including already released); `own(node)` when the node is not this node's explicit entry | identity miss | `… is not owned by …` |
| `AlreadyOwnedError` | `own(x, release)` for an object already live on this node's explicit stack (C8, D-37: a second release); `own(node)` on an already-unsubscribed node. `own(x)` with one argument on such an object returns `x` (§6.7) | a second release for one object | `… already owned …` |
| `UnawaitedCallError` | `assertNotLent` at the public entry of `get`, `call`, `fork`, `child`, `pool`, `all`, `race`, `join`, `result`, `interrupted`, `never`, `managed`, `run`, `runSync` | `lentTo !== undefined` (§7.11) | `` `${op}() on ${node} while it is lent to ${child}: the call was not awaited (two concurrent calls on one node? use all())` ``; `.child` is the call fiber |
| `FiberNotAwaitableError` | the `then` getter on a `kind: 'fiber'` node; `startBody` when a body returns a fiber (D-49) | `await fiber`, `Promise.resolve(fiber)`, `Promise.all([fiber])`; a sync or async body whose return value is a fiber settles `failure` with it | `Fibers are not awaitable; use join(f) or result(f)` / `… returned a fiber …` |
| `FiberAbortedError` | `take()` — i.e. `join`, `call`, `[Symbol.asyncDispose]` on a fiber, `all`/`race` groups | the awaited fiber's outcome is `aborted` and the awaiter is not frozen (no current node, observe node, release node) | `fiber … was aborted`; `.reason` is the abort reason |
| `PoolClosedError` | `poolFork` | the pool is delivered or `close()` was requested (and not yet complete; complete → `NodeCompletedError`) | `pool … is closed` |
| `PoolFullError` (D-01) | `poolFork` | `concurrency` reached and `whenFull: 'reject'` | `pool … is full (n)` |
| `CreationViolationError` | `lookup` (free) and `get`/`call`/`run`/`runSync`/`all`/`race`/`join`/`result`/`interrupted`/`never`/`managed` (free or method) while a creation frame is current (§8.1, §8.3); `inject` outside a creation frame; `get(ContextKey)`/`lookup(ContextKey)` | see each | `lookup() during creation; use inject()` / `inject() outside creation` / `ContextKey can only be injected …` / `` `${op}() during creation` `` |
| `FactoryReturnedUndefinedError` (D-01; `extends CreationViolationError`) | `runCreation` | a factory, constructor result, `provide()` or default factory returned `undefined` (§8.3) | `Provider for X returned undefined` (kept) |
| `AsyncRunError` | `run(fn)` in dev | `fn` returned a thenable (Q8) | `run(fn) returned a promise …` |
| `PlacementError` | `addProvider`; `child({ providers })`/`createRootContext({ providers })` (scope rule only); `createAutoHoisted` at placement, for a provider on a node built under the pending value node (D-108) | key decided at this context (§8.2); provider for a scoped key below the scope owner | `… already been decided …` / `… resolves to … above this context` |
| `TypeError` (platform) | `fork` with default `'join'` onto a live bodiless non-pool node (Q6); end of creation for an unowned `'join'` fork in a constructor; `own()` of a non-object or of a value with no dispose protocol; `own(node, release)`; `race([])`; `pool(opts)` with a non-function `onFailure`; `[Symbol.dispose]()` on a root; calling a `Task` as a function | programming errors at the call site | as given in §4 |
| `OwnerInterrupt` (D-01) | never thrown; it is the **abort reason** ramme produces when a parent's body exits under `childrenOnExit: 'interrupt'` and when an unsubscribed entry is released at its turn by an owner that was not itself aborted | — | `` `${owner} is exiting` ``; `.owner` |
| `Error` (plain, messages kept from today) | resolution | `No provider found for key: X`; `No provider found for X` (inject); `Circular dependency detected: A → B → A` (also `… re-enters the creation of X in progress …` and `… re-enters the failed creation of X …`, D-105, D-106); `No context found for scope 'σ' when resolving key: X`; `SelfScope key 'X' can only be injected during value creation or from a context with scopes: [SelfScope].`; `Cannot skipSelf for key 'X': no parent context exists.` | kept verbatim so ported regexes hold |
| `AggregateError` | `all` (every real failure, Q9); `race` (no winner); `finishCompletion` (two or more release/unconsumed errors); `releaseAll` | — | — |
| `SuppressedError` (via `SuppressedErrorCtor`) | `finishCompletion` | body `failure` + release/unconsumed errors (Q2: release-primary): `new SuppressedErrorCtor(releaseAggregate, bodyError)` | — |

Order of guards at a method entry: `assertOpen` (complete) →
`assertNotPending` → `assertNotCreating` → `assertNotLent`. Guards never
run inside internal paths (`resolveFrom`'s walk, the release loop,
`attachNode` from `placeAt`).

---

## 6. Test plan

Conventions: every test file imports `./node.js` (law 3) and
`./test/util.ts`, with one deliberate exception: `src/storage.test.ts`
omits the adapter so it can exercise the no-storage path (`isolate: true`
and `pool: 'forks'` keep that file's module state its own; there is no
unregister API, D-57). The vitest setup file installs a
`process.on('unhandledRejection')` hook that fails the current file (I10).
Tests reach internals (`explicit.size`, `decided`, `cache`, `state`) by
casting to `NodeImpl`; they never rely on timing beyond `tick()`.

`src/test/util.ts` exports: `tick(n = 1)` (await `n` macrotasks),
`micro()` (one microtask), `deferred<T>()` (`Promise.withResolvers`),
`settled(p)` (probe: resolves `'pending' | 'fulfilled' | 'rejected'` after
one tick), `trace()` (an ordered recorder returning `push(name)`),
`events(root)` (collects `NodeEvent`s from a root created with a
`NodeTopic` provider), `withRoot(opts, fn)` (`createRootContext`, run `fn`
inside `root.call`, close), `impl(ctx)` (cast to `NodeImpl`), `isFiber(x)`,
`gcUntil(pred)` (repeat `globalThis.gc()` + tick; skips when `gc` is
absent), `neverSettles(p)` (asserts `settled(p) === 'pending'` after two
ticks).

### 6.1 New test files and the scenarios each covers

**`src/stack.test.ts`** — push/find/unlink identity; LIFO `topPending`;
a push during iteration becomes the next `topPending`; `'releasing'`
entries are returned by `topPending` (the loop waits on them);
`AlreadyOwnedError` on a duplicate target; after `unlink` nothing is
retained (`size` 0, `find` misses) — the P1 data-structure half — and,
because `find` skips a `'released'` entry (D-62) and so cannot show the
identity index, a GC check (`it.skipIf(!hasGc)`) that released targets,
their entries and their disposes are collected while the stack lives,
including both D-65 re-push orders; `unlink` of an entry that belongs to
another stack and is not its head changes neither stack.

**`src/storage.test.ts`** (the one file without `./node.js`; D-57) —
without any adapter, `runInFrame` and `current()` throw
`NoCurrentNodeError` whose message contains `ramme/node`; then, after a
dynamic `import('./node.js')` in the same file, a frame survives `await`
and `setTimeout`; nested `run` restores the outer frame on return and on
throw; `currentCreation()` is visible only synchronously inside the
creation frame; `runInFrame(NO_NODE, fn)` makes `currentFrame()`
`undefined` inside `fn` even when an outer frame exists, and a
`queueMicrotask` issued there carries no frame (D-46).

**`src/managed.test.ts`** — against a fake `FreezeTarget`: (1) with no
current node the source is returned untouched; (2) `then` on an applied
target calls `markFrozen` once and the returned promise never settles;
(3) a `ManagedPromise` that is never awaited registers nothing in
`onApplied`; (4) `await`ing arms the cut; applying the target cuts the
await (never settles, `markFrozen` called once) even though the source
settles later; (5) a source that settles before application settles the
await and removes the cut from `onApplied`; (6) `Promise.all` over two
wrappers arms both and both are cut together; (7) `never` (source
`undefined`) drops its callbacks at `then` time; (8) observe targets get
an untargeted wrapper that still delivers only in `then`; (9)
`.catch`/`.finally` go through the override; (10) `deliver` is not run
when the wrapper is cut, nor when it is never awaited, and runs once per
`then` (D-38); (11) a `deliver` that throws rejects the derived promise,
and a second `then` runs it again (D-50); (12) after a cut, the cells are
empty: a `WeakRef` to the continuation callbacks is collected under
`gcUntil` while the source is still pending; (13) with no target, a source
that settles before `then` is called delivers at `then` time, not before;
(14) a wrapper over a never-rejecting source whose `deliver` throws, never
awaited, produces no `unhandledRejection` (the setup hook). Added by
D-66–D-68: (2) counts `markFrozen` one microtask after `then`, under no
frame, and a `.catch` the body attaches after delivery runs no freeze inside
its synchronous code; (7) `managedSignal` is cut-only with the target's one
shared cut for a freeze awaiter (100 raced iterations leave one `onApplied`
entry) and resolves with the source for an observe body, a release fiber
and top level, and the shared cut is per target (another target's delivery
leaves the first one's count alone); (6) "unsupported (D-67)" pins
`Promise.allSettled` and a `result()` member consuming a failure the frozen
body never reads, a non-awaited `.catch` arming the cut, and a wrapper
awaited by another body, with the dev warning reported once per creating
node and never for the creator, a bodiless node, top level, `NO_NODE` or a
production build.

**`src/freeze-gc.test.ts`** (skipped when `globalThis.gc` is missing) —
a body that holds a 1e6-element array in a closure and awaits
`managed(p)` is aborted, `p` settles later, the owner completes; a
`FinalizationRegistry` on the array fires after `gcUntil`. Same for a body
frozen on `never()`, on `join(f)` of a foreign fiber **that is still
running when `gc` runs** (property 4: the cut empties the cell while the
source is pending), on `call(slow)` whose child is still running, and one
that was frozen at `then` time (requested after delivery). Fails if any
node field, listener or source reaction retains the continuation.

**`src/node-core.test.ts`** —
*anatomy*: ids unique across kinds; `state` transitions
`running → settling → releasing → complete`; `scopes` read-only;
`child()` is a subscribed explicit entry; `pool()` is unsubscribed.
*delivery*: `abort` marks the whole subscribed subtree before any listener
(a listener on child A forks a freeze fiber under sibling B → born
delivered; `B.abort()` from A's listener emits no second
`node:delivered`); observe forwards only to restore (a restore grandchild
under freeze under observe is delivered; the freeze in between is not);
own-signal sources deliver an observe node; `timeoutMs` delivers a
`TimeoutError` reason; `opts.signal` delivers and the listener is removed
at completion; birth rule for all nine (parent mode × child mode) cases
under a delivered parent.
*freeze*: a freeze body suspended on `join(f)` when aborted never resumes,
its `finally` never runs, and the owner's release starts in the same tick
(a `trace` push in the release sees the body's `after` push absent);
plain code between delivery and the next managed await runs and its
`own()` is released; a body holding an unawaited managed promise while in
a bare await is *not* frozen at delivery and freezes when it awaits it;
after delivery, `p.catch(noop)` on a stored `join(f)` followed by an
`own()` and a managed await disposes nothing before the body suspends
(D-68); the D-67 shapes with a real node: `Promise.allSettled([join(f1),
join(f2)])` with `f1` failed and the owner aborted while `f2` runs pins
that `f1`'s failure is in no outcome (the accepted loss), a non-awaited
`.catch` before delivery followed by a bare await gets the D-64 warning,
and a wrapper awaited by another body gets the D-68 warning;
observe body settles its managed awaits and finishes on its own.
*release loop*: explicit LIFO then provided LIFO; a release that
`own()`s onto the owner is released next; an `own(tmp)` on the owner from a
continuation in the microtask drain that follows its last async release is
either released before `node:complete` or throws `NodeCompletedError`, and
never stays live on a complete node (D-69); a release fiber's `lookup` that
creates a value during the provided phase is released before older
provided values; a value created during the explicit phase is released at
the top of the provided phase (I3); sync-only, async-only and mixed stacks
settle in order; synchronous releases complete synchronously inside
`abort()` (runSync observation), **including a tree of nested `child()`
and fiber entries whose subtrees complete synchronously** (D-25: a node
entry returns `undefined` from its action when the child is already
complete); `releaseAll()` racing `release(x)` on the same entry runs that
release once and both promises settle (D-36); `abort()` arriving in the
middle of a `releaseAll()` runs every release once (counted disposes, one
`entry:released` each); a release callback that synchronously calls
`owner.abort()` does not throw and the owner completes (e.done exists
before the dispose runs).
*release fiber*: inside `own(x, release)`, `own({[Symbol.asyncDispose]})`
and `own(fn)` releases, `current().kind === 'release'`,
`current().parent === owner` (via lookup of an owner provider),
`signal()` is a fresh signal that fires after `releaseTimeoutMs`,
`owner.outcome` is defined; something `own`ed inside a release is released
before `entry:released` of the outer entry.
*contracts*: C1–C8 one test each.
*lifecycle table* (§5.5): `abort` signals and returns; `close` on a
bodiless node settles success and closes subscribed children recursively
(Q7) and aborts unsubscribed ones; `close` on a fiber waits for the body
without a signal, and a later `abort` wins; `[Symbol.dispose]` throws on a
root and aborts elsewhere; `[Symbol.asyncDispose]` twice shares one
release per entry; `await using` runs releases.
*use-after-release table* (§5.4) and *run/runSync*: `run` restores the
frame on throw; a returned promise → `AsyncRunError`; `runSync` =
child + run + abort with synchronous release observation; `runSync` with a
throwing fn still releases.
*unstarted fibers*: `abort()` before the start microtask settles
`aborted` and the body never runs; a fiber forked under an
already-delivered freeze parent runs until its first managed await.
*stall*: `node:stalled` emitted after `stallWarningMs` (fake timers) for
a delivered freeze body that never reaches a managed await and for a slow
release.

**`src/outcome.test.ts`** — §7.6/§9: delivered freeze body returning →
`aborted`; throwing → `aborted`; observe delivered → body's own result;
restore delivered → `aborted`; bodiless `close` → `success`, `abort` →
`aborted`; delivery after settling leaves the outcome; body `failure` +
release failure → `SuppressedError` whose `.error` is the release error
and `.suppressed` the body error; body `success` + two release failures →
`failure` with an `AggregateError`; `aborted` + release failure →
`failure`; unconsumed `'join'` failure surfaces once from the parent's
`close()`; a joined failure does not surface from the parent and leaves
`parent.unconsumed` empty; `'link'` aborts the parent at settle and
surfaces at completion; a handler is called once with the final failure
(including a release failure after a successful body) and **`current()`
inside the handler is the parent** (D-45); an owned fiber's failure aborts
the owner (C5) and surfaces; an `aborted` fiber fires no destination
(I12); a handler that throws is recorded on the parent.
*frozen awaiter* (D-38, D-40, D-41): an owner frozen on `join(f)` while
owned `f` fails → the owner's outcome is `failure`, the error surfaces
from the owner's `close()`/parent exactly once, and `f.failure.consumed`
is true afterwards; a parent frozen on `call(observeChild)` whose child
fails after the parent was delivered → surfaces from the parent; a request
fiber `Y` aborted while awaiting `app.call(work)` where `work` (observe)
later fails → surfaces from `app.close()`; `join(f)` stored and awaited
after a timer → no `unhandledRejection`, the failure is delivered at the
late `await` and `parent.unconsumed` is empty afterwards; `result(f)` and
`join(f)` whose returned promise is never awaited → the failure surfaces
from the parent; `release(x)` whose release throws while the caller is
frozen → the error surfaces from the owner's completion, while a delivered
caller receives it and the owner does not; a `child()` whose entry release
fails → surfaces from the parent's `close()` unless `child.close()` was
awaited first; a pool whose passive entry's release fails → same; a
second `join(f)` / `[Symbol.asyncDispose]()` on a failed fiber rejects
again with the same error (D-50).
*I13 converse*: an undelivered body that throws
`new DOMException('x', 'AbortError')` or a `FiberAbortedError` has outcome
`failure` with that error; a delivered `observe` body that throws has
outcome `failure` with its own error; a delivered `freeze` body that
returns normally has outcome `aborted`.

**`src/lending.test.ts`** — `Promise.all([call(a), call(b)])` throws
`UnawaitedCallError` on the second call naming `a`'s fiber and `all`;
every listed body-shaped method throws while lent and `own`/`release`/
`abort`/`close`/`[Symbol.asyncDispose]` do not; `lentTo` is cleared before
the awaiting body resumes and when the child fails or is aborted; nested
`call` lends only the inner node; `otherCtx.call(fn)` from a body lends
the body's node (the awaiting one), not `otherCtx`; top-level
`await app.call(main)` lends nothing, so `app.fork(...)` from a platform
callback during it works (§6.7 line 4); a `call` from a release fiber
lends the release fiber; `lookup(K, { skipSelf: true })` inside a
`call()`ed body resolves from the lent parent without
`UnawaitedCallError` (D-48); a lender that completes before its
`otherCtx.call(...)` child leaves `child.lender` undefined (D-53).

**`src/creation.test.ts`** — a value that attaches nothing gets no node
(no `node:created` for it); the first `own`/`current()`/`inject(ContextKey)`/
`fork`/`pool`/`child` creates it, `state === 'pending'`, `parent` unset,
`root === requester.root`; under a root with a `NodeTopic` receiver a
default factory that calls `own()`, `fork()`, `current()` and an early
`release(x)` emits `node:created` (`stack: 'none'`) → `entry:registered`
→ … → `node:placed` and throws no `PendingNodeError` (D-42);
`get`/`call`/`run`/`abort`/`close` on it → `PendingNodeError`; after
resolution `parent === S` and `state === 'running'`; declared placement
is live from the first touch (`parent === S` inside the constructor);
`inject(ContextKey) === current()` and reading it does not move placement
(a value that reads only `ContextKey` lands at `autoScopeRoot`);
`lookup`/`get`/`call`/`run`/`all`/`race` in a factory →
`CreationViolationError`; `inject` outside creation →
`CreationViolationError`; `inject` inside a forked body (runtime) →
`CreationViolationError` and `lookup` works (P5); a factory returning
`undefined` → `FactoryReturnedUndefinedError` (`instanceof
CreationViolationError`); a factory that `own()`s then throws releases the
entry, caches nothing, rethrows the factory's error (P23); `fork` in a
constructor does not run before the factory returns, starts after
placement with the value node as parent, and `lookup` inside it works
(P22); an unowned `'join'` fork in a constructor fails the resolution with
a `TypeError` and the pending node is released; `own(fork(...))` and
`fork(task(..., { onFailure }))` in a constructor are accepted; a
SelfScope value's `own()` lands on the outer value's node; placement
into a releasing S is released next (before S's older provided values);
placement into a complete S → `NodeCompletedError` and nothing is cached;
circular dependencies are detected through nested creation frames with the
`A → B → A` message; `skipSelf` inside creation does not trip the cycle
check (decorator pattern).

**`src/placement-view.test.ts`** — the §8.2 traces: `A@P`, `A@C`, `B`
injects `A`: order C-then-P and order P-then-C both end with `B@C` and
`B@P` built from the respective `A`; sibling `C2` without the override
shares `B@P`; transitive `D` (injects `B`) resolved from `C` after `D@P`
re-creates `D@C` and `B@C`; a property-style test runs every permutation
of `[C.get(B), P.get(B), C2.get(B), C.get(D)]` and asserts identical
final `cache` contents per node. Decided markers: `addProvider(K)` at any
context on `R..S` after `R` resolved `K` → `PlacementError`; above `S` and
on a fresh child → allowed; `addProvider` of a dep of an auto-hoisted hit
→ `PlacementError`; negative decision: `get(K, {optional:true})` miss then
`addProvider(K)` at the root → `PlacementError`; scoped provider below the
scope owner → `PlacementError` (at `addProvider` and at `child({providers})`);
optional miss in `deps(V)` (D-43): `V` injects `K` with
`{ optional: true }`, `K` absent, `V` lands at the root; a fresh child
provides `K`; `child.get(V)` rebuilds `V` with `K` injected and
`root.get(V)` still serves the root instance; scope shadow (D-44): `V`
injects σ-scoped `D` (default factory) resolved at σ-context `T`; a
nested σ-context `C` under `T`'s subtree requests `V` and gets one built
from `C`'s own `D`;
P7 (`child` provides `Database`, `child.get(UserRepo)`, then
`root.addProvider(UserRepo)` allowed and `root.get(UserRepo)` builds a
distinct root instance when `Database` has a default; `'No provider'` only
when it has none); P20 shadowed explicit key (a child providing `A` after
an ancestor cached auto-hoisted `V` with `A ∈ deps(V)` gets `V` rebuilt
by its view); P21 lazy registration order (a fiber forked before `Pool`
exists; the fiber's `lookup(Pool)` creates it on the provided stack of
the deepest dep; the pool is released after the fiber — G1 — and provided
LIFO follows creation order regardless of request order); `captureAutoScoped`
clamps placement and gives each captured child a fresh instance; a stale
provided value (its node complete) → `NodeCompletedError` on hit (I22).

**`src/di.test.ts`** — the ported `context.test.ts` suites (§6.2 below).

**`src/fiber.test.ts`** (rewritten) — `task()`: not callable
(`TypeError`), `name` defaults, `with()` merges options and name,
`bind()` partially applies; `fork` never runs any part of the body
synchronously and the body sees its own node current from its first line
(I20); `call` starts synchronously with the child current and returns the
value; a body cannot tell fork from call (same `current()` shape);
destinations: `'join'` held and surfaced, `'link'` aborts parent, handler
once; Q6 synchronous refusal on `root.fork(t)` and `child().fork(t)` with
the default destination, accepted with `onFailure`; `join` throws the
failure / `FiberAbortedError` for aborted when awaited from an observe
body; `result` never rejects; `await fiber` rejects with
`FiberNotAwaitableError`, `Promise.all([fiber])` too; `all` returns the
tuple in order, aggregates every real failure, excludes aborted members
from the `AggregateError`, rejects `FiberAbortedError` when a member was
aborted and none failed, `all([])` → `[]`; `race` resolves the first
success, aborts and awaits the rest, aggregates when all fail, `race([])`
→ `TypeError`; `interrupted()` resolves with the reason in an observe
body; `never()` freezes a freeze body and is cut at delivery;
`managed(p)` freezes; `timeoutMs` delivers `TimeoutError`; `{ signal }`
pre-aborted settles the fiber `aborted` without running; top-level
`await app.call(main)` + `app.abort()` rejects with `FiberAbortedError`
and the `await using` block completes (§4.3); `call` consumes the
failure even when the task has a handler; a sync body that returns a
fiber (`() => fork(t)`) and an async one (`async () => fork(t)`) both
settle `failure` with `FiberNotAwaitableError` and nothing escapes the
start microtask (D-49); `all`/`race` members declared with
`onFailure: 'link'` or a handler are run as `'join'` members and the
`AggregateError` arrives (D-51); `Promise.all([call(a), call(b)])` leaves
no unhandled rejection after the second call throws (D-38).

**`src/ambient.test.ts`** — each free function acts on `current()`
(I21); `current()`/`signal()` inside `fork`, `call`, `child().run`,
releases; the `NoCurrentNodeError` message with storage (the no-storage
message is `storage.test.ts`'s, D-57); `runSync` free function; `lookup`
optional/skipSelf passthrough; `own(x)` twice with one argument returns
`x` both times and registers one entry, `own(x, release)` on an owned `x`
→ `AlreadyOwnedError` (D-37).

**`src/pool.test.ts`** — `pool(opts)` validates `onFailure`; forks are
subscribers of the pool; destination is always `onFailure`;
`concurrency` with `'wait'` queues (`running`/`pending` counters move as
fibers complete) and with `'reject'` throws `PoolFullError`; a waiting
fiber cancelled by the owner's release never runs; `pool.close()` drains
the queue (waiters start as slots free, `running`/`pending` end at 0)
while `pool.abort()` cancels it (D-47); a passive `pool.own(x)` entry and a
DI value placed on the pool leave `running`/`pending` untouched when
released (D-47); `PoolClosedError` after `pool.abort()`/`pool.close()`;
`NodeCompletedError` after completion; the owner's completion waits for
the pool; the pool hears the signal at its turn (after explicit entries
above it); the ported `fiber-set` scenarios.

**`src/probes.test.ts`** — one named test per probe:
- **P1 resource-list leak**: 10 000 `own(obj)`+`release(obj)` cycles and
  10 000 `fork`+`join` cycles leave `explicit.size === 0` and
  `find` misses; completed fibers are unlinked; 10 000 **failing**
  `fork`+`join` cycles under one long-lived root leave
  `unconsumed.size === 0` and `subscribers.size === 0` (the record leaves
  the set at delivery, D-40); 1 000 `fork`+`result` cycles of failing
  fibers likewise; a completed fiber's `body` is `undefined` (D-53).
- **P2 double dispose**: `asyncDispose()` ×2, `close()`, `abort()` on one
  node → each entry released once; the same `completion`; `node:complete`
  once.
- **P3 admission after dispose**: `get`, `own`, `release`, `fork`, `call`,
  `child`, `pool`, `addProvider`, `run`, `join` on a complete node →
  `NodeCompletedError`; the quartet is a no-op.
- **P4 call not awaited by parent dispose**: a body drops `call(slow)`'s
  promise; the parent's `close()` still awaits the child; the next
  body-shaped operation in the body throws `UnawaitedCallError` naming the
  child.
- **P5 creation context leak into a spawned body**: a constructor forks;
  inside the body `currentCreation()` is undefined, `inject()` throws
  `CreationViolationError`, `lookup()` works, `current()` is the fiber, and
  the body did not start before the factory returned.
- **P7 order-dependent override / 'No provider' at root**: both orders of
  `child.get(UserRepo)` / `root.get(UserRepo)` converge; no `'No provider'`
  when `Database` has a default; `PlacementError` never depends on sibling
  activity.
- **P19 enterSync bleed**: after `ctx.run(fn)` returns (or throws) no node
  is current; there is no sync stack: `current()` at top level throws even
  after a `run`; a frame does not leak across `await` out of `run`.
- **P20 shadowed explicit key**: as in `placement-view.test.ts`, asserted
  on the instance identity of the dependency inside the rebuilt value.
- **P21 lazy registration order**: as above, asserted on the release
  trace (`fiber`, then `pool`).
- **P22 constructor-spawned fiber parented to requester**: a request
  fiber resolves an auto-hoisted value whose constructor forks; the fiber's
  parent is the value's node at the storage context, it starts after
  placement, and it outlives the request fiber's completion.
- **P23 failed factory leaks resources**: `own()` in a throwing factory is
  released, no stack holds anything, nothing is cached, the error
  rethrows, and the next `get` runs the factory again.
- **P6, P8–P18**: not inferable from PROPOSAL.md. They are `it.todo('P<n>:
  author to supply')` placeholders; the candidate scenarios below are
  implemented under `invariants.test.ts` and can be renumbered by the
  author: interrupt reaches the whole subtree in one tick (G4); G1
  provided values outlive explicit entries; G2/G3 LIFO; I7 closed door;
  I8 open window; aborted is not failure; no unhandled rejection from an
  unjoined failed fork; aborted outcome fires no destination; a release
  failure does not stop remaining releases; stall warning; release
  deadline signal fires; `Symbol.dispose` throws on a root.

**`src/invariants.test.ts`** — one named test per invariant, delegating
to helpers shared with the files above:
I1 a node is on exactly one stack and `own(foreignNode)` → `NotOwnedError`;
for a passive object, `A.own(x); B.own(x)` is accepted and documented
(D-39): each owner runs the dispose once and `A.release(x)` leaves `B`'s
entry live; I2 completion and each release happen once under concurrent
abort/close/asyncDispose, under `releaseAll()` racing `release(x)`, and
under an `abort()` arriving mid-`releaseAll()` (D-36); I3 explicit before
provided; I4 an owned fiber and a pool
hear the signal only at their turn; I5 early release of a middle entry
leaves the others' order unchanged; I6 a frozen body never resumes, and a
second managed await requested after freezing never settles; I7 every
operation on a complete node throws; I8 between delivery and completion
`own`/`release`/`fork`/`child`/`get` work; I9 the subtree is marked before
any listener runs; I10 the setup hook saw no unhandled rejection while an
unjoined fork failed; I11 consumed once or surfaced; I12 aborted is not
failure; I13 state decides; I14 every release is a fiber and is current;
I15 `own`/`fork`/`child` entries are registered before they return
(`entry:registered` precedes the return); I16 nothing runs in a creation
frame; I17 placement follows dependencies; I18 every creation-time read is
`inject`, `ContextKey` untracked; I19 decisions permanent, placement by
view; I20 fork is asynchronous; I21 the current node is the default
owner; I22 a released provided value fails loudly on hit; I23 every
acquisition is releasable early (`release(x)`, a handle whose `release()`
goes through the owner); I24 `own` never lands on the provided stack and a
DI value's node always does; I25 `own(fn)` runs inside a release fiber;
I26 a lent node rejects body-shaped use; I27 fibers are not awaitable and
tasks are not callable.

**`src/node-topic.test.ts`** — the event sequence for `fork` (`node:created`
→ `entry:registered` → `node:started` → `node:settled` → `node:releasing`
→ `node:complete`), `call` (`node:lent`/`node:returned`), `join`
(`join:enter`/`join:leave`; a frozen joiner emits `node:frozen` and no
`join:leave`), a DI value (`node:created` with `stack: 'none'` then
`entry:registered` for what its constructor owned, then `node:placed`,
then `node:started` for its constructor forks; D-42), release (`kind:
'release'` nodes always appear, with `entry:released` carrying `error` on
failure), `node:frozen`, `node:delivered`, `node:stalled` (also for a
delivered `observe` body that never settles, D-55); order pins (D-54): a
born-delivered child emits `node:created` → `node:delivered`; a fiber
constructed with an already-aborted `opts.signal` emits `node:created` →
`node:delivered` → `node:settled` → `node:complete`; `kind` is `'value'`
for DI values (D-52); `kind`/`task`/`stack`/`subscribed`/`seq` fields;
zero events and zero allocations-visible-to-tests without a receiver (the
receiver is resolved once per root).

**`src/request-example.test.ts`** — §6.7 end to end, as written. Setup:
`Pool` is a class key with the §6.6 default factory (`#ctx = current()`,
`own(fork(() => this.#reap()))` in the constructor, `acquire(owner =
current())` attaching the lease to `owner` before its promise resolves,
`Lease.release()` going through the owner), `Conn` a plain key, `work(req)`
a plain function that `lookup(Conn)`s; `handle` is the §6.7 task verbatim
(`lookup(Pool)`, `own(await pool.acquire())`, `call(task(() => work(req),
{ providers: [valueProvider(Conn, lease.conn)] }))`); a fake server
invokes a platform callback with no current node that does
`app.fork(handle.with({ name, signal: req.signal, onFailure }), req, res)`;
the root is created under `await using` and the test body runs as
top-level `await app.call(main)`. Assertions, one `it` each: (1) `Pool`
lands on `root.provided` (its only dependency is `ContextKey`, excluded
from tracking), its reaper's `node:started` follows `node:placed`, and
`lookup(Pool)` from a second handler returns the same instance; (2) the
handler fiber is lent during `call` — `fork` from inside `work` through
the handler's node throws `UnawaitedCallError` naming the call child —
and `own(await pool.acquire())` registers exactly one entry (D-37); (3)
aborting `req.signal` freezes the handler at its managed await, releases
the lease back to the pool (`pool.free` grows), does **not** call
`onFailure` (I12), and `app.close()` surfaces nothing; (4) a `work` that
throws calls `onFailure` once with the error, `current()` inside
`onFailure` is `app` (D-45), and `app.close()` surfaces nothing (the
handler consumed it); (5) after the handlers complete, `app.close()`
releases the pool's node last — release trace `[handler…, reaper, pool]`
— so every lease-holder completed before the pool (G1); (6) with a
handler still running, `app.abort()` from a platform callback makes the
top-level `await app.call(main)` reject with `FiberAbortedError`, the
`await using` block completes, and the handler's lease was released
(§4.3).

**`src/topic.test.ts`** — kept; `createContext({parent})` → `root.child()`.

### 6.2 Old tests: ported and dropped (per suite, exact counts)

The current suite has 249 tests: `context.test.ts` 150, `fiber.test.ts`
46, `push-context.test.ts` 21, `lifecycle-events.test.ts` 17,
`fiber-set.test.ts` 7, `topic.test.ts` 8. Ported 206, dropped 43.
Mechanical substitutions everywhere: `createContext({ parent: p, … })` →
`p.child({ … })`; `inject(RegisterResource)({ [Dispose]: f })` →
`own({ [Symbol.dispose]: f })` or `own(() => f())`; `handle.unregister()`
→ `release(x)`; `ctx.dispose()` (sync) → `ctx.abort()` (synchronous
release when every entry is synchronous) or `await ctx.close()`;
`await ctx.dispose()` → `await ctx.close()`; `ctx.runSync(fn, { providers,
scopes })` → `using c = ctx.child({ providers, scopes }); c.run(fn)`;
`Fiber.call(fn, { context: ctx, … })` → `ctx.call(task(fn, { … }))`;
`Fiber.spawn(fn, { context: ctx })` → `ctx.fork(task(fn, { onFailure: 'link' }))`
or a fork inside `ctx.call`; `Fiber.join/result/all` → `join/result/all([tasks])`;
`fiber.abort()` unchanged; `ctx.status`/`ctx.aborted` → `ctx.state`/
`ctx.signal.aborted`.

**`context.test.ts` → `src/di.test.ts`, `src/creation.test.ts`, `src/placement-view.test.ts`**

| Suite (count) | Ported | Dropped | Notes |
|---|---|---|---|
| Context basics (11) | 11 | 0 | messages kept (`No provider found for key: A`, `Circular dependency detected`) |
| default providers (6) | 6 | 0 | |
| auto-scoping (6) | 6 | 0 | "Root can't create RequestHandler" still throws (`REQUEST` has no default) |
| Execution Context (11) | 11 | 0 | `inject() should throw outside any context` asserts `lookup` → `NoCurrentNodeError` and `inject` → `CreationViolationError`; `runSync(fn, opts)` → child idiom |
| Context.runSync (9) | 9 | 0 | `runSync from within enterSync` → nested `outer.run(() => outer.runSync(...))` |
| Disposal › sync (7) | 7 | 0 | order assertions unchanged (provided LIFO; children before parent values = G1); sync cases observe after `abort()`, nested `child()` entries included (D-25: a node entry whose subtree completes synchronously keeps the owner synchronous) |
| Disposal › async (4) | 4 | 0 | |
| RegisterResource (6) | 6 (rewritten as "own in creation") | 0 | the two "outside creation" tests FLIP: `own` in a body attaches to the current node; with no node → `NoCurrentNodeError` |
| execution context auto-disposal (3) | 3 | 0 | `using c = ctx.child({providers}); c.run(fn)`; synchronous observation pinned |
| context type properties (1) | 0 | 1 | `dispose()` removed |
| Scopes (10) | 10 | 0 | |
| Dependencies (9) | 9 | 0 | |
| addProvider (7) | 7 | 0 | error type `PlacementError`, regex `/decided/`; FLIPPED (§8.2): "at child after key resolved at ancestor" → allowed (fresh child has no decisions); FLIPPED (P7): "at root after auto-scope stored at child" → allowed, and `root.get(UserRepo)` builds a distinct root instance |
| resolution caching (3) | 2 | 1 | probabilistic memo removed |
| SelfScope (9) | 9 | 0 | the three `root.create(WRAPPER)` tests use two sibling children each resolving `WRAPPER`; "wire disposal to the outer creation" → `own()` in the SelfScope factory lands on the wrapper's node and is released when its child closes |
| Provider.scope (7) | 7 | 0 | the `root.create` case as above |
| context.create() (7) | 0 | 7 | feature removed (§14) |
| create() dep tracking (2) | 0 | 2 | |
| createRefCountedKey (6) | 0 | 6 | out of core |
| refCountedProvider (4) | 0 | 4 | out of core |
| skipSelf (7) | 7 | 0 | `cycleExempt` replaces the creation-stack trick |
| resourceProvider (4) | 4 (re-expressed) | 0 | `factoryProvider(k, () => own(v, release))`, same order assertions |
| ContextRef (11) | 11 (re-expressed as `ContextKey`/`current()`) | 0 | pre-resolved → live node with `parent === root/child`; "throw when reading during factory" → `inject(ContextKey).get(X)` → `PendingNodeError`; "whenResolved" → a constructor `fork` runs after placement; "lookup outside/inside execution context" → `CreationViolationError`; "functional context" → `#ctx.get(ConfigKey)` after creation |
| **total (150)** | **129** | **21** | |

**`fiber.test.ts` → `src/fiber.test.ts`, `src/lending.test.ts`**

| Suite (count) | Ported | Dropped | Notes |
|---|---|---|---|
| Fiber.call (11) | 11 | 0 | "unawaited nested calls via stack-top" → the §7.11 lending test; "no context" → `NoCurrentNodeError` |
| Fiber.spawn (13) | 12 | 1 | `.promise` dropped; abort tests use `signal()`; "drain when parent disposes" → `await ctx.close()` waits |
| withAbortSignal (6) | 4 (re-expressed as `signal()`) | 2 | the empty "pre-abort" test and "unregister the resource" (no resource exists) |
| Fiber integration (2) | 2 | 0 | |
| linkAbortSignal (3) | 3 (re-expressed as `task(fn, { signal })`) | 0 | |
| Fiber.fork (4) | 4 | 0 | "no ambient context" → `NoCurrentNodeError` |
| Fiber.join (2), Fiber.result (2) | 4 | 0 | `result` returns an `Outcome` |
| Fiber.all (3) | 3 | 0 | `all([tasks])`; `AggregateError` on failure; empty array |
| **total (46)** | **43** | **3** | |

**`push-context.test.ts`** (21): `Context.run` (3) ported to
`ambient.test.ts`; `captureAutoScoped` (4) ported to `di.test.ts` with
`ctx.run` instead of `enterSync`; dropped 14: `enterSync/leaveSync` (4),
free `addProvider` (3), vitest lifecycle simulation (3), class injection
with enterSync (2), lifecycle with capture (2) — a node cannot be made
current across vitest hooks without `enterSync` (§14 maps it to `ctx.run`,
which is lexically scoped).

**`lifecycle-events.test.ts`** (17) → `src/node-topic.test.ts`: Fiber
events (8) → 8 (call/spawn/fork/join events on `NodeTopic`); resource
naming (1) → `entry:registered.entryName`; Lifecycle fibers (8) → 3 kept in
spirit (release fibers appear as `kind: 'release'`, async releases, errors
reported) + "NOT emit when no FiberTopic" FLIPPED (release fibers always
exist; no *events* without a receiver); dropped 5 (phase names
drain/flush/dispose; "skip for resources without the method"; "sync
resources only with receiver"). Ported 12, dropped 5.

**`fiber-set.test.ts`** (7) → `src/pool.test.ts`: all 7 re-expressed
(`createFiberSet` → `pool()` in a constructor on the pending node;
`onError` → `onFailure`; `ctx.dispose()` → `close()`; `fiberSet.context`
→ the pool node).

**`topic.test.ts`** (8): 8 ported.

### 6.3 Behavioural flips, each annotated in the test with the section

1. `addProvider` at a fresh child after the ancestor resolved → allowed (§8.2).
2. `addProvider(UserRepo)` at the root after `child` placed it → allowed; `root.get(UserRepo)` builds a root instance (§8.2, P7).
3. `own` outside creation attaches to the current node (§6.2) — it is no longer creation-only.
4. `captureAutoScoped` suites get a fresh instance rather than a throw where the proposal's semantics differ.
5. Release fibers exist whether or not a receiver is provided (§5.2); events exist only with a receiver (§10).
6. `lookup` inside a factory throws (§8.1).
7. Reading `inject(ContextKey)` during an auto-hoisted factory is allowed (the pending node); `get` on it throws `PendingNodeError` (§6.2).

---

## 7. Work breakdown

Five stages. S0 → S1 are sequential; S2 and S3 run in parallel on top of
S1; S4 integrates. Each stage's definition of done is checkable by an
implementer agent: `pnpm typecheck` (tsc over `tsconfig.tests.json`),
`pnpm lint`, and the named test files green with `pnpm test <file>`.
Until S4 deletes the old suites, old test files that no longer compile
are renamed to `*.test.ts.old` by the stage that breaks them (S1 breaks
all of them) so the whole suite can still run; S4 removes them.

### S0 — Foundation: types, errors, storage, stack, managed promise, harness

Files: `src/context.ts`, `src/resource.ts`, `src/context-storage.ts`,
`src/node.ts`, `src/async-context.ts`, `src/internal-context.ts`,
`src/stack.ts`, `src/managed.ts`, `src/test/util.ts`, `src/test/setup.ts`,
`tsconfig.json`, `tsconfig.tests.json`, `vitest.config.ts`, `package.json`
(`files`), `eslint.config.js` (no change expected).
Depends on: nothing. Parallelisable: the files are independent after
`context.ts` and `internal-context.ts` exist; one implementer is enough.
Done when: `tsc -p tsconfig.tests.json` passes for these files with the
rest of `src/` temporarily excluded (a scratch tsconfig is acceptable in
this stage only); `stack.test.ts`, `storage.test.ts`, `managed.test.ts`
pass, including `managed.test.ts` (10)–(14) (delivery only in `then`,
empty cells after a cut, no unhandled rejection from an unawaited
wrapper); `vitest.config.ts` carries `execArgv: ['--expose-gc']`,
`pool: 'forks'`, `isolate: true`, `setupFiles`; the `NoCurrentNodeError`
message without storage names `ramme/node`; `NO_NODE` is exported and
`currentFrame()` returns `undefined` under it.

### S1 — Node core

Files: `src/node-impl.ts`, `src/pool.ts`, `src/lifecycle-events.ts`,
`src/create-context.ts`, and a **stub** `src/inject.ts` that exports the
exact signatures of §1.11 with providers-only semantics (walk the parent
chain for `providers`, run `provide()` under `runCreation` with a
`CreationState` whose `tracker` is undefined, cache at the providing
context, `markDecided` and `assertProviderPlacement` as specified, no
default factories, no scopes, no shadow check, `inject` supporting
`ContextKey` and plain keys). Delete `src/context-impl.ts`,
`src/fiber-exec.ts`, `src/fiber-set.ts`, `src/ref-count.ts`,
`src/run-sync.ts`, `src/maybe-async.ts`; rename the old test files to
`.old`.
Depends on: S0. Parallelisable: no (one coherent class); the stub
`inject.ts` can be written by the S2 implementer against §1.11.
Done when: typecheck and lint pass for `src/` minus `.old` files;
`node-core.test.ts`, `outcome.test.ts` (the *frozen awaiter* and *I13
converse* groups included), `lending.test.ts`, `freeze-gc.test.ts`,
`pool.test.ts` (core scenarios; the ported fiber-set cases wait for S2's
constructor path) pass using only `valueProvider`/`factoryProvider`
without scopes or default factories; a grep finds no `activeCreationCtx`,
`creationStack`, `MISS_THRESHOLD`, `enterSync`, `ManagedResource`,
`syncStack`, `Drain`, `Flush`, `closeInner`, `failureConsumed` in `src/`
(excluding `.old`).

### S2 — Resolution: `inject.ts` with §8.2, creation purity, pending nodes

Files: `src/inject.ts` (full), `src/provider-util.ts`, `src/node-impl.ts`
(only the `get`/`addProvider`/`createValueNode`/`placeAt`/`abandon`
touch-points if S1 left any gap), tests `src/di.test.ts`,
`src/placement-view.test.ts`, `src/creation.test.ts`, the ported
fiber-set cases in `src/pool.test.ts`.
Depends on: S1. Parallelisable with S3.
Done when: `di.test.ts` (129 ported tests) green with the seven flips
annotated; `placement-view.test.ts` and `creation.test.ts` green; typecheck
and lint pass.

### S3 — Fiber layer surface: tasks, free functions, index

Files: `src/fiber.ts`, `src/ambient.ts`, `src/index.ts`, tests
`src/fiber.test.ts` (rewritten), `src/ambient.test.ts`.
Depends on: S1. Parallelisable with S2 (uses providers-only resolution
only).
Done when: `fiber.test.ts` and `ambient.test.ts` green; `index.ts` exports
exactly §1.15; `pnpm build` produces `dist/` whose `index.d.ts` contains
every name in §3.1, §7.1, §7.2, §7.7, §9.6 of the proposal and none of the
names enumerated under "Removed from the surface" in §1.15 (one grep per
name over `dist/index.d.ts`).

### S4 — Integration: probes, invariants, topics, cleanup, docs, package

Files: `src/probes.test.ts`, `src/invariants.test.ts`,
`src/node-topic.test.ts`, `src/request-example.test.ts` (§6.7 end to
end), `src/topic.test.ts` (child()), delete all
`*.test.ts.old`, `README.md` (tier 1 only), `DESIGN.md` (§1.1, §2–§4, §6,
§8 rewritten from the proposal; §7 package layout from §1.1 of this
document), `DECISIONS.md` (D1′, D3′, D4′, D6′, D8′, D9′, D10′, D16 as the
proposal lists them, plus the entries of §8 below that are permanent;
retire D5), `package.json` (description, keywords, `files`).
Depends on: S2 and S3. Parallelisable: tests and docs are independent.
Done when: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm check:package` all pass; the suite contains a named test for every
I1–I27 and for P1–P5, P7, P19–P23 (and `it.todo` for the rest), and the
six `request-example` assertions; the unhandled-rejection hook recorded
nothing across the full run; README's
first example uses only tier-1 names; `sideEffects` still lists exactly
`./dist/node.js` and `./dist/async-context.js`.

### S5 — Follow-ups outside this gate

`packages/eslint-plugin-ramme` (the §13 rules, a separate package);
`kilde/PROPOSAL.md` (§8.6); a micro-benchmark comparing release cost with
the previous phase runner. Not required for the ramme suite to be green.

### Stage dependency summary

```
S0 ──▶ S1 ──┬──▶ S2 ──┐
            └──▶ S3 ──┴──▶ S4 ──▶ S5
```

---

## 8. Decisions log

Each entry: what was decided, where the proposal left it open, one line of
rationale. Entries marked **(DECISIONS)** become permanent entries in
DECISIONS.md in S4; the rest are implementation choices recorded here.

- **D-01 Three additions to §9.6.** `PoolFullError` (for `whenFull: 'reject'`; `PoolClosedError` would be semantically wrong), `OwnerInterrupt` (the abort reason ramme itself produces, so `signal.reason` is inspectable), `FactoryReturnedUndefinedError extends CreationViolationError` (so the §8.3 rule has a class without changing `instanceof` checks). **(DECISIONS)**
- **D-02 No synchronous fallback storage.** Without `import 'ramme/node'` every frame-needing operation — including the first factory run — throws `NoCurrentNodeError` naming the import (§8.4, law 3). The old builtin stack is not kept; it would reintroduce the P19 bleed surface. Revisitable in `context-storage.ts` alone. **(DECISIONS, D9′)**
- **D-03 `call` lends `current()`, never the receiver.** `ctx.call(fn)` from body Y lends Y (the awaiting body); from a frame with no node it lends nothing. Lending the receiver would make `app.fork(...)` from a platform callback throw during a top-level `await app.call(main)` (§4.3 + §6.7). The grafted fix for the shared mistake. **(DECISIONS)**
- **D-04 Body exit interrupts all subscribers and does not mark the exiting node.** At a natural body exit under `childrenOnExit: 'interrupt'` every subscriber in the subtree is delivered (§5.1) with an `OwnerInterrupt` reason, whatever the exiting node's mode; the exiting node's own `signal` fires only on `abort()`/`timeoutMs`/linked signal. Keeps §5.1 literal and needs no "settled before delivery" flag.
- **D-05 Birth rule: delivered at birth iff the parent would have forwarded.** A `freeze` child under a delivered `observe` parent is *not* delivered at birth (the parent would not have forwarded to it had it existed); a `restore` child is delivered when any ancestor is. Reading the §4.4 table literally would make behaviour depend on whether a handler was forked before or after the shutdown signal, which the proposal's order-independence stance rejects. **(DECISIONS)**
- **D-06 Freeze: cut in flight, but only awaited managed promises count.** A managed await already in flight is cut at delivery and the body counts as frozen immediately (law 4, §6.8); "in flight" is defined as "`then` was called", which `ManagedPromise` observes. A stored, un-awaited managed promise does not freeze the body at delivery (§4.2) and freezes it the moment it is awaited. The same `then` is where the awaited value is delivered and a failure consumed (D-38). **(DECISIONS, with D13 of the proposal's numbering suggested)**
- **D-07 `never()` and `interrupted()` on a freeze node are cut-only promises.** No shared `NEVER` constant is ever `.then`ed, so no resolver or continuation is retained (A2). With no current node `never()` returns a fresh `new Promise(() => {})`.
- **D-08 `outcome` is fixed at settling and amended once at completion.** `classify()` runs in `onBodyExit`; `finishCompletion` folds release and unconsumed errors in (§9.2). This is what makes `owner.outcome` readable in every release (§5.6, §6.1). **(DECISIONS, D16)**
- **D-09 The lifecycle quartet is idempotent on a complete node.** `abort`, `close`, `[Symbol.dispose]`, `[Symbol.asyncDispose]` are no-ops / return a wrapper over the one `completion` after completion; every other method throws `NodeCompletedError` (I7). `await using` and double-dispose tests require it; §5.6 lists idempotence as built in for nodes. Idempotence is about the lifecycle (one signal, one release per entry, one completion), not about hiding an outcome: a second `asyncDispose()` on a failed fiber rejects again (D-50).
- **D-10 Destinations are immediate and final.** `'link'` and owned-fiber (C5) failures abort the parent at *settle* (§7.4 "immediately") and again, idempotently, at completion if release errors turned a successful body into a failure; the handler is called once, at completion, with the final failure, with the parent current (D-45); `'join'` is recorded on the parent at completion as a `FailureRecord` (§9.4, D-40). A handler that throws is recorded on the parent's `extraErrors`.
- **D-11 `close()` on a fiber waits for the body, then releases without a signal.** `closeRequested` makes `exitKind = 'await'` unless `abort()` arrives first, which wins. Subscribed node entries get `closeInternal()` recursively (Q7); unsubscribed ones get abort + await (asyncDispose is the first thing they hear).
- **D-12 Internal release of a node entry never consumes its failure.** The loop uses `abortInternal`/`closeInternal` + `completion` (which never rejects); the child's failure reaches the parent exactly once through `unconsumed` at completion (I11), whatever the child's kind (D-40). Only a delivered public `join`/`result`/`[Symbol.asyncDispose]` (and, for non-fibers, `close()`) consumes. Child failures therefore appear in the `AggregateError` branch of §9.2, and only the loop's passive release failures and handler exceptions in the `SuppressedError` branch when the body also failed. `close()` on a fiber rejects with its release/unconsumed errors only; the body failure stays `join`'s.
- **D-13 `abort()` on a fiber that has not started settles it `aborted` without running the body.** Covers an already-aborted `opts.signal` at construction and the owner's release reaching a not-yet-started fork. Birth-delivery (parent delivered) is different: the body still runs until its first managed await (§5.4).
- **D-14 `all` with an aborted member and no failure rejects `FiberAbortedError`.** The tuple cannot be completed; aborted outcomes never appear in the `AggregateError` (§7.5). `race` with no success rejects `AggregateError` of the real failures, or `FiberAbortedError` when every member was aborted; `race([])` is a `TypeError`.
- **D-15 Q6 refusal: synchronous on live bodiless nodes, deferred to the end of creation on value nodes.** `root.fork(t)` / `child().fork(t)` with the default `'join'` destination throw `TypeError` at the call; in a constructor the fork is recorded and checked after the factory returns, so `own(fork(...))` (§6.6) works and an unowned one fails the *resolution* synchronously with the pending node released. The shared mistake in all three plans. **(DECISIONS)**
- **D-16 Pool intake stops at the signal.** `pool.fork` throws `PoolClosedError` once the pool is delivered or `close()` was requested, `NodeCompletedError` after completion. A deliberate exception to I8 for intake infrastructure: a fiber forked into a delivered freeze pool would be born delivered and freeze immediately. **(DECISIONS)**
- **D-17 `get`/`call`/`run`/`runSync` and the body-shaped free functions throw `CreationViolationError` in a creation frame.** The method form cannot bypass the `lookup` ban (§8.1) or the "entering another node" ban (§8.3). Internal paths (`resolveFrom`, `resolveReceiver`) do not go through `get`, so emitting events or resolving dependencies during creation is unaffected.
- **D-18 Only `inject` may read `ContextKey`.** `get(ContextKey)`/`lookup(ContextKey)` throw `CreationViolationError` with a message pointing at `current()`; `ContextKey` is served by the creation frame and never tracked (§8.1).
- **D-19 `deps` per cache entry; no per-context union.** The shadow check needs the specific hit's `deps` and the decided rule marks `decided` directly; the union §8.2 mentions is dropped until profiling asks for it.
- **D-20 Placement by view caches at `S′`, the requester's own placement, not literally "at R".** `S′` equals `R` when `R` provides the shadowing key itself and otherwise lies strictly between `R` and the shadow; every requester under `S′` with the same view shares it. Semantically equivalent to §8.2's "memoized at R" for every requester below `S′`. **(DECISIONS, D10′ note)**
- **D-21 A re-created value landing on a context that already caches the key is abandoned.** Possible only for a factory whose dependency set varied between runs (D7's documented cost); the existing instance is returned, the new one's node released, a dev warning emitted. Never overwrite an answer a context has given (I19).
- **D-22 A cache hit whose value node is complete throws `NodeCompletedError`.** The G3 discipline (a release uses only what the value injected) is not enforced, but its violation fails loudly (I22) instead of handing out a released service.
- **D-23 `captureAutoScoped` is a public option on `NodeOptions`.** (Amended after review: it was `@internal`.) It is the one declared way to stop auto-hoisted instances leaking above a boundary without scoping every key, which test harnesses and isolation boundaries need; the published `.d.ts` carries it with its doc comment.
- **D-24 `runSync` has no options parameter.** §3.1's signature is kept; the old `runSync(fn, { providers })` idiom becomes `using c = ctx.child({ providers }); c.run(fn)` (sync `using` is allowed; `[Symbol.dispose]` = `abort()`, which completes synchronously when every entry is synchronous).
- **D-25 All-synchronous trees complete synchronously inside `abort()`.** `startBody`, `releaseEntry` and `releaseLoop` stay synchronous while nothing returns a promise, so `runSync`'s abort-on-exit releases before it returns and the ported auto-disposal tests observe it. This includes **node entries**: the node action returns `undefined` when the child is already `complete` after `abortInternal`/`closeInternal`, rather than its (already resolved) `completion`, so a nested `child()` or a fiber with a synchronous body does not push the owner's loop into a microtask. `close()`/`asyncDispose()` still return promises.
- **D-26 Dev mode is `process.env.NODE_ENV !== 'production'`** (always on where `process` is absent). Used by `AsyncRunError` (Q8), the Q4 warning (`console.warn` once per key per root) and the D-21 warning.
- **D-27 Timers.** `timeoutMs` → `setTimeout` (unref'd) aborting with `new DOMException('Timed out', 'TimeoutError')`; `AbortSignal.timeout` only when `releaseTimeoutMs` is set (Q11: no default); stall timers unref'd, `stallWarningMs` `0`/`Infinity` disables; everything cleared at completion.
- **D-28 `SuppressedErrorCtor` shim.** `engines >= 22` but the global ships in Node 24; `globalThis.SuppressedError ?? class { … }`. The type comes from the `ESNext.Disposable` lib, added to both tsconfigs.
- **D-29 The `then` trap is a kind-guarded prototype getter on `NodeImpl`.** Throws `FiberNotAwaitableError` for fibers, returns `undefined` otherwise, so plain contexts are not thenables; `Fiber<T>` declares no `then` and narrows `outcome` to `Outcome<T>` for inference.
- **D-30 Error classes live in `resource.ts`** (§16: "resource.ts shrinks to error types") together with `toDispose`; no `errors.ts`.
- **D-31 Free `addProvider` and `registerResource` are dropped.** `current().addProvider(p)` is one line; `own` replaces `registerResource`.
- **D-32 `NodeTopic` receivers are construction-time providers on the root.** The receiver is resolved on the first emit (the root's own `node:created`) with the raw walk; a later `addProvider(NodeTopic)` is a `PlacementError` by the normal rule. Same constraint as today.
- **D-33 Unconsumed failures flow through shared records.** `unconsumed: Set<FailureRecord>` on the parent and `failure: FailureRecord | undefined` on the child point at the same `{ error, consumed }` object, so I11 is one flag with no duplication and the parent retains the error, not the child node (D-53). A record leaves the set when a continuation delivers it (`consumeFailure`, D-38) and is folded into the parent's outcome at completion otherwise. `extraErrors` holds only the loop's passive release errors and handler exceptions.
- **D-34 A root's `[Symbol.dispose]` throws `TypeError`** (§3.3): nobody waits for its completion; `await using` or `close()` is the way.
- **D-35 Probe numbering.** P1–P5, P7, P19–P23 are implemented from the proposal's references; P6, P8–P18 are `it.todo` placeholders with the candidate scenarios implemented under invariant names, so no behaviour is left untested while the author supplies the numbering.

Revision 2 (second readiness review):

- **D-36 A release is idempotent by `Entry.state`, and `e.done` exists before the dispose runs.** `releaseEntry` returns immediately when `state !== 'live'` (sharing `e.done`), and creates `e.done` with `Promise.withResolvers` before constructing the release fiber. `releaseAll()` re-checks each entry's state as it reaches it instead of trusting its snapshot. This is I2/C4/C7 made local: `releaseAll()` racing `release(x)`, an `abort()` arriving mid-`releaseAll()`, and a dispose that synchronously re-enters the owner's loop (an owned fiber's C5 abort, a callback calling `owner.abort()`) all find one release and one promise. **(DECISIONS, under D16)**
- **D-37 `own(x)` with one argument is a no-op on an object this node already owns; C8 is about a second release.** §6.7 line 2 calls `own(await pool.acquire())` "a no-op by identity" while C8 says owning twice throws; the two are reconciled by what the call asks for: one argument asks "make sure this node owns `x`", which is already true, and returns `x`; `own(x, release)` asks to register a release, and a second release for one object is the C8 error (`AlreadyOwnedError`). The tier-1 idiom therefore reads as written, and a producer that attaches on behalf of the current node (§6.4) composes with a body that `own`s what it got back. Cross-node duplicates are D-39. **(DECISIONS, under D16)**
- **D-38 Delivery is consumption, and sources never reject.** Every managed promise is a `ManagedPromise` over a non-rejecting source (`completion`, `e.done`, `deliveredResolvers.promise`, an `async` helper that catches) plus a `deliver` step that runs only in `then`'s non-cut fulfilment path; `take()`, `consumeFailure()`, `deliverClose()` are `deliver` steps. Consequences, each a test: a frozen awaiter consumes nothing and the failure surfaces from the parent (I11 — the gap where an owner frozen on `join(f)` lost `f`'s failure); a stored, never-awaited `join`/`result`/`call` promise consumes nothing; `Promise.all([call(a), call(b)])` never delivers `a`; no internal promise can reject unhandled whether or not it is awaited (I10; `const p = call(x); await timer; await p` is safe); `close()` needs no shared promise because nothing it wraps can reject. The one wrapper over a user promise, `managed(p)`, has no `deliver` and leaves `p`'s handled-ness alone. **(DECISIONS, under D13)**
- **D-39 Cross-node double ownership of a passive object is not policed.** `A.own(x); B.own(x)` registers two entries and runs the dispose once per owner; `A.release(x)` leaves `B`'s entry live. §5.6 makes idempotence "your responsibility for passive entries", and the `WeakMap<object, Entry>` that would make this an error costs every `own()` a global map write for a mistake `no-floating-promises`-grade tooling cannot see anyway; nodes stay single-owner structurally (`entryOnOwner`, `own(foreignNode)` → `NotOwnedError`, Q14). Documented and tested as accepted (I1 test).
- **D-40 Every node routes its final failure to its parent's `unconsumed`, not just fibers.** A `child()` context, a pool or a DI value's node whose release fails completes with `failure`; `finishCompletion` creates its `FailureRecord` and adds it to the parent's set exactly as for a `'join'` fiber, so §9.4's "every unconsumed subscriber failure" and §5.6's "routed or collected" hold for non-fibers. A delivered `close()`/`[Symbol.asyncDispose]()` on the non-fiber consumes it. Release-kind nodes are excluded: their failure belongs to the entry they released and is handled by `releaseEntry.finish`. **(DECISIONS, under D16)**
- **D-41 An early release's error is an unconsumed failure until `release(x)`/`releaseAll()` delivers it.** §9.2 says the error "rejects that call only"; when that call's awaiter froze or never awaited, "only" would mean "nowhere", which §5.6 forbids. `releaseEntry.finish` therefore records an early failure on `e.failure` and in `owner.unconsumed`; the `deliver` step of `release(x)`/`releaseAll()` consumes it, and an undelivered record is folded into the owner's outcome at completion. A delivered caller sees exactly the §9.2 behaviour. **(DECISIONS, under D16)**
- **D-42 A pending value node is born with the requester's `root`.** `createValueNode` passes the requester as `basis`; the constructor takes `root` (and provisional `depth`/`autoScopeRoot`/inherited timeouts) from it when `parent` is undefined. `emit` therefore never resolves a receiver from a pending node, the first `own()`/`fork()`/`current()` in a default factory emits like any other node, and every node created under the pending node before placement (forks, pools, release fibers of an early `release(x)`) shares the receiver. `placeAt`/`fixTree` recompute depth and scope roots and assert `S.root === this.root`, which holds because `S` lies on the requester's ancestor path; the root's receiver cache is never touched. The event sequence `node:created (stack 'none') → entry:registered → node:placed → node:started` is what `node-topic.test.ts` pins.
- **D-43 `deps(V)` records optional misses.** `DepTracker.track(key, r)` adds `key` whether or not `r.resolved`; `deepest` and the transitive union move only on hits. §8.2 defines `deps(V)` as "the keys `V` injected", and "K is not provided" is as much a part of `V`'s view as a value would be: without it, a fresh child providing `K` would be served a `V` built without `K` across a shadow `shadowBetween` cannot see (I19). The `markDecided` of the miss already treated it as a decision; the tracker now agrees. **(DECISIONS, under D10′)**
- **D-44 A scope-owning context between `R` and `S` shadows a scoped dependency.** `shadowBetween` also returns true when a context on `[R, S)` owns `getKeyScope(d)` for some `d ∈ deps(V)` (SelfScope excluded). A nested σ-context changes `R`'s view of a σ-scoped dependency exactly as a provider would; §8.2 speaks only of providers, so this is recorded as an extension of its rule rather than a reading of it. Provider-level scopes (`p.scope`) are already caught by the provider check. **(DECISIONS, under D10′)**
- **D-45 Failure handlers run with the parent current; receivers run in the emitting frame.** `finishCompletion` invokes a handler destination under `{ node: parent }`: the failed fiber is complete (I7), the parent is the node whose lifetime the handler's work has, `own()` there is "never wrong" (I21), and `lookup()` resolves from it. The handler is the one callback the design keeps (§7.4), so its frame is specified and tested (`current() === parent`). `NodeTopic` receivers are sinks: they run synchronously wherever `emit` was called and must not use ambient operations; installing a frame per event would price observability above zero.
- **D-46 Settle reactions and start microtasks run under `NO_NODE`.** Promise reactions and `queueMicrotask` capture the async context at registration; `startBody` registers `r.then(onBodyExit…)` and `scheduleStart`/`finishCreation` queue their microtasks inside `runInFrame(NO_NODE, …)`, so `onBodyExit → releaseLoop → finishCompletion` never run under the forker's frame or a finished creation frame (`currentCreation()` set after the factory returned, I16/P5). Bodies always run under their own frame (`startBody`), release fibers under theirs, handlers under D-45; the internal continuation itself reads no frame. `currentFrame()` reports `NO_NODE` as `undefined`.
- **D-47 Pool accounting counts only `pooled` fibers; abort stops the queue, close drains it.** `poolFork` marks its fibers `pooled`; `finishCompletion` calls `poolChildComplete` only for them, so release nodes, DI values placed on the pool and passive `pool.own(x)` entries never decrement `running` or start a waiter. `poolChildComplete` starts no waiter once the pool is delivered (its loop settles each waiter `aborted`, D-13/D-16); under `close()` waiters still start as slots free, because a graceful close waits for the pool's work "naturally" (Q7) and the queue is that work. **(DECISIONS, under D-16)**
- **D-48 `get(K, { skipSelf })` is the internal walk from the parent.** It calls `resolveFrom(this.parent, K)` and applies the optional/throw decision itself instead of recursing through `parent.get`, so the parent's guards (`assertNotLent`, `assertNotCreating`) do not run: a decorator resolved from inside a `call()`ed body would otherwise hit `UnawaitedCallError` on its lent parent. The no-parent message is kept verbatim.
- **D-49 A body that returns a fiber fails with `FiberNotAwaitableError`.** `startBody` checks `isNodeImpl(r)` before the thenable probe and runs the probe inside the `try`, so the D-29 `then` trap (or a hostile `then` getter) becomes a body failure and never escapes the start microtask (I10/I27). An async body that returns a fiber already fails the same way, because resolving its promise with the fiber invokes the trap; sync and async bodies therefore agree.
- **D-50 "Consumed at most once" means routed once; re-delivery reports again.** The flag decides whether the parent surfaces a failure at completion; it never hides an outcome from a later observer. A second `join(f)`, `result(f)` or `[Symbol.asyncDispose]()` on a settled fiber runs `deliver` again and reports the same outcome; `consumeFailure()` is idempotent. `join` semantics (report the outcome) win over the alternative of resolving a second awaiter silently.
- **D-51 `all`/`race` run their members as `'join'` fibers.** Members are forked as `t.with({ onFailure: 'join' })`: a member's own `'link'` would abort the inline group fiber and turn the promised `AggregateError` into a `FiberAbortedError`, and a handler destination would both run the handler and appear in the result. The group's own failure still follows its caller's destination (Q9).
- **D-52 `'value'` is a `NodeEventKind`.** §10 lists `context | fiber | pool | release | entry`; a DI value's node needs a kind for `node:created`/`node:placed`/`node:complete`, and emitting it as `'context'` would hide the one node kind whose placement the design explains. **(DECISIONS, under D10′)**
- **D-53 Retention trims.** `body` (fn/args) is nulled at completion; `lender`/`lentTo` are cleared by whichever side completes first (a frozen `Y` whose `ctx.call(...)` child lives on another node no longer keeps `Y` alive through `child.lender`); the parent's `unconsumed` holds `FailureRecord`s, not child nodes (D-33), and a delivered record leaves the set (P1: 10 000 failing `fork`+`join` cycles leave the set empty).
- **D-54 Event order: `node:created` first; `node:delivered` from `markDelivered`.** The constructor checks the parent's openness, then emits `node:created` before attaching, subscribing, applying the birth rule or honouring `opts.signal`, so a born-delivered node and a fiber built on an already-aborted signal both read `node:created → node:delivered → …`. `markDelivered` emits `node:delivered` (and fires the controller) unless `fire()` will; `fire()` emits for the nodes of a two-pass delivery.
- **D-55 The stall timer is armed for every delivered body that has neither settled nor frozen.** §4.6 names "a delivered node", not a `freeze` one: `fire()` arms it for any started body, observe included, and `startBody` arms it for a body born delivered or for a release fiber. Cleared at settle/freeze/completion as before.
- **D-56 `scopes` returns `scopeSet` under `ReadonlySet`, or one shared `EMPTY_SCOPES`.** `scopeSet` is written once in the constructor and never mutated, so the type-level guarantee is the real one; the empty case never allocates. A `Set`-shaped wrapper is the fallback if a consumer is caught casting.
- **D-57 `storage.test.ts` is the one test file without `./node.js`.** Law 3's test convention has exactly one exception, stated: the no-storage path can only be exercised in a file that has not imported an adapter (there is no unregister API, and `registerContextStorage` is once-per-process). `isolate: true` and `pool: 'forks'` make the omission local to that file; the file registers the adapter dynamically for its remaining cases.

S0 implementation (entries marked *(impl)* record where the code departs from the text above, and why):

- **D-58 (impl) `Context.all` takes a `const` type parameter.** §1.2's `all<T extends readonly Task<[], unknown>[]>(tasks: T, …)` infers `all([a.bind(1), b.bind('x')])` as `Promise<(A | B)[]>` under TypeScript 6.0.3, contradicting §7.2 ("is `Promise<[A, B]>`"). `src/context.ts` declares `all<const T extends readonly Task<[], unknown>[]>`, which infers the tuple and changes nothing else (`const` affects inference, not assignability). S1's `NodeImpl.all` and S3's free `all` in `ambient.ts` must carry the same modifier, or calls through them infer arrays; S3's `index.d.ts` check should include a tuple-inference probe.
- **D-59 (impl) The old test files are renamed to `*.test.ts.old` in S0, not S1.** S0's `Context` interface, the `Frame` storage contract (no `current`/`enterSync`/`runAsync`, no synchronous fallback) and the adapters already break all six old suites at type level and at run time, and the rule is "by the stage that breaks them". `topic.test.ts.old` is the one S4 restores and ports (`createContext({ parent })` → `root.child()`, §6.1) rather than deletes. The old *source* modules (`context-impl.ts`, `inject.ts`, `fiber.ts`, `fiber-exec.ts`, `fiber-set.ts`, `ref-count.ts`, `run-sync.ts`, `create-context.ts`, `provider-util.ts`, `lifecycle-events.ts`, `index.ts`) no longer type-check either; S1/S2/S3 replace them. Until then `pnpm typecheck` and `pnpm build` fail by design, and S0 was verified with a scratch tsconfig over the S0 files plus type-only stubs for `node-impl.ts`, `pool.ts` and `inject.ts`'s `CreationState` (§7 S0 allows this).
- **D-60 (impl) S0 test-harness scope and two test-plan corrections.** (a) `src/test/util.ts` omits `events(root)` and `withRoot(opts, fn)`: both need `createRootContext` and `NodeTopic`, which S1 writes; S1 adds them. It adds `hasGc`/`gc` (GC tests use `it.skipIf(!hasGc)`; a helper cannot skip its caller, so `gcUntil` is a no-op without `gc` and throws when the predicate never holds, and runs each GC in a fresh job because `WeakRef#deref()` keeps its target alive until the job ends), `Trace` (`log`, `push`, `at(name)`), and the unhandled-rejection guard's record (`GUARD_KEY`, `unhandledRejectionGuard()`), which `setup.ts` installs once per process under a `Symbol.for` key and checks after each test (after one macrotask) and after the file. (b) `managed.test.ts` (1), "with no current node the source is returned untouched", predates revision 2: by §2.4 and D-38 `managedFor` always returns a `ManagedPromise`, so the test asserts that the wrapper is a `ManagedPromise`, that nothing can freeze, and that the source's value (and `managed(p)`'s rejection) pass through untouched. (c) `storage.test.ts`'s "`current()` throws without storage" is an `it.todo` until S3 writes `ambient.ts`; `runInFrame` carries the same message and is asserted now.
- **D-61 (impl) `ManagedPromise` arms per in-flight continuation, and keeps continuations out of retained closures.** §2.4 arms the cut once (`#armed`) and disarms on the first source reaction; then a second `then` after a delivery (re-delivery, D-50) would be in flight unarmed and a delivery arriving meanwhile would not cut it. The code adds the cut function to `onApplied` whenever a cell is created and removes it when the last live cell is delivered; a cut also drops `#source` and `#deliver`. The callbacks are stored only in the cell: the closures registered on the source are created in a separate method and capture `this` and the cell, never `then`'s parameters (V8 closures share their function's context, so a reaction created inside `then` would retain the continuation after a cut). `managed.ts` imports no `NodeImpl`: `freezeTarget()` assigns `peekCurrentNode()` to a `FreezeTarget`, so S1's `NodeImpl` conforming to it is a compile-time check.
- **D-62 (impl) Small S0 shape choices.** `Stack.size` is a read-only getter; `find`, `topPending` and `snapshotTopDown` skip an entry marked `'released'` even before it is unlinked; `unlink` is idempotent and clears the entry's `prev`/`next`; iteration (head → tail) tolerates unlinking the yielded entry and visits entries pushed meanwhile. `currentFrame()` treats any frame with neither `node` nor `creation` as no frame, not only the `NO_NODE` identity; `context-storage.ts` exports the no-storage message as `NO_STORAGE_MESSAGE` (`@internal`) for `requireCurrent` to reuse. `UnawaitedCallError`, `FiberAbortedError` get default messages; `toDispose` also throws `TypeError` for a non-function `release`, and casts `AsyncDisposable`'s `PromiseLike<void>` (the `ESNext.Disposable` lib type) to the `Promise<void>` of §1.3, which is safe because the release loop's `isPromise` is duck-typed; `toTask` throws `TypeError` for something that is neither a task nor a function; `TASK` is a local `Symbol('ramme.task')` (A4: one copy per realm).
- **D-63 (impl) An awaited `managed(p)` marks `p` handled even when its awaiter freezes.** §2.4's `then` returns `neverPromise()` on an applied target without touching the source. A body born delivered (§5.4), or delivered while it ran plain code (§4.2), that then runs `await managed(fetch(url, { signal: signal() }))` therefore left the fetch's `AbortError` unhandled: I10/§9.5 broken, and a crash under Node's default `--unhandled-rejections=throw`. The same happened to every rejecting member of `Promise.all([managed(p1), managed(p2)])` after delivery. When no cell is live, the applied path now attaches `source.then(undefined, noop)` once and drops `#source`/`#deliver`. A live cell means `#listen` has already subscribed. The `#cut` path is reachable only after such a subscription, and the cut's `#deliver` must survive until it runs. The reaction holds only the module-level `noop`, so nothing of the body is retained (A2), and on ramme's never-rejecting sources it is inert. This narrows D-38 and §2.4 property 7: "`managed(p)` leaves the user promise's handled-ness alone" holds only until the wrapper is awaited, and an unawaited `managed(p)` still leaves `p` to its owner, as an unawaited `p` would. Test: `managed.test.ts` (14) "an awaited managed(p) whose awaiter freezes marks p handled".
- **D-64 (impl) "Suspended" means `then` was called and its continuation is neither delivered nor cut, and only await shapes that resume the body after every such continuation are supported.** §2.4 property 2 equates "the body is suspended on this wrapper" with "`then` was called". A JS combinator can resume the body while a member's wrapper stays armed. A delivery that arrives while the body then runs plain code fires that stale cut, the node is counted frozen, and the owner releases under a running body that can later resume and run its `finally` against released resources. That breaks §4.2 ("never resumes"), I6 and §4.6. Example: the loser of `await Promise.race([join(f1), join(f2)])` followed by a bare `await fetch()`. Another: `await Promise.all([call(a), fetch(u, { signal: signal() })])`, where the cut counts the body frozen and the signal-aborted fetch then rejects the `Promise.all` into the body's `catch`. Changing the freeze model is a proposal change and is not taken. The supported shapes are a direct `await`; ramme's `all`/`race`, where the body awaits one wrapper over the group fiber and the group aborts its losers itself; and `Promise.all`, on fulfilment, whose every member is a managed wrapper whose `deliver` consumes nothing unless it throws (`join`, `call`, `close()`, `release(x)`; not `result`, D-67). Bare members are wrapped in `managed()`, so a cut empties every member and the combinator never settles. Multi-member waits whose members can fail belong in ramme's `all`/`race`. Unsupported in a `freeze` body: `Promise.race`, `Promise.any`, a `Promise.all` that rejects, `Promise.allSettled`, a `result(f)` member of any combinator, any combinator with a bare member, a `.then`/`.catch`/`.finally` attached to a managed promise without awaiting the result at once (await the wrapper directly and transform the value afterwards), and a managed promise awaited by any body other than the one that created it (the last four added by D-67). S4's docs list every one of these, and `managed.test.ts` (6) "unsupported (D-64)" and "unsupported (D-67)" pin them at the wrapper level. **S1 obligation:** in `onBodyExit`, a body that settles (fulfils or rejects) after the node recorded `{ kind: 'frozen' }` produces a dev-mode `console.warn` (D-26). The warning names the node and the unsupported shapes, and the settle changes nothing else (I6: the outcome and the release already happened). `node-core.test.ts` covers both interleavings with a real node and asserts the warning. **Retention:** cut-only wrappers (`never()`, and `interrupted()` through `managedSignal`, D-66) hold no cells, so they share one cut per target, a `WeakMap<FreezeTarget, () => void>` entry that calls `markFrozen`, instead of each adding its own `#cutFn`. `Set` deduplication then keeps `onApplied` at one entry for `while (…) await Promise.race([never(), next()])`, where 1000 iterations used to leave 1000 entries, each retaining its wrapper. This amends D-61 for cut-only wrappers. A sourced `Promise.race` loser still holds one cell and one source reaction until its source settles, which is the growth plain `Promise.race` over a long-lived promise has. That growth is documented and not changed.
- **D-65 (impl) `Stack` decides membership by the entry's own links, and iteration survives a push and an unlink of the yielded tail in one step.** D-62 lets `push` accept a target whose old entry is marked `'released'` but not yet unlinked. `push` then overwrites the index slot, and the index-based `unlink` refused the old entry for good: `size` stayed inflated, and the entry's target and dispose were retained (P1). `unlink(e)` now checks `e.stack === this && (e.prev !== undefined || head === e)`, because `unlink` clears `prev`, and it deletes the index slot only when the slot maps to `e`. `size` still counts such an entry until its owner unlinks it. §1.7's "live + releasing" is exact under §4.3's `finish`, which unlinks as it marks the entry released. After each yield the iterator continues from `e.next`, read afresh, while `e` is linked. Otherwise it continues from the captured `next`. If `e` was the tail, it continues from its old predecessor's `next`, or from the head when there was none, because everything there was pushed during the yield. The case D-62 missed, where the yielded tail is unlinked and an entry is pushed in the same step, is now visited. Other entries still may not be unlinked during iteration (`snapshotTopDown()`). `Entry` gains no field. Tests: `stack.test.ts` "a target pushed again while its old entry is 'released' but linked" and "iteration visits an entry pushed while the yielded tail is unlinked".
- **D-66 (impl) `interrupted()` is built by `managedSignal(source)`, not `managedFor`.** §4.6 returned `managedFor(this.deliveredResolvers.promise)`, which is a sourced wrapper. On a freeze awaiter each such wrapper adds its own `#cutFn` and cell, so `for (…) await Promise.race([interrupted(), next()])` left one `onApplied` entry per iteration, each retaining its wrapper (100 iterations, 100 entries). That contradicts D-07 and D-64's retention claim. `managedNever()` is no substitute, because an observe body's `await interrupted()` would then never resolve, breaking §2.4 property 5 and §4.4. `freezeTarget()` is private to `managed.ts`, so the choice is made there. `managedSignal(source)` returns the cut-only `new ManagedPromise(t, undefined)`, which uses the target's shared cut, when `freezeTarget()` is defined, and `new ManagedPromise(undefined, source)` otherwise. Cut-only is exact for a freeze awaiter: delivery is what resolves `deliveredResolvers`, and delivery cuts a freeze awaiter instead. The same holds for `restore`, because `applied` is set whenever a non-observe node is delivered. A call after delivery takes the applied path either way. §1.1, §1.8, §2.4 and §4.6 now use it. Test: `managed.test.ts` (7) "managedSignal (interrupted())".
- **D-67 (impl) Three more shapes are unsupported in a `freeze` body (amends D-64).** (a) *A consuming `deliver` under a combinator whose sibling can be cut.* Take `Promise.allSettled([join(f1), join(f2)])` or `Promise.all([result(f1), result(f2)])`. When `f1` fails, its wrapper's `deliver` (`take()`, or `result`'s step) runs `f1.consumeFailure()` and hands the error or outcome to the combinator, which keeps waiting. A delivery that then cuts the second wrapper freezes the body, and the combinator never settles. `f1`'s record has left `N.unconsumed` without reaching anyone, which breaks I11 and reopens the gap D-38 closed. D-64 therefore drops `Promise.allSettled` from its supported shapes and limits `Promise.all` to members whose `deliver` consumes nothing unless it throws: a throw rejects the `Promise.all`, so the body sees it. A `Promise.all` that rejects has a second defect besides the stale arm: a later failing member's `deliver` still runs and consumes into a combinator that ignores it. Multi-member waits whose members can fail belong in ramme's `all`/`race` (D-51), whose group fiber joins its members itself. Making consumption tentative while sibling cells of the same target are armed would be a model change, and is not taken. (b) *A `.then`/`.catch`/`.finally` attached to a managed promise without awaiting the result at once*, e.g. `const p = join(f); p.catch(() => {}); …`. The attachment is a `then` call. Before delivery it arms the cut, and a delivery during a later bare await counts the running body frozen (the D-64 harm). After delivery it reaches the applied path; D-68 keeps that path out of the body's synchronous code. Await the wrapper directly and transform the value afterwards. (c) *A managed promise awaited by a body other than the one that created it*, e.g. a single-flight cache where body A runs `cache.set(k, call(load))` and body B awaits `cache.get(k)`. The target is fixed at creation (§2.4 property 1), so a delivery to A cuts B's continuation without counting B frozen. B never resumes, and B's owner's release waits on it forever. A is counted frozen although it is not suspended on the wrapper. A managed promise is awaited only by the body that created it; D-68's dev check reports the other case. **S1 obligation:** the D-64 settle-after-frozen warning names these shapes too. `node-core.test.ts` adds a real-node case for each, listed under *freeze* in §6.1; the (a) case pins today's loss, so a later model change is visible. S4's docs list all of D-64's unsupported shapes. Tests: `managed.test.ts` (6) "unsupported (D-67)", three cases.
- **D-68 (impl) The applied path counts the body frozen one microtask later, under `NO_NODE`, and `then` reports a foreign awaiter in dev mode.** §2.4's `then` calls `t.markFrozen()` synchronously when the target is applied. `await`, the combinators and an async `return` call `then` from a job, after the body has suspended. A `.then`/`.catch`/`.finally` the body attaches itself calls it inside the body's synchronous code. There `markFrozen()` → `onBodyExit({ kind: 'frozen' })` → the release loop could dispose the body's resources before the attaching call returns, and could even complete the node, so the body's next `own()` would throw `NodeCompletedError`. The applied path now runs `queueMicrotask(() => t.markFrozen())` inside `runInFrame(NO_NODE, …)`, because S1's `onBodyExit` must not run under the body's frame (D-46). For a direct await, nothing changes except one microtask. For an attachment followed by a managed await (`p.catch(noop); use(conn); await call(x)`), the body is suspended for good by the time the owner releases, so that shape is harmless. Followed by a bare await, it is still the D-67 (b) shape. A synchronous body that attaches and then returns now settles `returned` before the queued freeze, which `bodyDone` turns into a no-op. The cut path, where `fire()` runs `onApplied`, stays synchronous: law 4 releases in the delivery's tick. Separately, in dev mode (D-26), `then` on a targeted wrapper warns once per creating node when the current node is a different node with a body (D-67 (c)). The thenable job of `await` and of the combinators runs in the awaiter's frame, so the check is exact for them. A `then` under no node is not reported, because `startBody` subscribes to a synchronous body's returned wrapper under `NO_NODE` (D-46), and that is the creator's own await. A wrapper awaited from top level or a platform callback is therefore unsupported but not reported. `FreezeTarget` gains optional `id` and `name`, read only for the message. Tests: `managed.test.ts` (2) "calls markFrozen once, a microtask later under no frame" and "a .catch the body attaches after delivery", and (9) with deferred counts; the foreign-awaiter warning is asserted in (6) "a wrapper awaited by another body".
- **D-69 (impl) The release loop calls `finishCompletion()` in the step that finds both stacks empty.** §4.2 chained `done.then(() => this.finishCompletion())` on the promise `releaseLoop()` returned. That promise resolves only after every nested `r.then(step)` has adopted its successor, which costs several microtasks per async release. Between the last `hasPending()` miss and `state = 'complete'`, the node is therefore still `'releasing'` and `assertOpen` passes (I8). An `own(tmp)` from a continuation in that microtask drain, such as a fiber holding the node as `ctx` or a D-64 frozen-but-running body, pushes a live entry. `finishCompletion` never releases it (P1/I2), and a later `release(tmp)` throws `NodeCompletedError`. Now `step` calls `this.finishCompletion()` itself when no stack has a pending entry, `releaseLoop()` returns nothing, and `onBodyExit` and `abandon` call it without chaining. The check and the completion happen in one synchronous step, so no continuation can run between them. An `own()` that lands before the step is released, and one that lands after it throws `NodeCompletedError` (I7). A fully synchronous tree still completes inside `abort()` (D-25), and the loop no longer builds a promise chain. §4.2 and §4.10 (`abandon`) now use this form. **S1 obligation:** `node-core.test.ts` › *release loop* includes the case listed in §6.1.

S1 implementation (entries marked *(impl)*, as above):

- **D-70 (impl) S1 leaves an interim public surface so that all of `src/` type-checks.** §7 S1's "typecheck … for `src/` minus `.old` files" includes `fiber.ts`, `index.ts` and `provider-util.ts`, which S3 and S2 own and which no longer compiled once `context-impl.ts` and the old `inject.ts` were gone. S1 therefore writes `fiber.ts` as §1.12's `task()`/`TaskImpl` with a *private* `requireCurrent` (§1.13's, reading `currentFrame()`; `TaskImpl.call` throws `CreationViolationError` in a creation frame first, as §1.13 says the free `call` does), writes `index.ts` as §1.15 minus the `ambient.ts` exports (S3 adds them, and moves `requireCurrent` to `ambient.ts`), and removes `resourceProvider` and its imports from `provider-util.ts` (§1.15's one-line change, taken early). S1's tests stand in for `current()` with `here()` (`src/test/util.ts`, `currentNode()` that throws) and use the method forms, which is what the free functions are (`current().<method>(...)`, §3.1).
- **D-71 (impl) The birth rule applies to subscribed nodes only.** §4.1's constructor applies the rule to every node with a parent, but D-05 defines it as "delivered at birth iff the parent would have forwarded to it", and a parent forwards only to subscribers (§4.1). An unsubscribed node born under a delivered parent — `pool()`, a declared-placement value node on a delivered storage context — would otherwise be delivered at birth: a pool made by a delivered body would refuse every fork with `PoolClosedError` (D-16), contradicting I4 ("unsubscribed hear late") and §5.4 ("`pool` works" after delivery). Unsubscribed nodes hear at their turn in their owner's release loop. `own(fork(t))` is unaffected: a fork is subscribed at birth, so it is born delivered before `own` flips it, as the rule says. Test: `node-core.test.ts` › *the birth rule* › "unsubscribed nodes are not delivered at birth".
- **D-72 (impl) `call` also refuses a current node that is already lent.** §4.8 checks `assertNotLent` on the receiver only. Because `call` lends `current()`, not the receiver (D-03), `const p = other.call(a); other.call(b)` from body `Y` made two concurrent calls on `Y` — the very thing §7.11 exists to catch — while `other` itself was never lent; the second call silently overwrote `Y.lentTo`. `call` now runs `lender.assertNotLent('call')` too. The free form (`current().call`) is unchanged: there the receiver is the lender. Test: `lending.test.ts` "a current node that is already lent cannot make a second call through another receiver". *(Extended by D-120: `all` and `race` run this check with their own name.)*
- **D-73 (impl) `all` and `race` wait on their members' `completion`s through one managed await.** §4.8 awaits `Promise.all(fibers.map((f) => result(f)))` inside the group fiber, which is exactly the D-67 (a) shape the plan marks unsupported in a freeze body: a member that failed early is consumed by its `result` delivery, and a delivery to the group that then cuts the remaining members freezes it with that failure in no outcome (I11). The group body now awaits `managedFor(Promise.all(fibers.map((f) => f.completion)))` — one wrapper over never-rejecting sources, a direct await (D-64's supported shape) — and only after every member has completed reads the outcomes and consumes the failures it reports. A frozen group consumes nothing, so its members' failures surface from its completion (and from there through its caller). `race` resolves a single never-rejecting "first success or all settled" promise the same way, aborts the losers, awaits all completions, and consumes the losers' failures as §4.8's `result()` did. Results are unchanged in every undelivered case (tuple, `AggregateError` of every real failure, D-14's `FiberAbortedError`).
- **D-74 (impl) A throwing `NodeTopic` receiver is reported with `console.error` and the event dropped.** `emit` runs inside the constructor, `onBodyExit`, `releaseEntry.finish` and `finishCompletion`; a receiver exception there would leave a node half-completed (an unresolved `completion`, an entry never unlinked), turning a logging bug into a hang. §10 says a receiver costs nothing and D-45 calls it a sink; neither says what a throwing sink does.
- **D-75 (impl) NodeImpl shape choices.** (a) §1.9/§3.1 name both a field `pool: PoolState` and the `pool(opts)` method; the field is `poolState` (the `NodeInit` key stays `pool`). (b) `pool.ts` builds a pool's fibers with `pool.makeFiber(task, args, destination)`, so its `NodeImpl` import stays type-only (§1.1's graph); `fork` and `call` use the same method. (c) `timeoutMs` and the linked `opts.signal` deliver through `abortIfOpen` (no throw on a pending or complete node), and their timers, like the stall timer, are registered under `NO_NODE` (D-46). (d) `ownReleaseTimeoutMs`/`ownStallWarningMs` keep the node's own options so `fixTree` can recompute the inherited values at placement. (e) `frozen` records a `{ kind: 'frozen' }` exit for the D-64 settle-after-frozen warning. (f) `startBody` also catches a throwing `then` *call* on the body's returned thenable (a body failure, I10). (g) A fiber settled at birth (an already-aborted `opts.signal`, D-13) is not scheduled by `fork`, not admitted by `poolFork` (it completed before `pooled` was set, so the pool's counters never see it), and skipped by `refuseUnownedJoinForks` (its `body` is already nulled, D-53). (h) `run(fn)` skips the Q8 thenable probe when `fn` returns a node, because probing a fiber's `then` throws (D-29). (i) `[Symbol.dispose]` on a pending node throws `PendingNodeError` before the root check (a pending node also has no parent). (j) `abandon` on a live value node aborts it only while it is `running`.
- **D-76 (impl) No stall timer when the root has no receiver.** `armStallTimer` returns early when `root.receiver === undefined`: `node:stalled` is only an event, and a release fiber arms a timer on every release (D-55), which would put a `setTimeout` on every `own`/`release` in a tree nobody observes. §10: "No receiver, no cost." The receiver is always resolved by then (the root's own `node:created` resolves it, D-32).
- **D-77 (impl) S1 test-plan corrections.** (a) `events(root)` (§6) is `events(opts)`: a receiver must be a construction-time provider on the root (D-32), so the helper creates the root and returns `{ root, log, of(type), typesOf(id) }`; `withRoot(opts, fn)` is as §6 describes. (b) §6.1 *release loop*'s "a tree of nested `child()` and fiber entries whose subtrees complete synchronously" (D-25) is pinned with unstarted forks, which `abortInternal` settles synchronously. A fiber *suspended* on a managed await does not complete inside its owner's `abort()`: `fire()` works top-down, so the owner's bodiless exit reaches the fiber's entry before the fiber's own cut runs later in the same pass, and the owner's loop continues one microtask later. That is §4.1's order and is kept; D-25 promises synchronous completion only for synchronous bodies. (c) Tests that abort an observe fiber `tick()` first: an unstarted fiber settles `aborted` at abort without running (D-13), which would otherwise interrupt its subscribers at once. (d) `pool.test.ts` places "a DI value on the pool" with a providers-only `factoryProvider` on the pool, as S1's stub supports; the constructor-path fiber-set ports wait for S2.

- **D-78 (impl) Millisecond options are checked at construction, and `Infinity` means no timer.** `NodeOptions` types `timeoutMs`, `releaseTimeoutMs` and `stallWarningMs` as `number`, and §4.1/§4.3 hand them to `setTimeout` and `AbortSignal.timeout` as they are. `AbortSignal.timeout` throws `RangeError` for anything that is not an integer in [0, 2^32 − 1] (`Infinity`, `NaN`, `1.5`, `-1`), and it threw inside `releaseEntry`, which is documented as never throwing, after the entry was marked `'releasing'`. A synchronous `close()`/`abort()` then threw with the node stuck in `'releasing'`. An async body exit turned into an unhandled rejection (I10) and a node that never completes (I2, §5.6). Node also clamps any `setTimeout`/`AbortSignal.timeout` delay above 2^31 − 1 to 1 ms, so `timeoutMs: Infinity` or a multi-week timeout aborted the node at once. `Infinity` is the natural "none" here, since `stallWarningMs` already documents it as "disables" (D-27). The `NodeImpl` constructor now validates all three options before it emits or attaches anything: each must be `undefined`, `Infinity`, or a number in [0, 2^31 − 1]. Anything else throws `TypeError` at the call site (`fork`, `call`, `child`, `pool`, `createRootContext`), as `PoolState` does for `concurrency`. Fractions are accepted. `Infinity` arms no `timeoutMs` timer, and no release deadline: a release fiber gets `AbortSignal.timeout(Math.ceil(ms))` only for a finite value (§4.3's `deadline`). `Infinity` is stored, not normalised to `undefined`, so a child's `releaseTimeoutMs: Infinity` overrides an inherited finite deadline. `releaseEntry` computes the deadline before it touches the entry. Finite values above 2^31 − 1 are refused rather than chained across several timers. Nobody needs a 25-day node timeout, and refusing keeps every timer a single `setTimeout`. Tests: `node-core.test.ts` › *delivery* "millisecond options are checked at the call site", "timeoutMs: Infinity arms no timer", "releaseTimeoutMs: Infinity is no deadline …".
- **D-79 (impl) `'link'` and owned-fiber (C5) escalation abort the parent while it is open, not only while its body runs.** §4.2 and §4.5 abort the parent only when `parent.state === 'running'`. Under `close()` (or `childrenOnExit: 'await'` once the owner's body has exited) the parent is `'releasing'` and waits on its children. A `'link'` fiber failing then left every sibling waiting forever, and `close()` never settled. §7.4 says `'link'` "aborts the parent immediately", and C5/§9.3 apply "while its owner is open". Everywhere else "open" means "not complete" (I7, §6.4), not "body still running". Both escalations now call `abortIfOpen` (state neither `'pending'` nor `'complete'`), which replaces §1.9's `abortIfRunning`; the timer and linked-signal sources already used it (D-75(c)). `abortInternal` on a releasing node delivers its remaining subscribed subtree, which is what D-11's "a later abort wins" relies on. Remaining unsubscribed entries are then aborted with the escalated reason (`releaseNodeEntry` reads `owner.delivered`). Tests: `outcome.test.ts` › *failure destinations* "'link' interrupts a parent that is closing …" and "an owned fiber that fails after its owner's body exited under childrenOnExit 'await' …".
- **D-80 (impl) `finishCompletion` finishes its bookkeeping on the parent before anything can complete the parent.** §4.5 called `p.abortIfRunning(err)` before `p.unconsumed.add(record)`, with the child still in `p.subscribers` and its entry still `'live'`. A bodiless parent completes inside that abort: its loop releases the already-complete child's entry synchronously (D-25) and finishes with an empty `unconsumed`. A `'link'` or owned fiber whose body succeeded and whose release failed therefore lost its failure (I11, §9.4). The parent's delivery also re-marked the complete child and emitted `node:delivered` after its `node:complete`. A handler that aborted its parent or pool and then threw lost its exception the same way: it was pushed on the `extraErrors` of a completed parent. The order is now: (1) clear the lending pair and remove the child from `p.subscribers`; (2) for a handler destination, turn a `'live'` entry into a release in flight (`holdEntry`: `'releasing'` plus a fresh `e.done`) while the handler runs, record a throw on `p.extraErrors`, then release the entry. An owner loop that the handler itself starts waits on `e.done`, as for an early release (C7, D-36), so the owner completes one microtask after the handler instead of inside it. Otherwise add the record to `p.unconsumed`; (3) unlink the entry if it is still live, run `poolChildComplete`, emit `node:complete` and resolve `completion`; (4) last, the `'link'`/C5 escalation `p.abortIfOpen(err)`. `abortInternal` is also a no-op on a complete node, so no path can deliver to one. Tests: `outcome.test.ts` › *failure destinations* "a 'link' fiber whose body succeeds and whose release fails surfaces from a bodiless parent …", "an owned fiber whose release fails … child() owner …", "a handler that aborts its pool and then throws …". *(Amended by D-119: `poolChildComplete` now runs in step (1), before a handler runs, so a pool's `onFailure` sees the failed fiber's slot free.)*
- **D-81 (impl) A pool's delivery settles its queue, and a waiter leaves the queue when it settles.** D-47 says an aborted pool "settles each waiter `aborted`" through its loop. Its loop cannot reach waiters it has already passed. `pool.close()` makes the loop `closeInternal` the top waiter, which only sets `closeRequested` (the waiter still starts as a slot frees), and the loop parks on that waiter's completion. A later `pool.abort()`, or the owner's close/abort reaching the unsubscribed pool, then delivered the waiters, but `fire()` skips unstarted bodies, `abortInternal`'s tail skips a releasing pool, and `poolChildComplete` starts nothing once the pool is delivered. The waiters never started or settled, and the pool and its owner never completed. That is the ordinary "graceful close, then force" pattern. Now `fire()` pass 2b calls `poolDelivered(pool)` after the pool's own bodiless exit, and it aborts every waiter still queued (newest first), which settles it `'unstarted'` (D-13). Separately, `poolChildComplete` used to drop a waiter that had settled (`bodyDone`) but not completed (its own release still in flight) from `waiting` without counting it. Its later completion decremented `running` below zero, and the concurrency limit then admitted one fiber too many. A waiter now leaves `waiting` in `onBodyExit` when it settles `'unstarted'` (`poolChildSettled`), and it is unpooled (`pooled = false`). `pending` drops at once, and only admitted fibers ever reach `poolChildComplete`, which is now just "`running--`, then admit while slots are free unless delivered". §1.10 gains `poolChildSettled` and `poolDelivered`. Tests: `pool.test.ts` "close() with waiters queued, then abort() …" (both forcing paths) and "a waiter that settles unstarted leaves the queue at once …".
- **D-82 (impl) A node marked by a delivery whose pass 2 is still running is exited by that pass, after its signal.** Take `abort()` (or `close()`) on a node that pass 1 has marked but pass 2a has not fired yet. That happens when an abort listener on a sibling re-enters, e.g. `A.signal` → `B.abort()`. The call found `delivered` set, skipped the delivery, and ran the tail: a bodiless `B` released and completed before `B.signal` fired. The order became `entry:released` → `node:complete` → `node:delivered`, a release that picks graceful or forced by its owner's signal took the wrong path, and listeners on `B`'s subtree ran after the subtree was released (§5.1 step order). The plan's test only asserted that no second `node:delivered` was emitted. Each node now carries `firePending`, set by `deliver()` and cleared after pass 2a fires the node. While it is set, `abortInternal` returns at once, because pass 2b will exit the node; a bodiless `close()` (`requestClose`) skips its `'await'` exit too, so the abort wins (D-11). For an unstarted body, `abortInternal` sets `cancelOnFire`, and pass 2b settles it `'unstarted'`, so D-13 still holds for a direct abort. An owner loop that reaches such a node meanwhile waits on its `completion`. Tests: `node-core.test.ts` › *delivery* "B.abort() from A's listener releases B only after B's signal fired …", "close() of an already-marked node from a listener …", "an unstarted fiber aborted from a listener while its delivery's pass 2 runs still never runs".
- **D-83 (impl) A body that returns a node other than a fiber returns it as its value.** §4.2's `startBody` throws `FiberNotAwaitableError("… returned a fiber")` for any `isNodeImpl(r)`, so `call(() => ctx.child())` failed while `call(async () => ctx.child())` resolved with the child. D-49 defines the rule for "a body that returns a fiber" and says "sync and async bodies therefore agree". `startBody` now throws only for `kind === 'fiber'` and skips the thenable probe for any node, as D-75(h) does for `run` (a non-fiber node's `then` is `undefined`). Test: `node-core.test.ts` › *bodies and messages* "a body that returns a context or a pool returns it as its value …".
- **D-84 (impl) Managed awaits register their source reactions outside the awaiting body's async context (amends D-61, §1.4, §1.5, §2.4 property 4).** A cut emptied every cell (A2), but the reaction `#listen` registered on the source captured the async context `then` ran in. Under AsyncContextFrame that is the body's frame, `{ node: B }`, plus every user `AsyncLocalStorage` value. The cut wrapper also kept `#target`. A frozen joiner of a long-lived fiber, a caller frozen on `call(longChild)` or on `managed(slowP)`, therefore retained its node and its whole async context, request objects included, until the source settled: a long-lived service fiber grew without bound under aborted requests. Changes: (a) `ContextStorage` gains two optional members. `snapshot()` returns a runner that re-enters the whole current context; `runDetached(fn)` runs `fn` in the context the adapter was loaded in. `node.ts` implements them with `AsyncLocalStorage.snapshot()` (per call, and once at import); `async-context.ts` uses `AsyncContext.Snapshot` when the platform has it. `context-storage.ts` exports `ContextRunner`, `captureContext()` (the adapter's snapshot, else a runner over ramme's current frame) and `runDetached()` (else `run(NO_NODE, fn)`; a direct call without storage). (b) `#listen`, and the applied path's "mark `p` handled" reaction (D-63), register under `runDetached`. (c) Each cell keeps `captureContext()` from `then`, and `#settle` runs `deliver` and the callbacks inside it, so a `.then(cb)` still runs in the context `then` was called in, user values included, with unchanged timing. A cut empties the cell and so frees that context. (d) `#onCut` drops `#target`. A `then` on a wrapper that was already cut therefore neither subscribes nor counts the target frozen again; the target is already frozen, and `markFrozen` is idempotent on a real node. `managed.test.ts` (14) now expects one `markFrozen` there, not two. The alternative of resolving a private promise per cell, whose native reaction carries the context, added a microtask between delivery and the callback. That changed D-61's "a delivery from the first continuation cuts the second", so it was not taken. Tests: `freeze-gc.test.ts` "the frozen node itself is collectable while the foreign fiber it joined still runs" and "a frozen body's async-context values are not retained by a pending managed(p)"; `managed.test.ts` (15) "deliver and the callbacks run in the context `then` was called in …".
- **D-85 (impl) `call` lends nothing to a child that settled at birth (amends D-75(g)).** §4.8 lends whenever `lender && lender !== child`. A call child built with an already-aborted `opts.signal` has already run `finishCompletion` in its constructor (D-13), so nothing would ever clear `lender.lentTo`. Every later body-shaped operation of the caller would throw `UnawaitedCallError`. `call` lends only when `child.state !== 'complete'`. This is the fourth settled-at-birth case, after `fork`, `poolFork` and `refuseUnownedJoinForks`. The awaited result is then `FiberAbortedError` (`take`). Test: `lending.test.ts` "a call whose child settled at birth (an already-aborted signal) lends nothing".
- **D-86 (impl) `interrupted()` is cut-only only when the awaiting body is the receiver (amends D-66).** D-66 made `interrupted()` cut-only whenever `freezeTarget()` is defined, because "delivery is what resolves `deliveredResolvers`, and delivery cuts a freeze awaiter instead". That holds only when the receiver is the awaiter. A freeze body awaiting another node's interrupt never woke: `root.call(async () => { await other.interrupted(); … })` followed by `other.abort('stop')`; the same from a subscribed fork, whose owner's `close()` then waited forever; `c.interrupted()` on a `c` that was already delivered; and the §6.6 reaper `svc.own(svc.fork(async () => { await svc.interrupted(); … }))`, which is unsubscribed, so `svc`'s delivery does not reach it: it never woke, and at its turn it was aborted and frozen. The receiver's delivery settled a source the cut-only wrapper does not hold. That broke §3.1 (`interrupted()` is the receiver's signal as a promise), §4.2/§4.3 (a managed await never settles only when the *awaiting* node is a delivered freeze node) and §5.6. `managedSignal(source, receiver)` now takes the receiver. It returns the cut-only wrapper only when `freezeTarget() === receiver`; otherwise it returns `new ManagedPromise(freezeTarget(), source)`, the wrapper `managedFor` builds. So the receiver's delivery resumes a foreign awaiter with the reason, and only the awaiter's own delivery cuts it. D-66's retention argument still holds for a loop over the body's own `interrupted()`. A `Promise.race` over a foreign `interrupted()` holds one cell until the receiver is delivered, which is D-64's documented sourced-loser growth; `Promise.race` is unsupported in a freeze body anyway. §1.8 and §2.4 now carry the two-argument signature. Tests: `managed.test.ts` (7) "managedSignal (interrupted())" (the foreign-receiver case); `node-core.test.ts` › *freeze* › *interrupted() of a node other than the awaiting body* (the method form before and during the delivery, from a call child and from a subscribed fork; the owned reaper behind a slow entry).
- **D-87 (impl) The restore birth rule walks subscription edges only (amends D-05, §3.3, §4.1).** §3.3's `anyAncestorDelivered(parent)` and §4.1's `nearestDeliveredAncestor(parent)` walk to any delivered ancestor, across unsubscribed edges. Probe: `pool = root.pool(…)`, then `root.own({}, async () => gate)` above it, then a restore fiber `R1` forked into the pool, then `root.abort()`, then `R2` forked into the pool. `R2` was born delivered, frozen at its first managed await and aborted, while `R1` and the pool kept running until the pool's turn. That broke I4 ("unsubscribed hear late"), D-05/D-71 ("delivered at birth iff the parent would have forwarded to it", and an undelivered pool forwards nothing), and it reintroduced the before/after-shutdown order dependence D-05 rejects. The walk (`deliveredOnSubscriptionPath`) now returns the first delivered node on the path up from the parent. It returns `undefined` after the first unsubscribed node it checks, because that node's own parent would not have forwarded to it. A restore fiber forked inside a release fiber, or under a placed value node, is covered the same way: both are unsubscribed. A restore node under an undelivered freeze node under a delivered observe node is still delivered at birth, because those edges are subscriptions. Test: `node-core.test.ts` › *the birth rule* › "restore: the walk follows subscription edges only …".
- **D-88 (impl) The method-form managed awaits also refuse a lent current node (extends D-72).** `join`, `result`, `interrupted`, `never` and `managed` checked `assertNotLent` on the receiver only. In body `Y`, `const p = call(slow); await other.join(f)` therefore proceeded while `Y` was lent, and `Y` was suspended on two things at once: the forgotten-await case §7.11 and I26 exist to catch. The same `await join(f)` on `Y` itself threw `UnawaitedCallError`. The await belongs to `current()`, whose freeze decision it is (§4.3), as D-72 found for `call`. These five now also run `currentFrame()?.node?.assertNotLent(op)` after the receiver's guards (`assertAwaitShaped`). `own`, `release`, `abort`, `close` and `[Symbol.asyncDispose]` stay exempt (§7.11). `all`/`race` already reach the check through `call`. `fork`, `child`, `pool`, `get`, `run` and `runSync` act on the receiver and are unchanged. Test: `lending.test.ts` "a lent current node cannot make a managed await through another receiver either …". *(Amended by D-116: in a failure handler's frame only the receiver is checked, as for `call` there; D-120: `all`/`race` report their own name.)*
- **D-89 (impl) `releaseEntry`'s completion step never throws and always settles `e.done` (§4.3).** §4.3 builds `entry:released` with `String(rf.outcome.error)`, and it evaluates that even when the root has no receiver. A release error with no prototype (`Object.create(null)`), or one whose `toString`/`Symbol.toPrimitive` throws, made it throw after the entry was marked `'released'` and before `resolve()`. A synchronous release threw `TypeError` out of `abort()` (through `releaseLoop`, `onBodyExit` and `fire()`, so the delivery's remaining marked nodes were never cut or exited), and the owner stayed `'releasing'` forever. An asynchronous one made `rf.completion.then(finish)` reject unhandled and left `e.done` pending, so the owner never completed. The same throw reached the start and freeze microtasks, the body-settle reaction and `releaseAll`'s `run()`, which D-38 requires never to reject. That broke §4.3 ("never throws"), I2, I10 and §5.6. `finish` now stringifies with `errorText` (`String(x)`, else `Object.prototype.toString.call(x)`, else a fixed text) and runs inside `try { … } finally { resolve(); }`. The entry is released before the event is built. The alternative, computing the text before the entry changes, was not taken: a loop that finds an entry `'releasing'` waits on `e.done`, so a throw between a settled `e.done` and the state change would spin the owner's loop. Tests: `node-core.test.ts` › *release errors that String() cannot convert* (sync and async, with and without a receiver; a null-prototype object and a throwing `toString`).
- **D-90 (impl) A delivery that arrives after the body exited is forwarded as a normal delivery, and it wins over an `'await'` exit (amends §4.1 `deliver`, D-11, D-79).** §4.1 forwards an observe node's delivery restore-only. Take an observe node whose body exited, or whose bodiless exit ran, under `'await'` (`close()`, or `childrenOnExit: 'await'`). A later `abort()`, or D-79's `'link'`/C5 escalation, then marked the node and passed its freeze subscribers through unmarked. Its loop was closing those subscribers, so a freeze fork suspended on a managed await never finished, and the node stayed `'releasing'` forever. Two probes showed it: `A = child({ interrupt: 'observe' })` with a `'link'` fork awaiting `never()`, then `A.close()`, then `A.abort()`; and an observe fiber with `childrenOnExit: 'await'` whose `'link'` fork fails after the body returned while a freeze fork still runs. §5.1 step 1 fires the interrupt to every subscriber on `abort()`, D-11 says a later abort wins, and D-79 relies on `abortInternal` on a releasing node delivering its remaining subscribed subtree. Restore-only forwarding exists so that the observe body can decide for its subtree, and once the body has exited there is no body to decide. `deliver` now uses `nextRestoreOnly = mode === 'observe' && !bodyDone`. It also sets `exitKind = 'interrupt'` on a node, of any mode, whose body exited under `'await'`, so node entries still ahead in its loop are aborted, not closed. Tests: `node-core.test.ts` › *the lifecycle table* "close(), then abort(), on an observe node whose bodiless exit was 'await' …"; `outcome.test.ts` › *failure destinations* "'link' escalation into an observe parent whose body exited under childrenOnExit 'await' …".
- **D-91 (impl) D-82's guard lasts until pass 2a has fired every node of the delivery, and `close()` on a delivered bodiless node is an interrupt (amends D-82, §4.6 `requestClose`).** D-82 cleared `firePending` right after pass 2a fired each node. With `A`, `B1` and `B2` marked, a `B1` listener calling `A.abort()` (`A` was fired before `B1`) exited `A` at once, and `A`'s releases ran while `B2.signal` had not fired yet. That is the §5.1 "signal, then release" order D-82 meant to restore. `requestClose()` skipped its guard in the same window. On an observe `A` with a restore child `R`, an `R` listener calling `A.close()` exited `A` under `'await'`, `A`'s freeze fork was never interrupted, and `A` stayed `'releasing'` forever. `fire()` now clears `firePending` for every marked node at once, between 2a and 2b. The report's proposal, keeping the guard until 2b has processed each node, was not taken. In 2b a node's own exit runs its loop, which calls `abortInternal` on subscribed children that 2b has not reached yet. They would then wait for their 2b turn, so `abort()` of an all-synchronous subtree would stop completing synchronously, breaking D-25 and `runSync`. Once 2a has finished, every signal of the delivery has fired, so an exit triggered by user code in 2b (a release, or the releases a cut starts) still keeps §5.1's order. One gap remained in the 2b window: `close()` on a delivered observe node that had not exited yet still chose `'await'`. A bodiless node born delivered (D-05) is in that state for its whole life. `requestClose` now exits a delivered bodiless node with `'interrupt'`: the abort came first and wins (D-11), as it does at a fiber's body exit. Tests: `node-core.test.ts` › *delivery* "an abort() of an already-fired ancestor from a later-fired subscriber's listener …" and "a close() of an already-fired observe ancestor from a later-fired restore subscriber's listener …"; *the lifecycle table* "close() of an already-delivered bodiless node is an interrupt …".

Fixes in S1 that needed no deviation: `inject()` outside creation now throws `CreationViolationError` whose message starts with §5's text, "inject() outside creation" (the key's name follows). `release(x)` for `null`, `undefined` or a primitive reaches its `NotOwnedError` instead of failing in the message builder. The I8 test now exercises `call` on a delivered freeze node from outside and from inside its body.

S2 implementation (entries marked *(impl)*, as above):

- **D-92 (impl) A scoped cache hit is served only to a requester whose nearest owner of that scope is the storage context (amends §4.10 `resolveFrom`, §1.6).** §4.10's walk serves the first cache hit on the path. A scoped value is cached at its scope owner `T`, so a requester `R` below a *nested* owner `T′` of the same scope, on `[R, T)`, walked past `T′` (nothing cached there yet) and was served `T`'s value. `outer.get(ID)` then `inner.child().get(ID)` handed the inner request the outer request's ID. For a SelfScope key under two `[SelfScope]` boundaries, `root.get(K)` then `child.get(K)` handed the child the root's instance; the ported test "should not hoist past the SelfScope boundary" passes only because it resolves the child first. The answer depended on resolution order, against §8.2 ("every order of resolution ends in the same state") and I19. It also broke the plan's own D-44 test: `V`'s re-creation from the nested owner `C` resolves `D` through the same walk, gets `T`'s `D`, lands back on `T`, and D-21 discards it, so `C` was served `V@T` (verified by disabling the rule: the D-44 case and the three below fail). `CacheEntry` gains `scope`: the effective scope (`p.scope ?? getKeyScope(key)`) a scoped value was stored under, `undefined` for unscoped providers and auto-hoisted values. On a hit with `scope` set and `R.findScopedContext(scope) !== C`, the walk returns `resolveScoped(R, key, scope, providerFrom(C, key))`, which creates at `R`'s own owner. `providerFrom(C, key)` is the first provider from `C` upward, the one that built the hit. Unscoped explicit hits and auto-hoisted hits are unchanged. The cost is one `findScopedContext` walk per scoped hit. §1.6 and §4.10 now carry it. Tests: `placement-view.test.ts` › *scoped cache hits are served only to requesters of the same scope owner* (three cases) and *deps(V)* › the D-44 case.
- **D-93 (impl) `shadowBetween`'s scope rule uses a dependency's effective scope (amends D-44).** D-44 says provider-level scopes "are already caught by the provider check". That holds only for a provider on `[R, S)`. A provider declared `{ scope: σ }` at or above `S`, the usual place being the root, leaves `getKeyScope(d)` undefined. A nested σ-owner between `R` and `S` was then no shadow: `V@r1`, built from `r1`'s `D`, was served under a nested σ-owner `r2` whose own view of `D` is `r2`'s (by D-92). `shadowBetween` now uses `σ(d) = providerFrom(S, d)?.scope ?? getKeyScope(d)`, the scope under which `R`'s walk resolves `d` once no provider for `d` sits on `[R, S)`, which is checked first. It is computed lazily, only at contexts with a `scopeSet`, and memoised per call. §4.10 now carries it. Test: `placement-view.test.ts` › *deps(V)* › "a provider-level scope is a scope shadow too, wherever the provider sits (D-93)".
- **D-94 (impl) S2 shape choices in `inject.ts`.** (a) `createExplicit` re-checks `S` after the factory. A factory that completes its own storage context (for example by calling `S.abort()`) would otherwise cache on a complete node. It now throws `NodeCompletedError` and abandons the node, as `createAutoHoisted` does (§6.2). The check goes through an `isComplete(n)` helper, because TypeScript narrows `S.state` across the factory call. (b) A SelfScope inner creation delegates `inject` and `node()` to the outer creation state, and shares its `slot` and `selfCache`. Delegated `inject` includes `ContextKey` and `skipSelf`; for `skipSelf` the inner sets its own `cycleExempt`. §4.10 wrapped `outer.inject(k, undefined)` as a result, which dropped `skipSelf` and the options, and named the shared node after the inner key if the inner materialised it first. Sharing `selfCache` makes a SelfScope key that both the value and its SelfScope helper inject one instance per creation. (c) `resolveSelf` returns `{ resolved: false }` for a key with neither provider nor default factory. `inject(K, { optional: true })` then works, and `inject(K)` throws the usual `No provider found for K` (§4.10's `throwNoProvider`). (d) `resolveScoped`'s hit at `T` applies the I22 check (D-22), as the walk's hit does. §4.10 now carries (a)–(c). Tests: `creation.test.ts` › "the same for a declared placement whose factory completes its storage context (D-94)", *SelfScope attachment*.
- **D-95 (impl) S2 test-plan corrections.** (a) S2 and S3 run in parallel (§7), so S3's `ambient.ts` does not exist while S2 runs. Several §6.1/§6.2 cases are about the free functions themselves: `lookup` in a factory, and `own` outside creation. `src/test/ambient-shim.ts` provides `lookup` and `own` with §1.13's semantics. For `lookup`, a creation frame throws `CreationViolationError` first. With no frame, both throw `NoCurrentNodeError`. Otherwise each calls the method on the current node, and `own` materialises the pending node. The S2 suites import both from the shim; everything else uses `here()` and method forms, as S1's suites do (D-70). S4 points the imports at `./ambient.js` and deletes the shim. (b) `di.test.ts` holds the 129 ports, the 4 `captureAutoScoped` ports (§6.2 places them there), and one added case for flip 6, which had no old test because nothing read through `lookup` in a factory. Flip 5 is a lifecycle-events flip and belongs to S4's `node-topic.test.ts`. (c) The old `unregister()` tests (*Disposal › sync*, *RegisterResource*) now assert `['removed', 'kept']`. There is no bare detach, so `release(x)` runs the release now (§6.1, C7). (d) ContextRef's "lookup() outside creation" becomes: `inject(ContextKey)`, and `root.get(ContextKey)` with no current node, throw `CreationViolationError` (D-18). The free `lookup(ContextKey)` there throws `NoCurrentNodeError` first (§1.13); that case is S3's. (e) The fiber-set ports drop `setScope(Worker, RootScope)`, so the pool is created on a pending node, as §6.2 says. A provided value's node is aborted at its turn (§5.6, D-11), so a fork that has not started when the root closes never runs. The first port keeps "close waits for the drain" by registering `own(() => pool.close())` after the pool; LIFO releases it before the pool. The others call `tick()` before closing. The `resourceProvider` ports own an object value, because `own` attaches objects only (§6.1).
- **D-96 (impl) Inside a creation, a SelfScope cache hit is per-creation (amends D-92, §4.10 `resolveFrom`).** `resolveScoped` makes SelfScope per-creation in a creation frame (§4.10, D-94). The walk's hit branch ran first, though. A SelfScope value cached at a `[SelfScope]` boundary `C` was served whenever `R.findScopedContext(SelfScope) === C`, which D-92's check accepts. Take `C = root.child({ scopes: [SelfScope] })`, `R = C.child()`, and `class V { self = inject(Self) }`. `C.get(Self)` then `R.get(V)` handed `V` the boundary's instance and placed `V` at `C`. The reverse order gave `V` a fresh instance and placed it at `R`. This broke §8.2 ("every order of resolution ends in the same state") and I19. The hit branch now begins with `if (hit.scope === SelfScope && currentCreation()) return resolveScoped(R, key, SelfScope, providerFrom(C, key))`, which reaches `resolveSelf` as a miss does. D-92's own reasoning applies: the creation is a nearer SelfScope owner than `C`. Outside a creation the boundary is still the owner, unchanged. Tests: `placement-view.test.ts` › *a SelfScope key is per-creation inside every creation…* (two cases, both orders).
- **D-97 (impl) Requester-relative reads pin an auto-hoisted value at its requester (§4.10, §2.3, §1.6, §1.11).** Two reads in a default factory answer relative to the requester `R`, not to the storage context. (1) A per-creation SelfScope value: `resolveSelf` reports `node: outer.base` (= `R`), so `V` was placed at `R`. (2) A `skipSelf` read answers with `R.parent`'s view. Nothing stopped the walk from serving such a `V`, cached at `R`, to a descendant requester. For (1), `R0.get(V)` then `R.get(V)` shared `R0`'s `V`, and the reverse order gave two. For (2), `V` was placed at the deepest dependency (`R`'s parent), so its own storage context was served a value built from its child's view. Both broke §8.2 and I19. The pin is now a rule. `DepTracker` gains `pinned` and `pin(at)`. `skipSelf` in an auto-hoisted creation calls `pin(R)` (deepest = `R`), on a miss too. A per-creation SelfScope result carries `pinned: true`, and `track` sets `pinned` from any pinned result, so it is transitive through a pinned auto-hoisted dependency. `CacheEntry` and `ResolvedResult` gain `pinned`. In the walk, a hit on a pinned entry with `R !== C` counts as a shadow: `createAutoHoisted(R, key)`. Declared values are never pinned: their author answers for their view (§8.1). The alternative for `skipSelf`, refusing it in auto-hoisted creations with `CreationViolationError`, was rejected: the pin keeps a legitimate decorator default working. One consequence: a SelfScope-dependent auto-hoisted value resolved from a `runSync` node or a release fiber is created there, not served from the parent. Tests: `placement-view.test.ts` › *requester-relative reads pin…* (SelfScope, transitive, skipSelf; both orders each).
- **D-98 (impl) The hit branch checks liveness after the view checks (amends D-22, §4.10).** `assertLive` (I22) ran before `shadowBetween`. A released `V@root` (its node aborted, its cache entry kept) therefore made `child.get(V)` throw `NodeCompletedError` from a child that provides its own `A`, although §8.2 says such a cache "is not R's answer: V's factory runs from R". D-92 already put its scope check before liveness for this reason. The order is now: D-96, D-92, placement by view (shadow or pin, D-97), then I22, then `markDecided`. A requester whose own answer was released still fails loudly. Test: `placement-view.test.ts` › *the hit branch checks liveness after placement by view*.
- **D-99 (impl) A failed or refused creation's node is owned by the requester and aborted like a live node (amends §4.10 `abandon`, §2.3, D-69's abandon path; §1.9 signature).** §4.10 released a pending node detached: "nothing waits on it". Measured consequences: (a) an async release outlived `root.close()`, against §0 "ancestors outlive descendants", §5.6 "the parent does not complete until you do" and §6.4; (b) a release failure was lost, although a declared factory's identical one rejects `close()` (I11, §9.2); (c) a release fiber's `lookup` stopped at the parentless node ("No provider found"), against §5.2; (d) the node's own signal never fired, and subscribers were aborted one at a time at their LIFO turn, against I9/G4. Separately, no abandon path cleared `inCreation`. Every fork made later under the node, including by its own releases (`all()`, `fork` + `join`), was queued on `creationForks` and never started, so the release, and with it the storage context's completion, hung forever. `abandon(error, requester)` now does the following. It takes the queued forks and clears `inCreation`. A pending node is `placeAt` the requester, or, when the factory completed the requester, the nearest open node above it. The node emits `node:placed` with that host, and then it is `abortInternal(error)`, as a declared node is. Its outcome is therefore `aborted`, and only release failures are routed, to the host's `unconsumed`, since the factory's error is already rethrown. Finally the queued forks are scheduled as `finishCreation` schedules them, under `NO_NODE`. The abort's synchronous loop has already settled every fork it reaches, without running it (D-13), so a fork queued by a release that the factory started (`release(x)` before the throw) runs, and that release ends. The defect report suggested dropping the queued forks; that hangs exactly this release, which awaits one of them. The host's provided stack is the one used: the explicit stack stays what bodies attached, so `releaseAll()` never waits for it. I24's "only resolution attaches to the provided stack" still holds. With no open node left (the factory completed the whole tree) the node is released unowned. Tests: `creation.test.ts` › *a failed or refused creation is owned by its requester (D-99)* (async release holds `close()`, release failure surfaces in both placements, releases resolve through the requester, one delivery, the no-host case, `all`/`fork+join` in a release for both placements, a fork queued by an early release).
- **D-100 (impl) A declared value's node moves to the tail of `S.provided` when its creation ends (G3; amends §4.9, §4.10, §1.7 I5).** The node of a declared placement is live on `S.provided` from its first touch (§6.2). A factory that touches it (`inject(ContextKey)`, `own`, `fork`) before injecting a declared dependency on the same `S` therefore sat below that dependency, and was released after it: `Svc`'s release saw `Db` closed. That reverses G3 ("reverse creation order, which is dependency order"); auto-hoisted values were right because `placeAt` runs at the end. `finishCreation` now calls `n.moveToProvidedTail()` for a declared placement, which uses the new `Stack.moveToTail(e)`. The entry object and index slot are kept, and a non-live entry (S's loop already reached it) is left in place. The report suggested deferring the attach itself to the end of the creation. That was rejected: an unattached live node would let `S` complete during the factory (`S.abort()` there) without waiting for it, and the node would then be aborted with its parent complete, so its failures would be lost and its releases could not resolve: the D-99 hazard again. Tests: `creation.test.ts` › *a declared value that touches its node before injecting a declared dependency is released before that dependency*; `stack.test.ts` › *moveToTail…*.
- **D-101 (impl) A release started during a creation cannot re-enter resolution (extends D-17, D-21; §2.2, §2.3).** `release(x)`/`releaseAll()` in a factory (allowed, §6.2) runs the dispose in a release fiber whose frame carries no creation. From there `get`/`lookup`/`call`/`run` passed `assertNotCreating`, and the frame-chain cycle check saw nothing. A declared factory's own key resolved from that dispose re-ran the factory, and `createExplicit` then overwrote the inner instance (two singletons, I19). An unconditional `lookup` there recursed until the stack overflowed, and an overflow can leave `e.done` unsettled, so `close()` hung. Three changes. (1) `assertBodyShaped` (get, call, all, race, run, runSync) also refuses a current node whose `creationOwner()` is set, with `CreationViolationError`. Awaits (`join`, `result`, `interrupted`, `never`, `managed`) stay allowed: they enter nothing, and an async release may await. (2) `runCreation` marks the key on the resolution base (`NodeImpl.creating`) while the factory runs. A creation of the same key whose base is that node or below it is `Circular dependency detected`. This catches a re-entry through a release of a node that is not in creation (`other.release(x)` from the factory). A `skipSelf` read resolves strictly above its base, so the decorator pattern is unaffected. (3) `createExplicit` never overwrites. If `S` already caches the key, the new node is abandoned and the existing entry returned, as D-21 does for auto-hoisted values; with (2) this is a guard only. Tests: `creation.test.ts` › *a release started during creation cannot re-enter resolution (D-101)* (two cases).
- **D-102 (impl) A declared factory whose own node is released during the factory fails (extends D-94(a)).** D-94(a) re-checked only `S`. `inject(ContextKey).abort()` (or `.close()`) in the factory, or `S`'s release loop reaching the value's node while an older entry keeps `S` releasing, returned and cached a value whose owned resources were already released. The first caller silently received a released service, and the cache entry pinned `S` to it (I19 forbids re-creation). `createExplicit` now also refuses when the value's node is not `'running'` or is delivered. It throws `NodeCompletedError` ("… was released during its own creation") and caches nothing, so a later `get` runs the factory again. A pending (auto-hoisted) node cannot be aborted or closed (`PendingNodeError`), so only declared placement needs the check. Test: `creation.test.ts` › *a declared factory during which its own node is released fails…* (abort and close).
- **D-103 (impl) Release continuations never run in the frame that started them (extends D-46).** `releaseDeadline` created `AbortSignal.timeout` in the caller's frame, unlike every other timer ramme registers. Node dispatches the timeout's abort in the async context of its creation, so for `release(x)` in a factory a deadline that fired after the creation ran its listeners under the finished creation frame. There `inject()` worked at runtime (P5/I16), `lookup()` threw `CreationViolationError`, `current()` was the value node, and the timer kept the `CreationState` reachable. The same held for `rf.completion.then(finish)`, for `releaseAll()`'s async loop, and for the release loop's `then(step)` continuations, all registered in the caller's frame. All of them are now created under `NO_NODE` (`outsideFrames`). `releaseAll()` makes its managed await in the caller's frame as before (§4.3): only its source runs detached. Test: `creation.test.ts` › *release continuations of a creation run under no frame (D-103)* (release and releaseAll).
- **D-104 (impl) S2 test corrections after review (amends D-95(a)).** (a) `src/test/ambient-shim.ts` also provides `fork`, `pool` and `child` with §1.13's semantics (`requireCurrent(op).<method>(…)`). The creation trigger test exercises the free functions themselves; before, each trigger called `here()` first and so only repeated the `current()` case. (b) *SelfScope attachment* adds a case where the SelfScope factory touches the shared node (`current()` or `own`) before the outer value does. It asserts the node's identity, its name (the outer key), its placement with the outer value and the release order. With D-94(b)'s delegation in `CreationState.node()` removed, this case fails and the old one still passes. (c) `di.test.ts`: the two `setScope` tests assert where and how the value is stored (scope set, not auto-hoisted, a nested owner stores its own). The two structural-placement tests assert identity with the instance built inside `run`, not `toBeInstanceOf`. The `runSync` `skipSelf` test provides the key on the `runSync` node itself, so skipping it is observable.
- **D-105 (impl) A failed creation keeps its key until its node completes (amends D-99, D-101).** `runCreation`'s `finally` cleared D-101's mark before the `catch` abandoned the node, and D-99 then aborts that node synchronously. A release of the failed value that resolved the key again (`own(() => lookup(K, { optional: true }))`, then `throw`) therefore ran the factory again, which failed again and was abandoned again. With a sync release this repeated until the stack overflowed (336 runs). `root.close()` then never settled, because an overflow can leave `e.done` unsettled. With an async release it never stopped: each failure's release started the next creation. This held for both placements and broke I2, I10, §5.6 and the purpose of D-101. Two changes. (1) Every abandon in `inject.ts` goes through `abandonCreation(cs, error)`: the runCreation `catch`, and the refusals after it (§6.2 complete S, D-21, D-94(a), D-102, D-108). It sets `NodeImpl.failedCreation = cs.key`, which `finishCompletion` clears. It also keeps the key in progress in the tree (D-106) while `abandon` runs, and runCreation now clears its own mark only after the `catch`, so the abort's synchronous releases are covered too. (2) `assertNotReentered` walks up from `cs.requester`: a creation of `K` whose requester lies in the subtree of a node with `failedCreation === K` is `Circular dependency detected: K re-enters the failed creation of K at …`. A walk from the requester covers the site walk the report suggested, because the resolution base (R, or S on R's chain) never lies below the requester. A declared re-resolution (site S above the abandoned node) is caught by the same walk. Only the failed node's subtree is refused. A retry from the requester while that node is still releasing runs the factory again, as it did before. The release that re-entered fails once, and its error surfaces through the host's unconsumed records (§9.2), so `close()` rejects with it. Tests: `creation.test.ts` › D-99 › "a release of the failed value that resolves its key again…" (both placements, sync and async release: one run, `close()` settles) and "a retry from the requester while the failed value still releases…".
- **D-106 (impl) Keys in creation are marked per tree, not per resolution base (amends D-101 (2)).** D-101 marked the key on the creation's base and searched for it only from the new creation's base upward. A creation re-entered from a release of a node above the requester was not detected. In `req.get(V)`, V's factory calls `root.release(d)`, and `d` looks up `V`: the base is `req`, the release fiber sits under `root`, and no walk from it reaches `req`. The factory then recursed until the stack overflowed (324 runs). `req.get(V)` returned, `root.close()` never settled, and with a bounded counter D-21's misleading warning fired. `NodeImpl.creating` is now kept on the tree's root only. It holds the keys whose factory is running anywhere in that tree, SelfScope inner creations excluded, because they are per creation (§4.10). A creation of a key in progress is `Circular dependency detected: K re-enters the creation of K in progress in …'s tree`, unless the key appears in the creation's own frame chain. That case is the `skipSelf` decorator path, which the frame-chain check with `cycleExempt` already governs: a non-exempt occurrence has already thrown. Creations are synchronous (A5), so a creation of `K` that starts while `K`'s factory runs is nested in it on the call stack. It came either through the frame chain or through a frame that escaped it: a release fiber, or a failure handler run by a synchronous completion. The report's alternative, marking release fibers as under creation, misses the handler path and releases started from such a release. One consequence is stricter than D-101: while `K@C1` is being created, a release that resolves `K` through an unrelated provider in another branch (`K@C2`) is refused too. A release cannot know where an auto-hoisted re-creation will land until it has run, and a factory whose cleanup re-resolves its own key is the D-101 hazard. Tests: `creation.test.ts` › D-101 › "in a release of a node above the requester…" (handled and unhandled); the existing `other.release(x)` case now goes through this check.
- **D-107 (impl) A creation ends when its factory returns (extends D-46, D-103; amends §1.4, §2.1).** runCreation installed `{ node: undefined, creation: cs }`, and nothing marked `cs` finished. A continuation the factory registered (`queueMicrotask`, `promise.then`, `setTimeout`, all ordinary in a constructor) captured that frame and ran later inside the creation. There `own()` and `fork()` materialised a fresh pending node that was never placed, so the resource was never released and the fork never ran. `inject()` worked at runtime (P5/I16), and `lookup()` threw `CreationViolationError`. `CreationState` gains `ended`. runCreation sets it in a `finally` right after `produce` returns or throws, before any abandon. `currentFrame()` treats a creation frame whose creation has ended as no frame, as it treats `NO_NODE`. Such a callback then runs as a platform callback does, and each misuse is loud: `own`/`fork`/`lookup`/`current()` throw `NoCurrentNodeError`, `inject` throws `CreationViolationError("inject() outside creation …")`, and `peekCurrentNode()`/`managedFor` see no awaiting node. The report's other option was to have `CreationState.node()`/`inject()` throw an "ended" error. It was not taken: it would leave `currentCreation()` set in the callback, so `get`/`lookup` would report "during creation" at runtime and `managedFor` would treat the value node as the awaiter. This touches `src/context-storage.ts`, an S0 file outside S2's list, for one condition in `currentFrame`. One more consequence: under the D-103 mutations, a continuation registered in the creation frame no longer sees `currentCreation()`. Their remaining effect is retention, so D-103's new test probes retention with GC. Tests: `creation.test.ts` › *a creation ends when its factory returns (D-107)* (microtask with and without a materialised node: `own`, `fork`, `inject`, `lookup`; a promise continuation and a timer).
- **D-108 (impl) The scope rule is checked again when a pending node is placed (amends §4.10, §4.11, §5).** `assertProviderPlacement` finds the scope owner with `findScopedContext`, which walks `parent`. A pending value node has no parent until `placeAt`, so for a node built under it the walk stopped there and the rule passed. That covers `child({ providers })`, `child().addProvider(…)`, `fork(task(…, { providers }))`, a pool, and their descendants. After placement, the child's scoped provider built the value at the scope owner and cached it there: `root.get(K)` answered `'leaked'`, or, in the other order, `No provider found`. This broke §8.2 ("a provider below the context a scoped key resolves to is still an error"), §5 and I19. `misplacedScopedProviders(n, S)` walks `n` and the node entries on its stacks, recursively. For each scoped provider (SelfScope excluded, as in §4.11) it looks for the owner from the node up to `n`, then on from `S`. In `createAutoHoisted`, after the complete-S check and before the D-21 check and any caching, the first hit is thrown as the same `PlacementError` a live node gives, and the node is abandoned with it (D-99, D-105). A refused provider also must not serve the abort's releases. `abandon` therefore deletes every misplaced provider of a pending node against its host before `placeAt(host)`, so a child's release resolves the owner's answer, not one built from the child's provider. That applies to any failed creation, not only this refusal. The report's alternative, refusing scoped providers on any node whose chain ends at a pending node, was not taken. It is wrong where the owner sits between that node and the pending node, and where no owner exists at all; a live node accepts both. A declared value's node has a parent from its first touch and is unaffected. Tests: `creation.test.ts` › *a scoped provider built under a pending node is checked when the node is placed (D-108)* (five shapes, provider-level scope; key-level scope with the live-node control, at its own owner and with no owner; the abandon drop).
- **D-109 (impl) S2 corrections after the second review (amends D-94(b), D-104).** (a) `cycleExempt` was set for every `skipSelf` read, not only for one of the creation's own key, as §1.11 and the field's comment say. A real cycle through a `skipSelf` read of another key (`K → inject(J, { skipSelf }) → K`) re-ran `K`'s factory under the exempt frame and failed with `No provider found for J`. Only a `skipSelf` read of `this.key` is exempt now. In a SelfScope inner creation (D-94(b)) the inner frame exempts only its own key, and the outer exempts its own in its own branch. The flag is saved and restored rather than reset to `false`, so a nested exempt read cannot clear an outer one. (b) Test corrections; each was checked by the mutation the review named, which now fails it. The PendingNodeError case adds `join` and `result`. In the D-99 cases, the requester is a child that provides `Db` (`node.parent === R`, `'db@R'`), and the async-release case runs with a child requester too. The I9 case records `delivered` from the node's own listener. The two §6.2 releasing-storage cases assert that `Late`'s entry was on `provided` (from inside the release, and from its `entry:released` event, after `node:releasing { stack: 'provided' }`). The five `di.test.ts` scope-placement ports assert scope set and not auto-hoisted, with a non-root owner where the scope is not `RootScope`. D-94(c) has a case. `placement-view.test.ts` checks that `deps(V)` marks a SelfScope dependency and a `skipSelf` read. `stack.test.ts` tests `moveToTail` with a non-head foreign entry. The D-103 describe has a case that GC-probes the creation state's retention while an async `release`/`releaseAll` is still running, with a `NodeTopic` receiver that records `currentCreation()` for the release events emitted after the factory returned.

S3 implementation (entries marked *(impl)*, as above):

- **D-110 (impl) `index.ts` names the types of `context.ts` instead of re-exporting them with `export type *` (amends §1.15).** §7 S3's done criterion greps `dist/index.d.ts` once per name of §3.1, §7.1, §7.2, §7.7 and §9.6. tsc emits `export type * from './context.js'` verbatim, so the sixteen public types of `context.ts` (`Context`, `Fiber`, `Task`, `NodeOptions`, `Outcome`, …) appeared in `index.d.ts` only as that one line, and no per-name grep could find them. `index.ts` now has `export type { NodeState, InterruptMode, NodeOptions, Body, Release, Provider, LookupOptions, Outcome, FailureDestination, TaskOptions, Fiber, Task, AllResult, PoolOptions, Pool, Context } from './context.js'`. That is the same set of names `export type *` exported (diffed against `context.ts`'s exports when it was written), so the surface is still exactly §1.15's; the difference is that a type added to `context.ts` later becomes public only when it is listed here too. Everything else in §1.15 is as written. The S3 check greps each name as an identifier in an export clause (preceded by `{`, a space or `,`, and followed by a space, `,` or `}`), so `create` does not match the module path `./create-context.js`; it also requires `Fiber` only in a type export and `runSync` only as the ambient export, and that no internal name leaks (`requireCurrent`, `captureAutoScoped`). A type-level probe pins D-58 (the free `all` and the method `all` infer `Promise<[A, B]>`), I27 (a task has no call signature), `Fiber` as a type only, and the absence of every removed name (one `@ts-expect-error` import per name). *(Corrected by D-115: as first written, the probe and the greps were run once by hand and committed nowhere; they are now `src/test/surface.check.ts`, `scripts/tsconfig.surface.json` and `scripts/check-surface.mjs`, run by `pnpm typecheck` and `pnpm check:surface`.)*
- **D-111 (impl) `TaskImpl.fork`/`call` are the free `fork`/`call` (amends §1.12).** §1.12 writes `requireCurrent('call').call(this, …)`. In a creation frame that call creates the value's pending node, and the method then throws `PendingNodeError` from `assertNotPending`. §1.13 says the body-shaped free functions throw `CreationViolationError` before touching any node (I16), and D-70 had already made S1's interim `TaskImpl.call` check the creation frame first. `t.call(...args)` is now `call(t, ...args)` and `t.fork(...args)` is `fork(t, ...args)`, so a task and the inline form cannot drift apart. `requireCurrent` moved to `ambient.ts` (D-70), where it is `@internal` and stripped from the `.d.ts`. `ambient.ts` imports only `context-storage.ts` and `resource.ts` at runtime: §1.1's graph allowed `inject.ts` for `ContextKey`, but `lookup(ContextKey)` needs no special case (no current node: `NoCurrentNodeError` from `requireCurrent`; with one: D-18's `CreationViolationError` from `get`). Test: `ambient.test.ts` › *in a creation frame* › the `task.call` case, which fails under the mutation `requireCurrent('call').call(this, …)`.
- **D-112 (impl) S3 test notes.** (a) `storage.test.ts`'s D-60(c) `it.todo` is now a test: without storage, `current`, `signal`, `lookup`, `own`, `fork` and `call` throw `NoCurrentNodeError` naming `import 'ramme/node'`. The file still imports no adapter before that test, because `ambient.ts` registers none. (b) Four ports of the previous fiber suite follow the proposal's semantics, not the old ones. "Fiber.fork › should drain when parent disposes" relied on a call waiting for an unjoined fork to finish naturally. Under §5.1 a body exit interrupts its subscribers by default, so that holds only with `childrenOnExit: 'await'`. The port asserts both: with `'await'` the fork completes naturally, and by default it is interrupted (frozen at its managed await and released) while the call still waits for its completion (§5.6). "linkAbortSignal › should abort immediately if signal is already aborted" becomes a fiber built on an aborted signal, which settles `aborted` at construction without running (D-13). The "no context available" cases of `call`, `fork` and `signal` throw `NoCurrentNodeError` synchronously instead of returning a rejected promise (§1.13). (c) The ported abort tests wait on `managed(sleep(ms, signal()))`, a sleep that resolves on abort, because a bare timer keeps a delivered freeze body running until it fires (§4.2). (d) `ambient.test.ts` checks I21 by spying on `NodeImpl.prototype[method]` for each free function. Vitest's spy calls `then` on a returned `Promise` (for `mock.settledResults`), which counts as awaiting a managed promise (§2.4 property 2). That is harmless there, because the awaiting node is never delivered; a spy over a body that is delivered would be the D-67 (b) shape.
- **D-113 (impl) A failure handler runs in a marked frame, and the parent waits for a handler that returns a promise (amends D-45, D-69, D-80, §2.1, §4.5, §4.8, §7.11).** Two defects in D-45's handler frame. (1) `finishCompletion` ran the handler under a plain `{ node: p }`. When `p`'s body was inside a call it did await, the handler's `lookup`, `fork`, `child` and `pool` threw `UnawaitedCallError` ("`get()` … the call was not awaited"); D-10 recorded the throw on `p.extraErrors` and `p` failed. D-45's "`lookup()` resolves from it" and §7.4's "parent unaffected" both broke, and I26 flagged an await nobody had forgotten. (2) The handler's return value was dropped. `FailureDestination` is typed `=> void`, which accepts an async function, and §6.7's own `onFailure: (e) => respond500(res, e)` returns whatever `respond500` returns. A rejection was therefore unhandled (I10), and code after an await ran with `p` current after `p` had completed, so `own()` there threw `NodeCompletedError`. Now the handler runs under `{ node: p, creation: undefined, handler: true }`. `Frame.handler` is `@internal` and stripped from the `.d.ts`, and the frame is carried across the handler's own awaits like any frame. In that frame: (a) `assertNotLent` lets `get`, `fork`, `child`, `pool` and `runSync` through on `p` while `p` is lent, because none of them waits on, enters or lends `p`. `call`, `all`, `race`, `run` and the managed awaits stay refused, with a message that names the handler instead of a forgotten await, so `lentTo` is never touched. `own`, `release`, `abort` and `close` were never refused (§7.11). (b) A managed await is never a freeze target (`freezeTarget` in `managed.ts`): the handler is not `p`'s body, so `p`'s delivery neither cuts the handler's await nor counts `p` frozen through it. (c) A `call`, and so `all` and `race`, lends nothing. D-03 lends the awaiting body, and a handler is not one; otherwise an async handler's `await call(t)` would make `p`'s own body fail with `UnawaitedCallError`. (d) When the handler returns a thenable (never probed on a fiber, D-29), `p.holdForHandler` keeps a never-rejecting promise in `p.handlerHolds` until it settles. When `p`'s release loop finds both stacks empty, it waits for every hold and then re-reads the stacks before calling `finishCompletion` (amends D-69). So `p` is still open for the handler's code after an await: D-45's `own()` attaches to `p` and `p`'s loop releases it. A rejection goes to `p.extraErrors`, like a synchronous throw (§9.2). The hold covers every path, including a child whose entry was already releasing; `holdEntry` (D-80) still covers the synchronous part. (b) is what makes (d) safe. Without it, an async handler awaiting `interrupted()` or `join()` under a freeze parent was cut at the parent's delivery, never resumed, and held the parent forever. A handler that never settles holds its parent, as a body that never settles does; the parent's `signal()`, current in the handler, is how it hears an abort. The review's alternative, marking the rejection handled and letting the parent complete, was rejected: work started by a handler would then outlive the node whose lifetime it has (I21). Tests: `lending.test.ts` › *a failure handler while its parent is lent* (three tests), and `fiber.test.ts` › *failure destinations* › *an async handler* (five tests: the parent is open after an await, a task's and a pool's rejection surface, no freeze, a returned fiber is not awaited). *(Amended by D-116–D-119: (a) applies only through the parent — through any other node a handler is checked as the receiver only, so `other.join(g)` and `other.call(t)` agree (D-116 (1)); (b) also covers a wrapper made by the parent's body and awaited in the handler, which `then` now treats as untargeted (D-116 (2)); (d) never holds a parent whose completion, or an ancestor's, the handler awaits (D-117), and the loop waiting for holds still releases node entries the handler attaches (D-118).)*
- **D-114 (impl) A promise ramme receives but hands to nobody is marked handled (I10; amends D-74, §4.13 `run`).** (1) In dev mode `run(fn)` threw `AsyncRunError` for a returned promise and dropped the promise. Its rejection was then an unhandled rejection nobody could catch, so one misuse gave two errors. The same happened for a `runSync` continuation that found its child complete, where `own()` throws `NodeCompletedError`. `run` now attaches a no-op rejection reaction before it throws. In production `run` still returns the promise to its caller. (2) `emit` caught a receiver that throws, but not one that returns a rejecting promise. That rejection is now reported with `console.error`, as D-74 reports a throw, and the event is dropped. Both go through `handleRejection`, which runs outside every frame (D-84) and uses `Promise.prototype.then` on a native promise rather than a subclass's override, so a `ManagedPromise` that `run` drops counts as awaited by nobody and arms no cut (D-67). Tests: `ambient.test.ts` › *Context.run* (an async `run` that rejects; `runSync` with an async fn that rejects and one that resumes) and `node-core.test.ts` › *NodeTopic receivers are sinks*.
- **D-115 (impl) S3 review: the surface check is committed, and four tests now assert what their names claim (corrects D-110; extends D-58, D-112).** (a) D-110's probe and greps had been run once by hand and were committed nowhere, so re-adding a removed name to `index.ts` left `typecheck`, `lint`, `test` and `build` green. Committed now: `src/test/surface.check.ts`, a type-level probe that imports the package by its own name. `tsconfig.tests.json` maps `ramme` to `src/index.ts`, so `pnpm typecheck` compiles the probe against the source surface. `scripts/tsconfig.surface.json` compiles the same probe against `dist/index.d.ts` through package.json `exports`; it moves `rootDir` and `outDir` off `src/` and `dist/`, because tsc maps a self-reference into the project's own `outDir` back to the sources. `scripts/check-surface.mjs` parses the export clauses of `dist/index.d.ts`. It requires exactly §1.15's 76 names, each in its space and from its module, and every name of the proposal's §3.1, §7.1, §7.2, §7.7 and §9.6. It also requires that none of the removed or internal names appears and that no `@internal` declaration is left in `dist/*.d.ts`. `pnpm check:surface` runs both checks after a build, and `check:package` ends with it. Mutation checks confirm the coverage: re-exporting `createContext`, leaking `requireCurrent`, exporting `Fiber` as a value, dropping `const` from `Context.all` and turning `stripInternal` off each fail `pnpm typecheck`, `pnpm check:surface`, or both. (b) `fiber.test.ts` pins D-58 for the method form: `root.all`, `current().all` and `all` on a `Context`-typed variable each infer the tuple. The test fails when `const` is removed from `Context.all`. (c) "abort() on the fiber fires its signal() and freezes it at its managed await" now asserts that the body never resumes. It fails when `NodeImpl.managed` returns the bare promise. (d) "removes the listener when the fiber settles normally" asserts that the removed listener is the one that was added, and that the signal has no `abort` listener left (`getEventListeners`). It fails when a different function is removed. (e) `storage.test.ts` "currentCreation() is visible only synchronously …" queues a microtask, a reaction and a timer inside the creation frame, ends the creation (D-107), and asserts that each continuation sees no frame. It fails without `creation.ended` in `currentFrame()`. *(Amended by D-117: the surface probe compiles with `skipLibCheck: false`.)*

S3 review fixes (entries marked *(impl)*, as above):

- **D-116 (impl) A failure handler's awaits are the handler's own, whichever node receives them and whichever body made the wrapper (amends D-113 (a), (b), D-88, D-68; §2.4, §4.6).** Two defects. (1) In a handler frame while the parent `p` was lent, `other.join`, `other.result`, `other.interrupted`, `other.never` and `other.managed` threw `UnawaitedCallError`: `assertAwaitShaped` ran `currentFrame().node.assertNotLent(op)`, the current node is `p`, and none of those ops is in `HANDLER_MAY_WHILE_LENT`. `other.call`, `other.all` and `other.race` went through, because a call in a handler frame lends nothing and checks no lender (D-113 (c)). The throw became a handler exception and failed `p`: §7.4's "parent unaffected" broke, and I26 was reported for an await nobody forgot. The review offered two consistent rules. Option (a) is taken: in a handler frame `assertAwaitShaped` checks only the receiver, as `call` does there. A handler frame now has one rule: nothing is lent, nothing freezes, and only the receiver's guards apply. Through `p` itself (the receiver is `p`, or the free form with `p` current), D-113 (a)'s refusals are unchanged. `call`, `all`, `race`, `run` and the managed awaits are refused with the handler message ("not await or call through it"), and `get`, `fork`, `child`, `pool` and `runSync` pass. Option (b), also refusing `other.call` and `other.all` there, was rejected: it refuses an await that neither waits on, enters nor lends `p`, which is D-113's own test for what a handler may do. (2) `ManagedPromise.then` decided by the wrapper's target alone. Take a wrapper made in `p`'s body, so targeted at `p` (`const conn = managed(connect())`), and awaited by a handler of `p`. That await armed `p`'s cut, and `checkAwaiter` stayed silent because the current node was `p`. `p`'s delivery then emptied the handler's cell and counted `p` frozen. The handler never resumed, its hold (D-113 (d)) never settled, and `p` never completed. Now `then` reads the frame first. In a handler frame it calls `thenAsHandler(run, onFulfilled, onRejected)`, which is untargeted whatever the target: it arms no cut, takes neither the applied path nor the cut-only one, skips the foreign-awaiter check, and chains to the source at once. Its cell is its own, so no cut empties it, and the deliver step is captured at `then` time. `holdForHandler` subscribes to a returned managed promise the same way, through the exported `thenAsHandler(r, run, onFulfilled, onRejected)`, still outside every frame (D-84). So `onFailure: () => conn` is not cut by `p`'s delivery either. `interrupted()` made by `p`'s body for its own interrupt is cut-only (D-66); `ManagedPromise.cutOnlySignal(t, source)` keeps its source in `#signalSource`, read only by a handler's await, so a handler awaiting it resumes at `p`'s delivery. D-66's one shared cut per target is unchanged. A wrapper `p`'s body was already frozen on (cut, or awaited after delivery) has dropped its source and deliver step (D-84), so a handler awaiting it still never resumes. Dev mode now warns at that await (a new `#spent` flag tells it from `never()`). Tests: `lending.test.ts` › *a failure handler while its parent is lent* › "through a receiver other than its parent, a handler may await and call while the parent is lent …" (`other.join`, `result`, `managed`, `call`, `all`; `join` through the parent still refused); `fiber.test.ts` › *an async handler* › "a managed promise its parent's body made is the handler's own await …" (`managed(p)` and a cut-only `interrupted()` from the body; the parent is aborted and completes; no warning); `managed.test.ts` (16).
- **D-117 (impl) A handler run never holds a parent whose completion it awaits (amends D-113 (d)).** `onFailure: () => app.close()` deadlocked the tree. It is the natural way to write "a fatal failure shuts the app down". The returned wrapper waits for `app`'s completion, D-113 (d) holds `app` through `handlerHolds` until the wrapper settles, and `app`'s loop waits for the hold. The same happened for a pool parent, for `async () => { await app.close() }`, and for `join`, `result`, `[Symbol.asyncDispose]`, `release(node)` and `releaseAll` on the parent or an ancestor. Before D-113 the return value was dropped, and the close worked. Now the handler frame carries a per-run record: `Frame.handler` is a `HandlerRun` (`@internal`, declared in `context-storage.ts`; it was `true`), implemented by `HandlerHold` in `node-impl.ts`, which keeps the run's hold promise. Six managed awaits pass a `WaitsFor` predicate as `managedFor`'s third argument (`ManagedPromise`'s fourth). `close`, `[Symbol.asyncDispose]`, `join`, `result` and `release(x)` of a node entry pass `completionOf(n)`, true when `n` is the handler's parent or an ancestor of it. `releaseAll` passes a predicate that is true when one of its explicit node entries is. `thenAsHandler` reports the predicate to the run (`run.awaits(waitsFor)`) before it chains. A run that awaits its parent's completion or an ancestor's is detached. If its hold does not exist yet (the handler returned the wrapper, or awaited it before its first suspension), `holdForHandler` adds none. Otherwise `dropHandlerHold` removes it from `handlerHolds` and wakes a loop that waits for it (D-118). The check runs at the handler's await, or at the hold for a returned wrapper, so a wrapper made elsewhere counts too (a stored `closing = app.close()`). A wrapper the handler makes but never awaits holds nothing back. A detached run's rejection lands on `p.extraErrors` while `p` is open, else on D-113's console backstop. Not detected: a dependency on `p`'s completion that passes through user code, such as a call whose body awaits `app.close()`, or `managed(p)` over a user promise. Under an `'interrupt'` exit D-118 releases such a call child, so the handler sees `FiberAbortedError`. Under `'await'` it holds `p`, as a body that never settles does. The review's alternative was to refuse such an await at once. It was rejected: shutting down from a fatal handler is the common case. Tests: `fiber.test.ts` › *an async handler* › *a handler that awaits its parent's completion or an ancestor's holds nothing, so the tree completes*. Six tests cover close: three handler shapes, the sync arrow, an async handler and one that closes after its parent's loop already waits, each with a fiber parent and a pool parent. They assert the app completes on the handler's close alone, with nothing on the console. Five more cover `root.join(Y)`, `root.result(Y)`, `Y[Symbol.asyncDispose]()`, `root.release(Y)` and `root.releaseAll()` from a handler of `Y`'s child. `HandlerRun` carries no `@internal` tag, although `Frame.handler` does: `dist/managed.d.ts` and `dist/node-impl.d.ts` name the interface, and with it stripped they failed to compile for a consumer without `skipLibCheck` (TS2305). It is still not exported from `index.ts`. `scripts/tsconfig.surface.json` now sets `skipLibCheck: false`, so `pnpm check:surface` compiles every declaration file the probe reaches and fails on such a dangling name (amends D-115 (a)); it failed before the tag was removed.
- **D-118 (impl) While the release loop waits for handler holds, it still releases node entries attached to the explicit stack (amends D-113 (d), D-69; restores §6.2).** Once both stacks were empty, the loop parked on `Promise.all(holds)`. An entry attached after that waited for every hold. An async handler's `await call(t)` attached a call child that was never released, so under an `'interrupt'` exit it was never interrupted. A call child that waits for an interrupt (`await never()`, a loop on `signal()`) then never settled, nor did the handler or its hold. The parent hung in `'releasing'`, depending on timing: a call attached before the empty check was aborted by the loop, and the handler got `FiberAbortedError`. Now the loop waits on `Promise.race([Promise.all(holds), woken])`. `attachNode` on the explicit stack and a dropped hold (D-117) resolve `woken` through `wakeReleaseLoop`, which is set only while the loop waits. From the first wait until every hold settles, the loop takes `explicit.topPendingNode()`, a new `Stack` method that returns the top pending node entry and passes passive ones. It releases that entry as step 2 would: interrupted under `'interrupt'`, closed under `'await'`. So §6.2's "an entry pushed during release is released next" holds for a fork, call, child or pool the handler attaches. Passive entries the handler owns and values placed on the provided stack stay until the holds settle, because the handler may still be using them. Then the plain LIFO loop releases them and completes the node. Before the first wait nothing changes: every entry pushed is released in LIFO order, passive or not. Tests: `fiber.test.ts` › *an async handler* › "a fiber the handler attaches after its parent's body exited is released next …" (the parent completes; the handler's call is interrupted by its owner; the handler's own entry is released after the handler is done); `stack.test.ts` "topPendingNode passes passive and 'released' entries …".
- **D-119 (impl) A pooled fiber frees its pool slot before its failure handler runs (amends D-80 (3), D-47).** `poolChildComplete` ran after the handler, so inside a pool's `onFailure` the failed fiber, already `'complete'`, still counted in `running`. Restarting it from a concurrency-1 `'reject'` pool threw `PoolFullError`, a handler exception that failed the pool and its parent. In a `'wait'` pool the restart queued behind a slot that was already free. Restarting the failed worker is the canonical use of a pool handler (§7.4, "supervised background work"). `finishCompletion` now calls `poolChildComplete` in step (1), right after it removes the child from `p.subscribers` and before the routing. One call frees the slot and admits waiters in FIFO order, so a queued waiter takes the slot before the handler's restart, which is queued (or refused under `'reject'`), as any later fork would be. Splitting the decrement from the admission was rejected because it would let the restart jump the queue. `poolChildComplete` runs no user code and cannot complete the pool (a start is a microtask, D-46), so D-80's guarantee still holds. Tests: `pool.test.ts` "a concurrency-1 'reject' pool restarts its failed worker from onFailure …" and "with whenFull 'wait', a waiter queued behind the failed fiber takes the freed slot before the handler's restart".
- **D-120 (impl) `all()` and `race()` name themselves in the lending error, and a test now checks `t.call`'s parent (extends D-72, D-88, D-111).** `all` and `race` delegated to `this.call(group)`, so a lent current node making `other.all([...])` got "`call()` on … while it is lent to …: the call was not awaited (two concurrent calls on one node? use all())". The user had called `all()`, not `call()`. `call`, `all` and `race` now share `callTask(op, task, args)`, which runs D-72's `lender.assertNotLent(op)`. The receiver's guards run once, in the public method. For `all` and `race` the hint is "(await it before this all(), or put both in one all())". Test: `lending.test.ts` "a current node that is already lent cannot make a second call through another receiver; all() and race() name themselves". Separately, `fiber.test.ts` "t.fork() and t.call() are fork(t) and call(t) …" checked `t.call`'s child only for having some parent. Its body now records its node's parent, and the test asserts that both forms record the caller. A mutation that runs `t.call` at the root fails it.

S4 implementation (entries marked *(impl)*, as above):

- **D-121 (impl) S4 test notes (§6.1 `request-example.test.ts`, `node-topic.test.ts`, `invariants.test.ts`, `probes.test.ts`, `topic.test.ts`).** (a) *Request example.* The handler is §6.7 verbatim except that its unused `res` parameter is spelled `_res`, which `@typescript-eslint/no-unused-vars` requires. The fake server is created at the test's top level and runs its callbacks through an `AsyncLocalStorage.snapshot()` taken there, as an `EventEmitterAsyncResource` would, so the callback really has no current node (a test asserts `current()` throws there). Calling the listener from inside `main` would otherwise inherit `main`'s frame. `Pool` reads its node with `#ctx = current()` (§6.6's spelling), which is `inject(ContextKey)` in creation and is untracked either way, so assertion (1) checks `deps(Pool)` is empty. Assertion (5) is stronger than written: `app.close()` starts while both handlers still wait on their queries, and the trace `[lease, lease, reaper, pool]` plus the `node:complete` order show the close waited for the lease-holders before releasing the pool (G1). Assertion (6) pins the order of the releases (`lease` before `reaper` before `pool`) and that `after using` is last, but not where the top-level call's rejection falls among them. `main` is frozen and completes at the delivery, so its rejection races the root's release loop by a few microtasks. (b) *Invariants.* A delivered `freeze` body's outcome is `aborted` whatever it does (I13), so a failing `expect` inside one would be swallowed. Tests that deliver a body record into variables and assert afterwards. I6's "a second managed await requested after freezing" is made by a promise reaction the body registered, which runs later in the body's frame. The node is held in its release phase by a slow release; once the node is complete, the same await is `NodeCompletedError` (I7) rather than a never-settling promise. I11's unjoined fork is given one bare `tick()` to fail: a body that returns at once interrupts its unstarted fork (§5.1, D-13), which then settles `aborted` and surfaces nothing. (c) *Probes.* P2 runs on a `child()` context and on a fiber. P4's parent is the root, closed while the dropped call's child still waits. (d) *Topic.* The "compose with parent receiver via skipSelf" port reads the parent's receiver with `child.get(MyTopic, { skipSelf: true })`, as its title says, instead of naming the root. (e) *Shim.* `src/test/ambient-shim.ts` is deleted and its four importers use `./ambient.js` (D-95, D-104).
- **D-122 (impl) S4 documentation and package choices.** (a) DECISIONS.md numbers the standalone **(DECISIONS)** entries into the D10–D17 range §17 of the proposal reserves. D-06, with D-38 under it, becomes D13, as D-06 suggests. D-03 becomes D11, D-05 D12, D-15 D14, D-16 D15 (D-47 under it) and D-01 D17. The entries marked for D9′, D10′ and D16 sit under those, and D7 is kept and amended (§16 of the proposal). Each cites its plan number. (b) DESIGN.md is rewritten whole, not only §1.1, §2–§4, §6 and §8. Its §5 (the two removed topics), §9 (kilde through lookup-api) and §10 (the old laws) described mechanisms that no longer exist. The section numbers are kept: §8, formerly the lookup-api bridge, now describes its replacement (§8.5, keys with default factories). (c) package.json `files` also gains `NOTICE`, which Apache-2.0 redistribution requires, and `DESIGN.md` and `DECISIONS.md`, which the README links to. `sideEffects` is unchanged. (d) The README's first example uses `app.call(profile, '42')` at top level, the root's method form of a tier-1 name. Its §6.7 section also uses `createInjectionKey`, `valueProvider` and `handle.with(...)`: keys and providers are in neither tier (§8, "unchanged").

S4 review fixes (entries marked *(impl)*, as above):

- **D-123 (impl) An early release's error is the awaiting caller's alone, even when the owner's releases end while the caller still waits (amends §4.4, §4.5, D-41; §1.8 `managedFor` and `ManagedPromise` take a fourth/fifth argument; §3.1 gains `earlyAwaits`).** `finishCompletion` folded every unconsumed early-release record into the owner's outcome, including one whose `release(x)`/`releaseAll()` awaiter had called `then` and was about to be delivered. Both then reported it. Take I2 (c) with a failing `a`. `M.releaseAll()` starts `b`, and `M.abort()` makes the loop wait on `b.done` behind `releaseAll`'s own loop. When `b` finishes, `releaseAll` releases `a`, which throws synchronously, and suspends for one microtask. The owner's loop then finds both stacks empty and completes `M` with `a`'s error, and `releaseAll()` rejects with it too. `M.close()` rejected (or the root's `close()`, without one), against §9.2 "rejects that call only", D-41 "a delivered caller sees exactly the §9.2 behaviour", §4.5 "early releases whose awaiter froze or never awaited" and I11. The same happened for `const p = M.release(x); M.abort(); await p` with an async `x` that throws. Fix: (1) `managed.ts` has `AwaitWatch { awaiting(); settled() }`, passed as `managedFor`'s fourth argument (`ManagedPromise`'s fifth). `awaiting()` is called once for each live cell `then` makes, a handler's cell included (D-116). `settled()` is called once for each cell when it ends: after `deliver` and the continuation have run, or when a cut empties it. The applied path makes no cell and so calls neither. The watch is dropped with `#deliver` at a cut and on the applied path. (2) `release(x)` and `releaseAll()` pass an `EarlyAwait(owner, entries)`. While it has a live awaiter it sits in `owner.earlyAwaits`. Its `owes` is true when one of its entries has a failure nobody has consumed. (3) At the empty point, after the handler holds (D-113 (d), D-118), the release loop checks `owesEarlyDelivery()`. If any waiting call owes a failure, the loop parks on `wakeReleaseLoop` under no frame (D-46), and re-reads when an awaiter stops waiting. A delivered awaiter has consumed the record by then, so the owner surfaces nothing. A cut awaiter leaves the record unconsumed, and the owner's completion surfaces it (D-41's "froze"). The wait is bounded: at the empty point every entry in a waiting call is released, so its source (`e.done`, or `releaseAll`'s run over released entries) settles within microtasks and the awaiter is delivered. The awaiter's continuation does not depend on the owner's completion. An entry attached during the wait (by that continuation, say) is released by the re-read, as §6.2 says. A call with no awaiter at the empty point, never awaited or stored, is not waited for, and its record is folded. A caller that first awaits after the owner completed gets the error again, as D-50's re-delivery does. Successful early releases are never waited for, so the timing of every existing test is unchanged. The review's other options were rejected. Skipping a record with a live awaiter in `finishCompletion` loses the error when that awaiter is cut after the owner completed. Waiting for every `releaseAll()` run would hold owners that owe nothing. Tests: `invariants.test.ts` I2 (c) now has a failing `a` (`releaseAll()` rejects with it, `M.close()` resolves, `M` is `aborted`) and (d) the `release(x)` shape (the root's `close()` resolves). `outcome.test.ts` › *frozen awaiters consume nothing* › "an early-release awaiter still waiting when its owner's loop finds both stacks empty …" covers `release(x)` and an `observe` body's `.then` on `releaseAll()`. "… cut while its owner's loop waits for it leaves the error to the owner's completion" puts the cut inside the wait: `a` queues the awaiter's abort, which lands after the loop parked. `M.close()` rejects with it once, the awaiter never resumes, and `earlyAwaits` is empty. Mutation checks: without the wait, I2 and the first outcome test fail. Without `settled()` at a cut, the second hangs and fails through `within`, as does "release(x) whose release throws while the caller is frozen …". DESIGN.md §4.12 and DECISIONS.md (D16, the D-41 bullet) state the rule.
- **D-124 (impl) `result()` emits `join:enter`/`join:leave` like `join()` (amends §4.6; completes §6.2's lifecycle-events port).** §6.2 maps the old "Fiber events (8)" to 8 `NodeTopic` tests, but S4 ported five, and D-121 did not record the gap. The old "join:enter and join:leave for Fiber.result" could not be ported, because §4.6's `result()` emitted no join events. So `const f = fork(work); await result(f)` left no trace of what the caller waited on, and §10's "print the running tree and what each node awaits is one query" did not hold for it. `result()` is a `join` that reports the outcome instead of throwing it, so it now emits `join:enter` before it waits and `join:leave` (with `f`'s status) in its `deliver` step. A frozen awaiter emits no `join:leave`, as for `join` (DESIGN.md's event table says so). `all`/`race` do not call `result()`, so they emit nothing new. The eight ports in `node-topic.test.ts`: call:enter/leave → "call: the lender emits node:lent and node:returned …"; call:leave with error → "a failing call: the child settles and completes with failure, and gives its lender back" (new); spawn started/settled → "fork: node:created → …"; no FiberTopic → "without a receiver nothing is emitted …"; fork mode → "fork, call and join events of one tree, in order"; join:enter/leave → "join: join:enter and join:leave on the joiner …"; join:leave with error → "join:leave carries the failure outcome of a joined fiber that failed" (new); result → "result(f) emits join:enter and join:leave on the awaiter, and a frozen awaiter no join:leave" (new). §6.2's counts are now met as written.
- **D-125 (impl) S4 review: eight tests now assert what their names claim, and three doc statements are corrected (extends D-121, D-122).** Each test change was checked against the mutation the review named. (a) `request-example.test.ts` (6): `main` threw "main resumed after the abort" after `await result(handler)`. A delivered freeze body is `aborted` whatever it throws (I13), so the throw could never fail the test (D-121 (b)'s own pitfall). It now sets `resumed` there, and the test asserts `resumed === false` and that `main`'s events contain `node:frozen` and no `node:settled`. It fails when the managed await is replaced by a bare `await impl(handler).completion`. (b) "the server callback runs with no current node …" called `server.later` from the test's top level, where no node is current anyway. It now calls it inside `app.call`, asserts that the callback sees `NoCurrentNodeError` while `current()` outside it is `main`, and that a request made from `main` is forked on the app (line 4). It fails when `FakeServer`'s snapshot is replaced by a plain call. (c) `invariants.test.ts` I3 made the value before any explicit entry, so one merged LIFO stack gave the same order. It now makes `Late` after an explicit entry and `Spawned` from a fork that is still running at `close()`, and pins `[call entry, fork entry, child entry, explicit 1, spawned service, late service, service]`. It fails when value nodes attach to the explicit stack. (d) I16's `lookup(ContextKey)` and `other.get(ContextKey)` throw `CreationViolationError` in any frame (D-18). They now use a plain provided key `K`, which the test first resolves outside a creation. A `forkRan` flag shows the constructor's fork ran, after the factory returned and in no creation frame. The test fails without `get`'s creation guard, and when the fork never runs. (e) `probes.test.ts` P2 compared the `completion` getter with itself. Each of the four promises now records `N.state` and the event-log length when it settles. The test asserts that none has settled while the async entry is held at the gate, and that each settles at `complete` after N's `node:complete`. It fails when a `close()` on a releasing non-fiber, or a repeated `[Symbol.asyncDispose]()` on a fiber, resolves at once. (f) `node-topic.test.ts`'s two "resolved once per root" tests counted factory runs, which the root's cache keeps at one. They now spy on the root's `cache.get` and assert that no event looks `NodeTopic` up again after the root's `node:created`. Both fail, and only they do, when `emit` re-resolves the receiver while the root is open. (g) "an early release(x) runs in a release fiber …" checked only the `entry:released` count. The dispose now records its current node, and the test asserts `kind: 'release'`, the body's node as parent, and `node:created`/`node:complete` of that node before `entry:released`. It fails when an early passive release runs inline. (h) Docs. README's "Await every `call`" said the next ramme operation throws `UnawaitedCallError`; it now says the next body-shaped one does, and that `own`, `release`, `abort` and `close` stay allowed (§7.11, I26). README's adapter paragraph said every operation throws `NoCurrentNodeError` without an adapter; it now says those that need the current node do, as D9′ and DESIGN.md §6 say, and that setup code runs, so a missing import can surface as late as shutdown. DESIGN.md §4.9 and DECISIONS.md D11 said a node is lent "until the child settles"; they now say until the call settles (the child completes, its releases included), which is when `finishCompletion` clears `lentTo`.
- **D-126 (impl) `join:enter`/`join:leave` name the awaiting body's node, not the receiver (amends D-124, and §4.6's pseudocode, which emits on `this`).** §4.3 gives a managed await to the awaiting body's node (`current()`), and `callTask` lends that node, not the receiver (D-03, D-88). `join()` and `result()` still emitted their events on `this`. A body Y running `await scope.join(f)` or `await scope.result(f)` on a bodiless `scope` therefore left both events on `scope` and none on Y, while a `call` in the same body lends Y. §10's "what each node awaits" query, D-124's reason for `result()`'s events, then reported a bodiless context waiting on `f` and Y waiting on nothing. D-124's "on the awaiter" held only for the free functions, where the receiver is the awaiter, and its test used only those. Fix: `NodeImpl.awaiterNode()` reads the frame as `callTask` does. It returns the frame's node unless the frame is a failure handler's (D-113), and otherwise the receiver (top level, a creation frame, a handler). `join()` and `result()` capture that node when called and emit both events on it. `join:leave` still comes from the `deliver` step, so a frozen awaiter emits none. Test: `node-topic.test.ts` › "join/result in method form on another node emit on the awaiting body, not on the receiver; with no body, on the receiver (§4.3, D-126)". `other.join(a)` and `other.result(b)` from a body put both pairs on the body, beside the body's `node:lent` for `other.call(...)`, and nothing on `other`. `other.join(g)` at top level puts them on `other`. The test fails when the events are emitted on `this`. DESIGN.md's event table says which node emits them.
- **D-127 (impl) An early-release call counts as awaited from its creation until an immediate `await` or combinator has called `then` (amends D-123).** D-123 counted an awaiter only once `then` ran. `await p` and the `Promise.all*` combinators call a `ManagedPromise`'s `then` from a job queued when they are evaluated, one microtask later, and the release loop's re-read could run first. Take `const x1 = M.own({}, async () => { await tick(); throw E1 }); const p1 = M.release(x1); M.abort(); try { await p1 } catch {}`, then `const x2 = M.own({}, () => { throw E2 }); await M.release(x2)`. The loop parks for p1's awaiter (D-123). Its delivery queues the caller's continuation, and then, in `settled()`, the loop's re-read. The continuation runs first, while M is still `releasing`, so `own(x2)` succeeds and `release(x2)` records E2 before its `await` queues the `then` job, which lands behind the re-read. The re-read found both stacks empty and nothing in `earlyAwaits`, and folded E2 into M's outcome. `M.close()` then rejected with E2 after `await M.release(x2)` had already done so. I2 (c) with synchronous entries did the same. `M.own(b); M.own(a /* throws */); await Promise.allSettled([M.releaseAll(), M.close()])` rejected both with a's error, because `close()` ran M's loop to the empty point synchronously before `allSettled` queued `releaseAll()`'s `then`. That contradicts §9.2 "rejects that call only", D-41, and DESIGN.md §4.12's "reported exactly once". Fix, the review's option 1: `release(x)` and `releaseAll()` call `EarlyAwait.hold()` before they release anything. It makes a provisional count: `#live` is 1, and the call is in `owner.earlyAwaits`. The first `awaiting()` takes the count over, so a real awaiter keeps the call in the set with no gap. If nobody calls `then`, a drop two hops later, queued under no frame (D-46), removes the call and wakes a loop waiting for it. The first hop runs before the job that an `await` or combinator evaluated after the call queues. The second hop is queued behind that job, so the job always comes first. The applied path (a frozen awaiter, which makes no cell) does not take the count over; the drop ends it. The hold is made for every call, not only for one that has already recorded a failure, because an async release can fail inside the window. It costs nothing for calls that owe nothing, since the loop reads `earlyAwaits` only through `owes`, and successful early releases are still never waited for. A failing call that nobody awaits holds its owner's loop for at most two microtasks before the owner folds its failure, and no existing test's timing changes. D-123's "a call with no awaiter at the empty point … is not waited for" now reads "is waited for at most two microtasks after its creation". A caller that first awaits after the owner completed still gets the error again (D-50). The review's option 2, re-queuing the step at the empty point, was rejected: it needs to know which wrappers have not yet been `then`ed, which is what the hold tracks. Tests: `outcome.test.ts` › *frozen awaiters consume nothing* › "an early release(x) made, and awaited at once, after its owner's loop was woken and before it re-reads is the caller's alone (D-127)" is the scenario above. It asserts that M is still `releasing` in the continuation, so the window is really exercised, then that `M.close()` resolves, M is `aborted` and `earlyAwaits` is empty. Its second half pins the bound: a synchronous failing `void N.release(y)` that nobody awaits is folded, once, into `N.close()`. `invariants.test.ts` I2 gains (e), the synchronous shape: `releaseAll()` rejects with a3's error, `close()` resolves, and M3 is `success`. Mutation checks: without the hold, both tests fail. A one-hop drop passes both. With today's wake paths the second hop is a margin, not a reachable case. No construction found reaches it: a synchronous wake between a call and its `await` either queues the re-read before the call (an `own` on the explicit stack, which the provisional count covers) or wakes the loop through `Promise.race` over the handler holds, which takes two hops itself. DESIGN.md §4.12 and DECISIONS.md D16 say when a call counts as awaited.
- **D-128 (impl) README: `FiberAbortedError` reaches more than code outside any task, and a `catch` misses only the body's own interruption (extends D-125 (h)).** The README's error table said `FiberAbortedError` came only from "`join` / `call` from outside any task on work that was interrupted". §5 throws it whenever the awaited fiber's outcome is `aborted` and the awaiter is not frozen. That includes a body that is not itself interrupted and joins a fiber that was aborted: `const f = fork(…); f.abort('stop'); await join(f)` throws it inside the task. `outcome.test.ts`'s `all` case pins this for `self.all([...])` in `app.call`. The row now reads "`join` / `call` / `all` / `race` of work that was interrupted, by code that is not itself interrupted (top level, a platform callback, or a body whose own node was not aborted)", as DESIGN.md's error table and §5 have it. The rule "a `catch` sees real errors, never an interruption" now says "never its own body's interruption", and adds that awaiting other work that was interrupted does throw. Docs only, so no test.
