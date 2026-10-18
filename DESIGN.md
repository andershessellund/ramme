# ramme — Design

**Hierarchical contexts for JavaScript.** Dependency injection, structured
concurrency, and resource lifecycle in one tree, so that a context is
simultaneously a *resolution scope* (what `lookup`/`inject` see), an
*execution scope* (what ambient code runs inside), and a *lifetime* (what
drains, flushes and disposes together).

This document describes the library as it is: the model, the invariants,
and how each mechanism works. It says *what*; the *why* and the rejected
alternatives are in [DECISIONS.md](DECISIONS.md), cited as `D<n>`. User
documentation is the README.

---

## 1. What ramme is

Reduced to one sentence:

> **ramme is one tree whose nodes answer three questions at once — "who
> provides X here?", "where am I running?", and "when does this die?" —
> because keeping those answers on one node is what makes each of them
> composable.**

```ts
const app = createRootContext({
  providers: [valueProvider(Config, config), classProvider(Db, Postgres)],
});

const fiber = Fiber.spawn(async () => {
  const db = lookup(Db);              // resolution: walks the tree
  await withAbortSignal((signal) =>   // lifetime: abort rides the tree
    fetch(url, { signal }));
}, { context: app });                 // execution: the fiber IS a child context

await app.dispose();                  // drain → flush → dispose, fibers included
```

The unification is the point (D1): a fiber is a child context registered as
a resource on its parent, so parent disposal waits for it; a value created
by DI can register resources that die with the context that caches it;
`lookup` works inside a fiber because the fiber is an execution scope.
Splitting these into separate packages would turn every one of those
sentences into an integration.

### 1.1 Position in the stack

ramme depends on [lookup-api](../lookup-api) (the neutral ambient-contract
seam it serves, §8) and nothing else. Sibling libraries — kilde (signals,
streams, channels), valsem (value semantics) — do not depend on ramme;
kilde reaches it only through lookup-api contracts. What ramme is *not* is
in §9.

### 1.2 Entry points

| Subpath | Contents |
| --- | --- |
| `ramme` | contexts, DI, fibers, topics, the lookup-api bridge |
| `ramme/node` | side-effect import: `AsyncLocalStorage` context storage |
| `ramme/async-context` | side-effect import: TC39 AsyncContext storage |

---

## 2. The context tree

A `Context` is a node with a parent (roots have none), scopes, providers, a
resolution cache, and a resource list. `createRootContext()` makes a root
(always carrying `RootScope`); `createContext()` a child of an explicit or
ambient parent. A child registers *itself* as a resource on its parent —
the tree and the lifetime graph are one structure.

### 2.1 Lifecycle

Status runs `active → draining → drained → flushing → flushed → disposing →
disposed`. `dispose()` is the three-phase shutdown over the node's
resources:

1. **Drain** — in parallel: stop intake, wait for in-flight work (fibers
   settle here).
2. **Flush** — reverse registration order: finish delayed work (buffers,
   batches).
3. **Dispose** — reverse registration order: release handles.

`abort()` is a separate, synchronous signal propagated down the tree first,
then graceful disposal is initiated. Abort never *is* disposal; the parent
orchestrates (inherited design, brought over intact).

### 2.2 The resource protocol

```ts
interface ManagedResource {
  [Drain]?(): Promise<void> | void;
  [Flush]?(): Promise<void> | void;
  [Dispose]?(): Promise<void> | void;
  [Abort]?(): void;
}
```

The four method keys are `Symbol.for('ramme.<phase>.v1')` (D3): any object
can implement the protocol without importing ramme, duplicate installs
agree on the keys, and a `.v2` can coexist with a `.v1` if the protocol
ever changes incompatibly. All methods optional.

---

## 3. Dependency injection

### 3.1 Keys, providers, scopes

