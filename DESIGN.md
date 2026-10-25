# ramme — Design

**One tree for services and work.** Dependency injection, structured
concurrency and resource lifetimes in one structure, so that a node is at
once a *resolution scope* (what `lookup`/`inject` see), an *execution scope*
(what ambient code runs inside) and a *lifetime* (what is released together).

This document describes the library as it is: the model, its rules and
its guarantees. It says *what*; the *why* and the rejected alternatives are
in [DECISIONS.md](DECISIONS.md), cited as `D<n>`, and the code says *how*; a
prime (`D1′`) marks an entry one of the two redesigns rewrote: the lifecycle
and concurrency redesign, or the generator runtime (D41). The guarantees
G1–G4 are defined in §2.5, the contracts C1–C8 in §2.6, and the design laws,
invariants I1–I26 and assumptions A1–A7 in §10. User documentation is the
README, which covers application code: the first API tier (§1.3) and a few
tier-2 names in passing.

---

## 1. What ramme is

> **ramme is one tree of nodes, where a node's position answers both what
> it may depend on and when it dies; ancestors outlive descendants, and you
> resolve only from ancestors, so everything you can resolve outlives you.**
> (D1′)

The tree holds services (DI values that attached something) and work
(fibers), as README's request handler shows ([README](README.md#a-request)).
It is not a registry of objects: most objects are plain values, and a
*resource* is an entry a value has placed on a node, a property of the
relationship rather than of the object (§2.6).

### 1.1 Position in the stack

ramme has no runtime dependencies. kilde (signals, streams, channels) is the
reactive library for ramme applications: it depends on ramme and is written
in its idiom; ramme never imports kilde (D6′).

### 1.2 Entry points

| Subpath | Contents |
| --- | --- |
| `ramme` | nodes, tasks, the ambient free functions, ops, DI, topics, errors |
| `ramme/result` | the `Result` helpers (`success` … `collect`, and `$`, which unwraps one in a body; §4.13) |
| `ramme/platform` | the platform's waits and callbacks as ramme spells them: `fetch`, `listen`, `nextFrame`, `each` (§4.9, D43) |

There is nothing to import or register: the current node is §6's
synchronous slot, on every platform (D41 decision 18). The one module with
a side effect is the floor's guard, which defines `Symbol.dispose` and
`Symbol.asyncDispose` where a runtime lacks them (`sideEffects` in
package.json names exactly that file); the floor is A2 (§10).

### 1.3 Two API tiers

| Tier 1: application code | Tier 2: resource and library authors |
| --- | --- |
| `task`, `fork`, `call`, `attempt`, `join`, `result`, `all`, `race`, `settle`, `lookup`, `own`, `release`, `shield`, `signal()`, `sleep`; `fail`, the fourth exit, an expected failure typed `E` on the task (§4.13, D42); `Result`, with its helpers and `$` in `ramme/result` (§4.13) | `unshield`, the hole in a `shield` (§4.2); `own(fork(…))`, `pool`, `interrupt: 'observe' \| 'restore'`, `childrenOnExit` |
| generator bodies (§4.2, §4.5): `function*` and `yield*`; `Op`; `wait`; `promised` for a library's async callback; `ramme/platform`'s `fetch`, `listen`, `nextFrame` and `each` (§4.9) | `Operation`, to type a helper that is only `yield*`ed (`Operation<T, E>`), and `Instruction` and `Fail`, for `Generator<Instruction \| Fail<E>, T, unknown>`, the type of a helper a body returns and of an annotated body |
| `inject` in constructors; `static readonly scope`; `createRootContext`; `await using`; `child()`, `abort`, `close` | `own(value, release)`; `releaseAll`; `current()`; `ctx.own` on behalf; `owner.outcome` |
| `t.bind`, `t.with`; the `name`, `signal`, `onFailure` and `providers` options; `createInjectionKey`, `valueProvider`; `aliasProvider`, the seam (an interface key or a test fake bound to an implementation that keeps its own scope); `Public` | `interrupted`, `never`, `wait(p, { abandon: true })`, `releaseTimeoutMs`, `stallWarningMs`, topics, `ctx.run`, `runSync`; keys with default factories (§8) |

The **work verbs**, whose op is lazy (§4.2), are `call`, `attempt`, `all`,
`race`, `settle`, `shield`, `unshield`, `join`, `result`, `sleep`,
`interrupted`, `never` and `wait`; the **lifecycle verbs**, which are eager,
are `release`, `releaseAll`, `close` and `[Symbol.asyncDispose]`.

---

## 2. The node tree

### 2.1 Anatomy

Every node is a `Context`. A node has a **parent**, which is both its
resolution parent and its owner, the node that releases it and waits for
its completion (D1′; an auto-hoisted value's node gets its parent at
placement, §3.3); an `AbortSignal`; optionally a body; an **explicit
stack** of what code attached to it; a **provided stack** of the nodes of DI
values that resolution placed on it; a state; and an outcome.

