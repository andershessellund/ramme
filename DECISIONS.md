# Decisions

Why ramme is built the way it is, and not some other way. One entry per
decision, in its final form: what was chosen, the alternatives that were
rejected, and the cost accepted. When a decision changes, its entry is
rewritten and the old choice becomes a rejected alternative; git history
keeps the sequence. The `D` numbers are stable identifiers, not an order; a
prime (`D1′`) marks an entry rewritten by the lifecycle and concurrency
redesign, which replaced the context/fiber model of the first extraction
with one tree of nodes, tasks, and freeze-on-interrupt.

How the mechanisms work is [DESIGN.md](DESIGN.md)'s job; an entry here
states the decision and points there. ramme is the extraction of the
DI/fiber/lifecycle core of a private monorepo package (internally
"spindle"); entries note where a choice was inherited from that lineage.
Choices made while implementing the redesign are cited by their number in
the implementation plan (`plan D-nn`), where the measured reasoning is kept.

## Shape

### D1′. One tree, and fibers are in it

ramme is one package whose tree of nodes is at once the resolution scope,
the execution scope and the lifetime. Contexts, fibers, pools, release
fibers and the nodes of DI values are all nodes, differing in three bits
(has a body; subscribed; interrupt mode). A node's resolution parent is an
ancestor-or-self of its lifetime owner; by default they are the same node.
The layering survives as module structure (keys/scopes and storage under
the node, the fiber surface over it), not as package boundaries.

**Why.** Auto-hoisting already answers "where may this value be cached?"
with "at the deepest context whose values it consumed", which is a lifetime
answer: placement *is* lifetime assignment. One tree in which ancestors
outlive descendants and you resolve only from ancestors makes untyped
ambient DI safe: everything you can resolve outlives you. Effect gets the
same guarantee from its type system (a resource's `Scope` in the `R`
channel), which is what lets it keep the fiber tree and the scope tree
apart; ramme has no `R` channel, so structure must do the tracking, and one
tree is the smallest structure that does. Fibers are inherent rather than a
layer: the core's one asynchronous act is release, and a release needs a
node to run in (a deadline to read, a place to acquire, a place to be seen),
and a node running a body is a fiber. What is *not* conflated is execution
history with lifetime: the fiber that runs a factory does not own what it
builds; placement does. **Rejected:** three packages (scope tree, DI,
fibers), a version-skew and plugin-API cost with one client per seam;
fibers as a separate package over a public tree API, when the core needs
fibers for its own releases; a tree that registers every object, when most
objects are values and a resource is an entry, a property of a
relationship. **Cost.** Cross-lifetime communication is explicit data: a
long-lived actor cannot `lookup` request-scoped values, it receives a
payload; propagated non-owning variables (Effect's `FiberRef`) are not
provided. DI-only consumers carry fiber code (tree-shaking mitigates).
DESIGN.md §1, §2.

### D2. The name: ramme

**Why.** Danish for *frame*, in the family of kilde, valsem, spor. A
context is literally a ramme: "inden for rammerne af", within the frame of,
is what scoped resolution means, and the frame metaphor covers all three
faces (a frame you resolve in, run in, and that is torn down as one). The
internal codename "spindle" was English in a Danish-named ecosystem, and
its best Danish rendering (*spindel*) is taken on npm. **Accepted:**
one-letter adjacency to the sibling package `samme`; they are different
domains (codec vs DI) and rarely meet in an import block. Extraction-time
decision.

### D3′. One release contract: `[Symbol.asyncDispose]`

The resource protocol is the platform's: an entry is an `AsyncDisposable`
(a `Disposable` is accepted and wrapped), and `own(value, release)` and
`own(deferFn)` are sugar that build one. A node releases in one sequence:
signal, explicit stack LIFO, provided stack LIFO. Every release runs in a
release fiber, current while it runs, whose signal is the deadline.

**Why.** The four versioned lifecycle symbols (`ramme.drain/flush/dispose/
abort.v1`) and three tree-wide phases existed so that a resource could
drain, then flush, then dispose. Under the redesign each of those has a
better home: draining is a subscribed `observe` task that stops intake and
settles; flushing before disposal is release order (what was acquired later
releases first); a deadline is the release fiber's `signal()`. With those
gone, a ramme-specific protocol would only cost interop: `await using`,
platform resources and every library that already implements
`Symbol.asyncDispose` are entries with no adapter. The release fiber gives
every release, ramme-native or foreign, a place to read the deadline,
acquire temporaries and see `owner.outcome` (D16). **Rejected:** the `.v1`
symbol set with tree-wide phases (the previous D3), which made every node's
shutdown wait for the slowest drain in the tree and needed "lifecycle
fibers" only when observed; keeping phases beside `asyncDispose`, two
protocols for one act. **Cost.** No separate flush phase: a resource that
must flush before a sibling closes expresses it by acquisition order or
inside its own release. DESIGN.md §2.4.

### D6′. kilde depends on ramme

kilde is the reactive library for ramme applications: it depends on ramme
and is written in its idiom; ramme never imports kilde. kilde's cold core
(signals, computeds, operators, channels) needs no lifetime and changes
little. Its hot layer is rewritten on ramme: hot constructs attach to the
current node, async callbacks are tasks (a derivation is a fiber; the
previous one is aborted and frozen when its input changes; failures have
destinations), and async states are values on a factory's node. kilde's
`Owner` seam, `createOwner`, `withOwner`, `installOwnerProvider` and its
staleness counters are removed.

**Why.** The previous arrangement kept kilde dependency-free and reached
lifecycle through an `Owner` seam served over lookup-api, which needed a
neutral contract layer, a bridge, and a `ramme/kilde` integration entry to
glue them. Once lookup-api was retired (D5) the seam had one implementation
and was only an indirection; and the hot layer's correctness (aborting a
stale derivation, never leaking a subscription) is exactly what ramme's
tasks, freeze and ownership provide. **Rejected:** the previous D6 (kilde
dependency-free; async-DI glue deferred to a `ramme/kilde` entry point);
kilde depending on a ramme-neutral lifetime interface, a second seam with
one implementation. **Cost.** kilde's hot layer cannot be used without
ramme; its cold core still can. Specified in kilde's own proposal.
DESIGN.md §1.1.