An `InjectionKey<T>` is a token created by `createInjectionKey(name)`,
optionally carrying a default factory, declared dependencies, and a scope.
Providers (`valueProvider`, `factoryProvider`, `classProvider`,
`aliasProvider`, `resourceProvider`) bind keys on a context. A `Scope` is a
name attached to contexts; a scoped key (or provider) stores its value on
the nearest context carrying that scope, wherever resolution started.
`SelfScope` means "cache per consuming creation, store nowhere";
`RootScope` is automatic on roots; `RequestScope` is the conventional
per-request scope, attached explicitly.

### 3.2 The two verbs

- **`inject(key)`** — creation-time only: declares a dependency of the
  value under construction, participates in placement (§3.3), wires
  lifecycle, and **throws** outside a creation context.
- **`lookup(key)`** — legal anywhere a context is ambient: reads the
  current value, tracks nothing.

The distinction is assertion, not just timing (D4): `inject` asserts "I am
being created and this is a dependency"; `lookup` asserts nothing. Inside a
creation context, `lookup` is for reads that are *creation-relative* or
*placement-invariant*; anything whose answer could differ between the
places the product might be shared belongs to `inject` — the planned
direction is to erase even that residue by tracking every creation-time
read (D4).

### 3.3 Creation contexts and auto-hoisting

Resolving an unprovided key with a default factory runs the factory inside
a **creation context** that records every `inject` into a `DepTracker`.
The value is then stored on the deepest context that served a tracked
dependency (clamped by the nearest `captureAutoScoped` boundary) — so a
value can never be cached above a context whose values it consumed, and
sharing is as wide as the dependencies allow. Explicitly scoped and
provider-targeted values skip tracking; their placement is declared.

During creation two special keys are served by the creation context itself:

- `inject(RegisterResource)` — registers a `ManagedResource` into the
  creation's resource bag; after placement, the bag lands on the storage
  context, so resources follow the value wherever it is cached.
- `inject(ContextRefKey)` — a deferred reference to the storage context,
  resolving after placement (`whenResolved` for auto-scoped values).

Circular `inject` chains throw with the chain named. `context.create(key)`
makes an unstored instance whose disposal cascades from the handle;
`createRefCountedKey`/`refCountedProvider` add reference-counted sharing
with a grace period.

### 3.4 Ambient execution

`ctx.run(fn)` / `enterSync()`+`leaveSync()` push the context onto the
pluggable storage (§6); `runSync(fn, opts)` runs `fn` in a temporary child.
`lookup`/`create`/`addProvider` read the ambient context.

---

## 4. Fibers

A fiber is structured async execution *as a context* (D8):

- **`Fiber.call(fn, opts?)`** — scoped sequential async: child context,
  run, await, dispose. Must be awaited immediately; an unawaited call is
  detected by stack-top enforcement and throws.
- **`Fiber.spawn(fn, opts?)`** — concurrent; returns `Fiber<T>`. The fiber
  is a `ManagedResource` on the parent: parent drain waits for it, parent
  abort reaches it, `fiber.abort()` aborts its context.
- **`Fiber.fork(fn, opts?)`** — spawn on the ambient context, for
  fork/join.
- **`Fiber.join` / `Fiber.result` / `Fiber.all`** — observable awaiting
  (join events on the topic), throwing and non-throwing.

`withAbortSignal(fn)` bridges context abort → `AbortSignal`;
`linkAbortSignal(signal, fiber)` bridges the other way (platform signal →
fiber abort). `createFiberSet` manages a bounded set of homogeneous fibers.

---

## 5. Observability

`createTopic` makes an injection-key-based event topic; providing a
receiver (usually at the root) turns emission on, its absence costs nearly
nothing. `ContextTopic` carries context/resource lifecycle events;
`FiberTopic` carries fiber start/settle, call enter/leave, join
enter/leave, and — when a receiver is present — each drain/flush/dispose
phase call wrapped as a lifecycle fiber. There is no stream topic: stream
instrumentation belongs to kilde (D6).

---

## 6. Context storage

Ambient context propagation is pluggable (`registerContextStorage`). The
built-in storage is a synchronous stack — context is deliberately lost
after the first `await` unless a real storage is registered:

- `import 'ramme/node'` — `AsyncLocalStorage`-backed (Node, workers).
- `import 'ramme/async-context'` — TC39 AsyncContext-backed (browsers,
  once the proposal or a polyfill provides it).

These are the two side-effect imports in the package; everything else is
side-effect-free.

---

## 7. Package layout

| Module | Responsibility |
| --- | --- |
| `resource.ts` | the `ManagedResource` protocol and the four symbols |
| `scope.ts` | `Scope`, `createScope`, the three built-ins |
| `context-key.ts` | `InjectionKey`, default factories, key scopes |
| `context.ts` | the public `Context` type and friends |
| `internal-context.ts`, `context-impl.ts` | the node: resolution cache, resource list, phases |
| `context-storage.ts` | pluggable ambient storage; sync default |
| `create-context.ts` | `createRootContext` / `createContext`; installs the bridge |
| `inject.ts` | creation contexts, `inject`/`lookup`/`create`, placement |
| `provider-util.ts`, `ref-count.ts`, `run-sync.ts` | providers, ref-counting, scoped sync runs |
| `fiber.ts`, `fiber-exec.ts`, `fiber-set.ts` | fibers |
| `topic.ts`, `lifecycle-events.ts` | topics; the two lifecycle topics |
| `contract-bridge.ts` | the lookup-api bridge (§8) |
| `node.ts`, `async-context.ts` | the storage entries |

Dependency direction: `resource`/`scope` are leaves; the context cluster
sits over them; `fiber*` sits over the context cluster (one soft back-edge:
`context-impl` uses `fiber-exec` to wrap lifecycle phases for
observability); `contract-bridge` is a leaf consumer of both worlds.

---

## 8. The lookup-api bridge

Libraries written against lookup-api call `lookup(contract)` with no
knowledge of ramme; the bridge is what makes a ramme context answer:

- `contractKey(contract)` — the `InjectionKey` a contract resolves
  through, memoized per contract object.
- `contractProvider(contract, value)` — provide a contract on a context
  like any value.
- `installContractResolver()` — installs one conditional resolver at
  lookup-api's durable root: it answers only when a ramme creation or
  execution context is ambient *and* the contract's key resolves there,
  and delegates everything else to the previously installed root.
  Idempotent; `createRootContext()` calls it, so applications get the
  bridge without import-order ceremony (D5).

Resolution during creation goes through the creation context (untracked
today; D4 records the planned tracking convergence), so a contract
provided on the context a factory runs under is visible to the libraries
that factory calls.

---

## 9. What is not here

- **Streams, signals, channels** live in [kilde](../kilde), which is
  dependency-free and reaches resource management through its `Owner`
  seam and lookup-api.
- **The async-DI glue** — `Requirement`, `Boundary`, `resolveAsync`, the
  DI-flavored reactive derivations — is not ported yet. It depends on both
  kilde and ramme and lands as a kilde-integration entry point
  (`ramme/kilde`) once kilde's extraction settles (D6).
- **Serving kilde's `Owner` contract** (creation bag during creation,
  ambient context at runtime) belongs to that same integration step.

---

## 10. Design laws

1. **One node, three answers.** Resolution scope, execution scope and
   lifetime stay on the same tree node; a mechanism that would split them
   must justify itself (D1).
2. **Placement follows dependencies.** A value is never cached above a
   context whose values it consumed.
3. **Resources follow their value.** Whatever context stores the value
   disposes its resources.
4. **Abort is a signal; disposal is an orchestration.** Abort propagates
   synchronously down; drain/flush/dispose are driven by the parent.
5. **Parents outlive children observably**: drain waits for fibers and
   child contexts; dispose runs in reverse registration order.
6. **Ambient propagation is pluggable and honest**: the default storage
   loses context at `await` rather than pretending otherwise.
7. **Observability is opt-in and priced at zero when off**: topics without
   receivers cost a lookup.
8. **The bridge attributes before it answers**: ramme resolves only
   ambient calls it can claim, and delegates the rest (lookup-api D4).