| Member | Meaning |
| --- | --- |
| `id`, `name` | process-unique id; `opts.name`, a fiber's task name; for the release fibers, `release:<entry>` for an entry's, `shield:<task>` for a shield, `unwind:<node>` for a halted body's unwind fiber (§4.2) |
| `state` | `pending` → `running` → `settling` → `releasing` → `complete` (`pending` only for a DI value's node before placement) |
| `signal` | fires when the node is delivered (§4.1) |
| `outcome` | `undefined` until settling, then `success` / `failure` / `defect` / `aborted` (§4.12) |
| `parent` | the resolution parent: `undefined` on a root (and on a value's node released unowned, §3.3); a value's storage node (§3.3); a release fiber's owner (§2.4); the node a `fork`, `call`, `child` or pool was made on. Readable in every state but `pending`, after completion included (tree shape does not change); `PendingNodeError` on a pending value node (§3.3; D33) |
| `scopes` | the scopes this node carries (read-only) |

Options (`NodeOptions`): `name`, `providers`, `scopes`, `interrupt`
(`'freeze'` default, `'observe'`, `'restore'`), `childrenOnExit`
(`'interrupt'` default, `'await'`; D18), `timeoutMs` (delivers a
`TimeoutError` to this node), `signal` (delivers when it fires),
`releaseTimeoutMs` (the deadline of this node's release fibers; inherited;
none by default, D21), `stallWarningMs` (default 5000; inherited; `0` or
`Infinity` disables) and `captureAutoScoped` (default `false`; for
harnesses and isolation boundaries: when set, nothing auto-hoisted for a
requester at or below this node is cached above it, §3.3, which clamps
placement and never changes resolution). Millisecond options are validated
at construction.

An **entry** is what a stack holds. A *node entry* is a child node (a
fiber, a `child()`, a pool, a DI value's node); its release is `abort()`
or `close()` followed by waiting for its completion. A *passive entry* is
anything else: an `AsyncDisposable` or `Disposable`, or the release that
`own(value, release)` or `own(deferFn)` builds. It has no signal or state
of its own, and its release is one call of its dispose.

### 2.2 The three bits (D19, D20)

Nodes differ in three independent bits, plus a `kind` tag (`context`,
`fiber`, `pool`, `release`, `value`) used for errors and events.

| Bit | Values | Decided by |
| --- | --- | --- |
| **Yields a value** | fiber (`Fiber<T>`) / not | `fork`/`call` vs everything else |
| **Subscribed** | hears the parent's interrupt at body exit (work) / at its turn in the release loop (infrastructure) | `fork`/`call`/`child` vs `own(node)`/`pool`; a DI value's node is never subscribed |
| **Interruption** | `freeze` (applied, forwarded) / `observe` (delivered only) / `restore` | the `interrupt` option |

### 2.3 Node kinds by construction

| Constructor | Kind | Stack / subscribed | Body | Notes |
| --- | --- | --- | --- | --- |
| `createRootContext(opts)` | context | root | no | the only free constructor; carries `RootScope`; `[Symbol.dispose]` throws |
| `child(opts)` | context | explicit / yes | no | a request scope |
| `call(t, …)` / `t.call(…)` | fiber, joined | explicit / yes | yes | starts synchronously at its `yield*` (§4.6) |
| `attempt(t, …)` / `t.attempt(…)` | fiber, joined | explicit / yes | yes | as `call`; resolves with the outcome (§4.5) |
| `unshield(t, …)` | fiber, joined | explicit / yes | yes | as `attempt`, inside a shield; also linked to the signal of the shield's owner (§4.2) |
| `fork(t, …)` / `t.fork(…)` | fiber | explicit / yes | yes | starts in a microtask, or after placement in creation; with `call`, handlers, workers, sessions |
| `own(fork(t, …))` | fiber | explicit / **no** | yes | an owned fiber (§2.6 C5): a reaper |
| `pool(opts)` | pool | explicit / no | no | its forks are its subscribers (§4.10) |
| a DI value's node | value | **provided** / no | no | auto-hoisted: pending until placed; declared: live from the start (§3.3) |
| a release fiber | release | none (transient) | yes | §2.4 |

`own(node)` on one of this node's own subscribed entries flips it to
unsubscribed; its stack entry stays where it is. Code cannot attach to the
provided stack; only resolution does.

### 2.4 Completion and release

When a node's body settles (a bodiless node: on `abort()` or `close()`, or
at its turn in its parent's release loop, below; a delivered body after it
has unwound, §4.2):

1. **Signal.** Under `childrenOnExit: 'interrupt'` (the default, D18), and
   always after `abort()`, the subscribed subtree is delivered in this tick,
   as each mode forwards (§4.1). A natural body exit delivers with an
   `OwnerInterrupt` reason and does not mark the exiting node itself. Under
   `'await'`, or on `close()`, nothing is fired.
2. **Release the explicit stack, LIFO**, once its unwind fiber and every
   shield it started have completed (§4.2). A subscribed node entry is mostly a
   wait (it gets `close()` under `'await'`/`close()`); an unsubscribed one
   (an owned fiber, a pool) is aborted at its turn, which is the first
   thing it hears.
3. **Release the provided stack, LIFO.**
4. **Complete.** The node leaves its owner's stack, after its unwind fiber
   and every shield it started have completed, one started during the
   release phase included (§4.2); its cache, providers and decided markers
   (§3.4) are dropped; its completion (what `close()` and
   `[Symbol.asyncDispose]()` wait for) resolves.

The loop re-reads the top of the stack at every step, so an entry pushed
while the node is releasing (an `own` from a release, a value placed by a
release fiber's `lookup`) is released next. A bodiless node, or one whose
body has not started, whose every release is synchronous completes
synchronously inside `abort()`; a started body is unwound by the
interruption (§4.2), so its node completes after the body has settled, jobs
later. A bodiless subscriber that a delivery reaches below a `freeze` or
`restore` body it interrupts (a `child()` scope of that body, or one below
it) is not exited by that delivery: its signal fires, and it is released at
its turn in its parent's release loop, after the body has settled, because
the body's halted `finally`, a `promised` callback's and its shields may
still use what the scope owns. An explicit `abort()`, `close()` or `Symbol`
dispose method of the scope itself still exits it at once. An entry keeps
the position it was attached at (I5, which names the two exceptions): an
early release removes it without moving the others.

**One release.** Each entry is released inside a **release fiber**: a node
of kind `release` whose parent is the owner, whose signal is a fresh
`AbortSignal.timeout(releaseTimeoutMs)` (or never fires), in `observe`
mode, on no stack (D3′), and runs the entry's release (§2.1; C4, C6, C7).
The release fiber is the current node while the release runs, so inside
any release, ramme-native or foreign, `signal()` is the deadline, `own(...)`
attaches things that live as long as the release, `lookup` resolves through
the owner, and `owner.outcome` (captured at acquisition) is readable: the
outcome is fixed at settling. The deadline, when it fires, delivers the
release fiber as a linked signal delivers any node (§4.1), a shield and a
halted body's unwind fiber (§4.2) included, each `observe` (§4.3). Nothing
is abandoned (D21).

### 2.5 What the order guarantees (D16)

- **G1** Anything code or its descendants read from a node's provided values
  stays alive until every explicit entry on that node has completed, unless
  the value's own node is aborted first: by an owned or `'link'` fiber
  forked on it that fails (§2.6 C5, §4.7), or by an `abort()` through a
  reference to it (a `current()` kept from the constructor). Its entries are
  then released at once, and a later cache hit throws `NodeCompletedError`
  (§4.12).
- **G2** Explicit entries release in reverse attachment order: dependency
  order iff a fiber uses only what was attached before it was forked.
  *Discipline:* acquire before you fork what uses it.
- **G3** Provided values release in reverse creation order, which is
  dependency order because `inject` runs during creation. *Discipline:* a
  value's release, and a value's owned fibers, use only what the value
  injected or reads through its own node.
- **G4** Interruption reaches the whole subscribed subtree at once, except
  below an `observe` node that has not exited, a running body or a bodiless
  node before its exit (§4.1); nothing waits for a sibling.

**Not guaranteed:** order among subscribers during step 1 (the *sibling
rule*: a subscriber must not depend on a sibling subscriber's liveness
during its cleanup; anything it needs then must be unsubscribed and
attached earlier, or a provided value); anything about a reference that
escaped to a longer-lived scope, except that use fails loudly (§2.7).

One wiring error breaks the order: providing a body-owned resource on the
same node points a dependency from the provided stack into the explicit
stack, so the provided value outlives what it uses.
`ramme/no-owned-provider` flags it (§9).

### 2.6 Ownership

**`own` and `release`.** `own(x)` attaches to the current node; `ctx.own(x)`
to a named one. The overloads are the contract (`own(resource)` for an
`AsyncDisposable` or `Disposable`; a node itself), and two sugars that wrap
it: `own(value, release)` and `own(deferFn)`. Every overload returns what
it attached; attached values must be objects so that `release(x)` finds the
entry by identity. `own(x)` with one argument on a passive object this node
already owns is a no-op that returns `x` (D16); `own(x, release)` for it is
`AlreadyOwnedError` (a second release). A child node is already an entry on
its owner's explicit stack, so `own(node)` attaches nothing: it makes a
subscribed child unsubscribed (§2.3), and a second `own` of it is
`AlreadyOwnedError`. There is no bare detach and no transfer of an entry
between owners (D1′).

```ts
const owner = current();
const tx = own(yield* wait(db.begin()), (tx) =>
  owner.outcome === undefined || owner.outcome.status === 'success' ? tx.commit() : tx.rollback());
```

Released early (`release(tx)`) or at a successful completion it commits;
under `aborted`, `failure` or `defect` it rolls back.

**The same as a DI service (D33).** A unit of work that a request's code
shares is a value declared per request (§3.1): README's `UnitOfWork`
([README](README.md#services-that-hold-state)), whose names this section
uses. Its entries are on its own node, which settles `aborted` when its
owner's turn aborts it (§2.4), whatever the request did, with
`OwnerInterrupt` or, when the request was interrupted, the request's own
reason, when that turn is what ends it (a `close()` through the kept
`current()` ends it earlier, `success`). So that node's outcome answers the
wrong question, and its release reads the outcome of the node storing it,
its `parent`, not its own node's.

*Precondition.* The node that carries `RequestScope` must be the request's
fiber, so that its outcome is the request's result: `task(function* (req)
{ … }, { scopes: [RequestScope] })`, or, for an existing task `handle`,
`fork(handle.with({ scopes: [RequestScope], … }))`. The idiom does not apply
to a bodiless `child({ scopes: [RequestScope] })`, which reports how it was
ended, not how its work ended (§4.12): under `await using` (§2.7) every unit
of work on it rolls back, and after `close()` every one commits, even when a
`call` on it failed and the error was caught.

*`acquire()` is synchronous*: `acquire(owner: Context = current()): Lease`
hands out a lease and attaches it to the current node, the value's node. A
field initializer cannot wait for the `Promise<Lease>` of the producer form
below (D26), so the idiom, and its LIFO order, need the synchronous form.
An asynchronous variant takes the lease at first use with `this.#node` as
its owner and registers the `own(this, …)` entry after it, so that LIFO
still commits before the connection is returned. `commit` and `rollback`
are generator methods, which the release fiber drives (`Release<T>` is
`(value: T) => void | Promise<void> | Operation<void, unknown>`, §4.5).

*What the release sees.* `o === undefined` means the entry is released while
the request still runs, in one of two ways. Either it is released without a
signal: through `uow.done()` (`#node.release(uow)`), or through `close()` or
`releaseAll()` on the kept `current()`, none of which aborts the value's
node, so the unit of work commits (a free `release(uow)` from the request
body throws `NotOwnedError`, C7: the entry is on the value's node, not the
request's). Or the value's own node was aborted first (G1, or a `Symbol`
dispose method, which aborts first, §2.7, called through a kept
`current()`), whose signal has then fired, so it rolls back. In every other
case (§2.4, §4.12) a value's release sees the outcome of the node storing it
as decided at settling, and a G1 abort after the request settled reads that
settled outcome. The release phase may later amend the outcome with release
failures and unconsumed child failures, folded in at completion (§4.12,
D16), which the release does not see; so a request body that returns while a
`'join'` fork it never joined has failed still commits.

`releaseAll()` releases the entries on the node's explicit stack at the time
of the call, top down and one at a time: each release finishes before the
next starts, and an entry released meanwhile by something else is skipped.
The provided stack is untouched and the node stays open. It rejects with the
one release error, or an `AggregateError` when several failed (§4.12).

**Contracts.**

- (C1) `own` is synchronous; the entry is registered before it returns.
- (C2) `own` on a delivered-but-incomplete node succeeds.
- (C3) `own` on a complete node throws `NodeCompletedError`.
- (C4) A release runs exactly once per entry, in a release fiber, after
  everything above it on its stack and (for provided entries) after the
  whole explicit stack; the one exception is a failure handler's hold
  (§4.7).
- (C5) An owned **fiber** that settles with `failure` or `defect` while its
  owner is open aborts the owner. One that settles with `success` is removed.
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
uses the method form, `acquire(owner: Context = current()): Promise<Lease>`,
which calls `owner.own(lease)` before it returns.

**Early release, `finally` and `catch`.** A body may release anything it
attached at any time; an interrupted body is halted (§4.2), which is no
error. A sync `using` disposal runs on `return()` too; `await using` is not
legal in a generator. Neither a `finally` nor `using` is the idiom for what
the body acquired: ramme cannot see what a `finally` cleans up (no events,
no early `release(x)`, no inspector row, no release order against the
node's entries), and a halt cuts a `finally` reached by normal completion
and suspended at the delivery, so a resource, and an invariant that must
hold after the body ends, belongs to an entry: `own(x)`, `own(() => …)`. A
`catch` sees real errors only (§4.12).

### 2.7 Lifecycle operations and use after release

| | Signal | Waits | Rejects with |
| --- | --- | --- | --- |
| `abort(reason)` | yes | no | — |
| `close()` | no | subscribers naturally, then both stacks | unconsumed failures |
| `[Symbol.dispose]()` | yes | no; the owner's completion waits | — (throws `TypeError` on a root) |
| `[Symbol.asyncDispose]()` | yes | completion | unconsumed failures; for a fiber, as `join`: its own failure, or `FiberAbortedError` when its outcome is `aborted`, as it is for a `freeze` or `restore` fiber that had not settled. Waited on by an interrupted body, it is release work only for a node strictly below that body; on the body's own node, an ancestor or an unrelated node the body is halted at once (§4.2) |

These four are idempotent on a complete node. `close()` on a fiber waits for
its body and then releases without a signal; an `abort()` arriving first
wins. `close()` on a bodiless node closes its subscribed children
recursively and aborts its unsubscribed ones at their turn. `await using`
ends a node the way an exception would, by interruption; to drain, call
`close()` (D3′, D41 decision 32). `await using` is legal where plain async
code holds a node, at the top level, in a test or a framework's lifecycle
hook, and not in a body, where `own` attaches the same `AsyncDisposable`.

| Operation | Before delivery | Delivered, not complete | Complete |
| --- | --- | --- | --- |
| `lookup` / `get` | works | works | `NodeCompletedError` |
| `own`, `release` | works | works; released at completion | `NodeCompletedError` |
| `fork` / `call` / `child` / `pool` | works | works; a subscribed child is delivered at birth iff the parent would forward to it (§4.3); `pool.fork` throws `PoolClosedError` (§4.10) | `NodeCompletedError` |
| a `yield*` of an op (§4.2) | settles | the body is halted as the op's shape says (`freeze`, `restore`; release work and `wait(p)` finish first) / settles (`observe`) | `NodeCompletedError` |
| a released resource's handle | — | — | resource-defined; should throw |

### 2.8 The parent/child contract

A parent gives anything on its stacks resolution (§1), a signal (§2.2,
§2.4), waiting without abandonment (§2.1, D21), order (G2, G3, I3), one
release (C4), `parent.outcome` during your release (§2.1, §2.4), a routed or
collected failure (§4.12) and a node to release in (§2.4). An entry gives a
`[Symbol.asyncDispose]()` whose synchronous prefix delivers its signal and
whose promise settles at its completion (§2.7), idempotence (§2.6, §2.7), a
readable `state`, `outcome` and `signal.aborted` (§2.1), use after
completion that throws (I7), a single owner (I1) and **finishing** (§4.2,
A7). The parent promises to wait forever; the child promises to finish. A
child that does not is reported (`node:stalled`, §5).

---

## 3. Dependency injection

### 3.1 Keys, providers, scopes

An `InjectionKey<T>` is a class, a function, or a token made by
`createInjectionKey(name, { factory?, scope? })`; a class or function key,
and a token with a `factory`, is its own **default factory**.
`setDependencies(target, ...keys)` declares constructor or function
arguments. Providers (`valueProvider`, `factoryProvider`, `classProvider`,
`aliasProvider`) bind keys on a node, at construction (`providers` on a
`child()`, a task's options, a pool or `createRootContext`) or later
(`addProvider`), and **a provider lives where it is registered**: its value
is stored on that node, whatever the key declares as its scope (D36). A
`Scope` is a name nodes carry (`scopes`), made by `createScope(name)`; scope
is a property of a key's own default: a scoped key's default stores its
value on the nearest node carrying that scope, and a key that declares
nothing is auto-hoisted (§3.3). A key's scope is declared at the key (D32),
as README's `SessionCache` declares `SessionScope`
([README](README.md#services-that-hold-state)).

A class or function key declares its scope with its `scope` property, read
as JavaScript reads any static: a subclass inherits its base's
declaration, and `static override readonly scope = X` re-declares it. The
value is a declaration only when it is a `Scope` made by `createScope`
(checked by identity, not shape). `undefined` (what `static scope?: Scope`
with no initializer emits) and a function (a static method named `scope`,
such as an ORM's `Model.scope()`) are ignored; any other value is a
`TypeError` naming the key, at every read of the key's scope: resolution,
the shadow checks of §3.4, and provider registration (`child({ providers })`,
`addProvider`), which validates the key's scope although a provider never
uses it. `setScope(key, scope)` is the form for a key you do not
own (a third-party class, a function), including one whose unrelated static
`scope` member would otherwise be refused; the registered scope wins over
the property, and `setScope` on a key that already declares a scope, own or
inherited, is a `TypeError` (two declarations). A token takes
`createInjectionKey(name, { scope })`.

**The helpers.** `valueProvider(key, value)`, `factoryProvider(key, factory)`
and `classProvider(key, Impl)` (or `classProvider(Class)`) state a
placement: the value is built on the providing node at the first resolution
through it, and stored there. `classProvider(Key, Impl)` therefore ignores
`Impl`'s own `static scope`. `aliasProvider(key, target)` is a **redirect**:
from the providing node down, resolving `key` resolves `target` instead, by
`target`'s own rules (an explicit provider for it on the path, its declared
scope, auto-hoisting), from the base of the walk that found the alias
(§3.3), and nothing is cached under `key`. It binds a key to an
implementation whose own declaration should govern placement: a root
`aliasProvider(Cache, SessionCache)` gives each session its own
`SessionCache`, a target declaring `SelfScope` gives each creation its own,
and an auto-hoisted target lands at its deepest dependency as if injected
directly. Chains of aliases are followed; a cycle is
`Circular dependency detected: A → B → A`, whether it is all aliases or
passes through a creation (a class target that injects the alias key again).

**Providers are checked against the public surface (D37).** A helper takes
what it is given (a value, a factory's result, a class, an alias target) as
`Public<T>`: `T`'s public members (`keyof T`, which leaves out `private` and
`#private` ones), what a consumer of `inject(T)` can reach. Functions, topic
receivers, classes, `any` and `unknown` pass through unchanged, and `T` is
inferred from the key alone. So a test fake of a class with `#private`
fields needs no cast, while a fake that misses a public member, or has one
of the wrong type, does not compile. `inject` and `lookup` still return `T`.
**An injected value is the key's public surface:** do not brand-check an
injected service (`instanceof`, `#x in v`) or pass it to code that reads its
private members from outside the instance; on a fake such a check answers
`false` or throws, and a TS-`private` member reads `undefined`.

`SelfScope` means "per consuming creation, stored nowhere" (or at a node
that carries it) for a key's default and for an alias target; a provider for
a `SelfScope`-declared key is stored at its node and shared like any
provider (D36), so the per-creation binding is an alias to an implementation
that declares `SelfScope`. `RootScope` is on every root; `RequestScope` is
the conventional per-request scope, attached explicitly to the request's
fiber (§2.6) or to a bodiless `child()`. Topics are keys too (§5).

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
parent (the decorator pattern). A service that needs runtime borrows for
its *own* lifetime keeps `#ctx = current()` from its constructor and reads
through it; borrows for a *call's* lifetime use the ambient `lookup` in the
method.

### 3.3 Creation, the value's node and auto-hoisting (D7)

Resolving `K` walks from its base `R` upward: the first cache hit or
provider answers. The base is the requester for `get`, `lookup` and an
auto-hoisted factory's `inject`; the storage node `S` for a
declared-placement factory's `inject`, which resolves from `S`; and the
parent for `skipSelf`. An alias answers from that same base (§3.1), so a
factory on the root that injects an alias to a session-declared target
fails as one that injects the target would, with no session above the root.
A value has a **declared placement** when a provider or a scope says where
it is stored: a provider is a declared placement at its own node, and a
key's scope is a declared placement for the key's default, on the nearest
node carrying the key's scope. A key with no provider but a default factory
is **auto-hoisted**: its factory runs in a **creation frame** (§6) that
records every `inject` into a dependency tracker, and the value is stored on
the deepest node that served one of its dependencies (clamped by the nearest
`captureAutoScoped` node, §2.1), so a value is never cached above a node
whose values it consumed, and sharing is as wide as the dependencies allow.
Tracked reads decide placement only for auto-hoisted values; a value with a
declared placement stays where it was declared.

**When to declare (D32).** Inference is right for stateless and derived
services and wrong for state (README): a service that holds state for one
session, request or other unit declares its scope (`static readonly scope`,
§3.1), and a requester with no node of that scope above it gets the error
of any scoped key without one. Everything else is left to inference.

The value's **own node** is excluded from tracking (D4′):
`inject(ContextKey)`, or `current()` in creation, returns it. It is created
when the factory first needs a current node: at the first `current()`,
`signal()`, `own`, `release`, `releaseAll`, `fork`, `pool`, `child`,
`promised` or `inject(ContextKey)`. A factory that calls none of them leaves
its value without a node. An auto-hoisted value's node is **pending** until
placement: it accepts `own`, `release`, `releaseAll`, `fork`, `pool` and
`child`, while `parent`, `get`, `addProvider`, `call`, `join`, `result`,
`interrupted`, `never`, `sleep`, `wait`, `run`, `runSync` (§4.11), `abort`,
`close` and the `Symbol` methods throw `PendingNodeError`, so an
auto-hoisted factory cannot read its placement (D33). At placement its
parent becomes the storage node `S`, it is pushed on **`S`'s provided
stack**, unsubscribed, and the forks made in the factory start. A
declared-placement value's node is never pending: `S` is known before the
factory runs, so the node is created live on `S`'s provided stack (its
`parent` is `S` from its first use, and reading it does not affect
placement), and when the creation ends it moves to the top of that stack,
above the dependencies the factory injected after the node was created
(D27). This is the one time an entry changes position. Placement into a node
that is already releasing (a release fiber's `lookup` created the value)
pushes it on top, so it is released next, before the values it depends on;
placement into a complete node throws `NodeCompletedError`.

A factory that throws has its node's explicit stack released, caches
nothing, and rethrows; the next resolution runs the factory again. A
pending node is first placed at the requester (or the nearest open node
above it), which is then its `parent`, waits for that release and collects
its failures; when the factory completed the whole tree there is no such
node, and the value's node is released unowned, with no `parent`. A
declared-placement value's node is released where it is, on `S`. A
factory returning `undefined` is `FactoryReturnedUndefinedError` (a
`CreationViolationError`). Circular `inject` chains throw `Circular dependency detected: A → B → A`, including
re-entry through a release the factory started. A fork made in a
constructor with the default `'join'` destination (§4.7) and not owned
fails the resolution (D14). Factories are synchronous (A4, D26).

### 3.4 Permanent decisions and placement by view (D10′)

**Decided markers.** When `R` resolves `K`, every node on the walk, from `R`
up to and including the one that answered, marks `K` *decided*, whether the
answer was a value or "not provided here". If the answer was an
auto-hoisted value `V`, the same nodes also mark every key in `deps(V)`,
its recorded dependencies (below). `addProvider(K)` at `C` throws
`PlacementError` iff `K` is decided at `C`. A fresh child has no decisions,
so providing at construction is always allowed. A key's scoped default,
created at its scope owner, decides the key on the whole walk, from `R` up
to the root, as a miss does: the provider search already walked to the root
without finding one, and a provider added above later would serve `R`'s
descendants values built from another view of the key. An alias that
answered decides its key from `R` up to the alias node; the walk that
resolved its target marks the target.

**Placement by view.** When `R` finds auto-hoisted `V` cached at `S`, a
node from `R` itself up to, but not including, `S` is a **shadow** if it
provides a key in `deps(V)` or carries the declared scope of one that no
provider at or above `S` serves (`SelfScope` aside). A key such a provider
serves has no scope to shadow, since a provider places where it is
registered, and no scoped default of it is cached below one (the marker
above); an alias's target is in `deps(V)` and is checked on its own. A
shadow changes `R`'s view of that dependency, so the
cache is not `R`'s answer: `V`'s factory runs from `R`, and the result is
placed by `R`'s view and memoized there, on the deepest node that serves
one of its dependencies as `R` sees them (clamped as in §3.3). That node,
`S′`, is `R` itself when `R` provides the shadowed key, and otherwise lies
at or below the shadow; every requester at or under `S′` with the same view
shares the value. With `A` provided at `P` and at `C`, and `B` injecting
`A`: whichever of `C.get(B)` and `P.get(B)` runs first, the tree ends with
`B@C` (the `B` cached at `C`) built from `C`'s `A` and `B@P` built from
`P`'s; a sibling of `C` without the override shares `B@P`.

`deps(V)` is recorded at creation: the keys `V` injected (an optional miss
included: "not provided" is part of `V`'s view, though no node served it),
plus the `deps` of each injected auto-hoisted value; declared-placement
values contribute their key only. An `inject` that reaches an alias also
records the alias keys on the redirect chain and the final target, whether
the target resolved or missed, and `V` is never stored above the deepest
alias node on the chain, as it is never stored above a provider it read
from; with the alias at or above the target's placement (the root,
typically) `V` is placed exactly as if it injected the target. A value built
from a requester-relative read (a per-creation `SelfScope` value, a
`skipSelf` read) is **pinned**: it is placed at its requester and served
only to a requester at that same node, so any other requester, a descendant
included, builds its own. Pinning carries through an injected auto-hoisted
value that is itself pinned; declared-placement values are never pinned
(D25). What this gives: no node ever changes an answer it has given; no
requester is served a value built from a view of its dependencies other than
its own; both hold in every order of resolution, for auto-hoisted factories
that inject the same keys on every run (below).

**An auto-hoisted factory must inject the same keys on every run.** A
re-creation forced by placement by view runs the factory from `R` with the
keys its first run injected itself in hand: its own reads, misses and
`skipSelf` reads, not the `deps` those reads brought in, which a shadow may
legitimately change (an override that serves a dependency as a value where
the first run got an auto-hoisted one, or a per-creation `SelfScope` one,
with dependencies of its own, or that replaces an alias). A per-creation
dependency's reads run through `V`'s creation but are among those `deps`,
not `V`'s own. If this run injects a different set of keys itself,
the resolution throws `PlacementError` naming the key and both sets, the
new instance's node is released, nothing is cached, and the answer at `S`
is untouched. With equal sets each shadowed read lands at or below its
shadow, so the re-run lands at or below the shadow, never on a node that
already caches the key (D7).

### 3.5 Creation is pure

An op reads the slot when it is made (§4.2), so the body-shaped verbs refuse
a creation there: making an op of a work verb (§1.3) in a factory throws
`CreationViolationError`, before any node is touched, and so do `runSync`
and entering any other node as current. On the value's own node, `run` and
the other body-shaped methods throw `PendingNodeError` while it is pending
(§3.3) and `CreationViolationError` once it is live. The lifecycle verbs
(§1.3) do not, so a factory may release early, and `own`, `fork`, `child`,
`pool` and `promised` act on the value's node (`promised` runs nothing when
it is made). Running in a creation what was made outside it is refused too:
a work op's `then`, or a `promised` callback called there, rejects with
`CreationViolationError` and runs nothing (one already running is only
waited for, I16). `fork` on a live node passed in from outside is allowed
(it starts in a microtask); a creation ends when its factory returns, so a
continuation the factory scheduled runs with no creation frame. A late read
on a value's node that *creates* a value (after construction) warns once per
key per root in development mode (§4.4, D4′).

---

## 4. Interruption and fibers

### 4.1 The signal

`node.abort(reason)` delivers to `node` synchronously and top-down along
subscription edges, as each mode forwards (§4.3; below an `observe` node
that has not exited, the rest hear when it exits, §2.4), in two passes:
first the whole subscribed subtree is marked delivered, with the reason,
then signals fire, then each suspended body's driver is told, which halts
it as its wait says (§4.2), and bodiless nodes exit. **Every node of a
delivery is marked before any listener runs** (D16), so a listener on any
of them sees all of them delivered. What an `observe` node held back is a
later delivery's: a bodiless `observe` node exits in the second pass and
delivers the rest of its subtree then, after the first pass's listeners
have run. Unsubscribed entries hear their signal at their turn in the
release loop. Marking and firing release nothing; a node starts releasing
when its body exits. A bodiless node, or a fiber whose body has not
started, exits in the second pass; a started body's halt is a job, never
run inside `abort()`; when each completes is §2.4's.

A node's own `abort()`, `timeoutMs` and linked `signal` always deliver to
it. The default reason is an `AbortError` `DOMException`; `timeoutMs`
delivers a `TimeoutError`; a parent's body exit delivers `OwnerInterrupt`.

### 4.2 The driver and the halt (D13′, D41)

*Interruption is an instruction to stop all work except releasing what was
acquired.*

A body is a **generator function** the runtime steps, or a synchronous
function, run in one step (§4.5); every wait is a `yield*` of an **op**, and
the body ends in one of §4.12's four ways. The driver sees every wait, so an
interruption never travels as an error: a delivered `freeze` or `restore`
node's body is **halted**, its generator's `return()` called at the `yield*`
where it waits. Its `catch` blocks never see the interruption, its `finally`
blocks run (a helper's included, innermost first), and nothing after that
`yield*` runs; a `finally` in the body's own generator function may wait,
and what it yields is release work, which the interruption does not cut
(below). README's `transfer` is the example
([README](README.md#waiting-and-what-an-interruption-does)).

**Ops.** Every waiting verb returns an `Op<T>`: an `Operation<T>`
(`[Symbol.iterator](): Iterator<Instruction, T, unknown>`), run by `yield*`,
and a plain thenable (`then` only, no `catch` or `finally`, no `Promise`).
`yield* op` is its `T`. A generator helper's `Generator<Instruction, T,
unknown>` is an `Operation<T>` too, run with `yield* helper(…)`;
`Operation<T>` annotates a helper that is only `yield*`ed. The iterator
yields an opaque `Instruction` once, never the op, so `yield op` without
the star is a type error in a body (and a `TypeError` at run time, below).

- **Work ops are lazy** (D41, decision 2): a work verb's op (§1.3) runs
  nothing when made. The driver runs one at its `yield*`, for the yielding
  body, synchronously (§4.6); `yield*` of the same op object runs it afresh
  each time, as a description (decision 3); `wait(fn)` calls `fn` then. An
  op nobody consumes runs nothing, so a forgotten `yield*` is missing work
  (§4.4), never an unhandled rejection (I10).
- **The lifecycle verbs are eager** (§1.3): they start their work when
  called (C7, D16) and return an `Op<void> & Promise<void>` that only waits;
  every consumer, `yield*` or `then`, waits for the same completion, and
  `.catch` and `.finally` work. A `then` consumes a failure as a work op's
  does (below).
- **Construction reads the slot** (decision 17): a free-function op is
  `current().verb(…)` evaluated when it is made, so its receiver is fixed and
  its **guards** run then: the receiver is not complete
  (`NodeCompletedError`), not pending (`PendingNodeError`), no creation is
  current (`CreationViolationError`; `lookup`, `get`, `call`, `attempt`, the
  groups, `shield`, `unshield`, `run` and `runSync` also refuse a release a
  factory started, §3.5), and `sleep`'s `ms` and `unshield`'s shield are
  checked. Outside any frame a free-function op throws `NoCurrentNodeError`
  when made: `const pause = sleep(50)` at module level is illegal; make the
  op where it is yielded. What fails when the op runs lands at the `yield*`,
  or rejects the `then`: `wait`'s function returning no promise, a source
  whose `then` throws (a `Promise` subclass that overrides it, I10), a
  receiver completed since (a stored `call`, `attempt`, `join` or `result`
  run after its receiver completed throws `NodeCompletedError`: no wait
  begins on a node after its `node:complete`, §5). `fork`, `child`, `pool`,
  `own` and `release` need no body frame (§3.5), and `fork(t)` or
  `lookup(K)` while an op is made and not yet yielded is fine.
- **The thenable** (decision 4): `await op` from plain async code runs the op
  once per object, on the first `then`, as a child of the node it was made
  through (an explicit receiver, `await app.call(main)`, or an op made in a
  step and handed out; in a halted `finally`, below), and settles with its
  value, or its failure, or `FiberAbortedError` when that child ended
  `aborted`. A promise waiter is a foreign frame, which nothing halts and
  which `then` cannot see, so the step that made the op stands for it: the
  failure is consumed, unless that step's body is halted when the work
  settles. Its `wait(p)` then discards the rejection, so the failure stays
  with its holder and surfaces from its completion, as `promised`'s does
  (§4.5). A plain async function that awaits several,
  `Promise.all([app.call(a), app.call(b)])`, runs them concurrently, each
  through its `then`. A `then` in a creation is §3.5's.

**The driver.** A step is one `next(v)`, `throw(e)` or `return()` on the
body's iterator, run with the body's frame in the slot (§6). The driver
subscribes to the source of each op it runs; the body resumes in the
source's reaction (decision 7): with the op's value, or with its failure
thrown in at the `yield*`, consumed as the op's resume step consumes it. A
yielded value that is neither an op's instruction nor a `Fail` gets a
`TypeError` thrown back at that `yield`. Between the delivery and the halt
the body may run plain code, and everything it does is legitimate (I8).

**The halt.** When it comes depends on what the body waits on (decision 8):

| The body waits on | Halted |
| --- | --- |
| `sleep`, `never`, its own `interrupted()`; a `join` or `result` of a fiber not subscribed below it (an owned fork, a pool's, another tree's); `wait(p, { abandon: true })`; a `close()` or `[Symbol.asyncDispose]()` of itself, an ancestor or an unrelated node; a `release` or `releaseAll` whose wait includes the body | at once: a job queued at the delivery under no frame, never inside `abort()`; a sleep's timer cleared |
| `call`, `attempt`, `unshield`, `all`, `race`, `settle`; a `join` or `result` of a fiber subscribed below it | once the awaited fiber has completed; its resume step does not run, so nothing is consumed and its failure surfaces from its holder (§4.12). A fiber the delivery did not reach (a `ctx.call` child of a node outside the delivered subtree, one below an `observe` node that has not exited, one born undelivered) is delivered then, with the body's reason |
| release work (`release`, `releaseAll`, `close()` or `[Symbol.asyncDispose]()` of a node strictly below it, `shield`); `wait(p)`, `wait((signal) => p)` | not at the delivery: on success it is resumed with the value and halted at its next `yield*`; on failure it is halted there, the failure unconsumed (a release failure surfaces at completion, §4.12; `p`'s own is discarded, as a halted body's throw is, D24) |
| an op not yet started, yielded after the delivery (in the step that delivered the node, by a body resumed by release work, by a body born delivered) | not run: halted there (a `call` made then makes no child). A started one (a `wait(p)` over a promise, a lifecycle op) is subscribed, and the rows above decide |

`attempt`, `unshield`, `settle` and `result` on an interrupted caller never
resolve with an outcome: the caller is halted, so `aborted` in an outcome
keeps meaning the awaited work's own abort (§4.5, §4.8).

A body born delivered (§4.3) is stepped to its first `yield*` of an op not
yet started and halted there without running it (decision 9). A return at
such a `yield*` is a job too, as at the delivery, never inside the step, so
a fork made just before the halt starts first.

**An applied waiter consumes nothing** (the table's third row; §4.12, D24),
and the waiter read is the one resumed, when it is resumed: an aborted fork
waiting on its live parent's `release(x)` leaves the failure to the parent,
and a shield, never applied, that waits on its interrupted body's
`release(x)` consumes what it catches.

A **source** is what an op's run waits on (a node's completion, the end of an
entry's release, a node's delivery, a timer); ramme's never reject, so no op
the core makes is an unhandled rejection, consumed or not (I10). The **resume
step** runs only when a consumer is actually resumed, and is where an awaited
value is produced and a failure is *consumed*.

**The halted `finally`.** After the halt every `yield*` is in a `finally`.
At the halt the driver makes the body's **unwind fiber**, a release fiber of
the node (§2.4), which the tree never delivers: only its own deadline does.
The driver goes on stepping the generator with the node current (U3,
decision 11):

- `current()`, `signal()`, `lookup`, `own`, `release`, `releaseAll`, `fork`,
  `child` and `pool` address the node, so `finally { yield* release(tx) }`
  finds the body's entry; a `fork` there is born delivered, and `signal()`
  has fired.
- The ops the `finally` yields run for the unwind fiber, and one made through
  the node (the free functions, `current().call(…)`, made before the halt or
  after it) runs on it; so does one made there through the node and run by
  its `then` (`yield* wait(Promise.all([call(a), call(b)]))`, an async helper
  waiting for an op made there), whose failure the `then` consumes and the
  `wait(p)` records, once. A `call`, an `attempt`, a group, a `wait`'s
  function or a `promised` callback made there is not born delivered, and
  only the deadline reaches it (§2.4). `wait((signal) => p)` there is
  handed the unwind fiber's signal, which the deadline fires, and so are
  `fetch` and `nextFrame` (§4.9); a rejection the deadline causes is a
  release failure (below).
- The resume steps consume nothing: a failure is thrown into the `finally`,
  which may catch it, and still folds into the outcome once, as a release
  failure: from an entry's release (`release(tx)`), a child or group of the
  unwind fiber, a shield, or a `wait(p)` whose `p` failed, which the driver
  records on the unwind fiber. Only `p`'s own failure is recorded, never one
  ramme hands the `finally` (a child's `FiberAbortedError`). A plain `throw`
  from the `finally` is discarded (D24); a `yield* fail(e)` there is
  §4.13's.
- A finally-yield whose wait includes the node's own completion or an
  ancestor's (`current()[Symbol.asyncDispose]()`, `root.release(current())`,
  an owner's `close()`, a `join` of an ancestor fiber), or a `join` or
  `result` of a fiber that only such a completion ends (a fork the node or an
  ancestor owns, `own(fork(t))`, whose body has not ended; `yield*
  release(f)` stops it first; an `observe` fork made in the `finally`, which
  is not born delivered, §4.3, and which only the node's release delivers),
  would wait forever: the generator is returned there instead, with a
  development-mode warning (decision 12). So is `wait(fn)` whose `fn` returns
  such an op. The predicate does not ask whether the fiber would end on its
  own: an `observe` fork there that ends by itself is returned all the same;
  run such cleanup as `yield* call(t)`, release work on the unwind fiber.
- Only the body's own generator function keeps the halt across a yield. A
  `yield*` in a *helper's* `finally` loses it, by the `yield*` algorithm:
  once the helper's `finally` ends, the body is resumed normally and runs
  on, as release work, and the helper's `yield*` gives it the halt's private
  sentinel as its value. In development mode a generator that finishes with
  any value other than the sentinel (a lost halt, or a `return` in a
  `finally`) is reported, naming the body, and so is any use of the sentinel,
  once per halt (decision 29). Waiting cleanup in a helper belongs in an
  entry (`own(value, function* (v) { … })`) or behind `yield* call(helper)`.

**`wait`.** `wait(p)` waits for a foreign promise, which the halt lets
finish (the table's third row), so what `p` produced can still be owned
(README's `transfer`). `wait(p, { abandon: true })` stops waiting at the
halt; `p` runs on. `wait((signal) => p)` calls the function when the op
runs, handing it the signal of the node the op runs on, so the halt aborts
it; a halted body never calls it. `p` exists when the op is made, so a
halted body that yields `wait(p)` still subscribes (the table's last row)
and `p` is marked handled; a promise only ramme holds, the function form's
or the `Promise.resolve` of a thenable that is not a promise, is marked
handled when the op runs (I10). A ramme op as `p`, or as what `fn` returns,
is that op's own wait: its shape decides the halt, its `waitsFor` holds for
decision 12 and for a failure handler's detach (§4.7), and its failure is
its holder's.

**`shield(body, …args)`** and `ctx.shield` run `body` (a `Body` or a `Task`,
with its arguments, as `call` takes them) in a **release fiber** of the
node, not for an entry, as any release runs (§2.4). The waiter is resumed
with the body's value, or its error, which the resume step consumes, except
for an applied waiter (above). The node **holds every shield it ran** (§2.4,
steps 2 and 4), with no ordering against entries already released. A
shield's failure is routed to the node as a `'join'` fiber's is: consumed by
the waiter's resume step, or surfaced from the node (I11). A shield is the
non-cancellable region on the normal path
(`yield* shield(function* () { yield* call(charge); yield* call(record); })`,
D41 decision 13); cleanup after a halt belongs in the body's own `finally`,
which may wait.

**`unshield(t, …args)`** and `ctx.unshield` make a hole in the enclosing
shield. Inside a shield `signal()` is the release deadline, so nothing
started there hears the interruption of the node the shield runs on, its
release fiber's parent (the current node for the free `shield`, `ctx` for
`ctx.shield`): the shield's **owner**. `unshield` is `attempt` (§4.5) on the
node it is made on, whose child is also linked to the owner's signal, as a
`NodeOptions.signal` links a node (§4.1), alongside its task's own `signal`.
The owner is found by walking up from that node to the nearest shield's
release fiber, past calls, forks, `child()` scopes and an entry's release
fiber, which is not a shield, and taking its parent.

```ts
yield* shield(function* () {
  yield* call(flushBuffer);                         // runs to its end
  const r = yield* unshield(notifyPeer, event);     // the one step the owner's interruption still stops
  if (r.status === 'defect') throw r.error;         // a real failure stays one (notifyPeer yields no fail)
  yield* call(writeOffset);                         // runs to its end, whatever the hole did
});
```

- **It ends when the owner is interrupted.** The owner's delivery fires its
  signal, which delivers the hole with the owner's reason: a `freeze` or
  `restore` hole is halted, and once it has unwound `unshield` resolves
  `{ status: 'aborted', reason }`; an `observe` hole hears it through
  `signal()` and `interrupted()` and runs on, its outcome its own (§4.3). The
  shield's body goes on.
- **It is skipped at once if it already was** (a shield the owner's halted
  `finally` runs): a linked signal that is already aborted settles the child
  `aborted` without running its body (§4.6), whatever its mode.

Outside any shield, on the unwind fiber included (above), there is no owner
to link to: `unshield` throws a `TypeError` when it is made, and `attempt`
is the form there. Nesting composes: a shield inside a hole is a new
region, and a shield inside a shield, or inside a call made under one, runs
on that shield's release fiber or that call's node, which is therefore its
owner; the task's interruption reaches neither, so it neither cuts nor
skips their holes, which only that node's own signal bounds. Under
`ctx.shield` the owner is `ctx`, never the body that ran it.

`sleep(ms)` and `ctx.sleep(ms)` wait `ms` milliseconds, a number in
[0, 2^31 − 1]; anything else is a `RangeError`, thrown when the op is made
(`never()` is the unbounded wait). The timer is armed when the op runs, at
its `yield*` (or its `then`), and the halt (the table's first row)
**clears the timer**. A waiter nothing halts (an `observe` body, a release
fiber or shield, a failure handler, top-level code through `then`) waits
the full `ms`. The timer is armed under an empty frame (§6) and is not
unref'd: a sleep keeps the process alive like any timer. Repetition is a
`fork` that loops on `yield* sleep(ms)` (D34).

`never()` is a wait that never ends: a `freeze` or `restore` body waiting on
it is halted at its delivery; anywhere else it waits forever.
`interrupted()` resolves with the current node's abort reason when that node
is delivered (at once if it already was), and `ctx.interrupted()` with
`ctx`'s; a `freeze` or `restore` body waiting on its own node's is halted by
that delivery instead, so the resolving form is for `observe` bodies (§4.3),
release fibers, top-level code and a body waiting on another node.

### 4.3 Interruption modes and the birth rule (D12, D20)

| | `freeze` (default) | `observe` | `restore` |
| --- | --- | --- | --- |
| Delivered | when the parent forwards, or aborted directly | when the parent forwards, or aborted directly | whenever an ancestor on its subscription path is delivered |
| Applied (the body is halted, §4.2) | yes | **no** | yes |
| Forwards to subscribers | yes | **no**, except to `restore` ones | yes |
| Outcome after delivery | `aborted`, whatever the body does | the body's own result | `aborted` |
| Born under an already-delivered parent | delivered at birth iff the parent forwards to it (a delivered `freeze` or `restore` parent; not a delivered `observe` one) | **not** delivered at birth | delivered at birth |

`observe` is the resource author's mode: the body sees the interrupt
(`signal()`, `yield* interrupted()`), runs a controlled shutdown and settles
on its own. `restore` re-opens a cancellable window inside an `observe`
region. `task(fn, { interrupt: 'observe', timeoutMs: 5000 }).call()` is a
critical section with a deadline: at 5 s its `signal()` fires and the body
decides how to stop; nothing ends it if it ignores the signal.

### 4.4 Hazards and diagnostics

A halted body unwinds only as far as its waits let it: one waiting on a
`wait(p)` whose `p` never settles, one whose halted `finally` waits for a
driver that never answers (a `ROLLBACK` on a dead connection), and one that
runs plain code without yielding are never returned, and their node, every
owner above it and the root's `await using` shutdown wait. Foreign library
code is invisible throughout. The mitigation is diagnostic: `node:stalled`
when a delivered node (any mode) has not settled within `stallWarningMs`;
`releaseTimeoutMs` delivers every release fiber, and abandons nothing
(§2.4). So give such cleanup a driver-level timeout, or hand the driver the
deadline: `wait((signal) => db.rollback({ signal }))` in a halted `finally`
is handed the unwind fiber's. Release fibers are nodes, so a stuck release,
a long shield, a slow halted `finally` (its unwind fiber) and a draining
`close()` show up the same way.

**Unbounded work in a halted `finally`.** A `call` there of an `observe`
task that waits for its own interruption (`yield* interrupted()`) never
ends: `root.abort()` stops at the node, delivered already, and only
aborting that task ends it.

**Plain code after a halted `wait(p)`.** The halt lets `p` finish, and the
body runs on from that `yield*` to its next one: a debounced
`show(yield* wait(img.decode()))` shows a stale result. Guard such code with
`signal().aborted`, or wait with `{ abandon: true }` (§4.2).

**A forgotten `yield*`.** `call(sendEmail, user);` sends nothing, silently
(§4.2). `ramme/no-unused-op` flags a work verb as an expression statement
(§9); an op kept in a variable and never yielded is not flagged, nor is a
`fail(e);` or a `$(r);` without its `yield*`, which ends nothing: the body
runs on past it, and the error never joins the task's `E` (D42).

**A shared promise.** A promise made from an op's `then` is a plain
promise: shared between bodies (a memoized loader), it hands its rejection
to every body that waits on it, so one failure fails each of them, and an
expected failure arrives thrown, as a defect (§4.12).

**A platform timer.** A `yield* wait(new Promise((r) => setTimeout(r, ms)))`
in flight at the interruption is let finish, so the body resumes when the
timer fires and its node, with everything attached to it (a connection
lease), stays alive for the rest of the wait. `sleep(ms)` is the form the
halt cuts, its timer cleared (§4.2, D34); `ramme/no-timers` flags
`setTimeout`, `setInterval`, `setImmediate` and `requestAnimationFrame`
(whose replacement is `nextFrame`, §4.9) in every file (§9).

**Development mode** is on unless `process.env.NODE_ENV === 'production'`,
and always on where `process` does not exist (D30). It adds `AsyncRunError`
(§4.11), the `console.warn` on a late read that creates a value (§3.5;
declare it with `inject` instead), decision 12's warning and the lost-halt
report (§4.2).

### 4.5 Tasks and bodies (D8′, D31)

A body is a generator function (§4.2), and a task is its definition:

```ts
function* parse(req: Request): Generator<Instruction, Order, unknown> { /* … */ }  // a helper: shares the caller's node
const handle = task(function* (req: Request, res: Response) { /* … */ });           // a task: a new node per run

yield* parse(req);                        // plain call, same node
yield* handle.call(req, res);             // new child node, joined
yield* handle.attempt(req, res);          // the same, resolving with the outcome instead of throwing
handle.fork(req, res);                    // new child node, concurrent
yield* call(function* () { /* … */ });    // inline task: block scope for temporaries
fork(function* () { /* … */ });           // inline task: ad-hoc concurrency
```

`task(body, opts)` returns a `Task`: `name`, `fork(...args)`,
`call(...args)`, `attempt(...args)`, `with(opts)` (the same task with
per-use option overrides) and `bind(...args)` (fixes the whole argument
list, giving the `Task<[], T>` that `all`, `race` and `settle` take;
arguments later passed to its `fork`, `call` or `attempt` are ignored). A
`Task` is an object, not a function: invoking it is a `TypeError` at compile
time and at runtime. Options (`TaskOptions` = `NodeOptions` + `onFailure`)
live at the definition. Anything that should be a node (handlers, jobs,
workers, sessions; anything whose temporaries must be released on return, or
that must be separately interruptible or visible) is a task; everything else
is a function. A function that acquires temporaries either releases them
before returning or is a task.

**Bodies.** `task`, `fork`, `call`, `attempt`, `shield`, `unshield`, the
members of `all`, `race` and `settle`, `pool.fork` and `promised` take a
generator function, or a synchronous one. An `async` function is no body
(D41, decision 5): `Body`'s type refuses its promise, and the runtime fails
the node with a `TypeError` naming `function*`, every node kind but an
entry's release fiber. The runtime decides by what the body returned: an op
is driven as the body's own `yield*` of it, in its frame, so
`task(() => call(leaf))` and a body returning a helper's generator work
(decision 28), and so is a `fail(e)` (D42), so a release or a handler that
returns one fails as one that yields it does; a generator object is driven;
a thenable is refused; an `async function*` is refused; anything else is the
value. A generator's own return value is a value: `return yield* op`, never
`return op`. A release may be a generator function or return an op
(`own(tx, function* (tx) { … })`), driven in its release fiber, and so may a
failure handler (§4.7). A release or a failure handler may still return a
promise (a foreign `[Symbol.asyncDispose]()`, `async (x) => x.close()`): it
is waited for as a bare wait, and it is current only until its first
`await`: one that uses ramme after it throws `NoCurrentNodeError`, and that
is its release failure or handler exception.

**`promised(t)`** turns a body into a library's async callback:
`db.transaction(promised(function* (tx) { … }))`. It captures the current
node when it is made, which must be where the slot is set (a step,
`node.run(fn)`); `ctx.promised(t)` names one, for a module-level entry point.
Each call of the returned function runs `t` as a call-shaped child of that
node: a subscribed `'join'` fiber, started synchronously. It returns a real
promise of the value, rejected with the child's failure, which it consumes
unless the node is a halted body (whose throw is discarded, so the failure
stays with the node and surfaces at its completion), with
`FiberAbortedError` when the child ended `aborted`, or with
`NodeCompletedError` once the node has completed; during a creation, §3.5.
The node's interruption reaches the child as it reaches a callee (§4.2;
README's `save`). Made in a halted `finally`, it captures the unwind fiber
and runs as release work.

A `Fiber<T, E>` is a node with a body yielding an outcome. It is not
thenable: `await fiber`, `Promise.resolve(fiber)` and `Promise.all([fiber])`
reject with `FiberNotAwaitableError`; use `join(f)` (the value; an expected
failure re-yielded, a defect thrown) or `result(f)` (the four-way outcome,
never the failure propagated; an interrupted waiter is halted as §4.2
says). A body that returns a fiber fails with `FiberNotAwaitableError`.

**`attempt`** is `call` with `result`'s resume step, as `call` is `fork`
plus `join`. `attempt(t, …args)`, `ctx.attempt(t, …args)` and
`t.attempt(…args)` make the child `call` makes and resolve with its four-way
`Outcome<T, E>` instead of its value: a `failure` or a `defect` is delivered
as a value and consumed on resume, never propagated (D42). As for `call`,
the child runs as a `'join'` fiber whatever its task's `onFailure`. A
`freeze` or `restore` caller that is itself interrupted is halted (§4.2) and
never sees an outcome, so `aborted` reports the child's own delivery: its
`timeoutMs` or `signal`, an explicit abort of it, or the abort of a receiver
that is not the awaiting body. The exception is a `restore` child, which
hears every delivery on its subscription path (§4.3): an `observe` caller is
never halted, so its own interruption reaches such a child and comes back as
`aborted` with the caller's reason, and so does an `observe` ancestor's,
which a `freeze` caller below it does not hear. An `observe` body that falls
back on `aborted` checks `signal().aborted` first; a `freeze` body below an
`observe` ancestor, whose `signal()` has not fired, tells the child's
deadline by its reason, the `TimeoutError` `DOMException` that `timeoutMs`
delivers (an ancestor's interruption carries one only when it was itself a
deadline). It is the shape of a deadline with a fallback, where a real
failure is rethrown, as the `catch` it replaces would: README's
`fetchPrices` ([README](README.md#errors-you-will-meet)).

`result(fork(t))` reads the same outcome but starts the body a microtask
later. An outcome nobody inspects is a failure dropped silently (D31).

### 4.6 Start semantics (D22)

- `call` and `attempt` start the body synchronously at their `yield*`, with
  the child current, before the yielding step returns; so do `all`, `race`
  and `settle` for their group fiber, whose members are forks. Through
  `then` (top-level code, an explicit receiver: `await app.call(main)`)
  they start when `then` is first called, a job after the `await` is
  evaluated (§4.2).
- `fork` **never** runs any part of the body in the forker's frame: it
  starts in a microtask, or after placement when forked during creation.
  The body sees its own node as current from its first line, never a
  creation frame, and `own(fork(t))` takes effect before it starts.
- A body cannot tell whether it was forked or called.
- A fiber aborted before its body started settles `aborted` without running.

### 4.7 Failure destinations (D14, D23)

```ts
type FailureDestination = 'join' | 'link' | ((error: unknown, fiber: Fiber<unknown, unknown>) => void);
```

| Destination | On `failure` or `defect` | Use |
| --- | --- | --- |
| `'join'` (default) | held for `join`/`result`/`asyncDispose`; if unconsumed when the parent completes, surfaces from the parent's completion | fork now, join later |
| `'link'` | aborts the parent immediately; surfaces from the parent's completion | helpers the parent cannot continue without; owned fibers (C5) |
| handler | called once, at completion, with the final failure and the parent current; the parent waits for a promise it returns | supervised background work; pools |

An `aborted` outcome fires no destination. An expected failure is routed as
a defect is (D42): held for a joiner, whose `join` re-yields it; `'link'`
aborts the parent with it, and the parent surfaces it from its completion as
its own `defect`, since a parent cannot be handed a typed failure it did not
declare; a handler receives it, its `error` parameter `E | unknown` (which is
`unknown`), and tells the two apart by `fiber.outcome.status`. `fork` with the
default `'join'` onto a live bodiless node that is not a pool (`root.fork(t)`,
`child().fork(t)`) throws `TypeError` at the call; pass `onFailure`, fork
from a body, or use a pool.

A handler runs with the parent current, so `lookup`, `own`, `fork`, `child`
and `pool` act on the node whose lifetime the handler's work shares, but it
is not the parent's body. A generator handler is driven in the handler's
frame and never halted: the parent's delivery leaves its waits (§4.2). It
may `call`, `attempt`, `settle` or `shield` through the parent at any time.
A handler, or the op it returns, holds the parent open until it ends,
and a promise it returns (an `async` handler, a bare wait, current only
until its first `await`) until it settles; a failure or a rejection, like a
synchronous throw, is collected with the parent's release failures (§4.12).
While that hold lasts and the parent's stacks are otherwise empty, the
parent's release loop takes only node entries: a fork, `call`, `child` or
pool the handler attaches is released as soon as it is attached, and passive
entries and values attached meanwhile wait until the hold settles. A node
entry can therefore be released before a passive entry attached above it,
the one exception to C4's order. A generator handler, or a returned op, that
waits for the completion of its parent or of an ancestor holds nothing from
then on, so `onFailure: () => app.close()` shuts the app down instead of
waiting for itself; an `async` handler's waits are invisible, so one that
awaits such a completion holds the parent forever.

### 4.8 `all`, `race` and `settle` (D28, D31)

All three run the tasks as subscribers of a fresh child fiber, the *group*
(a `call`; `opts` apply to the group):
`all([fetchUser.bind(id), fetchOrders.bind(id)])` resolves with the tuple of
values in order, and rejects with an `AggregateError` of **every** real
failure; `aborted` members are excluded from it, and an aborted member with
no failure rejects with `FiberAbortedError`. `race` resolves with the first
`success`, aborts the rest and waits for them; with no success it rejects with an
`AggregateError` of the failures (or `FiberAbortedError` if every member was
aborted); `race([])` is a `TypeError`. Members always run as `'join'` fibers
of the group, whatever their own destination.

An expected failure fails `all` as a defect does (D28, D42), once every member
has completed, and every failure is reported: when one member failed, and by
an expected failure, that failure is re-yielded, so `all`'s `E` is the union
of its members' (`Op<[User, Order], UserNotFound | OrderNotFound>`); with a
`defect` among the members' failures, or two failures or more, the
`AggregateError` of every real failure, expected ones included, in task
order, is thrown, a defect, since one `Fail` can be yielded and none may be
dropped. A body that branches on each member's expected failure uses
`settle`. `race` takes the first success, which an expected failure does not
beat; with none, `all`'s rule decides, and its `E` is the union too.

`settle` is `all` that resolves with every member's outcome instead of
rejecting. `settle([fetchUser.bind(id), fetchOrders.bind(id)])` waits for
every member as `all` does, aborting none on a sibling's account (D28), and
resolves with the tuple of their outcomes in order (`SettleResult`:
`[Outcome<User, UserNotFound>, Outcome<Order[], never>]` for a `fetchUser`
that fails with `UserNotFound` and a `fetchOrders` that has no `fail`);
`settle([])` resolves `[]`. Failures and aborts are values, so a member
never rejects the `settle`: each member's failure is held, unconsumed, by
the group's parent (the receiver) rather than by the group, whose outcome
stays its own, until `settle`'s resume step consumes it and delivers it as
that member's outcome, unless the caller is halted on it (§4.2). When the
group itself is delivered (its own `timeoutMs` or `signal`), it forwards to
the members still running as any node does (§4.1, §4.3). A member the group
never forked reports `aborted` with the group's reason: every member, when
the group was aborted before its body ran. Either way the tuple resolves:
the caller is alive. A member's `aborted` is thus its own delivery or the
group's, or, as for `attempt` (§4.5), an `observe` caller's or ancestor's
interruption reaching a `restore` member or group. `settle` rejects only
with a failure of the group's own, such as a value provided through
`opts.providers` whose release threw, or a member's fork that threw (an
invalid option on its task, refused when its node is built), and then hands
the resumed caller every failure once, in the shape `all` rejects with: the
group's error alone, or a `SuppressedError` of it over an `AggregateError`
of the failures of the members it had forked, which are consumed with it. A
fork that throws does so in the group body's first step, before any member
it forked has started (forks start in a microtask, I20), so those are
aborted unstarted and the group's error comes alone (D41: the group bodies
are generators).

### 4.9 The platform layer (`ramme/platform`, D43)

**Every platform primitive that waits or calls back has a ramme spelling.**
A wait is an op, which a halt can stop (`yield*` of a bare promise is
TS2488); a callback re-enters its node synchronously, and an entry the node
owns removes the registration; an async iteration is `each` (`for await` is
TS1103 in a generator); and a lint refuses the bare form (§9). The layer is
the subpath `ramme/platform`, built on the public core alone (§7), and it
reads the platform's globals when its ops run. Timers are the core's `sleep`
(§4.2), and a callback that expects a promise is the core's `promised`
(§4.5).

| Platform | ramme |
| --- | --- |
| `fetch` | `yield* fetch(input, init)`, the global's parameters: a `wait` whose function calls `globalThis.fetch` with `init` and a signal combining the caller's own (a `Request` input's signal, `init.signal`) with the one the wait hands it, the body's `signal()` (in a halted `finally` the unwind fiber's deadline, so cleanup can still fetch). A `Request` input keeps its signal, `referrer` and `referrerPolicy`, which a non-empty `init` would replace or reset (the Fetch standard's `Request(input, init)`). A halt aborts the request; the wait finishes, by its rejection, and the body is returned (§4.2's third row), the `AbortError` discarded |
| `addEventListener`, an emitter's `on`/`off`, `on*` properties | `listen(target, type, handler, opts?)`: the handler runs synchronously inside the node current at registration, as `node.run` does (`current()`, `lookup`, `own`, `fork`, `child`, `signal()`, `preventDefault()`; nothing waits: it forks a task, which reports by the node's destination rules, so a bodiless node's fork names `onFailure`, D14). A generator or `async` handler is a `TypeError`. Every call is its own registration, as an emitter's `on` is: the same handler listened twice runs twice per event, where `addEventListener` registers one `(type, callback, capture)` once. Removed at the node's delivery through the native `{ signal }` (an `AbortSignal.any` of the node's signal and `opts.signal`; on an emitter, or a target that ignores `signal` such as ws's `WebSocket`, by removal at the signal's `abort`), and at an end without one (`close()`, a natural exit) by its entry; `opts.signal` and `once` remove it early with its entry; an event that reaches it after the delivery (an emitter's call of a listener removed during the same `emit`, an earlier listener of the node's signal dispatching) is dropped; a node already delivered, or an `opts.signal` already fired, registers nothing. A throw from the handler never reaches the target: it aborts the node, the error as the reason, and is the entry's release failure, so the node ends `defect(e)`, as a `'link'` child's failure ends it; when the handler ended its own registration first (`close()`, `abort()`, `releaseAll()`, its `opts.signal`), that release waits for the handler to return and fails with its throw. An event dispatched during a creation runs no handler: `node.run` refuses the frame (I16), and its `CreationViolationError` goes to the dispatcher, as a bare listener's `node.run` would throw it, so the creation fails, never the registering node |
| `requestAnimationFrame` | `yield* nextFrame()`, the frame's timestamp (a 16 ms timer where frames are absent): a halt returns the body at once and cancels the frame; an `observe` body, which no halt returns, has the wait rejected with the reason at its delivery (where `sleep` runs its full duration, D34) |
| `for await` | `for (const x of yield* each(source)) { …; yield* each.next(); }`: `yield* each(source)` waits for the first item and is a synchronous iterable over the current one, and `yield* each.next()` waits for the next item of the innermost loop. When the body leaves the loop early (`break`, `return`, a throw, a `fail`) or is halted in it, the source's `return()` is called once, as release work: the loop is an entry the node owns, and the loop iterator's `return()` releases it, an eager `release(x)` that calls the source's `return()` at once; nothing is waited for inside that `return()` (decision 29): the node waits for the entry's release, and completes after it; a `return()` that fails is the node's release failure. An exhausted source, or one whose read failed, is never returned. A halt stops waiting for a read at once, and the release then returns the source; an async generator queues that `return()` behind a read in flight, so a read not handed `signal()` holds the node until it settles (`node:stalled`). A pass that skips `each.next()` throws a `TypeError` at the loop's head, and the source is returned |

### 4.10 Pools (D15)

```ts
interface PoolOptions extends NodeOptions {
  name: string;
  onFailure: (error: unknown, fiber: Fiber<unknown, unknown>) => void;   // required
  concurrency?: number;                                          // default unbounded
  whenFull?: 'wait' | 'reject';                                  // default 'wait'
}
```

A pool is an unsubscribed bodiless node; its forks are its subscribers and
always report to `onFailure`, an expected failure as a defect does (D42).
`pool.running` counts the forks the pool has admitted (started, or due to
start in their start microtask) and not yet completed, never its release
fibers, values placed on it or passive entries; `pool.pending` counts queued
ones. With `concurrency` reached, `'wait'` queues the fork and `'reject'`
throws `PoolFullError`. A fork frees its slot at completion, before its
failure reaches `onFailure`. Intake stops at the signal: `pool.fork` throws
`PoolClosedError` once the pool is delivered or `close()` was requested,
`NodeCompletedError` after completion. `close()` drains the queue (waiters
start as slots free); `abort()` cancels it (queued forks settle `aborted`
without running).

### 4.11 `run` and `runSync`

`ctx.run(fn)` makes `ctx` current for a synchronous `fn`: the way code with
no current node enters the tree, and the way a test makes a node current. A
returned promise throws `AsyncRunError` in development mode (§4.4): it would
be current only for the synchronous part. `runSync(fn, …args)` is `child()`,
`run`, and `abort()` on exit: synchronous block scoping whose synchronous
releases have run when it returns. A fork made in `fn` never starts: the
exit abort settles it `aborted` unstarted (§4.6), and on the bodiless child
it needs `onFailure` (§4.7). A body `fn` started synchronously (a `promised`
callback called in `fn`, suspended on a `yield*`) is halted by that abort
instead, jobs later, so the child completes after it (§2.4, §4.2). `run`
returning a generator throws `AsyncRunError` too (nothing would step it); an
op it returns is a value, which runs nothing until it is consumed.

### 4.12 Outcomes and errors (D17, D24, D38, D42)

**Four statuses (D42).** A node's `Outcome<T, E>` is one of four, which
`attempt`, `result`, `unshield` and `settle` deliver as values:

| Status | How the body ended | Typed |
| --- | --- | --- |
| `success`, `value` | it returned | `T` |
| `failure`, `error` | it yielded `fail(e)` (or `$` of a failed `Result`, or a callee's failure re-yielded): an expected failure, one a caller is meant to branch on (§4.13) | `E`, the task's, inferred |
| `defect`, `error` | it threw: handled at task boundaries (`attempt`, `onFailure`), where a `catch` translates it, never used as domain control flow | `unknown` |
| `aborted`, `reason` | it was interrupted, decided by state (D24) | `unknown` |

An expected failure is yielded, never thrown, so no `catch` sees it (§4.13),
while a defect is thrown at the `yield*`, where a `catch` may take it. An
interruption is neither: another node's reaches a caller as `aborted` from
`attempt`/`settle`, or thrown as `FiberAbortedError` from `call` (or as a
foreign operation's `AbortError` when that operation was handed `signal()`);
the caller's own halts it, which no `catch` sees (§4.2). `Outcome` minus
`defect` and `aborted` is `Result<T, E>` (§4.13), so `attempt` on a task
returning a `Result` yields `Outcome<Result<V, F>, E>`, two layers read with
one vocabulary.

Every node's outcome is computed at settling and decided by state, never by
inspecting the error: a `freeze` or `restore` node delivered before its body
settled is `aborted`, whatever the body produced, including when its halted
`finally` returned a value; an `observe` node's outcome is its body's
result; a bodiless node is `success` on `close`, `aborted` on `abort`.
Delivery after settling changes nothing. A yielded `Fail` fixes `failure` at
the fail, before its `finally` blocks run, so a delivery while they run
changes nothing either; a body already delivered when it yields one is
halted there instead, the error discarded as its throw would be.

The release phase amends the outcome once, aligned with `await using`, and
always to a `defect`: a release failure is a thrown-class thing, never the
task's typed `E` (D42). With `R` the release failure, or an `AggregateError`
of two or more:

| Body outcome | Amended, with release failures `R` |
| --- | --- |
| `success`, or a bodiless node | `defect(R)` |
| `failure(e)` | `defect(SuppressedError(R, e))`, release-primary |
| `defect(d)` | `defect(SuppressedError(R, d))`, release-primary |
| `aborted` | `defect(R)` |

What the `finally` a halt or a fail runs fails with (a failed wait there, a
`fail` there, and after a fail a throw) is such a release failure (§4.2,
§4.13); so is what surfaces from the node's completion unconsumed (below), a
subscriber's expected failure included. An early `release(x)` or
`releaseAll()` whose release throws rejects that call (§2.6); if its awaiter
was applied (an interrupted body, which is handed the error but consumes
nothing, §4.2), or never awaited, the error surfaces from the owner's
completion instead. An owner whose releases end while the caller is still
waiting completes only once the caller has been resumed, so the error is
reported exactly once (D16). The call counts as awaited from its creation
until its awaiter is resumed; a call whose releases all succeeded is never
waited for, and a failing call nobody awaits holds its owner for at most two
microtasks, after which its error goes to the owner's completion. A caller
that first awaits after the owner completed sees the error again, as any
second `join` does.

At completion a node collects its own failure or defect, every unconsumed
subscriber failure (fibers, child contexts, pools and value nodes alike; an
entry's release fiber's failure is collected only as its entry's release
failure, while a shield's is routed like a `'join'` fiber's, §4.2; a
`settle` member's is held by the group's parent instead, §4.8), every
owned-fiber failure and every early-release failure that no resumed awaiter
received. A fiber's final outcome then goes to *its* destination; a
context's or pool's `close()` and `asyncDispose()` reject with it. A failure
is consumed at most once: by the resume step (§4.2) of a `join` (or `call`),
`result`, `attempt`, `unshield`, `settle`, `shield`, `asyncDispose` or
`close`, or by the parent surfacing it, whether it is delivered as a value
or propagated (D31).

| Error | Thrown when |
| --- | --- |
| `NoCurrentNodeError` | a free function, or a free-function op when it is made, outside any node: at top level, or in plain async code after its first `await`; the message names the cause (ramme has no async context) and the three entry points (§6) |
| `NodeCompletedError` | any operation but the lifecycle four on a complete node; a cache hit on a released value; placement into a complete node |
| `PendingNodeError` | a refused operation on a value node before placement (§3.3) |
| `NotOwnedError` | `release(x)` of something this node does not own; `own(node)` of another node's entry |
| `AlreadyOwnedError` | a second release for one object on one node; `own(node)` of an already-owned node |
| `FiberNotAwaitableError` | awaiting a fiber; a body returning a fiber |
| `FiberAbortedError` | `join`/`call`/`all`/`race` of an aborted fiber by a waiter that is not itself halted; an op awaited through its `then` whose child ended `aborted`; a `promised` callback's aborted child; `[Symbol.asyncDispose]()` of an aborted fiber (it aborts first, §2.7), including a halted body's release-work dispose of a fiber below it (§4.2); `.reason`. `result`, `attempt`, `unshield` and `settle` report `aborted` as an outcome instead. A halted body never sees one for its own interruption, which is `return()` |
| `PoolClosedError`, `PoolFullError` | pool intake after the signal or `close()`; at capacity with `whenFull: 'reject'` |
| `CreationViolationError` | `lookup` or a body-shaped operation during creation; `inject` outside creation; `get(ContextKey)` |
| `FactoryReturnedUndefinedError` | a factory or provider returned `undefined` (a `CreationViolationError`) |
| `AsyncRunError` | `run(fn)` returned a promise or a generator (development mode, §4.4) |
| `PlacementError` | providing a decided key (§3.4); a forced re-creation whose factory injected different keys than its first run (§3.4) |
| `OwnerInterrupt` | never thrown: the abort reason of a parent's body exit, or of an entry's turn in the release loop; `.owner` |

### 4.13 Expected failures, `Result` and `$` (D38, D42)

**`fail`, the fourth exit.** `yield* fail(e)` ends a body at once with the
outcome `failure(e)`, beside `return v`, `throw e` and the halt: no `catch`
sees it, nothing after it runs, and the driver returns the generator as a
halt does, with the halt's sentinel, so its `finally` blocks run, and may
wait, as release work on an unwind fiber (§4.2), and development mode's
lost-halt report covers a lost return. A callee's expected failure ends the
caller the same way: the resume step of its `yield*` turns it into a `Fail`,
the re-yield. The failure is yielded, so it enters the generator's yield
union, a `Fail<E>` under a brand disjoint from `Instruction`'s, and `task`
reads `E` off that union: `task(body)` is `Task<A, T, E>`, `E` inferred,
never declared, `never` for a body with no `fail`. It is written
`return yield* fail(e)`: TypeScript narrows after a `return`, not after a
`yield*` of `never`. Propagation is `yield*`, as README's `getUser` and
`getOrder` show ([README](README.md#expected-failures)).

`call`, a helper's `yield*`, `join`, `shield` and `wait(op)` re-yield a
child's expected failure into the caller's union, and `all` and `race` as
§4.8 says; `attempt`, `result`, `unshield` and `settle` deliver the four-way
outcome as a value (§4.12). A `then` rejects with the error, and so does a
`promised` callback's promise; a fiber's `[Symbol.asyncDispose]()`, whose op
carries no `E`, throws it at the `yield*`. A fork's expected failure that
nobody joins is routed as §4.7 says. `Fiber<T, E>` carries `E`;
`Outcome<T, E>`'s defaults to `unknown`, `Task`'s and `Fiber`'s to `never`.
TypeScript compares classes by structure, so each error class has a distinct
literal member, without which the union collapses to one of them. `fail`
reads no node: it may be made anywhere, and each `yield*` yields afresh.

A `fail` in a halted `finally` is a release failure (§4.12), recorded on the
unwind fiber (a re-yielded one is already its holder's record), and ends
that `finally`: it cannot change `aborted`, which it amends to `defect(e)`.
A failure handler's generator that fails rejects the handler, a handler
exception (§4.7); what fails in the `finally` its fail runs is reported
beside it, as in a body: `SuppressedError(later, e)`.

**`Result`, the interchange type.** `Result<T, E>` (`Success<T> |
Failure<E>`) is a core type: `Outcome` minus `defect` and `aborted`, the data
an expected failure is where it crosses a boundary a body does not (a
function's or a library's return value, JSON, a message). Its helpers are
free functions in the subpath `ramme/result`, which imports only types from
the core. None is a method, and each works on any plain object of the shape,
so a hand-rolled `{ status, value | error }` needs no adapter.

| Function | Is |
| --- | --- |
| `success(v)`, `failure(e)` | a plain, unfrozen `Success<T>` / `Failure<E>` |
| `isSuccess(r)`, `isFailure(r)` | a type guard on `status` |
| `map(r, f)`, `mapFailure(r, f)` | `f` over the value, or over the error; the other side returned as it is |
| `andThen(r, f)` | the next fallible step: `f(value)`'s `Result`, whose error joins `r`'s |
| `orElse(r, f)` | the recovery: `f(error)`'s `Result` |
| `unwrap(r)` | the value, or the error **thrown**: the named moment an expected failure becomes a defect (Rust's `.unwrap()`) |
| `unwrapOr(r, fallback)` | the value, or `fallback` |
| `fromThrowing(f)`, `fromThrowing(p)` | foreign code fenced: what `f()` returns as a success, what it throws as a failure, whose error is `unknown` because a throw has no type; a function returning a promise, and a promise, give a promise of the `Result`, which never rejects, and are awaited at once (below) |
| `collect(rs)` | the first failure, or every value in order (not `all`: that name is ramme's) |
| `$(r)` | in a body, `yield* $(r)` is the value, or ends the body with `failure(r.error)`, as `yield* fail(r.error)` does (below) |

Every helper takes the inferred return type of an unannotated fallible
function, which has one `Failure` member per error (`Failure<InvalidCard> |
Failure<Insufficient> | Success<Receipt>`), and keeps every error. A member
of the other kind contributes `never`, never `unknown`:
`andThen(r, (v) => success(v + 1))` keeps `r`'s error type, and
`orElse(r, () => success(x))` has error `never`.

**`$`** is the bridge from a `Result` you hold to the body's `E`: a
generator helper whose `yield* $(r)` evaluates to the success value itself,
never awaited (a promise or a fiber included), or yields the failure's error
as a `Fail`, which ends the body with it; a `Success` adds nothing to the
union. It takes a `Result`, not a promise of one: wait for that first,
`yield* $(yield* wait(p))`; anything that is no `Result` is a `TypeError` at
the `yield*`. A task that returns a `Result` succeeds with it, data, and its
caller's `$` turns it back into the caller's own failure:
`const n = yield* $(yield* call(parse, text))`.

For ramme work, use `attempt`, which keeps the four statuses (§4.5).
`fromThrowing` is for foreign code: over an op it runs the op through its
`then`, a promise waiter nothing halts, and reports a child's expected
failure, its defect and its abort alike as a failure of the `Result`
(`FiberAbortedError` for the abort); its `catch` takes every error, and its
promise never rejects. Its promise forms await at once: `fromThrowing(p)`,
and `fromThrowing(f)` whose `f()` returns a promise, call `then` on it a job
after `fromThrowing` is called, so a stored `fromThrowing(join(f))` consumes
`f`'s failure into a `Result` that nothing may then read. A function's
return value is chained only when its `then` is a function. A fiber's `then`
getter throws (§4.5), so a returned fiber is the success, and
`fromThrowing(() => pool.fork(job))` fences pool intake, which `attempt`
cannot: the fiber as a success, or `PoolFullError` or `PoolClosedError`
(§4.10) as a failure. A function whose return type may or may not be a
promise (`number | Promise<number>`) is typed as giving the `Result` or a
promise of it, as the runtime does. One typed `any` or `unknown` is typed
synchronously, whatever it returns: give it its return type, or fence the
promise itself.

Deliberately absent: a class or methods on the data, `match`, `tap`,
`Option`, and a scope of its own for the `?` operator (D38, D42).

---

## 5. Observability (D29)

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
| `node:settled` | the body settled (an interrupted one after it unwound), with `outcome` |
| `node:releasing` | `stack`: the release loop entered a stack |
| `entry:registered` / `entry:released` | `entryName`, `stack`; `error` on a failed release |
| `node:complete` | `outcome`; a node's last lifecycle event: only the `join:leave` of a wait begun on it with no body waiting (a `then`, a failure handler's) on a fiber its completion does not wait for can follow it |
| `node:stalled` | `sinceMs` (§4.4) |
| `join:enter` / `join:leave` | `joinedId`, `outcome`: a `join`, `result`, `attempt` or `unshield` waits on a fiber; emitted on the waiting body's node, not on the receiver of `n.join(f)` (on the receiver when no body waits: `then`, a failure handler); a waiter whose resume step does not run (a halted one) emits no `join:leave` |

Release fibers are nodes and emit these events too, so the stream covers
shutdown. A receiver is a sink: it runs synchronously in the emitting frame
and must not use ambient operations; one that throws is reported with
`console.error` and the event is dropped. Without a receiver no event is
built and no stall timer armed.

---

## 6. Ambient state: the current node

The **current node** is the node the running code belongs to: a body's own
fiber, the release fiber during a release, the node `ctx.run(fn)` entered,
or, during creation, the value's own node (§3.3). Every free function is
`current().<method>(...)` (I21; law 2).

There is one mechanism, on every platform, and ramme has no async context
(D41, decision 18): a **frame** (the current node, or a creation, §3.3)
sits in a **synchronous module slot**, which the runtime sets around every
step of a body (§4.2), a creation, a release, a failure handler,
`node.run(fn)`, a `listen` handler and a `promised` body, and restores
after it, so frames nest (a `call`'s first step inside its caller's,
`node.run` inside a step) and none is ever left set. The slot is valid in a
step, in whatever a step calls synchronously (constructors, factories,
`inject`, `own`, `lookup`, a library's synchronous callback), in
`node.run(fn)`, in a `listen` handler and in a `promised` body; it is never
valid after an `await`. ramme runs what it does on behalf of no node inside
a step or a creation (timers, release-loop continuations, the `releaseAll`
loop a factory started) under the empty frame, `NO_NODE`; a release itself,
one a factory started included, runs in its release fiber's frame (I14),
never the creation's. Every reaction and microtask runs after the slot is
restored, so none inherits a body's frame or a finished creation.

**Three entry points for plain async code** (D41, decision 16). There is no
async code under a node: top-level code, a test, a framework's entry point
and a library's callback reach ramme through an **explicit receiver**
(`await app.call(main)`, `await using app`, `root.close()`; an op made
through a node is thenable, §4.2), through **`promised(body)`** for a
library's async callback (§4.5), or, for a synchronous callback, by
re-entering a node: **`listen(target, type, handler)`** for a platform event
(§4.9) and **`node.run(fn)`** for any other (§4.11). A plain async function
sees the node current until its first `await`, and none after it:
`current()`, `lookup` and every free function throw `NoCurrentNodeError`
there, loudly rather than on a wrong node (§4.12). A node it took before the
first `await` still works through its methods
(`const node = current(); await x; node.fork(t)`).

---

## 7. Package layout

The repository is a pnpm workspace. Its root is the `ramme` package, whose
modules, in `src/`, are these; `packages/eslint-plugin-ramme` is the lint
plugin (§9), a separate package that ramme does not depend on and that does
not import ramme. The package's subpaths (§1.2) are `index.ts` (`ramme`),
`result.ts` (`ramme/result`) and `platform.ts` (`ramme/platform`).

| Module | Responsibility |
| --- | --- |
| `context-key.ts` | `InjectionKey`, default factories, key scopes, `setDependencies` |
| `scope.ts` | `Scope`, `createScope`, `SelfScope`, `RootScope`, `RequestScope` |
| `topic.ts` | `createTopic`, `TopicReceiver` |
| `provider-util.ts` | `classProvider`, `factoryProvider`, `valueProvider`, `aliasProvider` (marked as a redirect through `inject.ts`) |
| `context.ts` | public types: `Context`, `NodeOptions`, `Task`, `Fiber`, `Result`, `Outcome`, `Pool`, `Provider`, `Public`, `Op`, `Operation`, `Instruction`, `Fail`, … |
| `result.ts` | the `ramme/result` subpath: free functions over plain `Result` objects, and `$`, a generator helper that yields a held `Result`'s failure as a `Fail` |
| `resource.ts` | the error classes, `SuppressedErrorCtor`, `toDispose` (the `own` overloads into one dispose) |
| `context-storage.ts` | the `Frame` and the synchronous slot: `runInFrame`, `runDetached`, current-frame reads (§6) |
| `disposal-symbols.ts` | the floor's guard: `Symbol.dispose` and `Symbol.asyncDispose` where a runtime lacks them (the one side-effect module, §1.2) |
| `internal-context.ts` | shared internal types: node kinds, cache entries (value, storage node, `deps(V)`, the keys its factory injected itself, pin), resolve results (with the redirect an alias followed), the task brand (the marker that identifies a `Task`), failure records (an error and whether it was consumed), and the type machinery that reads a body's `E` off its yield union (D42) |
| `stack.ts` | `Entry`, `Stack`: the two stacks, fixed positions, LIFO release order |
| `managed.ts` | ops (§4.2): the lazy `WorkOp` and its thenable, the eager `LifecycleOp` (a `Promise`), the iterator and its `Instruction`, a run's source, resume step and halt shape, the subscription (`Sub`), `sleep`'s timer; the `Fail` record `fail` yields and the resume step's signal for a child's expected failure (D42) |
| `driver.ts` | the driver of generator bodies (§4.2): the step in the node's frame, the run and subscription at `yield*`, the halt rows (§4.2), the halted `finally` on the unwind fiber, the lost-halt report; a failure handler's generator |
| `node-impl.ts` | `NodeImpl`: every node; delivery, body, release loop, release fibers, `shield` and `unshield`, placement hooks, lifecycle, `fork`/`call`/`attempt`/`all`/`race`/`settle`, the ops' runs and their halt predicates, events |
| `pool.ts` | the pool's concurrency queue and intake rules |
| `inject.ts` | `inject`, `ContextKey`, creation state, dependency tracking, the resolution walk, alias redirects, decided markers, placement by view, the value node's creation and placement |
| `fiber.ts` | `task()` |
| `ambient.ts` | the free functions: `current`, `signal`, `lookup`, `own`, `release`, `fork`, `call`, `shield`, … |
| `lifecycle-events.ts` | `NodeEvent`, `NodeTopic` |
| `create-context.ts` | `createRootContext` |
| `index.ts` | the public surface |
| `platform.ts` | the `ramme/platform` subpath (§4.9): `fetch`, `listen`, `nextFrame`, `each`, over the public surface |

Runtime import graph (type-only imports not shown; no evaluation-order
cycles): `scope`, `resource`, `internal-context` and `context` are leaves;
`result` is a leaf: it imports only types from `context`; `context-key` sits
over `scope` (a key's declared scope, D32); `topic` sits over `context-key`,
and `lifecycle-events` over `topic`; `context-storage` is a leaf at runtime;
`stack` and `pool` sit over `resource`; `disposal-symbols` is a leaf, which
`index` and `node-impl` import first; `managed` sits over `context-storage`
and `resource`; `inject` over `context-key`, `context-storage`,
`lifecycle-events`, `resource` and `scope`; `provider-util` over `inject`;
`inject` and `pool` never import `node-impl` at runtime (nodes are created
and placed through methods on the requester); `driver` sits over
`context-storage`, `inject`, `managed` and `resource`, and never imports
`node-impl` at runtime (it drives a node through its methods); `node-impl`
sits over `context-key`, `context-storage`, `disposal-symbols`, `driver`,
`inject`, `internal-context`, `managed`, `pool`, `resource` and `stack`;
`ambient` over `context-storage`, `managed` and `resource`; `fiber` over
`ambient` and `internal-context`; `create-context` over `node-impl` and
`scope`; `index` re-exports; `platform` sits over `index` alone, the public
surface, so the layer can do nothing a user could not. No module either
entry reaches imports a Node module, or reads a global beyond ES2022's but
`queueMicrotask`, `setTimeout`, `clearTimeout`, `AbortController`,
`AbortSignal`, `DOMException`, `console` and, in `platform`, `performance`
(the browser is a target: `check:surface` and src/test/browser-smoke.test.ts
check the build).

### 7.1 Costs

`pnpm bench` (scripts/bench.mjs) times the runtime's common acts against the
build. The numbers are indicative: Node 26.3.0 on one Apple-silicon machine
(darwin arm64), best of five runs, nanoseconds per operation, with
development mode on and off alike to within a few percent.

| Operation | ns |
| --- | --- |
| `yield* wait(Promise.resolve())` | ~190 |
| `yield*` of a settled op (`join(f)` of a completed fiber) | ~210 |
| a `promised` round trip from top-level code: a node per call | ~540 |
| `yield* call(syncTask)`: a node made, its body run, the node completed | ~600 |
| `own(x, release)` and `yield* release(x)` of a passive entry: a release fiber | ~800 |
| `yield* sleep(0)` | ~1,140,000: the platform's timer, clamped to about a millisecond |

A wait costs about a microtask and its bookkeeping: a body resumes in its
source's reaction (D41, decision 7), so a `yield*` of an op that has already
settled costs what a pending one does once it settles. A node made and
completed costs about three waits, and the release fiber in which every
release runs (D3′) about four.

---

## 8. Libraries: keys carry their defaults (D5)

A library that defines a key for its own consumption gives it a **default
factory**, so the library works when the application wires nothing, and the
application overrides by providing the key, as with README's `Mailer`
([README](README.md#tests-and-overrides)). The default is an auto-hoisted
value like any other (§3.3), placed per tree; a test overrides it with a
child's providers or its own root, and placement by view (§3.4) applies to
it. `createRootContext()` installs nothing process-global.

**Every wait and every callback has a ramme spelling.** A library that wraps
a driver or a platform API serves bodies by the rule `ramme/platform`
follows (§4.9): each wait is an op, a generator method that
`yield* wait((signal) => …)`s and hands the driver the signal; each callback
the library registers re-enters the node that registered it (`listen`,
`node.run`); and each async callback the library hands a driver is a
`promised` body (§4.5). Its helpers return ops or generators, which serve
bodies through `yield*`; top-level code runs one through a node it names
(`await app.call(function* () { return yield* lib.query(q); })`). An
exported generator helper names `Instruction`, and `Fail` when it fails, in
its emitted declaration, which is why both are public (§1.3).

---

## 9. What is not here

- **The lint rules** ship in this repository as a separate package,
  `eslint-plugin-ramme` (`packages/eslint-plugin-ramme`, §7; D35), whose
  `configs.recommended` turns all nine on, as errors (D41, decision 14; D43):
  `ramme/no-async-body` (§4.5), `ramme/no-unused-op` (§4.4),
  `ramme/no-unused-outcome` (§4.5, D31), `ramme/no-timers` (§4.4, §4.9),
  `ramme/no-stored-borrow` (§3.2), `ramme/no-owned-provider` (the wiring
  error of §2.5), and the platform rules of §4.9 (decision 26),
  `ramme/no-bare-listener`, `ramme/no-bare-fetch` and
  `ramme/no-bare-async-iteration`, each message naming the `ramme/platform`
  replacement. They are syntactic; the package's
  [README](packages/eslint-plugin-ramme/README.md#rules) states what each
  rule flags and its approximations. Recommended alongside, type-aware:
  `@typescript-eslint/no-floating-promises` (a forgotten `await` in
  top-level code) and `@typescript-eslint/await-thenable` (`await helper()`
  on a generator helper).
- **Typed defects** (D42): a throw is a `defect`, typed `unknown`, since
  whatever a body calls can throw anything (§4.12, §4.13).
- **The rest of the platform's catalogue.** `ramme/platform` has `fetch`,
  `listen`, `nextFrame` and `each` (§4.9); `once` and `on` for events, `idle`
  for `requestIdleCallback` and `bind` for an observer's callback are not in
  it, and the lints do not flag observers, `requestIdleCallback` or
  `scheduler.postTask`.
- **kilde's hot layer**, the constructs that hold a subscription or run
  asynchronous work, lives in kilde, built on ramme's public API as tasks
  and as values on a factory's node (D6′).
- **Reference counting** is a pool of size one with a delayed close, outside
  the core.
- **Not provided** (D1′): transferring or detaching an entry; an option
  that would let a node resolve from an ancestor of its owner instead of
  from its owner; propagated non-owning variables.
- **Polyfills** beyond the two disposal symbols (§1.2, A2).

---

## 10. Design laws

1. **Acquisition is ownership.** Whatever a body acquires is attached to a
   node before the acquisition returns; that node releases it, whether the
   body returned, threw or was interrupted. A body may release early; it
   never writes cleanup as control flow.
2. **The ambient node is the default; name a node only to mean another.**
   The free functions act on the current node; the same operations as
   `Context` methods exist for acting on behalf of another.
3. **The current node is the synchronous slot**: valid in a step, in what
   a step calls synchronously, in `node.run(fn)`, a `listen` handler and a
   `promised` body, and never after an `await`; ramme has no async context.
   Async code reaches ramme through a node it names or captured before its
   first `await` (§6, D41).
4. **Interruption stops work; it never requires cleanup.** Interruption
   halts the body at its next wait by returning the generator; a `finally`
   in the body's own frame may wait, as release work; no `catch` sees it;
   the outcome is `aborted` by state. An expected failure is yielded, never
   thrown, and ends the body the same way (D42). Its node's stacks are
   released by the runtime. Interruption is delivered to the whole
   subscribed subtree at once (an `observe` node holds it back from its
   subtree until it exits, a bodiless one included, §4.1); completion
   propagates up.
5. **What code attached is released before what DI provided.** Explicit
   stack, then provided stack, each in reverse order. Nothing is promised to
   references that escaped their scope except that use fails loudly.
6. **No bare callbacks, no bare promises for work.** Every asynchronous hook
   is a fiber, or a synchronous re-entry of its node through a ramme wrapper
   (`node.run(fn)`, `listen`, §4.9); anything that should be a node is a task, which can only
   be forked or called. `Symbol.asyncDispose` is the interop contract, and
   the core runs it as a fiber.

**Invariants.** I1 single owner. I2 a node completes at most once; each
entry's release runs at most once. I3 explicit before provided. I4
unsubscribed entries hear late. I5 LIFO, fixed positions (an entry never
moves, except a declared value's node at the end of its creation, §3.3; a
failure handler's hold releases node entries ahead of passive ones, §4.7).
I6 once a `freeze` or `restore` node is delivered, its body runs no op it
yields on its normal path, except one already started (§4.2's last row);
what its own `finally` yields is release work, which the tree never
interrupts: only the unwind fiber's deadline reaches it, and halts only its
`restore` work (D21, §2.4). I7 after completion every operation throws. I8
between delivery and completion every synchronous operation works, except
intake into a pool (D15), and the body's own `finally` may wait. I9 marked
before heard: every node a delivery reaches is marked before any of its
listeners runs (an `observe` node's held-back subtree is a later delivery's,
§4.1). I10 no unhandled rejections from the core's promises (a promise
derived from one is the user's), and a work op nobody consumes never runs.
I11 consumed once or surfaced. I12 aborted is not failure. I13 state
decides. I14 every release is a fiber, current while it runs synchronously
or steps. I15 synchronous attachment. I16 nothing but the factory runs in a
creation frame: no body, `run` or other node is entered from it, and a
continuation the factory schedules runs outside it. I17 placement follows
dependencies. I18 every creation-time read is `inject`. I19 decisions are
permanent and placement is by view. I20 fork is asynchronous. I21 the
current node is the default owner. I22 escape fails loudly. I23 every
acquisition is releasable early. I24 only resolution attaches to the
provided stack. I25 every asynchronous hook is a fiber, or a synchronous
re-entry of its node through a ramme wrapper. I26 fibers are not awaitable;
tasks are not callable. Each has a named test in `src/invariants.test.ts`;
the last clause of I16 is tested in `src/creation.test.ts`.

**Assumptions.** A1 abandoned promises are collectable (a `never()` nobody
settles, `$`'s later `next()`, and the reactions, subscriptions and bodies
ramme detaches and empties). A2 the platform is Node 22+ or an evergreen
browser: ES2022 syntax, `Promise.withResolvers`, `AbortSignal.any`/`timeout`,
the disposal symbols (defined at import where missing), `AggregateError`
(`SuppressedError` is shimmed where missing). A3 one copy of ramme per
realm: two copies keep separate slots, do not see each other's nodes and do
not step each other's ops, which is not supported and not detected. A4
factories are synchronous. A5 dependencies are acquired before their
dependents (by construction for DI values; by discipline for fibers and
values' releases). A6 cleanup the design relies on is an entry; a body's own
`finally` may wait, and a halt cuts a normal-path `finally` suspended at the
delivery. A7 bodies pass `signal()` on or yield often enough to unwind
promptly.
