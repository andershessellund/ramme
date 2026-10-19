// ---------------------------------------------------------------------------
// Resolution and creation (PROPOSAL.md §6.2, §8; IMPLEMENTATION.md §1.11,
// §2.3, §4.9–§4.11).
//
// - `inject` is the only creation-time read (§8.1). It is tracked for
//   auto-hoisted values: `deps(V)` (misses included, D-43) and the deepest
//   dependency decide where `V` is placed (D7).
// - `resolveFrom` is the one walk `NodeImpl.get` and `inject` share. It
//   marks every context on the walk *decided* (§8.2), serves a cache hit only
//   when the hit is the requester's own view (placement by view, D-20; scope
//   shadows, D-44; scoped hits, D-92), and otherwise creates: at a provider's
//   context, at a scope owner, or — auto-hoisted — at the deepest dependency.
// - Creation runs synchronously (A5) under a creation frame. The value's node
//   is created on demand: pending until placement for an auto-hoisted value,
//   live on the storage context's provided stack for a declared placement
//   (§6.2). A failed creation releases what the node owns, with the requester
//   as its owner (P23, D-99); forks made during creation start after
//   placement (I20), and an unowned `'join'` fork fails the resolution (Q6,
//   D-15). A creation re-entered from a release it started is a cycle (D-101,
//   D-106), and so is one re-entered from the releases of a failed creation
//   (D-105). The creation ends when its factory returns (D-107).
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
import type { CacheEntry, ResolveResult, ResolvedResult } from './internal-context.js';
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

/** The value's own node during creation: `inject(ContextKey)` is `current()` there (§7.2, §8.1). Inject-only (D-18). */
export const ContextKey: InjectionKey<Context> = createInjectionKey<Context>('Context');

function keyName(key: InjectionKey<unknown>): string {
  return getKeyDescription(key);
}

/** `${name ?? kind}#${id}`, for messages. */
export function describeNode(node: NodeImpl): string {
  return `${node.name ?? node.kind}#${node.id}`;
}

/** D-26: dev mode is `process.env.NODE_ENV !== 'production'`, and always on where `process` is absent. */
function dev(): boolean {
  return (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV !== 'production';
}

// ---------------------------------------------------------------------------
// inject — creation-time only (§8.1)
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
        'use lookup() at runtime', // §5: starts with the specified text
    );
  const value = cs.inject(key, options);
  if (value === undefined && !options?.optional) throw new Error(`No provider found for ${key.name}`);
  return value;
}

// ---------------------------------------------------------------------------
// DepTracker and CreationState
// ---------------------------------------------------------------------------

/** deps(V), the deepest dependency and the pin of an auto-hoisted value (§8.2, D-43, D-97). */
export class DepTracker {
  deepest: NodeImpl;
  readonly deps = new Set<InjectionKey<unknown>>();
  /** V read something requester-relative: it is served only at its storage context (D-97). */
  pinned = false;

  constructor(start: NodeImpl) {
    this.deepest = start;
  }

  /**
   * deps ∪= {key} always, a miss included (D-43); on a hit: deepest by depth, deps ∪= r.deps when r is
   * auto-hoisted, and a pinned result pins V (D-97). A per-creation SelfScope result's node is the
   * requester, so it also makes the requester the deepest dependency.
   */
  track(key: InjectionKey<unknown>, r: ResolveResult<unknown>): void {
    this.deps.add(key);
    if (!r.resolved) return;
    if (r.node.depth > this.deepest.depth) this.deepest = r.node;
    if (r.autoHoisted && r.deps) for (const d of r.deps) this.deps.add(d);
    if (r.pinned) this.pinned = true;
  }

  /** A requester-relative read (`skipSelf`) pins V at the requester `at` (D-97). */
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
  /** True while a skipSelf resolve of the same key runs. */
  cycleExempt: boolean;
  /**
   * Set by runCreation when the factory returns or throws (D-107). A creation frame whose creation has
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
  inject<T>(key: InjectionKey<T>, options: LookupOptions | undefined): T | undefined;
}

interface CreationInit {
  key: InjectionKey<unknown>;
  requester: NodeImpl;
  base: NodeImpl;
  placement: NodeImpl | undefined;
  tracker: DepTracker | undefined;
  outer: CreationState | undefined;
  /** A SelfScope inner creation: everything it reads and attaches goes through the outer creation (§4.10 resolveSelf). */
  delegate?: CreationState;
}

