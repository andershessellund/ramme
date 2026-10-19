# ramme — lifecycle and concurrency redesign

**Status:** proposal, pre-implementation, revision 6.2. Supersedes
DESIGN.md §2, §3.4, §4, §6, §8 and parts of §3; supersedes DECISIONS D1
(rationale), D3, D4, D6, D8, D9, retires D5, and amends D7. Section numbers
are the proposal's own; `→D<n>` marks where a DECISIONS entry will be
written.

Revision 6.2: implementer-level fixes from the readiness review. The
freeze decision is made for the awaiting body's node, never for the node a
method was called on (§4.3); `lookup` is banned during creation (§8.1);
one ambient mechanism (§8.4); placement into a releasing storage context
(§6.2); tracking decides placement only for auto-hoisted values (§8.1);
`AllResult` (§7.2); and R-b is replaced by *permanent decisions and
placement by view* (§8.2), which keeps the tombstone's correct half and
drops the half that caused P7.

Revision 6.1: lookup-api is retired. ramme is zero-dependency; the bridge,
`contractKey`, `contractProvider` and `installContractResolver` are
removed; the convention that library-defined keys carry default factories
replaces the contract-with-fallback idea (§8.5).

Revision 6: the ambient idiom is restored and the platform requirement it
implies is stated as law (async context propagation is required); `task()`
separates a definition from its runs; free functions over the ambient node
(`fork`, `call`, `own`, `lookup`, `join`, …) with `Context` methods kept for
attaching on behalf of another node; kilde becomes a ramme library (D6
inverts).

Revision 5: no ambient reads at runtime; `(ctx, ...args)` convention;
lending. Revision 4: one contract; two stacks per node; every release is a
fiber; fibers are inherent. Revision 3: `release`; resource as an entry;
producers take an `Owner`; contracts as keys. Revision 2: explicit
attachment; `inject`/`lookup` by lifetime; the creation bag as a pending
node.

---

## 0. Summary

A ramme program is one tree of **nodes**. A node has a resolution parent,
a signal, optionally a body, an **explicit stack** of things code attached
to it, and a **provided stack** of DI values the DI system placed on it.
Contexts, fibers, pools and the nodes of DI values are all nodes; they
differ in three independent bits (§3.2). Ancestors outlive descendants. A
node's position answers both what it may depend on and when it dies;
`inject` chooses that position during creation, `lookup` reads from it at
runtime (§3.0). The tree holds services and work, not every object: most
objects are values, and a resource is an *entry* a value has placed on a
node (§1, §6.6).

Six laws:

1. **Acquisition is ownership.** Whatever a body acquires is attached to a
   node before the acquisition returns; that node releases it, whether the
   body returned, threw or was interrupted. A body may release what it
   acquired early, whenever that is useful (`release(x)`,
   `handle.release()`); what it never does is write cleanup as control
   flow, because `finally` does not run on a frozen body. (§6, §6.8)
2. **The ambient node is the default; name a node only to mean another.**
   `fork`, `call`, `own`, `lookup`, `join` and the rest are free functions
   over the *current node*: a body's own fiber, the pending node during
   creation, the release fiber during a release. The same operations exist
   as methods on `Context` for the one case that needs a name: attaching
   or resolving on behalf of a node that is not the current one. (§7.10)
3. **Async context propagation is required.** The ambient node reaches
   across `await` only through the platform (`AsyncLocalStorage`, TC39
   AsyncContext). ramme therefore targets runtimes that have it, which is
   every server runtime today and browsers when AsyncContext ships or via a
   generator transform. This is a platform fact, not a choice: nothing in
   userland can resume an `async` function with context attached. (§12 A1)
4. **Interruption stops work; it never requires cleanup.** An interrupted
   body's next managed await never settles; the body is abandoned and its
   node's stacks are released by the runtime. Interruption is a signal
   delivered to the whole subscribed subtree at once; completion propagates
   up. (§4, §5)
5. **What code attached is released before what DI provided.** A node
   releases its explicit stack, then its provided stack, each in reverse
   order. Anything read from a node's provided values stays alive for the
   whole life of whatever read it; among explicit entries, and among
   provided values, reverse order is dependency order when dependencies
   were acquired first. Nothing is promised to references that escaped
   their scope except that use fails loudly. (§5.3)
6. **No bare callbacks, no bare promises for work.** Every asynchronous
   hook the framework offers is a fiber. Anything that should be a node is
   a **task**: a definition that can only be `fork`ed or `call`ed, never
   invoked as a plain async function. `Symbol.asyncDispose` is kept as the
   interop contract, and the core runs it as a fiber. (§5.2, §7.0, §7.10)

Application code sits inside these laws and reads like ordinary
JavaScript: a request handler is `task(async (req, res) => { … })` whose
body calls `lookup(Db)`, `own(await pool.acquire())`, `fork(...)`, with no
context threading. Resource authors use a second tier (§7.9). kilde is the
reactive library for ramme applications and is written in the same idiom
(§6.6, §16).

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **node** | The unit of the tree: resolution parent, signal, optional body, explicit stack, provided stack, state, outcome. Every node is a `Context`. |
| **current node** | The node the running code belongs to, propagated across `await` by the platform's async context. Read with `current()`. |
| **body** | An async function `(...args) => Promise<T> \| T`. Run in the current node by calling it, or in a new node through a task. |
| **task** | A body plus options, returned by `task(body, opts)`. Not callable. Each `task.fork(...)` or `task.call(...)` runs the body in a new fiber. |
| **fiber** | One run of a task: a node with a body, yielding an outcome. |
| **call** | Running a body in a **new** child node and awaiting it. Lends the current node until it settles (§7.11). |
| **fork** | Running a body in a new child node concurrently; returns a `Fiber<T>`. |
| **resolution parent** | The node a node resolves through and appears under in the tree. |
| **subscriber** | A node that receives its parent's interrupt when the parent's body exits or the parent is aborted. Subscribers are *work*. |
| **explicit stack** | Entries attached by code: `own(...)`, `fork`, `call`, `child`, `pool`. Released first, LIFO. |
| **provided stack** | The nodes of DI values placed on this node by resolution. Released after the explicit stack, LIFO. |
| **entry** | An `AsyncDisposable` (or `Disposable`, wrapped) on a stack. A node is an entry on its resolution parent's stack; a passive resource is an entry with no node of its own. |
| **resource** | An entry. A property of the relationship, not of the object. |
| **value** | Any object that is not currently an entry. |
| **handle** | What an acquisition returns. Its `release()` goes through the owner. |
| **owner** | The node whose stack an entry is on. |
| **dependency** | What `inject(K)` returns during creation: must live at least as long as the value under construction; met by placing the value no higher than the dependency. |
| **borrow** | What `lookup(K)` returns: must live at least as long as the current node; met by resolving only from its ancestors. Must not be stored on anything longer-lived than the current node. |
| **lent** | A node whose body is inside a `call`. Body-shaped operations on it throw until the call settles. |
| **delivered / applied / forwarded** | The node's `signal` fired / it is in `freeze` mode and delivered, so managed awaits never settle / it delivers to its subscribers. |
| **managed await** | An await on a promise ramme produced (§4.3). Only these can freeze. |
| **bare await** | Any other await. Completes normally regardless of interruption. |
| **frozen** | The body requested a managed await on an applied node. It never resumes. |
| **release** | Calling an entry's `[Symbol.asyncDispose]()` inside a release fiber. |
| **release fiber** | The fiber a release runs in: resolution parent = owner, fresh deadline signal, `observe` mode, on no stack. It is the current node while the release runs. |
| **complete** | Body settled or frozen, explicit stack released, provided stack released. |
| **outcome** | `success` / `failure` / `aborted` (§9.1). |
| **creation** | Running a factory, constructor or contract fallback. The only place `inject` is legal. The current node there is the value's **pending node**. |
| **placement** | Choosing the storage context of a DI value. |

