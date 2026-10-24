# ramme — Design

**One tree for services and work.** Dependency injection, structured
concurrency and resource lifetimes in one structure, so that a node is at
once a *resolution scope* (what `lookup`/`inject` see), an *execution scope*
(what ambient code runs inside) and a *lifetime* (what is released together).

This document describes the library as it is: the model, the guarantees,
and how each mechanism works. It says *what*; the *why* and the rejected
alternatives are in [DECISIONS.md](DECISIONS.md), cited as `D<n>`; a prime
(`D1′`) marks an entry that the lifecycle and concurrency redesign
rewrote. The guarantees G1–G4 are defined in §2.5, the contracts C1–C8 in
§2.6, and the design laws, invariants I1–I27 and assumptions A1–A8 in §10.
User documentation is the README, which covers application code: the first
API tier (§1.3) and a few tier-2 names in passing.

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
in its idiom; ramme never imports kilde (D6′). A library that reads ambient
services defines its keys with default factories (§8, D5). The shipped lint
rules (§9) are a separate package.

### 1.2 Entry points

| Subpath | Contents |
| --- | --- |
| `ramme` | nodes, tasks, the ambient free functions, DI, topics, errors |
| `ramme/node` | side-effect import: `AsyncLocalStorage` context storage |
| `ramme/async-context` | side-effect import: TC39 `AsyncContext` storage |
| `ramme/result` | the `Result` helpers (`success` … `collect`, `gen`, `$`; §4.13) |

The two adapters are the only modules with side effects (`sideEffects` in
package.json names exactly those files). One of them is required (§6, D9′).

### 1.3 Two API tiers