class CreationStateImpl implements CreationState {
  readonly key: InjectionKey<unknown>;
  readonly requester: NodeImpl;
  readonly base: NodeImpl;
  readonly placement: NodeImpl | undefined;
  readonly tracker: DepTracker | undefined;
  readonly outer: CreationState | undefined;
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
    this.#delegate = init.delegate;
    // A SelfScope inner creation shares the outer value's node and per-creation cache (D-94).
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

  inject<T>(key: InjectionKey<T>, options: LookupOptions | undefined): T | undefined {
    // §1.11: only a skipSelf read of the creation's OWN key (the decorator pattern) is exempt from the
    // frame-chain cycle check. A skipSelf read of another key that reaches this key again is a cycle.
    const own = (key as InjectionKey<unknown>) === this.key;
    const d = this.#delegate;
    if (d !== undefined) {
      // SelfScope inner: deps flow outward — the outer creation tracks them and `ContextKey` is its node (§4.10).
      // The outer exempts its own key in its own skipSelf branch; this frame exempts the inner key (D-94(b)).
      if (!options?.skipSelf || !own) return d.inject(key, options);
      return this.#exempt(() => d.inject(key, options));
    }
    if (key === (ContextKey as InjectionKey<unknown>)) return this.node() as unknown as T; // untracked (§8.1)
    let r: ResolveResult<unknown>;
    if (options?.skipSelf) {
      // D-97: "my parent's answer" is relative to the requester, so an auto-hoisted value that reads it is
      // pinned there: placed at R and never served to another requester, whose parent may answer otherwise.
      this.tracker?.pin(this.requester);
      const base = this.base.parent;
      if (base === undefined) {
        this.tracker?.track(key, { resolved: false });
        return undefined; // the caller turns this into the optional/throw decision
      }
      r = own ? this.#exempt(() => resolveFrom(base, key)) : resolveFrom(base, key);
    } else {
      // Declared placement resolves from S, auto-hoisted from R (§2.3).
      r = resolveFrom(this.placement ?? this.requester, key);
    }
    // Auto-hoisted only (§8.1): deps(V) and the deepest dependency. A miss is tracked too (D-43).
    this.tracker?.track(key, r);
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
// runCreation, the Q6 check at the end of creation, finishCreation (§2.3, §4.9)
// ---------------------------------------------------------------------------

function chain(cs: CreationState): string {
  const keys: InjectionKey<unknown>[] = [];
  for (let c: CreationState | undefined = cs; c; c = c.outer) keys.unshift(c.key);
  return keys.map(keyName).join(' → ');
}

function runCreation<R>(cs: CreationState, produce: () => R): R {
  // Cycle check over the frame chain (replaces the module-level creation stack). A frame whose skipSelf
  // read of its own key is running is exempt: the key is reached again through its own chain (decorator).
  let viaChain = false;
  for (let c = cs.outer; c; c = c.outer)
    if (c.key === cs.key) {
      if (!c.cycleExempt) throw new Error(`Circular dependency detected: ${chain(cs)}`);
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
      // Factories are synchronous (A5): the frame is gone when produce returns, and a continuation the
      // factory scheduled that runs later sees no frame (D-107).
      value = runInFrame({ node: undefined, creation: cs }, produce);
    } finally {
      cs.ended = true;
    }
    if (value === undefined) throw new FactoryReturnedUndefinedError(`Provider for ${cs.key.name} returned undefined`);
    if (cs.ownsSlot) refuseUnownedJoinForks(cs);
    return value;
  } catch (e) {
    // §8.3: release the value node's stacks, owned by the requester (D-99); nothing is cached (P23). The key
    // is still in progress here, so the abort's synchronous releases cannot re-enter it (D-105).
    if (cs.ownsSlot) abandonCreation(cs, e);
    throw e;
  } finally {
    marked?.delete(cs.key);
  }
}

/**
 * Re-entry outside the frame chain (D-101, D-105, D-106). A release or failure handler run during a creation
 * runs under its own frame, so a resolution from there is not nested in the creation's frame chain.
 * (1) An abandoned value node keeps its key until it completes: a creation of that key from its subtree
 * (its releases, sync or async) is a cycle, so a failed factory is never re-run by its own cleanup.
 * (2) Keys in creation are marked on the tree's root while their factory runs: a creation of a key that is in
 * progress in the same tree, not reached through its own frame chain, is a cycle, wherever the release sits.
 */
function assertNotReentered(cs: CreationState, viaChain: boolean): void {
  for (let c: NodeImpl | undefined = cs.requester; c; c = c.parent)
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
 * D-99, D-105: a failed or refused creation's node is owned by the requester and aborted. Its key is marked on
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

/** Q6 for forks made on the value node (or below it) during creation (D-15). */
function refuseUnownedJoinForks(cs: CreationState): void {
  for (const f of cs.nodeIfCreated?.creationForks ?? []) {
    if (f.state === 'complete' || f.body === undefined) continue; // settled at birth: nothing left to join (D-75(g))
    const p = f.parent!;
    if (f.subscribed && f.body.destination === 'join' && !p.hasBody && p.kind !== 'pool')
      throw new TypeError(
        `fork(${f.name ?? 'anonymous'}) in the constructor of ${keyName(cs.key)} has the default 'join' destination ` +
          'and was not owned: write own(fork(…)) or pass onFailure',
      );
  }
}

/**
 * After placement (auto-hoisted) or once the value is cached (declared placement): a declared value's node
 * takes its place on S.provided after its dependencies (G3, D-100), then the creation's forks start,
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
    for (const f of forks) queueMicrotask(() => f.startBody()); // D-46: no frame; startBody installs the body's own
  });
}

function resolveDependencies(key: InjectionKey<unknown>): unknown[] | undefined {
  const deps = getDependencies(key);
  return deps === undefined ? undefined : deps.map((k) => inject(k));
}

function defaultProvider<T>(key: InjectionKey<T>): Provider<T> {
  return { key, provide: () => invokeDefaultFactory(key, resolveDependencies(key)) };
}

// ---------------------------------------------------------------------------
// Decided markers and placement by view (§8.2)
// ---------------------------------------------------------------------------

/** Mark `keys` decided on every context from `from` up to and including `toInclusive` (§8.2). */
function markDecided(from: NodeImpl, toInclusive: NodeImpl, keys: Iterable<InjectionKey<unknown>>): void {
  const ks = [...keys];
  for (let c: NodeImpl | undefined = from; c; c = c.parent) {
    for (const k of ks) c.decided.add(k);
    if (c === toInclusive) break;
  }
}

/** The first provider for `key` from `C` upward. */
function providerFrom<T>(C: NodeImpl, key: InjectionKey<T>): Provider<T> | undefined {
  for (let c: NodeImpl | undefined = C; c; c = c.parent) {
    const p = c.providers?.get(key);
    if (p !== undefined) return p as Provider<T>;
  }
  return undefined;
}

/**
 * The scope `d` resolves under for a requester whose walk finds no provider for `d` below `S`: the
 * first provider's scope from `S` upward, else the key's own (D-93).
 */
function effectiveScope(S: NodeImpl, d: InjectionKey<unknown>): Scope | undefined {
  return providerFrom(S, d)?.scope ?? getKeyScope(d);
}

/**
 * Whether some `d ∈ deps` resolves differently from `R` than from `S`: provided strictly below `S`,
 * `R` included (§8.2), or resolving under a scope whose owner lies on `[R, S)` (D-44, D-93). SelfScope
 * is excluded: a SelfScope dependency is per-creation, and the value it pins is never served to
 * another requester (D-97).
 */
function shadowBetween(R: NodeImpl, S: NodeImpl, deps: ReadonlySet<InjectionKey<unknown>>): boolean {
  let scopes: Map<InjectionKey<unknown>, Scope | undefined> | undefined;
  for (let C = R; C !== S; C = C.parent!) {
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

/** Not narrowed by TypeScript across a factory call: the factory may complete the node (D-94). */
function isComplete(n: NodeImpl): boolean {
  return n.state === 'complete';
}

function assertLive(hit: CacheEntry, key: InjectionKey<unknown>): void {
  if (hit.valueNode !== undefined && hit.valueNode.state === 'complete')
    throw new NodeCompletedError(`${keyName(key)} has been released`); // I22: escape fails loudly (D-22)
}

// ---------------------------------------------------------------------------
// resolveFrom — the walk (§4.10)
// ---------------------------------------------------------------------------

/** Resolve `key` for requester `R`: the walk `NodeImpl.get` and `inject` share. */
export function resolveFrom<T>(R: NodeImpl, key: InjectionKey<T>): ResolveResult<T> {
  for (let C: NodeImpl | undefined = R; C; C = C.parent) {
    if (C.state === 'pending')
      throw new PendingNodeError(
        `resolution of ${keyName(key)} reached pending node ${describeNode(C)}: a value's node cannot resolve before placement`,
      );
    if (C.state === 'complete')
      throw new NodeCompletedError(`resolution of ${keyName(key)} walked through completed node ${describeNode(C)}`);
    const hit = C.cache.get(key);
    if (hit !== undefined) {
      // In order: is this R's answer at all (D-96, D-92, placement by view), and only then is it alive (D-98).
      // D-96: inside a creation a SelfScope key is per-creation (§4.10), even where a [SelfScope] boundary has
      // stored one: the creation is a nearer SelfScope owner than C, as D-92 reasons for nested boundaries.
      if (hit.scope === SelfScope && currentCreation() !== undefined)
        return resolveScoped(R, key, SelfScope, providerFrom(C, key));
      // D-92: a scoped value stored at an outer owner of its scope is not R's answer when R's own owner of
      // that scope (a nested σ-context, a SelfScope boundary) lies on [R, C): R's value is made there.
      if (hit.scope !== undefined && R.findScopedContext(hit.scope) !== C)
        return resolveScoped(R, key, hit.scope, providerFrom(C, key));
      // Placement by view (§8.2, D-20): a dependency shadowed on [R, C), or a value pinned at another
      // requester (D-97), means this cache is not R's view: V's factory runs from R.
      if (
        hit.autoHoisted &&
        ((hit.pinned && R !== C) || (hit.deps !== undefined && hit.deps.size > 0 && shadowBetween(R, C, hit.deps)))
      )
        return createAutoHoisted(R, key);
      assertLive(hit, key); // I22: R's own answer was released (D-22)
      markDecided(R, C, hit.deps === undefined ? [key] : [key, ...hit.deps]);
      return hitResult(hit, C);
    }
    const p = C.providers?.get(key);
    if (p !== undefined) {
      const scope = p.scope ?? getKeyScope(key);
      if (scope !== undefined) return resolveScoped(R, key, scope, p as Provider<T>);
      const r = createExplicit(C, p as Provider<T>, R, undefined);
      markDecided(R, C, [key]);
      return r;
    }
  }
  const scope = getKeyScope(key);
  if (scope !== undefined) return resolveScoped(R, key, scope, undefined);
  if (hasDefaultFactory(key)) return createAutoHoisted(R, key);
  markDecided(R, R.root, [key]); // "not provided here" is a decision on the whole walk
  return { resolved: false };
}

/** A scoped key: stored at R's nearest owner of `scope`; SelfScope during creation is per-creation and unstored. */
function resolveScoped<T>(R: NodeImpl, key: InjectionKey<T>, scope: Scope, provider: Provider<T> | undefined): ResolveResult<T> {
  if (scope === SelfScope) {
    const cs = currentCreation();
    if (cs !== undefined) return resolveSelf(cs, key, provider); // per-creation, unstored, unmarked
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
    markDecided(R, T, [key]);
    return { resolved: false };
  }
  const r = createExplicit(T, provider ?? defaultProvider(key), R, scope);
  markDecided(R, T, [key]);
  return r;
}

/** Auto-hoisting (D7): run the default factory from R, place the value at its deepest dependency (or the capture boundary). */
function createAutoHoisted<T>(R: NodeImpl, key: InjectionKey<T>): ResolvedResult<T> {
  const tracker = new DepTracker(R.autoScopeRoot);
  const cs = new CreationStateImpl({ key, requester: R, base: R, placement: undefined, tracker, outer: currentCreation() });
  const value = runCreation(cs, () => invokeDefaultFactory(key, resolveDependencies(key)));
  let S = tracker.deepest;
  if (R.autoScopeRoot.depth > S.depth) S = R.autoScopeRoot; // the captureAutoScoped clamp
  if (isComplete(S)) {
    // §6.2: placement into a complete storage context throws, and the resolution fails on use.
    const err = new NodeCompletedError(`cannot place ${keyName(key)} on completed ${describeNode(S)}`);
    abandonCreation(cs, err); // owned by R, or the nearest open node above it (D-99)
    throw err;
  }
  const n = cs.nodeIfCreated;
  const misplaced = n === undefined ? undefined : misplacedScopedProviders(n, S)[0];
  if (misplaced !== undefined) {
    // D-108: the scope rule of §4.11 for a provider built under the pending node, whose walk could not reach
    // the scope owner before placement. Refused as a live node refuses it; nothing is cached.
    const err = scopedPlacementError(misplaced.node, misplaced.provider, misplaced.owner);
    abandonCreation(cs, err);
    throw err;
  }
  const existing = S.cache.get(key);
  if (existing !== undefined) {
    // D-21: a factory whose dependencies varied landed where an instance exists. Never overwrite an answer (I19).
    abandonCreation(cs, new Error(`duplicate placement of ${keyName(key)} at ${describeNode(S)}`));
    if (dev())
      console.warn(
        `ramme: ${keyName(key)} was re-created from ${describeNode(R)} and landed on ${describeNode(S)}, which already ` +
          'holds an instance; the existing one is used. Its factory injects different keys on different runs (D-21).',
      );
    markDecided(R, S, existing.deps === undefined ? [key] : [key, ...existing.deps]);
    return hitResult(existing, S);
  }
  const deps = new Set(tracker.deps);
  const pinned = tracker.pinned;
  S.cache.set(key, { value, node: S, autoHoisted: true, deps, valueNode: n, scope: undefined, pinned });
  n?.placeAt(S); // pending → running; the tail of S.provided: if S is releasing, released next (§6.2)
  finishCreation(cs);
  markDecided(R, S, [key, ...deps]);
  return { resolved: true, value, node: S, autoHoisted: true, deps, created: true, pinned };
}

/**
 * Declared placement (a provider's context, or a scope owner): the value's node is live on S from its first
 * touch (§6.2), and moves after its dependencies on S.provided when the creation ends (D-100).
 */
function createExplicit<T>(
  S: NodeImpl,
  provider: Provider<T>,
  R: NodeImpl,
  scope: Scope | undefined,
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
  });
  const value = runCreation(cs, () => provider.provide());
  const n = cs.nodeIfCreated;
  if (isComplete(S)) {
    // D-94: the factory itself completed S (e.g. aborted it): nothing may be cached on a complete node.
    const err = new NodeCompletedError(`cannot place ${keyName(provider.key)} on completed ${describeNode(S)}`);
    abandonCreation(cs, err);
    throw err;
  }
  if (n !== undefined && (n.state !== 'running' || n.delivered)) {
    // D-102: the value's own node was aborted, closed or completed during its factory (by S's release loop,
    // or by the factory itself): its owned resources are released or being released, so the value is dead.
    const err = new NodeCompletedError(`${keyName(provider.key)} was released during its own creation`);
    abandonCreation(cs, err);
    throw err;
  }
  const existing = S.cache.get(provider.key);
  if (existing !== undefined) {
    // D-101: never overwrite an answer S has given (I19). The re-entry check in runCreation makes this
    // unreachable for a cycle; it stays as the guard D-21 is for auto-hoisted values.
    abandonCreation(cs, new Error(`duplicate placement of ${keyName(provider.key)} at ${describeNode(S)}`));
    return hitResult(existing, S);
  }
  S.cache.set(provider.key, {
    value,
    node: S,
    autoHoisted: false,
    deps: undefined,
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
 * auto-hoisted outer value at its requester (§4.10), and the result is pinned, so that value is never
 * served to another requester (D-97).
 */
function resolveSelf<T>(outer: CreationState, key: InjectionKey<T>, provider: Provider<T> | undefined): ResolveResult<T> {
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
  if (provider === undefined && !hasDefaultFactory(key)) return { resolved: false }; // D-94: inject() decides optional/throw
  const cs = new CreationStateImpl({
    key,
    requester: outer.requester,
    base: outer.base,
    placement: outer.placement,
    tracker: undefined,
    outer,
    delegate: outer,
  });
  const value = runCreation(cs, () =>
    provider !== undefined ? provider.provide() : invokeDefaultFactory(key, resolveDependencies(key)),
  );
  outer.selfCache.set(key, value);
  return { resolved: true, value, node: outer.base, autoHoisted: false, deps: undefined, created: true, pinned: true };
}

// ---------------------------------------------------------------------------
// Provider placement rules (§8.2, §4.11)
// ---------------------------------------------------------------------------

/**
 * PlacementError iff the key is decided at `C` (not at construction), or a scoped provider sits below its scope's
 * owner. Under a pending value node the owner walk stops at that node; the scope rule is checked again when the
 * node is placed (D-108).
 */
export function assertProviderPlacement(C: NodeImpl, p: Provider<unknown>, atConstruction: boolean): void {
  if (!atConstruction && C.decided.has(p.key))
    throw new PlacementError(
      `Cannot provide '${keyName(p.key)}' at ${describeNode(C)}: the key has already been decided here. ` +
        'Providers must be registered before any resolution of the key through this context.',
    );
  const scope = providerScope(p);
  if (scope !== undefined) {
    const T = C.findScopedContext(scope);
    if (T !== undefined && T !== C) throw scopedPlacementError(C, p, T);
  }
}

/** The scope §4.11's rule applies to: the provider's or the key's, SelfScope excluded. */
function providerScope(p: Provider<unknown>): Scope | undefined {
  const scope = p.scope ?? getKeyScope(p.key);
  return scope === SelfScope ? undefined : scope;
}

function scopedPlacementError(C: NodeImpl, p: Provider<unknown>, T: NodeImpl): PlacementError {
  return new PlacementError(
    `Cannot provide scoped key '${keyName(p.key)}' at ${describeNode(C)}: it resolves to ${describeNode(T)} above this context`,
  );
}

/** The nearest owner of `scope` from `c` upward, continuing at `S` from the pending node `n`, which has no parent yet. */
function scopeOwnerVia(c: NodeImpl, scope: Scope, n: NodeImpl, S: NodeImpl): NodeImpl | undefined {
  for (let x: NodeImpl | undefined = c; x !== undefined; x = x === n ? S : x.parent) if (x.scopeSet?.has(scope)) return x;
  return undefined;
}

export interface MisplacedProvider {
  readonly node: NodeImpl;
  readonly provider: Provider<unknown>;
  /** The scope owner above `node` once the pending node is placed. */
  readonly owner: NodeImpl;
}

/**
 * D-108: the providers on `n` and every node on its stacks, recursively, that §4.11's scope rule refuses once
 * the pending value node `n` is placed at `S`. A node built under a pending node (`child({ providers })`,
 * `child().addProvider(…)`, `fork(task(…, { providers }))`, a pool) passed the rule at construction only
 * because its owner walk stopped at `n`.
 */
export function misplacedScopedProviders(n: NodeImpl, S: NodeImpl): MisplacedProvider[] {
  const out: MisplacedProvider[] = [];
  const todo: NodeImpl[] = [n];
  for (let c = todo.pop(); c !== undefined; c = todo.pop()) {
    if (c.providers !== undefined)
      for (const p of c.providers.values()) {
        const scope = providerScope(p);
        const T: NodeImpl | undefined = scope === undefined ? undefined : scopeOwnerVia(c, scope, n, S);
        if (T !== undefined && T !== c) out.push({ node: c, provider: p, owner: T });
      }
    for (const e of c.explicit) if (e.node !== undefined) todo.push(e.node);
    for (const e of c.provided) if (e.node !== undefined) todo.push(e.node);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The NodeTopic receiver (§4.14, D-32)
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
