// ---------------------------------------------------------------------------
// Resolution and creation (DESIGN.md §3, §4.6).
//
// - `inject` is the only creation-time read (DESIGN.md §3.2). It is tracked for
//   auto-hoisted values: `deps(V)` (misses included, D10′) and the deepest
//   dependency decide where `V` is placed (D7).
// - `resolveFrom` is the one walk `NodeImpl.get` and `inject` share. It
//   marks every context on the walk *decided* (DESIGN.md §3.4), serves a cache hit only
//   when the hit is the requester's own view (placement by view and scope
//   shadows, D10′; scoped hits, DESIGN.md §3.1), and otherwise creates: at a provider's
//   context whatever the key's scope (D36), at a scope owner for a key's own
//   default, or — auto-hoisted — at the deepest dependency. An `aliasProvider`
//   is a redirect: the walk resolves its target from the walk's base instead and
//   caches nothing under the alias key (D36).
// - Creation runs synchronously (A4) under a creation frame. The value's node
//   is created on demand: pending until placement for an auto-hoisted value,
//   live on the storage context's provided stack for a declared placement
//   (DESIGN.md §3.3). A failed creation releases what the node owns, with the
//   requester as its owner; forks made during creation start after placement
//   (I20), and an unowned `'join'` fork fails the resolution (D14). A creation
//   re-entered from a release it started is a cycle, and so is one re-entered
//   from the releases of a failed creation (DESIGN.md §3.3). The creation ends
//   when its factory returns (DESIGN.md §3.5).
//
// This module never imports node-impl.ts at runtime: value nodes are created
// with `requester.createValueNode(...)`, placed with `node.placeAt(S)` and
// abandoned with `node.abandon(e)`.
// ---------------------------------------------------------------------------

import {
  createInjectionKey,
  getDependencies,
  getKeyDescription,
  getKeyScope,
  hasDefaultFactory,
  invokeDefaultFactory,
} from './context-key.js';
import type { InjectionKey } from './context-key.js';
import type { Context, LookupOptions, Provider } from './context.js';
import { NO_NODE, currentCreation, runInFrame } from './context-storage.js';
import type { CacheEntry, Redirected, ResolveResult, ResolvedResult } from './internal-context.js';
import { NodeTopic } from './lifecycle-events.js';
import type { NodeEvent } from './lifecycle-events.js';
import type { NodeImpl } from './node-impl.js';
import {
  CreationViolationError,
  FactoryReturnedUndefinedError,
  NodeCompletedError,
  PendingNodeError,
  PlacementError,
} from './resource.js';
import { SelfScope } from './scope.js';
import type { Scope } from './scope.js';
import type { TopicReceiver } from './topic.js';

/** The value's own node during creation: `inject(ContextKey)` is `current()` there (DESIGN.md §3.3). Inject-only (DESIGN.md §4.12). */
export const ContextKey: InjectionKey<Context> = createInjectionKey<Context>('Context');

function keyName(key: InjectionKey<unknown>): string {
  return getKeyDescription(key);
}

function names(keys: ReadonlySet<InjectionKey<unknown>>): string {
  return [...keys].map(keyName).join(', ');
}