### D8′. A fiber is one run of a task, and the ambient node is the default

A **task** (`task(body, opts)`) is a body plus options; it is an object,
not a function, and can only be `fork`ed or `call`ed, each run being a new
fiber, a child of the current node. A **fiber** is a node with a body; it
is not thenable (`join`/`result` read it). The operations are free functions
over the **current node** (`fork`, `call`, `own`, `lookup`, `join`, …); the
same operations exist as `Context` methods for the one case that needs a
name: acting on behalf of a node that is not current.

**Why.** "A fiber is a child context" (the previous D8) was the
load-bearing unification and is kept, strengthened: every fiber is a node,
so its temporaries are released when it ends, it is interruptible and
visible, and it is found ambiently. The redesign closes the two gaps the old
API left. An async function used as a fiber could also be called bare,
running as an untracked promise; a `Task` cannot be invoked, so the
decision "this is a node" is made once, at the definition. And
`Fiber.spawn(fn, { context })` threaded the parent through every call
site; the ambient node makes the parent the current node by default (I21),
which is never wrong, only sometimes not what was meant, and the method form
exists for that case. Inline bodies are accepted as anonymous tasks.
**Rejected:** the `Fiber` namespace (`Fiber.call/spawn/fork/join/all`),
`fiber.promise` (a bare promise for work), `withAbortSignal`/
`linkAbortSignal` (replaced by `signal()` and the `signal` option);
requiring `task()` for inline bodies too. **Cost.** A node per fiber
(fibers are not free); application code must decide function vs task at
the definition. DESIGN.md §4.5–§4.9.

## Semantics

### D4′. `inject` is a dependency, `lookup` is a borrow; `lookup` is banned in creation