---

## 2. What changes at a glance

| Today | Proposed |
|---|---|
| `ManagedResource` with `Drain`/`Flush`/`Dispose`/`Abort` symbols | one contract: `[Symbol.asyncDispose]` (`Symbol.dispose` accepted and wrapped) |
| Three tree-wide phases | per node: signal → explicit stack LIFO → provided stack LIFO |
| `Fiber.call(fn)`, `Fiber.spawn(fn)`, `Fiber.fork(fn)`; bodies are `() => Promise<T>` | `task(body)` with `.fork(...args)` / `.call(...args)`; inline `fork(body, ...args)` / `call(body, ...args)` |
| Async functions used as fibers can also be called bare | a `Task` is not callable; bare invocation is a `TypeError` |
| `import 'ramme/node'` optional; context "honestly ends at the first await" | required; the ambient node is the idiom and the platform carries it |
| Unawaited `Fiber.call` detected by stack-top enforcement | `call` lends the current node; body-shaped use before it settles throws |
| `inject(RegisterResource)`, `resourceProvider`, `context.create()`, `Created` | `own(...)`; `release(x)` |
| `inject(ContextRefKey)` with `whenResolved` | `inject(ContextKey)` / `current()` in creation: the pending node |
| `lookup` in creation untracked (D4 hazard) | `lookup` in creation throws; `inject` is the only creation-time read and is tracked |
| Probabilistic resolution memo; negative memo at the auto-scope root (P7) | deterministic decided markers; placement by view (§8.2) |
| Lifecycle phases wrapped in "lifecycle fibers" when observed | every release is a fiber, always |
| Cooperative cancellation: body unwinds, throws `AbortError` | freeze: the body's next managed await never settles |
| Parent waits for children to finish naturally | parent interrupts subscribers at body exit; `childrenOnExit: 'await'` opts out |
| Hard dependency on lookup-api; `contractKey`, `contractProvider`, `installContractResolver`; `createRootContext` installs a process-global resolver | zero dependencies; no bridge; `createRootContext` has no global side effect; library keys carry default factories (§8.5) |
| `createRefCountedKey` / `refCountedProvider`; `createFiberSet` | pool of size one (out of core); `pool(...)` |
| kilde reaches ramme through an `Owner` seam and lookup-api (D6) | kilde depends on ramme and is written in its idiom (D6′) |
| Disposed contexts accept `get`/`spawn`/`registerResource` | every operation on a complete node throws |

---

## 3. The node

### 3.0 Why one tree, and why fibers are in it →D1′

Auto-hoisting answers "where may this value be cached?" with "at the
deepest context whose values it consumed". That is already a lifetime
answer: a value may live exactly as long as its dependencies. Placement *is*
lifetime assignment; resolution scope and lifetime are one question.

The corollary makes untyped ambient DI safe: **everything you can resolve
outlives you.** Ancestors complete after descendants and you resolve only
from ancestors, so no node can hold a dependency that dies first. Effect
obtains the same guarantee from its type system (a resource's `Scope`
requirement lives in the `R` channel), which is what lets it keep the fiber
tree and the scope tree separate. ramme has no `R` channel; structure must
do the tracking, and one tree with ancestors-outlive-descendants is the
smallest structure that does. The resolution parent must therefore be an
ancestor-or-self of the lifetime owner; by default they are the same node.

The **current node** is a pointer into that tree, carried by the platform's
async context. It is what makes the idiom ambient: `lookup(Db)` inside a
handler body resolves from the handler's fiber, and `own(x)` attaches
there, without either being passed around. What ramme does **not** conflate
is execution *history* with lifetime: the fiber that happens to run a
factory does not own what the factory builds; placement does (§6.2, §7.3).

The tree is not a registry of objects. It holds services (DI values with a
node) and work (fibers). The many small objects a service mints are values;
they cost nothing until they place an entry on the service's node (§6.6).

**Fibers are inherent.** The core's one asynchronous act is release, and a
release needs a node to run in: a deadline signal to read, a place to
acquire, a place in the tree to be seen. A node running a body is a fiber.
The primitive is core; `fiber.ts` adds the ergonomic surface (§7.0).

