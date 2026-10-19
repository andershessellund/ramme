# ramme — Design

**One tree for services and work.** Dependency injection, structured
concurrency and resource lifetimes in one structure, so that a node is at
once a *resolution scope* (what `lookup`/`inject` see), an *execution scope*
(what ambient code runs inside) and a *lifetime* (what is released together).

This document describes the library as it is: the model, the guarantees,
and how each mechanism works. It says *what*; the *why* and the rejected
alternatives are in [DECISIONS.md](DECISIONS.md), cited as `D<n>`. User
documentation is the README, which shows the first API tier only (§1.3).

---

## 1. What ramme is

Reduced to one sentence:

> **ramme is one tree of nodes, where a node's position answers both what
> it may depend on and when it dies; ancestors outlive descendants, and you
> resolve only from ancestors, so everything you can resolve outlives you.**
> (D1′)

```ts
import 'ramme/node';

class Api {
  readonly #base = inject(Config).apiUrl;            // a dependency: places the value (§3.3)
  readonly #pool = own(openPool(this.#base));        // an entry on the value's own node (§2.6)
  get(path: string) { return fetch(this.#base + path, { signal: signal() }); }   // the caller's signal
}

const handle = task(async (req: Request) => {        // a definition; each run is a fiber (§4.5)
  const api = lookup(Api);                           // a borrow for this run (§3.2)
  const file = own(await openTemp());                // released when the run ends, however it ends
  return call(render, await api.get(req.url));       // a child node, awaited; lends this one (§4.9)
});

await using app = createRootContext();               // the root: where shutdown lives
server.on('request', (req) => app.fork(handle.with({ signal: req.signal, onFailure: log }), req));
```

The tree holds services (DI values that attached something) and work
(fibers). It is not a registry of objects: most objects are plain values,
and a *resource* is an entry a value has placed on a node, a property of the
relationship rather than of the object (§2.6).

### 1.1 Position in the stack

ramme has no runtime dependencies. kilde (signals, streams, channels) is the
reactive library for ramme applications: it depends on ramme and is written
in its idiom; ramme never imports kilde (D6′). The lookup-api seam ramme
used to serve is retired; libraries define keys with default factories
instead (§8, D5). The shipped lint rules (§9) are a separate package.

### 1.2 Entry points

| Subpath | Contents |
| --- | --- |
| `ramme` | nodes, tasks, the ambient free functions, DI, topics, errors |
| `ramme/node` | side-effect import: `AsyncLocalStorage` context storage |
| `ramme/async-context` | side-effect import: TC39 `AsyncContext` storage |

The two adapters are the only modules with side effects (`sideEffects` in
package.json names exactly those files). One of them is required (§6, D9′).

### 1.3 Two API tiers

| Tier 1: application code | Tier 2: resource and library authors |
| --- | --- |
| `task`, `fork`, `call`, `join`, `result`, `all`, `lookup`, `own`, `release`, `signal()` | `own(fork(…))`, `pool`, `interrupt: 'observe' \| 'restore'`, `childrenOnExit` |
| `inject` in constructors; `createRootContext`; `await using` | `own(value, release)`; `current()`; `ctx.own` on behalf; `owner.outcome` |
| — | `interrupted`, `never`, `managed`, `releaseTimeoutMs`, `stallWarningMs`, topics, `ctx.run`; keys with default factories (§8) |

---

## 2. The node tree

### 2.1 Anatomy

Every node is a `Context`. A node has a resolution parent, an
`AbortSignal`, optionally a body, an **explicit stack** of what code
attached to it, a **provided stack** of the nodes of DI values that
resolution placed on it, a state and an outcome.