`inject(K)` returns a dependency of the value under construction: legal only
during creation, tracked, and it decides placement for auto-hoisted values.
`lookup(K)` returns a borrow for the current node: legal anywhere a node is
current *except* creation, where it throws `CreationViolationError`. The
value's own node (`inject(ContextKey)`, `current()` in creation) is excluded
from tracking. Tracked reads decide placement only for auto-hoisted values;
a value with a declared placement (a provider target or a scope) stays where
it was declared, and its author answers for what it holds.

**Why.** The verbs are distinguished by the lifetime their result must
meet, not by timing. A dependency must live at least as long as the value,
whose lifetime is not known until placement, and is met by moving the value
down to its deepest dependency; a borrow must live at least as long as the
current node, which is fixed, and is met by resolving upward from it. During
a factory the only invocation a borrow could be measured against is the
factory call itself, so a creation-time borrow could only mean "use this
while constructing and don't keep it", and nothing legitimate survives that
description: a read whose result shapes the product is a dependency, and a
read that does not (logging the construction) is either scope-invariant,
where tracking is free, or mislabelled telemetry (a root singleton stamped
with one request's id), whose fix is a scope on the key. Banning rather than
silently tracking means nothing a borrow returned can end up on `this`, and
the two verbs keep disjoint meanings. **Rejected:** the previous split
(`lookup` untracked in creation), whose documented hazard baked one scope's
answer into a shared value; the previous planned convergence (track every
creation-time read), which keeps the hazard's shape and blurs the verbs;
an `untracked` verb, which gives placement to the caller. **Cost.** A helper
written for bodies cannot be called from a factory and must be handed its
dependencies, which is what a factory should be doing anyway. DESIGN.md
§3.2, §3.5.

### D7. Auto-hoisted values store at the deepest tracked dependency (amended)

A default-factory value with no declared placement is cached on the deepest
node that served one of its `inject`ed dependencies, clamped by the nearest
`captureAutoScoped` node; nodes below share it. The tracker also records
`deps(V)`, the keys `V` injected plus the `deps` of each injected
auto-hoisted value, which D10′ uses; the value's own node is untracked (D4′);
reads place only auto-hoisted values.

**Why.** Inherited from the lineage and kept: it makes "placement follows
dependencies" (I17) mechanical, sharing as wide as dependencies allow and
never wider, without per-key scope annotations. `captureAutoScoped` exists
for harnesses (a test node that must not leak instances upward) and is
internal. Because creation-time reads are all `inject` (D4′) and factories
are synchronous, `deps(V)` is complete when `V` is placed. **Cost.**
Placement depends on what a factory injected on its run; a factory whose
dependency set varies by input gets that run's placement, and a re-created
value that lands where an instance already exists is discarded in favour of
the existing one (with a development warning). Declared scopes are the way
out. DESIGN.md §3.3.

### D9′. Async context propagation is required

The current node reaches across `await` only through the platform's async
context: `import 'ramme/node'` (`AsyncLocalStorage`) or
`import 'ramme/async-context'` (TC39 `AsyncContext`). There is one ambient
mechanism, a frame in that storage; creation uses it synchronously. Without
an adapter every frame-needing operation, including the first factory run,
throws `NoCurrentNodeError` whose message names the import; there is no
synchronous fallback stack (plan D-02). There is no default root either:
`createRootContext()` is one line and is where shutdown lives.

**Why.** The ambient idiom (`lookup`, `own`, `fork`, `signal()` with nothing
passed) is what makes application code read like ordinary JavaScript, and
it is only sound if the current node survives `await`. That is a platform
fact, not a choice: native `await` resumes a function in a job that
userland cannot wrap. Every server runtime has propagation today
(`AsyncLocalStorage` on Node ≥ 22, Bun, Deno, Workers with `nodejs_compat`;
`AsyncContextFrame` on current Node makes it cheap); browsers get it when
AsyncContext ships or through a build-time async-to-generator transform.
The previous default, a synchronous stack that honestly lost context at the
first `await`, was half an idiom: code that worked until its first await.
It also left a bleed surface (`enterSync` without `leaveSync`) and needed a
separate module-level creation stack, both removed. Side-effect imports
remain the idiom for "register a platform binding once"; `sideEffects` in
package.json names exactly those two files. **Rejected:** the synchronous
default (the previous D9); a Zone-style polyfill; a silent default root,
which would hide the "where does this die?" question the design asks.
**Cost.** Browsers without AsyncContext are unsupported except through a
transform; forgetting the import fails at the first ambient operation, with
the fix in the message. DESIGN.md §6.

### D10′. Permanent decisions and placement by view

Two rules replace the probabilistic resolution memo and the negative memo at
the auto-scope root. **Decided markers:** when a requester resolves `K`,
every node on the walk, up to and including the one that answered, marks
`K` decided, whether the answer was a value or "not provided here", and for
an auto-hoisted answer `V` every key in `deps(V)` too; `addProvider(K)` at
a node where `K` is decided throws `PlacementError`, and a fresh child has
no decisions, so providing at construction is always allowed. **Placement
by view:** a
cache hit on auto-hoisted `V` at `S` is not requester `R`'s answer when a
key in `deps(V)` is provided strictly between `R` and `S`; `V`'s factory
runs from `R` and the result is placed by `R`'s view.

**Why.** The old tombstone stopped a context from *providing* a key it had
answered for, which is right, and also stopped the root from
*instantiating* a value some descendant had placed lower, which was the
order-dependent "No provider found" at the root. Decisions keep the correct
half. Placement by view makes overrides compose: a default factory may
inject request-scoped things, land at the request context, and be
overridden by a request context that provides one, and two instances on one
path are two consistent views, arising only where someone deliberately
provided a dependency at two levels. No node ever changes an answer it has
given; no requester is served a value built from a view of its dependencies
other than its own; both hold in every order of resolution. **Rejected:**
forbidding shadowing (R-a), which also forbids the natural override of a
request-flavoured default; "auto-hoisted keys only at the root", which
equates a default factory with living at the root; an error on a cache hit
across a shadow (R-b), whose error is order-dependent unless paired with a
second-placement check and which treats two consistent instances as a
fault. **Cost.** Two instances on one path where a dependency is provided
twice; a `Set` lookup per node on each walk. DESIGN.md §3.4.

Settled while implementing it:

- *The memo lands at the requester's own placement* (plan D-20). The rebuilt
  value is cached at `S′`, the placement `R`'s view computes: `R` itself when
  `R` provides the shadowing key, otherwise the node strictly between `R`
  and the shadow where its deepest dependency lives. Every requester under
  `S′` with the same view shares it, which is the rule's "memoized at `R`"
  for every one of them.
- *`deps(V)` records optional misses* (plan D-43). "K is not provided" is as
  much a part of `V`'s view as a value: without it a fresh child providing
  `K` would be served a `V` built without `K` across a shadow nobody could
  see.
- *A scope-owning node shadows a scoped dependency* (plan D-44, amended by
  D-93). A node between `R` and `S` that owns the effective scope of some
  `d ∈ deps(V)` (`SelfScope` excluded) changes `R`'s view of `d` exactly as
  a provider would, so it is a shadow too. The effective scope is the
  provider's, else the key's.
- *A DI value's node has its own event kind, `'value'`* (plan D-52). It is
  the one node kind whose placement the design explains; emitting it as a
  context would hide it in `node:created`/`node:placed`/`node:complete`.

### D11. `call` lends the current node, never the receiver

`call` (and `all`, `race`, which are calls) records `lentTo` on the node
that was current when it ran, and that node's body-shaped operations throw
`UnawaitedCallError` until the call settles (the child completes, its
releases included); `own`, `release`, `abort`, `close` and the `Symbol`
methods do not. With no current node, nothing is lent. (plan D-03)

**Why.** The awaiting body is the one that is supposed to be suspended on
the call's promise, so it is the one whose further use means the `await`
was forgotten; that replaces the old stack-top enforcement with one field
that works after any number of awaits. Lending the receiver instead would
make `app.fork(...)` from a platform callback throw while a top-level
`await app.call(main)` runs, the exact shape of a server's main loop.
Attaching and cancelling stay open, because another party (a producer
granting a lease, a signal handler) may legitimately do them while the
body waits. **Rejected:** lending the receiver; no detection (a forgotten
await on a call silently runs two bodies on one node). **Cost.** One more
error a newcomer meets; `Promise.all([call(a), call(b)])` is refused and
must be `all([...])`. DESIGN.md §4.9.

### D12. The birth rule: delivered at birth iff the parent would have forwarded

A `freeze` child born under a delivered parent is delivered at birth iff the
parent would have forwarded to it: under a delivered `freeze` parent yes,
under a delivered `observe` parent no. A `restore` child is delivered at
birth when an ancestor on its subscription path is delivered. An `observe`
child never is. (plan D-05)

**Why.** Reading the mode table literally (a `freeze` child is "delivered at
birth" under any delivered parent) would make behaviour depend on whether a
handler was forked before or after the shutdown signal: a server in
`observe` mode draining its connections would see handlers forked before the
signal keep running and handlers forked after it freeze at once. The design
is order-independent everywhere else (D10′), so the rule is phrased as the
forwarding rule applied at birth. **Cost.** A `freeze` fiber forked into a
draining `observe` region runs until its parent's own exit interrupts it.
DESIGN.md §4.3.

### D13. Freeze: only managed awaits freeze, and delivery is consumption

Interruption stops work by making the body's next **managed await** (an
await on a promise ramme produced) never settle; the body never resumes and
is abandoned, and its node's stacks are released by the runtime. The
decision is made for the awaiting body's node. A managed await already in
flight is cut at delivery and the body counts as frozen at once; "in
flight" means its `then` was called, which ramme's promise subclass
observes, so a stored, un-awaited managed promise does not freeze the body
at delivery and freezes it the moment it is awaited. (plan D-06)

**Why.** Cooperative cancellation (the body unwinds and throws `AbortError`)
requires every body to clean up correctly on a path it rarely runs, through
`finally` blocks that also run on success; freeze removes cleanup as
control flow entirely, because acquisition is ownership (law 1) and the node
releases what the body owned. Only promises ramme produced can freeze,
because only they can be decided at `then` time; everything else is a bare
await and completes normally, and `signal()` and `managed(p)` bring foreign
work in. With no current node (top level, a platform callback) nothing can
freeze, so `app.abort()` from a signal handler rejects a top-level
`await app.call(main)` and the process's `await using` cleanup runs.
**Rejected:** cooperative cancellation; freezing at delivery regardless of
what the body awaits (a body in plain code between delivery and its next
managed await is legitimately running, I8); deciding for the node a method
was called on (it would freeze the top-level await forever). **Cost.** A
`freeze` body that never reaches a managed await never freezes; the
mitigation is diagnostic (`node:stalled`). Combinators that resume a body
while one of its managed promises is pending (`Promise.race`,
`Promise.allSettled`, a `.then` attached without awaiting) are unsupported
in `freeze` bodies and warned about in development. DESIGN.md §4.2.

*Delivery is consumption, and sources never reject* (plan D-38). Every
managed promise wraps a source that never rejects (a node's `completion`,
an entry's `done`, the delivery promise) plus a `deliver` step that runs
only when an awaiting continuation is actually resumed, in `then`; that step
is where an awaited value is produced, an error thrown to the awaiter, and
a failure consumed. A frozen awaiter therefore consumes nothing, and the
failure surfaces from its parent (I11); a stored, never-awaited `join`,
`result` or `call` consumes nothing; and no ramme-internal promise can be an
unhandled rejection whether or not it is ever awaited (I10). The one
wrapper over a user promise, `managed(p)`, has no `deliver` step and leaves
`p`'s handled-ness to its owner.

### D14. A `'join'` fork onto a bodiless node is refused

`fork` with the default `'join'` destination onto a live bodiless node that
is not a pool (`root.fork(t)`, `child().fork(t)`) throws `TypeError` at the
call. In a constructor the fork is recorded and checked when the factory
returns, so `own(fork(...))` and a fork with `onFailure` are accepted, and
an unowned `'join'` fork fails the resolution synchronously with the
pending node released. (plan D-15)

**Why.** A `'join'` failure is held until something joins it or the parent
completes; on a bodiless node nothing joins it until shutdown, so a failure
would wait silently for the life of the process. Refusing makes the author
choose: a handler, `'link'`, a body to fork from, or a pool. In a
constructor the check cannot run at the call, because `own(fork(...))` (an
owned reaper, the service idiom) makes the fork unsubscribed only after
`fork` returns. **Rejected:** accepting and surfacing at shutdown; checking
constructor forks at the call, which would refuse the reaper idiom.
**Cost.** One more error on the first `root.fork(t)`; the message names the
alternatives. DESIGN.md §4.7.

### D15. Pool intake stops at the signal

`pool.fork` throws `PoolClosedError` once the pool is delivered or `close()`
was requested, and `NodeCompletedError` after completion. (plan D-16)

**Why.** A deliberate exception to I8 (operations work between delivery and
completion) for intake infrastructure: a fiber forked into a delivered
`freeze` pool would be born delivered and freeze at its first managed await,
which is work accepted only to be thrown away. A pool that is closing is
closing its intake; the caller learns it at once. **Cost.** A producer that
races shutdown must handle `PoolClosedError`. DESIGN.md §4.10.

*Accounting counts only the pool's own fibers; abort stops the queue, close
drains it* (plan D-47). `running` and `pending` move only for fibers the
pool admitted, never for release fibers, DI values placed on the pool or
passive `pool.own(x)` entries. Once the pool is delivered no waiter starts
and the queued ones settle `aborted` without running; under `close()`
waiters still start as slots free, because a graceful close waits for the
pool's work, and the queue is that work.

### D16. What the release order guarantees

A node releases its explicit stack, then its provided stack, each in
reverse order. **G1** anything read from a node's provided values stays
alive until every explicit entry on that node has completed; **G2** explicit
entries release in reverse attachment order, which is dependency order iff
a fiber uses only what was attached before it was forked; **G3** provided
values release in reverse creation order, which is dependency order because
`inject` runs during creation; **G4** interruption reaches the whole
subscribed subtree at once. Not guaranteed: order among subscribers during
the signal; anything about a reference that escaped to a longer-lived
scope, except that use fails loudly.

**Why.** Provided values are registered lazily, at a time the body author
does not control: a handler forked before the pool existed may be the one
whose `lookup` creates it. Only "explicit before provided" makes G1
unconditional; LIFO within each stack gives dependency order wherever
dependencies were acquired first (A6), by construction for DI values and by
discipline for fibers. The previous three tree-wide phases gave weaker,
global ordering at the cost of every node waiting for the slowest drain.
**Rejected:** one merged stack in attachment order (a lazily created service
would be released before the handlers that read it); phases (D3′).
**Cost.** Two disciplines the type system cannot check: acquire before you
fork what uses it (G2), and a value's release uses only what it injected
(G3). Providing a body-owned resource on the same node points a dependency
from the provided stack into the explicit stack; a lint rule flags it.
DESIGN.md §2.4, §2.5.

Settled while implementing it:

- *The outcome is fixed at settling and amended once at completion* (plan
  D-08). Classification by state runs when the body settles or freezes;
  release and unconsumed errors are folded in once, when the node completes.
  This is what makes `owner.outcome` readable in every release, so a
  transaction entry can commit or roll back on its owner's outcome.
- *A release is idempotent by its entry's state, and its promise exists
  before any dispose code runs* (plan D-36). A second release of an entry
  (`releaseAll()` racing `release(x)`, an `abort()` arriving mid-
  `releaseAll()`, a dispose that synchronously re-enters its owner) finds
  one release in flight and one promise to share (I2, C4, C7).
- *`own(x)` with one argument is a no-op on an object this node already
  owns; C8 is about a second release* (plan D-37). One argument asks "make
  sure this node owns `x`", which is already true when a producer attached
  it on the body's behalf, so `own(await pool.acquire())` reads as written;
  `own(x, release)` asks to register a release, and a second one for one
  object is `AlreadyOwnedError`. Cross-node duplicates of a passive object
  are not policed: each owner runs its dispose once.
- *Every node routes its final failure to its parent* (plan D-40). A child
  context, a pool or a DI value's node whose release fails completes with
  `failure`, and that failure is held by its parent exactly as a `'join'`
  fiber's is, so "every unconsumed subscriber failure" surfaces and nothing
  is lost; a delivered `close()`/`[Symbol.asyncDispose]()` on it consumes
  it.
- *An early release's error is unconsumed until `release(x)` delivers it*
  (plan D-41). The error rejects that call only when the call's awaiter is
  actually resumed; if it froze or never awaited, the error surfaces from
  the owner's completion instead of nowhere. An owner whose release loop
  ends while such an awaiter is still waiting completes only after the
  awaiter is resumed or frozen, so the error is reported once (plan
  D-123). The call counts as awaited from its creation, so an `await` or
  combinator applied to it at once is waited for too, even when the
  release has already failed synchronously (plan D-127).

### D17. Three error types beyond the core set

Besides `NoCurrentNodeError`, `NodeCompletedError`, `PendingNodeError`,
`NotOwnedError`, `AlreadyOwnedError`, `UnawaitedCallError`,
`FiberNotAwaitableError`, `FiberAbortedError`, `PoolClosedError`,
`CreationViolationError`, `AsyncRunError` and `PlacementError`, ramme
exports `PoolFullError` (for `whenFull: 'reject'`), `OwnerInterrupt` (the
abort reason ramme itself produces when a parent's body exits or an entry
is released at its turn, so `signal.reason` is inspectable) and
`FactoryReturnedUndefinedError extends CreationViolationError` (a factory
returned `undefined`). (plan D-01)

**Why.** `PoolClosedError` would be wrong for a pool that is open but full;
a reason a listener can test with `instanceof` is better than a generic
`AbortError` when the interrupt came from structure rather than from a
caller; and a subclass gives the undefined-factory rule a class without
changing `instanceof CreationViolationError` checks. **Cost.** Three more
names in the surface. DESIGN.md §4.12.

## Integration

### D5. The lookup-api bridge (retired)

ramme no longer serves lookup-api contracts: there is no bridge, no
`contractKey`/`contractProvider`, no `installContractResolver`, and
`createRootContext()` installs nothing process-global. ramme has no runtime
dependencies. What survives is lookup-api's one discipline, as a convention:
**a key a library defines for its own consumption carries a default
factory**, so the library works when the application wires nothing, and
the application overrides by providing the key.

**Why.** lookup-api existed so that a library could read ambient services
without committing to ramme, through a neutral seam ramme would serve.
There is no such library: every library in this ecosystem depends on ramme
(D6′), and a neutral seam with one implementation is only an indirection,
one that also cost ramme a hard dependency (and a `link:` publish blocker)
and a process-global resolver installed from `createRootContext`.
Everything lookup-api offered beyond the default-factory discipline is
already a ramme feature, done better: a default is placed per tree instead
of memoized per process; a test overrides with a child's providers instead
of a frame; placement by view (D10′) keeps an override from being baked into
a hoisted value, which is what lookup-api's frame masking was for; and
attribution (answering only calls ramme can claim) is moot when there is
one container. **Rejected:** keeping the bridge for hypothetical
ramme-neutral libraries; unifying contract fallbacks with default factories
(the bridge's deferred step), which would have kept the seam alive for no
consumer. **Cost.** A library cannot be ramme-neutral and still resolve
ambient services; if such a library appears, the seam can be rebuilt as a
separate package over `registerContextStorage` and keys. DESIGN.md §8.