The cost: cross-lifetime communication is explicit data. A long-lived actor
cannot `lookup` request-scoped values; it receives a payload. Propagated,
non-owning dynamic variables (Effect's `FiberRef`) can be added later
without touching the tree; they are not in this proposal.

### 3.1 Anatomy

```ts
export type NodeState = 'pending' | 'running' | 'settling' | 'releasing' | 'complete';
export type InterruptMode = 'freeze' | 'observe' | 'restore';

export interface NodeOptions {
  name?: string;
  providers?: Provider<unknown>[];
  scopes?: Scope[];
  interrupt?: InterruptMode;                       // default 'freeze'
  childrenOnExit?: 'interrupt' | 'await';          // default 'interrupt'
  timeoutMs?: number;                              // deliver to this node's own signal after
  signal?: AbortSignal;                            // deliver to this node when it fires
  releaseTimeoutMs?: number;                       // deadline for this node's release fibers; inherited
  stallWarningMs?: number;                         // default 5000; inherited
}

export type Body<T, A extends unknown[] = []> = (...args: A) => Promise<T> | T;
export type Release<T> = (value: T) => void | Promise<void>;   // runs with the release fiber current

export interface Context {
  // --- identity & state ---
  readonly id: number;
  readonly name: string | undefined;
  readonly state: NodeState;
  readonly scopes: ReadonlySet<Scope>;
  readonly signal: AbortSignal;
  readonly outcome: Outcome<unknown> | undefined;  // undefined while running

  // --- resolution ---
  get<T>(key: InjectionKey<T>): T;
  get<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;
  addProvider<T>(provider: Provider<T>): void;

  // --- attachment: the explicit stack (§6) ---
  own<T extends Disposable | AsyncDisposable>(resource: T): T;         // the contract
  own<T extends object>(value: T, release: Release<T>): T;             // sugar: wraps
  own<T extends object>(defer: T & (() => void | Promise<void>)): T;   // sugar: wraps
  release(value: object): Promise<void>;
  releaseAll(): Promise<void>;

  // --- running bodies in a child of THIS node (§7) ---
  fork<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Fiber<T>;
  call<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Promise<T>;
  all<T extends readonly Task<[], unknown>[]>(tasks: T, opts?: NodeOptions): Promise<AllResult<T>>;
  race<T>(tasks: readonly Task<[], T>[], opts?: NodeOptions): Promise<T>;
  pool(opts: PoolOptions): Pool;
  child(opts?: NodeOptions): Context;

  // --- awaiting; the freeze decision is made for the awaiting body's node, current(), if any (§4.3) ---
  join<T>(fiber: Fiber<T>): Promise<T>;
  result<T>(fiber: Fiber<T>): Promise<Outcome<T>>;
  interrupted(): Promise<unknown>;
  never(): Promise<never>;
  managed<T>(promise: Promise<T>): Promise<T>;

  // --- synchronous frames ---
  run<R>(fn: () => R): R;                          // make this node current for synchronous fn
  runSync<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R;   // child + run + abort on exit

  // --- lifecycle (§5.5) ---
  abort(reason?: unknown): void;
  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/** The ambient surface: each is `current().<method>(...)`. */
export function current(): Context;                // throws NoCurrentNodeError outside any node
export function signal(): AbortSignal;             // current().signal
export function lookup<T>(key: InjectionKey<T>, options?: LookupOptions): T | undefined;
export function own<T>(...): T;                    // all overloads
export function release(value: object): Promise<void>;
export function fork<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Fiber<T>;
export function call<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Promise<T>;
export function all(...), race(...), pool(...), child(...);
export function join<T>(fiber: Fiber<T>): Promise<T>;
export function result<T>(fiber: Fiber<T>): Promise<Outcome<T>>;
export function interrupted(): Promise<unknown>;
export function never(): Promise<never>;
export function managed<T>(promise: Promise<T>): Promise<T>;
```

Internal: `parent`, `subscribers: Set<Context>`, `explicit: List<Entry>`,
`provided: List<Entry>`, `interrupt` (fires on abort or body exit),
`lentTo` (§7.11), `bodyOutcome`, `releaseErrors`, `unconsumedFailures`,
the resolution cache, providers.

`own(node)` is the first overload: a brand check moves the node from
subscriber to non-subscriber; its stack entry stays where it is. Code
cannot attach to the provided stack; only resolution does.

### 3.2 The three bits

| Bit | Values | Decided by |
|---|---|---|
| **Yields a value** | fiber (`Fiber<T>`) / not | `fork`/`call` vs everything else |
| **Subscribed** | hears the parent's interrupt at body exit (work) / at its turn in the stack (infrastructure) | `fork`/`call`/`child` vs `own(node)`/`pool`; a DI value's node is never subscribed |
| **Interruption** | `freeze` (applied, forwarded) / `observe` (delivered only) | `interrupt` option |

| | has a body | no body |
|---|---|---|
| **subscribed** | `fork`, `call`: handlers, workers, sessions | `child()`: a request scope |
| **unsubscribed** | `own(fork(…))`: a reaper | `pool(...)`; a DI value's node; a passive entry |

### 3.3 Node kinds by construction

| Constructor | Value | Stack / subscribed | Body | Notes |
|---|---|---|---|---|
| `createRootContext(opts)` | no | root | no | the only free constructor; `Symbol.dispose` throws |
| `child(opts)` | no | explicit / yes | no | |
| `call(t, …)` / `t.call(…)` | yes, joined | explicit / yes | yes | starts synchronously; lends the current node |
| `fork(t, …)` / `t.fork(…)` | yes | explicit / yes | yes | starts in a microtask, or after placement in creation |
| `own(fork(t, …))` | yes | explicit / **no** | yes | |
| `pool(opts)` | no | explicit / no | no | its `fork`s are its subscribers |
| the pending node (creation) | no | **provided** / no | no | the value's own node, §6.2 |
| release fiber | no | none (transient) | yes | §5.2 |

---

## 4. Interruption

### 4.1 The signal

`node.abort(reason)` delivers to `node`, synchronously, top-down along
subscription edges: mark the node delivered; if its mode is `freeze`,
deliver to each subscriber (an `observe` node delivers only to `restore`
subscribers); unsubscribed entries hear their signal at their turn in the
release loop. **The whole subscribed subtree is marked in the same tick,
before any listener runs.** Delivery releases nothing.

**Sibling rule.** Subscribers are interrupted together and complete in any
order, so a subscriber must not depend on a sibling subscriber's liveness
during its cleanup. Anything a fiber needs while cleaning up must be
unsubscribed and attached earlier, or a provided value.

### 4.2 Freeze semantics

On a node in `freeze` mode that has been delivered, every managed await
returns a promise that never settles. The body is *frozen*: it never
resumes, never runs `finally`, never throws. ramme retains no resolver, so
the suspended function is garbage-collectable (A2). A frozen body counts as
settled for completion. Between delivery and the next managed await the
body is still running plain code, and everything it does is legitimate.

### 4.3 Managed awaits

A managed await is an await on a promise returned by `call`, `all`,
`race`, `release`, `releaseAll`, `join`, `result`, `interrupted`, `never`,
`managed(p)`, or by `close()`/`asyncDispose()`. The freeze decision is made
for **the awaiting body's node**: `current()` at the time of the call,
whether the free function or the method form was used. With no current
node, at top level (`await app.call(main)`) or in a platform callback,
nothing can freeze and the promise settles normally, rejecting with
`FiberAbortedError` if the awaited node was aborted. Were the decision made
for the node a method was called on, `app.abort()` from a signal handler
would freeze the top-level `await app.call(main)` forever and the
process's `await using` cleanup would never run. Everything else is bare:
`fetch`, timers, driver promises, and all code that does not use ramme.
`managed(p)` wraps a bare promise so that it freezes.

### 4.4 Interruption modes

| | `freeze` (default) | `observe` | `restore` |
|---|---|---|---|
| Delivered | when parent forwards, or aborted directly | when parent forwards, or aborted directly | whenever **any** ancestor is delivered |
| Applied (managed awaits freeze) | yes | **no** | yes |
| Forwards to subscribers | yes | **no**, except `restore` ones | yes |
| Outcome after delivery | `aborted`, whatever the body does | the body's own result | `aborted` |
| Born under an already-delivered parent | delivered at birth | **not** delivered at birth | delivered at birth |

`observe` is the resource author's mode: the body sees the interrupt
(`signal()`, `await interrupted()`) and runs a controlled shutdown, then
settles on its own. It never freezes. `restore` re-opens a cancellable
window inside an `observe` region. A node's own `abort()`, `timeoutMs` or
linked `signal` always delivers to it. `task(fn, { interrupt: 'observe',
timeoutMs: 5000 }).call()` is a bounded critical section.

### 4.5 What application code sees

Nothing beyond `signal()` to pass on. Handlers, sessions and jobs `lookup`,
`own`, and run. Interrupted, they stop at their next managed await and
their attachments are released for them. Graceful behaviour is composed
above them: a server is a subscribed `observe` task that stops accepting,
drains its pool, and settles.

### 4.6 Hazards and diagnostics

A `freeze` body that never reaches a managed await after delivery never
freezes; its owner waits. Foreign library code is bare throughout. The
mitigation is diagnostic: `node:stalled` when a delivered node has not
settled or frozen within `stallWarningMs`. Release fibers are nodes, so a
stuck release shows up the same way.

---

## 5. Completion and release

### 5.1 Body exit

When a node's body settles or freezes (bodiless: on `abort()`, or on
`close()`):

1. **Signal.** Under `childrenOnExit: 'interrupt'` (default), and always on
   `abort()`, fire the interrupt: every subscriber in the subtree is
   delivered in this tick. Under `'await'`, or on `close()`, nothing is
   fired.
2. **Release the explicit stack, LIFO.** Subscribed entries: mostly a wait
   (`close()` on them under `'await'`/`close()`). Unsubscribed entries:
   `asyncDispose` is the first thing they hear.
3. **Release the provided stack, LIFO.**
4. **Complete.** Removed from the owner's stack; cache and providers
   dropped.

### 5.2 One release

Each entry is released by calling its `[Symbol.asyncDispose]()` inside a
**release fiber**: resolution parent = owner, `signal` = a fresh
`AbortSignal.timeout(releaseTimeoutMs)` (or never-firing), mode `observe`,
on no stack; the release loop holds it and awaits its completion. The
release fiber is the **current node** while the release runs, so inside
any release, ramme-native or foreign, `signal()` is the deadline, `own(...)`
attaches things that live exactly as long as the release, and the owner
captured at acquisition gives `owner.outcome`. A node entry's
`asyncDispose` is `abort(); await completion`; a passive entry borrows the
release fiber as its node.

A release runs exactly once per entry, even under a concurrent early
`release(x)`; continues to the next entry if it throws, errors collected
(§9.2). Entries never move (I5).

### 5.3 What the order guarantees →D16

- **G1** Anything code or its descendants read from a node's provided
  values stays alive until every explicit entry on that node has
  completed. Unconditional: provided values are registered lazily, at a
  time the body author does not control.
- **G2** Explicit entries release in reverse attachment order: dependency
  order iff a fiber uses only what was attached before it was forked.
  *Discipline:* acquire before you fork what uses it.