| Member | Meaning |
| --- | --- |
| `id`, `name` | process-unique id; `opts.name`, a fiber's task name, `release:<entry>` for release fibers |
| `state` | `pending` → `running` → `settling` → `releasing` → `complete` (`pending` only for a DI value's node before placement) |
| `signal` | fires when the node is delivered (§4.1) |
| `outcome` | `undefined` until settling, then `success` / `failure` / `aborted` (§4.12) |
| `scopes` | the scopes this node carries (read-only) |

Options (`NodeOptions`): `name`, `providers`, `scopes`, `interrupt`
(`'freeze'` default, `'observe'`, `'restore'`), `childrenOnExit`
(`'interrupt'` default, `'await'`), `timeoutMs` (delivers a `TimeoutError`
to this node), `signal` (delivers when it fires), `releaseTimeoutMs` (the
deadline of this node's release fibers; inherited; none by default) and
`stallWarningMs` (default 5000; inherited; `0` or `Infinity` disables).
Millisecond options are validated at construction.

### 2.2 The three bits

Nodes differ in three independent bits, plus a `kind` tag (`context`,
`fiber`, `pool`, `release`, `value`) used for errors and events.

| Bit | Values | Decided by |
| --- | --- | --- |
| **Yields a value** | fiber (`Fiber<T>`) / not | `fork`/`call` vs everything else |
| **Subscribed** | hears the parent's interrupt at body exit (work) / at its turn in the release loop (infrastructure) | `fork`/`call`/`child` vs `own(node)`/`pool`; a DI value's node is never subscribed |
| **Interruption** | `freeze` (applied, forwarded) / `observe` (delivered only) / `restore` | the `interrupt` option |

| | has a body | no body |
| --- | --- | --- |
| **subscribed** | `fork`, `call`: handlers, workers, sessions | `child()`: a request scope |
| **unsubscribed** | `own(fork(…))`: a reaper | `pool(…)`; a DI value's node; a passive entry |

### 2.3 Node kinds by construction

| Constructor | Kind | Stack / subscribed | Body | Notes |
| --- | --- | --- | --- | --- |
| `createRootContext(opts)` | context | root | no | the only free constructor; carries `RootScope`; `[Symbol.dispose]` throws |
| `child(opts)` | context | explicit / yes | no | |
| `call(t, …)` / `t.call(…)` | fiber, joined | explicit / yes | yes | starts synchronously; lends the current node (§4.9) |
| `fork(t, …)` / `t.fork(…)` | fiber | explicit / yes | yes | starts in a microtask, or after placement in creation |
| `own(fork(t, …))` | fiber | explicit / **no** | yes | an owned fiber (C5) |
| `pool(opts)` | pool | explicit / no | no | its forks are its subscribers (§4.10) |
| a DI value's node | value | **provided** / no | no | pending until placed (§3.3) |
| a release fiber | release | none (transient) | yes | §2.4 |

`own(node)` on one of this node's own subscribed entries flips it to
unsubscribed; its stack entry stays where it is. Code cannot attach to the
provided stack; only resolution does.

### 2.4 Completion and release

When a node's body settles or freezes (a bodiless node: on `abort()` or
`close()`):

1. **Signal.** Under `childrenOnExit: 'interrupt'` (the default), and always
   after `abort()`, every subscriber in the subtree is delivered in this
   tick. A natural body exit delivers them with an `OwnerInterrupt` reason
   and does not mark the exiting node itself. Under `'await'`, or on
   `close()`, nothing is fired.
2. **Release the explicit stack, LIFO.** A subscribed node entry is mostly a
   wait (it gets `close()` under `'await'`/`close()`); an unsubscribed one
   (an owned fiber, a pool) is aborted at its turn, which is the first
   thing it hears.
3. **Release the provided stack, LIFO.**
4. **Complete.** The node leaves its owner's stack; its cache, providers and
   decisions are dropped; `completion` resolves.

The loop re-reads the top of the stack at every step, so an entry pushed
while the node is releasing (an `own` from a release, a value placed by a
release fiber's `lookup`) is released next. A node whose every release is
synchronous completes synchronously inside `abort()`.

**One release.** Each entry is released by calling its
`[Symbol.asyncDispose]()` (a `Disposable` is wrapped; D3′) inside a
**release fiber**: a node of kind `release` whose resolution parent is the
owner, whose signal is a fresh `AbortSignal.timeout(releaseTimeoutMs)` (or
never fires), in `observe` mode, on no stack. The release fiber is the
current node while the release runs, so inside any release, ramme-native or
foreign, `signal()` is the deadline, `own(...)` attaches things that live as
long as the release, `lookup` resolves through the owner, and
`owner.outcome` (captured at acquisition) is readable: the outcome is fixed
at settling. A node entry's release is `abort()` (or `close()`) and then
waiting for its completion. A release runs exactly once per entry, even
under a concurrent early `release(x)`; a release that throws does not stop
the next one, and its error is collected (§4.12).

### 2.5 What the order guarantees (D16)

- **G1** Anything code or its descendants read from a node's provided values
  stays alive until every explicit entry on that node has completed.
  Unconditional: provided values are registered lazily, at a time the body
  author does not control.
- **G2** Explicit entries release in reverse attachment order: dependency
  order iff a fiber uses only what was attached before it was forked.
  *Discipline:* acquire before you fork what uses it.
- **G3** Provided values release in reverse creation order, which is
  dependency order because `inject` runs during creation. *Discipline:* a
  value's release, and a value's owned fibers, use only what the value
  injected or reads through its own node.
- **G4** Interruption reaches the whole subscribed subtree at once; nothing
  waits for a sibling.

**Not guaranteed:** order among subscribers during step 1 (the *sibling
rule*: a subscriber must not depend on a sibling subscriber's liveness
during its cleanup; anything it needs then must be unsubscribed and
attached earlier, or a provided value); anything about a reference that
escaped to a longer-lived scope, except that use fails loudly (§2.7).

### 2.6 Ownership

**`own` and `release`.** `own(x)` attaches to the current node; `ctx.own(x)`
to a named one. The overloads are the contract (`own(resource)` for an
`AsyncDisposable` or `Disposable`; a node itself), and two sugars that wrap
it: `own(value, release)` and `own(deferFn)`. Every overload returns what
it attached; attached values must be objects so that `release(x)` finds the
entry by identity. `own(x)` with one argument on an object this node already
owns is a no-op that returns `x`, so a body can `own` what a producer
already attached on its behalf; `own(x, release)` for it is
`AlreadyOwnedError` (a second release). There is no bare detach.

```ts
const owner = current();
const tx = own(await db.begin(), (tx) =>
  owner.outcome === undefined || owner.outcome.status === 'success' ? tx.commit() : tx.rollback());
```

Released early (`release(tx)`) or at a successful completion it commits;
under `aborted`/`failure` it rolls back.

**Where an entry lands.**

- In a body: on the explicit stack of the current node, the body's fiber.
- In creation: on the explicit stack of the value's **pending node**, the
  current node during the factory (§3.3).
- In a release: on the release fiber, released when the release finishes.
- On a node someone handed you: on that node's explicit stack.

**Contracts.**

- (C1) `own` is synchronous; the entry is registered before it returns.
- (C2) `own` on a delivered-but-incomplete node succeeds.
- (C3) `own` on a complete node throws `NodeCompletedError`.
- (C4) A release runs exactly once per entry, in a release fiber, after
  everything above it on its stack and (for provided entries) after the
  whole explicit stack.
- (C5) An owned **fiber** that settles with `failure` while its owner is
  open aborts the owner. One that settles with `success` is removed.
- (C6) A release that throws does not stop the remaining releases.
- (C7) `release(x)` runs `x`'s release now, exactly once; concurrent calls
  share one promise; `release` of something the node does not own throws
  `NotOwnedError`.
- (C8) A second release registered for one object on one node throws
  `AlreadyOwnedError`.

Two nodes owning the same passive object each run its dispose once;
idempotence of a passive entry is its author's responsibility.

**Producers attach before they return.** A function that returns a newly
acquired resource attaches it before returning and returns a handle whose
`release()` goes through the owner. The owner defaults to the current node;
a producer that grants later, inside some other fiber, holds the owner and
uses the method form:

```ts
acquire(owner: Context = current()): Promise<Lease> {
  const lease = new Lease(this.#take(), owner);   // lease.release() is owner.release(lease)
  owner.own(lease);                                // no moment without someone responsible
  return Promise.resolve(lease);
}
```

**Early release, `finally` and `catch`.** A body may release anything it
attached at any time. What the model removes is *cleanup as control flow*:
a frozen body never resumes (§4.2), so a `finally` in an async body does not
run on interruption, and `using`/`await using` inside async bodies is
`finally` in disguise. Invariants that must hold after the body ends belong
to an entry: `own(() => …)`. `try/catch` is fine: a `catch` never sees an
interruption, only real errors.

### 2.7 Lifecycle operations and use after release

| | Signal | Waits | Rejects with |
| --- | --- | --- | --- |
| `abort(reason)` | yes | no | — |
| `close()` | no | subscribers naturally, then both stacks | unconsumed failures |
| `[Symbol.dispose]()` | yes | no; the owner's completion waits | — (throws `TypeError` on a root) |
| `[Symbol.asyncDispose]()` | yes | completion | unconsumed failures; for a fiber also its own failure (acts as `join`) |

These four are idempotent on a complete node. `close()` on a fiber waits for
its body and then releases without a signal; an `abort()` arriving first
wins. `close()` on a bodiless node closes its subscribed children
recursively and aborts its unsubscribed ones at their turn.

| Operation | Before delivery | Delivered, not complete | Complete |
| --- | --- | --- | --- |
| `lookup` / `get` | works | works | `NodeCompletedError` |
| `own`, `release` | works | works; released at completion | `NodeCompletedError` |
| `fork` / `call` / `child` / `pool` | works | works; a `freeze` child is delivered at birth, an `observe` one is not | `NodeCompletedError` |
| managed await | settles | never settles (`freeze`) / settles (`observe`) | `NodeCompletedError` |
| a released resource's handle | — | — | resource-defined; should throw |

A cache hit whose value node has completed throws `NodeCompletedError`
rather than handing out a released service.

### 2.8 The parent/child contract

What a parent provides to anything on its stacks: resolution (everything it
resolves; ancestors outlive you); a signal (subscribed: at the parent's body
exit or abort; unsubscribed: at your turn; provided values: after every
explicit entry has completed); waiting (the parent does not complete until
you do, **whatever it costs**; a deadline is a signal to you, never
permission to abandon you); order (reverse attachment within your stack;
explicit before provided); `asyncDispose` at most once; `parent.outcome`
readable during your release (`undefined` means early); your failure routed
or collected, never an unhandled rejection; a place to run (your own node,
or a release fiber, current while you release).

What an entry provides: `[Symbol.asyncDispose]()` whose synchronous prefix
delivers your signal (nodes) and whose promise settles when you are fully
complete; idempotence (built in for nodes, yours for passive entries);
readable `state`/`outcome`/`signal.aborted` (nodes); every operation throws
after completion; a single owner; and **finishing**: your release eventually
settles because your body reaches a managed await or honours the signal.
The parent promises to wait forever; the child promises to finish. A child
that does not is reported (`node:stalled`, §5).

---

## 3. Dependency injection

### 3.1 Keys, providers, scopes

An `InjectionKey<T>` is a class, a function, or a token made by
`createInjectionKey(name, { factory?, scope? })`; a class or function key,
and a token with a `factory`, is its own **default factory**.
`setDependencies(target, ...keys)` declares constructor or function
arguments. Providers (`valueProvider`, `factoryProvider`, `classProvider`,
`aliasProvider`) bind keys on a node, at construction (`providers`) or
later (`addProvider`). A `Scope` is a name nodes carry (`scopes`); a scoped
key or provider stores its value on the nearest node carrying that scope.
`SelfScope` means "per consuming creation, stored nowhere" (or at a node
that carries it); `RootScope` is on every root; `RequestScope` is the
conventional per-request scope, attached explicitly
(`child({ scopes: [RequestScope] })`). Topics are keys too (§5).

### 3.2 The two verbs: `inject` and `lookup` (D4′)

| | `inject(K)` | `lookup(K)` |
| --- | --- | --- |
| Returns | a **dependency** of the value under construction | a **borrow** for the current node |
| Required lifetime | at least the value's, not yet known | at least the current node's, fixed |
| Met by | moving the value down to its deepest dependency | resolving upward from the current node |
| Legal | creation only (constructors, field initializers, factories) | anywhere a node is current, except creation |
| Result may be stored on | the value | nothing longer-lived than the current node |

`lookup` (and `get`) during creation throws `CreationViolationError`;
`inject` outside creation throws it too. `lookup(K, { optional, skipSelf })`
and `ctx.get(K, …)` take the same options; `skipSelf` resolves from the
parent (the decorator pattern) without that parent's guards, so it works
from inside a `call()`ed body. A service that needs runtime borrows for its
*own* lifetime keeps `#ctx = current()` from its constructor and reads
through it; borrows for a *call's* lifetime use the ambient `lookup` in the
method. The two side by side are the dependency/borrow distinction made
visible.

### 3.3 Creation, the pending node and auto-hoisting (D7)

Resolving `K` walks from the requester `R` upward: the first cache hit or
provider answers. A provider's value is stored where it is declared (its
providing node, or its scope's owner). A key with no provider but a default
factory is **auto-hoisted**: its factory runs in a **creation frame** that
records every `inject` into a dependency tracker, and the value is stored on
the deepest node that served one of its dependencies (clamped by the nearest
`captureAutoScoped` node, a harness option), so a value is never cached
above a node whose values it consumed, and sharing is as wide as the
dependencies allow. Tracked reads decide placement only for auto-hoisted
values; a value with a declared placement stays where it was declared.

The value's **own node** is excluded from tracking: `inject(ContextKey)`,
or `current()` in creation, returns it. That node is created on demand by
the first `own`, `fork`, `pool`, `child`, `current()` or
`inject(ContextKey)`; a value that attaches nothing never gets one. Until
placement it is **pending**: it accepts `own`, `release`, `releaseAll`,
`fork`, `pool` and `child`, while `get`, `addProvider`, `call`, the managed
awaits, `run`, `runSync`, `abort`, `close` and the `Symbol` methods throw
`PendingNodeError`. At placement its parent becomes the storage node `S`,
it is pushed on **`S`'s provided stack**, unsubscribed, and the forks made
in the factory start. A declared placement's node is live on `S` from its
first touch. Placement into a node that is already releasing (a release
fiber's `lookup` created the value) pushes it on top, so it is released
next, before the values it depends on; placement into a complete node
throws `NodeCompletedError`.

A factory that throws has its node's explicit stack released (the node is
owned by the requester while that happens), caches nothing, and rethrows;
the next resolution runs the factory again. A factory returning `undefined`
is `FactoryReturnedUndefinedError` (a `CreationViolationError`). Circular
`inject` chains throw `Circular dependency detected: A → B → A`, including
re-entry through a release the factory started. A fork made in a
constructor with the default `'join'` destination and not owned fails the
resolution: nothing would join it (D14). Factories are synchronous (A5),
which is what lets creation run under the same async context as everything
else and what makes the recorded dependency set complete at placement.

### 3.4 Permanent decisions and placement by view (D10′)

**Decided markers.** When `R` resolves `K`, every node on the walk, from `R`
up to and including the one that answered, marks `K` *decided*, whether the
answer was a value or "not provided here". If the answer was an
auto-hoisted value `V`, the same nodes also mark every key in `deps(V)`.
`addProvider(K)` at `C` throws `PlacementError` iff `K` is decided at `C`.
A fresh child has no decisions, so providing at construction is always
allowed. A provider for a scoped key below the node that key resolves to is
also a `PlacementError` (at `addProvider`, at `child({ providers })`, and
when a pending value node that built such a child is placed).

**Placement by view.** When `R` finds auto-hoisted `V` cached at `S`, and
some key in `deps(V)` is provided strictly between `R` and `S` (or a node
there owns the scope of a scoped dependency), the cache is not `R`'s
answer: `V`'s factory runs from `R` and the result is placed by `R`'s view
and memoized there. With `A` provided at `P` and at `C`, and `B` injecting
`A`: whichever of `C.get(B)` and `P.get(B)` runs first, the tree ends with
`B@C` built from `C`'s `A` and `B@P` built from `P`'s; a sibling of `C`
without the override shares `B@P`.

`deps(V)` is recorded at creation: the keys `V` injected (an optional miss
included: "not provided" is part of `V`'s view), plus the `deps` of each
injected auto-hoisted value; declared-placement values contribute their key
only. A value built from a requester-relative read (a per-creation
`SelfScope` value, a `skipSelf` read) is pinned to its requester. What this
gives: no node ever changes an answer it has given; no requester is served a
value built from a view of its dependencies other than its own; both hold
in every order of resolution.

### 3.5 Creation is pure

During creation: `inject` reads are tracked and `lookup` throws; the
pending node is current; `call`, `run`, the managed awaits and entering any
other node as current throw `CreationViolationError`; `fork` on a live node
passed in from outside is allowed (it starts in a microtask); a creation
ends when its factory returns, so a continuation the factory scheduled runs
with no creation frame. A late read on a value's node that *creates* a value
(after construction) warns once per key in development.

---

## 4. Interruption and fibers

### 4.1 The signal

`node.abort(reason)` delivers to `node` synchronously and top-down along
subscription edges, in two passes: first the whole subscribed subtree is
marked (a `freeze` node forwards to every subscriber; an `observe` node
only to `restore` ones), then signals fire, then in-flight managed awaits
are cut and bodiless nodes exit. **Every node of a delivery is marked before
any listener runs.** Unsubscribed entries hear their signal at their turn in
the release loop. Delivery itself releases nothing.

A node's own `abort()`, `timeoutMs` and linked `signal` always deliver to
it. The default reason is an `AbortError` `DOMException`; `timeoutMs`
delivers a `TimeoutError`; a parent's body exit delivers `OwnerInterrupt`.

### 4.2 Freeze and managed awaits (D13)

On a delivered `freeze` node every **managed await** returns a promise that
never settles. The body is *frozen*: it never resumes, never runs `finally`,
never throws. ramme retains nothing of it, so the suspended function is
garbage-collectable (A2). A frozen body counts as settled. Between delivery
and the next managed await the body is running plain code, and everything
it does is legitimate (I8).

A managed await is an await on a promise returned by `call`, `all`,
`race`, `release`, `releaseAll`, `join`, `result`, `interrupted`, `never`,
`managed(p)`, `close()` or `[Symbol.asyncDispose]()`. Everything else is
bare: `fetch`, timers, driver promises; `managed(p)` makes one freeze. The
freeze decision is made for **the awaiting body's node**, `current()` when
the promise is made, whichever node the method was called on. With no
current node (top level, a platform callback) nothing freezes, and the
promise rejects with `FiberAbortedError` if the awaited fiber was aborted.
So `app.abort()` from a signal handler makes a top-level
`await app.call(main)` reject, and the surrounding `await using` cleanup
runs.

"Suspended on a managed await" means its `then` was called: a stored,
not-yet-awaited managed promise does not freeze the body at delivery, and
freezes it the moment it is awaited. `await`, `return p` from an async
function and ramme's own `all`/`race` are the supported shapes; combinators
that can resume a body while one of its managed promises is still pending
(`Promise.race`, `Promise.allSettled`, a `.then` attached without awaiting)
are not, and development builds warn about them. Delivery of a managed
promise's value is also where a failure is *consumed*: a frozen awaiter
consumes nothing, and the failure surfaces from the parent (§4.12). Every
source ramme wraps settles without rejecting, so no ramme promise is ever
an unhandled rejection, awaited or not.

### 4.3 Interruption modes and the birth rule (D12)

| | `freeze` (default) | `observe` | `restore` |
| --- | --- | --- | --- |
| Delivered | when the parent forwards, or aborted directly | when the parent forwards, or aborted directly | whenever an ancestor on its subscription path is delivered |
| Applied (managed awaits freeze) | yes | **no** | yes |
| Forwards to subscribers | yes | **no**, except to `restore` ones | yes |
| Outcome after delivery | `aborted`, whatever the body does | the body's own result | `aborted` |
| Born under an already-delivered parent | delivered at birth | **not** delivered at birth | delivered at birth |

`observe` is the resource author's mode: the body sees the interrupt
(`signal()`, `await interrupted()`), runs a controlled shutdown and settles
on its own; it never freezes. `restore` re-opens a cancellable window inside
an `observe` region. `task(fn, { interrupt: 'observe', timeoutMs: 5000 })
.call()` is a bounded critical section. A subscribed child born under a
delivered parent is delivered at birth iff the parent would have forwarded
to it; an unsubscribed one hears at its turn, as always.

### 4.4 Hazards and diagnostics

A `freeze` body that never reaches a managed await after delivery never
freezes, and its owner waits. Foreign library code is bare throughout. The
mitigation is diagnostic: `node:stalled` when a delivered node (any mode)
has neither settled nor frozen within `stallWarningMs`. Release fibers are
nodes, so a stuck release shows up the same way.

### 4.5 Tasks and the two kinds of function (D8′)

```ts
async function parse(req: Request): Promise<Order> { … }           // a function: shares the caller's node
const handle = task(async (req: Request, res: Response) => { … });  // a task: a new node per run

await parse(req);                   // plain call, same node
await handle.call(req, res);        // new child node, joined, lends the current node
handle.fork(req, res);              // new child node, concurrent
await call(async () => { … });      // inline task: block scope for temporaries
fork(async () => { … });            // inline task: ad-hoc concurrency
```

`task(body, opts)` returns a `Task`: `name`, `fork(...args)`,
`call(...args)`, `with(opts)` (per-use overrides) and `bind(...args)`
(partial application, which `all`, `race` and pools take). A `Task` is an
object, not a function: invoking it is a `TypeError` at compile time and at
runtime. Options (`TaskOptions` = `NodeOptions` + `onFailure`) live at the
definition. Anything that should be a node (handlers, jobs, workers,
sessions; anything whose temporaries must be released on return, or that
must be separately interruptible or visible) is a task; everything else is
a function. A function that acquires temporaries either releases them
before returning or is a task.

A `Fiber<T>` is a node with a body yielding an outcome. It is not thenable:
`await fiber`, `Promise.resolve(fiber)` and `Promise.all([fiber])` reject
with `FiberNotAwaitableError`; use `join(f)` (the value, or the failure
thrown) or `result(f)` (the outcome; never rejects). A body that returns a
fiber fails with `FiberNotAwaitableError`.

### 4.6 Start semantics

- `call` starts the body synchronously, with the child current.
- `fork` **never** runs any part of the body in the forker's frame: it
  starts in a microtask, or after placement when forked during creation. A
  creation context cannot leak into a forked body; `own(fork(t))` is
  race-free; the body sees exactly its own node as current from its first
  line.
- A body cannot tell whether it was forked or called.
- A fiber aborted before its body started settles `aborted` without
  running; a fiber forked under an already-delivered `freeze` parent runs
  until its first managed await.

### 4.7 Failure destinations (D14)

```ts
type FailureDestination = 'join' | 'link' | ((error: unknown, fiber: Fiber<unknown>) => void);
```

| Destination | On `failure` | Use |
| --- | --- | --- |
| `'join'` (default) | held for `join`/`result`/`asyncDispose`; if unconsumed when the parent completes, surfaces from the parent's completion | fork now, join later |
| `'link'` | aborts the parent immediately; surfaces from the parent's completion | helpers the parent cannot continue without; owned fibers (C5) |
| handler | called once, at completion, with the final failure and the parent current; the parent waits for a promise it returns | supervised background work; pools |

An `aborted` outcome fires no destination. `fork` with the default
`'join'` onto a live bodiless node that is not a pool (`root.fork(t)`,
`child().fork(t)`) throws `TypeError` at the call: nothing would join it
until shutdown. Pass `onFailure`, fork from a body, or use a pool.

### 4.8 `all` and `race`

Both run the tasks as subscribers of a fresh child fiber (a `call`, so they
lend the current node): `all([fetchUser.bind(id), fetchOrders.bind(id)])`
resolves with the tuple of values in order, and rejects with an
`AggregateError` of **every** real failure; `aborted` members are excluded
from it, and an aborted member with no failure rejects with
`FiberAbortedError`. `race` resolves with the first `success`, aborts and
awaits the rest; with no success it rejects with an `AggregateError` of the
failures (or `FiberAbortedError` if every member was aborted); `race([])` is
a `TypeError`. Members always run as `'join'` fibers of the group, whatever
their own destination.

### 4.9 Lending: unawaited calls are detected (D11)

`call` **lends** the current node to the child until the call settles (the
child completes, its releases included): the caller is supposed to be
suspended on the returned promise, so any body-shaped use of that node in
the window means the `await` was forgotten. While lent, `lookup`/`get`,
`call`, `fork`, `child`, `pool`, `all`, `race`, `join`, `result`,
`interrupted`, `never`, `managed`, `run` and `runSync` throw
`UnawaitedCallError` naming the child (`.child`). `own`, `release`,
`abort`, `close` and the `Symbol` methods do not: another party may attach
on behalf of the node or cancel it from outside.

`call` lends `current()`, never the receiver: `otherCtx.call(fn)` from body
`Y` lends `Y`, and a top-level `await app.call(main)` lends nothing, so a
platform callback can `app.fork(...)` while it runs.
`Promise.all([call(a), call(b)])` throws on the second call; two concurrent
calls on one node were never structured (use `all`). A forgotten `await` on
a plain function call is invisible to ramme and left to
`no-floating-promises`.

### 4.10 Pools (D15)

```ts
interface PoolOptions extends NodeOptions {
  name: string;
  onFailure: (error: unknown, fiber: Fiber<unknown>) => void;   // required
  concurrency?: number;                                          // default unbounded
  whenFull?: 'wait' | 'reject';                                  // default 'wait'
}
```

A pool is an unsubscribed bodiless node; its forks are its subscribers and
always report to `onFailure`. `pool.running` counts started forks,
`pool.pending` queued ones. With `concurrency` reached, `'wait'` queues the
fork and `'reject'` throws `PoolFullError`. Intake stops at the signal:
`pool.fork` throws `PoolClosedError` once the pool is delivered or `close()`
was requested, `NodeCompletedError` after completion. `close()` drains the
queue (waiters start as slots free); `abort()` cancels it (queued forks
settle `aborted` without running). The pool's owner reaches it at its turn
in the release loop, after the explicit entries above it.

### 4.11 `run` and `runSync`

`ctx.run(fn)` makes `ctx` current for a synchronous `fn`: the way code with
no current node enters the tree, and the way a test makes a node current. A
returned promise throws `AsyncRunError` in development (it would be current
only for the synchronous part). `runSync(fn, …args)` is `child()`, `run`,
and `abort()` on exit: synchronous block scoping whose synchronous releases
have run when it returns.

### 4.12 Outcomes and errors (D17)

Every node's outcome is computed at settling and decided by state, never by
inspecting the error: a `freeze` or `restore` node delivered before its body
settled or froze is `aborted`, whatever the body produced; an `observe`
node's outcome is its body's result; a bodiless node is `success` on
`close`, `aborted` on `abort`. Delivery after settling changes nothing.

The release phase amends the outcome once, aligned with `await using`: body
`failure` plus release failures → `SuppressedError(releaseError, bodyError)`
(release-primary); body `success` or bodiless plus release failures →
`failure` (with an `AggregateError` for two or more); body `aborted` plus
release failures → `failure`. An early `release(x)` whose release throws
rejects that call; if the caller froze or never awaited, the error surfaces
from the owner's completion instead. The call counts as awaited from its
creation, so an `await` or combinator applied to it at once is covered,
until its awaiter is resumed or frozen. An owner whose releases end while
the caller is still waiting completes only once the caller has been
resumed (or frozen), so the error is reported exactly once (plan D-123,
D-127). A call nobody awaits holds its owner for at most two microtasks.
A caller that first awaits after the owner completed sees the error again,
as any second `join` does.

At completion a node collects its own failure, every unconsumed subscriber
failure (fibers, child contexts, pools and value nodes alike), every
owned-fiber failure and every undelivered early-release failure. A fiber's
final outcome then goes to *its* destination; a context's or pool's
`close()` and `asyncDispose()` reject with it. A failure is consumed at most
once: by a delivered `join`/`result`/`asyncDispose`/`close`, or by the
parent surfacing it. Nothing ramme produces is an unhandled rejection.

| Error | Thrown when |
| --- | --- |
| `NoCurrentNodeError` | a free function runs outside any node; or no context storage is registered (the message names `ramme/node`) |
| `NodeCompletedError` | any operation but the lifecycle four on a complete node; a cache hit on a released value; placement into a complete node |
| `PendingNodeError` | a refused operation on a value node before placement (§3.3) |
| `NotOwnedError` | `release(x)` of something this node does not own; `own(node)` of another node's entry |
| `AlreadyOwnedError` | a second release for one object on one node; `own(node)` of an already-owned node |
| `UnawaitedCallError` | body-shaped use of a lent node (§4.9); `.child` is the call fiber |
| `FiberNotAwaitableError` | awaiting a fiber; a body returning a fiber |
| `FiberAbortedError` | `join`/`call`/`all`/`race` of an aborted fiber by an awaiter that is not frozen; `.reason` |
| `PoolClosedError`, `PoolFullError` | pool intake after the signal or `close()`; at capacity with `whenFull: 'reject'` |
| `CreationViolationError` | `lookup` or a body-shaped operation during creation; `inject` outside creation; `get(ContextKey)` |
| `FactoryReturnedUndefinedError` | a factory or provider returned `undefined` (a `CreationViolationError`) |
| `AsyncRunError` | `run(fn)` returned a promise (development) |
| `PlacementError` | providing a decided key (§3.4); a scoped provider below its scope's owner |
| `OwnerInterrupt` | never thrown: the abort reason of a parent's body exit, or of an entry's turn in the release loop; `.owner` |

---

## 5. Observability

`createTopic<T>(name)` makes an injection key for a receiver function;
providing one turns emission on, and its absence costs nothing. `NodeTopic`
carries the node tree's lifecycle; its receiver must be a construction-time
provider on the root and is resolved once per root:

```ts
createRootContext({ providers: [valueProvider(NodeTopic, (e) => trace(e))] });
```

Every event has `seq` (increasing), `id` (the node; for `entry:*` the
owner), `kind` (`context` | `fiber` | `pool` | `release` | `value`, or
`entry`) and `parentId`:

| Event | Fields |
| --- | --- |
| `node:created` | `name`, `task`, `stack` (`explicit` / `provided` / `none`), `subscribed`, `mode`; always a node's first event |
| `node:placed` | `storageId`: a value node reached its storage node |
| `node:started` | a body started |
| `node:delivered` | `reason` |
| `node:frozen` / `node:settled` | the body froze / settled with `outcome` |
| `node:lent` / `node:returned` | `childId`: a `call` lent this node / gave it back |
| `node:releasing` | `stack`: the release loop entered a stack |
| `entry:registered` / `entry:released` | `entryName`, `stack`; `error` on a failed release |
| `node:complete` | `outcome`; always a node's last event |
| `node:stalled` | `sinceMs` (§4.4) |
| `join:enter` / `join:leave` | `joinedId`, `outcome`: a `join` or `result` waits on a fiber; emitted on the awaiting body's node, not on the receiver of `n.join(f)` (on the receiver when no body awaits); a frozen awaiter emits no `join:leave` |

Because every release is a fiber, "print the running tree and what each
node awaits" is one query and covers shutdown. A receiver is a sink: it
runs synchronously in the emitting frame and must not use ambient
operations; one that throws is reported with `console.error` and the event
is dropped. Without a receiver no event is built and no stall timer armed.

---

## 6. Ambient state: the current node

The **current node** is the node the running code belongs to: a body's own
fiber, the release fiber during a release, the node `ctx.run(fn)` entered,
or, during creation, the value's pending node. Every free function is
`current().<method>(...)` (I21); the `Context` methods exist for acting on
behalf of a node that is not current.

There is one mechanism. A `Frame` (`{ node, creation }`) is held in the
platform's async context, which an adapter registers once:

- `import 'ramme/node'`: `AsyncLocalStorage` (Node ≥ 22, Bun, Deno,
  Cloudflare Workers with `nodejs_compat`; `AsyncContextFrame` on current
  Node);
- `import 'ramme/async-context'`: TC39 `AsyncContext.Variable` where it
  ships (throws at import when it is missing).

`registerContextStorage(impl)` is the seam both use. Propagation is
required (law 3): nothing in userland can resume a native `async` function
with context attached. Without storage, every frame-needing operation
throws `NoCurrentNodeError`, and the message names the missing import;
there is no synchronous fallback stack and no module-level ambient variable
(D9′). Creation uses the same mechanism synchronously: a factory runs with
a creation frame current, and `inject` reads the creation state from it.
ramme runs its own continuations (body settle reactions, start microtasks,
release steps, timers) under an empty frame, so they inherit neither the
forker's node nor a finished creation.

---

## 7. Package layout

| Module | Responsibility |
| --- | --- |
| `context-key.ts` | `InjectionKey`, default factories, key scopes, `setDependencies` |
| `scope.ts` | `Scope`, `createScope`, `SelfScope`, `RootScope`, `RequestScope` |
| `topic.ts` | `createTopic`, `TopicReceiver` |
| `provider-util.ts` | `classProvider`, `factoryProvider`, `valueProvider`, `aliasProvider` |
| `context.ts` | public types: `Context`, `NodeOptions`, `Task`, `Fiber`, `Outcome`, `Pool`, … |
| `resource.ts` | the error classes, `SuppressedErrorCtor`, `toDispose` (the `own` overloads into one dispose) |
| `context-storage.ts` | the `Frame`, the storage contract, `registerContextStorage`, current-frame reads |
| `node.ts`, `async-context.ts` | the two storage adapters (side-effect entries) |
| `internal-context.ts` | shared internal types: node kinds, cache entries, task brand, failure records |
| `stack.ts` | `Entry`, `Stack`: the two stacks, fixed positions, LIFO release order |
| `managed.ts` | `ManagedPromise`: the freeze decision and failure delivery |
| `node-impl.ts` | `NodeImpl`: every node; delivery, body, release loop, release fibers, lending, placement hooks, lifecycle, `fork`/`call`/`all`/`race`, awaits, events |
| `pool.ts` | the pool's concurrency queue and intake rules |
| `inject.ts` | `inject`, `ContextKey`, creation state, dependency tracking, the resolution walk, decided markers, placement by view, the pending node's lifecycle |
| `fiber.ts` | `task()` |
| `ambient.ts` | the free functions: `current`, `signal`, `lookup`, `own`, `release`, `fork`, `call`, … |
| `lifecycle-events.ts` | `NodeEvent`, `NodeTopic` |
| `create-context.ts` | `createRootContext` |
| `index.ts` | the public surface |

Runtime import graph (type-only imports not shown; no evaluation-order
cycles): `context-key`, `scope`, `topic`, `resource` are leaves;
`context-storage` is registered into by the adapters; `stack`, `managed`,
`lifecycle-events` and `internal-context` sit over those; `inject` and
`pool` never import `node-impl` at runtime (nodes are created and placed
through methods on the requester); `node-impl` sits over all of them;
`ambient` over `context-storage`, `resource` and `inject`; `fiber` over
`ambient`; `create-context` over `node-impl`; `index` re-exports.

---

## 8. Libraries: keys carry their defaults (D5 retired)

There is no bridge to a neutral contract seam, no `contractKey`, no
process-global resolver, and `createRootContext()` installs nothing. A
library that defines a key for its own consumption gives it a **default
factory**, so the library works when the application wires nothing, and
the application overrides by providing the key:

```ts
// in the library
export const HttpConfig = createInjectionKey('HttpConfig', { factory: () => ({ timeoutMs: 10_000 }) });
export class HttpClient { readonly #config = inject(HttpConfig); … }

// in the application, or a test
const app = createRootContext({ providers: [valueProvider(HttpConfig, { timeoutMs: 1_000 })] });
```

The default is placed per tree, not memoized per process; a test overrides
it with a child's providers or its own root; and placement by view (§3.4)
keeps an override from being baked into a hoisted value.

---

## 9. What is not here

- **The lint rules** (`ramme/no-finally-in-async`, `ramme/no-using-in-async`,
  `ramme/no-stored-borrow`, `ramme/no-owned-provider`, `ramme/no-bare-task`)
  ship as a separate ESLint plugin package. Recommended alongside:
  `@typescript-eslint/no-floating-promises`.
- **kilde's hot layer** (derived resources, `connect`, `toPromise`, async
  states) is rewritten on ramme in kilde, as tasks and values on a
  factory's node (D6′).
- **Reference counting** is a pool of size one with a delayed close, outside
  the core. Transfer of an entry between owners, a `resolveFrom` option and
  propagated dynamic variables are out of v0.
- **Browsers without AsyncContext** are not supported, except through a
  build-time `async`-to-generator transform; there is no Zone-style
  polyfill.

---

## 10. Design laws

1. **Acquisition is ownership.** Whatever a body acquires is attached to a
   node before the acquisition returns; that node releases it, whether the
   body returned, threw or was interrupted. A body may release early; it
   never writes cleanup as control flow.
2. **The ambient node is the default; name a node only to mean another.**
   The free functions act on the current node; the same operations as
   `Context` methods exist for acting on behalf of another.
3. **Async context propagation is required.** The current node reaches
   across `await` only through the platform.
4. **Interruption stops work; it never requires cleanup.** An interrupted
   body's next managed await never settles; its node's stacks are released
   by the runtime. Interruption is delivered to the whole subscribed
   subtree at once; completion propagates up.
5. **What code attached is released before what DI provided.** Explicit
   stack, then provided stack, each in reverse order. Nothing is promised to
   references that escaped their scope except that use fails loudly.
6. **No bare callbacks, no bare promises for work.** Every asynchronous hook
   is a fiber; anything that should be a node is a task, which can only be
   forked or called. `Symbol.asyncDispose` is the interop contract, and the
   core runs it as a fiber.

**Invariants.** I1 single owner. I2 a node completes at most once; each
entry's release runs at most once. I3 explicit before provided. I4
unsubscribed entries hear late. I5 LIFO, fixed positions. I6 frozen is
final. I7 after completion every operation throws. I8 between delivery and
completion every synchronous operation works. I9 marked before heard. I10
no unhandled rejections. I11 consumed once or surfaced. I12 aborted is not
failure. I13 state decides. I14 every release is a fiber, current while it
runs. I15 synchronous attachment. I16 nothing runs in a creation frame. I17
placement follows dependencies. I18 every creation-time read is `inject`.
I19 decisions are permanent and placement is by view. I20 fork is
asynchronous. I21 the current node is the default owner. I22 escape fails
loudly. I23 every acquisition is releasable early. I24 only resolution
attaches to the provided stack. I25 no bare callbacks. I26 a lent node
rejects body-shaped use. I27 fibers are not awaitable; tasks are not
callable. Each has a named test in `src/invariants.test.ts`.

**Assumptions.** A1 async context propagation is present. A2 abandoned
promises are collectable. A3 the platform has `AbortSignal.any`/`timeout`,
`Symbol.dispose`/`asyncDispose`, `AggregateError`, `Promise.withResolvers`
(`SuppressedError` is shimmed where missing). A4 one copy per realm. A5
factories are synchronous. A6 dependencies are acquired before their
dependents (by construction for DI values; by discipline for fibers and
values' releases). A7 bodies do not use `finally` or `using` for cleanup.
A8 bodies pass `signal()` on or use managed awaits often enough to freeze
promptly.