function sameKeys(a: ReadonlySet<InjectionKey<unknown>>, b: ReadonlySet<InjectionKey<unknown>>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/** `${name ?? kind}#${id}`, for messages. */
export function describeNode(node: NodeImpl): string {
  return `${node.name ?? node.kind}#${node.id}`;
}

// ---------------------------------------------------------------------------
// inject — creation-time only (DESIGN.md §3.2)
// ---------------------------------------------------------------------------

/**
 * Declare a dependency of the value under construction. Legal only during
 * creation (constructors, field initializers, factories); `inject(ContextKey)`
 * is the value's own node and is not tracked.
 */
export function inject<T>(key: InjectionKey<T>): T;
export function inject<T>(key: InjectionKey<T>, options: LookupOptions & { optional?: false | undefined }): T;
export function inject<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;
export function inject<T>(key: InjectionKey<T>, options?: LookupOptions): T | undefined {
  const cs = currentCreation();
  if (cs === undefined)
    throw new CreationViolationError(
      `inject() outside creation: ${keyName(key)} was injected outside a constructor, field initializer or factory; ` +
        'use lookup() at runtime', // the message starts with 'inject() outside creation'
    );
  const value = cs.inject(key, options);
  if (value === undefined && !options?.optional) throw new Error(`No provider found for ${key.name}`);
  return value;
}

// ---------------------------------------------------------------------------
// DepTracker and CreationState
// ---------------------------------------------------------------------------

/** deps(V), the keys V injected itself, the deepest dependency and the pin of an auto-hoisted value (DESIGN.md §3.4, D10′). */
export class DepTracker {
  deepest: NodeImpl;
  readonly deps = new Set<InjectionKey<unknown>>();
  /**
   * The keys V's factory injected itself, misses and `skipSelf` reads included: the D7 re-run check compares these.
   * Not the reads of a per-creation SelfScope dependency's factory, which run through V's creation but are that
   * dependency's (deps only).
   */
  readonly direct = new Set<InjectionKey<unknown>>();
  /** V read something requester-relative: it is served only at its storage context (DESIGN.md §3.4). */
  pinned = false;

  constructor(start: NodeImpl) {
    this.deepest = start;
  }

  /**
   * deps ∪= {key} always, a miss included (D10′), and direct ∪= {key} when V's own factory read it (`direct`; false
   * for a read forwarded from a SelfScope inner creation). Through an alias (D36), deps ∪= the redirect chain and its
   * target, a miss included, and the deepest alias node bounds V's placement as a provider's node does. On a hit:
   * deepest by depth, deps ∪= r.deps when r is auto-hoisted, and a pinned result pins V (DESIGN.md §3.4). A
   * per-creation SelfScope result's node is the requester, so it also makes the requester the deepest dependency.
   */
  track(key: InjectionKey<unknown>, r: ResolveResult<unknown>, direct = true): void {
    if (direct) this.direct.add(key);
    this.deps.add(key);
    if (r.via !== undefined) {
      for (const k of r.via.keys) this.deps.add(k);
      if (r.via.node.depth > this.deepest.depth) this.deepest = r.via.node;
    }
    if (!r.resolved) return;
    if (r.node.depth > this.deepest.depth) this.deepest = r.node;
    if (r.autoHoisted && r.deps) for (const d of r.deps) this.deps.add(d);
    if (r.pinned) this.pinned = true;
  }

  /** A requester-relative read (`skipSelf`) pins V at the requester `at` (DESIGN.md §3.4). */
  pin(at: NodeImpl): void {
    this.pinned = true;
    if (at.depth > this.deepest.depth) this.deepest = at;
  }
}

export interface CreationState {
  readonly key: InjectionKey<unknown>;
  /** R, the requester. */
  readonly requester: NodeImpl;
  /** Resolution base for inject: R (auto-hoisted) or S (declared placement). */
  readonly base: NodeImpl;
  /** S when declared, else undefined. */
  readonly placement: NodeImpl | undefined;
  /** Present iff auto-hoisted. */
  readonly tracker: DepTracker | undefined;
  /** The enclosing creation (cycle detection; SelfScope nesting). */
  readonly outer: CreationState | undefined;
  /** The alias redirect that led to this creation, if any (D36): its keys name the hops in a cycle's message. */
  readonly via: Hops | undefined;
  /** True while a skipSelf resolve of the same key runs. */
  cycleExempt: boolean;
  /**
   * Set by runCreation when the factory returns or throws (DESIGN.md §3.5). A creation frame whose creation has
   * ended is no frame (`currentFrame()`): a continuation the factory scheduled runs outside the creation.
   */
  ended: boolean;
  /** Per-creation SelfScope values; shared by a SelfScope inner creation with its outer one. */
  readonly selfCache: Map<InjectionKey<unknown>, unknown>;
  /** The value's node; shared with SelfScope inner creations. */
  readonly slot: { node: NodeImpl | undefined };
  /** False for SelfScope inner creations. */
  readonly ownsSlot: boolean;
  /** Materialise: slot.node ??= requester.createValueNode(name, placement). */
  node(): NodeImpl;
  readonly nodeIfCreated: NodeImpl | undefined;
  /**
   * `direct` is false for a read forwarded from a SelfScope inner creation: tracked in deps(V), pin and placement
   * like any read, but not among the keys V's factory injected itself (D7).
   */
  inject<T>(key: InjectionKey<T>, options: LookupOptions | undefined, direct?: boolean): T | undefined;
}

interface CreationInit {
  key: InjectionKey<unknown>;
  requester: NodeImpl;
  base: NodeImpl;
  placement: NodeImpl | undefined;
  tracker: DepTracker | undefined;
  outer: CreationState | undefined;
  via: Hops | undefined;
  /** A SelfScope inner creation: everything it reads and attaches goes through the outer creation (resolveSelf; DESIGN.md §3.4). */
  delegate?: CreationState;
}

class CreationStateImpl implements CreationState {
  readonly key: InjectionKey<unknown>;
  readonly requester: NodeImpl;
  readonly base: NodeImpl;
  readonly placement: NodeImpl | undefined;
  readonly tracker: DepTracker | undefined;
  readonly outer: CreationState | undefined;
  readonly via: Hops | undefined;
  cycleExempt = false;
  ended = false;
  readonly selfCache: Map<InjectionKey<unknown>, unknown>;
  readonly slot: { node: NodeImpl | undefined };
  readonly ownsSlot: boolean;
  readonly #delegate: CreationState | undefined;

  constructor(init: CreationInit) {
    this.key = init.key;
    this.requester = init.requester;
    this.base = init.base;
    this.placement = init.placement;
    this.tracker = init.tracker;
    this.outer = init.outer;
    this.via = init.via;
    this.#delegate = init.delegate;
    // A SelfScope inner creation shares the outer value's node and per-creation cache.
    this.slot = init.delegate?.slot ?? { node: undefined };
    this.selfCache = init.delegate?.selfCache ?? new Map();
    this.ownsSlot = init.delegate === undefined;
  }

  get nodeIfCreated(): NodeImpl | undefined {
    return this.slot.node;
  }

  node(): NodeImpl {
    if (this.#delegate !== undefined) return this.#delegate.node();
    return (this.slot.node ??= this.requester.createValueNode(keyName(this.key), this.placement));
  }

  inject<T>(key: InjectionKey<T>, options: LookupOptions | undefined, direct = true): T | undefined {
    // Only a skipSelf read of the creation's OWN key (the decorator pattern, DESIGN.md §3.2) is exempt from the
    // frame-chain cycle check. A skipSelf read of another key that reaches this key again is a cycle.
    const own = (key as InjectionKey<unknown>) === this.key;
    const d = this.#delegate;
    if (d !== undefined) {
      // SelfScope inner: deps flow outward — the outer creation tracks them and `ContextKey` is its node (DESIGN.md §3.4).
      // They are this dependency's reads, not the outer factory's own (D7): forwarded with direct = false.
      // The outer exempts its own key in its own skipSelf branch; this frame exempts the inner key.
      if (!options?.skipSelf || !own) return d.inject(key, options, false);
      return this.#exempt(() => d.inject(key, options, false));
    }
    if (key === (ContextKey as InjectionKey<unknown>)) return this.node() as unknown as T; // untracked (DESIGN.md §3.3)
    let r: ResolveResult<unknown>;
    if (options?.skipSelf) {
      // DESIGN.md §3.4: "my parent's answer" is relative to the requester, so an auto-hoisted value that reads it is
      // pinned there: placed at R and never served to another requester, whose parent may answer otherwise.
      this.tracker?.pin(this.requester);
      const base = this.base.up;
      if (base === undefined) {
        this.tracker?.track(key, { resolved: false }, direct);
        return undefined; // the caller turns this into the optional/throw decision
      }
      r = own ? this.#exempt(() => resolveFrom(base, key)) : resolveFrom(base, key);
    } else {
      // Declared placement resolves from S, auto-hoisted from R.
      r = resolveFrom(this.placement ?? this.requester, key);
    }
    // Auto-hoisted only (DESIGN.md §3.3): deps(V) and the deepest dependency. A miss is tracked too (D10′).
    this.tracker?.track(key, r, direct);
    return r.resolved ? (r.value as T) : undefined;
  }

  /** Run `fn` with this frame exempt from the cycle check; restores the previous flag (nested exempt reads). */
  #exempt<R>(fn: () => R): R {
    const was = this.cycleExempt;
    this.cycleExempt = true;
    try {
      return fn();
    } finally {
      this.cycleExempt = was;
    }
  }
}

// ---------------------------------------------------------------------------
// runCreation, the unowned 'join' fork check at the end of creation (D14), finishCreation (DESIGN.md §3.3, §4.6)
// ---------------------------------------------------------------------------

/** The frame chain's keys, outermost first, each preceded by the alias hops that led to it (D36), then `tail`. */
function chain(cs: CreationState | undefined, tail: readonly InjectionKey<unknown>[] = []): string {
  const keys: InjectionKey<unknown>[] = [...tail];
  for (let c: CreationState | undefined = cs; c; c = c.outer) keys.unshift(...(c.via?.keys ?? []), c.key);
  return keys.map(keyName).join(' → ');
}

/**
 * The message chain of a cycle the frame check found: `cs` repeats the key of the enclosing frame `c`. When `cs` was
 * reached through an alias hop that also led to `c`, the cycle closed at that hop, so the chain ends there, as the
 * redirect's own check ends it (D36): an alias `A → B` whose declared-placement class `B` injects `A` again, which
 * the redirect cannot see since `B`'s inject resolves from its storage node, reads `A → B → A`, not `A → B → A → B`.
 */
function cycleChain(cs: CreationState, c: CreationState): string {
  const again = cs.via?.keys.findIndex((k) => c.via?.keys.includes(k) === true) ?? -1;
  return again < 0 ? chain(cs) : chain(cs.outer, cs.via!.keys.slice(0, again + 1));
}

function runCreation<R>(cs: CreationState, produce: () => R): R {
  // Cycle check over the frame chain (replaces the module-level creation stack). A frame whose skipSelf
  // read of its own key is running is exempt: the key is reached again through its own chain (decorator).
  let viaChain = false;
  for (let c = cs.outer; c; c = c.outer)
    if (c.key === cs.key) {
      if (!c.cycleExempt) throw new Error(`Circular dependency detected: ${cycleChain(cs, c)}`);
      viaChain = true;
    }
  let marked: Set<InjectionKey<unknown>> | undefined;
  if (cs.ownsSlot) {
    assertNotReentered(cs, viaChain);
    const inProgress = (cs.requester.root.creating ??= new Set());
    if (!inProgress.has(cs.key)) (marked = inProgress).add(cs.key); // an exempt nested creation leaves the outer's mark
  }
  try {
    let value: R;
    try {
      // Factories are synchronous (A4): the frame is gone when produce returns, and a continuation the
      // factory scheduled that runs later sees no frame (DESIGN.md §3.5).
      value = runInFrame({ node: undefined, creation: cs }, produce);
    } finally {
      cs.ended = true;
    }
    if (value === undefined) throw new FactoryReturnedUndefinedError(`Provider for ${cs.key.name} returned undefined`);
    if (cs.ownsSlot) refuseUnownedJoinForks(cs);
    return value;
  } catch (e) {
    // DESIGN.md §3.3: release the value node's stacks, owned by the requester; nothing is cached. The key
    // is still in progress here, so the abort's synchronous releases cannot re-enter it.
    if (cs.ownsSlot) abandonCreation(cs, e);
    throw e;
  } finally {
    marked?.delete(cs.key);
  }
}

/**
 * Re-entry outside the frame chain (DESIGN.md §3.3). A release or failure handler run during a creation
 * runs under its own frame, so a resolution from there is not nested in the creation's frame chain.
 * (1) An abandoned value node keeps its key until it completes: a creation of that key from its subtree
 * (its releases, sync or async) is a cycle, so a failed factory is never re-run by its own cleanup.
 * (2) Keys in creation are marked on the tree's root while their factory runs: a creation of a key that is in
 * progress in the same tree, not reached through its own frame chain, is a cycle, wherever the release sits.
 */
function assertNotReentered(cs: CreationState, viaChain: boolean): void {
  for (let c: NodeImpl | undefined = cs.requester; c; c = c.up)
    if (c.failedCreation === cs.key)
      throw new Error(
        `Circular dependency detected: ${chain(cs)} re-enters the failed creation of ${keyName(cs.key)} at ${describeNode(c)} ` +
          '(a release of the failed value resolved it again)',
      );
  const root = cs.requester.root;
  if (!viaChain && root.creating?.has(cs.key) === true)
    throw new Error(
      `Circular dependency detected: ${chain(cs)} re-enters the creation of ${keyName(cs.key)} in progress in ${describeNode(root)}'s tree ` +
        '(a release or failure handler run during that creation resolved it again)',
    );
}

/**
 * DESIGN.md §3.3: a failed or refused creation's node is owned by the requester and aborted. Its key is marked on
 * the node until the node completes, and is in progress in the tree while the abort's synchronous releases run,
 * so neither its own releases nor a release reaching another node can run the factory again.
 */
function abandonCreation(cs: CreationState, error: unknown): void {
  const n = cs.nodeIfCreated;
  if (n === undefined) return;
  n.failedCreation = cs.key;
  const inProgress = (cs.requester.root.creating ??= new Set());
  const mark = !inProgress.has(cs.key);
  if (mark) inProgress.add(cs.key);
  try {
    n.abandon(error, cs.requester);
  } finally {
    if (mark) inProgress.delete(cs.key);
  }
}

/** The unowned 'join' fork check for forks made on the value node (or below it) during creation (D14). */
function refuseUnownedJoinForks(cs: CreationState): void {
  for (const f of cs.nodeIfCreated?.creationForks ?? []) {
    if (f.state === 'complete' || f.body === undefined) continue; // settled at birth: nothing left to join
    const p = f.up!;
    if (f.subscribed && f.body.destination === 'join' && !p.hasBody && p.kind !== 'pool')
      throw new TypeError(
        `fork(${f.name ?? 'anonymous'}) in the constructor of ${keyName(cs.key)} has the default 'join' destination ` +
          'and was not owned: write own(fork(…)) or pass onFailure',
      );
  }
}

/**
 * After placement (auto-hoisted) or once the value is cached (declared placement): a declared value's node
 * takes its place on S.provided after its dependencies (G3; DESIGN.md §3.3), then the creation's forks start,
 * never synchronously (I20).
 */
function finishCreation(cs: CreationState): void {
  if (!cs.ownsSlot) return; // a SelfScope inner creation shares the outer's node; the outer finishes it
  const n = cs.nodeIfCreated;
  if (n === undefined) return;
  if (cs.placement !== undefined) n.moveToProvidedTail();
  n.inCreation = false;
  const forks = n.creationForks.splice(0);
  if (forks.length === 0) return;
  runInFrame(NO_NODE, () => {
    for (const f of forks) queueMicrotask(() => f.startBody()); // DESIGN.md §6: no frame; startBody installs the body's own
  });
}

/** The constructor/function arguments declared with `setDependencies`, each resolved with `inject`; undefined when none. */
export function resolveDependencies(key: InjectionKey<unknown>): unknown[] | undefined {
  const deps = getDependencies(key);
  return deps === undefined ? undefined : deps.map((k) => inject(k));
}

function defaultProvider<T>(key: InjectionKey<T>): Provider<T> {
  return { key, provide: () => invokeDefaultFactory(key, resolveDependencies(key)) };
}

// ---------------------------------------------------------------------------
// Decided markers and placement by view (DESIGN.md §3.4)
// ---------------------------------------------------------------------------

/** Mark `keys` decided on every context from `from` up to and including `toInclusive` (DESIGN.md §3.4). */
function markDecided(from: NodeImpl, toInclusive: NodeImpl, keys: Iterable<InjectionKey<unknown>>): void {
  const ks = [...keys];
  for (let c: NodeImpl | undefined = from; c; c = c.up) {
    for (const k of ks) c.decided.add(k);
    if (c === toInclusive) break;
  }
}

/** The first provider for `key` from `C` upward. */
function providerFrom<T>(C: NodeImpl, key: InjectionKey<T>): Provider<T> | undefined {
  for (let c: NodeImpl | undefined = C; c; c = c.up) {
    const p = c.providers?.get(key);
    if (p !== undefined) return p as Provider<T>;
  }
  return undefined;
}

/**
 * The scope `d` resolves under for a requester whose walk finds no provider for `d` below `S` (D10′): none when
 * a provider for `d`, an alias included, sits at or above `S`, since a provider places where it is registered
 * (D36; an alias's target is in deps(V) and checked on its own), else the key's own. No scoped default of `d`
 * is cached below such a provider: creating one decides `d` up to the root (resolveScoped).
 */
function effectiveScope(S: NodeImpl, d: InjectionKey<unknown>): Scope | undefined {
  return providerFrom(S, d) !== undefined ? undefined : getKeyScope(d);
}

/**
 * Whether some `d ∈ deps` resolves differently from `R` than from `S`: provided strictly below `S`,
 * `R` included (DESIGN.md §3.4), or resolving under a scope whose owner lies on `[R, S)` (D10′). SelfScope
 * is excluded: a SelfScope dependency is per-creation, and the value it pins is never served to
 * another requester (DESIGN.md §3.4).
 */
function shadowBetween(R: NodeImpl, S: NodeImpl, deps: ReadonlySet<InjectionKey<unknown>>): boolean {
  let scopes: Map<InjectionKey<unknown>, Scope | undefined> | undefined;
  for (let C = R; C !== S; C = C.up!) {
    if (C.providers !== undefined) for (const d of deps) if (C.providers.has(d)) return true;
    if (C.scopeSet !== undefined)
      for (const d of deps) {
        scopes ??= new Map();
        if (!scopes.has(d)) scopes.set(d, effectiveScope(S, d));
        const σ = scopes.get(d);
        if (σ !== undefined && σ !== SelfScope && C.scopeSet.has(σ)) return true;
      }
  }
  return false;
}

function hitResult<T>(e: CacheEntry, S: NodeImpl): ResolvedResult<T> {
  return {
    resolved: true,
    value: e.value as T,
    node: S,
    autoHoisted: e.autoHoisted,
    deps: e.deps,
    created: false,
    pinned: e.pinned,
  };
}

/** Not narrowed by TypeScript across a factory call: the factory may complete the node. */
function isComplete(n: NodeImpl): boolean {
  return n.state === 'complete';
}

function assertLive(hit: CacheEntry, key: InjectionKey<unknown>): void {
  if (hit.valueNode !== undefined && hit.valueNode.state === 'complete')
    throw new NodeCompletedError(`${keyName(key)} has been released`); // I22: escape fails loudly (DESIGN.md §2.7)
}

// ---------------------------------------------------------------------------
// aliasProvider redirects (D36)
// ---------------------------------------------------------------------------

/**
 * The alias keys a redirect chain has followed in one resolution, and the base `R` it resolves from (D36). A
 * creation reached through a redirect keeps them (`CreationState.via`).
 */
interface Hops {
  readonly keys: readonly InjectionKey<unknown>[];
  readonly base: NodeImpl;
}

const NO_HOPS: readonly InjectionKey<unknown>[] = [];

/** An alias provider → its target. Written by `aliasProvider` (provider-util.ts); read by resolveFrom's provider branch only. */
const aliasTargets = new WeakMap<Provider<unknown>, InjectionKey<unknown>>();

/** Mark `p` as a redirect to `target` (provider-util.ts `aliasProvider`). Its shape stays `{ key, provide }`. */
export function markAlias(p: Provider<unknown>, target: InjectionKey<unknown>): void {
  aliasTargets.set(p, target);
}

/**
 * `key` provided at `N` by an alias (D36): resolve `target` from `R`, the base of the walk that found the alias,
 * by `target`'s own rules, and cache nothing under `key`. The alias is `N`'s decision on `key` (D10′). The result
 * carries the chain and the deepest alias node, resolved or not, for the tracking creation (DepTracker.track).
 * A redirect runs no factory, so runCreation's frame check cannot see a cycle of aliases: following a key already
 * followed in this resolution, or by a creation in progress reached through it from the same base, is a cycle. A
 * repeat from another base is left to the frame check, which ends its message at the repeated hop (cycleChain): a
 * declared-placement target resolves its injects from its storage node, from which the same key may legitimately
 * reach another alias, or the same alias and then other providers, and a `skipSelf` read resolves from the parent.
 */
function redirect<T>(
  R: NodeImpl,
  N: NodeImpl,
  key: InjectionKey<T>,
  target: InjectionKey<unknown>,
  hops: readonly InjectionKey<unknown>[],
): ResolveResult<T> {
  const cs = currentCreation();
  let cycle = hops.includes(key);
  for (let c = cs; c && !cycle; c = c.outer) cycle = c.via?.base === R && c.via.keys.includes(key);
  if (cycle) throw new Error(`Circular dependency detected: ${chain(cs, [...hops, key])}`);
  const r = resolveFrom(R, target, [...hops, key]) as ResolveResult<T>;
  markDecided(R, N, [key]);
  const inner = r.via;
  const via: Redirected = {
    keys: [key, ...(inner?.keys ?? [target])],
    node: inner !== undefined && inner.node.depth > N.depth ? inner.node : N,
  };
  return { ...r, via };
}

// ---------------------------------------------------------------------------
// resolveFrom — the walk (DESIGN.md §3.4)
// ---------------------------------------------------------------------------

/**
 * Resolve `key` for requester `R`: the walk `NodeImpl.get` and `inject` share. `hops` are the alias keys a redirect
 * chain followed to reach `key` (D36).
 */
export function resolveFrom<T>(
  R: NodeImpl,
  key: InjectionKey<T>,
  hops: readonly InjectionKey<unknown>[] = NO_HOPS,
): ResolveResult<T> {
  const via: Hops | undefined = hops.length > 0 ? { keys: hops, base: R } : undefined;
  for (let C: NodeImpl | undefined = R; C; C = C.up) {
    if (C.state === 'pending')
      throw new PendingNodeError(
        `resolution of ${keyName(key)} reached pending node ${describeNode(C)}: a value's node cannot resolve before placement`,
      );
    if (C.state === 'complete')
      throw new NodeCompletedError(`resolution of ${keyName(key)} walked through completed node ${describeNode(C)}`);
    const hit = C.cache.get(key);
    if (hit !== undefined) {
      // In order: is this R's answer at all (SelfScope and scoped hits, DESIGN.md §3.1; placement by view), and
      // only then is it alive (I22).
      // DESIGN.md §3.1: inside a creation a SelfScope key is per-creation, even where a [SelfScope] boundary has
      // stored one: the creation is a nearer SelfScope owner than C, as with the nested boundaries below.
      if (hit.scope === SelfScope && currentCreation() !== undefined)
        return resolveScoped(R, key, SelfScope, providerFrom(C, key), via);
      // DESIGN.md §3.1: a scoped value stored at an outer owner of its scope is not R's answer when R's own owner of
      // that scope (a nested σ-context, a SelfScope boundary) lies on [R, C): R's value is made there.
      if (hit.scope !== undefined && R.findScopedContext(hit.scope) !== C)
        return resolveScoped(R, key, hit.scope, providerFrom(C, key), via);
      // Placement by view (DESIGN.md §3.4, D10′): a dependency shadowed on [R, C), or a value pinned at another
      // requester, means this cache is not R's view: V's factory runs from R.
      if (
        hit.autoHoisted &&
        ((hit.pinned && R !== C) || (hit.deps !== undefined && hit.deps.size > 0 && shadowBetween(R, C, hit.deps)))
      )
        return createAutoHoisted(R, key, hit.direct, via); // the re-run must inject the same keys itself (D7)
      assertLive(hit, key); // I22: R's own answer was released (DESIGN.md §2.7)
      markDecided(R, C, hit.deps === undefined ? [key] : [key, ...hit.deps]);
      return hitResult(hit, C);
    }
    const p = C.providers?.get(key);
    if (p !== undefined) {
      const target = aliasTargets.get(p);
      if (target !== undefined) return redirect(R, C, key, target, hops);
      // A provider is a statement of placement: its value is stored here, whatever the key's scope (D36).
      const r = createExplicit(C, p as Provider<T>, R, undefined, via);
      markDecided(R, C, [key]);
      return r;
    }
  }
  const scope = getKeyScope(key);
  if (scope !== undefined) return resolveScoped(R, key, scope, undefined, via);
  if (hasDefaultFactory(key)) return createAutoHoisted(R, key, undefined, via);
  markDecided(R, R.root, [key]); // "not provided here" is a decision on the whole walk
  return { resolved: false };
}

/**
 * A key's scoped default: stored at R's nearest owner of `scope`; SelfScope during creation is per-creation and
 * unstored. A provider never comes here (D36): `provider` is the one found from a scoped cache hit upward, which
 * is always `undefined` since creating the default decided the key up to the root.
 */
function resolveScoped<T>(
  R: NodeImpl,
  key: InjectionKey<T>,
  scope: Scope,
  provider: Provider<T> | undefined,
  via: Hops | undefined,
): ResolveResult<T> {
  if (scope === SelfScope) {
    const cs = currentCreation();
    if (cs !== undefined) return resolveSelf(cs, key, provider, via); // per-creation, unstored, unmarked
    // Outside creation a context with scopes: [SelfScope] is the boundary: fall through.
  }
  const T = R.findScopedContext(scope);
  if (T === undefined) {
    if (scope === SelfScope)
      throw new Error(
        `SelfScope key '${keyName(key)}' can only be injected during value creation or from a context with scopes: [SelfScope].`,
      );
    throw new Error(`No context found for scope '${scope.name}' when resolving key: ${keyName(key)}`);
  }
  const hit = T.cache.get(key);
  if (hit !== undefined) {
    assertLive(hit, key);
    markDecided(R, T, [key]);
    return hitResult(hit, T);
  }
  if (provider === undefined && !hasDefaultFactory(key)) {
    // The provider search already walked to the root (a scoped key may be provided at or above its scope
    // owner), so "not provided" is a decision on the whole walk, as for an unscoped miss (I19).
    markDecided(R, R.root, [key]);
    return { resolved: false };
  }
  const r = createExplicit(T, provider ?? defaultProvider(key), R, scope, via);
  // The provider search already walked to the root without finding one, so a default decides the key on the whole
  // walk, as a miss does: no ancestor can provide it later, which would serve R's descendants a value built from
  // another view (D10′, I19), and no provider ever sits above a scoped default (effectiveScope).
  markDecided(R, provider === undefined ? R.root : T, [key]);
  return r;
}

/**
 * Auto-hoisting (D7): run the default factory from R, place the value at its deepest dependency (or the capture
 * boundary). `expected` is the recorded set of keys the factory injected itself, for the instance a
 * placement-by-view re-creation refused: the re-run must inject exactly those keys, or the factory is
 * non-deterministic and the resolution fails (D7). The closure deps(V) may legitimately differ: a shadow can change
 * a dependency's kind (a provided value in place of an auto-hoisted one, an override of an alias).
 */
function createAutoHoisted<T>(
  R: NodeImpl,
  key: InjectionKey<T>,
  expected: ReadonlySet<InjectionKey<unknown>> | undefined,
  via: Hops | undefined,
): ResolvedResult<T> {
  const tracker = new DepTracker(R.autoScopeRoot);
  const cs = new CreationStateImpl({ key, requester: R, base: R, placement: undefined, tracker, outer: currentCreation(), via });
  const value = runCreation(cs, () => invokeDefaultFactory(key, resolveDependencies(key)));
  if (expected !== undefined && !sameKeys(tracker.direct, expected)) {
    const err = new PlacementError(
      `${keyName(key)} injected {${names(tracker.direct)}} when re-created from ${describeNode(R)}, but ` +
        `{${names(expected)}} when first created. An auto-hoisted factory must inject the same keys on every run; ` +
        'make the factory deterministic, or give the key an explicit scope or provider (D7).',
    );
    abandonCreation(cs, err);
    throw err;
  }
  let S = tracker.deepest;
  if (R.autoScopeRoot.depth > S.depth) S = R.autoScopeRoot; // the captureAutoScoped clamp
  if (isComplete(S)) {
    // DESIGN.md §3.3: placement into a complete storage context throws, and the resolution fails on use.
    const err = new NodeCompletedError(`cannot place ${keyName(key)} on completed ${describeNode(S)}`);
    abandonCreation(cs, err); // owned by R, or the nearest open node above it (DESIGN.md §3.3)
    throw err;
  }
  const n = cs.nodeIfCreated;
  const existing = S.cache.get(key);
  if (existing !== undefined) {
    // Unreachable given the same-keys check above (D7: equal deps place the re-run at or below the shadow). Kept as the I19 guard:
    // an answer S has given is never overwritten, and a placement that would needs to fail loudly.
    const err = new PlacementError(
      `${keyName(key)} re-created from ${describeNode(R)} landed on ${describeNode(S)}, which already holds an instance (D7).`,
    );
    abandonCreation(cs, err);
    throw err;
  }
  const deps = new Set(tracker.deps);
  const direct = new Set(tracker.direct);
  const pinned = tracker.pinned;
  S.cache.set(key, { value, node: S, autoHoisted: true, deps, direct, valueNode: n, scope: undefined, pinned });
  n?.placeAt(S); // pending → running; the tail of S.provided: if S is releasing, released next (DESIGN.md §2.4)
  finishCreation(cs);
  markDecided(R, S, [key, ...deps]);
  return { resolved: true, value, node: S, autoHoisted: true, deps, created: true, pinned };
}

/**
 * Declared placement (a provider's context, or a key's scope owner for its default; `scope` is the key's scope for
 * a default, `undefined` for a provider): the value's node is live on S from its first touch, and moves after its
 * dependencies on S.provided when the creation ends (DESIGN.md §3.3).
 */
function createExplicit<T>(
  S: NodeImpl,
  provider: Provider<T>,
  R: NodeImpl,
  scope: Scope | undefined,
  via: Hops | undefined,
): ResolvedResult<T> {
  if (S.state === 'complete')
    throw new NodeCompletedError(`cannot place ${keyName(provider.key)} on completed ${describeNode(S)}`);
  const cs = new CreationStateImpl({
    key: provider.key,
    requester: R,
    base: S,
    placement: S,
    tracker: undefined,
    outer: currentCreation(),
    via,
  });
  const value = runCreation(cs, () => provider.provide());
  const n = cs.nodeIfCreated;
  if (isComplete(S)) {
    // The factory itself completed S (e.g. aborted it): nothing may be cached on a complete node.
    const err = new NodeCompletedError(`cannot place ${keyName(provider.key)} on completed ${describeNode(S)}`);
    abandonCreation(cs, err);
    throw err;
  }
  if (n !== undefined && (n.state !== 'running' || n.delivered)) {
    // The value's own node was aborted, closed or completed during its factory (by S's release loop,
    // or by the factory itself): its owned resources are released or being released, so the value is dead.
    const err = new NodeCompletedError(`${keyName(provider.key)} was released during its own creation`);
    abandonCreation(cs, err);
    throw err;
  }
  const existing = S.cache.get(provider.key);
  if (existing !== undefined) {
    // Never overwrite an answer S has given (I19). The re-entry check in runCreation (DESIGN.md §3.3) makes
    // this unreachable for a cycle; it stays as the guard, like the one for auto-hoisted values (D7).
    abandonCreation(cs, new Error(`duplicate placement of ${keyName(provider.key)} at ${describeNode(S)}`));
    return hitResult(existing, S);
  }
  S.cache.set(provider.key, {
    value,
    node: S,
    autoHoisted: false,
    deps: undefined,
    direct: undefined,
    valueNode: n,
    scope,
    pinned: false,
  });
  finishCreation(cs);
  return { resolved: true, value, node: S, autoHoisted: false, deps: undefined, created: true, pinned: false };
}

/**
 * SelfScope during creation: one instance per creation, unstored and unmarked. Its own reads and
 * attachments go through the outer creation, so its dependencies are the outer value's and its `own()`
 * lands on the outer value's node. The result's node is the outer resolution base, which places an
 * auto-hoisted outer value at its requester (DESIGN.md §3.4), and the result is pinned, so that value is never
 * served to another requester.
 */
function resolveSelf<T>(
  outer: CreationState,
  key: InjectionKey<T>,
  provider: Provider<T> | undefined,
  via: Hops | undefined,
): ResolveResult<T> {
  if (outer.selfCache.has(key))
    return {
      resolved: true,
      value: outer.selfCache.get(key) as T,
      node: outer.base,
      autoHoisted: false,
      deps: undefined,
      created: false,
      pinned: true,
    };
  if (provider === undefined && !hasDefaultFactory(key)) return { resolved: false }; // inject() decides optional/throw
  const cs = new CreationStateImpl({
    key,
    requester: outer.requester,
    base: outer.base,
    placement: outer.placement,
    tracker: undefined,
    outer,
    via,
    delegate: outer,
  });
  const value = runCreation(cs, () =>
    provider !== undefined ? provider.provide() : invokeDefaultFactory(key, resolveDependencies(key)),
  );
  outer.selfCache.set(key, value);
  return { resolved: true, value, node: outer.base, autoHoisted: false, deps: undefined, created: true, pinned: true };
}

// ---------------------------------------------------------------------------
// Provider placement rules (DESIGN.md §3.4)
// ---------------------------------------------------------------------------

/**
 * PlacementError iff the key is decided at `C` (not at construction: a fresh node has no decisions; D10′). A
 * provider is stored where it is registered, whatever the key's scope (D36), so its placement needs no other
 * check; the key's scope is still read, and discarded, so that a malformed `static scope` is a TypeError at
 * registration (D32).
 */
export function assertProviderPlacement(C: NodeImpl, p: Provider<unknown>, atConstruction: boolean): void {
  if (!atConstruction && C.decided.has(p.key))
    throw new PlacementError(
      `Cannot provide '${keyName(p.key)}' at ${describeNode(C)}: the key has already been decided here. ` +
        'Providers must be registered before any resolution of the key through this context.',
    );
  getKeyScope(p.key); // validation only (D32)
}

// ---------------------------------------------------------------------------
// The NodeTopic receiver (DESIGN.md §5)
// ---------------------------------------------------------------------------

/** Resolve the root's receiver once with the raw walk (not `get`); events emitted while it resolves are dropped. */
export function resolveReceiver(root: NodeImpl): TopicReceiver<NodeEvent> | undefined {
  root.receiver = 'resolving';
  let receiver: TopicReceiver<NodeEvent> | undefined;
  try {
    const r = resolveFrom(root, NodeTopic);
    receiver = r.resolved && typeof r.value === 'function' ? r.value : undefined;
  } finally {
    root.receiver = receiver;
  }
  return receiver;
}