- **G3** Provided values release in reverse creation order, which is
  dependency order because `inject` runs during creation. *Discipline:* a
  value's release, and a value's owned fibers, use only what the value
  injected or reads through its own node.
- **G4** Interruption reaches the whole subscribed subtree at once; nothing
  waits for a sibling.

**Not guaranteed:** order among subscribers during step 1; anything about
a reference that escaped to a longer-lived scope. It fails on use (§5.4).

One wiring error to detect: providing a body-owned resource on the *same*
node points a dependency from the provided stack into the explicit stack;
a dev check flags it.

### 5.4 Use after release

| Operation | Before delivery | Delivered, not complete | Complete |
|---|---|---|---|
| `lookup` / `get` | works | works | throws `NodeCompletedError` |
| `own`, `release` | works | works; released at completion | throws |
| `fork` / `call` / `child` / `pool` | works | works; a `freeze` child is delivered at birth, an `observe` one is not | throws |
| managed await | settles | never settles (`freeze`) / settles (`observe`) | n/a |
| a released resource's handle | — | — | resource-defined; should throw |

### 5.5 `close`, `abort`, `dispose`, `asyncDispose`

| | Signal | Waits | Rejects with |
|---|---|---|---|
| `abort(reason)` | yes | no | — |
| `close()` | no | subscribers naturally, then both stacks | unconsumed failures |
| `[Symbol.dispose]()` | yes | no; the owner's completion waits | — (throws on a root) |
| `[Symbol.asyncDispose]()` | yes | completion | unconsumed failures; for a fiber also its own failure (acts as `join`) |

### 5.6 The parent/child contract

What a parent provides to anything on its stacks: resolution (everything
the parent resolves; ancestors outlive you); a signal (subscribed: at the
parent's body exit or abort; unsubscribed: at your turn; provided values:
after every explicit entry has completed); waiting (the parent does not
complete until you do, **whatever it costs**; a deadline is a signal to
you, never permission to abandon you); order (reverse attachment within
your stack; explicit before provided); `asyncDispose` at most once;
`parent.outcome` readable during your release (`undefined` means early);
your failure routed or collected, never an unhandled rejection; a place to
run (your own node, or a release fiber, which is current while you
release).

What an entry provides to its parent: `[Symbol.asyncDispose]()` whose
synchronous prefix delivers your signal (nodes) and whose promise settles
when you are fully complete, rejecting with your unconsumed failure;
idempotence (built in for nodes, your responsibility for passive entries);
readable `state`/`outcome`/`signal.aborted` (nodes); every operation throws
after completion; single owner; and **finishing**: your `asyncDispose`
eventually settles because your body reaches a managed await or honours
the signal. **The parent promises to wait forever; the child promises to
finish.** What the parent does with a child that does not is tell the world
(`node:stalled`).

---

## 6. Ownership

### 6.1 `own` and `release`

`own(x)` attaches to the current node; `ctx.own(x)` to a named one. Every
overload returns what it attached; attached values must be objects so
`release` can find the entry by identity. There is no bare detach: an
entry nobody owns is a leak by construction.

The `(value, release)` and defer sugars run with the release fiber
current, so `signal()` inside them is the deadline. A transaction:

```ts
const owner = current();
const tx = own(await db.begin(), (tx) =>
  owner.outcome === undefined || owner.outcome.status === 'success' ? tx.commit() : tx.rollback());
```

Released early (`release(tx)`) or at a successful completion it commits;
under `aborted`/`failure` it rolls back. "Run this on interruption" is
`own(() => …)`; reacting earlier, while work is still unwinding, is a
subscribed `observe` task reading `signal()`.

### 6.2 Where an entry lands

