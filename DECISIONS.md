# Decisions

Why ramme is built the way it is, and not some other way. One entry per
decision, in its final form: what was chosen, the alternatives that were
rejected, and the cost accepted. When a decision changes, its entry is
rewritten and the old choice becomes a rejected alternative; git history
keeps the sequence. The `D` numbers are stable identifiers, not an order; a
prime (`D1′`) marks an entry rewritten by the lifecycle and concurrency
redesign, which replaced the context/fiber model of the first extraction
with one tree of nodes, tasks, and interruption at managed awaits (first as
a freeze, D13, since as a sticky rejection, D39).

How the mechanisms work is [DESIGN.md](DESIGN.md)'s job; an entry here
states the decision and points there. ramme is the extraction of the
DI/fiber/lifecycle core of a private monorepo package (internally
"spindle"); entries note where a choice was inherited from that lineage.
The guarantees G1–G4, contracts C1–C8, invariants I1–I27, assumptions
A1–A8 and the numbered design laws cited here are defined in DESIGN.md
§2.5, §2.6 and §10.

Choices settled while implementing the redesign are recorded in the entry
they refine, in its text or under "Settled while implementing it". The
redesign was specified in PROPOSAL.md and planned in IMPLEMENTATION.md;
both were removed once it was implemented and remain in git history (added
in commit 72a0448, last revised in 19759ae). Every decision here is
complete without them. Source comments and test names still cite those two
documents by section (`§n`), plan decision (`D-nn`), probe (`Pn`) and open
question (`Qn`); read those against 19759ae, not against DESIGN.md.

## Shape

### D1′. One tree, and fibers are in it

ramme is one package whose tree of nodes is at once the resolution scope,
the execution scope and the lifetime. Contexts, fibers, pools, release
fibers and the nodes of DI values are all nodes, differing in three bits
(has a body; subscribed; interrupt mode). A node has one parent, which is
both what it resolves from and the owner that releases it and waits for it.
An entry stays on the stack it was attached to until it is released: there
is no detach and no transfer between owners. The layering survives as
module structure (keys/scopes and storage under the node, the fiber surface
over it), not as package boundaries.