| Tier 1: application code | Tier 2: resource and library authors |
| --- | --- |
| `task`, `fork`, `call`, `attempt`, `join`, `result`, `all`, `race`, `settle`, `lookup`, `own`, `release`, `signal()`, `sleep`; `Result`, with its helpers in `ramme/result` (§4.13) | `own(fork(…))`, `pool`, `interrupt: 'observe' \| 'restore'`, `childrenOnExit` |
| `inject` in constructors; `static readonly scope`; `createRootContext`; `await using`; `child()`, `abort`, `close` | `own(value, release)`; `releaseAll`; `current()`; `ctx.own` on behalf; `owner.outcome` |
| `t.bind`, `t.with`; the `name`, `signal`, `onFailure` and `providers` options; `createInjectionKey`, `valueProvider` | `interrupted`, `never`, `managed`, `releaseTimeoutMs`, `stallWarningMs`, topics, `ctx.run`; keys with default factories (§8) |

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
| `id`, `name` | process-unique id; `opts.name`, a fiber's task name, `release:<entry>` for release fibers |
| `state` | `pending` → `running` → `settling` → `releasing` → `complete` (`pending` only for a DI value's node before placement) |
| `signal` | fires when the node is delivered (§4.1) |
| `outcome` | `undefined` until settling, then `success` / `failure` / `aborted` (§4.12) |
| `parent` | the resolution parent: `undefined` on a root (and on a value's node released unowned, §3.3); a value's storage node (§3.3); a release fiber's owner (§2.4); the node a `fork`, `call`, `child` or pool was made on. Readable in every state but `pending`, after completion included (tree shape does not change); `PendingNodeError` on a pending value node (§3.3; D33) |
| `scopes` | the scopes this node carries (read-only) |

Options (`NodeOptions`): `name`, `providers`, `scopes`, `interrupt`
(`'freeze'` default, `'observe'`, `'restore'`), `childrenOnExit`
(`'interrupt'` default, `'await'`; D18), `timeoutMs` (delivers a
`TimeoutError` to this node), `signal` (delivers when it fires),
`releaseTimeoutMs` (the deadline of this node's release fibers; inherited;
none by default, D21), `stallWarningMs` (default 5000; inherited; `0` or
`Infinity` disables) and `captureAutoScoped` (default `false`; when set,
nothing auto-hoisted for a requester at or below this node is cached above
it, §3.3). Millisecond options are validated at construction.

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
| `attempt(t, …)` / `t.attempt(…)` | fiber, joined | explicit / yes | yes | as `call`; resolves with the outcome (§4.5) |
| `fork(t, …)` / `t.fork(…)` | fiber | explicit / yes | yes | starts in a microtask, or after placement in creation |
| `own(fork(t, …))` | fiber | explicit / **no** | yes | an owned fiber (§2.6 C5) |
| `pool(opts)` | pool | explicit / no | no | its forks are its subscribers (§4.10) |
| a DI value's node | value | **provided** / no | no | auto-hoisted: pending until placed; declared: live from the start (§3.3) |
| a release fiber | release | none (transient) | yes | §2.4 |

`own(node)` on one of this node's own subscribed entries flips it to
unsubscribed; its stack entry stays where it is. Code cannot attach to the
provided stack; only resolution does.

### 2.4 Completion and release

When a node's body settles or freezes (a bodiless node: on `abort()` or
`close()`):

1. **Signal.** Under `childrenOnExit: 'interrupt'` (the default, D18), and
   always after `abort()`, the subscribed subtree is delivered in this tick
   (below an `observe` node whose body is still running, only its `restore`
   descendants; the rest hear when that body exits, §4.1). A natural body
   exit delivers with an `OwnerInterrupt` reason and does not mark the
   exiting node itself. Under `'await'`, or on `close()`, nothing is
   fired.
2. **Release the explicit stack, LIFO.** A subscribed node entry is mostly a
   wait (it gets `close()` under `'await'`/`close()`); an unsubscribed one
   (an owned fiber, a pool) is aborted at its turn, which is the first
   thing it hears.
3. **Release the provided stack, LIFO.**
4. **Complete.** The node leaves its owner's stack; its cache, providers and
   decided markers (§3.4) are dropped; its completion (what `close()` and
   `[Symbol.asyncDispose]()` wait for) resolves.

The loop re-reads the top of the stack at every step, so an entry pushed
while the node is releasing (an `own` from a release, a value placed by a
release fiber's `lookup`) is released next. A node whose every release is
synchronous completes synchronously inside `abort()`. An entry keeps the
position it was attached at (I5): an early release removes it without
moving the others, and `own(node)` leaves it in place; the one exception
is in §3.3. While a failure handler holds the node, its node entries are
released ahead of the passive ones (§4.7).

**One release.** Each entry is released inside a **release fiber**: a node
of kind `release` whose parent is the owner, whose signal is a fresh
`AbortSignal.timeout(releaseTimeoutMs)` (or never fires), in `observe`
mode, on no stack (D3′). A passive entry's release is one call of its
dispose: its `[Symbol.asyncDispose]()`, its `[Symbol.dispose]()`, or the
function given to `own(value, release)` or `own(deferFn)`. A node entry's
release is `abort()` (or `close()`, §2.7) and then waiting for its
completion. The release fiber is the current node while the release runs,
so inside any release, ramme-native or foreign, `signal()` is the deadline,
`own(...)` attaches things that live as long as the release, `lookup`
resolves through the owner, and `owner.outcome` (captured at acquisition)
is readable: the outcome is fixed at settling. A release runs exactly once
per entry, even under a concurrent early `release(x)`; a release that
throws does not stop the next one, and its error is collected (§4.12).

### 2.5 What the order guarantees (D16)

- **G1** Anything code or its descendants read from a node's provided values
  stays alive until every explicit entry on that node has completed, unless
  the value's own node is aborted first: by an owned or `'link'` fiber
  forked on it that fails (§2.6 C5, §4.7), or by an `abort()` through a
  reference to it (a `current()` kept from the constructor). Its entries are
  then released at once, and a later cache hit throws `NodeCompletedError`
  (§2.7).
- **G2** Explicit entries release in reverse attachment order: dependency
  order iff a fiber uses only what was attached before it was forked.
  *Discipline:* acquire before you fork what uses it.
- **G3** Provided values release in reverse creation order, which is
  dependency order because `inject` runs during creation. *Discipline:* a
  value's release, and a value's owned fibers, use only what the value
  injected or reads through its own node.
- **G4** Interruption reaches the whole subscribed subtree at once, except
  below an `observe` body that is still running (§4.1); nothing waits for a
  sibling.

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
const tx = own(await db.begin(), (tx) =>
  owner.outcome === undefined || owner.outcome.status === 'success' ? tx.commit() : tx.rollback());
```

Released early (`release(tx)`) or at a successful completion it commits;
under `aborted`/`failure` it rolls back.

**The same as a DI service (D33).** A unit of work that a request's code
shares is a value declared per request (§3.1). Its entries are on its own
node, which settles `aborted` when its owner's turn aborts it (§2.4),
whatever the request did, so that node's outcome answers the wrong
question; its release reads the outcome of the node storing it, its
`parent`:

```ts
// The pool hands out a lease synchronously and attaches it to `owner` before returning (below):
//   acquire(owner: Context = current()): Lease   // takes an idle connection or throws; a factory cannot await (D26)
export class UnitOfWork {
  static readonly scope = RequestScope;
  readonly #node = current();                     // this value's node; declared placement, so #node.parent is already the request node
  readonly #lease = inject(DbPool).acquire();     // owned by this value's node; released after the release below (LIFO)
  constructor() {
    own(this, () => {
      const o = this.#node.parent!.outcome;       // the request's outcome: fixed before its provided stack is released
      if (o === undefined) return this.#node.signal.aborted ? this.rollback() : this.commit();   // done(), or this node aborted early (G1)
      return o.status === 'success' ? this.commit() : this.rollback();
    });
  }
  /** Commit now, while the request still runs. */
  done(): Promise<void> { return this.#node.release(this); }
  query(sql: string) { return this.#lease.conn.query(sql, signal()); }
  async commit(): Promise<void> { … }
  async rollback(): Promise<void> { … }
}
```

*Precondition.* The node that carries `RequestScope` must be the request's
fiber, so that its outcome is the request's result:
`task(async (req) => …, { scopes: [RequestScope] })`, or, for an existing
task `handle`, `fork(handle.with({ scopes: [RequestScope], … }))`. A bodiless
`child({ scopes: [RequestScope] })` reports how it was ended, not how its
work ended: `success` on `close()`, `aborted` on `abort()` (§4.12). Under
`await using`, whose `[Symbol.asyncDispose]()` aborts first (§2.7), every
unit of work on it then rolls back; after `close()` every one commits, even
when a `call` on the node failed and the error was caught. The idiom does
not apply to such a node.

*`acquire()` is synchronous.* It hands out a lease and attaches it to the
current node, the value's node. The producer below returns
`Promise<Lease>`, which a field initializer cannot await (D26), so the
idiom as shown, and its LIFO order, need the synchronous form. An
asynchronous variant takes the lease at first use with `this.#node` as its
owner and registers the `own(this, …)` entry after it, so that LIFO still
commits before the connection is returned. `commit` and `rollback` return
`Promise<void>`, since `Release<T>` is `(value: T) => void | Promise<void>`.

*What the release sees.* `o === undefined` means the entry is released
while the request still runs, in one of two ways. Either it is released
without a signal: through `uow.done()` (`#node.release(uow)`), or through
`close()` or `releaseAll()` on the kept `current()`, none of which aborts
the value's node, so the unit of work commits (a free `release(uow)` from
the request body throws `NotOwnedError`, C7: the entry is on the value's
node, not the request's). Or the value's own node was aborted first (G1: an
owned or `'link'` fiber forked on it failed, or `abort()`, or a `Symbol`
dispose method, which aborts first (§2.7), was called through a kept
`current()`), whose signal has then fired, so it rolls back. Only such an
abort makes the early branch roll back: a cancel written as
`#node.close()` commits. In every other case the request node's outcome is
fixed at settling, and its provided
stack is released after its explicit stack (§2.4, §4.12): a value's release
sees the outcome of the node storing it as decided at settling, unless its
own node was aborted first, and a G1 abort after the request settled reads
that settled outcome. The release phase may later amend the outcome with
release failures and unconsumed child failures, folded in at completion
(§4.12, D16), which the release does not see; so a request body that
returns while a `'join'` fork it never joined has failed still commits. The
value's own node settles `aborted` when the request's release loop reaches
it, whatever the request did, with `OwnerInterrupt` or, when the request
was interrupted, the request's own reason, which is why the idiom reads the
parent, not the owner. That is the outcome fixed at settling, and only
when the request's turn is what ends the node: a `close()` through the
kept `current()` ends it earlier, `success`. Either way the node's final
outcome may still be amended at completion (§4.12): a release of its own
that throws, or an owned fiber of it that failed, makes it `failure`.

`releaseAll()` releases the entries on the node's explicit stack at the
time of the call, top down and one at a time: each release finishes before
the next starts, and an entry released meanwhile by something else is
skipped. The provided stack is untouched and the node stays open. It
rejects with the one release error, or an `AggregateError` when several
failed (§4.12).

**Where an entry lands.**

- In a body: on the explicit stack of the current node, the body's fiber.
- In creation: on the explicit stack of the value's **own node**, the
  current node during the factory (§3.3).
- In a release: on the release fiber, released when the release finishes.
- On a node someone handed you: on that node's explicit stack.

**Contracts.**

- (C1) `own` is synchronous; the entry is registered before it returns.
- (C2) `own` on a delivered-but-incomplete node succeeds.
- (C3) `own` on a complete node throws `NodeCompletedError`.
- (C4) A release runs exactly once per entry, in a release fiber, after
  everything above it on its stack and (for provided entries) after the
  whole explicit stack; the one exception is a failure handler's hold
  (§4.7).
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
to an entry: `own(() => …)`. `try/catch` is fine: ramme never throws a
body's own interruption into it (a `freeze` or `restore` body stops at its
next managed await instead), so a `catch` sees errors only: a foreign
operation's `AbortError` when it was handed `signal()`, and
`FiberAbortedError` when the body awaits other work that was aborted
(§4.12). To branch on how other work ended rather than catch it, `attempt`
and `settle` deliver the outcome as a value (§4.5, §4.8).

### 2.7 Lifecycle operations and use after release

| | Signal | Waits | Rejects with |
| --- | --- | --- | --- |
| `abort(reason)` | yes | no | — |
| `close()` | no | subscribers naturally, then both stacks | unconsumed failures |
| `[Symbol.dispose]()` | yes | no; the owner's completion waits | — (throws `TypeError` on a root) |
| `[Symbol.asyncDispose]()` | yes | completion | unconsumed failures; for a fiber, as `join`: its own failure, or `FiberAbortedError` when its outcome is `aborted`, as it is for a `freeze` or `restore` fiber that had not settled |

These four are idempotent on a complete node. `close()` on a fiber waits for
its body and then releases without a signal; an `abort()` arriving first
wins. `close()` on a bodiless node closes its subscribed children
recursively and aborts its unsubscribed ones at their turn.

| Operation | Before delivery | Delivered, not complete | Complete |
| --- | --- | --- | --- |
| `lookup` / `get` | works | works | `NodeCompletedError` |
| `own`, `release` | works | works; released at completion | `NodeCompletedError` |
| `fork` / `call` / `child` / `pool` | works | works; a subscribed child is delivered at birth iff the parent would forward to it (§4.3); `pool.fork` throws `PoolClosedError` (§4.10) | `NodeCompletedError` |
| managed await (§4.2) | settles | never settles (`freeze`) / settles (`observe`) | `NodeCompletedError` |
| a released resource's handle | — | — | resource-defined; should throw |

A cache hit whose value node has completed throws `NodeCompletedError`
rather than handing out a released service.

### 2.8 The parent/child contract

What a parent provides to anything on its stacks: resolution (everything it
resolves; ancestors outlive you); a signal (subscribed: at the parent's body
exit or abort; unsubscribed: at your turn; provided values: after every
explicit entry has completed); waiting (the parent does not complete until
you do; a deadline is a signal to you, never an end to the wait, D21); order
(reverse attachment within your stack; explicit before provided);
`asyncDispose` at most once; `parent.outcome` readable during your release
(`undefined` means early); your failure routed or collected, never an
unhandled rejection; a place to run (your own node, or a release fiber,
current while you release).

What an entry provides: `[Symbol.asyncDispose]()` whose synchronous prefix
delivers your signal (nodes) and whose promise settles when you are fully
complete; idempotence (built in for nodes, yours for passive entries);
readable `state`/`outcome`/`signal.aborted` (nodes); every operation throws
after completion; a single owner; and **finishing**: your release eventually
settles because your body reaches a managed await (§4.2) or honours the
signal. The parent promises to wait forever; the child promises to finish. A
child that does not is reported (`node:stalled`, §5).

---

## 3. Dependency injection

### 3.1 Keys, providers, scopes

An `InjectionKey<T>` is a class, a function, or a token made by
`createInjectionKey(name, { factory?, scope? })`; a class or function key,
and a token with a `factory`, is its own **default factory**.
`setDependencies(target, ...keys)` declares constructor or function
arguments. Providers (`valueProvider`, `factoryProvider`, `classProvider`,
`aliasProvider`) bind keys on a node, at construction (`providers`) or
later (`addProvider`). A `Scope` is a name nodes carry (`scopes`), made by
`createScope(name)`; a scoped key or provider stores its value on the
nearest node carrying that scope. A key's scope is declared at the key
(D32):

```ts
const SessionScope = createScope('session');

class SessionCache {
  static readonly scope = SessionScope;       // one per session, whatever it injects
  readonly #config = inject(Config);
  readonly #entries = new Map<string, Entry>();
}
```

A class or function key declares its scope with its `scope` property, read
as JavaScript reads any static: a subclass inherits its base's
declaration, and `static override readonly scope = X` re-declares it. The
value is a declaration only when it is a `Scope` made by `createScope`
(checked by identity, not shape). `undefined` (what `static scope?: Scope`
with no initializer emits) and a function (a static method named `scope`,
such as an ORM's `Model.scope()`) are ignored; any other value is a
`TypeError` naming the key, at every read of the key's scope: resolution,
the shadow checks of §3.4, and provider registration (`child({ providers })`,
`addProvider`). `setScope(key, scope)` is the form for a key you do not
own (a third-party class, a function), including one whose unrelated static
`scope` member would otherwise be refused; the registered scope wins over
the property, and `setScope` on a key that already declares a scope, own or
inherited, is a `TypeError` (two declarations). A token takes
`createInjectionKey(name, { scope })`. A provider's own `scope` option takes
precedence over the key's and never reads it.

`SelfScope` means "per consuming creation, stored nowhere" (or at a node
that carries it); `RootScope` is on every root; `RequestScope` is the
conventional per-request scope, attached explicitly: to the request's
fiber (`task(async (req) => …, { scopes: [RequestScope] })`, or
`handle.with({ scopes: [RequestScope] })` for an existing task `handle`),
which the unit-of-work idiom of §2.6 requires, or to a bodiless
`child({ scopes: [RequestScope] })`.
Topics are keys too (§5).

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
parent (the decorator pattern) without checking that parent's body guards
(§4.9), so it works from inside a `call()`ed body, whose parent is lent. A
service that needs runtime borrows for its *own* lifetime keeps
`#ctx = current()` from its constructor and reads through it; borrows for a
*call's* lifetime use the ambient `lookup` in the method. The two side by side are the dependency/borrow distinction made
visible.

### 3.3 Creation, the value's node and auto-hoisting (D7)

Resolving `K` walks from the requester `R` upward: the first cache hit or
provider answers. A value has a **declared placement** when a provider or a
scope says where it is stored: on the providing node, or on the nearest node
carrying the provider's or the key's scope. A key with no provider but a
default factory is **auto-hoisted**: its factory runs in a **creation
frame** (§6) that records every `inject` into a dependency tracker, and the
value is stored on the deepest node that served one of its dependencies (clamped by
the nearest `captureAutoScoped` node, a `NodeOptions` flag for harnesses
and isolation boundaries that clamps placement and never changes
resolution), so a value is never cached above a node whose values it
consumed, and sharing is as wide as the dependencies allow. Tracked reads
decide placement only for auto-hoisted values; a value with a declared
placement stays where it was declared.

**When to declare (D32).** Inference gives the widest sharing the
dependencies allow, which is right for stateless and derived services and
wrong for state: a class whose fields inject nothing session-scoped lands at
the root and is shared by every session, and nothing in the class says so.
A service that holds state for one session, request or other unit declares
its scope (`static readonly scope`, §3.1); its value is then stored on the
nearest node carrying that scope, whatever it injects, and a requester with
no such node above it gets the error of any scoped key without one.
Everything else is left to inference.

The value's **own node** is excluded from tracking (D4′):
`inject(ContextKey)`, or `current()` in creation, returns it. It is created
when the factory first needs a current node: at the first `current()`,
`signal()`, `own`, `release`, `releaseAll`, `fork`, `pool`, `child` or
`inject(ContextKey)`. A factory that calls none of them leaves its value
without a node. An auto-hoisted value's node is **pending** until
placement: it accepts `own`, `release`, `releaseAll`, `fork`, `pool` and
`child`, while `parent`, `get`, `addProvider`, `call`, `join`, `result`,
`interrupted`, `never`, `sleep`, `managed`, `run`, `runSync` (§4.11),
`abort`, `close` and the `Symbol` methods throw `PendingNodeError`, so an
auto-hoisted factory cannot read its placement (D33). At placement its
parent becomes the storage node `S`, it is pushed on **`S`'s provided
stack**, unsubscribed, and the forks made in the factory start. A
declared-placement value's node is never pending: `S` is known before the
factory runs, so the node is created live on `S`'s provided stack (its
`parent` is `S` from its first use, and reading it does not affect
placement), and when the creation ends it moves to the top of that stack,
above the dependencies
the factory injected after the node was created (D27). This is the one time
an entry changes position. Placement into a node that is already releasing (a release fiber's
`lookup` created the value) pushes it on top, so it is released next,
before the values it depends on; placement into a complete node throws
`NodeCompletedError`.

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
fails the resolution (D14). Factories are synchronous (A5, D26).

### 3.4 Permanent decisions and placement by view (D10′)

**Decided markers.** When `R` resolves `K`, every node on the walk, from `R`
up to and including the one that answered, marks `K` *decided*, whether the
answer was a value or "not provided here". If the answer was an
auto-hoisted value `V`, the same nodes also mark every key in `deps(V)`,
its recorded dependencies (below). `addProvider(K)` at `C` throws
`PlacementError` iff `K` is decided at `C`. A fresh child has no decisions,
so providing at construction is always allowed. A provider for a scoped
key below the node that key resolves to is also a `PlacementError` (at
`addProvider`, at `child({ providers })`, and when a pending value node
that built such a child is placed; D10′).

**Placement by view.** When `R` finds auto-hoisted `V` cached at `S`, a
node from `R` itself up to, but not including, `S` is a **shadow** if it
provides a key in `deps(V)` or carries the effective scope of one: the scope
of the first provider for that key at or above `S`, else the key's own
(`SelfScope` aside). A shadow changes `R`'s view of that dependency, so the
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
values contribute their key only. A value built from a requester-relative
read (a per-creation `SelfScope` value, a `skipSelf` read) is **pinned**:
it is placed at its requester and served only to a requester at that same
node, so any other requester, a descendant included, builds its own.
Pinning carries through an injected auto-hoisted value that is itself
pinned; declared-placement values are never pinned (D25). What this gives:
no node ever changes an answer it has given; no requester is served a value
built from a view of its dependencies other than its own; both hold in
every order of resolution, for auto-hoisted factories that inject the same
keys on every run (below).

**An auto-hoisted factory must inject the same keys on every run.** A
re-creation forced by placement by view runs the factory from `R` with the
recorded `deps(V)` in hand. If this run injects a different set of keys,
the resolution throws `PlacementError` naming the key and both sets, the
new instance's node is released, nothing is cached, and the answer at `S`
is untouched. With equal sets the re-run lands at or below the shadow,
never on a node that already caches the key (D7).

### 3.5 Creation is pure

During creation: `inject` reads are tracked and `lookup` throws; the
value's own node is current (§3.3); `call`, `attempt`, `all`, `race`,
`settle`, `run`, `runSync`, `join`, `result`, `interrupted`, `never`,
`sleep`, `managed` and entering any other node as current throw
`CreationViolationError` (`release`, `releaseAll`, `close()` and
`[Symbol.asyncDispose]()` do not); `fork` on a live node passed in from
outside is allowed (it starts in a microtask); a creation ends when its
factory returns, so a continuation the factory scheduled runs with no
creation frame. A late read on a value's node that *creates* a value
(after construction) warns once per key per root in development mode
(§4.4, D4′).

---

## 4. Interruption and fibers

### 4.1 The signal

`node.abort(reason)` delivers to `node` synchronously and top-down along
subscription edges, in two passes: first the whole subscribed subtree is
marked delivered, with the reason (a `freeze` node forwards to every
subscriber; an `observe` node whose body is still running only to `restore`
ones, and the rest hear when that body exits, §2.4), then signals fire,
then in-flight managed awaits are cut (§4.2) and bodiless nodes exit.
**Every node of a delivery is marked before any listener runs** (D16), so a
listener on any of them sees all of them delivered. Unsubscribed entries
hear their signal at their turn in the release loop. Marking and firing
release nothing; a node starts releasing when its body exits, and the cuts
and bodiless exits of the second pass make that happen inside `abort()`, so
a node whose releases are all synchronous is complete when `abort()`
returns (§2.4).

A node's own `abort()`, `timeoutMs` and linked `signal` always deliver to
it. The default reason is an `AbortError` `DOMException`; `timeoutMs`
delivers a `TimeoutError`; a parent's body exit delivers `OwnerInterrupt`.

### 4.2 Freeze and managed awaits (D13)

On a delivered `freeze` node every **managed await** returns a promise that
never settles. The body is *frozen*: it never resumes, never runs `finally`,
never throws. A managed await already in flight when its node is delivered
is **cut**: its continuation is dropped, so it never settles, and the body
counts as frozen at once. ramme retains nothing of a frozen body, so the
suspended function is garbage-collectable (A2). A frozen body counts as
settled. Between delivery and the next managed await the body is running
plain code, and everything it does is legitimate (I8).

A managed await is an await on a promise returned by `call`, `attempt`,
`all`, `race`, `settle`, `release`, `releaseAll`, `join`, `result`,
`interrupted`, `never`, `sleep(ms)`, `managed(p)`, `close()` or
`[Symbol.asyncDispose]()`. Everything else is bare: `fetch`, timers other
than `sleep`, driver promises; `managed(p)` makes one freeze. `never()`
returns a promise that never settles: a `freeze` or `restore` body awaiting
it is parked until its node is delivered, which freezes it; anywhere else
it waits forever.
`interrupted()` resolves with the current node's abort reason when that node
is delivered (at once if it already was), and `ctx.interrupted()` with
`ctx`'s; a `freeze` or `restore` body awaiting its own node's delivery is
frozen by that delivery instead, so the resolving form is for `observe`
bodies (§4.3), release fibers, top-level code and a body waiting on another
node.

`sleep(ms)` and `ctx.sleep(ms)` resolve after `ms` milliseconds, a number
in [0, 2^31 − 1]; anything else is a `RangeError`, thrown before a timer is
armed (`never()` is the unbounded wait). Its freeze target is decided when
it is called, as below: a `freeze` or `restore` body awaiting it is frozen
at its node's delivery, and that delivery **clears the timer**, whether the
sleep was awaited or only stored, so no timer outlives the interruption or
retains the frozen body. A body already applied when it calls `sleep`
(plain code after delivery, I8, or a fork born delivered, §4.6) arms no
timer and freezes on it, as on `never()`. Without a target (an `observe`
body, a release fiber, a failure handler, a `ctx.run` frame on a bodiless
node, top level) it waits the full `ms`: an `observe` body reacts to its
interruption through `signal()` and `interrupted()` (§4.3), and a failure
handler that backs off with `await sleep(…)` resumes (§4.7). A failure
handler that awaits a sleep a body made, which the body's delivery may
clear or which armed no timer, waits on a timer of its own and resumes at
that sleep's deadline (§4.7). The timer is
armed under an empty frame (§6) and, unlike ramme's own timers, is not
unref'd: a sleep keeps the process alive like any timer. Repetition is a
`fork` that loops on `sleep` (D34).

The freeze decision is made for **the awaiting body's node**, `current()`
when the promise is made, whichever node the method was called on. With no
current node (top level, a platform callback) nothing freezes, and the
promise rejects with `FiberAbortedError` if the awaited fiber was aborted.
So `app.abort()` from a signal handler makes a top-level
`await app.call(main)` reject, and the surrounding `await using` cleanup
runs.

"Suspended on a managed await" means its `then` was called: a stored,
not-yet-awaited managed promise does not freeze the body at delivery, and
freezes it the moment it is awaited. The node is fixed when the promise is
made, so **a managed promise is awaited only by the body that made it**. The
supported shapes are a direct `await` (or `return p` from an async
function); ramme's own `all`/`race`/`settle`, where the body awaits one
promise over a group fiber that handles its members; and a `Promise.all`
that fulfils, when every member is a managed promise whose resume step
(below) consumes nothing unless it throws (`join`, `call`, `close()`,
`release(x)`). Other shapes can resume a body while one of its managed
promises is still pending (a later delivery then counts a running body
frozen and releases its node under it), lose a failure a member consumed, or
cut another body's await without freezing it. Unsupported in a `freeze`
body: `Promise.race`, `Promise.any`, `Promise.allSettled`, a `Promise.all`
that rejects, a `result(f)`, `attempt` or `settle` member of any combinator,
any combinator with a bare member, a `.then`/`.catch`/`.finally` attached to
a managed promise without awaiting it at once, and a managed promise awaited
by another body. Development mode reports them when they misfire (§4.4).
`ramme/no-promise-combinators` (§9, D35) flags every `Promise` combinator,
the supported fulfilling `Promise.all` included, because syntax cannot tell
it from one that rejects; such a use is disabled inline with a reason.

**`gen` and `$` (§4.13).** Supported: `await gen(…)` (or `return gen(…)`)
awaited at once by the body, whose generator awaits a managed promise inside
`$` (`yield* $(p)`) or directly. `gen` runs the generator in the body's
frame and `yield*` calls `$`'s `next()` synchronously, so the await inside
`$` is a direct await in the body's own async context: the managed promise
is armed for the body's node and cut at its delivery, as `await call(t)` is.
`gen`'s `await it.next()` and `yield*`'s own awaits are bare promises
chained behind it, so a cut drops the whole chain and the body counts frozen
at once. Unsupported in a `freeze` body: a `gen(…)` stored and awaited
later, or used as a member of any `Promise` combinator (its promise is
bare). The managed await inside `$` is armed as soon as the generator
reaches it, so a delivery while the body is suspended elsewhere counts the
running body frozen and releases its node under it. Use `all`/`settle` over
tasks instead.

`fromThrowing(p)` over a managed promise, and `fromThrowing(f)` whose
`f()` returns one, are the same shape. The promise form is an async
function whose `await p` calls `then` as soon as `fromThrowing` is called,
in the body's async context. Awaited (or returned) at once by the body, it
is a direct await. Stored, dropped or used as a combinator member, it is
unsupported in a `freeze` body, unlike the bare managed promise it wraps,
which arms nothing until it is awaited. Its armed await consumes a failure
(a `join`'s) as soon as the source settles, so when the body then freezes
on another await, that failure is lost: it is held as data in a `Result`
nobody reads, and nothing reports it. A delivery while the body is
suspended elsewhere counts the running body frozen and releases its node
under it, and so does a `void fromThrowing(join(f))` in plain code after
delivery (I8), which takes the applied path at once.

A managed promise wraps a **source**, an internal promise that never
rejects (a node's completion, the end of an entry's release, a node's
delivery), plus a **resume step** that runs only when an awaiter is
actually resumed (unrelated to a node's delivery of its signal, §4.1). The
resume step is where an awaited value is produced and a failure is
*consumed*: a frozen awaiter consumes nothing, and the failure surfaces
from the parent (§4.12). Since no source rejects, no promise the core makes
is ever an unhandled rejection, awaited or not.

### 4.3 Interruption modes and the birth rule (D12, D20)

| | `freeze` (default) | `observe` | `restore` |
| --- | --- | --- | --- |
| Delivered | when the parent forwards, or aborted directly | when the parent forwards, or aborted directly | whenever an ancestor on its subscription path is delivered |
| Applied (managed awaits freeze) | yes | **no** | yes |
| Forwards to subscribers | yes | **no**, except to `restore` ones | yes |
| Outcome after delivery | `aborted`, whatever the body does | the body's own result | `aborted` |
| Born under an already-delivered parent | delivered at birth iff the parent forwards to it (a delivered `freeze` or `restore` parent; not a delivered `observe` one) | **not** delivered at birth | delivered at birth |

`observe` is the resource author's mode: the body sees the interrupt
(`signal()`, `await interrupted()`), runs a controlled shutdown and settles
on its own; it never freezes. `restore` re-opens a cancellable window inside
an `observe` region. `task(fn, { interrupt: 'observe', timeoutMs: 5000 })
.call()` is a critical section with a deadline: at 5 s its `signal()`
fires and the body decides how to stop; nothing ends it if it ignores the
signal. A subscribed child born under a
delivered parent is delivered at birth iff the parent would have forwarded
to it; an unsubscribed one hears at its turn, as always.

### 4.4 Hazards and diagnostics

A `freeze` body that never reaches a managed await after delivery never
freezes, and its owner waits. Foreign library code is bare throughout. The
mitigation is diagnostic: `node:stalled` when a delivered node (any mode)
has neither settled nor frozen within `stallWarningMs`. Release fibers are
nodes, so a stuck release shows up the same way.

The commonest bare await is a platform timer. An
`await new Promise((r) => setTimeout(r, ms))` in flight at interruption is
not cut, so the body resumes when the timer fires and its node, with
everything attached to it (a connection lease), stays alive for the rest of
the wait. `sleep(ms)` is the managed form, whose timer the delivery clears
(§4.2, D34); `ramme/no-timers` flags `setTimeout`, `setInterval` and
`setImmediate` in application code (§9).

**Development mode** is on unless `process.env.NODE_ENV === 'production'`,
and always on where `process` does not exist (D30). It adds these checks:
`AsyncRunError` when `run(fn)` returns a promise (§4.11); a
`console.warn`, once per key per root, when a read through a value's own
node after construction creates a value (§3.5; declare it with `inject`
instead); a warning when a body settles after it was counted frozen, which
means it awaited in an unsupported shape (§4.2); a warning, once per node,
when a managed promise is awaited by a body other than the one that made
it; and a warning when a failure handler awaits a managed promise whose
creating body was frozen on it, which never settles (§4.7; a `sleep` is the
exception, since the handler waits it out on a timer of its own).

### 4.5 Tasks and the two kinds of function (D8′, D31)

```ts
async function parse(req: Request): Promise<Order> { … }           // a function: shares the caller's node
const handle = task(async (req: Request, res: Response) => { … });  // a task: a new node per run

await parse(req);                   // plain call, same node
await handle.call(req, res);        // new child node, joined, lends the current node
await handle.attempt(req, res);     // the same, resolving with the outcome instead of throwing
handle.fork(req, res);              // new child node, concurrent
await call(async () => { … });      // inline task: block scope for temporaries
fork(async () => { … });            // inline task: ad-hoc concurrency
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

A `Fiber<T>` is a node with a body yielding an outcome. It is not thenable:
`await fiber`, `Promise.resolve(fiber)` and `Promise.all([fiber])` reject
with `FiberNotAwaitableError`; use `join(f)` (the value, or the failure
thrown) or `result(f)` (the outcome; never rejects). A body that returns a
fiber fails with `FiberNotAwaitableError`.

**`attempt`** is `call` with `result`'s resume step, as `call` is `fork`
plus `join`. `attempt(t, …args)`, `ctx.attempt(t, …args)` and
`t.attempt(…args)` make the child `call` makes, start it synchronously and
lend the current node until it completes (§4.6, §4.9), and resolve with its
`Outcome<T>` instead of its value: a `failure` is delivered as a value and
consumed on resume, never thrown. As for `call`, the child runs as a
`'join'` fiber whatever its task's `onFailure`, and a caller that first
awaits a stored `attempt` after the receiver completed (a `ctx.attempt`, or
top level) is handed a failure the receiver has already reported. The await
is managed: a `freeze` or `restore` caller that is itself interrupted
freezes on it as on `call` and never sees an outcome; it consumes nothing,
and the failure surfaces from the receiver's completion instead (§4.12). So
`aborted` reports the child's own delivery: its `timeoutMs` or `signal`, an
explicit abort of it, or the abort of a receiver that is not the awaiting
body. The exception is a `restore` child, which hears every delivery on its
subscription path (§4.3): an `observe` caller is never frozen, so its own
interruption reaches such a child and comes back as `aborted` with the
caller's reason, and so does an `observe` ancestor's, which a `freeze`
caller below it does not hear. An `observe` body that falls back on
`aborted` checks `signal().aborted` first; a `freeze` body below an
`observe` ancestor, whose `signal()` has not fired, tells the child's
deadline by its reason, the `TimeoutError` `DOMException` that `timeoutMs`
delivers (an ancestor's interruption carries one only when it was itself a
deadline). `attempt` emits `join:enter` and `join:leave` on the awaiting
body's node, as `result` does (§5). It is the shape of a deadline with a
fallback, where a real failure is rethrown, as the `catch` it replaces
would:

```ts
const r = await attempt(fetchPrices.with({ timeoutMs: 500 }), sku);
if (r.status === 'failure') throw r.error;                             // a real failure stays a failure
const prices = r.status === 'success' ? r.value : cachedPrices(sku);   // 'aborted': the 500 ms ran out
```

`result(fork(t))` reads the same outcome but starts the body a microtask
later and lends nothing, so a forgotten await goes unnoticed. An outcome
nobody inspects is a failure dropped silently, which is why `call` stays the
default (D31).

### 4.6 Start semantics (D22)

- `call` and `attempt` start the body synchronously, with the child
  current; so do `all`, `race` and `settle` for their group fiber, whose
  members are forks.
- `fork` **never** runs any part of the body in the forker's frame: it
  starts in a microtask, or after placement when forked during creation.
  The body sees its own node as current from its first line, never a
  creation frame, and `own(fork(t))` takes effect before it starts.
- A body cannot tell whether it was forked or called.
- A fiber aborted before its body started settles `aborted` without
  running; a fiber forked under an already-delivered `freeze` parent runs
  until its first managed await.

### 4.7 Failure destinations (D14, D23)

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
`child().fork(t)`) throws `TypeError` at the call; pass `onFailure`, fork
from a body, or use a pool.

A handler runs with the parent current, so `lookup`, `own`, `fork`, `child`
and `pool` act on the node whose lifetime the handler's work shares, but it
is not the parent's body. Its managed awaits never freeze: the parent's
delivery neither cuts them nor counts the parent frozen, and a `sleep` there
runs its full duration (§4.2). A `sleep` the parent's body made, awaited by
the handler, resumes it at that sleep's deadline: the handler waits on a
timer of its own, which the delivery that clears the body's timer leaves
running. Its `call`s lend nothing (§4.9). While the
parent's body is lent, the handler may still use
`get`, `fork`, `child`, `pool` and `runSync` through the parent, and `own`,
`release`, `releaseAll`, `abort`, `close` and the `Symbol` methods, which no
lent node refuses; `call`, `attempt`, `all`, `race`, `settle`, `run`,
`join`, `result`, `interrupted`, `never`, `sleep` and `managed` through it
throw `UnawaitedCallError`; a handler that must wait then forks the wait.
Through any other node only that node's own body guards apply (§4.9). A
promise the handler returns holds the parent open
until it settles, and a rejection, like a synchronous throw, is collected
with the parent's release failures (§4.12). While that hold lasts and the
parent's stacks are otherwise empty, the parent's release loop takes only
node entries: a fork, `call`, `child` or pool the handler attaches is
released as soon as it is attached, and passive entries and values attached
meanwhile wait until the hold settles. A node entry can therefore be
released before a passive entry attached above it, the one exception to C4's
order. A handler that awaits the completion of its parent or of an ancestor
holds nothing from then on, so `onFailure: () => app.close()` shuts the app
down instead of waiting for itself.

### 4.8 `all`, `race` and `settle` (D28, D31)

All three run the tasks as subscribers of a fresh child fiber, the *group*
(a `call`, so they lend the current node; `opts` apply to the group):
`all([fetchUser.bind(id), fetchOrders.bind(id)])` resolves with the tuple of
values in order, and rejects with an `AggregateError` of **every** real
failure; `aborted` members are excluded from it, and an aborted member with
no failure rejects with `FiberAbortedError`. `race` resolves with the first
`success`, aborts and awaits the rest; with no success it rejects with an
`AggregateError` of the failures (or `FiberAbortedError` if every member was
aborted); `race([])` is a `TypeError`. Members always run as `'join'` fibers
of the group, whatever their own destination.

`settle` is `all` that resolves with every member's outcome instead of
rejecting. `settle([fetchUser.bind(id), fetchOrders.bind(id)])` waits for
every member as `all` does, aborting none on a sibling's account (D28), and
resolves with the tuple of their outcomes in order (`SettleResult`:
`[Outcome<User>, Outcome<Order[]>]`); `settle([])` resolves `[]`. Failures
and aborts are values, so a member never rejects the `settle`: each
member's failure is held, unconsumed, by the group's parent (the receiver)
rather than by the group, whose outcome stays its own, until `settle`'s
resume step consumes it and delivers it as that member's outcome. A caller
that is interrupted freezes on `settle` as on `all` and consumes nothing, so
the failures surface from the receiver's completion (§4.12). When the group
itself is delivered (its own `timeoutMs` or `signal`), it forwards to the
members still running as any node does (§4.1): a `freeze` or `restore`
member's outcome is then `aborted`, and an `observe` member's is what its
body settles with (§4.3). A member the group never forked reports `aborted`
with the group's reason: every member, when the group was aborted before its
body ran. Either way the tuple resolves: the caller is alive. A member's
`aborted` is thus its own delivery or the group's, or, as for `attempt`
(§4.5), an `observe` caller's or ancestor's interruption reaching a
`restore` member or group. `settle` rejects only with a failure of the
group's own, such as a value provided through `opts.providers` whose release
threw, or a member's fork that threw (an invalid option on its task, refused
when its node is built), and then hands the resumed caller every failure
once, in the shape `all` rejects with: the group's error alone, or a
`SuppressedError` of it over an `AggregateError` of the failures of the
members it had forked, which are consumed with it.

### 4.9 Lending: unawaited calls are detected (D11)

`call` **lends** the current node to the child until the call settles (the
child completes, its releases included); so do `attempt`, and `all`, `race`
and `settle`, which are calls. The body-shaped operations on a node check
its **body guards**: the node is not complete (`NodeCompletedError`), not
pending (`PendingNodeError`), no creation is current
(`CreationViolationError`), and the node is not lent (`UnawaitedCallError`);
`fork`, `child` and `pool`, which a pending node and a creation allow, check
completion and lending only. While lent, `lookup`/`get`, `call`, `attempt`,
`fork`, `child`, `pool`, `all`, `race`, `settle`, `join`, `result`,
`interrupted`, `never`, `sleep`, `managed`, `run` and `runSync` throw
`UnawaitedCallError` naming the child (`.child`); a managed await also
checks the lending of the awaiting body's node, whichever node receives it.
`own`, `release`, `releaseAll`, `abort`, `close` and the `Symbol` methods do
not check lending.

`call` lends `current()`, never the receiver: `otherCtx.call(fn)` from body
`Y` lends `Y`, and a top-level `await app.call(main)` lends nothing, so a
platform callback can `app.fork(...)` while it runs. A `call` from a failure
handler lends nothing either: the handler is not its parent's body (§4.7).
`Promise.all([call(a), call(b)])` throws on the second call, unless `a`
completed synchronously inside the first (use `all`, or `settle` for the
outcomes). A forgotten `await` on a plain function call is invisible to
ramme and left to `no-floating-promises`.

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
always report to `onFailure`. `pool.running` counts the forks the pool has
admitted (started, or due to start in their start microtask) and not yet
completed, never its release fibers, values placed on it or passive entries;
`pool.pending` counts queued ones. With `concurrency` reached, `'wait'`
queues the fork and `'reject'` throws `PoolFullError`. A fork frees its slot
at completion, before its failure reaches `onFailure`. Intake stops at the
signal: `pool.fork` throws `PoolClosedError` once the pool is delivered or
`close()` was requested, `NodeCompletedError` after completion. `close()`
drains the queue (waiters start as slots free); `abort()` cancels it (queued
forks settle `aborted` without running). The pool's owner reaches it at its
turn in the release loop, after the explicit entries above it.

### 4.11 `run` and `runSync`

`ctx.run(fn)` makes `ctx` current for a synchronous `fn`: the way code with
no current node enters the tree, and the way a test makes a node current. A
returned promise throws `AsyncRunError` in development mode (§4.4): it
would be current only for the synchronous part. `runSync(fn, …args)` is
`child()`, `run`, and `abort()` on exit: synchronous block scoping whose
synchronous releases have run when it returns.

### 4.12 Outcomes and errors (D17, D24, D38)

**Three kinds (D38).** An expected failure, one a caller is meant to branch
on, is a `Result` value, returned and typed (`{ status: 'success', value }`
or `{ status: 'failure', error }`, §4.13). A throw is a defect: a task's
failure is untyped, handled at task boundaries (`attempt`, `onFailure`),
where a `catch` translates it, and never used as domain control flow. An
interruption is
neither: it is decided by state (D24), and it reaches a caller as `aborted`
from `attempt`/`settle`, or thrown as `FiberAbortedError` from `call` (or as
a foreign operation's `AbortError` when that operation was handed
`signal()`, §2.6). `Outcome` is `Result` plus `aborted`, so `attempt` on a
task returning a `Result` yields `Outcome<Result<V, E>>`, two layers read
with one vocabulary.

Every node's outcome is computed at settling and decided by state, never by
inspecting the error: a `freeze` or `restore` node delivered before its body
settled or froze is `aborted`, whatever the body produced; an `observe`
node's outcome is its body's result; a bodiless node is `success` on
`close`, `aborted` on `abort`. Delivery after settling changes nothing.

The release phase amends the outcome once, aligned with `await using`: body
`failure` plus release failures → `SuppressedError(releaseError, bodyError)`
(release-primary); body `success` or bodiless plus release failures →
`failure` (with an `AggregateError` for two or more); body `aborted` plus
release failures → `failure`. An early `release(x)` or `releaseAll()` whose
release throws rejects that call (`releaseAll()` with the one error, or an
`AggregateError` when several failed); if the caller froze or never awaited,
the error surfaces from the owner's completion instead. An owner whose
releases end while the caller is still waiting completes only once the
caller has been resumed (or frozen), so the error is reported exactly once
(D16). The call counts as awaited from its creation until its awaiter is
resumed or frozen; a call whose releases all succeeded is never waited for,
and a failing call nobody awaits holds its owner for at most two microtasks,
after which its error goes to the owner's completion. A caller that first
awaits after the owner completed sees the error again, as any second `join`
does.

At completion a node collects its own failure, every unconsumed subscriber
failure (fibers, child contexts, pools and value nodes alike; a release
fiber's failure is collected only as its entry's release failure; a
`settle` member's is held by the group's parent instead, §4.8), every
owned-fiber failure and every early-release failure that no resumed awaiter
received. A fiber's final outcome then goes to *its* destination; a
context's or pool's `close()` and `asyncDispose()` reject with it. A failure
is consumed at most once: by the resume step (§4.2) of a `join` (or `call`),
`result`, `attempt`, `settle`, `asyncDispose` or `close`, or by the parent
surfacing it. `result`, `attempt` and `settle` deliver a failure as a value
(`{ status: 'failure', error }`) instead of throwing it, and an `aborted`
outcome as a value instead of `FiberAbortedError`; the consumption is the
same, so an outcome nobody inspects is a failure dropped (D31). Nothing the
core produces is an unhandled rejection. `gen` is an async function, and a
dropped `gen(…)` can be one (§4.13).

| Error | Thrown when |
| --- | --- |
| `NoCurrentNodeError` | a free function runs outside any node; or no context storage is registered (the message names `ramme/node`) |
| `NodeCompletedError` | any operation but the lifecycle four on a complete node; a cache hit on a released value; placement into a complete node |
| `PendingNodeError` | a refused operation on a value node before placement (§3.3) |
| `NotOwnedError` | `release(x)` of something this node does not own; `own(node)` of another node's entry |
| `AlreadyOwnedError` | a second release for one object on one node; `own(node)` of an already-owned node |
| `UnawaitedCallError` | body-shaped use of a lent node (§4.9); `.child` is the call fiber |
| `FiberNotAwaitableError` | awaiting a fiber; a body returning a fiber |
| `FiberAbortedError` | `join`/`call`/`all`/`race`/`[Symbol.asyncDispose]()` of an aborted fiber by an awaiter that is not frozen (`asyncDispose` aborts first, §2.7); `.reason`. `result`, `attempt` and `settle` report `aborted` as an outcome instead |
| `PoolClosedError`, `PoolFullError` | pool intake after the signal or `close()`; at capacity with `whenFull: 'reject'` |
| `CreationViolationError` | `lookup` or a body-shaped operation during creation; `inject` outside creation; `get(ContextKey)` |
| `FactoryReturnedUndefinedError` | a factory or provider returned `undefined` (a `CreationViolationError`) |
| `AsyncRunError` | `run(fn)` returned a promise (development mode, §4.4) |
| `PlacementError` | providing a decided key (§3.4); a scoped provider below the node carrying its scope; a forced re-creation whose factory injected different keys than its first run (§3.4) |
| `OwnerInterrupt` | never thrown: the abort reason of a parent's body exit, or of an entry's turn in the release loop; `.owner` |

### 4.13 Results and `gen` (D38)

`Result<T, E>` (`Success<T> | Failure<E>`) is a core type; its helpers are
free functions in the subpath `ramme/result`, which imports only types from
the core. None is a method, and each works on any plain object of the
shape, so a hand-rolled `{ status, value | error }` needs no adapter.

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
| `gen(body)`, `$(x)` | the `?` operator (below) |

Each helper takes the whole `Result` as its type parameter and reads the
value and error types off its members, as `gen` does. So every step takes
the inferred return type of an unannotated fallible function, which has one
`Failure` member per error (`Failure<InvalidCard> | Failure<Insufficient> |
Success<Receipt>`), and keeps every error; a `Result<T, E>` parameter would
take one inference candidate for `E` and refuse it. A member of the other
kind contributes `never`, never `unknown`:
`andThen(r, (v) => success(v + 1))` keeps `r`'s error type, and
`orElse(r, () => success(x))` has error `never`.

```ts
class UserNotFound extends Error { readonly name = 'UserNotFound' as const; }
class OrderNotFound extends Error { readonly name = 'OrderNotFound' as const; }

const r = await gen(async function* () {
  const user = yield* $(getUser(id));       // getUser: (id) => Promise<Result<User, UserNotFound>>
  const order = yield* $(getOrder(user));   // getOrder: (u) => Promise<Result<Order, OrderNotFound>>
  return success(order);
});
// r: Result<Order, UserNotFound | OrderNotFound>
```

`$(x)` takes a `Result` or a promise of one, typed by `x` as a whole,
awaited, so a union of promises (`$(admin ? getAdmin(id) : getUser(id))`)
is taken too. `yield* $(x)` evaluates to the
success value itself, never awaited (a promise or a fiber included), or
yields the failure. `gen(body)` drives the body's async generator: a
yielded failure ends the run and is its result; otherwise the body's
return value is, and it must be a `Result`, so `return failure(e)` works
beside `yield*`. The error type, inferred, is the union of the errors of
the yielded and the returned failures; TypeScript compares classes by
structure, so each error class above has a distinct literal member,
without which the union collapses to one of them. The failure unwinds as data, so no `catch`
in the body sees it, and `gen` does not call the generator's `return()`:
that would resume the body and run a `finally`, which a body does not
have anyway (A7). Nested `gen`s compose, since the inner one returns a
`Result` the outer `$` consumes. A generator is not an arrow, so a method
passes its `this`: `gen(this, async function* () { … })`.

`$` is a hand-written async iterator, not an `async function*`, whose
`return` would await the value: a thenable success value would be
unwrapped, and a fiber's `then` throws (§4.5). Its first `next()` awaits
`x`, always, so a promise is handled and a settled `Result` costs one
microtask. Over a managed promise that is the body's own direct await; the
supported and unsupported shapes under a freeze are in §4.2. Over a bare
promise it is a bare await (§4.4), which a delivery does not cut.

`gen` is an async function, not a managed await. Its promise rejects at
once with whatever the body throws, a defect, as the async function it
replaces would. That includes a failure thrown by a `call` inside `$`:
`$`'s await runs that call's resume step, which consumes the failure
(D13), so the node does not surface it, and a dropped `gen(…)` whose body
throws is an unhandled rejection. Await or return `gen(…)` at once; §9
says which lint sees a dropped one.

For ramme work, use `attempt`, which keeps `aborted` (§4.5). `fromThrowing`
is for foreign code: over a ramme call it reports an abort as
`failure(FiberAbortedError)`. Its promise forms await at once:
`fromThrowing(p)`, and `fromThrowing(f)` whose `f()` returns a promise,
call `then` on it when `fromThrowing` is called. So over a managed promise
(`fromThrowing(managed(foreignPromise))`), await or return
`fromThrowing(…)` at once, as `gen(…)`: stored, dropped or used as a
combinator member, it is unsupported in a `freeze` body (§4.2). A
function's return value is chained only when its `then` is a function. A
fiber's `then` getter throws (§4.5), so a returned fiber is the success, and
`fromThrowing(() => pool.fork(job))` fences pool intake, which `attempt`
cannot: the fiber as a success, or `PoolFullError` or `PoolClosedError`
(§4.10) as a failure.
A function whose return type may or may not be a promise
(`number | Promise<number>`) is typed as giving the `Result` or a promise of
it, as the runtime does. One typed `any` or `unknown` is typed
synchronously, whatever it returns: give it its return type, or fence the
promise itself.

Deliberately absent: a class or methods on the data, `match`, `tap`,
`Option`, and a synchronous `genSync`. Narrowing on `status` is the
combinator library; code that wants chaining wraps the plain object in
neverthrow in one line.

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
| `node:frozen` / `node:settled` | the body froze / settled with `outcome` |
| `node:lent` / `node:returned` | `childId`: a `call` lent this node / gave it back |
| `node:releasing` | `stack`: the release loop entered a stack |
| `entry:registered` / `entry:released` | `entryName`, `stack`; `error` on a failed release |
| `node:complete` | `outcome`; always a node's last event |
| `node:stalled` | `sinceMs` (§4.4) |
| `join:enter` / `join:leave` | `joinedId`, `outcome`: a `join`, `result` or `attempt` waits on a fiber; emitted on the awaiting body's node, not on the receiver of `n.join(f)` (on the receiver when no body awaits); a frozen awaiter emits no `join:leave` |

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
`current().<method>(...)` (I21); the `Context` methods exist for acting on
behalf of a node that is not current.

There is one mechanism. A `Frame` (`{ node, creation }`, and a mark on the
frame a failure handler runs in, §4.7) is held in the platform's async
context, which an adapter registers once:

- `import 'ramme/node'`: `AsyncLocalStorage` (Node ≥ 22, Bun, Deno,
  Cloudflare Workers with `nodejs_compat`; `AsyncContextFrame` on current
  Node);
- `import 'ramme/async-context'`: TC39 `AsyncContext.Variable` where it
  ships (throws at import when it is missing).

`registerContextStorage(impl)` is the seam both use. Propagation is
required (law 3, D9′). Without storage, every frame-needing operation
throws `NoCurrentNodeError`, and the message names the missing import;
there is no synchronous fallback stack and no module-level ambient variable
(D9′). Creation uses the same mechanism synchronously: a factory runs with
a creation frame current, and `inject` reads the creation state from it.
ramme runs its own continuations (body settle reactions, start microtasks,
release steps, timers) under an empty frame, so they inherit neither the
forker's node nor a finished creation.

---

## 7. Package layout

The repository is a pnpm workspace. Its root is the `ramme` package, whose
modules, in `src/`, are these; `packages/eslint-plugin-ramme` is the lint
plugin (§9), a separate package that ramme does not depend on and that does
not import ramme. The package's subpaths (§1.2) are `index.ts` (`ramme`),
the two adapters (`ramme/node`, `ramme/async-context`) and `result.ts`
(`ramme/result`).

| Module | Responsibility |
| --- | --- |
| `context-key.ts` | `InjectionKey`, default factories, key scopes, `setDependencies` |
| `scope.ts` | `Scope`, `createScope`, `SelfScope`, `RootScope`, `RequestScope` |
| `topic.ts` | `createTopic`, `TopicReceiver` |
| `provider-util.ts` | `classProvider`, `factoryProvider`, `valueProvider`, `aliasProvider` |
| `context.ts` | public types: `Context`, `NodeOptions`, `Task`, `Fiber`, `Result`, `Outcome`, `Pool`, … |
| `result.ts` | the `ramme/result` subpath: free functions over plain `Result` objects, `gen`, `$` |
| `resource.ts` | the error classes, `SuppressedErrorCtor`, `toDispose` (the `own` overloads into one dispose) |
| `context-storage.ts` | the `Frame`, the storage contract, `registerContextStorage`, current-frame reads |
| `node.ts`, `async-context.ts` | the two storage adapters (side-effect entries) |
| `internal-context.ts` | shared internal types: node kinds, cache entries (value, storage node, `deps(V)`, pin), the task brand (the marker that identifies a `Task`), failure records (an error and whether it was consumed) |
| `stack.ts` | `Entry`, `Stack`: the two stacks, fixed positions, LIFO release order |
| `managed.ts` | `ManagedPromise`: the freeze decision and the resume step |
| `node-impl.ts` | `NodeImpl`: every node; delivery, body, release loop, release fibers, lending, placement hooks, lifecycle, `fork`/`call`/`attempt`/`all`/`race`/`settle`, awaits, events |
| `pool.ts` | the pool's concurrency queue and intake rules |
| `inject.ts` | `inject`, `ContextKey`, creation state, dependency tracking, the resolution walk, decided markers, placement by view, the value node's creation and placement |
| `fiber.ts` | `task()` |
| `ambient.ts` | the free functions: `current`, `signal`, `lookup`, `own`, `release`, `fork`, `call`, … |
| `lifecycle-events.ts` | `NodeEvent`, `NodeTopic` |
| `create-context.ts` | `createRootContext` |
| `index.ts` | the public surface |

Runtime import graph (type-only imports not shown; no evaluation-order
cycles): `scope`, `resource`, `internal-context` and `context` are leaves;
`result` is a leaf: it imports only types from `context`; `context-key` sits
over `scope` (a key's declared scope, D32); `topic` sits
over `context-key`, and
`lifecycle-events` over `topic`; `context-storage`, `stack` and `pool` sit
over `resource`, and the adapters register into `context-storage`;
`managed` sits over `context-storage`; `inject` over `context-key`,
`context-storage`, `lifecycle-events`, `resource` and `scope`;
`provider-util` over `inject`; `inject` and `pool` never import
`node-impl` at runtime (nodes are created and placed through methods on the
requester); `node-impl` sits over `context-key`, `context-storage`,
`inject`, `internal-context`, `managed`, `pool`, `resource` and `stack`;
`ambient` over `context-storage` and `resource`; `fiber` over `ambient` and
`internal-context`; `create-context` over `node-impl` and `scope`; `index`
re-exports.

---

## 8. Libraries: keys carry their defaults (D5)

A library that defines a key for its own consumption gives it a **default
factory**, so the library works when the application wires nothing, and
the application overrides by providing the key:

```ts
// in the library
export const HttpConfig = createInjectionKey('HttpConfig', { factory: () => ({ timeoutMs: 10_000 }) });
export class HttpClient { readonly #config = inject(HttpConfig); … }

// in the application, or a test
const app = createRootContext({ providers: [valueProvider(HttpConfig, { timeoutMs: 1_000 })] });
```

The default is an auto-hoisted value like any other (§3.3), placed per
tree; a test overrides it with a child's providers or its own root, and
placement by view (§3.4) applies to it. `createRootContext()` installs
nothing process-global.

---

## 9. What is not here

- **The lint rules** ship in this repository as a separate package,
  `eslint-plugin-ramme` (`packages/eslint-plugin-ramme`, §7; D35), whose
  `configs.recommended` turns all seven on as errors:
  `ramme/no-finally-in-async` and `ramme/no-using-in-async` (a `finally` or
  a `using` declaration in an async function, A7, §2.6),
  `ramme/no-timers` (`setTimeout`, `setInterval`, `setImmediate`: bare
  awaits, §4.2, §4.4), `ramme/no-promise-combinators` (every `Promise`
  combinator, stricter than §4.2), `ramme/no-stored-borrow` (a `lookup(…)`
  result in a class field, on `this` or in a module variable, §3.2),
  `ramme/no-owned-provider` (the wiring error of §2.5) and
  `ramme/no-unused-outcome` (a discarded `attempt` or `settle`, §4.5, D31).
  They are syntactic, and the package's README names each rule's
  approximations. A named async function passed to `fork` or `call`
  (`fork(parse)`) has no lint and stays an open gap (D8′). Recommended
  alongside: `@typescript-eslint/no-floating-promises`. A dropped `gen(…)`
  (§4.13) is covered only in part: `ramme/no-unused-outcome` matches
  `attempt` and `settle` only, so it does not flag `gen`;
  `no-floating-promises` flags a `gen(…)` used as a bare expression
  statement, but it needs type information (it is in
  `tseslint.configs.recommendedTypeChecked`, not in `recommended`), and it
  flags neither `void gen(…)` (its `ignoreVoid` option is on by default)
  nor `await gen(…);` with its `Result` discarded, which nothing reports
  (D38).
- **Typed task failures** (D38): a task's failure is `unknown`, as a throw
  is; a failure a caller is meant to branch on is a `Result` the function
  returns (§4.12, §4.13). `ramme/result` has no `Option`, no `match` or
  `tap`, and no `genSync`.
- **kilde's hot layer**, the constructs that hold a subscription or run
  asynchronous work, lives in kilde, built on ramme's public API as tasks
  and as values on a factory's node (D6′).
- **Reference counting** is a pool of size one with a delayed close, outside
  the core.
- **Not provided** (D1′): transferring or detaching an entry; an option
  that would let a node resolve from an ancestor of its owner instead of
  from its owner; propagated non-owning variables.
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
   subtree at once (an `observe` body holds it back from its own subtree
   while it runs, §4.3); completion propagates up.
5. **What code attached is released before what DI provided.** Explicit
   stack, then provided stack, each in reverse order. Nothing is promised to
   references that escaped their scope except that use fails loudly.
6. **No bare callbacks, no bare promises for work.** Every asynchronous hook
   is a fiber; anything that should be a node is a task, which can only be
   forked or called. `Symbol.asyncDispose` is the interop contract, and the
   core runs it as a fiber.

**Invariants.** I1 single owner. I2 a node completes at most once; each
entry's release runs at most once. I3 explicit before provided. I4
unsubscribed entries hear late. I5 LIFO, fixed positions (an entry never
moves, except a declared value's node at the end of its creation, §3.3; a
failure handler's hold releases node entries ahead of passive ones, §4.7).
I6 frozen is final. I7 after completion every operation throws. I8 between
delivery and completion every synchronous operation works, except intake
into a pool (D15). I9 marked before heard. I10 no unhandled rejections from
the core's promises. I11
consumed once or surfaced. I12 aborted is not failure. I13 state decides.
I14 every release is a fiber, current while it runs. I15 synchronous
attachment. I16 nothing but the factory runs in a creation frame: no body,
`run` or other node is entered from it, and a continuation the factory
schedules runs outside it. I17 placement follows dependencies. I18 every
creation-time read is `inject`. I19 decisions are permanent and placement is
by view. I20 fork is asynchronous. I21 the current node is the default
owner. I22 escape fails loudly. I23 every acquisition is releasable early.
I24 only resolution attaches to the provided stack. I25 no bare callbacks.
I26 a lent node rejects body-shaped use. I27 fibers are not awaitable; tasks
are not callable. Each has a named test in `src/invariants.test.ts`; the
last clause of I16 is tested in `src/creation.test.ts`.

**Assumptions.** A1 async context propagation is present. A2 abandoned
promises are collectable. A3 the platform has `AbortSignal.any`/`timeout`,
`Symbol.dispose`/`asyncDispose`, `AggregateError`, `Promise.withResolvers`
(`SuppressedError` is shimmed where missing). A4 one copy of ramme per
realm: two copies keep separate current-node storage and do not see each
other's nodes, which is not supported and not detected. A5 factories are
synchronous. A6 dependencies are acquired before their dependents (by
construction for DI values; by discipline for fibers and values'
releases). A7 bodies do not use `finally` or `using` for cleanup. A8
bodies pass `signal()` on or use managed awaits often enough to freeze
promptly.