- In a body: on the explicit stack of the current node, the body's fiber.
- In creation: on the explicit stack of the value's **pending node**, which
  is the current node during the factory. It is created on demand by the
  first `own`, `fork`, `pool`, `current()` or `inject(ContextKey)`; a value
  that attaches nothing never gets one. At placement the pending node's
  resolution parent is set to the storage context S and it is pushed on
  **S's provided stack**, unsubscribed; queued fibers start now. Before
  placement it accepts `own`, `release`, `fork`, `pool`; `get`, `call`,
  `run` throw `PendingNodeError`. If placement is explicit the node is
  live from the start. Placement into a storage context that is already
  releasing (a release fiber's `lookup` created the value) pushes the node
  onto that provided stack above the loop's cursor, so it is released next,
  before the values it depends on; placement into a complete storage
  context throws `NodeCompletedError` and the resolution fails on use.
- In a release: on the release fiber, released when the release finishes.
- On a node someone handed you (§6.4): on that node's explicit stack.

### 6.3 Contracts

- (C1) `own` is synchronous; the entry is registered before it returns.
- (C2) `own` on a delivered-but-incomplete node succeeds.
- (C3) `own` on a complete node throws `NodeCompletedError`.
- (C4) Release runs exactly once per entry, in a release fiber, after
  everything above it on its stack and (for provided entries) after the
  whole explicit stack.
- (C5) An owned **fiber** that settles with `failure` while its owner is
  open **aborts the owner**. One that settles with `success` is removed.
- (C6) A release that throws does not stop the remaining releases.
- (C7) `release(x)` runs `x`'s release now, exactly once; concurrent calls
  share one promise; `release` of something the node does not own throws
  `NotOwnedError`.
- (C8) Owning the same object twice on one node throws `AlreadyOwnedError`.

### 6.4 Producers attach before they return

A function that returns a newly acquired resource attaches it **before**
returning and returns a handle whose `release()` goes through the owner.
By law 2 the owner defaults to the current node; a producer that must
attach on behalf of a node that is not current (a grant arriving later,
inside some other fiber) holds the owner and uses the method form:

```ts
acquire(owner: Context = current()): Promise<Lease> {
  const waiter = this.#enqueue(owner);
  waiter.handle = owner.own(waiter);                          // a frozen waiter leaves the queue at its owner's release
  return waiter.granted;                                      // bare promise; no finally
}
#grant(waiter: Waiter, conn: Conn): void {
  waiter.handle?.release();                                   // the wait is over; drop its entry early
  const lease = new Lease(conn, (l) => this.#return(l.conn));
  try {
    lease.handle = waiter.owner.own(lease);                   // on behalf of the waiter, not of whoever runs #grant
    waiter.resolve(lease);
  } catch (e) {
    if (e instanceof NodeCompletedError) this.#free.push(conn);   // owner gone; keep it
    else throw e;
  }
}
```

There is no moment at which a resource exists without someone responsible
for it. `own` on behalf of a lent node is allowed (§7.11).

### 6.5 What `own` replaces

| Today | Proposed |
|---|---|
| `inject(RegisterResource)({ [Dispose]: … })` | `own({ [Symbol.asyncDispose]: … })` in the constructor |
| `ResourceHandle.unregister()` | `release(x)` / `handle.release()` |
| `inject(ContextRefKey)`, `.whenResolved` | `current()` / `inject(ContextKey)` in creation |
| `resourceProvider(k, v, r)` | `factoryProvider(k, () => own(v, release))` |
| `ctx.create(k)`, `Created<T>` | build the value where needed; `own` its entries |
| `withAbortSignal(fn)` / `linkAbortSignal(signal, fiber)` | `fn(signal())` / `task(fn, { signal }).fork()` |
| `createFiberSet(...)` | `pool(...)` |
| `signal.addEventListener('abort', cb)` | `own(cb)` (at release) or a subscribed `observe` task (early) |
| `try { … } finally { await cleanup }`, `await using` | `own(...)` before the work |

### 6.6 Services, values and lazy resources

**A pool.** A DI value owning its connections; borrowers own leases.

```ts
class Pool {
  #ctx = current();                                        // the pending node, placed with the value
  #closed = false;
  #conns = own(openConnections(n), async (conns) => {
    this.#closed = true;                                   // stop intake
    await this.#drained(signal());                         // the release fiber's deadline
    await conns.closeAll();
  });
  constructor() { own(fork(() => this.#reap())); }        // owned reaper, starts after placement
  acquire(owner: Context = current()): Promise<Lease> { if (this.#closed) throw new PoolClosedError(); … }
}
```

By G1, every lease-holder that read the pool has completed before the
pool's node is released.

**A lazy value.** Cold async states, subscriptions, queries: many, cheap,
garbage-collectable when cold. Not DI values, not nodes. The *factory* is
the DI value; a state manages entries on the factory's node on the
factory's behalf. This is kilde's async-state implementation under D6′ and
is specified there; the shape is:

```ts
class UserStates {                                  // the DI value; placed by its injects
  #ctx = current();
  #http = inject(Http);
  #ids = inject(UserIdStates);
  for(id: Signal<string>) { return new UserState(this.#ctx, this.#http, this.#ids, id); }
}
// UserState: on first subscriber, owner.own(upstream.subscribe(…)); on last, owner.release(sub) and abort the fetch;
// each load is owner.fork(task(() => …, { onFailure: (e) => set(errored(e)) })) — an aborted fetch fires nothing.
```

**A ref count.** A pool of size one with a delayed close. Out of the core.

### 6.7 Worked example: a request

```ts
const handle = task(async (req: Request, res: Response) => {
  const pool = lookup(Pool);                                          // 1
  const lease = own(await pool.acquire());                            // 2
  return call(task(() => work(req), { providers: [valueProvider(Conn, lease.conn)] }));   // 3
});

server.on('request', (req, res) =>
  app.fork(handle.with({ name: req.url, signal: req.signal, onFailure: (e) => respond500(res, e) }), req, res));   // 4
```

1. `Pool` misses and has a default factory: auto-hoisted; its node lands on
   the **provided** stack of the deepest dependency's context and its
   reaper starts there. By G1 the pool outlives the handler whether or not
   the handler was forked before the pool existed.
2. `acquire()` attached the lease to the current node, the handler's
   fiber, before its promise resolved; `own` here is a no-op by identity
   and is written for the reader.
3. A block-scoped child with its own providers; the handler's fiber is
   lent until it settles. `work` is a plain function running in the
   child.
4. The one place a node is named: `app.fork(...)` attaches the handler to
   the root on behalf of the server's event callback, which has no current
   node of its own.

### 6.8 Early release, `finally` and `catch`

A body owns nothing, but it may ask for anything it attached to be
released at any time: `release(x)`, `handle.release()`, or the resource's
own early-completion path. Releasing a connection when the query is done,
committing before returning, unsubscribing when the last message arrives
are ordinary straight-line statements. What the model removes is *cleanup
as control flow*:

- **`finally` is banned in async functions** (§13): a frozen body never
  resumes, so nothing in a `finally` runs on interruption. Invariants that
  must hold after the body ends belong to an entry (`own(() => …)`).
- **`using` / `await using` are banned in async functions**: `finally` in
  disguise.
- **`try/catch` is allowed and not linted.** A `catch` never sees an
  interruption, only real errors. Catching to translate and rethrow is
  fine; catching to recover is pointless on a delivered node, whose next
  managed await freezes, but harmless.

---

## 7. Fibers

### 7.0 What the fiber layer adds

The primitive is core (§3.0). `fiber.ts` adds tasks (§7.10), lending
(§7.11), start semantics (§7.3), failure destinations (§7.4),
`join`/`result`, `all`/`race`, pools.

### 7.1 Options

```ts
export type FailureDestination = 'join' | 'link' | ((error: unknown, fiber: Fiber<unknown>) => void);
export interface TaskOptions extends NodeOptions { onFailure?: FailureDestination; }   // default 'join'
```

### 7.2 Interfaces

```ts
export interface Fiber<T> extends Context {
  /** Not thenable. `then` exists at runtime only to throw FiberNotAwaitableError; use join / result. */
}

export interface Task<A extends unknown[], T> {
  readonly name: string;
  fork(...args: A): Fiber<T>;                      // in a child of the current node
  call(...args: A): Promise<T>;                    // in a child of the current node, joined; lends it
  with(opts: TaskOptions): Task<A, T>;             // per-use overrides
  bind(...args: A): Task<[], T>;                   // partial application; what all/race/pool take
}
export function task<A extends unknown[], T>(body: Body<T, A>, opts?: TaskOptions): Task<A, T>;

/** The tuple of the tasks' values, in order; `all([a.bind(1), b.bind('x')])` is `Promise<[A, B]>`. */
export type AllResult<T extends readonly Task<[], unknown>[]> =
  { -readonly [K in keyof T]: T[K] extends Task<[], infer U> ? Awaited<U> : never };

export type Outcome<T> =
  | { readonly status: 'success'; readonly value: T }
  | { readonly status: 'failure'; readonly error: unknown }
  | { readonly status: 'aborted'; readonly reason: unknown };

export const ContextKey: InjectionKey<Context>;     // inject only; same as current() in creation
```

A `Task` is an object, not a function: `handle(req)` is a `TypeError` at
compile time and at runtime. There is no `Fiber` namespace. `Fiber.fork`,
`Fiber.call`, `Fiber.spawn`, `Fiber.all`, `Fiber.join`, `withAbortSignal`,
`linkAbortSignal`, `createContext`, `createFiberSet`, `enterSync`,
`leaveSync` are removed.

### 7.3 Start semantics

- `call` starts the body synchronously, with the child current, and lends
  the parent (§7.11).
- `fork` **never** runs any part of the body in the forker's frame: a
  microtask at runtime, after placement on a pending node. A creation
  context cannot leak into a forked body; `own(fork(t))` is race-free; the
  body sees exactly its own node as current from its first line.
- A body cannot tell whether it was forked or called.

### 7.4 Failure destinations

| Destination | On `failure` | Use |
|---|---|---|
| `'join'` (default) | held for `join`/`result`/`asyncDispose`; if unconsumed when the parent completes, surfaces from the parent's completion | fork now, join later |
| `'link'` | aborts the parent immediately; surfaces from the parent's completion | helpers the parent cannot continue without; owned fibers (C5) |
| handler | called once with the error; parent unaffected | supervised background work; pools |

An `aborted` outcome fires no destination. A failure is consumed at most
once. `fork` with `'join'` onto a bodiless node that is not a pool is
refused: nothing joins it until shutdown (Q6).

### 7.5 `all` and `race`

Both create a fresh subscribed child and run the tasks as its
subscribers: `all([fetchUser.bind(id), fetchOrders.bind(id)])`. `all`
reports **every** real failure as an `AggregateError`; `aborted` outcomes
are excluded. `race` resolves with the first `success`, aborts and awaits
the rest.

### 7.6 Outcome classification

A `freeze` node delivered before its body settled or froze has outcome
`aborted`, **whatever the body produced**; classification is by node state,
never by inspecting the error. An `observe` node's outcome is its body's
result. A bodiless node's outcome is `success` on `close`, `aborted` on
`abort`.

### 7.7 Pools

```ts
export interface PoolOptions extends NodeOptions {
  name: string;
  onFailure: (error: unknown, fiber: Fiber<unknown>) => void;   // required
  concurrency?: number;                                          // default unbounded
  whenFull?: 'wait' | 'reject';                                  // default 'wait'
}
export interface Pool extends Context {
  fork<T, A extends unknown[]>(t: Task<A, T> | Body<T, A>, ...args: A): Fiber<T>;   // destination is always onFailure
  readonly running: number;
  readonly pending: number;
}
```

### 7.8 `run` and `runSync`

`ctx.run(fn)` makes `ctx` current for a synchronous `fn`: the way code with
no current node (a platform event callback) enters the tree, and the way
a test makes a node current; a returned promise throws in development.
`runSync(fn, …args)` is `child()`, `run`, `abort()` on exit: synchronous
block scoping.

### 7.9 Two API tiers

| Tier 1 — application code | Tier 2 — resource and library authors |
|---|---|
| `task`, `fork`, `call`, `join`, `result`, `all`, `lookup`, `own`, `release`, `signal()` | `own(fork(…))`, `pool`, `interrupt: 'observe' \| 'restore'`, `childrenOnExit` |
| `inject` in constructors; `createRootContext`; `await using` | `own(value, release)`; `current()`; `ctx.own` on behalf; `owner.outcome` |
| — | `interrupted`, `never`, `managed`, `releaseTimeoutMs`, `stallWarningMs`, topics, `ctx.run`; keys with default factories (§8.5) |

The README's first page shows tier 1 only.

### 7.10 Tasks and the two kinds of function

One function shape runs in the caller's node; a task runs in its own:

```ts
async function parse(req: Request): Promise<Order> { … }           // a function: shares the caller's node
const handle = task(async (req: Request, res: Response) => { … });  // a task: a new node per run

await parse(req);                   // plain call, same node
await handle.call(req, res);        // new child node, joined, lends the current node
handle.fork(req, res);              // new child node, concurrent
await call(async () => { … });      // inline task: block scope for temporaries
fork(async () => { … });            // inline task: ad-hoc concurrency
```

- **The decision is made at the definition.** Anything that should be a
  node is a task: handlers, jobs, workers, sessions, anything whose
  temporaries must be released on return or that must be separately
  interruptible or visible in the tree. Everything else is a function.
- A task is **not callable**, so it can never be run as a bare promise.
  Options live at the definition (`name`, `interrupt`, `childrenOnExit`,
  default destination) and are overridden per use with `with`.
- Inside a body nothing is passed: `lookup`, `own`, `fork`, `signal()`
  resolve through the current node, which the platform carries across
  every `await` (law 3).
- `bind` gives partial application, which is what `all`, `race` and pools
  consume.
- A function that acquires temporaries either releases them early before
  returning or is a task. Callers should not have to know.
- A service holds `#ctx = current()` from its constructor for things that
  live as long as the service, and uses the ambient `own`/`lookup` in
  methods for things that live as long as the call. The two side by side
  are the dependency/borrow distinction made visible.

### 7.11 Lending: unawaited calls are detected

`call` **lends** the current node to the child until the call settles: the
caller's body is supposed to be suspended on the returned promise, so any
body-shaped use of that node in the window means the `await` was
forgotten. The node records `lentTo`; these operations throw
`UnawaitedCallError` naming the child while it is set:

- `lookup`/`get`, `call`, `fork`, `child`, `pool`, `all`, `race`, `join`,
  `result`, `interrupted`, `never`, `managed`, `run`, `runSync`.

These do **not**, because another party may legitimately perform them on a
node whose body is inside a call: `own`, `release` (a producer attaching
on behalf of the node); `abort`, `close`, the `Symbol` methods
(cancellation from outside).

`Promise.all([call(a), call(b)])` throws on the second call, and the
message points at `all`; two concurrent calls on one node were never
structured. `fork` lends nothing. A forgotten `await` on a *plain*
function call is invisible to ramme and is left to `no-floating-promises`.
One field, no extra state, works after any number of awaits: it replaces
the current stack-top enforcement.

---

## 8. Contexts and DI

Unchanged: keys, providers, scopes, the placement rule (D7), topics.

### 8.1 `inject` and `lookup` →D4′

| | `inject(K)` | `lookup(K)` |
|---|---|---|
| Returns | a **dependency** of the value under construction | a **borrow** for the current node |
| Required lifetime | at least the value's — *not yet known* | at least the current node's — *fixed* |
| Met by | moving the value down to its deepest dependency | resolving upward from the current node |
| Legal | creation only (constructors, field initializers, factories, fallbacks) | anywhere a node is current |
| Result may be stored on | the value | nothing longer-lived than the current node |

**`lookup` is banned during creation** and throws `CreationViolationError`.
During a factory the only invocation a borrow could be measured against is
the factory call itself, so a creation-time borrow could only mean "use
this while constructing and don't keep it". Nothing legitimate survives
that description. A read whose result shapes the product (a URL copied out
of a config) is a dependency and must be `inject`. A read that does not
(logging the construction) is harmless to track when the key is
scope-invariant, and when it is scope-varying it is mislabelled telemetry,
a root singleton's construction stamped with one request's id; the fix is a
scope on the key, after which `inject` returns the right logger. Banning
rather than silently tracking means nothing a borrow returned can end up on
`this`, and the two verbs keep disjoint meanings. The cost is that a helper
written for bodies cannot be called from a factory and must be handed its
dependencies, which is what a factory should be doing anyway. `inject`
outside creation throws as well.

Tracked `inject` reads decide placement only for **auto-hoisted** values. A
value with a declared placement (a provider target or a scope) stays where
it was declared, as today, and its author answers for what it holds.

The one read excluded from tracking is `ContextKey` / `current()`: the
value's own node, whose depth placement is computing. A service that needs
runtime borrows for its *own* lifetime reads through `#ctx = current()`
captured in its constructor; borrows for the *call's* lifetime use the
ambient `lookup` in the method.

### 8.2 Permanent decisions and placement by view →D10′

Two rules replace today's probabilistic memo and auto-scope-root tombstone,
and the R-b check of earlier revisions.

**Decided markers.** When a requester resolves `K`, every context on the
walk, from the requester up to and including the one that answered, marks
`K` *decided*, whether the answer was a value or "not provided here". If
the answer was an auto-hoisted value `V`, the same contexts also mark every
key in `deps(V)` decided: answering `V` fixed the answers for its
dependencies on that path. `addProvider(K)` at `C`, and `K` in
`child({ providers })`, throw `PlacementError` iff `K` is decided at `C`.
A fresh child has no decisions, so providing at construction is always
allowed. A provider below the context a scoped key resolves to is still an
error. This is today's tombstone with the half it got wrong removed: it
still stops a context from *providing* a key it has already answered for,
and no longer stops the root from *instantiating* a value some descendant
placed lower, which was P7's "No provider found".

**Placement by view.** When a requester `R` walks up and finds
auto-hoisted `V` cached at `S`, and some key in `deps(V)` is provided
strictly between `R` and `S`, the cache is not `R`'s answer: `V`'s factory
runs from `R`, the result is placed by `R`'s view, at or below the shadow,
and memoized at `R`. Two instances on one path are two consistent views,
not an ambiguity, and arise only where someone deliberately provided a
dependency at both levels. Every order of resolution ends in the same
state. With `A` provided at `P` and at `C`, and `B` injecting `A`: `C`
first gives `B@C`, then `P` gives `B@P`; `P` first gives `B@P`, then `C`
hits it across its own `A` and re-creates `B@C`; a sibling `C2` without the
override hits `B@P` with no shadow between and shares it. Transitively, `D`
injecting `B` and resolved from `C` after `D@P` exists re-creates `D` and,
inside its factory, `B`.

`deps(V)` is recorded at creation: the keys `V` injected, plus the `deps`
of each injected value that was itself auto-hoisted; declared-placement
values contribute their key only. It is complete because creation-time
reads are `inject` (§8.1). Each context keeps the union of `deps` over the
values cached on it, so both rules are `Set` lookups along a path.

**An auto-hoisted factory must inject the same keys on every run.** A
re-creation forced by a shadow runs the factory with the recorded `deps(V)`
in hand; if the re-run injects a different set, the resolution throws
`PlacementError` naming both sets and nothing is cached. With equal sets the
re-run always lands at or below the shadow, so it can never collide with an
instance that already exists; a non-deterministic factory is a defect, not
a supported pattern.

What this gives: no context ever changes an answer it has given; no
requester is ever served a value built from a view of its dependencies
other than its own; both hold regardless of the order in which the tree is
exercised; and a default factory may inject request-scoped things, land at
the request context, and be overridden by a request context that provides
it. Tests that override a default-factory dependency do so on a fresh
child before anything under it resolves, or on their own root;
`captureAutoScoped` is likely unnecessary and is kept until the suite says
so.

### 8.3 Creation is pure

During creation: `inject` reads are tracked and `lookup` throws
`CreationViolationError`; the pending node is current; `call`, `run`, or
entering any other node as current throws `CreationViolationError`; `fork` on a live node passed in
from outside is allowed (microtask start); if the factory throws, the
pending node's explicit stack is released; a factory returning `undefined`
is an error.

### 8.4 Ambient state

One mechanism. The **current node** is carried by the platform's async
context, installed by `import 'ramme/node'` (or `ramme/async-context`), and
is required (law 3). Creation uses the same mechanism synchronously: the
factory runs with the pending node current, and `inject` reads the
creation state from it; because factories are synchronous (A5), nothing
about creation depends on propagation across `await`. There is no separate
creation stack and no module-level ambient variable. Without storage,
`current()` throws `NoCurrentNodeError`, and the message names the missing
import.

### 8.5 Library-defined keys carry defaults →D5 retired

lookup-api is retired (revision 6.1). It existed so that a library could
read ambient services without committing to ramme, through a neutral seam
ramme would serve. There is no such library: every library in this
ecosystem depends on ramme (kilde, §8.6), and a neutral seam with one
implementation is only an indirection. ramme therefore has no bridge, no
`contractKey`/`contractProvider`, and `createRootContext()` installs
nothing process-global. ramme is zero-dependency.

What survives is lookup-api's one discipline, as a convention rather than
machinery: **a key a library defines for its own consumption carries a
default factory**, so the library works when the application wires nothing
and the application overrides by providing. Everything lookup-api offered
beyond that is already a ramme feature, done better: a default is placed
per tree instead of memoized per process; a test overrides with a child
context's providers instead of a frame; and placement by view (§8.2)
keeps an override from being baked into a hoisted value, which is what
lookup-api's frame masking was for.

### 8.6 kilde →D6′

kilde is the reactive library for ramme applications and depends on ramme;
ramme never imports kilde. kilde's cold core (signals, computeds,
operators, channels) needs no lifetime and changes little. Its hot layer
(`deriveResource`, `connect`, `toPromise`, `link`, async states) is
rewritten in this idiom: hot constructs attach to the current node, async
callbacks are tasks (a derivation is a fiber; the previous one is aborted
and frozen when the input changes; failures have destinations), async
states are values on a factory's node (§6.6). kilde's `Owner` seam,
`createOwner`, `withOwner`, `installOwnerProvider` and its staleness
counters are removed. Specified in `kilde/PROPOSAL.md`.