**Why.** Auto-hoisting already answers "where may this value be cached?"
with "at the deepest context whose values it consumed", which is a lifetime
answer: placement *is* lifetime assignment. One tree in which ancestors
outlive descendants and you resolve only from ancestors makes untyped
ambient DI safe: everything you can resolve outlives you. Effect, a
TypeScript effect system, gets the same guarantee from its type system: the
type of every computation lists the services it still needs (its `R`
parameter), and acquiring a resource adds a `Scope` to that list, so the
compiler refuses to run it where no scope encloses it. That is what lets
Effect keep the fiber tree and the scope tree apart; ramme has no such type
parameter, so structure must do the tracking, and one tree is the smallest
structure that does. One parent for both roles is what makes the argument
mechanical, and it is why an entry cannot move: a node handed to a
longer-lived owner would outlive the ancestors it resolved its borrows from,
and a passive entry's release may read the outcome of the owner it was
attached to (D16); a detached entry would have no owner to release it (law
1). Fibers are inherent rather than a layer: the core's one asynchronous act
is release, and a release needs a node to run in (a deadline to read, a
place to acquire, a place to be seen), and a node running a body is a fiber.
What is *not* conflated is execution history with lifetime: the fiber that
runs a factory does not own what it builds; placement does. **Rejected:**
three packages (scope tree, DI, fibers), a version-skew and plugin-API cost
with one client per seam; fibers as a separate package over a public tree
API, when the core needs fibers for its own releases; a tree that registers
every object, when most objects are values and a resource is an entry, a
property of a relationship; a resolution parent separate from the owner (an
option to resolve from one of the owner's ancestors), which would be sound,
since those outlive the owner, but which nothing needs, so it is left out;
transferring or detaching an entry. **Cost.** Cross-lifetime communication
is explicit data: a long-lived actor cannot `lookup` request-scoped values,
it receives a payload; propagated non-owning variables (Effect's `FiberRef`,
a per-fiber variable that child fibers inherit) are not provided. A resource
cannot be handed from a short-lived owner to a longer-lived one: the
longer-lived one acquires it (a producer that takes an `owner`, DESIGN.md
§2.6). DI-only consumers carry fiber code (tree-shaking mitigates).
DESIGN.md §1, §2.

### D2. The name: ramme

**Why.** Danish for *frame*, like the Danish names of its sibling packages
(kilde, the reactive library of D6′; `samme`, a codec). A context is
literally a ramme: "inden for rammerne af", within the frame of, is what
scoped resolution means, and the frame metaphor covers all three faces (a
frame you resolve in, run in, and that is torn down as one). The internal
codename "spindle" was English in a Danish-named ecosystem, and its best
Danish rendering (*spindel*) is taken on npm. **Accepted:** one-letter
adjacency to `samme`; they are different domains (codec vs DI) and rarely
meet in an import block. Extraction-time decision.

### D3′. One release contract: `[Symbol.asyncDispose]`

The resource protocol is the platform's: an entry is an `AsyncDisposable`
(a `Disposable` is accepted and wrapped), and `own(value, release)` and
`own(deferFn)` are sugar that build one. A node releases in one sequence:
signal, explicit stack LIFO, provided stack LIFO. Every release runs in a
release fiber, a node current while it runs, in `observe` mode, whose
signal is the deadline.

**Why.** The four versioned lifecycle symbols
(`ramme.drain/flush/dispose/ abort.v1`) and three tree-wide phases existed
so that a resource could drain, then flush, then dispose. Under the redesign
each of those has a better home: draining is a subscribed `observe` task
that stops intake and settles; flushing before disposal is release order
(what was acquired later releases first); a deadline is the release fiber's
`signal()`. With those gone, a ramme-specific protocol would only cost
interop: `await using`, platform resources and every library that already
implements `Symbol.asyncDispose` are entries with no adapter. The release
fiber gives every release, ramme-native or foreign, a place to read the
deadline, acquire temporaries and see `owner.outcome` (D16), and because it
is a node, a trace of the running tree and what each node awaits covers
shutdown with no separate mechanism. It runs in `observe` mode because a
release past its deadline must be told, not stopped: a release cut short
leaves its resource half-released, and nothing else would finish it, since
the owner runs each release once (C4) and waits for it (D21). **Rejected:**
the `.v1` symbol set with tree-wide phases (the previous D3), which made
every node's shutdown wait for the slowest drain in the tree and ran a phase
call in a fiber (a "lifecycle fiber") only when a topic receiver was
observing; keeping phases beside `asyncDispose`, two protocols for one act;
a release stopped at its deadline. **Cost.** No separate flush phase: a
resource that must flush before a sibling closes expresses it by acquisition
order or inside its own release. Every release of every entry, a passive
`own(x)` included, creates a node, an `AbortSignal` (a timeout, or one that
never fires) and its events. DESIGN.md §2.4.

### D21. The parent waits; a deadline is a signal

A node does not complete until every entry on its stacks has completed,
however long that takes; nor before its body has unwound after an
interruption, and every shield it started has completed (D39).
`releaseTimeoutMs` (none by default) only sets the signal of the node's
release fibers and shields (D3′, D39), and `timeoutMs` only delivers to the
node; nothing abandons a child, a release or a shield. `[Symbol.dispose]()` on a
root throws `TypeError`, because a root has no owner to wait for its
completion.

**Why.** Abandoning a child at a deadline would let its parent, and then the
parent's ancestors, release the values the child still uses: G1–G3 hold
only because completion waits. The same holds for a body still unwinding
after its interruption and for a shield it started, awaited or not (D39): a
foreign `finally` or a rollback may use anything the node holds. An abandoned release leaves its resource
half-released with nothing responsible for it, against law 1. Only the
child can stop safely, so the deadline goes to the child, and a child that
does not stop is a defect that is reported (`node:stalled`), not hidden.
There is no default release deadline because no single value fits every
resource (a flush may rightly take minutes), and a default would signal
resources that are working correctly; a deadline is policy, set where the
budget is known. A synchronous `[Symbol.dispose]()` aborts and returns, and
on a child the owner's completion still waits for it; on a root nothing
would, so `using root` would leave the tree releasing unobserved, with its
failures reported to no one. **Rejected:** abandoning a child or a release
after its deadline; a default release deadline; a root
`[Symbol.dispose]()` that aborts and returns. **Cost.** A stuck release
hangs shutdown indefinitely, and so does a body whose unwind awaits a driver
that never answers, which no release deadline reaches (D39); the
mitigations are `node:stalled` and whatever supervises the process.
DESIGN.md §2.1, §2.7, §2.8.

### D6′. kilde depends on ramme

kilde is the reactive library for ramme applications: it depends on ramme
and is written in its idiom; ramme never imports kilde. kilde's cold core
(signals, computeds, operators, channels) needs no lifetime and changes
little. Its hot layer, the constructs that hold a subscription or run
asynchronous work and so must be torn down, is built on ramme: hot
constructs attach to the current node, async callbacks are tasks (a
derivation that recomputes asynchronously is a fiber; the previous one is
aborted when its input changes, and unwinds at its next managed await;
failures have destinations), and the state of an asynchronous value lives
on a factory's node. kilde's own lifetime seam is removed: an `Owner`
interface that a host installed (`installOwnerProvider`) and kilde created
and entered (`createOwner`, `withOwner`), and the counters kilde used to
discard the late result of a superseded derivation, which an aborted fiber
never delivers: its outcome is `aborted` by state (D24).

**Why.** The previous arrangement kept kilde dependency-free and reached
lifecycle through that `Owner` seam, a provider hook kilde kept on
`globalThis` so that a host could install itself; the plan was to serve it
over lookup-api (D5), which would have needed a neutral contract layer, a
bridge, and a `ramme/kilde` integration entry to glue them. Once lookup-api was retired the seam had one
implementation and was only an indirection; and the hot layer's correctness
(aborting a stale derivation, never leaking a subscription) is exactly what
ramme's tasks, interruption and ownership provide. **Rejected:** the previous D6
(kilde dependency-free; async-DI glue deferred to a `ramme/kilde` entry
point); kilde depending on a ramme-neutral lifetime interface, a second seam
with one implementation. **Cost.** kilde's hot layer cannot be used without
ramme; its cold core still can. How each kilde construct maps onto ramme is
kilde's design, documented with kilde; ramme commits only to what this entry
states, and nothing in ramme is kilde-specific. DESIGN.md §1.1.

### D8′. A fiber is one run of a task, and the ambient node is the default

A **task** (`task(body, opts)`) is a body plus options; it is an object,
not a function, and can only be `fork`ed or `call`ed, each run being a new
fiber, a child of the current node. A **fiber** is a node with a body; it
is not thenable (`join`/`result` read it). The operations are free functions
over the **current node** (`fork`, `call`, `own`, `lookup`, `join`, …); the
same operations exist as `Context` methods for the one case that needs a
name: acting on behalf of a node that is not current.

**Why.** "A fiber is a child context" (the previous D8) was the load-bearing
unification and is kept, strengthened: every fiber is a node, so its
temporaries are released when it ends, it is interruptible and visible, and
it is found ambiently. The redesign closes the two gaps the old API left. An
async function used as a fiber could also be called bare, running as an
untracked promise; a `Task` cannot be invoked, so the decision "this is a
node" is made once, at the definition. And `Fiber.spawn(fn, { context })`
threaded the parent through every call site; the ambient node makes the
parent the current node by default (I21), which is never wrong, only
sometimes not what was meant, and the method form exists for that case.
Inline bodies (`call(async () => …)`) are accepted as anonymous tasks,
because an inline arrow has no name by which it could also be called bare;
the gap is a named function used both ways. A fiber is not thenable because
awaiting is where ramme decides interruption and consumes failures (D13,
D39): a managed promise is made for the body that is current when it is made
and belongs to that body. A thenable fiber would be awaited wherever anyone
held it, including by `Promise.resolve` inside foreign code, by an async
function's `return`, or by no body at all, so the interruption decision and
the one consumption of its failure (I11) would happen wherever that `then`
call happened. `join(f)` and `result(f)` make the managed await at the call,
for the current body. **Rejected:** the `Fiber` namespace
(`Fiber.call/spawn/fork/join/all`); `fiber.promise`, a bare promise for
work, which either rejects unhandled when nobody awaits it or consumes the
failure when the fiber settles, reaching no one if its awaiter was
interrupted (the failure mode D13 rejects); `withAbortSignal`/`linkAbortSignal`, separate
functions for running with a signal and linking a foreign one, which a
current node makes redundant: `signal()` reads the node's signal anywhere,
and the `signal` option links a foreign signal at the definition or per use;
requiring `task()` for inline bodies too, ceremony that closes no gap.
**Cost.** A node per fiber (fibers are not free); application code must
decide function vs task at the definition. `fork` and `call` also accept a
plain function, so for a named async function the gap stays open:
`fork(parse)` and `parse()` both compile, and neither the type nor a lint
flags it (D35). DESIGN.md §4.5–§4.9.

### D22. `fork` starts in a microtask; `call` starts synchronously

`fork` never runs any part of the body in the forker's frame: the body
starts in a microtask, or after placement when it was forked during
creation (I20). `call` starts the body synchronously, with the child
current.

**Why.** A synchronous start would run the body's first segment inside the
forker's frame. During a creation that is a creation frame, so the body
would begin where `inject` is legal and `lookup` is not (D4′, I16), on a
node not yet placed. Outside creation the forker has not yet returned, so
an `own(fork(t))` (D19), or any other attachment the forker makes right
after `fork`, would race the body's start. Starting in a microtask gives
the body exactly its own node as current from its first line. `call` has
none of these hazards: the caller awaits it at once and is lent (D11), and
`call` is refused during creation, so a synchronous start costs nothing and
keeps a call as close to a plain function call as a node allows.
**Rejected:** a synchronous `fork`; a microtask start for `call` too, which
delays every call by a tick and protects nothing. **Cost.** A fork's body
starts a microtask later than a plain call would, and code that forks and
then inspects the fiber synchronously sees it unstarted. DESIGN.md §4.6.

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
the two verbs keep disjoint meanings. The value's own node is not a
dependency: it has no position until the value is placed, and its position
follows from the value's dependencies, not the other way round. Tracked as
a read, it would have to count as served at the requester, the only
position an unplaced node has, so every value that attaches anything would
be stored at its requester and no service that owns a resource would be
shared. **Rejected:** the previous split (`lookup` untracked in creation),
whose documented hazard baked one scope's answer into a shared value; the
previous planned convergence (track every creation-time read), which keeps
the hazard's shape and blurs the verbs; an `untracked` verb, which gives
placement to the caller; tracking the value's own node like any read.
**Cost.** A helper written for bodies cannot be called from a factory and
must be handed its dependencies, which is what a factory should be doing
anyway. DESIGN.md §3.2, §3.5.

Settled while implementing it:

- *A late read through a value's node that creates a value is warned.* A
  service may keep `#ctx = current()` and read through it after
  construction (DESIGN.md §3.2). When such a read creates the value it
  reads, that value is placed after its reader, and where both land on one
  provided stack it is released first, the reverse of G3, while the reader
  may still use it in its own release; declaring it with `inject` creates
  it first. A read that hits an existing value creates no new order, so it
  is not warned. It is a development warning (D30), once per key per root,
  not an error, because the read is legal and the hazard needs both values
  on one stack and a release that uses the later one. **Rejected:** an
  error; a warning on every late read, which would flag the `#ctx` idiom
  itself.

### D7. Auto-hoisted values store at the deepest tracked dependency

A default-factory value with no declared placement is cached on the deepest
node that served one of its `inject`ed dependencies, clamped by the nearest
`captureAutoScoped` node; nodes below share it. The tracker also records
`deps(V)`, the keys `V` injected plus the `deps` of each injected
auto-hoisted value, which D10′ uses, and apart from it the keys `V`'s
factory injected itself, which the re-run check below compares; the value's
own node is untracked (D4′); reads place only auto-hoisted values.

**Why.** Inherited from the lineage and kept: it makes "placement follows
dependencies" (I17) mechanical, sharing as wide as dependencies allow and
never wider, without per-key scope annotations. `captureAutoScoped` is a
public `NodeOptions` flag for harnesses and isolation boundaries (a node
whose auto-hoisted instances must not leak upward); it clamps placement, it
never changes resolution. It is public rather than a test-harness option
because an application's isolation boundary (a plugin's or a tenant's
subtree) has the same need, and without the flag the only way to keep
instances below a node would be a scope on every key. Because creation-time
reads are all `inject` (D4′) and factories are synchronous, `deps(V)` is
complete when `V` is placed. **Rejected:** a clamp only test harnesses can
set; handling only the symptom, the previous behaviour: a re-creation forced
by placement by view (D10′) that landed on a node already caching the key
abandoned the new instance and served the existing one, with a development
warning. That collision happens only when a factory's key set varies, and
serving the existing instance hid the defect; checking the key set at the
re-run names the cause, and the collision branch remains only as an I19
guard that throws. Rejected too: comparing the closure `deps(V)` at the
re-run, the check's earlier form. The closure changes legitimately when a
shadow changes a dependency's kind, which made an ordinary override an
order-dependent `PlacementError`: with `class Dep { c = inject(Config) }`
and `V` injecting `Dep`, `root.get(V)` and then a child providing
`valueProvider(Dep, …)` threw "V injected {Dep} when re-created …, but
{Dep, Config} when first created", while the child-first order worked, and
a child overriding an alias (D36), whose target is in `deps(V)`, did the
same. **Cost.** Placement depends on what a factory injected on
its run, so **an auto-hoisted factory must inject the same keys on every
run.** A factory that does not is a defect, and it is detected where it can
be: a re-creation forced by a shadow of a *first-run* dependency (`P` and
`C` both provide `A`; `B@P`, the instance of `B` cached at `P`, was built
with `inject(A)`; `C` resolves `B` and must not be served `P`'s view) runs
the factory again from `C` with the keys its first run injected itself in
hand (its own reads, misses and `skipSelf` reads, not the `deps` they
brought in); if that run injects a different set of keys itself, the
resolution throws `PlacementError` naming both sets, the new instance is
released, and `P`'s answer is untouched (I19). With equal sets each shadowed
read lands at or below its shadow, so the re-run always lands at or below
the shadow and can never collide with an existing instance. What is not
detected: a factory whose key set varies, but whose cached instance meets no
shadow of a first-run dependency, is never re-run, so every requester under
it is served that instance, built from the keys its first run read. A
requester whose view provides a key only another run would have injected
gets a value its own view would not have built, and nothing reports it;
placement by view's guarantees (D10′) assume the same keys on every run. The
clamp costs sharing: a value whose dependencies are all served above a
`captureAutoScoped` node gets one instance per such node instead of one
shared instance. DESIGN.md §3.3, §3.4.

### D25. Requester-relative values are pinned

A value built from a requester-relative read (a per-creation `SelfScope`
value, a `skipSelf` read) is **pinned**: placed at its requester and served
only to requesters at that same node. Pinning carries through an injected
auto-hoisted value that is itself pinned; a declared-placement value is
never pinned.

**Why.** A requester-relative read answers differently for each requester,
a descendant included: a `skipSelf` read from a child skips the child's
provider, not the parent's, and a `SelfScope` value is made per creation.
Placement by view compares a requester's view with the cached value's
through the keys of `deps(V)` (D10′), and no key records "relative to
whom", so no shadow check can tell when the cache is another requester's
answer; the only placement that serves each requester its own view is not
to share. A declared-placement value stays where its author declared it,
and its author answers for what it holds (D4′). **Rejected:** treating such
reads as ordinary dependencies, which serves a descendant a value built
from its ancestor's relative view; forbidding requester-relative reads in
auto-hoisted factories, which denies the decorator pattern (`skipSelf`) to
default factories. **Cost.** No sharing: every requester, descendants of
the first included, builds its own instance, and so does every value that
injects one. DESIGN.md §3.4.

### D26. Factories are synchronous

A factory, constructor or provider function runs to completion
synchronously (A5), and `inject` is legal only until it returns.
Asynchronous initialisation is not part of creation.

**Why.** Creation runs in the same async context as everything else, as a
frame that `inject` reads (D9′). A synchronous factory is the only kind
whose frame ends exactly when it returns, so a continuation it schedules
never runs as part of it (I16), and the dependency set it records is
complete at placement (D7). An asynchronous factory would keep creation
open across awaits: its node could not be placed until it settled, every
concurrent resolution of the key would wait for it or race it, and an
`inject` after an await would change placement after other requesters had
started waiting for the value. Beneath the mechanics is the harder
problem: an asynchronous factory can fail part-way, and concurrent
requesters of one key would have to either share one in-flight creation,
and its failure, or race to create; dealing with failure during creation is
what makes asynchronous DI containers hard, and ramme declines the problem.
**Rejected:** asynchronous factories (`await inject(...)`, or a factory
whose promise the container awaits before caching). **Cost.** Asynchronous
acquisition happens in a body, where failure and cancellation are already
structured, and the result is provided to what needs it synchronously:
`const db = own(await connect()); await call(task(work, { providers:
[valueProvider(Db, db)] }))`, or a `child({ providers })`. A service that
must own asynchronous setup starts it with a fork in its constructor or
performs it at first use behind a managed await; consumers cannot await a
value's construction. DESIGN.md §3.3.

### D27. A declared value's node is live from the start and moves above its dependencies

A declared-placement value knows its storage node `S` before its factory
runs, so its node is created live on `S`'s provided stack the first time
the factory needs it, never pending; when the creation ends, its entry
moves to the top of `S`'s provided stack. That is the one time an entry
changes position (I5).

**Why.** Pending exists because an auto-hoisted value's storage node is
unknown until its last `inject`. A declared value's is known, so its node
is an ordinary live node owned by `S` from the start, and the pending
state's refusals and its re-homing at the requester after a failed factory
(DESIGN.md §3.3) stay confined to where they are needed. The entry,
though, is pushed when the factory first needs the node, and values the
factory injects after that are placed on `S` above it, where LIFO would
release them first while the value may still use them. Moving the entry
once, at the end of its creation, restores reverse creation order, which is
dependency order (G3). **Rejected:** keeping a declared value's node
pending until its factory returns, which keeps I5 without exception at the
price of a pending node whose storage is already known; leaving the entry
where it was pushed, which releases a value's late dependencies before the
value. **Cost.** One exception to fixed positions, which any reasoning
about release order has to remember. DESIGN.md §3.3.

### D32. A key declares its lifetime at the class: `static readonly scope`

A class or function key declares its scope through its `scope` property:
`class SessionCache { static readonly scope = SessionScope; … }`. The
property is read as JavaScript reads any static, through the prototype
chain, so a subclass inherits its base's declaration and
`static override readonly scope = X` re-declares it. It is a declaration
only when its value is a `Scope` made by `createScope`, tested by identity
(a module-private `WeakSet` that `createScope` fills, which covers
`SelfScope`, `RootScope` and `RequestScope`). `undefined` and a function
are ignored; any other value is a `TypeError` naming the key, at every read
of the key's scope: resolution, the shadow checks of placement by view
(D10′) and provider registration. `getKeyScope(key)` is the
`setScope`-registered scope, else the declaration, else none.
`setScope(key, scope)` registers a scope for a key that declares none, and
wins over its property; on a key with a declaration, own or inherited, it
is a `TypeError`. `createInjectionKey(name, { scope })` is unchanged and is
the form for tokens. Placement is the existing scoped placement: the key's
default is stored on the nearest node carrying the scope, whatever it
injects. A provider has no scope and places where registered (D36);
provider registration still reads the key's scope, to refuse a malformed
one. The rule for users: a service that holds state for one session,
request or other unit declares its scope; inference is for stateless and
derived services, and gives the widest sharing the dependencies allow.

**Why.** Auto-hoisting places a value at its deepest dependency (D7), so a
class whose fields inject nothing session-scoped lands at the root and is
shared by every session, and nothing in the class says so; `setScope(Class,
scope)` was an opt-in line somewhere else. A lifetime is part of what a
stateful class is, so it must be readable at the class, and a static
property needs no compiler flag and no dependency. It is read through the
prototype chain because that is how a reader expects a static to behave.
Identity decides what counts, not shape: every function has a string
`name`, so a structural test would take a static method named `scope` for a
`Scope`. `undefined` is ignored because under the ES2022 target
`static scope?: Scope` with no initializer emits an own `scope` property
whose value is `undefined`; a function is ignored because an unrelated
static method named `scope` (an ORM's `Model.scope()`) is common. Any other
value is refused rather than ignored: a `scope` that looks like a lifetime
and is not one (`static scope = 'session'`) would otherwise auto-hoist
silently, the defect the declaration exists to prevent, and `setScope` is
the escape for a key whose `scope` means something else, a third-party
class included. `setScope` on a declared key is refused because two
declarations of one key's lifetime would need a precedence rule the
class's reader cannot see. **Rejected:** a development-mode warning when a
value that `own`s something is hoisted to the root, which cannot tell state
from stateless (a root service that owns a connection pool is the normal
case); decorators, which need a compiler flag and are not zero-dependency;
mandatory scopes, which punish the stateless majority that inference serves
well; a structural `Scope` test (above). **Cost.** A declared scope places
only the key's default: a provider for the key has no scope and places
where registered (D36), so a class provided at the root is shared whatever
it declares, and binding it at the root with its declared lifetime takes an
alias; provider registration still reads the key's scope, to refuse a
malformed one. A third-party class whose static `scope` is something else
must be given `setScope` before it is resolved or provided, or it is
refused. The property is read
at every read of the key's scope: each resolution of the key's default
that does not hit a cached value (resolution through a provider never reads
it), each shadow check, each provider registration. Nothing is
memoized beyond the cached value itself, so a cache hit reads no `scope`,
and a property reassigned after a value was cached leaves that value where
it is for every requester the cache serves. DESIGN.md §3.1, §3.3.

### D33. `parent` is public, and a stored value's release reads its storage node through it

`Context` has `readonly parent: Context | undefined`, the node's resolution
parent (DESIGN.md §2.1): `undefined` on a root, and on a value's node
released unowned after its factory completed the whole tree; a value's
storage node, and after a failed factory the node it was placed at to be
released; a release fiber's owner, so `current().parent` inside a release
is the owner; the node a `fork`, `call`, `child` or pool child was made on.
It is readable on a complete node, since tree shape does not change, like
`outcome`. On a pending value node it throws `PendingNodeError`, the
refusal `get` and `addProvider` give there (DESIGN.md §3.3), so an
auto-hoisted factory cannot read its placement. A declared-placement
factory can: its node is live on `S` from its first use (D27), so
`current().parent` in it is `S`, which is fixed before the factory runs and
which reading does not move. The DI unit of work of DESIGN.md §2.6 is the
idiom it enables: a value declared per request (D32) whose release reads
`#node.parent.outcome` to commit or roll back, on a request fiber that
carries the scope.

**Why.** The case was a unit of work whose release commits or rolls back by
the request's outcome, and it could not be a DI service: its release must
read the request node's outcome, and a DI value's own node is not the
request. The program spread it over a captured `current()`, an `own` with
an outcome test and `placeOrder.with({ providers })`: seven pieces and an
extra node per request. The storage node's outcome is the one a stored
value's release wants, since the storage node is what the value lives as
long as, and `parent` is the general primitive: it is already a fact of the
tree, which every internal walk reads. **Rejected:** passing the owner's
outcome to the release callback: the owner of a value's entries is the
value's node, which settles `aborted` when its owner's turn aborts it
(DESIGN.md §2.4), whatever the request did, so it answers the wrong
question (its final outcome can still be amended at completion, DESIGN.md
§4.12, but by the value's own failures, not the request's). A `storage()`
accessor: a second name for a parent. Exposing `parent` on a pending node
as `undefined`: that is a root's answer, so a pending node would read as a
root, and code that captured the node would read two different parents for
one node; `PendingNodeError` is the refusal `get` and `addProvider` already
give before placement (DESIGN.md §3.3). **Cost.** `parent` lets code reach
up the tree. DESIGN.md §2.6's rules on what a release may use (G3) are
unchanged, and `lookup` remains the way to resolve upward. The idiom's
reading is the outcome as decided at settling (D16): release failures and
unconsumed child failures folded in at completion do not reach it, so a
request whose unjoined `'join'` fork failed still commits, and a bodiless
`child({ scopes: [RequestScope] })` reports how it was ended, not how its
work ended (DESIGN.md §2.6, §4.12). DESIGN.md §2.1, §2.6, §3.3.

Settled while implementing it:

- *Internal walks read `up`; `parent` is a getter.* The node already had a
  public, mutable `parent` field, written once by placement, which internal
  code read on pending nodes: an event's `parentId`, the birth rule's walk
  up the subscription path, the creation owner, the root test of
  `[Symbol.dispose]()`. Declaring the member on `Context` would have
  compiled with no new code and answered `undefined` on a pending node, the
  alternative rejected above. The field is `up`, every internal walk stays
  on it, and only the public getter refuses a pending node.

### D9′. Async context propagation is required

The current node reaches across `await` only through the platform's async
context: `import 'ramme/node'` (`AsyncLocalStorage`) or
`import 'ramme/async-context'` (TC39 `AsyncContext`). There is one ambient
mechanism, a frame in that storage; creation uses it synchronously. Without
an adapter every frame-needing operation, including the first factory run,
throws `NoCurrentNodeError` whose message names the import; there is no
synchronous fallback stack. There is no default root either:
`createRootContext()` is one line and is where shutdown lives.

**Why.** The ambient idiom (`lookup`, `own`, `fork`, `signal()` with nothing
passed) is what makes application code read like ordinary JavaScript, and it
is only sound if the current node survives `await`. That is a platform fact,
not a choice: native `await` resumes a function in a job that userland
cannot wrap. Every server runtime has propagation today (`AsyncLocalStorage`
on Node ≥ 22, Bun, Deno, Workers with `nodejs_compat`; `AsyncContextFrame`
on current Node makes it cheap); browsers get it when AsyncContext ships or
through a build-time async-to-generator transform. The previous default, a
synchronous stack that honestly lost context at the first `await`, was half
an idiom: code that worked until its first await. It also left a bleed
surface (a context entered with `enterSync()` and never left with
`leaveSync()` stayed current for unrelated code) and needed a separate
module-level creation stack, both removed. The adapter is chosen by an
explicit side-effect import (`sideEffects` in package.json names exactly
those two files), not by conditional exports or by detection at load: one
runtime can offer both mechanisms, a bundler resolves export conditions for
its build target rather than for the realm that runs the bundle, and
detection would have ramme's main entry probe `node:async_hooks`, which
bundles for other platforms cannot resolve. The import puts the choice in
the application's entry file, and its absence is reported by name.
**Rejected:** the synchronous default (the previous D9); a Zone-style
polyfill; a silent default root, which would hide the "where does this die?"
question the design asks; package.json conditional exports choosing the
adapter; detecting `AsyncLocalStorage` or `AsyncContext` at load. **Cost.**
Browsers without AsyncContext are unsupported except through a transform;
forgetting the import fails at the first ambient operation, with the fix in
the message. The choice lives in `context-storage.ts`: a synchronous
fallback, if one is ever wanted back, would be a default storage registered
there. DESIGN.md §6.

### D10′. Permanent decisions and placement by view

Two rules replace the first extraction's two resolution memos. In the
probabilistic one each node counted the answers it took from an ancestor,
across all keys, and cached every tenth, so whether a later `addProvider`
at or below it was refused depended on unrelated traffic. The negative one,
the *tombstone*: when an auto-hoisted value was stored below the auto-scope
root (the root, or the nearest `captureAutoScoped` node), that root
recorded the key as "not resolved here". **Decided markers:** when a
requester resolves `K`, every node on the walk, up to and including the one
that answered, marks `K` decided, whether the answer was a value or "not
provided here", and for an auto-hoisted answer `V` every key in `deps(V)`
too; `addProvider(K)` at a node where `K` is decided throws
`PlacementError`, and a fresh child has no decisions, so providing at
construction is always allowed. **Placement by view:** a cache hit on
auto-hoisted `V` at `S` is not requester `R`'s answer when a key in
`deps(V)` is provided at `R` or between `R` and `S` (such a provider, or a
node carrying a scope as below, is a *shadow*); `V`'s factory runs from `R`
and the result is placed by `R`'s view.

**Why.** The tombstone stopped a node from *providing* a key it had answered
for, which is right. It also stopped the root from *instantiating* a value
some descendant had placed lower, which is wrong and depends on order: after
a child that provides `Database` resolved `UserRepo` (which injects
`Database`), `root.get(UserRepo)` failed with "No provider found" although
`Database` has a default, and the opposite order worked. Decisions keep the
correct half. A walk that answered auto-hoisted `V` also marks every key in
`deps(V)`: its nodes answered `V` from a view in which each of `V`'s
dependencies resolved as it did, so a provider for one of them added later
at such a node would make placement by view rebuild `V` for requesters that
were already given the cached one, changing an answer. Placement by view
makes overrides compose: a default factory may inject request-scoped things,
land at the request context, and be overridden by a request context that
provides one, and two instances on one path are two consistent views,
arising only where someone deliberately provided a dependency at two levels.
No node ever changes an answer it has given; no requester is served a value
built from a view of its dependencies other than its own; both hold in every
order of resolution, for factories that inject the same keys on every run
(D7). **Rejected:** forbidding shadowing, which also forbids the natural
override of a request-flavoured default; "auto-hoisted keys only at the
root", which equates a default factory with living at the root; an error on
a cache hit across a shadow, whose error is order-dependent unless paired
with a second-placement check and which treats two consistent instances as a
fault. **Cost.** Two instances on one path where a dependency is provided
twice. A node that answered `V` can no longer provide any of `V`'s
dependencies, more `addProvider` refusals than marking `K` alone would give.
Each cache hit on an auto-hoisted value writes its key and every key of
`deps(V)` into the decided set of every node on the walk, and the shadow
check tests each key of `deps(V)` against the providers of every node
between `R` and `S` and, at each node that carries scopes, against the key's
effective scope: none when a provider walk from `S` up finds a provider for
the key, else the key's declared scope. That is work proportional to the
walk's length times `|deps(V)|` per hit. Decided sets grow with every
key resolved through a node and are dropped only when it completes.
DESIGN.md §3.4.

Settled while implementing it:

- *The rebuilt value is cached at the requester's own placement, not at the
  requester.* It lands at `S′`, the node D7 picks for the run from `R`: the
  deepest node that served one of its dependencies in `R`'s view, so `R`
  itself when `R` provides the shadowing key, and otherwise a node at or
  below the shadow. Every requester at or under `S′` with the same view
  shares it. A memo at `R` itself would give each of them (a sibling of `R`,
  another child of the overriding node) its own instance built from the
  same view: sharing narrower than the dependencies allow, against D7.
- *`deps(V)` records optional misses.* An optional `inject` of `K` that
  finds no provider still adds `K` to `deps(V)`; no node served it, so
  `V`'s placement is unchanged. "K is not provided" is as much a part of
  `V`'s view as a value, and the walk that missed already marked `K`
  decided; the tracker records the same decision. Without it a fresh child
  providing `K` would be served a `V` built without `K`, across a shadow
  placement by view could not see, since `K` was not in `deps(V)`.
- *A node carrying a scope shadows a scoped dependency.* The rule names
  providers, but a node at `R` or between `R` and `S` that carries the
  effective scope of some `d ∈ deps(V)` changes `R`'s view of `d` exactly
  as a provider would, since `R`'s walk resolves `d`'s default at the
  nearest node carrying that scope; so it is a shadow too. The effective
  scope is `d`'s declared scope when no provider for `d` (an alias included)
  sits at or above `S`, and none when one does: a provider places where it
  is registered (D36), so `R`, whose walk meets no provider below `S` (one
  at `R` or between them is a shadow already), is served the same `d` as
  `S`. Taking the declared scope alone is wrong there: with a root
  `classProvider(SessionCache)` for a session-declared class and an
  auto-hoisted `V` injecting it, a second session would count as a shadow
  of a key the root serves, and the re-run would land on the root, which
  already holds `V` (the I19 guard of D7). The rule is exact because a
  scoped default decides its key up to the root when it is created, as a
  miss does: the provider search walked to the root without finding one,
  and without the marker a provider added later at an ancestor would let a
  sibling's `V` be cached above the default and served to the default's
  own requesters, built from another view. So a scoped default is never
  cached below a provider of its key. The usual case is an alias at the
  root to a σ-declared implementation (D36): the alias's key has no
  effective scope, the target is in `deps(V)` with its own σ, and `R`
  under a nested node carrying σ is served a `V` built from its own
  target, not the outer one's. `SelfScope` is excluded: inside a creation a
  `SelfScope` dependency is made per creation, and a value that reads one is
  pinned to its requester instead (D25).
- *Superseded by D36: a scoped provider below the node carrying its scope
  was refused.* D36 removes the rule; a provider now stores its value where
  it is registered. The rule as it stood: a provider for a σ-scoped key
  stores its value on the nearest node carrying σ. Declared below that
  node, it would still store there, and every
  requester under that node would be served whichever value was created
  first: the provider's, if a requester below it asked first, or the
  default's or another provider's, if a sibling did. That answer would
  depend on order, which these rules exist to prevent, so it is a
  `PlacementError` at `addProvider` and at `child({ providers })`; a
  pending value node that built such a child is checked when it is placed,
  since the node carrying σ above it is unknown until then. **Rejected:**
  storing the value at the provider's node, which turns the key's scope
  into a suggestion. D36 answers that rejection: scope is a property of the
  key's default, and an explicit provider is a statement; the order
  dependence came from a provider inheriting the key's scope, which D36
  also removes.
- *A DI value's node has its own event kind, `'value'`.* It is the one node
  kind whose placement the design explains; emitting it as a context would
  hide it in `node:created`/`node:placed`/`node:complete`.

### D36. Providers place where registered; `aliasProvider` redirects

An explicit provider lives where it is registered. `addProvider(p)` on a
node, or `providers:` on a `child()`, a task's options (run by `fork` or
`call`, `task.with` included), `pool({ providers })` or
`createRootContext`, stores the value on that node, whatever the key, or an
implementation class, declares as its scope. Scope is a property of default
providers only: a key's `static scope`, `setScope` or
`createInjectionKey(name, { scope })` decides where the key's own default
stores its value, and auto-hoisting decides when nothing is declared
(D7, D32). The provider `scope` option is removed, and with it the helpers'
options argument and `ProviderOptions`. `classProvider(Key, Impl)`
constructs `Impl` on the providing node. `aliasProvider(key, target)` is a
redirect: from its node down, resolving `key` resolves `target` instead,
from the base of the walk that found the alias (the requester, the storage
node in a declared-placement creation, the parent for `skipSelf`), by
`target`'s own rules, and caches nothing under `key`. The alias is a
decision on `key` at its node (D10′); a value that injects `key` records
the redirect chain and its target in `deps(V)`, misses included, and is
never stored above the alias node; a cycle of aliases is the
circular-dependency error, naming the hops. Placement by view keeps its
guarantees under the rule with two adjustments (D10′): a dependency that a
provider at or above the cached value's node serves has no effective scope,
and a scoped default decides its key up to the root when it is created. The
re-run check compares the keys a factory injected itself (D7). This
supersedes D10′'s settled bullet "a scoped provider below the node carrying
its scope is refused". DESIGN.md §3.1, §3.3, §3.4.

**Why.** An `addProvider` at a node is a statement, not an inference: its
author said where the value lives. The defect D32 addressed was an inferred
placement (a stateful class auto-hoisted to the root because nothing it
injects is session-scoped), and a provider that inherited its key's scope
was placed by inference too: its author wrote a node and the value went
elsewhere. Registered on a session node for a session-declared class, it
built a second instance at a nested owner of the scope below that node, and
`providers:` on a task for a key whose scope owner sat above the call was a
`PlacementError`. One rule for explicit providers (where registered) and
one for defaults (the key's scope, else its dependencies) leaves nothing to
infer, and the override a test needs below a declared scope becomes legal:
a `call` child that provides a fake unit of work shadows the request's for
that child only. Binding an interface at the root without fixing the
implementation's lifetime is a redirect's job, as it is for Angular's
`useExisting`: a root `aliasProvider(SessionCache, FakeSessionCache)`, the
fake declaring `SessionScope`, gives each session its own fake, and an
auto-hoisted target lands at its deepest dependency as if injected
directly. D10′ rejected storing a provider's value at the provider's node
because it "turns the key's scope into a suggestion"; the answer is that
scope is a property of the key's default, and an explicit provider is a
statement. The order dependence that rule guarded against came from the
provider inheriting the key's scope, which is gone. The two adjustments to
placement by view keep D10′'s guarantees: under a provider a key has no
scope for a nested owner to shadow, and without the root-wide marker a
provider added at an ancestor after a scoped default was created would let
another requester's value, built from the ancestor's provider, be cached
above the default and served to the default's own requesters.
**Rejected:** a provider inheriting the key's scope, the previous rule, with
its `PlacementError` for a provider below the node carrying the scope; an
asymmetric "widening" guard that refuses a provider above a declared scope
unless it is marked explicit, judged a surprise where there is none, since
a provider above the scope is exactly what its author wrote; a cached
alias, the previous `aliasProvider` (a factory `() => inject(target)` whose
value was cached under `key` at the alias node), which shares one instance
and so cannot bind a per-session or per-request implementation at the
root. **Cost.** Binding a per-request (or per-session) implementation at the
root must use the redirect: a `classProvider` there shares one instance.
`classProvider(Key, Impl)` ignores `Impl`'s own declaration, by its
documented meaning. A provider for a `SelfScope`-declared key is stored at
its node and shared by every creation, not made per creation, so
`SelfScope` applies to defaults and alias targets only; the per-creation
binding is `aliasProvider(K, Impl)` with `Impl` declaring `SelfScope`.
After a scoped default is created, no ancestor can provide its key. A
value that injects an alias is never cached above the alias node, so an
alias below the root narrows the sharing of everything that injects its
key, as a provider there does. Nothing is cached under an alias key, so
each resolution of it walks to the alias node and resolves the target.

Settled while implementing it:

- *The redirect checks its own cycles.* runCreation's frame-chain check
  sees only creations, and a redirect runs no factory, so a cycle of
  aliases alone recursed until the stack overflowed. The redirect keeps the
  alias keys it has followed in the current resolution and throws on a
  repeat; and a creation reached through a redirect keeps its hops, so an
  alias `A → B` whose class `B` injects `A` again reads
  `Circular dependency detected: A → B → A`, as the cached alias's frame
  made it, rather than `A → B → A → B`. The redirect counts a repeat by an
  enclosing creation only from the same base, so it does not take for a
  cycle a decorator written as an alias whose target injects the key with
  `skipSelf`, which resolves from the parent, nor a declared-placement
  target's `inject` of the key, which resolves from its storage node, where
  the key may reach another alias, or the same alias and then other
  providers. Whether those resolve is up to the frame check, as for any
  creation; when it finds the target repeated, reached through an alias hop
  that also led to the first one, it ends the message at that hop, so a
  declared or provided `B` requested from below its storage node reads
  `A → B → A` too.
- *`Provider<T>` keeps its public shape.* Users write providers as
  `{ key, provide }` literals, so the redirect is marked in a module-private
  `WeakMap` in inject.ts that `aliasProvider` fills (`markAlias`), as
  context-key.ts keeps its markers; only resolveFrom's provider branch reads
  it, and resolution never calls an alias's `provide`.

### D37. Providers are checked against the public surface

The provider helpers check what they are given against `Public<T>`, the
members a consumer of `inject(T)` can reach: `valueProvider(key, value)`
takes `NoInfer<Public<T>>`, `factoryProvider(key, factory)` a factory
returning it, `classProvider(key, Impl)` and `aliasProvider(key, target)`
an implementation (for an alias: a class, a function or a token) of a
`U extends Public<T>`, and `T` is inferred from the key alone. `Public<T>`
is a public type: `{ [K in keyof T]: T[K] }`, with functions, classes, `any`
and `unknown` passed through unchanged. `inject` and `lookup` keep
returning `T`. DESIGN.md §3.1.

**Why.** Angular's providers are untyped (`useValue: any`): a wrong provider
fails at run time, and a fake drifts from what it replaces without notice.
Typing them against `T` itself forbids a fake of any class with a
`#private` member, since no other class can have it, and that breeds casts,
which hide exactly the drift the type should catch. `keyof` leaves out
`private` and `#private` members, so `Public<T>` is the consumer's view of
`T` and the right contract at the provider boundary: a fake needs every
public member, each of a compatible type, and may have more. The
pass-throughs keep what the mapped type alone loses. It erases call
signatures, so a topic receiver (`valueProvider(MyTopic, (e) => …)`) would
lose its contextual typing and any non-nullish value would pass for a
function-valued key; over `any` it rejects primitives, `null` and
`undefined`, and over `unknown`, where it is `{}`, it rejects `null` and
`undefined`. `NoInfer` keeps `T` from being inferred from the value: a fake that
lacks a method is a supertype of the class, and `T` inferred from it would
type the provider as the fake's and compile. An alias target's token
branch refuses functions (`{ call?: never }`), because every function has a
`name` and would otherwise pass as a token of any type. **Rejected:**
`inject` returning `Public<T>`: it is viral, into every signature that
passes a service on, and it would not close the identity hole below, which
is a run-time fact; untyped providers; `T` itself, the previous form.
**Cost.** The one hole is any check of class identity on an injected value:
`instanceof`, a `#private` read or a `#x in v` brand check, which throw or
answer `false` on a fake, and a TS-`private` member read, which returns
`undefined`. The types cannot see it, so DESIGN.md §3.1 says not to
brand-check an injected service. A generic wrapper
`<T>(k: InjectionKey<T>, v: T) => valueProvider(k, v)` does not compile,
since an unresolved `T` is not assignable to `Public<T>`, and needs
`v as Public<T>`; none exists in the repository. One more name in tier 1.

### D11. `call` lends the current node, never the receiver

`call` (and `attempt`, `all`, `race` and `settle`, which are calls) records
`lentTo` on the node that was current when it ran, and that node's
body-shaped operations throw `UnawaitedCallError` until the call settles
(the child completes, its releases included; an interrupted caller's await
is therefore rejected only then, D39); `own`, `release`,
`releaseAll`, `abort`, `close` and the `Symbol` methods do not. With no
current node, or from a failure handler (which runs with its parent current
but is not its body), nothing is lent.

**Why.** The awaiting body is the one that is supposed to be suspended on
the call's promise, so it is the one whose further use means the `await`
was forgotten; a handler's call lent to its parent would fail the parent's
body over an await nobody forgot. One field works after any number of
awaits and catches every body-shaped use; the first extraction's stack-top
check (a nested `Fiber.call` compared the ambient context with the top of
its fiber's stack of calls) caught a forgotten await only at that fiber's
next call. Lending the receiver instead would make `app.fork(...)` from a
platform callback throw while a top-level `await app.call(main)` runs, the
exact shape of a server's main loop. Attaching and cancelling stay open,
because another party (a producer granting a lease, a signal handler) may
legitimately do them while the body waits. **Rejected:** lending the
receiver; no detection (a forgotten await on a call silently runs two
bodies on one node). **Cost.** One more error a newcomer meets;
`Promise.all([call(a), call(b)])` is refused and must be `all([...])`. The
check misses a forgotten await whose call completed synchronously, since
the node is no longer lent when it is next used. DESIGN.md §4.9.

### D19. Subscribed and unsubscribed children; `own(node)` unsubscribes

A child node is **subscribed** (work: it hears its parent's interrupt when
the parent's body exits or the parent is aborted) or **unsubscribed**
(infrastructure: it hears at its turn in the parent's release loop, I4).
`fork`, `call` and `child` make subscribed children; a pool, a DI value's
node and a release fiber are unsubscribed; `own(node)` makes a subscribed
child of the current node unsubscribed and leaves its stack entry where it
is.

**Why.** Interruption and release answer different questions. Work should
stop when its parent stops (D18). Infrastructure the work uses (a pool the
handlers fork into, a reaper fiber that maintains a cache, a connection's
keep-alive) must outlive that work's cleanup: subscribers are interrupted
together and in no order (G4), so a subscriber that uses a subscribed
sibling during its cleanup finds it already stopping. Hearing at its turn
makes an infrastructure child live exactly as long as a passive resource
attached at the same position, until everything attached after it has been
released (G2). Subscription is a relation between a node and its owner,
not a property of the task (the same task is work in one place and
infrastructure in another), so it is decided where the node is attached,
by the verb that attaches every other resource; since `fork` never starts
the body in the forker's frame (D22), `own(fork(t))` is in effect before
the body runs. **Rejected:** interrupting every child at once, which stops
infrastructure while the work that uses it is still cleaning up (a pool
would refuse intake from handlers still forking into it, D15); a
`subscribed: false` task option, which fixes at the definition what depends
on the attachment, and per use would be a second spelling of `own`.
**Cost.** `own` has two meanings, attaching a passive entry and
unsubscribing a node, and a second `own` of a node throws where a second
`own` of a passive object is a no-op (D16). Whether a child hears at the
parent's exit or at its turn is not visible at the `fork` call. DESIGN.md
§2.2, §2.3.

### D18. A body's exit interrupts its subscribers

When a body settles, every subscriber of its node that is still
running is delivered an `OwnerInterrupt` (`childrenOnExit: 'interrupt'`,
the default); `childrenOnExit: 'await'` waits for them instead. The exiting
node is not itself marked delivered: the interrupt starts there, and its
own signal stays unfired.

**Why.** A fork the body did not join is work whose result nobody will
read: the body has produced its own result without it. What it still does
is either a forgotten `join` or background work that belongs to a
longer-lived owner (a pool, or an owned fiber with a handler). Interrupting
it ends the parent promptly and keeps the fork's lifetime within the
body's, which is what structured concurrency promises; waiting would let a
forgotten `join` hold the parent, and everything awaiting the parent, for
as long as the fork runs. A natural exit is not an interruption of the
exiting node, so it does not mark it: the node's signal means "this node
was interrupted" (DESIGN.md §4.1), which a resource reading it must not see
after a body that returned, and work forked onto the node while it
releases (a failure handler's restart) would be born delivered (D12).
**Rejected:** waiting as the default, the nursery rule of other
structured-concurrency libraries, which turns every unjoined fork into a
hang its author does not see at the call site; marking the exiting node.
**Cost.** A body that needs its forks finished must `join` them, use `all`,
or set `childrenOnExit: 'await'`; a fork forgotten under the default is cut
short without a report. DESIGN.md §2.1, §2.4.

### D20. Three interruption modes

A node's `interrupt` option is `'freeze'` (the default: a delivery is
applied, so managed awaits reject, D39, and it is forwarded to every
subscriber; the mode kept its name when freeze gave way to sticky
rejection), `'observe'` (delivered but not applied: the body reads
`signal()` or awaits `interrupted()` and settles on its own; while it runs,
the delivery is forwarded only to `restore` subscribers), or `'restore'`
(applied, and delivered whenever an ancestor on its subscription path is,
through any `observe` region).

**Why.** Stopping at managed awaits is right for work (D13, D39), but some
shutdowns are work that must finish: a server draining its connections, a
writer flushing a batch, a consumer committing offsets. Such a body must see
the interrupt and keep running, so the mode is chosen per node, and the
default is the one application code needs. An `observe` body withholds the
interrupt from its subtree because the subtree is its own work: a drain that
forks a task per connection to finish must not have those tasks stopped by
the interrupt it is handling; the body decides when its children stop, at the latest when
it exits (D18). `restore` re-opens cancellation inside such a region for
work that should stop anyway (a keep-alive ping in a draining server)
without making the whole region cancellable. **Rejected:** a per-await
opt-out (`await uninterruptible(p)`), which would have to be repeated at
every await of a drain, including inside library code it calls; a single
cancellable flag per node with no forwarding rule, which leaves an
`observe` body's forks either stopped by the interrupt it handles or never
interruptible. **Cost.** Three modes to learn. An `observe` body that
ignores its signal never ends, and its owner waits for it (D21); the report
is `node:stalled`. A `freeze` fork inside an `observe` region runs until
the region's body exits (D12). DESIGN.md §4.3.

### D12. The birth rule: delivered at birth iff the parent would have forwarded

A subscribed `freeze` child born under a delivered parent is delivered at
birth iff the parent would have forwarded to it: under a delivered `freeze`
parent yes, under a delivered `observe` parent no. A subscribed `restore`
child is delivered at birth when an ancestor on its subscription path is
delivered; the walk up stops at the first unsubscribed node, whose own
parent would not have forwarded to it. An `observe` child never is, nor is
an unsubscribed one (a pool, a release fiber, a DI value's node), which
hears at its turn in its owner's release loop (I4).

**Why.** Delivering every `freeze` child born under any delivered parent
would make behaviour depend on whether a handler was forked before or
after the shutdown signal: a server in `observe` mode draining its
connections would see handlers forked before the signal keep running and
handlers forked after it stop at their first managed await. The design is order-independent
everywhere else (D10′), so the rule is phrased as the forwarding rule
applied at birth, and because a parent forwards only to subscribers, an
unsubscribed edge ends it. **Rejected:** that blanket rule; applying the
rule to unsubscribed children (a pool made by a delivered body would be
born delivered and refuse every fork, D15); a `restore` walk to any
delivered ancestor (a `restore` fiber forked into an undelivered pool
after the signal would be stopped while one forked before it keeps running).
**Cost.** A `freeze` fiber forked into a draining `observe` region runs
until its parent's own exit interrupts it (D18). DESIGN.md §4.3.

### D13. Only managed awaits are interrupted, and a failure is consumed on resume

Interruption acts on a body only at a **managed await** (an await on a
promise ramme produced); what it does there is D39's: the await rejects.
The decision is made for the awaiting body's node. "In flight" means the
await's `then` was called, which ramme's promise subclass observes, so a
stored, un-awaited managed promise is not interrupted at the delivery, and
is the moment it is awaited.

*Its freeze half is superseded by D39.* As first decided, interruption made
the body's next managed await never settle: the body never resumed and was
abandoned, an await in flight was cut at the delivery, and the node released
at once, without waiting on work that might never settle. That removed
cleanup as control flow entirely, and its cost turned out to be a silent
leak at the foreign boundary (a driver's transaction callback whose
`finally` never ran), which D39 records; D39 replaces freeze with sticky
rejection and keeps the two properties freeze was built for.

**Why.** Only promises ramme produced can be decided at `then` time;
everything else is a bare await and completes normally, and `signal()` and
`managed(p)` bring foreign work in (a timer has its own managed form,
`sleep(ms)`, D34). With no current node (top level, a platform callback)
nothing is interrupted, so `app.abort()` from a signal handler rejects a
top-level `await app.call(main)` and the process's `await using` cleanup
runs. **Rejected:** cooperative cancellation through the signal alone,
which leaves stopping to every body on a path it rarely runs; interrupting
at delivery regardless of what the body awaits (a body in plain code
between delivery and its next managed await is legitimately running, I8);
deciding for the node a method was called on (it would interrupt the
top-level await of work the caller does not own). **Cost.** A `freeze` body
that never reaches a managed await is never interrupted; the mitigation is
diagnostic (`node:stalled`). DESIGN.md §4.2, §4.4.

*A failure is consumed on resume, and sources never reject.* Every managed
promise wraps a source that never rejects (a node's completion, the end of
an entry's release, a node's delivery, which `interrupted()` waits on) plus
a resume step (`deliver` in the code; unrelated to a node's delivery of its
signal) that runs only when an awaiting continuation is actually resumed, in
`then`; that step is where an awaited value is produced, an error thrown to
the awaiter, and a failure consumed. An awaiter rejected by its
interruption therefore consumes nothing, and the failure surfaces from its
parent (I11); a stored, never-awaited `join`, `result` or `call` consumes
nothing; and no ramme-internal promise can be an unhandled rejection
whether or not it is ever awaited (I10). The one wrapper over a user
promise, `managed(p)`, has no resume step and leaves `p`'s handled-ness to
its owner until it is awaited; an awaited `managed(p)` marks `p` handled
even when its awaiter is rejected instead, or
`await managed(fetch(url, { signal: signal() }))` in a delivered body would
leave the fetch's `AbortError` unhandled. **Rejected:** consuming a failure
when its source settles, through promises that reject: an owner interrupted
on `join(f)` consumed `f`'s failure without ever being resumed, so it
reached no one, and `const p = call(x); await timer; await p` was an
unhandled rejection while the timer ran. **Cost.** Consumption is final once
the resume step runs: a combinator that has settled on one member and then
takes another member's failure loses it, which is why `Promise.race`,
`Promise.any` and a `Promise.all` that rejects may drop a member's failure
(DESIGN.md §4.2); multi-member waits belong in ramme's `all`/`race`/`settle`,
which join their members themselves (D31).

### D39. Sticky rejection replaces freeze; `shield` is release work on demand

Interruption unwinds the body. On a delivered `freeze` or `restore` node,
every managed await the body makes rejects with `InterruptedError(reason)`:
the one in flight at the delivery, and every one made afterwards, forever.
Release work is exempt: `release(x)` and `releaseAll()` unless they wait for
the awaiting node's own completion, `close()` and `[Symbol.asyncDispose]()`
of a node strictly below the awaiting node, and `shield(…)`. A call-shaped
await (`call`, `attempt`, `all`, `race`, `settle`, and a `join` or `result`
of a fiber subscribed below the body) rejects only when the awaited fiber has
completed, and a `child()` scope of the body is released only once the body
has unwound. The node completes after its body has settled and after every
shield it started, and its outcome is `aborted` by state (D24).
`shield(body, …args)` (and `ctx.shield`) runs a body in a release fiber of
the node and awaits it: its signal is the release deadline, no interruption
rejects it, and the node holds it until it completes. `InterruptedError` is
a new error class, the awaiting body's own interruption; `FiberAbortedError`
keeps meaning other work that was aborted. `finally` and `using` run on
interruption and are legal, but the idiom is unchanged: what must hold after
the body ends is an entry (`own`). The `recommended` lint config gains
`no-swallowed-interruption` (an error) and turns `no-finally-in-async`,
`no-using-in-async` and `no-promise-combinators` into warnings (D35).

**Why.** Freeze (D13 as first decided) made an interrupted body's next
managed await never settle, so cleanup as control flow could not run and
could not swallow the interruption. Its cost was discovered at the foreign
boundary: a `finally` in a frame ramme does not own, a database driver's
transaction callback (`db.transaction(async (tx) => { await call(x) })`:
Prisma's `$transaction`, Knex's and Drizzle's `transaction`; node-postgres
has no callback API, so there it is a hand-written `withTx(client, fn)`
helper), a mutex helper, a retry wrapper, a `for await` over a library
iterator, runs in the *same async context* as the body, so ramme cannot tell
it from the body's own code, and under freeze its commit, rollback or unlock
never runs. That is a silent resource leak, in production, in code no lint
can see. Sticky rejection (Kotlin's `CancellationException` plus
`NonCancellable`, Trio's `Cancelled` plus `shield`) makes the body unwind,
so foreign `finally` blocks run, while stickiness (every later managed await
rejects too) and outcome-by-state (D24) keep the two properties freeze was
built for: a swallowed interruption cannot complete more ramme work (a child
it starts runs only as the birth rule allows, D12) and cannot turn into a
`success`. The residue, bare side effects in a catch-all, is loud and
lintable where it is the user's code. In foreign code it is not: a foreign
retry wrapper that retries on any error retries the interruption, each
attempt's managed awaits are rejected again while its bare work (the retried
callee's synchronous prefix, a driver write not handed `signal()`) still
runs to its end, and an unbounded policy never lets the node complete
(`node:stalled` reports it; pass `signal()` to helpers that take one, and to
the writes inside them). The call-shaped deferral keeps D11: the lending is
cleared only by the child's completion, so the body's `catch`, and a foreign
`finally` around the call, run once the bracketed work has stopped and
released, and can use the node. The same deferral for a `join` of a fork
subscribed below the body, and the late release of the body's `child()`
scopes, give a foreign `finally` around those the same footing: the work it
brackets has stopped, and what it cleans up is still there. Release work is
exempt because interruption is an instruction to stop all work except
releasing what was acquired: a
rollback must be able to await its own driver call. `shield` is that on
demand, built from the existing mechanism, a release fiber, with its
deadline, its visibility and its owner's wait (D21).

**Rejected:** freeze as shipped (above); a one-shot rejection that leaves
later awaits alone, which asyncio shows can be swallowed (a task that
catches `CancelledError` simply runs on); a rejection that skips `finally`,
freeze by another name at the foreign boundary; detecting foreign frames,
impossible since they share the body's async context; a default deadline on
shields, against D21 (a deadline is a signal, never an end, and
`releaseTimeoutMs` is that signal); making `attempt` resolve with `aborted`
for the caller's own interruption, which turns the interruption into a value
a body can branch past (D31); rejecting a call-shaped await at the
delivery, which resumes a body still lent to its callee (its `catch` meets
`UnawaitedCallError`) and runs a foreign `finally` inside the callee's work,
or, for a `join` of a subscribed fork, inside the fork's (a mutex released
while the critical section still writes); releasing a body's `child()` scope
inside the delivery, which hands the foreign `finally` around the interrupted
await a connection already returned to its pool; settling unstarted a call
that an already-interrupted caller makes, which would spare a retried call
its bare work but changes the birth rule (D12) and `call`'s synchronous start
(D22).

**Cost.** Error handlers run on cancellation unless they discriminate: a
`catch` sees the body's own interruption, hence `no-swallowed-interruption`.
A `finally` cannot await non-release work. Release is no longer
instantaneous at delivery: a node completes after its body has unwound, jobs
later, and a body doing bare work after a caught interruption holds it open,
as does foreign cleanup that awaits a driver with no timeout of its own (a
`ROLLBACK` on a dead connection), and with it every owner up to the root's
`await using` shutdown. `node:stalled` is the mitigation there, a
diagnostic; `releaseTimeoutMs` signals shields and entries' releases and
never reaches a body, so such cleanup needs a driver-level timeout, or a
`shield` whose `signal()` it is handed. A body's `child()` scopes are
released only once it has unwound, and a `join` of a subscribed fork waits
for the fork's unwind, as a `call` does. An exempt `close()` of an
unsubscribed child is a drain as long as its work. A foreign retry wrapper
retries the interruption (above), and each attempt re-runs the retried call's
bare work to its end, so a non-idempotent driver write not handed `signal()`
is repeated once per attempt. A foreign helper that swallows errors inside a
transaction callback lets the rest of the callback run as bare work and the
driver commit the partial transaction, unless a managed await follows the
swallow; ending the callback with `signal().throwIfAborted()` makes it reject
into the rollback. `managed(p)` stops waiting for `p`, not `p`. A promise
derived from a managed one (a combinator, a `.then` chain, an async helper, a
stored `gen(…)`) rejects on interruption, and is an unhandled rejection
unless awaited at once; shared between bodies (a memoized loader, a batch),
it carries its creator's `InterruptedError` to every one of them, which
`signal().aborted` tells from their own. `Promise.race`, `Promise.any` and a
rejecting `Promise.all` still drop a member's failure that arrives after
they settled (D13). Three lint rules are downgraded to warnings. Two more
names in the core surface. DESIGN.md §2.4, §2.6, §4.2, §4.4, §9, §10.

Settled while implementing it:

- *Release work is exempt only under a precise criterion, and an applied
  awaiter consumes nothing.* `release(x)` and `releaseAll()` are exempt
  unless their wait includes the awaiting node (the `waitsFor` predicate a
  failure handler's await already used holds for the awaiter); `close()`
  and `[Symbol.asyncDispose]()` only for a node strictly below it. On the
  awaiter itself, an ancestor or an unrelated node they reject: such an
  await waits for a completion that waits for the body, so exempting it
  would turn `await current()[Symbol.asyncDispose]()` in a body, or a
  shutdown fork on `app.child()` awaiting `app[Symbol.asyncDispose]()`, into
  a silent deadlock. The resume step of an exempt await that resumes an
  applied body throws the failure but leaves the record with its holder,
  which folds it in at completion, so `aborted` plus that failure becomes
  `failure`, reported once (D24). Consuming it would hand a rollback's error
  to a body whose throw the classification discards, the "ignoring release
  failures after an `aborted` body" D24 rejects. The applied state read is
  that of the awaiter being resumed, when it resumes, not that of the body
  the promise was made for: an aborted fork awaiting its live parent's
  `release(x)` would otherwise consume the failure into a discarded throw,
  and a shield awaiting its interrupted body's `release(x)` would leave the
  failure it handled to surface again. A shield or another release fiber,
  top-level code and a bodiless node are never applied bodies.
  **Rejected:** exempting every release-shaped await; reading the creator's
  applied state, for those two losses.
- *A call-shaped await is marked at the delivery and rejected at the awaited
  fiber's completion; the mark delivers a fiber the delivery missed.* The
  mark runs `fiber.abortIfOpen(the awaiter's reason)` for a fiber that is not
  delivered: a `ctx.call` child of a node outside the delivered subtree, a
  call on an undelivered pool, a fiber below an `observe` body that is still
  running, or one born undelivered after the delivery, such as an `observe`
  task (D12). Without it, a fiber on the awaiter's own stack would be
  delivered only at the awaiter's exit, which waits for the body, which waits
  for the fiber. A `join` or `result` is call-shaped when its fiber is
  subscribed below the awaiting body, decided at the mark: that fiber is work
  the delivery stops, so waiting for its unwind is bounded as a callee's is,
  and a foreign `finally` around the join (a mutex helper's unlock) runs
  after the fork's work, not during it. Any other fiber is not the body's to
  stop, and its `join` rejects at the delivery: an owned `own(fork(t))` hears
  its interruption only at its turn in the release loop (I4), so waiting for
  it would wait for the body, and delivering it would make it hear early.
  **Rejected:** rejecting at once and clearing the lending for a callee
  outside the subtree, which cuts D11 short and leaves an `observe` child
  called after the delivery deadlocked; deferring a `managed(p)`, whose
  source ramme cannot stop, so the wait could be unbounded: it stops waiting,
  and what stops `p` is the `signal()` its operation was handed.
- *A body's `child()` scopes are released at their turn, after the body has
  unwound.* A delivery that interrupts a `freeze` or `restore` body reaches
  its bodiless subscribers too, and their signals fire with it (G4), but a
  bodiless subscriber whose nearest ancestor with a body is that unwinding
  body is not exited by the delivery: its parent's release loop releases it
  at its turn, as any subscribed node entry, once the body has settled. The
  body's `catch`, its `finally`, a foreign helper's `finally` and its shields
  may still use what the scope owns (a pooled connection the rollback runs
  on). An explicit `abort()`, `close()` or dispose of the scope still exits
  it at once, and a bodiless node with no unwinding body above it still
  exits in the delivery. **Rejected:** documenting the early release instead,
  which leaves the foreign `finally` around an interrupted await on a
  `child()` scope's connection running on one already back in its pool.
- *The owner holds its shields, and a shield's failure is routed.* A release
  fiber on no stack is not something the release loop waits for, and the
  body need not await a shield (`void shield(…)`, a `Promise.race`
  member). So the owner keeps one never-rejecting completion per shield it
  started (`shieldHolds`, as `handlerHolds`, D23): its release starts only
  when the body has settled and every shield has completed, and the loop
  re-reads the set before completing, so a shield started during the release
  phase still completes first. A shield stays kind `release` but routes its
  final failure as a `'join'` fiber's, to its parent's unconsumed set, the
  one exception to D16's "every node except an entry's release fiber"; its
  resume step consumes it, subject to the applied-awaiter rule. It is not
  put on the explicit stack: the release loop would abort it at its turn,
  firing a signal that is only the release deadline here. The shield lends
  the current node from before its body starts until it completes or the
  lender's body settles, whichever is first: a settled body cannot have
  forgotten an await, and `shieldHolds` keeps the node open, so a
  `void shield(…)` does not leave the node lent after the body returned,
  where a child's failure handler awaiting through it would meet
  `UnawaitedCallError`. **Rejected:** a development warning for a shield
  started after the body settled, a feature.
- *The rejection's class follows the awaiter.* A managed promise's node is
  fixed when it is made (D13). The creating body, and top-level code (a
  `then` under no current node), get `InterruptedError(that node's reason)`;
  any other awaiter (another body, a shield or another release fiber) gets
  `FiberAbortedError(that node's reason)`. ramme's own subscriptions under no
  frame name the node they act for (`thenFor` in managed.ts), so they are
  classified, and reported by the development warning, as that node's await:
  `startBody`'s subscription to a promise a synchronous body returns is that
  body's, as an async body's `return p` is, and `managed(p)` over a managed
  promise awaits it for whoever awaits the `managed(p)`. So at a direct await
  of a managed promise an `InterruptedError` is always the awaiting body's
  own interruption, and I12 holds there: a body that was not delivered and
  rethrows what it caught fails with `FiberAbortedError`, and never reports
  an interruption as a failure. A promise derived from one is not a direct
  await: shared between bodies (a memoized loader, a DataLoader-style batch),
  it carries its creator's `InterruptedError` to every body awaiting it, with
  no warning, and a body that rethrows it fails with it; `signal().aborted`,
  which fires at a `freeze` or `restore` node's delivery, tells a body's own
  interruption from such a one (DESIGN.md §4.4). The awaiter's own delivery
  does not reject such an await. **Rejected:** deciding the target at `then`
  time, which would change "the node is fixed when it is made"; the minimal
  rule is enough for I12 at a direct await; treating ramme's own frameless
  subscriptions as top-level code, which made a synchronous body returning
  another body's promise, or `managed()` over one, fail with an interruption
  it never had; putting the interrupted node on `InterruptedError`, a
  feature.
- *Exempt and call-shaped awaits are shapes of the one managed promise.*
  A `ManagedPromise` takes an optional shape: `exempt` (it arms nothing, is
  never rejected, and its resume step receives the applied state of the
  awaiter it resumes, read when it resumes), or `onMark` (call-shaped: run at
  the first mark, it delivers the awaited fiber if needed and returns whether
  the await is deferred at all, which a `join` of a fiber not subscribed
  below the target declines). The exemption criterion is evaluated for the
  awaiting node when the promise is made, as the target is
  (`managedRelease(exempt, …)` in managed.ts). **Rejected:** making exempt
  promises untargeted, which loses the node the exemption criterion is
  decided for.
- *Rejections are queued jobs, and a rejected promise keeps its source.* A
  rejection runs as a microtask queued under no frame and re-enters the
  awaiter's captured context, so a `.then(_, h)` never runs inside the
  `then()` that attached it, nor inside `abort()`. It empties the cells it
  rejects but keeps the source, resume step, `waitsFor` and sleep deadline,
  so a failure handler's await of the same promise is still delivered
  (DESIGN.md §4.7). With that, the development warning about a handler
  awaiting a spent wrapper had nothing left to report and went, with the
  warning for a body that settled after it was counted frozen and the
  `node:frozen` event. **Cost.** A rejected promise's source holds its
  resume step, and through it its nodes, until the source settles; a
  `never()` raced in a loop stays armed on its node until the delivery.
- *`unshield` is the hole in a shield: `shield` plus `unshield` are Effect's
  `uninterruptibleMask` plus `restore`.* Inside a shield `signal()` is the
  release deadline, so nothing started there hears the owner's interruption
  (the owner is the node the shield runs on, its release fiber's parent: the
  current node for the free `shield`, `ctx` for `ctx.shield`, never the body
  that called `ctx.shield`, since the shield is that node's release work,
  holding it open and resolving through it), and a library helper that
  wants "non-cancellable except for this one await" needs a hole. By hand it
  is a child linked to `current().parent!.signal`, which is right only in the
  shield's own body: in a call made there, `current()` is the call's node and
  `.parent` the shield's release fiber, so the hole is linked to the deadline
  and silently never fires. `unshield(t, …args)` walks up from the node it is
  made on to the nearest shield's release fiber, which the one flag a shield
  already carried marks (`isShield`, which routes its failure and ends its
  lending with the lender's body; an entry's release fiber has it unset),
  and links the child to that fiber's parent's signal through
  `NodeOptions.signal`, combined with the task's own by `AbortSignal.any`.
  It is attempt-shaped because the hole is the one place in a shield where
  the owner's interruption arrives, and the shield's body is release work
  that must go on: an outcome lets it branch (carry on after `aborted`,
  rethrow a `failure`), where a rejection would unwind the very body the
  shield exists to keep running, and the lending keeps D11 (an unawaited
  hole is a forgotten await; a second `unshield` during one is refused with
  the hint that keeps the link, one hole around an `all()`, since an `all()`
  of the two in the shield would make its members children of the shield,
  linked to no owner). An owner already interrupted skips the hole:
  a linked signal that is already aborted settles any child unstarted,
  `observe` or not (DESIGN.md §4.6), which is Effect's `restore` under a
  pending interruption, and spares the hole's bare work (a peer notification
  not handed `signal()`). This supersedes the first specification of
  `unshield`, which had such a hole born delivered and run up to its first
  managed await (rejected below). An `observe` hole whose owner is
  interrupted mid-hole hears it through `signal()` and runs on, as any
  `observe` child does. A shield inside a shield, or inside a call made
  under one, runs on that shield's release fiber or that call's node, which
  is then its owner, so its holes follow only that node's own signal (the
  outer shield's release deadline, or the call's own delivery) and the
  task's interruption neither cuts nor skips them. That is Effect's rule
  too (`restore` restores the entry state of its own mask), and linking past
  the caller's shield to the task would let a helper's hole reopen a region
  its caller closed on purpose. Outside any shield it throws a
  `TypeError`, before anything is made: there is no owner to link to, and
  behaving as `attempt` there would hide a helper used where it cannot do
  what it says. No row in the error table: it is a misuse at the call site,
  as `race([])` is. A third name in the core surface;
  `ramme/no-unused-outcome` does not match it yet (D35). **Rejected:** a
  `restore` callback parameter on `shield` (`shield((restore) => …)`), a
  second name for a composition of two existing primitives, which code in a
  call below the shield would have to be handed explicitly; reading the
  owner off `current().parent`, for the call inside the shield above;
  running a hole whose owner was already interrupted up to its first
  managed await (the birth rule's `freeze` child), which repeats the bare
  work the interruption was meant to stop.

### D40. Why not generators (Effection)

*Being reversed, in stages, by D41 (provisional); stage 2 removed the async
profile below: bodies are generators, and there is no async context.*

Effection's operations are generators that its runtime drives (`yield*`
where ramme has `await`): halting an operation makes the runtime call the
generator's `return()`, so every `finally` runs, deterministically, and
there is no rejection for a `catch` to swallow and no foreign frame to tell
from the body's own, since control passes through the runtime at every
`yield*`. ramme chose `async`/`await` with async-context propagation instead,
for ergonomics (plain async functions, native stack traces and debuggers,
TypeScript's inference) and for library interop (every driver and every
`Promise`-returning API is awaited as it is, and `await using` works), and
it pays with rejection-based unwinding: an interruption reaches a body as a
rejection that a `catch` can see, so stickiness, outcome-by-state and a lint
rule (D39) do what the generator protocol does by construction. The trade:
interop and plain JavaScript, against one hazard Effection does not have,
the swallowed `catch`; generator-based operations would have made every
library call an adapter and every `await` a `yield*`.

### D41. Bodies are generators; the runtime is a driver *(provisional)*

*Provisional: this entry records a decision that lands in stages, and is
completed when the last stage lands, when D40 becomes its rejected
alternative and D9′, D13 and D39 are superseded. Stages 1 and 2 have landed:
the driver and ops, then the removal of async bodies, the async context, the
bridge machinery and lending. The full record (the alternatives, the costs,
the probes and the review) is PROPOSAL.md at the repository root while the
stages land; the last stage deletes it and completes this entry.*

A body is a generator function that the runtime steps, and every wait is a
`yield*` of an op the driver sees, so an interruption no longer travels as
a rejection: the driver halts the body by calling its generator's
`return()`. A `finally` runs, and one in the body's own generator function
may wait, as release work; a `catch` never sees the interruption; nothing is
sticky. The current node is a synchronous slot the driver sets around each
step, so bodies need no async context on any platform, and plain async code
reaches ramme through an explicit receiver, `promised` or `node.run`.

**Why.** Native `await` resumes a function in a job userland cannot wrap
(D9′), so ramme learns of a body's waits only through the promises it hands
out, and of the body's position only through the async context. Most of
DESIGN.md §4.2's machinery compensates for that: bare and managed awaits,
the supported-shapes list, sticky rejection and its exemptions,
`InterruptedError` and the classification by awaiter, call-shaped deferral,
lending, four async-only lint rules, and the storage adapters with their
browser boundary. A generator body turns the halt into `return()`, the
swallowed `catch` into an impossibility, and the adapters into a slot, while
keeping D39's call-shaped halt (a `finally` around `yield* call(t)` runs
after `t` has stopped) and D40's interop through one generic wrapper,
`wait(p)`, and one for a library's async callback, `promised(body)`.

**The stages.**

1. *Ops and the driver* (landed): every waiting verb's result is an
   `Op` (an `Operation`, iterable, and still the eager promise it was);
   generator bodies, releases and failure handlers are accepted beside async
   ones, and a returned op is driven; a generator body is halted by
   `return()` where §4.2 rejects an async one, with its `finally` run as
   release work on an unwind fiber (U3); `wait` and `promised`
   (DESIGN.md §4.14). Each step runs in the node's frame through today's
   `runInFrame`, so a generator body still needs `ramme/node` or
   `ramme/async-context`, as an async one does.
2. *Removal* (landed, this release): async bodies refused; `ramme/node`,
   `ramme/async-context`, the storage registry, sticky rejection,
   `InterruptedError`, `managed` and lending deleted; work ops lazy,
   construction reading the slot; the halt rows in the driver; a codemod
   (scripts/codemod-generator-bodies.mjs); the four async-only lint rules
   deleted, `no-async-body` and `no-unused-op` added.
3. *Expected failures*: `yield* fail(e)`, `E` inferred on tasks, a four-way
   `Outcome`; `gen` retired.
4. *`ramme/platform`*: `fetch`, `listen`, `nextFrame`, `each`; a browser
   smoke test.
5. *Documents and benchmark*: DESIGN.md and DECISIONS.md rewritten around
   this entry, which is then completed.

**Settled while implementing stage 1.**

- *U3, not the two-node frame* (the proposal's open question 1): in a halted
  `finally` every synchronous verb (`current()`, `signal()`, `lookup`,
  `own`, `release`, `releaseAll`, `fork`) addresses the node, and only the
  call-shaped ops made there (`call`, `attempt`, the groups, `promised`
  callbacks) run on the unwind fiber. Re-run against U3, the review probes
  that could have refuted it do not: a throw from the halted `finally` is
  discarded (p6); `release(tx)` and `releaseAll()` there find the body's
  entries (p7); a failure the `finally` catches from `release`, `call` or
  `attempt` still folds in once (p8); a second `return()` while a helper's
  `finally` is suspended skips the rest of that block, and the body's
  `finally` still runs and waits (p9). U3's costs stand as stated: a `fork`
  there is born delivered, and `signal()` there has fired, so cleanup that
  needs a deadline writes `wait((signal) => p)`, which is handed the unwind
  fiber's.
- *A shield in a halted `finally` stays on the node*: a release fiber is
  never born delivered nor cancelled whatever its parent, and on the node,
  whose interruption has come, an `unshield` in it is skipped at once, as in
  an interrupted async body's cleanup (D39). On the unwind fiber it would
  have run, bounded only by the deadline.
- *`Op<T>` extends `Promise<T>` in this stage*: every op is a `Promise`
  subclass at run time, and existing code calls `.catch` on `join`, `all`,
  `call` and `close()` results (a `PromiseLike`-only `Op` is 50 type errors
  in the existing tests); stage 2 narrows it with laziness.
- *`Body` keeps one function type with a union return*:
  `Generator<Instruction, T, unknown> | Op<T> | Promise<T> | T`. Its members
  are inferred before the bare `T`, so a generator that only throws is
  `never` and a plain value is itself; a union of function types, or an
  `Operation<T>` member, makes every iterable value (a string, an array, a
  `Map`) infer as an operation, and refuses those plain bodies. The cost:
  `Operation<T>` annotates only a helper that is `yield*`ed; a helper a body
  returns (`task(() => helper(x))`), and a body that needs an annotation, is
  typed `Generator<Instruction, T, unknown>`.
- *`wait(op)` is the op's own wait*: a ramme op handed to `wait` (or
  `managed`) keeps its shape, its `waitsFor` and its holder's report of its
  failure, so `wait(db.close())` in a halted `finally` reports a failure once
  and `wait(current().close())` is decision 12's return, as the op yielded
  bare is. Only a user promise's own rejection is a foreign failure, and only
  that is recorded on the unwind fiber; a rejection ramme makes (an
  interruption) never is.
- *An op made before the halt, yielded in the halted `finally`*
  (transitional, eager ops): release work there, waited for as a failure
  handler waits for it, never rejected with the body's own interruption; a
  `never()` returns the generator with a warning. Lazy ops remove the case.
- *Decision 12 covers a join of what only the unwound node's release ends*:
  a `join` or `result`, in the halted `finally`, of an owned fork of the
  node or an ancestor whose body has not ended waits for a release that waits
  for that `finally`; PR #4's async profile rejected it at once, and the
  generator profile returns there with the warning instead of deadlocking.
- *`promised` follows A.3*: the callback's failure is consumed by its
  promise unless the captured node is a halted body, so a failed ROLLBACK in
  a halted callback surfaces from the node, as under `yield* call(body)`. A
  call during a creation is refused (I16).
- *The lost-halt detector* (decision 29): a lost halt gives the body the
  halt's sentinel as the helper's `yield*` value, so dev mode's sentinel
  reports any use of it, besides a finish with another value; a body that
  only returns the sentinel unused goes unreported.


**Settled while implementing stage 2.**

- *The halt at a `yield*` of an op not yet started is a job.* A body that
  finds its node applied at such a `yield*` (row 4, a body born delivered,
  one resumed by release work) is returned in a microtask queued under no
  frame, as the delivery's own halt is, never inside the step: a fork made
  just before it starts first, so a born-delivered child runs its first
  step (decision 9) before its parent's release would cancel it unstarted.
- *Lifecycle ops are `Op<void> & Promise<void>`* in the types: `.catch` on
  `close()` stays valid, and a work op is a plain `PromiseLike`. Each
  consumer of either, `yield*` or `then`, is resumed in the source's
  reaction, so `await op` resumes one job after the source settles, as a
  managed promise's did; the D16 watch is told after the consumer resumed.
- *`Body` keeps `Op<T>`, not `Operation<T>`*: an `Operation<T>` member reads
  an array's or a string's iterator as an operation's and refuses those
  plain bodies; the union's last member is `never` for a thenable, which is
  what refuses an `async` function. A guard on the generator member against
  `return op` was tried and dropped: it refuses every generic body.
- *A failure handler still detaches*: its driver reports each op's
  `waitsFor` to the run before running it, so a generator handler, or one
  returning an op (decision 28), that waits for its parent's completion
  holds nothing; a promise a handler returns is a bare wait, which cannot.
- *The group bodies of `all`, `race` and `settle` are generators* waiting on
  never-rejecting sources a halt returns at once. A member fork that throws
  (an invalid option) now does so before any member started, so the group's
  error comes alone where an async group body had let a synchronously
  failing member run first.
- *`run(fn)` returns an op as a value*: a work op runs nothing until it is
  consumed, so it is not refused as a promise would be; a generator still is.
- *`wait(op)` returns the op itself*, so its shape and consumption are the
  op's; `$` in `ramme/result` takes a `PromiseLike` (an op is no longer a
  `Promise`).
- *Decision 12 covers the hazard stage 1 documented*: an `observe` child
  forked in a halted `finally` (a `fork` there addresses the node, whose
  delivery has passed, and an `observe` child is not born delivered) is
  delivered only by the node's release, which waits for that `finally`, so a
  `join` or `result` of it there waited forever: `node:stalled` reported the
  node and its unwind fiber, never the child, and nothing bounded the wait
  (`root.abort()` stops at the node, delivered already). The predicate now
  holds for a fiber reached from the node along subscription edges through
  no delivered node, whose body has not ended, so the generator is returned
  with the warning and the release then delivers the child; as for an owned
  fork, it does not ask whether the child would end by itself. Lazy ops did
  not change it: `fork` is eager. A `call` of one there runs on the unwind
  fiber and is release work, but one that waits for its own interruption
  never ends: nothing delivers the unwind fiber, its deadline does not reach
  an `observe` child, and only aborting the child ends it (DESIGN.md §4.14,
  "slow or unbounded work").
- *A thenable reads the step that made its op.* A `then` cannot see its
  consumer: the slot is synchronous, and `await` or `Promise.all` calls
  `then` a job later, under no frame. So a work op and a lifecycle op record
  the node of the step that made them (the unwind fiber in a halted
  `finally`), and their `then` consumes the failure it delivers unless that
  node is a halted body when the work settles, whose `wait(p)` discards the
  rejection; the record then stays with its holder and surfaces at
  completion, as `promised`'s does (A.3). Without it, `yield* wait(Promise.all
  ([call(a), call(b)]))` in a body halted while it waited lost `a`'s failure,
  which stage 1's managed promise kept. The receiver's state was the other
  candidate and loses D39's two cases: an aborted fork whose `Promise.all`
  waits for its live parent's `release(x)` (the receiver is live, so the
  failure was consumed into the fork's discarded throw), and a shield that
  catches its interrupted body's `release(x)` through `Promise.all` (the
  receiver is halted, so a failure the shield handled surfaced again).
- *U3 holds for `then` too*: an op made through the node in its halted
  `finally` records the unwind fiber, and its `then` runs it there, as the
  driver runs the `finally`'s ops, so `Promise.all([call(a), call(b)])` or an
  async helper awaiting an op made there runs its cleanups as release work,
  not born delivered and halted at their first `yield*` (with their
  `FiberAbortedError` recorded as a release failure). An op made before the
  halt and run through `then` after it runs on the node, as a `promised`
  callback made before the halt does.
- *A `then` during a creation is refused*, as a `promised` callback is: a
  `then` that would run a work op inside a factory rejects with
  `CreationViolationError` and runs nothing (I16), and the op stays unrun; a
  `then` of one already running only subscribes.
- *`wait(fn)` keeps the `waitsFor` of the op `fn` returns*: it is known only
  once `fn` ran, so the driver tests it after running the op, before it
  subscribes (decision 12's return, with the warning), and a failure
  handler's driver reports it then (its detach).
- *A stored `join` or `result` checks its receiver when it runs*, as a
  stored `call` did through its attach: run after the receiver completed, it
  throws `NodeCompletedError`, where it rethrew a failure the completion had
  surfaced and emitted `join:enter` on a node after its `node:complete`.
- *A source whose `then` throws* (a `Promise` subclass overriding it, which
  `wait(p)` keeps as its source) fails the wait at the `yield*` (I10): the
  driver answers it as the source's rejection, where it escaped the step as
  an uncaught exception and left the node running.
- *`Body`'s guard refuses an `async function*` in the types*, as PROPOSAL.md
  §6's `Plain<T>` does: its last member is `never` for an async iterator as
  well as for a thenable.
### D34. `sleep(ms)`: ramme's timer is a managed await

*Amended by D41 (stage 2): `sleep` is a lazy work op, its timer armed when it
is yielded; a halt returns the waiting body at once and clears the timer,
nothing rejects; a failure handler's `yield* sleep` is its own run, so the
handler's timer to the body's deadline below is gone, as are lending and
`managed`.*

A free function `sleep(ms): Promise<void>` and a method `ctx.sleep(ms)`
resolve after `ms` milliseconds. Both are body-shaped, like `never` and
`managed`: `CreationViolationError` in creation, `NoCurrentNodeError` for the
free function outside any node (`ctx.sleep` with no current node is a plain
delay), `PendingNodeError` on a pending node, and `UnawaitedCallError` when
the awaiting node is lent, a failure handler going through its lent parent
included. `ms` is a number in [0, 2^31 − 1], the bound of every ramme
timer; anything else is a `RangeError` naming the value and the bound and
suggesting `never()`, thrown before a timer is armed. It is a managed await
(D13) whose target is decided when the promise is made: the current
node when it has a body, is not `observe`, is not a release fiber and the
frame is not a failure handler's. A target already applied arms no timer,
and the sleep rejects with `InterruptedError` as soon as it is awaited.
Otherwise the target's delivery clears the timer, whether the sleep is
awaited or only stored, and then rejects a `freeze` or `restore` body
awaiting it, as any managed await (amended by D39, which replaced the
freeze); the timer removes its clearing entry when it fires. Without a
target the sleep runs its full duration. The timer is armed under an empty
frame (DESIGN.md §6) and is not unref'd.

**Why.** A timer is the most common bare await, with a measurable cost at
interruption. Interruption acts only at a managed await, so a bare
`await setTimeout` in flight when its node is delivered keeps the node
alive until the timer fires: an aborted request held its connection lease
for the full duration of a bare wait, and the workaround, a user-written
timer promise awaited as `await managed(delay(20, signal()))`, took two
wrappers around it. Clearing at the delivery is what makes the
interruption complete: no timer outlives it. Arming none for a target
already applied follows, since the await rejects at once. A failure
handler's awaits are never rejected (DESIGN.md §4.7), so its sleep is
never cleared by its parent's delivery, and a handler that backs off with
`await sleep(…)` resumes. ramme's own timers are unref'd because they only
diagnose or bound a wait; a sleep is the wait, and a top-level
`await app.sleep(n)` must not let the process exit before it resolves.
**Rejected:** `managed(setTimeout-promise)` as the idiom: two wrappers, and
the timer survives the interruption; patching the global timers, which is not
zero-dependency and not ours to patch; a `sleep` that rejects or resolves
early for `observe` bodies: an `observe` body reacts through `signal()` and
`interrupted()` (DESIGN.md §4.3), and an early resolution would run the next
iteration of a loop as if the time had passed. **Cost.** `setTimeout`,
`setInterval` and `setImmediate` in application code become lint errors
(D35), and `fork` with a loop on `sleep` replaces `setInterval`. A failure
handler cannot sleep through a parent that is lent; it forks the wait. One
more name in tier 1. DESIGN.md §4.2, §4.4.

Settled while implementing it:

- *A failure handler that awaits a body's sleep waits on a timer of its
  own.* A handler's awaits are untargeted and are delivered when their
  source settles (DESIGN.md §4.7), but a targeted sleep's source is the
  body's timer, which the body's delivery clears, and a sleep the body made
  after its delivery has no timer at all. A handler awaiting either would
  wait on a promise that never settles and hold its parent open, with no
  report. So a handler's await of a targeted sleep arms a timer of its own,
  outside every frame and not unref'd, to the sleep's deadline (and at most
  `ms` after the handler's await, however the wall clock moves), whatever
  became of the body's. The body's timer is still cleared at its delivery,
  and the wrapper keeps only the deadline, so nothing of the body is
  retained. **Rejected:** keeping the body's timer running while a handler
  awaits it, which lets it outlive the interruption and still leaves a
  handler that first awaits after the clear, or after the delivery,
  without one; a development warning for the hang, which reports a hang
  ramme can avoid. **Cost.** A handler that awaits a body's sleep before the
  delivery arms a second timer to the same deadline.

### D14. A `'join'` fork onto a bodiless node is refused

`fork` with the default `'join'` destination onto a live bodiless node that
is not a pool (`root.fork(t)`, `child().fork(t)`) throws `TypeError` at the
call. In a constructor the fork is recorded and checked when the factory
returns, so `own(fork(...))` and a fork with `onFailure` are accepted, and
an unowned `'join'` fork fails the resolution synchronously with the
pending node released.

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

### D23. Failure destinations, and an owned fiber's failure aborts its owner

A fiber's failure goes to one destination, set at the definition or per use
(`onFailure`): `'join'` (the default: held for `join`, `result` or
`asyncDispose`, and surfaced from the parent's completion if nothing
consumed it), `'link'` (aborts the parent at once, and surfaces from its
completion), or a handler (called once, at the fiber's completion, with the
parent current; a promise it returns holds the parent open). An owned fiber
whose failure arrives while its owner is open also aborts the owner (C5).

**Why.** `'join'` is the default because a fork is most often a value the
body will read: the failure belongs to whoever reads the value, and the
parent is the reader of last resort, so no failure is lost and none is
reported twice (I11). `'link'` is for a helper the parent cannot continue
without, where a failure held for a later `join` would let the parent go on
with a broken assumption. A handler is for supervised work whose failure is
handled where it happens. It runs at completion, not at settling, so it
sees the final failure, release failures included (D24), and with the
parent current, so a restart (`fork` in the handler) lands where the failed
fiber was. It holds the parent through its returned promise because a
handler that does asynchronous work (report, then restart) would otherwise
be cut off by the parent's completion. Two refinements keep the hold from
deadlocking: a handler awaiting the completion of its parent or an ancestor
holds nothing from then on (it would wait for itself:
`onFailure: () => app.close()`), and while a hold lasts on a parent whose
stacks are otherwise empty, each node entry the handler attaches is
released as soon as it is attached (a handler awaiting its own restart
would otherwise wait for a fiber that only the parent's release
interrupts). An owned fiber is infrastructure its owner relies on (D19), so
its failure means the owner is broken: aborting the owner fails fast where
a held failure would wait for a `join` no body makes. **Rejected:** `'link'`
as the default, which turns every background failure into its parent's
death; a handler called at settling, before the fiber's releases have run;
a handler that cannot hold its parent; holding an owned fiber's failure
like a subscriber's. **Cost.** An unjoined `'join'` failure is reported
only when the parent completes, which may be much later. While a handler's
hold lasts, a node entry can be released before a passive entry attached
above it, the one exception to C4's order. DESIGN.md §2.6, §4.7.

### D28. `all` and `race` follow nodes, not promises

`all` and `race` run their tasks as subscribers of a fresh group fiber,
which the caller `call`s. `all` resolves with every value in order and
rejects with an `AggregateError` of every real failure, excluding aborted
members (`FiberAbortedError` when members were aborted and none failed).
`race` resolves with the first `success`, aborts and awaits the rest, and
rejects only when no member succeeded. Members always run as `'join'`
fibers of the group, whatever their own destination.

**Why.** Each departs from the `Promise` combinator of the same name because
its members are nodes: a member is done when its node has released, not
when its value is known, and its failure must be consumed exactly once
(I11). `all` therefore waits for every member before it reports, and then
reports every failure; rejecting with the first, as `Promise.all` does,
would leave the others to be dropped or reported separately. `race` takes
the first success, `Promise.any`'s rule, because its use is redundancy: in
`race([primary, replica])` a replica that fails fast must not beat one
that answers. Members run as `'join'` because the group is their reader: a
member's own `'link'` would abort the group before it aggregated, and a
handler would take the failure away from the result. The group is one
fiber so that the caller makes one managed await and is interrupted as a
whole, once the group has completed (D13, D39). **Rejected:** `Promise.all` and `Promise.race` semantics (first
rejection, first settlement); honouring each member's own destination.
**Cost.** `all` does not stop at the first failure: the other members run
to their end before it rejects, and fail-fast is a body that forks with
`'link'`. The names match the `Promise` combinators while the rules
differ. DESIGN.md §4.8.

### D31. Outcomes as values: `attempt` and `settle`

`attempt(t, …args)` (also `ctx.attempt`, `t.attempt`) is `call` with
`result`'s resume step: the same child, started synchronously, the current
node lent until it completes, and a managed await that rejects an
interrupted `freeze` or `restore` caller with `InterruptedError` once the
child has completed (amended by D39, which replaced the freeze); it
resolves with the child's `Outcome` and consumes a failure instead of
throwing it. `settle(tasks,
opts)` (also `ctx.settle`) is `all` that resolves with every member's
outcome instead of rejecting: its members run as `'join'` fibers of a group
the caller `call`s, each runs to its end and none is aborted on a sibling's
account, as in `all` (D28), and it resolves with the tuple of outcomes in
order once every member has completed. A member's failure is held by the
group's parent, not by the group, until `settle`'s resume step consumes it.
`settle` rejects only with a failure of the group's own, and then with the
members' failures attached and consumed, in the shape `all` rejects with.
`call` and `all` stay as they are.

**Why.** A body that branches on how other work ended had one tool:
`try/catch` around `call`, where a `catch` sees a real failure or a
`FiberAbortedError` (DESIGN.md §2.6). "Try with a deadline, fall back" was
`try { await call(t.with({ timeoutMs })) } catch (e) { if (e instanceof
FiberAbortedError) … else throw e }`: a catch that must rethrow what it did
not mean to handle, around an `instanceof` test. With the outcome as a
value, `aborted` is a branch. For a `freeze` or `restore` caller it
describes the child (its `timeoutMs`, its `signal`, an explicit abort),
because the caller's own interruption rejects the await with
`InterruptedError` (D39) instead of arriving as an outcome: the
interruption is not a value a body can branch past. A `restore` child (or
`settle` member or group) is the exception: it hears every delivery on its
subscription path (D20), including one its caller does not hear, so an
`observe` ancestor's interruption, which that ancestor does not forward to
a `freeze` caller below it, comes back to the caller, which is not
interrupted, as `aborted`, and so does an `observe` caller's own, since its
awaits are never rejected. The `observe` body sees its interruption by design
(DESIGN.md §4.3) and checks `signal()` before it falls back; the `freeze`
caller's `signal()` has not fired, so a deadline fallback that can run below
an `observe` region tests the reason instead: the child's `timeoutMs`
delivers a `TimeoutError` `DOMException`, which an ancestor's interruption
carries only when it was itself a deadline. The outcome is the one `result`
already reports, decided by state (D24), so nothing new is classified.
`attempt` keeps what `call` has and `result(fork(t))` lacks: the body starts
synchronously (D22) and the current node is lent (D11), so an unawaited
`attempt` is caught as an unawaited `call` is. `settle` is the form for
several tasks, and the structured replacement for `Promise.allSettled`,
which does not structure its members (DESIGN.md §4.2): the group is
interrupted as a whole, its members are aborted and awaited with it, and
nothing is consumed before the caller resumes. The members' failures
wait on the group's parent because the group completes before its caller
resumes: held on the group, they would be folded into the group's outcome at
its completion, so the group would report its members' failures as its own;
consumed by the group's body, they would be lost whenever the caller was
interrupted while the group ran on (I11), which a group on another node
(`ctx.settle`) does. On the parent they are what a joinable failure is, delivered by one
resume step or surfaced once from the parent's completion. When the group
fails on its own account (a member's fork that threw is one), the resumed
caller is still handed them, with the group's error: left held on the
receiver, they would surface from the caller's completion after its `catch`
had already handled the rejection, which `all` never does.
**Rejected:** `result(fork(t))` as the idiom, which loses the synchronous
start and the lending; making `call` itself resolve with an outcome, which
hides every failure by default, so the forgotten check is silent where a
forgotten `catch` today is loud; resolving with `aborted` for the caller's
own interruption (D39); `settle` as an option on `all`, which
waits the same way and differs only in the result shape (values and a
rejection, or outcomes), two result types under one name; holding the
members' failures on the group, or consuming them in its body (above).
**Cost.** An outcome nobody inspects drops its error silently: `await
attempt(t)` with no look at `status` is the failure mode outcomes-as-values
invite, which is why `call` stays the default and `attempt` is opt-in.
`ramme/no-unused-outcome` flags a discarded `attempt`/`settle` (D35). A
`restore` child inside an `observe` region can hand a caller that was not
interrupted the region's shutdown as
`aborted`, which only its reason tells apart from the child's deadline. Two
more names in tier 1; `attempt` emits `join:enter`/`join:leave`, which
`call` does not. DESIGN.md §4.5, §4.8, §4.12.

### D38. `Result` is `Outcome` minus `aborted`; data only; `gen` and `$` are the `?` operator

A failure a caller is meant to branch on is a return value, typed:
`Result<T, E> = Success<T> | Failure<E>`, that is `{ readonly status:
'success'; readonly value: T } | { readonly status: 'failure'; readonly
error: E }`, a core type, and `Outcome<T>` is `Result<T, unknown>` plus
`{ status: 'aborted', reason }`, with exactly the structure it had before.
Everything thrown is a defect, handled at task boundaries (`attempt`,
`onFailure`) and translated there, never used as domain control flow; an
interruption is neither (D24). The helpers are free functions over plain
objects in the subpath `ramme/result`, which imports only types from the
core: `success`, `failure`, `isSuccess`, `isFailure`, `map`, `mapFailure`,
`andThen`, `orElse`, `unwrap`, `unwrapOr`, `fromThrowing`, `collect`, and
`gen` and `$`, which supply `?`: inside `gen(async function* () { … })`,
`yield* $(r)` evaluates to the success value, or yields the failure, which
ends the run as `gen`'s result, and `gen` infers the error union from the
yields. Each helper takes the whole `Result` as one type parameter and
reads the value and error types off it, so a member of the other kind
contributes `never`.

**Why.** Libraries written for ramme need one envelope to compose, or each
invents its own `{ ok, data }` and every boundary between two of them is an
adapter. The envelope is `Outcome`'s, so `attempt` on a task that returns a
`Result` is two layers read with one vocabulary, and its discriminant key
is `status`, as `Promise.allSettled` names it; `allSettled`'s values are
`'fulfilled'`/`'rejected'`, with `reason`, and the values here are ramme's
`Outcome` words. It is a plain object, so it survives JSON, structured
clone and other libraries' helpers, and a hand-rolled object of the shape
needs no adapter. The payload survives only as far as its own values do:
JSON drops an `Error`'s message, and structured clone does not keep an
`Error` subclass. The error channel stays untyped at the task boundary,
because a declared `E` on a thrown failure is a claim, not a proof:
whatever a body calls can throw anything, and only a returned value has the
type its function declares (Effect's typed `E` needs the Effect wrapper,
which ramme rejected together with `R`). `gen` infers the union from the
yields and unwinds as data, not as an exception, so no `catch` can swallow
the failure and nothing has to be declared. The helpers take the whole
`Result` because a `Result<T, E>` parameter fails in two ways. TypeScript
takes one inference candidate for `E`, so it refuses the inferred return
type of an unannotated fallible function, `Failure<A> | Failure<B> |
Success<T>`. And it infers `unknown` for a type parameter with no
candidate, so `andThen(r, (v) => success(v + 1))` over `r: Result<number,
UserNotFound>` would be `Result<number, unknown>`, and one
`yield* $(success(1))` would widen a `gen`'s whole error union to
`unknown`. Read off the whole `Result`, every error of a union is kept and a
`Success`-only argument has error `never`, with nothing annotated.
**Rejected:** a class with
methods, neverthrow-style, which puts behaviour on the data and needs an
adapter for every other shape; typed `E` on tasks (above); a thenable `$`,
`await $(p)` with a declared `E`, which unwinds by exception through every
intermediate `catch` and needs the type declared; `$` lifting functions
(`$(getUser)(id)`), which loses `this`; making `Result` iterable, so that
`yield* await getUser(id)` works without `$`, which puts behaviour on the
data and still needs `$` for foreign results; `$` as an `async function*`,
whose `return` awaits its operand, so a thenable success value would be
unwrapped, a fiber's `then` would throw `FiberNotAwaitableError` (I27), and
`$` would add a managed await that the type `T` does not show; an `Option`
type; a synchronous `genSync`, left out until asked for; `match`, `tap` and
other combinators, since narrowing on `status` is the combinator library
and code that wants chaining wraps the plain object in neverthrow in one
line. **Cost.** Two more concepts, and `yield*` syntax. Generators are not
arrows, so `this` needs the overload `gen(thisArg, body)`. The interplay
with interruption had to be verified and documented (DESIGN.md §4.2):
`await gen(…)` over `yield* $(p)` is rejected as `await call(t)` is, and the
`InterruptedError` propagates out of `$`, the generator and `gen`, which
never turns it into a `Result` (D39); a stored `gen(…)`, or one used as a
combinator member, is a derived promise that rejects on interruption and is
an unhandled rejection unless awaited at once, not merely a floating
promise. A `fromThrowing(…)` over a managed promise that is stored, dropped
or used as a combinator member arms the managed await at once and can
consume a failure that a body interrupted elsewhere never reads; and
`fromThrowing`'s `catch` takes every error, so over the caller's own
interruption it gives `failure(InterruptedError)`, a swallow no lint sees,
and its promise still never rejects. `gen` does not call the generator's
`return()` on a yielded failure: that would run the body's `finally`
blocks, which are not where a body's cleanup belongs (A7, as D39 restates
it). `gen` is an async function, so a dropped `gen(…)` whose body throws
is an unhandled rejection, and the node does not surface that failure,
which `$`'s await consumed; I10 is therefore stated for the core's promises.
`@typescript-eslint/no-floating-promises` flags a bare `gen(…)` statement,
but only with type information, and not `void gen(…)` or `await gen(…);`
with its `Result` discarded, and nothing else reports those:
`ramme/no-unused-outcome` matches `attempt` and `settle` only (D35).
TypeScript compares types by structure, so error classes need a
distinguishing member to stay separate in an inferred union. Three more
names in the core surface, and a subpath of fourteen functions. DESIGN.md
§4.2, §4.12, §4.13, §9.

Settled while implementing it:

- *`fromThrowing` keeps the three overloads in the order given, async
  function first.* Otherwise `fromThrowing(async () => …)` matches
  `() => T` and is typed as a `Success` holding an unfenced promise, whose
  rejection goes unhandled. The order has one visible edge: a function
  whose return type is `never` (it only throws) matches `() =>
  PromiseLike<T>` first and is typed as a promise, while the call returns
  the failure synchronously; giving the function its return type (`(): T
  => { throw e }`) picks the synchronous overload. The `() => T`
  overload's return type is conditional on `T`. A return type with a
  thenable member (`number | Promise<number>`) gives `Result<number,
  unknown> | Promise<Result<number, unknown>>`, as the runtime chains a
  returned thenable; `Result<T, unknown>` would type a promise as a
  `Result` whose `status` reads `undefined`, so neither branch on it runs.
  `any` (`() => JSON.parse(s)`) and `unknown` say nothing of a thenable and
  are typed synchronously: such a function that returns a promise gives a
  promise its type does not show, so give it its return type, or fence the
  promise itself. **Rejected:** a conditional overload that excludes
  `never`, which is a fourth signature for a function nobody fences on
  purpose; typing `any` as either, which would make
  `fromThrowing(() => JSON.parse(s))` a union to await.
- *A function's result is chained only when its `then` is a function.*
  `fromThrowing(f)` fences the call of `f`. It then reads `then` on what
  `f()` returned, and a read that throws counts as no thenable: a fiber's
  `then` getter throws (I27), and a fiber is a value, which the core does
  not probe either when a failure handler returns one. So
  `fromThrowing(() => fork(t))` is the fiber as a success, and
  `fromThrowing(() => pool.fork(job))` fences pool intake, which `attempt`
  cannot: the fiber, or `PoolFullError` or `PoolClosedError` as a failure.
  **Rejected:** reading `then` inside the fence, which made the throwing
  read `f`'s failure although `f` returned: an admitted fork read as
  `failure(FiberNotAwaitableError)`, as a refused one does, and its handle
  was lost.
- *The helpers take the whole `Result` as their type parameter.* The first
  signatures were `<T = never, E = never>(r: Result<T, E>)`, and `$` took
  `Result<T, E> | Promise<Result<T, E>>`. An unannotated function that
  returns `failure(new InvalidCard())` or `failure(new Insufficient())` or
  `success(receipt)` infers `Promise<Failure<InvalidCard> |
  Failure<Insufficient> | Success<Receipt>>`, and TypeScript took the first
  `Failure`'s error as `E` and refused the second, at `$` and at every
  helper. Each helper now takes `R extends Result<unknown, unknown>` and
  reads `SuccessOf<R>` and `ErrorOf<R>` (unexported), as `gen` already did.
  `$` takes its argument whole and reads it through `Awaited`, so a union of
  promises (`$(c ? getUser(id) : getAdmin(id))`) is taken too, which an
  `R | Promise<R>` parameter, one candidate per promise, still refuses.
  **Rejected:** keeping the `Result<T, E>` parameters and requiring a
  fallible function to annotate its return type as one `Result<T, E1 |
  E2>`, a rule nothing enforces, broken by every unannotated function with
  an error far from its cause.

### D15. Pool intake stops at the signal

`pool.fork` throws `PoolClosedError` once the pool is delivered or `close()`
was requested, and `NodeCompletedError` after completion.

**Why.** A deliberate exception to I8 (operations work between delivery and
completion) for intake infrastructure: a fiber forked into a delivered
`freeze` pool would be born delivered and be rejected at its first managed
await, which is work accepted only to be thrown away. `close()` fires no signal, so
a fork into a closing pool would run normally; it is refused for another
reason: a graceful close waits for the pool's work, its queue included, so
open intake would let a producer that keeps forking hold the pool, and its
owner's shutdown, open indefinitely. Either way the caller learns it at
once. **Rejected:** accepting forks into a closing pool until its queue
drains. **Cost.** A producer that races shutdown must handle
`PoolClosedError`. DESIGN.md §4.10.

*Accounting counts only the pool's own fibers; abort stops the queue, close
drains it.* `running` and `pending` move only for fibers the pool admitted,
never for release fibers, DI values placed on the pool or passive
`pool.own(x)` entries: those hold no slot, and counting their completion
would let one more fork run than `concurrency` allows. A fiber frees its
slot at completion, before its failure reaches `onFailure`, and the same
step admits waiters in order. A handler can therefore restart the failed
fiber (supervised background work) even at `concurrency: 1` under
`'reject'`, where freeing the slot after the handler would make the
restart throw `PoolFullError` and fail the pool; under `'wait'` the
restart queues behind forks already waiting. Once the pool is delivered,
including by an `abort()` that forces an earlier `close()`, no waiter
starts and the queued ones settle `aborted` without running, as any fiber
aborted before its body started does. Under `close()` waiters still start
as slots free, because a graceful close waits for the pool's work, and the
queue is that work. A closing pool therefore lasts as long as its queue,
and `abort()` cuts it short.

### D16. What the release order guarantees

A node releases its explicit stack, then its provided stack, each in reverse
order. **G1** anything read from a node's provided values stays alive until
every explicit entry on that node has completed (unless that value's own
node is aborted first, DESIGN.md §2.5); **G2** explicit entries release in
reverse attachment order, which is dependency order iff a fiber uses only
what was attached before it was forked; **G3** provided values release in
reverse creation order, which is dependency order because `inject` runs
during creation; **G4** interruption reaches the whole subscribed subtree at
once (below a running `observe` body, only its `restore` descendants; D20).
Not guaranteed: order among subscribers during the signal; anything about a
reference that escaped to a longer-lived scope, except that use fails
loudly.

**Why.** Provided values are registered lazily, at a time the body author
does not control: a handler forked before the pool existed may be the one
whose `lookup` creates it. Only "explicit before provided" makes G1 hold
whatever the order of registration; LIFO within each stack gives dependency
order wherever dependencies were acquired first (A6), by construction for DI
values and by discipline for fibers. The previous three tree-wide phases
gave weaker, global ordering at the cost of every node waiting for the
slowest drain. **Rejected:** one merged stack in attachment order (a lazily
created service would be released before the handlers that read it); phases
(D3′). **Cost.** Three disciplines the type system cannot check: acquire
before you fork what uses it (G2); a value's release, and a value's owned
fibers, use only what the value injected or reads through its own node (G3);
and the sibling rule: a subscriber does not depend on a sibling subscriber's
liveness during its cleanup, since subscribers are interrupted together and
in no order (G4), so what it needs then is unsubscribed and attached earlier
(D19), or a provided value. Providing a body-owned resource on the same node
points a dependency from the provided stack into the explicit stack;
`ramme/no-owned-provider` flags it. DESIGN.md §2.4–§2.6.

Settled while implementing it:

- *One delivery reaches the subtree at once, and marks it before any
  listener runs.* `abort()` marks every node it reaches delivered, then
  fires their signals, then interrupts their managed awaits (I9). A listener on
  any of them, often foreign code reacting to an `AbortSignal`, therefore
  sees the whole delivery: every node it can reach in the subtree already
  reads as delivered, with the delivery's reason, so it cannot fork into a
  node about to be interrupted as if it were not (the birth rule, D12,
  applies), and an `abort(reason)` it makes on a child cannot replace the
  child's reason with its own. **Rejected:** level-by-level propagation,
  each parent forwarding as it handles its own signal, where what a
  listener sees, and which reason a child records, depend on listener
  order. The cost: delivery is two synchronous passes over the subtree, and
  no listener runs until the whole subtree is marked.
- *The outcome is fixed at settling and amended once at completion.*
  Classification by state runs when the body settles; release
  and unconsumed errors are folded in once, when the node completes. This
  is what makes `owner.outcome` readable in every release, so a transaction
  entry can commit or roll back on its owner's outcome; an outcome computed
  only at completion would not exist until every release had run. The
  price: a release reads the outcome from the body alone. A failure that an
  earlier release or an unconsumed child adds is folded in after it, so a
  transaction can commit on a node that then completes `failure`.
- *A release is idempotent by its entry's state, and its promise exists
  before any dispose code runs.* The entry is marked releasing, with a
  fresh promise, before its release fiber starts; any release that finds it
  releasing shares that promise, and `releaseAll()` re-checks each entry as
  it reaches it instead of trusting its snapshot. A second release
  (`releaseAll()` racing `release(x)`, an `abort()` arriving mid-
  `releaseAll()`, a dispose that synchronously re-enters its owner)
  therefore finds one release in flight and one promise to share (I2, C4,
  C7). Taking the promise from the release fiber's completion would fail
  the last case: a synchronous dispose re-enters before the fiber's start
  has returned, and would find the entry releasing with nothing to wait on.
- *`own(x)` with one argument is a no-op on a passive object this node
  already owns; C8 is about a second release.* One argument asks "make sure
  this node owns `x`", which is already true when a producer attached it on
  the body's behalf, so `own(await connections.acquire())` (a producer's
  resource, DESIGN.md §2.6) reads as written and returns `x`; making every
  second `own` throw would break that idiom for each producer that attaches
  before it returns. `own(x, release)` asks to register a release, and a
  second one for one object is `AlreadyOwnedError`. Cross-node duplicates of
  a passive object are not policed: `A.own(x); B.own(x)` registers two
  entries, each owner runs its dispose once, and `A.release(x)` leaves `B`'s
  entry live. Refusing them would cost every `own()` a write to a
  process-wide map from object to entry, to catch a mistake an idempotent
  dispose makes harmless; nodes themselves stay single-owner (`own(node)` of
  another node's entry is `NotOwnedError`, I1).
- *Every node except an entry's release fiber routes its final failure to
  its parent.* A child context, a pool or a DI value's node whose release fails
  completes with `failure`, and its parent holds that failure exactly as it
  holds a `'join'` fiber's, so "every unconsumed subscriber failure"
  includes it; a `close()` or `[Symbol.asyncDispose]()` on the node whose
  awaiter resumes consumes it. Routing only fibers would lose the failure of
  any such node nobody closed directly: its owner's release loop only waits
  on its completion, which never rejects. An entry's release fiber is
  excluded because its failure is that of the entry it released, which the
  owner already collects as a release failure (or, for an early release,
  holds for `release(x)`); routing it too would report it twice. A shield's
  release fiber has no entry, so its failure is routed as a `'join'`
  fiber's (D39).
- *An early release's error is unconsumed until the awaiter of `release(x)`
  or `releaseAll()` receives it.* The error rejects that call only when the
  call's awaiter is actually resumed; if its awaiter was applied (an
  interrupted body, handed the error without consuming it, D39), or never
  awaited, the error surfaces from the owner's completion instead of
  nowhere. An owner whose release loop ends while such an awaiter is still
  waiting completes only after the awaiter is resumed, so the error is
  reported once, not by both the call and the owner. The wait is short,
  since every entry in the call is released by then, and a call whose
  releases succeeded is never waited for. Leaving the error out of the
  owner's outcome while its awaiter waits would lose it if that awaiter
  then consumed nothing after the owner completed; waiting for every `releaseAll()` would hold owners that owe
  nothing. The call counts as awaited from its creation: `await` and the
  `Promise` combinators call `then` a microtask after they are evaluated,
  and the loop could end in that gap and fold in the error the caller is
  about to receive. Every call is counted, not only one that has already
  failed, since an async release can fail inside the gap; a failing call
  nobody awaits holds its owner for at most two microtasks.

### D17. Three error types beyond the core set

Besides `NoCurrentNodeError`, `NodeCompletedError`, `PendingNodeError`,
`NotOwnedError`, `AlreadyOwnedError`, `UnawaitedCallError`,
`FiberNotAwaitableError`, `FiberAbortedError`, `InterruptedError` (the
awaiting body's own interruption, D39), `PoolClosedError`,
`CreationViolationError`, `AsyncRunError` and `PlacementError`, ramme
exports `PoolFullError` (for `whenFull: 'reject'`), `OwnerInterrupt` (the
abort reason ramme itself produces when a parent's body exits or an entry
is released at its turn, so `signal.reason` is inspectable) and
`FactoryReturnedUndefinedError extends CreationViolationError` (a factory
returned `undefined`).

**Why.** `PoolClosedError` would be wrong for a pool that is open but full;
a reason a listener can test with `instanceof` is better than a generic
`AbortError` when the interrupt came from structure rather than from a
caller; and a subclass gives the undefined-factory rule a class without
changing `instanceof CreationViolationError` checks. **Cost.** Three more
names in the surface. DESIGN.md §4.12.

### D24. Outcomes are decided by state

A node's outcome is fixed when its body settles, by its state,
never by inspecting what the body produced: a `freeze` or `restore` node
delivered before that point is `aborted`, whatever the body returned or
threw, including when it caught its `InterruptedError` and returned
normally (amended by D39: an interrupted body unwinds and settles, where
under freeze it never did); an `observe` node's outcome is
its body's result; a bodiless node is `success` on `close()` and `aborted`
on `abort()`. The release phase amends it once: a body `failure` plus
release failures becomes `SuppressedError(releaseError, bodyError)`; a
`success`, bodiless or `aborted` outcome plus release failures becomes
`failure`.

**Why.** An error cannot tell whether its body was interrupted. A body
stopped mid-`fetch` may surface the fetch's `AbortError`, a `TimeoutError`,
a library's wrapper of either, or nothing at all; a real failure may be an
`AbortError` from an unrelated signal. The node's state knows whether it
was interrupted before the body finished, so the outcome follows state, and
an `aborted` outcome fires no failure destination (I12): what an
interrupted body leaves behind is not a failure. A body that swallows its
`InterruptedError` and returns a value is still interrupted: classified by
what it returned, the swallow would turn the interruption into a `success`
(D39). The release amendment
follows `await using`, where an error from disposal suppresses the body's:
the release failure is primary because it is the newer problem and the one
the owner would not otherwise see, and the body's failure stays reachable
as `.suppressed`. **Rejected:** classifying by error type (an `AbortError`
means aborted); keeping the body's failure primary, which hides a failing
release behind the failure that led to it; ignoring release failures after
an `aborted` body. **Cost.** A real failure that a `freeze` body's plain
code produces after its delivery is classified `aborted` and reaches no
one; work that must report failures during shutdown runs in `observe`
mode. DESIGN.md §4.12.

## Integration

### D5. Library keys carry default factories; the lookup-api bridge is retired

**A key a library defines for its own consumption carries a default
factory**, so the library works when the application wires nothing, and
the application overrides by providing the key. ramme no longer serves
lookup-api, a separate, dependency-free package through which a library
could read ambient services without depending on any container: the
library declared a *contract* (a named key with a fallback), and
lookup-api answered it through a resolver that a container installed
process-wide, or with the fallback when none was installed. ramme's side,
the bridge from contracts to ramme keys (`contractKey`, `contractProvider`,
and `installContractResolver`, which `createRootContext()` called), is
removed: `createRootContext()` installs nothing process-global, and ramme
has no runtime dependencies. The fallback survives as the convention
above.

**Why.** lookup-api existed so that a library could read ambient services
without committing to ramme. There is no such library: every library in
this ecosystem depends on ramme (D6′), and a neutral seam with one
implementation is only an indirection, one that also cost ramme a runtime
dependency and a process-global resolver. What lookup-api offered beyond
the fallback, ramme does per tree: a default is placed per tree, not
memoized once per process; a test overrides with a child's providers or its
own root, not through a process-wide override; and placement by view
(D10′) keeps an override from being baked into a hoisted default.
**Rejected:** keeping the bridge for hypothetical ramme-neutral libraries;
serving lookup-api's fallbacks as ramme default factories, which would have
kept the seam alive for no consumer. **Cost.** A library cannot be
ramme-neutral and still resolve ambient services; if such a library
appears, the seam can be rebuilt as a separate package over
`registerContextStorage` and keys. DESIGN.md §8.

## Diagnostics

### D29. Lifecycle events are a topic

Observability goes through DI: `createTopic(name)` makes an injection key
for a receiver function, and providing a receiver turns emission on. The
node tree's events go to `NodeTopic`, whose receiver must be a
construction-time provider on the root and is resolved once per root. A
receiver is a synchronous sink; one that throws is reported with
`console.error`, and its event is dropped.

**Why.** A key makes emission cost nothing when nobody listens: without a
receiver no event object is built and no stall timer armed, so the
instrumentation can live in the core. It is also scoped like everything
else (a test's root has its own receiver; two roots in one process share
nothing) without a process-global registry. Resolving once per root keeps
each emission to one field read, which is correct only if the answer
cannot change, hence a construction-time provider on the root: a later
`addProvider` would change an answer already given (D10′). A throwing
receiver is reported and its event dropped because emission runs inside
delivery and release steps that must not stop halfway (I2, I10); a bug in
tracing must not break the lifecycle it traces. **Rejected:** a
process-global event emitter; resolving the receiver per event; letting a
receiver's error propagate. **Cost.** A receiver cannot be added to a
running root: tracing a live process means providing, at startup, a
receiver that can be switched on later. A receiver must not use ambient
operations, since it runs in the emitting frame. DESIGN.md §5.

### D30. Development mode is on unless production is declared

Development mode is on unless `process.env.NODE_ENV === 'production'`, and
always on where `process` does not exist. It adds the checks and warnings
of DESIGN.md §4.4, `AsyncRunError` among them.

**Why.** The checks catch misuse that is otherwise silent (an unsupported
await shape, a promise returned to `run`, a late read that creates a value)
and cost little, so the safe side is on, and `NODE_ENV` is the production
switch servers and bundlers already set. `AsyncRunError` is one of them,
not an error in every mode, because the misuse is one of shape, caught by
the first development run of the code, and production keeps `run` a plain
call that returns what `fn` returned. **Rejected:** off by default, which
lets the misuse reach production in every project that did not opt in; a
ramme-specific switch every application would have to learn and set;
`AsyncRunError` thrown in every mode. **Cost.** Browser and worker bundles
run every check and warning unless the bundler defines
`process.env.NODE_ENV`, and so does a production server that does not set
it; code never run in development can pass a promise through `run`
unreported. DESIGN.md §4.4, §4.11.

### D35. Lints, not runtime checks

The hazards that are syntactic are lint rules, in the separate package
`eslint-plugin-ramme` in this repository (DESIGN.md §9), whose
`recommended` config turns all eight on, each at its own severity: as
errors, a `catch` that can swallow the body's own `InterruptedError`
(`no-swallowed-interruption`), a platform timer (`no-timers`), a `lookup`
result stored in a field, on `this` or in a module variable
(`no-stored-borrow`), a value provided on the node that owns it
(`no-owned-provider`) and a discarded `attempt` or `settle`
(`no-unused-outcome`); as warnings, a `finally` or a `using` declaration in
an async function (`no-finally-in-async`, `no-using-in-async`) and a
`Promise` combinator (`no-promise-combinators`), which sticky rejection made
supported but which ramme cannot see or structure (D39). The hazards that
depend on run-time values stay development-mode diagnostics (DESIGN.md
§4.4, D30): a managed promise awaited by another body, a late read that
creates a value, a promise returned to `run`; a stall stays `node:stalled`.

**Why.** Each of these hazards is visible where it is written and invisible
when it happens: a swallowed interruption leaves a body running on bare
work after its node was told to stop, a `finally` hides its resource from
ramme, a timer only delays a release, a dropped outcome is silent by
construction (D31), and a stored borrow fails, if at all, after its node
completed, far from the line that stored it. Inside a body the constructs
look like plain JavaScript and behave differently (DESIGN.md §2.6, §4.2), so
a reader does not catch them either. A lint reports each one before the
code runs, at no run-time cost, and checks A7 (cleanup the design relies on
is an entry) and the timer half of A8. The development-mode diagnostics
stay because their hazards depend on what syntax cannot see: which promise
is managed, which body awaits it, whether a read creates a value. Where a
rule must choose, it is stricter than the design: `no-promise-combinators`
flags `Promise.allSettled` and the fulfilling `Promise.all` over managed
members that DESIGN.md §4.2 supports, because syntax cannot tell a
fulfilling `Promise.all` from one that rejects, nor managed members from
bare ones, and an inline disable with a reason marks the cases that are
fine. The three rules on constructs that are now supported warn rather than
fail, since what they flag works; `no-swallowed-interruption` fails, since
what it flags is a bug. One package in the same repository keeps the rules in step
with the design they enforce; it has no runtime dependencies (ESLint is a
peer), and ramme does not depend on it. **Rejected:** type-level tricks: a
`Promise` subtype for managed promises cannot forbid `Promise.race` over it,
since every subtype is still a `Promise`, and a `finally` has no type at
all; a runtime patch of `Promise.race` and its siblings, which changes a
global ramme does not own and costs every program that loads ramme;
`no-bare-task`, the rule DESIGN.md §9 once listed for an async function
passed where a task belongs. `fork` and `call` accept inline bodies by
design (DESIGN.md §4.5), and `all`, `race` and `settle` take only a `Task`,
so the type already catches a bare function there. What remains, a named
async function passed to `fork` or `call` (`fork(parse)`, the case D8′ gave
that rule), is an open gap with no lint (D8′). **Cost.** The rules are
syntactic approximations, named per rule in the package's README. ramme's
functions are matched by name, not by import. Every async function counts
as a body, so a `finally` or a `catch` in a release callback or an `observe`
body, which are never interrupted, is flagged, and so is a top-level
`Promise.all` or timer. `no-swallowed-interruption` is a heuristic: a
conditional rethrow of something else passes and swallows the rest, and a
foreign library's `catch` is not linted at all (D39).
Aliasing gives false negatives (`const t = setTimeout`,
`const { all } = Promise`, a borrow stored through a local). `setTimeout`,
`setInterval` and `setImmediate` in application code are errors, and `fork`
with a loop on `sleep` replaces `setInterval` (D34). A lint binds only a
project that runs it. DESIGN.md §9.