---

## 9. Errors

### 9.1 Outcome

Every node has one, computed at settling; `aborted` is decided by state.

### 9.2 Body error and release errors

Aligned with `await using`: body `failure` + release failures →
`SuppressedError(releaseError, bodyError)`; body `success` (or bodiless) +
release failures → `failure` with an `AggregateError`; body `aborted` +
release failures → `failure`. An early `release(x)` that throws rejects
that call only.

### 9.3 Owned fibers

`failure` while the owner is open → the owner is aborted (C5), failure
recorded as unconsumed. `success` → removed. `aborted` → normal.

### 9.4 Unconsumed failures

At completion a node collects its own failure, every unconsumed subscriber
failure, and every owned-fiber failure. A fiber's outcome is then `failure`
delivered to *its* destination; a context's or pool's `close()` and
`asyncDispose()` reject with it.

### 9.5 No unhandled rejections

`Fiber` is not thenable and has no `.promise`; a `Task` is not callable;
outcomes are values materialised only by `join`/`result`. `close()` returns
one shared promise. A managed await on an applied node never settles.

### 9.6 Error types

```ts
export class NoCurrentNodeError extends Error {}         // free function outside any node
export class NodeCompletedError extends Error {}
export class PendingNodeError extends Error {}
export class NotOwnedError extends Error {}
export class AlreadyOwnedError extends Error {}
export class UnawaitedCallError extends Error { child: Context }
export class FiberNotAwaitableError extends Error {}
export class FiberAbortedError extends Error { reason: unknown }
export class PoolClosedError extends Error {}
export class CreationViolationError extends Error {}
export class AsyncRunError extends Error {}
export class PlacementError extends Error {}
```

---

## 10. Observability

`NodeTopic`, with `kind` (`context` | `fiber` | `pool` | `release` |
`entry`), `task` (the task's name for fibers), `stack`, `subscribed`,
`seq`: `node:created`, `node:placed`, `node:started`, `node:delivered`,
`node:frozen`, `node:settled`, `node:lent` / `node:returned`,
`node:releasing`, `entry:registered` / `entry:released`, `node:complete`,
`node:stalled`, `join:enter` / `join:leave`. Because every release is a
fiber, "print the running tree and what each node awaits" is one query
and covers shutdown. No receiver, no cost.

---

## 11. Invariants

- **I1 Single owner.**
- **I2 Once.** A node completes at most once; each entry's release runs at
  most once.
- **I3 Explicit before provided** (G1).
- **I4 Unsubscribed hear late.**
- **I5 LIFO, fixed positions.**
- **I6 Frozen is final.**
- **I7 Closed door.** After completion, every operation on the node throws.
- **I8 Open window.** Between delivery and completion, every synchronous
  operation on the node works.
- **I9 Marked before heard.**
- **I10 No unhandled rejections.**
- **I11 Consumed once or surfaced.**
- **I12 Aborted is not failure.**
- **I13 State decides.**
- **I14 Every release is a fiber**, and is current while it runs.
- **I15 Synchronous attachment.**
- **I16 Nothing runs in a creation frame.**
- **I17 Placement follows dependencies.**
- **I18 Every creation-time read is `inject`.** `lookup` throws in
  creation; tracked reads decide placement only for auto-hoisted values;
  the value's own node is excluded from tracking.
- **I19 Decisions are permanent and placement is by view.** No context
  changes an answer it has given; no cache hit crosses a shadow of the
  value's dependencies (§8.2).
- **I20 Fork is asynchronous.**
- **I21 The current node is the default owner.** Every free function acts
  on the current node, which is the node whose lifetime the running code
  has: attaching there is never wrong, only sometimes not what was meant.
  The method form exists for that case and for nothing else.
- **I22 Escape fails loudly.**
- **I23 Every acquisition is releasable early.**
- **I24 Only resolution attaches to the provided stack.**
- **I25 No bare callbacks.**
- **I26 A lent node rejects body-shaped use.**
- **I27 Fibers are not awaitable; tasks are not callable.**

---

## 12. Assumptions

- **A1 Async context propagation is present.** `AsyncLocalStorage` on
  Node ≥ 22, Bun, Deno and Cloudflare Workers (`nodejs_compat`); TC39
  AsyncContext where it ships; otherwise a build-time `async`-to-generator
  transform, as Angular used with Zone.js. Browsers without one of these
  are not supported. Nothing in userland can provide this: native `await`
  resumes a function in a job that cannot be wrapped. On current Node the
  implementation is `AsyncContextFrame`, which is cheap.
- **A2 Abandoned promises are collectable.**
- **A3 Platform:** `AbortSignal.any`/`timeout`, `Symbol.dispose`/
  `asyncDispose`, `SuppressedError`, `AggregateError`,
  `Promise.withResolvers`.
- **A4 One copy per realm**, detected, not supported.
- **A5 Factories are synchronous.** This is what lets creation run under
  the same async context as everything else with no separate stack, and
  what makes `deps(V)` complete at the moment `V` is placed.
- **A6 Dependencies are acquired before their dependents**: by construction
  for DI values; by discipline for fibers (G2) and for values' releases
  (G3).
- **A7 Bodies do not use `finally` or `using` for cleanup.** Enforced by
  lint.
- **A8 Cooperative edges.** Bodies pass `signal()` on or use managed awaits
  often enough to freeze promptly.

---

## 13. Shipped lint rules

`ramme/no-finally-in-async`, `ramme/no-using-in-async`,
`ramme/no-stored-borrow` (a `lookup(...)` result assigned to a field or
module variable), `ramme/no-owned-provider` (§5.3), `ramme/no-bare-task`
(an `async` function passed where a `Task` is expected without `task()`,
where the type does not already catch it). Recommended alongside:
`@typescript-eslint/no-floating-promises`. `try/catch` is not linted.

---

## 14. Migration from the current API

| Current | Replacement |
|---|---|
| `Drain`, `Flush`, `Dispose`, `Abort`; `ManagedResource` | `Symbol.asyncDispose`; `own(value, release)` |
| `ctx.registerResource(r)` / `handle.unregister()` | `own(r)` / `release(r)` |
| `inject(RegisterResource)(r)` | `own(r)` in the constructor |
| `inject(ContextRefKey)`, `.whenResolved` | `current()` / `inject(ContextKey)` |
| `resourceProvider(k, v, r)` | `factoryProvider(k, () => own(v, release))` |
| `ctx.create(k)`, `Created<T>` | build the value where needed; `own` its entries |
| `createRefCountedKey`, `refCountedProvider` | pool of size one, outside core |
| `createContext({ parent, ... })` | `child({ ... })`, or `parent.child({ ... })` |
| `ctx.dispose()` | `ctx.close()` or `ctx[Symbol.asyncDispose]()` |
| `ctx.status`, `ctx.aborted` | `ctx.state`, `ctx.signal.aborted` |
| `Fiber.call(fn, { context })` | `call(fn)` or `context.call(fn)`; reusable: `task(fn).call()` |
| `Fiber.spawn(fn, { context })`, `Fiber.fork(fn)` | `fork(fn)` or `context.fork(fn)`; reusable: `task(fn).fork()` |
| `Fiber.join(f)` / `Fiber.result(f)` / `fiber.promise` | `join(f)` / `result(f)` |
| `Fiber.all([fibers])` | `all([tasks])` |
| `withAbortSignal(fn)` / `linkAbortSignal(signal, fiber)` | `fn(signal())` / `task(fn, { signal }).fork()` |
| `createFiberSet({ name, onError })` | `pool({ name, onFailure })` |
| `ctx.run(async () => …)` | `ctx.call(async () => …)` |
| `ctx.enterSync()` / `leaveSync()` in tests | `ctx.run(fn)` |
| `contractKey(c)`, `contractProvider(c, v)`, `installContractResolver()`, `import 'lookup-api'` | removed; define an `InjectionKey` with a default factory and `valueProvider` to override |
| `ContextTopic`, `FiberTopic` | `NodeTopic` |

---

## 15. Open decisions

Recommendations in bold.

- **Q1 Mode names.** **`interrupt: 'freeze' | 'observe' | 'restore'`.**
- **Q2 Error precedence.** **Release-primary with `SuppressedError`.**
- **Q3 Shadowed dependencies.** Rejected: R-a (no shadowing), which does
  not remove the hazard without also forbidding the natural override of a
  request-flavoured default; "auto-hoisted keys only at the root", which
  wrongly equates a default factory with living at the root; R-b (error on
  a cache hit across a shadow), whose error is order-dependent unless
  paired with a second-placement check, and which treats two consistent
  instances on a path as a fault. **Resolved: permanent decisions and
  placement by view (§8.2).**
- **Q4 Dev warning for values' late reads that create values.** **Warn.**
- **Q5 Pool `whenFull` default.** **`'wait'`.**
- **Q6 `'join'` fork onto a bodiless non-pool node.** **Refuse.**
- **Q7 `close()` with idle bodiless children.** **Close recursively.**
- **Q8 `ctx.run` returning a promise.** **Dev-mode throw.**
- **Q9 `all` failure reporting.** **All real failures.**
- **Q10 Keep `runSync`.** **Yes.**
- **Q11 Default `releaseTimeoutMs`.** **None.**
- **Q12 Sugar for owned fibers.** **None for now**; `own(fork(t))`.
- **Q13 `ContextKey` name.** **`ContextKey`**; `current()` is the same
  thing in creation.
- **Q14 Transfer between owners.** **Out of v0.**
- **Q15 Expose `Context.register`** (lookup-api's `Owner` shape).
  **Drop**: lookup-api is retired (§8.5).
- **Q16 A `resolveFrom` option** (Effect's `forkIn`). **Out of v0.**
- **Q17 Inline bodies in `fork`/`call`.** Accept `Body` as well as `Task`,
  or require `task()` everywhere. **Accept both**: an inline body is an
  anonymous task; the enforcement benefit of `task()` is for named,
  reusable definitions.
- **Q18 A default root** when `current()` finds nothing at top level.
  **No**: `createRootContext()` is one line and is where shutdown lives
  (`await using app`); a silent root would hide the "where does this
  die?" question the whole design asks.
- **Q19 Throwing `then` on `Fiber`.** **Yes.**
- **Q20 Browser support.** Document as "when AsyncContext ships, or with
  an async-to-generator transform"; **do not** build a Zone-style
  polyfill.

Resolved in revision 6: ambient idiom; tasks; async context required;
explicit methods kept for on-behalf only; kilde on ramme. Resolved in
revision 6.1: lookup-api retired.

---

## 16. Not changed by this proposal

Keys and providers; `Scope`, `SelfScope`, `RootScope`, `RequestScope`; the
placement rule (D7) and the `DepTracker`/`createAutoHoisted` machinery
that implements it, extended with `deps(V)`; topics as DI keys. The
package layout, save that `resource.ts` shrinks to error types,
`fiber-set.ts` becomes `pool.ts`, `fiber.ts` gains `task`,
`create-context.ts` keeps only `createRootContext`, and
`contract-bridge.ts` is deleted along with the `lookup-api` dependency in
`package.json` (which also removes the `link:` publish blocker).

Removed outright: the probabilistic resolution memo (`MISS_THRESHOLD`),
the negative memo at the auto-scope root, `activeCreationCtx` and the
module-level creation stack, `installContractResolver`.

## 17. Sequencing

1. DECISIONS entries D1′, D3′, D4′, D6′, D8′, D9′, D10–D17; retire D5 and
   drop D2's and D4's references to lookup-api; rewrite DESIGN §1.1, §2–§4,
   §6, §8 from this document. Archive the lookup-api repository with a
   README pointing here; its D3 (masking) and D4 (attribution) remain the
   reasoning behind R-b and the one-container stance.
2. `node.ts`: `Context` with both stacks, subscribers, the interrupt
   signal, delivery, freeze, the fiber primitive, release fibers, lending,
   pending nodes and placement, the current node over storage. Regression
   tests: the 23 probes from the review plus one test per invariant.
3. `fiber.ts`: `task`, the free functions, destinations, `join`/`result`,
   `all`/`race`, pools, the `then` trap.
4. §8.2 (decided markers, `deps(V)`, placement by view) on the existing
   placement machinery; creation-purity checks including the `lookup` ban;
   removal of the probabilistic memo and the auto-scope-root tombstone.
5. Lint package; README showing tier 1 only.
6. `kilde/PROPOSAL.md`, then kilde's hot layer on ramme.
