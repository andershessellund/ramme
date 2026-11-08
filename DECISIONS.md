# Decisions

Why ramme is built the way it is, and not some other way. One entry per
decision, in its final form: what was chosen, the alternatives that were
rejected, and the cost accepted. When a decision changes, its entry is
rewritten and the old choice becomes a rejected alternative; git history
keeps the sequence. An entry a later decision superseded is kept as a short
stub that names its successor and keeps its original reason, for the
record, and says which half of it stands when one does (D9′'s, D13's). The
`D` numbers are stable identifiers, not an order; a prime (`D1′`) marks an
entry rewritten in place by one of the two redesigns: the lifecycle and
concurrency redesign, which replaced the context/fiber model of the first
extraction with one tree of nodes and tasks, and the generator runtime
(D41), which made every body a generator the runtime steps and an
interruption its halt. D13′ is the one prime that is not a rewrite in
place: it continues D13's surviving half, beside D13's stub.

Stating the rules is [DESIGN.md](DESIGN.md)'s job; an entry here
states the decision and points there. ramme is the extraction of the
DI/fiber/lifecycle core of a private monorepo package (internally
"spindle"); entries note where a choice was inherited from that lineage.
The guarantees G1–G4, contracts C1–C8, invariants I1–I27, assumptions
A1–A7 and the numbered design laws cited here are defined in DESIGN.md
§2.5, §2.6 and §10.

Choices settled while implementing a redesign are recorded in the entry
they refine, in its text or under "Settled while implementing it". Each
redesign was specified in documents removed once it was implemented, which
remain in git history: the lifecycle and concurrency redesign's proposal
and implementation plan (added in commit 72a0448, last revised in
19759ae), and the generator runtime's proposal, which D41 cites by its
decision numbers ("D41, decision 12") and which lived at the repository
root through the commits of PR #5 (added in 5da90d8, unrevised, and
deleted when D41 was completed; read it at 5da90d8). Later stages of that
PR were specified outside the repository: stage 6a made tasks callable
(D44; commit a75ce3d) and stage 6b, the commit after it, rewrote the
documents for it. So were PR #6's review fixes: D45, and the notes they
added to D15, D24, D41, D42 and D43. Every decision here is complete without
them.

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

*Amended by D41 (decisions 31 and 32).* `[Symbol.asyncDispose]` is the
contract for foreign resources and for roots. `own(x)` takes anything with
`[Symbol.asyncDispose]` or `[Symbol.dispose]`, so a library that adopted the
standard is attached with no adapter, its release fiber waiting on the
returned promise as a bare wait. A body is a generator, where `await using`
is not legal (TS2852) and sync `using` runs on `return()` but is invisible to
ramme, so in a body `own` is the idiom, and a ramme value is released
through the tree (`yield* release(x)` early), needing the symbol only if
plain async code holds it. Nodes implement both symbols for where
`await using` is legal: the top level, a test, a framework's lifecycle hook.
A node's `[Symbol.asyncDispose]()` aborts, then waits: `await using` ends a
node the way an exception would, by interruption, as a body's exit
interrupts its subscribers (D18), so a test or a `main` that leaves work
running (a forgotten fork, a server loop) ends rather than hangs; to drain,
call `close()`. **Rejected** for decision 32: `[Symbol.asyncDispose]()` as
`close()`, as a Trio nursery or a Kotlin `coroutineScope` waits for its
children, which makes a test that forgets a fork hang until its runner's
timeout and a server's `await using` need an `abort()` from its shutdown
signal first. **Cost:** a scope ended by `await using` interrupts what it
ran, so work that must finish is drained explicitly with `await app.close()`.

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
interruption, its halted `finally` included, and every shield it started has
completed (D41). `releaseTimeoutMs` (none by default) only sets the signal
of the node's release fibers, shields and unwind fiber (D3′, D41), which
delivers them as the `observe` nodes they are, halting only their `restore`
work, and `timeoutMs` only delivers to the node; nothing abandons a child, a
release, a shield or a halted `finally`. `[Symbol.dispose]()` on a
root throws `TypeError`, because a root has no owner to wait for its
completion.

**Why.** Abandoning a child at a deadline would let its parent, and then the
parent's ancestors, release the values the child still uses: G1–G3 hold
only because completion waits. The same holds for a body still unwinding
after its interruption and for a shield it started, waited for or not
(D41): a halted `finally`, a `promised` callback's or a driver's rollback may
use anything the node holds. An abandoned release leaves its resource
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
hangs shutdown indefinitely, and so does a body whose halted `finally` waits
for a driver that never answers, which its deadline only signals (D41); the
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
aborted when its input changes, and is halted at its wait; failures have
destinations), and the state of an asynchronous value lives
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

*Amended by D44: a task is callable, and its call is the lazy op of one
run; the free `call` and the task's own `call`, `bind`, `fork` and `attempt`
are gone.*

A **task** (`task(body, opts)`) is a body plus options; a `Task` is
callable, and calling it makes a lazy op (D44), each run being a new fiber,
a child of the current node. A **fiber** is a node with a body; it is not
thenable (`join`/`result` read it). The operations are free functions over
the **current node** (`fork`, `own`, `lookup`, `join`, …); the same
operations exist as `Context` methods for the one case that needs a name:
acting on behalf of a node that is not current.

**Why.** "A fiber is a child context" (the previous D8) was the load-bearing
unification and is kept, strengthened: every fiber is a node, so its
temporaries are released when it ends, it is interruptible and visible, and
it is found ambiently. The redesign closes the two gaps the old API left. An
async function used as a fiber could also be called bare, running as an
untracked promise, so the redesign made a `Task` that cannot be invoked and
the decision "this is a node" was made once, at the definition; that reason
lapsed when a call became a lazy op that runs nothing until it is yielded
(D41, decision 2), and the decision stands, made at `task(…)` (D44). And
`Fiber.spawn(fn, { context })` threaded the parent through every call site;
the ambient node makes the parent the current node by default (I21), which
is never wrong, only sometimes not what was meant, and the method form
exists for that case.
Inline bodies (`fork(function* () { … })`) are accepted as anonymous tasks,
because an inline function has no name by which it could also be called
bare; a generator function declared by name could be used both ways, so
`no-generator-helper` reports every such declaration, one only a task takes
included (D44, decision 5). A fiber is not thenable
because a wait is where ramme decides the halt and consumes failures (D41,
D13′): `join(f)` and `result(f)` are ops the waiting body yields, run for
that body. A thenable fiber would be awaited wherever anyone held it,
including by `Promise.resolve` inside foreign code, by an async function's
`return`, or by no body at all, so the one consumption of its failure (I11)
would happen wherever that `then` call happened. **Rejected:** the `Fiber` namespace
(`Fiber.call/spawn/fork/join/all`); `fiber.promise`, a bare promise for
work, which either rejects unhandled when nobody awaits it or consumes the
failure when the fiber settles, reaching no one if its awaiter was
interrupted (the failure mode D13′ rejects); `withAbortSignal`/`linkAbortSignal`, separate
functions for running with a signal and linking a foreign one, which a
current node makes redundant: `signal()` reads the node's signal anywhere,
and the `signal` option links a foreign signal at the definition or per use;
requiring `task()` for inline bodies too, ceremony that closes no gap.
**Cost.** A node per fiber (fibers are not free); application code must
decide function vs task at the definition. `fork` and `attempt` also accept
a plain function, so `fork(parse)` and `yield* parse()` of one named
generator function both compile: the type does not flag it, and
`no-generator-helper` reports the declaration (D35; D44, decision 5).
DESIGN.md §4.5–§4.8.

### D22. `fork` starts in a microtask; a task's call starts synchronously

`fork` never runs any part of the body in the forker's frame: the body
starts in a microtask, or after placement when it was forked during
creation (I20). A task's call starts the body synchronously, with the child
current.

**Why.** A synchronous start would run the body's first segment inside the
forker's frame. During a creation that is a creation frame, so the body
would begin where `inject` is legal and `lookup` is not (D4′, I16), on a
node not yet placed. Outside creation the forker has not yet returned, so
an `own(fork(t))` (D19), or any other attachment the forker makes right
after `fork`, would race the body's start. Starting in a microtask gives
the body exactly its own node as current from its first line. A call has
none of these hazards: it is an op, which the driver runs at the caller's
`yield*` and starts the body before the caller's step returns, the caller
suspended on it (D41), and a call is refused during creation, so a
synchronous start costs nothing and keeps a call as close to a plain
function call as a node allows. **Rejected:** a synchronous `fork`; a
microtask start for a call too, which delays every call by a tick and
protects nothing. **Cost.** A fork's body starts a microtask later than a
plain call would, and code that forks and then inspects the fiber
synchronously sees it unstarted. Through `then` (`await app.call(main)` in
top-level code) a call starts when `then` is first called, a job after the
`await`. DESIGN.md §4.6.

### D44. Tasks are callable; every function that waits is a task; receivers; `createKeyFor`; the canonical style

A task is a function whose call is the lazy op of one run, it may bind a
receiver, the combinators take its ops, every function that waits is one,
an interface is keyed over its class with `createKeyFor`, and the README
shows one style (DESIGN.md §3.1, §3.2, §4.4, §4.5, §4.8, §9). Stage 6a of PR #5
made the change in the code (commit a75ce3d), and stage 6b, the commit after
it, in the documents; the code cites the decisions below as "D44, decision
n". This amends D8′, D35, D37, D4′ and D41's decisions 2, 4, 6 and 29.

**1. A task is callable.** `t(…args)` is the lazy op `call(t, …args)` was,
run by `yield*` as a call-shaped child, and "this is a node" is decided
once, at `task(…)` (DESIGN.md §4.5). **Why.** D8′ kept a task uncallable
because a fiber's async function could also be called bare, running as an
untracked promise. Under D41 a call makes a lazy op (D41, decision 2), which
runs nothing until a body yields it, or plain async code awaits it through
the node it was made through, so a bare `t(x);` is missing work, which a
lint reports, never untracked work: the reason lapsed, and the decision it
protected still holds, since `task(…)` says once whether a function is a
node. A call then reads as the function call it stands for,
`yield* getUser(id)` where the uncallable task needed
`yield* call(getUser, id)`, and its op is a value the combinators take
(decision 4). Making the op reads the slot (D41, decision 17): outside any
node it throws `NoCurrentNodeError` and in a factory
`CreationViolationError`, both naming the task. **Rejected:** keeping
`call(t, …args)` beside `t(…)`, two spellings of one act; an eager call,
whose child runs at once, D11's case.
**Cost.** A task type-checks wherever a plain callback is expected, so
`arr.forEach(t)` and `emitter.on(type, t)` compile and each call makes an op
that nothing runs, dropped silently. `listen` refuses a handler that returns
an op, with a `TypeError` at the event (DESIGN.md §4.9), and the type-aware
`no-unused-op` does not see the case, which writes no call (decision 9).

**2. `task(self, body)` binds a receiver.** The body runs as
`body.call(self, …args)`, `with` keeps the receiver, a free body's `this` is
typed `void`, and the second argument being a function makes the first the
receiver (DESIGN.md §4.5). **Why.** A service's operations are fields,
`readonly get = task(this, function* get(path) { … })`, which read the
instance's `#private` state, are listed by the IDE, are typed `Task` (so the
type-aware lint sees a dropped call, decision 9), and pass as values with
the receiver attached (`all([api.get(a), api.get(b)])`). D41's decision 6
refused an overload for `this` because `call(this, function* () { … })`
cannot be told from `call(body, fnArg)` when `this` is a function; `task`
has no such ambiguity, since a body is never the receiver of itself and
`task(body, opts)` has no function second, so it reverses that decision for
`task` (D41 records it). **Rejected:** a second name, `method(this, …)`: one
concept, one name. `self` as an option, `task(body, { self: this })`: `this`
typed from an option bag reads worse and infers less reliably than from a
positional parameter. A `@task` method decorator: TypeScript's decorators
cannot change a member's declared type, so the member would be typed as the
generator function, invisible to `then` and to the `Op`-typed lint. Generator
methods, decision 6's former answer: a method's call is no node, a helper
(decision 5). **Cost.** An operation is a field, made per instance, not a
prototype method: a subclass replaces it, it has no `super.get`, and one
called from an earlier field's initializer is still `undefined`. And no
task is generic, in this form or the free one: `Task` has members besides
its call (`name`, `with`), so TypeScript carries no type parameter of a
generic body through `task(…)`, and
`function* transaction<T>(work: Task<[tx], T>)` gives `T` as `unknown`. An
operation that would return its work's value returns nothing, and the work
hands the value out itself, as README's `Db.transaction` does; a field
annotated with the generic signature compiles only through a cast, and its
type has no `with`.

**3. A task's `call`, `bind`, `fork` and `attempt`, and the free `call`, are
removed.** `t(…)`, `fork(t(…))` and `attempt(t(…))` are the spellings, and
`ctx.call(t, …)` and `ctx.fork(t, …)` stay as plain async code's explicit
receiver (DESIGN.md §4.5, §6). **Why.** A callable task is a function, and
own properties named `call` and `bind` would shadow `Function.prototype`'s,
which every library that calls a function as `fn.call(self, …)` relies on.
`t.fork(x)` and `t.attempt(x)` were second spellings of `fork(t(x))` and
`attempt(t(x))`, and the free `call(t, …)` is `t(…)`. `ctx.call` and
`ctx.fork` take a task or a body, never an op: an op is made through the
current node, so code that has an op has a current node and the free `fork`
and `yield*` serve it, and outside every node no op can be made at all
(decision 1). **Rejected:** keeping `t.fork` and `t.attempt` as sugar; a
renamed own `call` (`t.run(x)`), a second spelling. **Cost.**
`fork(t, …args)` and `attempt(t, …args)` stay as overloads, so code may
still write two spellings where scripts/codemod-callable-tasks.mjs moved
the tree to one; the README shows only `fork(t(…))`.

**4. The combinators take ops.** `fork`, `attempt`, `all`, `race`, `settle`
and `pool.fork` take an op, or a task of no arguments as itself; a task's
call is unwrapped into the task's own fiber, any other op runs in a fiber
named after its verb, and the fiber that runs an op is its host (DESIGN.md
§4.8). **Why.** With a callable task the op is the value a body holds, so
the combinators take what `yield*` takes, and unwrapping keeps the tree as
it was: `all([a(1), b('x')])` makes exactly the fibers
`all([a.bind(1), b.bind('x')])` made, one per task, named after it, with its
options, and no node for the op. An op that is no task's call (`sleep(ms)`,
`wait(p)`, a group) needs a node to run on; being its host, that fiber hands
a `wait((signal) => p)` member its own signal, which the race fires when the
member loses. `race([t(x), sleep(ms)])` then follows D28: the first success
wins and the losers are aborted and waited for, so it is a deadline on
success only, since a failing `t` beats nothing: the race waits out the
sleep and drops `t`'s failure as a loser's, a defect included.
`t.with({ timeoutMs })(x)` is the deadline that lets the failure through,
and DESIGN.md §4.8 says so beside the form. **Rejected:** groups
of tasks only, which need `t.bind` for arguments (decision 3); a node for
every op, a fiber more per member and the task's own options lost under it;
a race that a failure wins, D28's rejected alternative. **Cost.** The race
with a sleep reads as a general deadline and is not one; an op that is no
task's call runs with no options of its own.

**5. No helpers.** Every function that waits is a task, a synchronous
function is a plain function, and there is no third kind; the lint
`no-generator-helper` refuses a generator function not written inline as a
task body, `promised` body, release or failure handler, and the lost-halt detector
stays (DESIGN.md §4.4, §4.5). **Why.** The tree is the call tree. A helper,
a generator function a body runs with `yield*`, shares its caller's node:
its temporaries are the caller's, it is not interrupted, timed or seen on
its own, and a trace has a hole where it ran. A node per operation costs
microseconds (`yield* syncTask()`, about 600 ns, DESIGN.md §7.1) against
waits that are I/O. And the lost-halt hazard of D41's decision 29, a
`yield*` in a helper's `finally` that resumes the body past its halt, exists
only because helpers exist: a task's `finally` is its own body's, which
keeps the halt. The runtime cannot tell a helper's generator from a body's
(a `yield*` hands it the generator's yields), so it still drives one, and
the sentinel and the development-mode report stay, as the detector for code
that breaks the rule where the lint does not look (an imported generator, a
disabled report). `fail(e)` and `ramme/result`'s `$` are operations ramme
exports, a part of the language bodies are written in, not user code.
**Rejected:** Effection's rule, "no `yield*` in a `finally`", as the rule
users learn: it keeps the third kind and its hole in the trace, and forbids
the waiting cleanup a task's own `finally` may do (D41). Removing the
sentinel: it detects the rule's violation. Helpers as an accepted form under
the style preset: the hazard is a bug, not a style, so the rule is in
`recommended` (D35). **Cost.** A function that waits and needs no node of
its own still gets one, a fiber per call; and the lint also flags a
generator that only iterates data (`function* range(n)`) in a file that uses
ramme, which takes an inline disable.

**6. `createKeyFor<I>(impl, opts?)`.** An interface's key over its
implementation: `impl` is checked against `I` at the call (its instance
type assignable to `I`; `#private` members do not matter), the token's value
is made by `impl`'s own default factory with the dependencies it declares,
its name is `opts.name ?? impl.name`, and its scope `opts.scope`, else
`impl`'s, read on every use (DESIGN.md §3.1). **Why.** An interface with
two implementations needs a key that is neither: the interface has no value
to key by, and keying by one class ties every call site to it.
`createKeyFor` makes the separation in three declarations, interface,
implementation and key, the key sharing the interface's name, since types
and values are separate namespaces, so `inject(Mailer)` reads as a class
key does. It is the separation Effect gets from a `Tag` and a `Layer`, a
service's interface kept apart from its construction, without a layer: the
default implementation is the key's own factory, placed by `impl`'s rules,
and a provider replaces it (D36). Checked at the call, the default can never
fail the interface, and a provider for the key is checked against `I`, which
has no private members, so no `Public` is involved (D37). `impl`'s scope is
read on every use, as D32 reads a key's, so a later `setScope(impl, …)`
reaches the key. **Rejected:**
`createInjectionKey<I>(name, { factory: () => inject(Impl) })`, the earlier
seam: a name to keep in step by hand, no
check of `Impl` against `I`, and the instance resolved as a key of its own
and cached twice, under the class and under the token; an alias at the root,
`aliasProvider(Mailer, SmtpMailer)`, which every root must repeat.
**Cost.** `impl`'s type is a class or function callable with no arguments,
so a constructor whose parameters `setDependencies` supplies declares them
optional.

**7. A task is not a key.** `inject(t)` and `lookup(t)` are type errors and
`TypeError`s, and so are a provider for a task (at its registration), an
alias to one and `setScope` on one; `setDependencies`, which takes any
function, refuses one with a `TypeError` (DESIGN.md §3.1). **Why.** A task is
a function, and a function key's default factory is its call (DESIGN.md
§3.1), so `inject(getUser)` would compile and resolve the task's op as a
service: a value that runs nothing, cached and shared. **Rejected:** a task
as the factory of its op. **Cost.** The brand is read wherever a key
enters, and is excluded from the function-key type (decision 8).

**8. The brand is the task's own.** Each callable carries the task brand as
an own property, so `Function.prototype`'s `bind`, `call` and `apply` work on
a task as on any function, and a bound copy is no task but a plain function,
run as an inline body whose op runs (DESIGN.md §4.5). **Why.** A brand on the
prototype would make `t.bind(self)` a broken task, a task's prototype with
none of its fields; an own brand makes it what `bind` makes of any function.
**Cost.** `t.bind(self)` is typed as the task itself (TypeScript keeps a
type whose call signature has no `this` parameter as it is) and is a plain
function at run time: `with` on it throws a `TypeError`.

**9. `no-unused-op` has a type-aware half.** With type information it flags
a call statement in a function whose callee is typed `Task` and whose value
is an `Op` (DESIGN.md §4.4, §9). **Why.** A task is a function, so syntax
cannot tell `api.get(path);` from any other call statement, and types can.
**Rejected:** a syntactic guess at every call statement in a body, which
would flag every plain function's call; a run-time report of an op made and
never run, a cost to every op (D35). **Cost.** It needs a typed lint run
(`parserOptions.project`, or `projectService`), and sees a statement only:
not an op kept in a variable, nor a task handed where a callback is expected
(decision 1).

**10. The canonical style.** The README shows one style and DESIGN.md lists
what else is accepted (README, "The rules"; DESIGN.md §3.1, §3.2). A service
is a class with `readonly #x = inject(X)` fields,
`readonly op = task(this, function* op(…) { … })` fields and
`static readonly scope`, and is its own key; an interface is separated only at two implementations, with
`createKeyFor`; every function that waits is a task; a standalone task is
an entry point (a handler, a job, `main`); `inject` is for structural
dependencies (what a service is made of), `lookup` for contextual ones (what
is true here: the transaction, the connection, the request, the principal),
and `inject` of a contextual key makes an auto-hoisted service contextual,
placed under the provider and re-created with it, a legitimate design named
as such, while one with a declared scope resolves its `inject`s from its
scope's node and does not see a provider below it;
state lives in fields changed by atomic transitions, never read before a
wait and written after it; a shared wait is a fiber the service owns (the
cache idiom); the contextual lookup of a connection lives in the client, not
in every repository. A closure service
(`const Api = () => ({ get: task(function* get(…) { … }) })`, `Api.scope`
set), a function key and `createInjectionKey(name, { factory })` are
accepted and not canonical, and the `style` lint preset, off by default,
reports a function key (`no-function-key`) and an anonymous task
(`named-task`), not a token's `factory` (D35).
**Why.** Several equal spellings of one model are learned as several models;
one style shown makes each example read like the last. Structural and
contextual name what the two verbs are for (D4′), and naming the
consequence of injecting a contextual key keeps a per-transaction service
a choice rather than a surprise of placement (D7); a declared scope keeps a
service where it was declared (D4′), so only an auto-hoisted one follows the
key. A body's code between two
waits runs in one step, so a check and a set with no wait between them are
atomic, and a state read before a wait may be stale after it. A shared wait
owned by the service is joined by every caller: an interrupted caller stops
waiting without stopping it, the service's end stops it, and every caller
gets the same value or the same typed failure. A client that owns the
connection's lookup keeps the repositories structural, so they are shared,
and the transaction's boundary in one place. **Rejected:** removing the
accepted forms: the model would not get smaller, only the surface, since a
function key is a class key without the class and a token with a factory is
what `createKeyFor` builds. Making the closure form canonical: the class
form has fields the IDE lists, `static scope`, and a static name for the
group of operations, and the author's objection to classes was to
`instanceof` and inheritance, and the class form here uses neither. **Cost.** A class per
service, with `this` in each operation; two forms to read in code ramme
accepts; and the style preset sees only what syntax shows (an anonymous
task, a function key), not the rest of the style.

**11. The standing gap: requirements are checked at the first `lookup`.**
Whether every requirement is provided is known when a `lookup` misses, not
at compile time (DESIGN.md §9); deferred. **Why.** Effect's `R` makes a
missing service a compile error (D1′); ramme's DI is ambient and untyped. An
`R` inferred through the yield union, as `E` is (D42), would move the
failure to the start of the run and expose the requirements as data, but
would not prove them without typed providers on the root, and would add a
parameter to every `Task`, `Fiber` and `Op`. **Rejected,** for now: that
`R`, and typed providers. **Cost.** A missing provider fails at the first
`lookup` of its key, which may be deep in a run, and only a run that reaches
it finds it.

## Semantics

### D4′. `inject` is a dependency, `lookup` is a borrow; `lookup` is banned in creation

`inject(K)` returns a dependency of the value under construction: legal only
during creation, tracked, and it decides placement for auto-hoisted values.
`lookup(K)` returns a borrow for the current node: legal anywhere a node is
current *except* creation, where it throws `CreationViolationError`. The
value's own node (`inject(ContextKey)`, `current()` in creation) is excluded
from tracking. Tracked reads decide placement only for auto-hoisted values;
a value with a declared placement (a provider target or a scope) stays where
it was declared, and its author answers for what it holds. `inject` is for
structural dependencies, what a service is made of, and `lookup` for
contextual ones, what is true where the work runs (the transaction, the
connection, the request, the principal); an auto-hoisted service that
injects a contextual key becomes contextual itself, placed under the
provider and re-created with it, a legitimate design named as such, while a
value with a declared placement resolves its `inject`s from the node it is
stored on and does not see a provider below it (D44, decision 10; README,
"Services that hold state").

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
**Cost.** Code written for bodies, a task or a function that `lookup`s,
cannot run in a factory, which must be handed its dependencies, what a
factory should be doing anyway. DESIGN.md §3.2, §3.5.

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
synchronously (A4), and `inject` is legal only until it returns.
Asynchronous initialisation is not part of creation.

**Why.** Creation runs as a frame in the synchronous slot, which `inject`
reads (D41). A synchronous factory is the only kind
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
`const db = own(yield* wait(connect())); yield* work.with({ providers:
[valueProvider(Db, db)] })()`, or a `child({ providers })`. A service that
must own asynchronous setup starts it with a fork in its constructor or
performs it at first use, in one of its tasks; consumers
cannot wait for a value's construction. DESIGN.md §3.3.

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

*Superseded by D41 (decision 18): ramme has no async context, on any
platform. The current node is a synchronous slot the driver sets around each
step of a generator body, and plain async code reaches ramme through a node
it names, `promised` or `node.run`.* For the record, the reason it was
required: the ambient idiom (`lookup`, `own`, `fork`, `signal()` with nothing
passed) is only sound if the current node survives `await`, and native
`await` resumes a function in a job userland cannot wrap, so the node
crossed it through `AsyncLocalStorage` or `AsyncContext`, chosen by a
side-effect import (`ramme/node`, `ramme/async-context`). Its cost was the
browser without AsyncContext, and a forgotten import failing at the first
ambient operation. The entry's other half stands: there is no default root,
since `createRootContext()` is one line and is where shutdown lives, and a
silent default root would hide the "where does this die?" question the
design asks. DESIGN.md §6.

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
The case is a class that is its own key, the canonical service (D44,
decision 10): a test fake of README's `SessionCache` cannot have its
`#entries`, since no other class can, so typing providers against `T` itself
forbids a fake of every class with a `#private` member, and that breeds
casts, which hide exactly the drift the type should catch. An interface's
key made with `createKeyFor` is checked against the interface, which has no
private members, and needs no `Public` (D44, decision 6). `keyof` leaves out
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

*Superseded by D41 (decision 2): work ops are lazy, so a `call` nobody
yields runs nothing, and there is no forgotten await for lending to catch;
`UnawaitedCallError` is gone, and `ramme/no-unused-op` reports the forgotten
`yield*`.* For the record, the reason it was decided: an eager `call` ran
its child at once, so a body that went on using its node without awaiting
it ran two bodies on one node, silently; recording `lentTo` on the awaiting
node, not the receiver, caught that after any number of awaits while
leaving `app.fork(…)` from a platform callback open during a top-level
`await app.call(main)`. Its cost was one more error a newcomer met, and
`Promise.all([call(a), call(b)])` refused.

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
applied, so the body is halted at its wait, D41, and it is forwarded to
every subscriber; the mode's name is older than the halt), `'observe'`
(delivered but not applied: the body reads `signal()` or yields
`interrupted()` and settles on its own; while it runs, the delivery is
forwarded only to `restore` subscribers), or `'restore'` (applied, and
delivered whenever an ancestor on its subscription path is, through any
`observe` region).

**Why.** Halting at its waits is right for work (D41), but some
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
handlers forked after it halted at their first wait. The design is order-independent
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

*Superseded by D41 (decisions 8 to 10) in its first half; its second half
is D13′.* For the record, the reason it was decided: native `await` resumes
in a job ramme cannot see, so interruption could act on an async body only
at a **managed await**, one on a promise ramme produced and could decide at
`then` time, while every other await was bare and completed normally, and
`managed(p)` brought foreign work in. As first decided the managed await
never settled (the freeze), which removed cleanup as control flow and
leaked at the foreign boundary, where a driver's transaction callback's
`finally` never ran; D39 replaced it with sticky rejection, and D41 with the
halt, since the driver sees every wait. Its other reasons stand, under the
halt: with no current node nothing is interrupted, so `app.abort()` from a
signal handler rejects a top-level `await app.call(main)`, and a body in
plain code between the delivery and its next wait is legitimately running
(I8).

### D13′. A failure is consumed on resume, and sources never reject

Every op's run waits on a **source** that never rejects (a node's
completion, the end of an entry's release, a node's delivery, which
`interrupted()` waits on, a timer), plus a **resume step** that runs only
when the op's consumer is actually resumed: the driver resuming the body at
its `yield*`, or a `then` settling its promise. That step is where the value
is produced, an error thrown to the consumer, and a failure consumed. A
halted body therefore consumes nothing, and the failure surfaces from its
holder (I11); an applied waiter that release work resumes is handed the
failure and leaves the record with its holder; a stored, never-consumed
`join`, `result` or `call` runs and consumes nothing; and no op the core
makes can be an unhandled rejection, consumed or not (I10). `wait(p)` over a
user promise has no resume step of ramme's: it marks `p` handled when it
subscribes, also when its body is halted at it instead, or
`yield* wait(fetch(url, { signal: signal() }))` in a delivered body would
leave the fetch's `AbortError` unhandled. DESIGN.md §4.2.

**Why.** A failure belongs to the code that reads it (I11), and only a
resumed consumer reads anything: a halted body never sees what it waited on,
so consuming the failure there would hand it to no one. Sources that never
reject make the rule mechanical, since nothing ramme holds can reject
unobserved. **Rejected:** consuming a failure when its source settles,
through sources that reject: an owner interrupted on `join(f)` consumed
`f`'s failure without ever being resumed, so it reached no one, and a
stored call was an unhandled rejection while its body waited on something
else. **Cost.** Consumption is final once the resume step runs: a
combinator that has settled on one member and then takes another member's
failure loses it, which is why `Promise.race`, `Promise.any` and a
`Promise.all` that rejects, over ops' `then`s, may drop a member's failure;
multi-member waits belong in ramme's `all`/`race`/`settle`, which join their
members themselves (D31).

### D39. Sticky rejection replaces freeze; `shield` is release work on demand

*Superseded by D41 (decisions 8, 11, 13 and 29): a body is halted by
`return()`, so nothing is sticky and no `catch` sees the interruption. What
D39 kept survives there: its three shapes of wait are the halt table, a
`child()` scope of the body is released only once the body has unwound,
`shield` and `unshield` stay in tier 2, and the release work a halt lets
finish includes the body's own halted `finally`.* For the record, the reason
it was decided: freeze (D13 as first decided) never resumed an interrupted
async body, so a `finally` in a frame ramme did not own (a driver's
transaction callback: Prisma's `$transaction`, Knex's and Drizzle's
`transaction`) never ran its commit, rollback or unlock, a silent leak in
code no lint could see. A sticky rejection, every managed await of the body
rejecting with `InterruptedError` from the delivery on, made the body unwind
through foreign `finally` blocks, while stickiness and outcome by state
(D24) kept a swallowed interruption from completing more ramme work or
turning into a `success` (Kotlin's `CancellationException` with
`NonCancellable`, Trio's `Cancelled` with `shield`). Its costs were the
`catch` that sees the interruption, the rule to rethrow `InterruptedError`,
a `finally` that could wait only for release work, and promises derived
from a managed one that rejected on interruption.

### D40. Why not generators (Effection)

*Superseded by D41, which reverses it; D41's cost list answers each reason
below.* For the record, the reason it was decided: Effection's operations
are generators its runtime drives, so a halt calls the generator's
`return()` and every `finally` runs, with no rejection for a `catch` to
swallow. ramme chose `async`/`await` with async-context propagation instead,
for ergonomics (plain async functions, native stack traces and debuggers,
TypeScript's inference) and for library interop (every `Promise`-returning
API awaited as it is, and `await using`), and paid with rejection-based
unwinding, which stickiness, outcome by state and a lint rule (D39) had to
make safe; generators would have made every library call an adapter and
every `await` a `yield*`.

### D41. Bodies are generators; the runtime is a driver

A body is a generator function the runtime steps, every wait is a `yield*`
of an **op** the driver sees, and an interruption no longer travels as a
rejection: the driver **halts** the body by returning its generator at the
wait it is on (DESIGN.md §4.2). This supersedes D9′ (whose no-default-root
half stands), D11, D13 (whose second half D13′ continues), D39 and D40, and
amends D3′. DESIGN.md §4.2, §4.5, §6, §10.

**The decisions.** The proposal that specified this entry numbered its
decisions, and the documents and the code cite them as "D41, decision n".
Each, with its outcome; *decided* marks the author's decisions on the first
draft, the rest were its recommendations, adopted.

1. *What an op yields*: a private `Instruction`, never the op (DESIGN.md
   §4.2), so `yield op` without the star is a type error (TS2769) and a
   run-time `TypeError`, an `async function*` cannot run an op through
   `then`, and a `fail`'s yield is told apart. Rejected: the op yields
   itself, as Effect's `SingleShotGen` does.
2. *When an op runs*: work ops lazily, and the op a called task returns
   (D44, decision 1), the lifecycle verbs eagerly (DESIGN.md §4.2), for C7
   (`release(x)` runs `x`'s release now), an early release
   from a factory, which cannot wait (D26), and D16's promise that exists
   before any dispose code runs. Rejected: every op eager, which keeps
   lending; lifecycle ops lazy too, after which no synchronous code could
   release or close.
3. *A second consumption*: `yield*` runs a work op afresh, as a description,
   and `then` runs it once per object, as a promise must (DESIGN.md §4.2).
   Rejected: memoizing both (a loop spins after one sleep, a retry never
   retries); single use (a second `await op` throws).
4. *The thenable*: a plain `PromiseLike` on a work op that knows its node,
   and on the op a called task returns (D44, decision 1); the lifecycle ops
   stay promises (DESIGN.md §4.2). Rejected: a `Promise`
   subclass, eager by contract.
5. *Async bodies* (decided): refused (DESIGN.md §4.5); a release or a
   failure handler may still return a promise, a bare wait. Rejected: async
   bodies as Node-only sugar, and one deprecated release that still ran them
   (below).
6. *`this`*: no overload on `call`, `fork`, `task` or `promised`; a body
   that needs `this` is a generator method or `.bind(this)`. Rejected:
   `call(this, function* () { … })`, after Effect's `gen(self, …)`, which
   cannot be told from `call(body, fnArg)` when `this` is a function.
   Reversed for `task` by D44 (decision 2): `task(self, body)` binds a
   receiver, told apart by its second argument being a function, and a
   generator method is a helper, which D44 removes (decision 5).
7. *Resumption*: in the source's reaction (S1), a microtask per wait
   (DESIGN.md §4.2). Rejected: resuming within the step when an op
   completed during its start (S2), which would save that microtask of a
   wait that costs about 200 ns in all (DESIGN.md §7.1); a scheduler of
   ramme's own (Effection's parent priority), where D22's microtask start
   already serves. The pins assert event order, never microtask counts, so
   S2 stays open to a later change.
8. *The halt at each wait*: D39's three shapes, with `return()` in place of
   the rejection and decided by the same predicates, and an op not yet
   started not run (DESIGN.md §4.2's table). Rejected: returning at once
   from every wait, as Effection halts, which runs a `finally` around
   `yield* call(t)` (an unlock, a rollback) while the callee still writes,
   and loses an acquisition in flight. Amended by D45: a body resumed after
   its delivery has had its one grant, and stops at its next wait but a
   lifecycle op of release work, so the table's two last rows are a grant
   row and an after-the-grant row.
9. *A body born delivered*: stepped to its first `yield*` of an op not yet
   started and halted there (DESIGN.md §4.2), since `return()` on an
   unstarted generator runs no code at all. Rejected: settling it
   unstarted, which changes D12. Under D45 its first `wait(p)` or lifecycle
   op of release work is its grant, and any later wait but a lifecycle op
   returns it.
10. *`wait(p)` at a halt* (decided): `p` finishes, `{ abandon: true }` stops
    waiting, `wait((signal) => p)` hands the work the signal (DESIGN.md
    §4.2); the name `managed` goes. Rejected: stopping at once by default,
    as Effection's `until` does, which never owns a connection being
    acquired and abandons a transaction callback in the middle of its
    rollback. Amended by D45: only the wait in flight at the delivery
    finishes; after the grant every `wait` of the body's own flow abandons,
    while its halted `finally` still waits for everything it yields.
11. *What a halted `finally` addresses*: U3 (DESIGN.md §4.2). Rejected: the
    two-node frame (below); U1, the node current with its ops exempt, under
    which a `call` in the `finally` is born delivered and halted.
12. *A finally-yield whose wait includes its own node*: returned there, with
    a development-mode warning (DESIGN.md §4.2). Rejected: throwing a
    `TypeError` into the `finally`, which may catch it.
13. *`shield`, `unshield`* (decided): kept in tier 2, for a non-cancellable
    region on the normal path (DESIGN.md §4.2). Rejected: deleting them,
    which leaves `try {} finally { … }` as the only spelling of a
    non-cancellable region.
14. *The async-only lint rules* (decided): `no-swallowed-interruption`,
    `no-finally-in-async`, `no-using-in-async` and `no-promise-combinators`
    deleted, not moved; `no-async-body` and `no-unused-op` added, and
    `no-unused-outcome` extended (D35; DESIGN.md §9). Rejected: a `bridge`
    config holding the deleted rules.
15. *Expected failures* (decided): yielded, typed on the task (D42).
16. *Async code under a node* (decided): there is none (DESIGN.md §6); an op
    that knows its node is thenable. Rejected: the bridge (below).
17. *Where an op checks its guards* (decided): at construction, which reads
    the slot (DESIGN.md §4.2). Rejected: pure construction, which made a
    module-level op legal at the cost of a factory's `void call(t)` silently
    doing nothing and a shared op's run belonging to its first awaiter.
18. *Async context* (decided): none, on any platform (DESIGN.md §6);
    `ramme/node`, `ramme/async-context` and the storage registry go, and the
    floor is ES2022 syntax plus four runtime APIs (DESIGN.md §10, A2).
    Rejected: optional storage, and an ES2018 floor with shims (below).
19. *The platform layer's placement*: the subpath `ramme/platform`, with no
    dependencies and no `node:` import (D43).
20. *`fetch`*: an op over the global's, handed the body's signal (D43).
21. *The frame of a `listen` handler*: synchronous, inside the registering
    node, as `node.run` (D43).
22. *`listen`'s removal*: through the native `{ signal }` and an entry the
    node owns (D43).
23. *`once` and `on`*: not in the layer.
24. *`each`*: Effection's shape, `for (const x of yield* each(src)) { …;
    yield* each.next(); }` (D43).
25. *Observers*: a generic `bind(fn)`; not in the layer.
26. *The platform lints' scope*: ramme code only (D43).
27. *Names*: `Operation<T, E>`, `Op<T, E>` and an exported `Instruction`
    over a private brand (DESIGN.md §1.3, §4.2). Rejected: one name,
    `Operation<T> & PromiseLike<T>`, for long hovers.
28. *An op returned by a body, a release or a handler* (decided): driven in
    the returning frame as its own `yield*` (DESIGN.md §4.5). Rejected:
    forbidding a returned op, which needs `Release<T>` narrowed.
29. *A finally-yield in a helper* (decided): not release work, and
    development mode reports a lost halt (DESIGN.md §4.4), kept as the
    detector for D44's rule that there are no helpers (decision 5 there).
    Rejected: wrapping every helper call in an op that tracks the return
    mode, a wrapper at every call.
30. *A library's async callback* (decided): `promised(body)`, a core verb,
    and `ctx.promised(body)` for a module-level entry point (DESIGN.md §4.5).
31. *`[Symbol.asyncDispose]`* (decided): the contract for foreign resources
    and roots (DESIGN.md §2.7); D3′ amended, not reversed.
32. *What a node's `[Symbol.asyncDispose]()` does*: abort, then wait
    (DESIGN.md §2.7), so `await using` ends a node by interruption and
    `close()` drains (D3′).

**Why.** Native `await` resumes a function in a job userland cannot wrap
(D9′), so ramme learned of a body's waits only through the promises it
handed out, and of the body's position only through the async context. Most
of the async runtime compensated for that: bare and managed awaits and the
list of supported shapes, the freeze and then sticky rejection with its
exemptions, `InterruptedError` and its classification by awaiter,
call-shaped deferral, lending and `UnawaitedCallError`, four async-only lint
rules, a handler's private sleep timer, and the storage adapters with their
browser boundary. A generator body turns the halt into `return()`, the
swallowed `catch` into an impossibility (a returned generator has no later
wait to reject), a forgotten wait into missing work a lint reports, and the
adapters into a slot, while it keeps D39's call-shaped halt (a `finally`
around `yield* call(t)` runs after `t` has stopped) and D40's interop,
through one generic wrapper per wait, `wait(p)`, and one for a library's
async callback, `promised(body)`. The slot is the synchronous fallback D9′
rejected, and D9′'s reasons do not apply: the old stack could be left
entered, while the slot is restored in a `finally` and a step never spans a
microtask checkpoint; the old stack lost the node at a body's first `await`,
and a generator body has none; and outside bodies ramme states the limit,
`NoCurrentNodeError` after an `await`, instead of hiding it. With nothing to
propagate, the browser is a target on the same terms as every server
runtime. Generators were weighed on adoption too: no generator library
offering only cancellation and lifetimes has reached broad adoption
(Effection stays niche, and ember-concurrency's users pushed it toward
`async` syntax), and Effect's `yield*` is adopted for what comes with it.
ramme's case rests on DI, the tree and typed expected failures (D42), not on
the generator runtime; against Effection plus a DI layer, ramme keeps what
Effection's contract does not have: DI with placement by dependencies, the
two stacks and their release order, outcomes by state, typed expected
failures, call-shaped halts across child nodes, pools and lifecycle events.

**Rejected.** *Freeze* (D13 as first decided) and *sticky rejection for
bodies* (D39): both acted through promises, the first leaking a foreign
`finally`, the second letting a `catch` see the interruption. *Async bodies
as Node-only sugar*, with sticky rejection: two cancellation models under
one `Task`, `InterruptedError` in tier 1, and a DESIGN.md describing two
runtimes; and *one deprecated release that still ran them*, two body
semantics for a migration that a codemod (scripts/codemod-generator-bodies.mjs)
and a single owner made unnecessary. *The slot enhanced by
`AsyncLocalStorage`* (optional storage, decision 18's former
recommendation): kept for async code under a node, it would have kept
`ramme/node`, an import whose absence fails at the first use, possibly in a
rollback callback, and a per-step `als.run` above the driver's own cost.
*The bridge*: async code under a node, as B1 kept the sticky-rejection model
there (growing the source by 200 to 300 lines) or as B0 reduced it to a
thenable whose only interruption was the child's `FiberAbortedError`. Either
needed async context for a callback to find its node, and the async code
that mattered under a node, a driver's transaction callback, `promised` makes
a body. *The two-node unwind frame* (decision 11's former recommendation):
`current()`, `release`, `releaseAll` and `lookup` on the node and `own`,
`fork`, `call`, `child`, `pool` and `signal()` on the unwind fiber, two nodes
in one frame, so that ambient `fork(t)` and `current().fork(t)` would
differ, for an undelivered `fork` and a live `signal()` in cleanup.
*Effection's "You must not `yield*` inside a `finally`"* ("the halt is
lost"), waiting cleanup going in `ensure()`: ramme permits it one frame
deep, in the body's own generator, where the driver keeps the halt across
the yield. *An ES2018 floor with shims* (`withResolvers`, `AggregateError`,
`AbortSignal.*`, downlevelled fields; 35 to 50 lines): it buys nothing the
audience needs and puts platform shims in the core.

**Cost.** *Generators*: `function*` and `yield*` are noisier than `async`
and `await`, there are no arrow generators, and tutorials and assistants
default to `async`; most mistakes are compile errors (an `await` in a body
is TS1308, a `yield*` of a promise TS2488, `for await` TS1103), and the rest
a lint's. *The two `wait` modes*: a choice at every foreign wait between
`wait(p)`, which a halt lets finish when it is in flight (D45), with its
hazards (DESIGN.md §4.4), and
`{ abandon: true }`, which leaves `p` running; the default is the opposite
of Effection's. *A helper's
`finally` may not wait*: a `yield*` there loses the halt, and in production
the rest of the body runs as release work; the development-mode detector is
the guard, and since D44 (decision 5) there are no helpers, which
`no-generator-helper` reports. *Async code must enter through a node*:
sprinkling ramme into existing async code is lost. An async function that
uses ramme after an `await` throws `NoCurrentNodeError` there, and becomes a
task, a `promised` body, or code holding a node it took before its first
`await`; libraries whose hooks are async (middleware, ORM extensions, test fixtures)
reach ramme only that way, and `await helper()` on a generator helper
resolves to the generator object, which `@typescript-eslint/await-thenable`
catches. *Unbounded work in a halted `finally`* holds every owner up to the
root, and only its deadline stops any of it: its `restore` work, and what
was handed the signal. *A halt cuts a normal-path `finally`* suspended at
the delivery, so cleanup the design relies on stays an entry (A6). *`await
using` is gone from bodies* (TS2852). *A forgotten `yield*` is silent
missing work*, where `UnawaitedCallError` was loud, and `no-unused-op` sees
a statement, not an op kept in a variable. *Two rules for ops*: work ops
lazy, lifecycle ops eager. And *D40's reasons, answered*:
plain async functions are conceded; stack traces are at parity (both keep
the chain within a task and lose it across tasks); TypeScript's inference is
kept (`yield*` infers each step's value, and the failure union, D42);
library interop is conceded, to one generic wrapper per wait and a node per
`promised` call (DESIGN.md §7.1).

**Settled while implementing it.**

- *D39's criteria decide the halt* (DESIGN.md §4.2's table). A `close()` or
  `[Symbol.asyncDispose]()` of the node itself, an ancestor or an unrelated
  node waits for a completion that waits for the body, so the body is
  returned at once instead of deadlocking. A fiber the delivery missed is
  delivered at the call-shaped wait, without which a fiber on the body's own
  stack would be delivered only at the body's exit, which waits for the
  fiber. A `join` or `result` is call-shaped when its fiber is subscribed
  below the body, work the delivery stops; any other fiber is not the body's
  to stop, and an owned `own(fork(t))` hears its interruption only at its
  turn (I4). A body's `child()` scopes are released at their turn, after the
  body has unwound, since its halted `finally` and its shields may still use
  what they own (a pooled connection the rollback runs on).
- *`unshield` is the hole in a shield*: `shield` and `unshield` are
  Effect's `uninterruptibleMask` and its `restore`. The owner is the nearest
  shield's release fiber's parent (DESIGN.md §4.2), which is right inside a
  call made in the shield too, where `current().parent` is the shield's
  release fiber. The hole is attempt-shaped, since the shield's body is
  release work that must go on and branches on the outcome. An owner already
  interrupted skips the hole, sparing its plain work, and a shield inside a
  shield, or inside a call under one, is owned by that node, as Effect's
  `restore` restores its own mask's state. **Rejected:** a `restore`
  callback parameter on `shield`, which code in a call below the shield
  would have to be handed; reading the owner off `current().parent`;
  running a hole whose owner was already interrupted up to its first wait.
- *U3, not the two-node frame* (the proposal's open question 1; DESIGN.md
  §4.2). Re-run against U3, the review probes that could have refuted it do
  not: a throw from the halted `finally` is discarded (p6; a release
  failure since D45); `release(tx)`
  and `releaseAll()` there find the body's entries (p7); a failure the
  `finally` catches from `release`, `call` or `attempt` still folds in once
  (p8); a second `return()` while a helper's `finally` is suspended skips
  the rest of that block, and the body's `finally` still runs and waits
  (p9). U3's costs stand as stated (DESIGN.md §4.2, §4.4).
- *A shield in a halted `finally` stays on the node* (DESIGN.md §4.2): on
  the unwind fiber an `unshield` in it would have run, bounded only by the
  deadline.
- *`Body` is one function type with a union return*:
  `Generator<Instruction | Fail<E>, T, unknown> | Op<T, E> | T`, its last
  member `never` for a thenable and for an async iterator, which is what
  refuses an `async` function and an `async function*` in the types. Its
  members are inferred before the bare `T`, so a generator that only throws
  is `never` and a plain value is itself; a union of function types, or an
  `Operation<T>` member, makes every iterable value (a string, an array, a
  `Map`) infer as an operation, and refuses those plain bodies. A guard on
  the generator member against `return op` was tried and dropped: it refuses
  every generic body. The cost: a body is annotated
  `Generator<Instruction | Fail<E>, T, unknown>`, never `Operation<T>`
  (DESIGN.md §1.3).
- *`wait(op)` is the op's own wait*, and returns the op itself (DESIGN.md
  §4.2): `wait(db.close())` in a halted `finally` reports a failure once.
- *Decision 12 covers a join of what only the unwound node's release ends*
  (DESIGN.md §4.2): such a `join` waits for a release that waits for that
  `finally`, and would deadlock.
- *`promised` follows the body's consumption* (DESIGN.md §4.5), so a failed
  ROLLBACK in a halted callback surfaces from the node, as under
  `yield* call(body)`.
- *The lost-halt detector* (decision 29; DESIGN.md §4.4): a lost halt gives
  the body the halt's sentinel as the helper's `yield*` value, so dev mode's
  sentinel reports any use of it, besides a finish with another value; a
  body that only returns the sentinel unused goes unreported.
- *The halt at a `yield*` of an op not yet started is a job* (DESIGN.md
  §4.2), so a born-delivered child runs its first step (decision 9) before
  its parent's release would cancel it unstarted.
- *Lifecycle ops are `Op<void> & Promise<void>`* in the types: `.catch` on
  `close()` stays valid, and a work op is a plain `PromiseLike`. Each
  consumer of either, `yield*` or `then`, is resumed in the source's
  reaction, so `await op` resumes one job after the source settles, as a
  managed promise's did; the D16 watch is told after the consumer resumed.
- *A failure handler still detaches* (DESIGN.md §4.7): its driver reports
  each op's `waitsFor` to the run before running it.
- *The group bodies of `all`, `race` and `settle` are generators* (DESIGN.md
  §4.8): a member fork that throws now does so before any member started,
  where an async group body had let a synchronously failing member run first.
- *`run(fn)` returns an op as a value* (DESIGN.md §4.11); a generator is
  still refused.
- *Decision 12 covers an `observe` child forked in a halted `finally`*
  (DESIGN.md §4.2): a `fork` there addresses the node, whose delivery has
  passed, and an `observe` child is not born delivered, so only the node's
  release, which waits for that `finally`, delivered it, and a `join` or
  `result` of it there waited forever: `node:stalled` reported the node and
  its unwind fiber, never the child, and nothing bounded the wait. Lazy ops
  did not change it: `fork` is eager.
- *A thenable reads the step that made its op* (DESIGN.md §4.2). A `then`
  cannot see its consumer: the slot is synchronous, and `await` or
  `Promise.all` calls `then` a job later, under no frame. Without it,
  `yield* wait(Promise.all([call(a), call(b)]))` in a body halted while it
  waited lost `a`'s failure, which the eager ops' managed promise had kept.
  The receiver's state was the other candidate and loses D39's two cases:
  an aborted fork whose `Promise.all` waits for its live parent's
  `release(x)` (the receiver is live, so the failure was consumed into the
  fork's discarded throw), and a shield that catches its interrupted body's
  `release(x)` through `Promise.all` (the receiver is halted, so a failure
  the shield handled surfaced again).
- *U3 holds for `then` too* (DESIGN.md §4.2), so cleanups an op made there
  runs through its `then` are release work, not born delivered and halted
  at their first `yield*` (with their `FiberAbortedError` recorded as a
  release failure).
- *A `then` during a creation is refused*, as a `promised` callback is
  (DESIGN.md §3.5, I16).
- *`wait(fn)` keeps the `waitsFor` of the op `fn` returns* (DESIGN.md
  §4.2): it is known only once `fn` ran, so the driver tests it then, before
  it subscribes, and a failure handler's driver reports it then.
- *A stored `join` or `result` checks its receiver when it runs* (DESIGN.md
  §4.2), as a stored `call` did through its attach, where it rethrew a
  failure the completion had surfaced and emitted `join:enter` on a node
  after its `node:complete`.
- *A source whose `then` throws* fails the wait at the `yield*` (DESIGN.md
  §4.2, I10): the driver answers it as the source's rejection, where it
  escaped the step as an uncaught exception and left the node running.

### D42. An expected failure is yielded: `fail`, `E` on tasks, a four-way `Outcome`

An expected failure, one a caller is meant to branch on, is a fourth way for
a body to end, beside `return v`, `throw e` and the halt: `yield* fail(e)`
ends the body at once with the outcome `failure(e)`, its `E` inferred onto
the task, and the outcome is four-way (DESIGN.md §4.12, §4.13). `gen` is
retired, since a body is the scope; `$` stays in `ramme/result` as the
bridge from a `Result` you hold, `fromThrowing` as the fence, and the
data-only `Result` as the interchange type. This is D41's decision 15,
option (b′).

**Why.** Under D38 a failure a caller branches on was a returned `Result`,
typed at its function and untyped at the task boundary, where `gen` and `$`
supplied `?` inside an async generator that never called `return()` (A6),
and a task's failure stayed `unknown`. A generator body is already the scope
`gen` was: what a body yields the driver sees, so a yielded failure can end
the body without unwinding as an exception through every `catch`, and its
type can be read off the yield union as D38 reads a `Result`'s members,
with nothing declared. That is Effect's typed `E` without `R` (DI is ambient)
or the wrapper (a body is a plain generator function), and Rust's `?` with
inferred unions. The split DESIGN.md §4.12 stated in prose, an expected
failure as data and a throw as a defect, becomes a status, so `attempt` on a
body that failed as designed no longer reports what a crash reports.

**An unjoined fork's expected failure is routed as a defect is** (D14,
D23; DESIGN.md §4.7), and with `'link'` it surfaces from the parent's
completion as the parent's **`defect`**: a parent cannot be given a typed
failure it did not declare. Its `E` is what its own body yields, and a
linked child is never `yield*`ed, so a `failure(e)` on the parent would
carry a type its signature does not have. The same holds for every failure
that surfaces from a completion unconsumed, and a release failure likewise
amends an outcome always to a `defect` (D24; DESIGN.md §4.12).

**Rejected.** (a) `gen` as the explicit scope with the task boundary untyped
(D38 as it stood): Effect's syntax without its main type benefit, and a
second scope concept beside the body. (b) A body that may `yield* $(r)`,
typed `Task<A, Result<T, E>>`: a `$` in a helper ends the whole task, so
`gen` is still needed for a helper's own scope, and the value is wrapped.
Also rejected: a declared or separately inferred `E` (`task<E>(…)`, or `E`
read from `Generator<Instruction | Fail<E>, …>`), which takes one inference
candidate and refuses a second failure type, D38's lesson, so the task reads
the whole yield union; a `Fail` that is structurally an `Instruction`, which
an ordinary op's instruction absorbs, so `E` would infer `never` in any body
that also waits; `failure` as a linked child's failure on its parent
(above); keeping `gen` beside `fail`.

**Cost.** `Task`, `Fiber` and `Outcome` gain a parameter, visible in hovers
and in written signatures; deep graphs accumulate unions, which a module
boundary narrows with `mapFailure` over the outcome's error, and tagged error
classes become the convention (TypeScript compares classes by structure, so
an error class needs a distinguishing member to stay a member of a union, as
under D38). `Outcome`'s shape change is breaking, cheapest now: every check of
a thrown error as `failure` reads `defect`; and since `Fiber`'s `E` defaults
to `never`, a failure handler annotated `(error: unknown, fiber:
Fiber<unknown>)`, as a task's `onFailure` or a pool's, no longer compiles and
is written `Fiber<unknown, unknown>`. `Fail` is one more exported type,
which a library's generator helper needs for its declaration emit, as it
needs `Instruction`. An op whose type carries no `E` cannot re-yield one, so
a fiber's `[Symbol.asyncDispose]()` throws its expected failure at the
`yield*`. DESIGN.md §4.2, §4.5, §4.7, §4.8, §4.12, §4.13.

**Settled while implementing it.**

- *The `finally` a fail runs is release work* (DESIGN.md §4.13). Its throw
  is reported, as JavaScript reports a `finally`'s throw over the `return`
  it replaces, and so, since D45, is a halted `finally`'s; a throw of a
  failure a wait handed it that is reported without it (`p`'s own, or one a
  failure record still holds) is not recorded again (D45).
- *`all`, and `race` with no success, re-yield a lone expected failure, and
  report two or more as a defect* (DESIGN.md §4.8), the proposal having
  read "fail fast … as on a defect" as D28's behaviour, which waits for
  every member and reports every failure. Re-yielding the first and
  consuming the others would drop them, which D28's *Why* rejects.
- *The run-time `Fail` is a record under a registered symbol*
  (`Symbol.for('ramme.fail')`), not an instance of a private class:
  `ramme/result` imports nothing at run time (DESIGN.md §7), so `$` makes the
  record itself. The type's brand is declared only, as `Instruction`'s is.
  Two copies of ramme read each other's `Fail`s, which is harmless.
- *`Fail` is exported*, the core gaining two names (`fail`, `Fail`) where one
  was preferred: a probe compiling a library's generator helper with
  `declaration` emitted `import("…/node_modules/ramme/dist/context.js")
  .Fail<NotFound>` for a private `Fail`, a path the package's `exports`
  refuses, so it is public for the reason `Instruction` is (D41, decision
  27).
- *The verbs read `E` off the yield union only*, as `FailedWith<Y>`, a
  conditional type, with `Y` the whole yield union of the body's generator
  or of the op it returns: a `task(…)` written inside the array `all` takes
  would otherwise infer `E = unknown` from the array's contextual type,
  `Task<[], unknown, unknown>`, and inference from a contextual return type
  does not reach into a conditional type. Not `NoInfer`, which an earlier
  draft used: over an object type it stays in the type, so each level of
  propagation wrapped `E` once more (`NoInfer<C | NoInfer<B | NoInfer<A>>>`),
  which is not `Equal` to `A | B | C`, defeats `Exclude` and `Extract`, and
  shows in a library's emitted declarations. `join` and `result` default `E`
  to `never`, so a written `join<number>(f)` is a fiber with no expected
  failure.
- *The distribution of `E` over `Fail`* (`Fails<E>`, in `Operation`'s
  iterator) is a module-local type of context.ts, as `ramme/result`'s helper
  types are: a library's unannotated helper generic over `E` (`function*
  orFail<T, E>(x: T | undefined, e: E)`) emits it inline, where a name from a
  module the package's `exports` do not expose fails the emit (TS2883).
  `check:surface` compiles such a library outside the package.
- *`Fiber`'s `E` defaults to `never`*, as `Task`'s does, so `fork(t())` is
  `Fiber<T, E>` with the task's `E` and `Fiber<T>` is the fiber of a
  `Task<A, T>`; a failure handler is handed `Fiber<unknown, unknown>`.
  `Outcome`'s defaults to `unknown`, the outcome of any node.
- *A release takes any `E`*: `Release<T>` may return `Operation<void,
  unknown>`, since a release's expected failure, its own or a callee's
  re-yielded, is its owner's release failure, a defect there.
- *`$` takes a `Result`, not a promise of one* (DESIGN.md §4.13).
- *A failure handler's generator that fails* (its own `fail`, or a callee's
  re-yielded) is returned, its `finally` blocks run as the rest of the
  handler, and the handler rejects with the error, a handler exception.
  What fails in those blocks, a second `fail` (a callee's re-yielded one
  included, which the handler's `yield*` has consumed) or a throw, is
  reported beside it, as a body's release work is: the handler rejects with
  `SuppressedError(later, e)`, so neither error is lost.
- *`fail` reads no node* (DESIGN.md §4.13): it only makes the record, so a
  module-level `const notFound = fail(e)` is fine, and each `yield*` yields
  afresh, as an op's description does (D41, decision 3). What it returns is
  an instance of a private class, recognized as decision 28 recognizes an op
  (DESIGN.md §4.5): `own(v, () => fail(e))` is the owner's release failure,
  never a dropped value.

### D43. The platform layer: every wait and every callback has a ramme spelling

Every platform primitive that waits or calls back has a ramme spelling, in
the subpath `ramme/platform`: a **wait is an op**, a **callback re-enters its
node**, an **async iteration is `each`**, and a **lint refuses the bare
form**. Four primitives make the layer (D41, decisions 19 to 26), `fetch`,
`listen`, `nextFrame` and `each` (DESIGN.md §4.9). The layer is built on the
public core alone and imports nothing from Node, so the browser is a target
with no entry of its own (D41, decision 18). The lints, each message naming
the replacement: `no-bare-listener` and `no-bare-fetch` (fixed by importing
`ramme/platform`'s `fetch`) in ramme code only (decision 26), a generator
function or a class that uses ramme for the first, a generator function of a
file that imports ramme for the second; `no-bare-async-iteration` in any
file that imports ramme, its top level included, and inside any generator
function; and `no-timers`, extended to `requestAnimationFrame`, in every
file, as before. DESIGN.md §4.9, §9.

**Why.** Waiting is where interruption attaches: a halt stops only a wait the
driver sees, so a bare `fetch` holds the halted body's node for the whole
request, and a bare frame fires into a body that has ended. Calling back is
where context is lost: the platform calls a listener outside every frame,
where `current()`, `lookup`, `own` and `fork` have no node, and nothing
removes the listener when the node that registered it ends. Generator bodies
make the spellings necessary rather than merely better: `yield*` of a bare
promise is TS2488 and `for await` in a generator TS1103, so a body that waits
on the platform must have something to `yield*`. A subpath keeps the core's
surface as it is (87 names) and every import of `ramme` free of DOM and
`fetch` types; building it on the public API alone shows that API suffices,
and keeps the layer from bypassing the core's guards.

**Rejected.** *`fetch` and `listen` in the core*: surface and platform types
in every import, a server's entry reading globals it never uses, and no line
between what the runtime needs and what a platform offers. *A Zone-style
patch* of `globalThis.fetch`, `EventTarget.prototype.addEventListener` and the
promise jobs to carry the node: not zero-dependency, not ramme's to patch, a
cost to every program that loads ramme, blind to what it does not patch, and
the propagation D41's decision 18 refused, by another name. *`wait((signal) =>
fetch(u, { signal }))` as the idiom* (decision 20's alternative): noise at
every call, and a lint would have to check the signal. *Explicit stepping for
`each`* (`const it = each(s); while (true) { const r = yield* it.next(); … }`,
decision 24's alternative): verbose, and a `while`'s `break` tells the
iteration nothing, so the source could be closed only at the node's end,
where a `for…of` calls its iterator's `return()` on `break`, `return`, a
throw and the halt's `return()`. *A generator handler forked per event*
(decision 21's form): refused instead with a `TypeError`, since a handler
that forks says where the fork's failure goes, by the node's destination
rules (a bodiless node's needs `onFailure`, D14).

**Cost.** `fetch` shadows a global: importing it changes what `fetch` means
in the whole file, which the lint's fix checks before it offers itself. Every
pass of an `each` loop ends with `yield* each.next()`, a `continue` included.
The platform's ops are free-function ops, so they need a current node: top-level
code keeps the global `fetch`, or names a node through `wait`. A source stuck
in a read holds a halted node until the read settles when the source queues
its `return()` behind the read (an async generator does; `node:stalled`
reports it). The rest of the proposal's catalogue (`once`, `on`, `idle`,
`bind` for observers) is not in this layer yet.

**Settled while implementing it.**

- *`each` has decision 24's shape*, as above, chosen over the explicit
  stepping the specification suggested, since only a `for…of` tells `each`
  that the body left the loop. Skipping `each.next()` throws a `TypeError` at
  the loop's head in every mode, not in development mode only: there is
  nothing else to do, since a synchronous `next()` cannot wait, and serving
  the item again would spin synchronously. The source is returned there.
  `each.next()` twice in a pass reads on, as Effection's does.
- *`each` closes through an entry* (DESIGN.md §4.9). A read the halt
  interrupts is abandoned (`wait(…, { abandon: true })`): the halt does not
  wait for the next item, which an idle stream may never send.
- *A `listen` handler's throw aborts the node and is its listener entry's
  release failure* (DESIGN.md §4.9), as decision 21's `'link'` route ends
  it, with the abort synchronous and the error kept even when the node was
  delivered already; a `'link'` fork carrying the error would start a
  microtask later and, born delivered, lose it. A handler that ends its own
  registration first fails that release with its throw, as the core's
  `holdEntry` holds a failure handler's entry (I11). `listen` refuses an
  `async` function as it refuses a generator function (the specification
  names the latter): neither is a synchronous handler.
- *Only the handler's own throw is routed*: an event dispatched during a
  creation (a factory that emits on a shared bus, or aborts a signal someone
  listens to) fails the creation, never the registering node (DESIGN.md
  §4.9), which the dispatch has nothing to do with. Dropping the event
  instead would hide the factory's impurity.
- *No handler runs after the node's delivery* (DESIGN.md §4.9), since the
  node's signal fires its own listeners before the dependent signal handed
  as `{ signal }`, and an emitter calls a listener removed during the same
  `emit`. Each `listen` is its own registration because the platform never
  sees the handler, only its wrapper, and a second registration of the same
  handler on another node must not vanish with the first.
- *`listen` passes `AbortSignal.any([node.signal, opts.signal])` even with no
  `opts.signal`*: the platform keeps what `{ signal }` registers on that
  signal after the listener is removed (Node a listener, the DOM an abort
  algorithm), so a dependent signal keeps the node's own clean. `listen`
  returns nothing: `opts.signal` is the early removal.
- *`fetch`'s signal is the one `wait` hands it* (DESIGN.md §4.9), so cleanup
  in a halted `finally` can make a request; the specification's literal
  `signal()` has fired there. Combined with a `Request` input's own signal,
  it keeps the lint's fix of `fetch(new Request(u, { signal:
  AbortSignal.timeout(n) }))` a request that times out. The guards of
  `fetch`, `nextFrame` and `listen` name the primitive, not the core verb
  under it (`wait`, `current`).
- *`nextFrame` in an `observe` body*: built on the public `wait`, the frame is
  cancelled when the body's signal fires, and a body no halt returns has the
  wait rejected with the reason, as a `fetch` is; the core's `sleep` instead
  runs its full duration (D34), which needs an internal canceller this layer
  does not import.
- *The browser check: static on the build, and the smoke test run in
  headless Chromium* (DESIGN.md §7;
  `DOMException` and `console` are the core's: an abort's default reason,
  development-mode reports). `check:surface` makes it on dist/, and
  src/test/browser-static.test.ts on src/ compiled for the test run (vitest's
  global setup, src/test/build.ts), so `pnpm test` needs no build and never
  reads a stale one; the smoke test, src/test/browser-smoke.test.ts, runs a
  body of the core's verbs and README's search box ("The platform") through
  the public entries. `check:surface`
  also type-checks a Node consumer with no DOM library against every
  declaration file, so `ramme/platform`'s signatures name only what
  @types/node has as a global (`listen`'s options are its own interface, not
  the DOM's `AddEventListenerOptions`). Vitest's browser mode, which the
  proposal planned, was left out at first, since it needs Playwright; after
  review it was added as development dependencies only
  (`@vitest/browser-playwright`, `playwright`): `pnpm test:browser` runs the
  smoke test unchanged in headless Chromium, as CI's `browser` job does, and
  the static half, which reads files, moved to browser-static.test.ts.
- *Decision 32 is settled as recommended*: a node's `[Symbol.asyncDispose]()`
  stays abort, then wait. `await using` ends a node the way an exception
  would, by interruption; to drain, call `close()`.
- *Two `listen` defects, fixed after review* (DESIGN.md §4.9). A handler that
  returns a promise is refused in every mode with the op case's `TypeError`,
  its rejection handled first, where only development mode's `node.run`
  check saw it and production left the rejection unhandled. A registration
  that ends its own node (an emitter's `newListener` hook, an
  `addEventListener` that aborts or closes it) or fires `opts.signal` ran the
  node's delivery, and possibly the entry's release, before there was a
  removal to run: the listener stayed registered for good. `Listener.attach`
  now removes it at once, and nothing is left on `opts.signal`.

### D45. A halt has one grant; a halted `finally`'s throw is a release failure

Two rules of the halt (DESIGN.md §4.2), the first replacing D41's decision 8
for a body resumed after its delivery, the second D24's discard.

**One grant per halt.** The wait in flight at the delivery, when it is
release work, a `wait(p)` or a `wait((signal) => p)`, finishes, and the body
is resumed with its value once: the **grant**, so it can `own` what it waited
for or finish its release work. Every op the halted body yields after that
returns it at its `yield*`: a `wait(p)` abandons `p`, which runs on, its
settlement ignored and its rejection handled; a `wait((signal) => p)` does
not call its function; a task's call makes no child, and a `shield` does
not start. A lifecycle op of release work (`release`, `releaseAll`,
`close()` or `[Symbol.asyncDispose]()` of a node below the body) is the
exception and still runs, resuming the body after it (`yield* release(x)`
in the resumed segment, as in the `finally`). A body delivered with no wait
in flight, in its own step or born delivered (decision 9), has its grant at
its first `wait(p)` or lifecycle op; a resume before the delivery is none.
After the grant every `wait` of the body's own flow behaves as
`{ abandon: true }`, so the option matters only for the wait in flight. The
halted `finally` is unchanged: it is release work, and every wait there
finishes. So there are two regimes: the body's own flow has one grant and
stops at its next wait; its halted `finally` waits for everything it
yields. I27 names the first. The driver sees yields, not blocks, so a
`finally` the body's own flow enters after the delivery, by a `return` or a
throw in the resumed segment, is that flow: its first wait that is not a
lifecycle op returns the body, and the rest of that `finally` never runs.

**A halted `finally`'s throw is a release failure.** It is recorded on the
unwind fiber as a failed wait there is, so the outcome, `aborted` by state,
is amended to `defect(e)` by D24's release-phase rule, and `yield* cleanup()`
failing with `e` and `throw e` give the same outcome. A throw of a failure a
wait there handed the `finally` is not recorded again when something else
reports it: `p`'s own, recorded when it was handed, or one a failure record
still holds unconsumed (a child's, a release's), which its holder reports.
The `finally` a fail runs (D42) follows the same rule, where it had reported
such a failure twice, as an `AggregateError` of one error. No record holds
ramme's `FiberAbortedError` for an aborted child, nor a failure an earlier
consumer took (a caught `join`, a `result`), so a throw of either is
recorded, as the same throw in the body's own flow is reported; so is a
callee's `Fail` re-yielded in the `finally` from a consumed record. A value
the `finally` returns stays discarded (decision 29's lost halt). D24 is
amended with a pointer here, D41's decisions 8, 9 and 10 with a note each,
and D42's note on the fail's `finally` rewritten.

**Why.** D41's rule resumed a body after its wait and let the next wait
decide again, and a `wait(p)` over a promise had started before it was
yielded, so it was subscribed and let finish too: a body of eager waits was
never halted. A probe of `read`, `write` and `commit`, interrupted during
`read`, ran all three and ended `aborted`: the interruption stopped nothing,
and the outcome said the commit had not happened. The grant keeps what
decision 10 bought, the acquisition in flight owned
(`own(yield* wait(connect()))`), and bounds what an interruption lets run to
one segment of plain code. Release work stays outside the bound because an
interruption stops all work except releasing what was acquired (DESIGN.md
§4.2). D24 discarded a halted `finally`'s throw because, in the async
runtime, the interruption was thrown into the body, so a `finally`'s throw
could be its echo. A generator is returned, nothing is thrown in (D41), and
the rationale is gone, while the asymmetry it left was real: the same
cleanup failure was a `defect` when a task threw it and `aborted` when the
`finally` did, so moving cleanup into a task changed the outcome.

**Rejected.** *Resume and decide again* (D41's decision 8 as written): never
halts a body of eager waits. *Halting at the wait in flight itself*, as
Effection halts at every wait: breaks `own(yield* wait(connect()))`, which
leaks the connection being acquired (decision 10's reason). *No grant for a
body delivered with no wait in flight*: loses a born-delivered body's
acquisition the same way. *Halting release work after the grant too*: an
early `release(x)` the body wrote would be skipped, and its awaiter would
learn nothing of the release's failure. *A `shield` yielded after the
delivery as release work*: it is lazy work not yet started, as a task's
call is, and D41 never ran one; only a shield in flight finishes. *Telling
a `finally` the body enters itself from the halted one*: the driver sees a
yield, not the block around it. *Keeping the discard*: its premise was the
thrown interruption. *Recording a rethrown failure again*: one failure
reported twice (I11). *Taking every handed failure as reported*: ramme's
`FiberAbortedError` and a consumed record's error would be reported by no
one (I11), and moving cleanup into a task would change the outcome again.

**Cost.** Plain code in the grant still runs, and foreign work it starts
eagerly (the `write` of `yield* wait(write(x))`) is started and abandoned:
the lazy `wait((signal) => p)`, which a halted body calls only in its halted
`finally`, is the form for starting work, and README shows it first. An abandoned promise runs on
unobserved, and its node may complete before it settles. `wait(p)` means two
things by position: the wait in flight, which a halt finishes, and any later
one, which it abandons. A halted `finally` that throws now ends its node
`defect`, which reaches the failure destinations (I12 keeps `aborted` silent,
not a defect), and so does a body whose halt was lost (decision 29), whose
main flow runs on as release work: its throw is a release failure too. The
identity test sees only the value handed in: a `finally` that wraps a handed
failure in a new error reports both. A throw from the grant's plain code,
outside any `finally`, is still discarded by D24, while the same throw in
the `finally` is reported: the grant is the body's flow, classified by state,
and the `finally` is release. A `finally` the resumed segment enters by its
own `return` or throw is cut at its first wait that is not a lifecycle op,
its rollback abandoned and its node possibly complete first, where D41 let a
`wait(p)` there finish: cleanup that must finish belongs in an entry
(DESIGN.md §4.4), as it already did for a `finally` reached by normal
completion.

**Settled while implementing it.**

- *The grant is the first resume after the delivery*, whichever wait gives
  it: a body delivered during `yield* release(x)` is resumed by that release,
  its grant, and stops at its next `wait(p)`.
- *A lifecycle op after the grant is subscribed and its shape decides*
  (DESIGN.md §4.2's table): release work runs, and a `close()` of the body's
  own node returns it at once, the first row's.
- *An abandoned `wait(p)` runs its op only to reach `p`*, whose rejection is
  then handled; nothing is subscribed. `promised` bodies are driven by the
  same driver, so a library's callback stops at its second wait as a task's
  body does.
- *Whether a handed failure is reported without the `finally` is read from
  its failure record*, when the resume step throws it: still unconsumed, its
  holder reports it. A run says so for what it throws (a child's outcome, an
  entry's release, a node's `close()`); a user promise's own failure is
  recorded when handed instead.

### D34. `sleep(ms)`: ramme's timer is a wait the halt cuts

A free function `sleep(ms)` and a method `ctx.sleep(ms)` return a work op
that waits `ms` milliseconds. Like the other body-shaped verbs, the free one
throws when it is made: `NoCurrentNodeError` outside any node,
`CreationViolationError` in a creation, `PendingNodeError` on a pending
node; `ctx.sleep` from top-level code is a plain delay through its `then`.
`ms` is a number in [0, 2^31 − 1], the bound of every ramme timer; anything
else is a `RangeError` naming the value and the bound and suggesting
`never()`, thrown when the op is made. The timer is armed when the op runs,
at its `yield*` (or its `then`), under an empty frame (DESIGN.md §6), and is
not unref'd. A `freeze` or `restore` body waiting on it is halted at its
node's delivery, and the halt clears the timer; a body already delivered at
the `yield*` does not run the op, so arms none. A waiter nothing halts (an
`observe` body, a release fiber or a shield, a failure handler, top-level
code) waits the full `ms`, and a failure handler's `yield*` of a sleep its
parent's body made is its own run of the op, with its own timer (D41,
decision 3). Repetition is a `fork` that loops on `yield* sleep(ms)`.

**Why.** A timer is the most common foreign wait, with a measurable cost at
interruption: a platform timer waited for through `yield* wait(…)` is let
finish by a halt (D41, decision 10), so an aborted request would hold its
connection lease for the rest of the wait. `sleep` is a wait the driver
sees, so the halt cuts it and clears its timer, and no timer outlives the
interruption. ramme's own timers are unref'd because they only diagnose or
bound a wait; a sleep is the wait, and a top-level `await app.sleep(n)` must
not let the process exit before it resolves. **Rejected:** a user-written
timer promise under `wait(…, { abandon: true })` as the idiom, a wrapper at
every call whose timer survives the interruption; patching the global
timers, which is not zero-dependency and not ours to patch; a `sleep` that
rejects or resolves early for `observe` bodies: an `observe` body reacts
through `signal()` and `interrupted()` (DESIGN.md §4.3), and an early
resolution would run the next iteration of a loop as if the time had
passed. **Cost.** `setTimeout`, `setInterval` and `setImmediate` in
application code are lint errors (D35), and `fork` with a loop on `sleep`
replaces `setInterval`. One more name in tier 1. DESIGN.md §4.2, §4.4.

Settled while implementing it:

- *A failure handler's sleep is its own.* Under the async runtime a
  handler's await of a body's sleep waited on the body's timer, which the
  body's delivery cleared, so a handler armed a private timer to the sleep's
  deadline. Every work op now runs afresh for each consumer (D41, decision
  3), so a handler that yields a sleep the body made arms its own timer at
  its own `yield*`, and the private timer went.

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

`all` and `race` run their members as subscribers of a fresh group fiber,
which runs as the caller's call (D44). `all` resolves with every value in order and
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
fiber so that the caller makes one wait and is halted as a whole, once the
group has completed (D41, decision 8). **Rejected:** `Promise.all` and `Promise.race` semantics (first
rejection, first settlement); honouring each member's own destination.
**Cost.** `all` does not stop at the first failure: the other members run
to their end before it rejects, and fail-fast is a body that forks with
`'link'`. The names match the `Promise` combinators while the rules
differ. DESIGN.md §4.8.

### D31. Outcomes as values: `attempt` and `settle`

`attempt(t(…args))` (also `attempt(t, …args)` and `ctx.attempt`, D44) is a
task's call with `result`'s resume step: the same child, started
synchronously at its `yield*`, and an interrupted `freeze` or `restore` caller halted on it once
the child has completed, as on a task's call (D41, decision 8); it resolves with the
child's four-way `Outcome<T, E>` (`success`; `failure`, an expected failure
the child yielded, typed `E` on its task; `defect`, what it threw; and
`aborted`, D42), and consumes a failure of either kind instead of
propagating it. Below, a "failure" a caller branches on is either kind.
`settle(members,
opts)` (also `ctx.settle`) is `all` that resolves with every member's
outcome instead of rejecting: its members run as `'join'` fibers of a group
run as the caller's call, each runs to its end and none is aborted on a sibling's
account, as in `all` (D28), and it resolves with the tuple of outcomes in
order once every member has completed. A member's failure is held by the
group's parent, not by the group, until `settle`'s resume step consumes it.
`settle` rejects only with a failure of the group's own, and then with the
members' failures attached and consumed, in the shape `all` rejects with.
A task's call and `all` stay as they are: they re-yield an expected failure and
throw a defect.

**Why.** A body that branches on how other work ended had one tool:
`try/catch` around `call`, where a `catch` sees a real failure or a
`FiberAbortedError` (DESIGN.md §2.6). "Try with a deadline, fall back" was
`try { yield* call(t.with({ timeoutMs })) } catch (e) { if (e instanceof
FiberAbortedError) … else throw e }`: a catch that must rethrow what it did
not mean to handle, around an `instanceof` test. With the outcome as a
value, `aborted` is a branch. For a `freeze` or `restore` caller it
describes the child (its `timeoutMs`, its `signal`, an explicit abort),
because the caller's own interruption halts the caller (D41) instead of
arriving as an outcome: the interruption is not a value a body can branch
past. A `restore` child (or `settle` member or group) is the exception: it
hears every delivery on its subscription path (D20), including one its
caller does not hear, so an `observe` ancestor's interruption, which that
ancestor does not forward to a `freeze` caller below it, comes back to the
caller, which is not interrupted, as `aborted`, and so does an `observe`
caller's own, since it is never halted. The `observe` body sees its interruption by design
(DESIGN.md §4.3) and checks `signal()` before it falls back; the `freeze`
caller's `signal()` has not fired, so a deadline fallback that can run below
an `observe` region tests the reason instead: the child's `timeoutMs`
delivers a `TimeoutError` `DOMException`, which an ancestor's interruption
carries only when it was itself a deadline. The outcome is the one `result`
already reports, decided by state (D24), so nothing new is classified.
`attempt` keeps what a task's call has and `result(fork(t))` lacks: the body starts
synchronously at the `yield*` (D22), and an interrupted caller is halted only
once the child has stopped. `settle` is the form for
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
start; making the call itself resolve with an outcome, which hides every
failure by default, so the forgotten check is silent where a forgotten
`catch` is loud; resolving with `aborted` for the caller's own
interruption, a value a body could branch past; `settle` as an option on `all`, which
waits the same way and differs only in the result shape (values and a
rejection, or outcomes), two result types under one name; holding the
members' failures on the group, or consuming them in its body (above).
**Cost.** An outcome nobody inspects drops its error silently: `yield*
attempt(t)` with no look at `status` is the failure mode outcomes-as-values
invite, which is why the plain call stays the default and `attempt` is opt-in.
`ramme/no-unused-outcome` flags a discarded `attempt`/`settle` (D35). A
`restore` child inside an `observe` region can hand a caller that was not
interrupted the region's shutdown as
`aborted`, which only its reason tells apart from the child's deadline. Two
more names in tier 1; `attempt` emits `join:enter`/`join:leave`, which
a task's call does not. DESIGN.md §4.5, §4.8, §4.12.

### D38. `Result` is `Outcome` minus `defect` and `aborted`; data only; `$` is the `?` operator

*Amended by D42, which made an expected failure inside a body a yielded
`yield* fail(e)`, typed `E` on the task, and retired `gen`; this entry is
written as amended.*

Where a failure a caller is meant to branch on crosses a boundary a body
does not (a function's or a library's return value, JSON, a message), it is
a value, typed: `Result<T, E> = Success<T> | Failure<E>`, that is
`{ readonly status: 'success'; readonly value: T } | { readonly status:
'failure'; readonly error: E }`, a core type, `Outcome<T, E>` minus `defect`
and `aborted` (D42). Everything thrown is a defect, handled at task
boundaries (`attempt`, `onFailure`) and translated there, never used as
domain control flow; an interruption is neither (D24). The helpers are free
functions over plain objects in the subpath `ramme/result`, which imports
only types from the core, thirteen of them: `success`, `failure`,
`isSuccess`, `isFailure`, `map`, `mapFailure`, `andThen`, `orElse`,
`unwrap`, `unwrapOr`, `fromThrowing`, `collect`, and `$`, the `?` operator:
in a body, `yield* $(r)` evaluates to the success value, or ends the body
with `failure(r.error)`, as `yield* fail(r.error)` does. Each helper takes
the whole `Result` as one type parameter and reads the value and error types
off it, so a member of the other kind contributes `never`.

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
`Error` subclass. A thrown error stays untyped, a defect: a declared `E` on
a thrown failure is a claim, not a proof, since whatever a body calls can
throw anything, and only a returned or yielded value has the type its code
gives it (D42). `$` is how a `Result` a body holds becomes the body's own
expected failure, which unwinds as data, not as an exception, so no `catch`
can swallow it and nothing has to be declared. The helpers take the whole
`Result` because a `Result<T, E>` parameter fails in two ways. TypeScript
takes one inference candidate for `E`, so it refuses the inferred return
type of an unannotated fallible function, `Failure<A> | Failure<B> |
Success<T>`. And it infers `unknown` for a type parameter with no
candidate, so `andThen(r, (v) => success(v + 1))` over `r: Result<number,
UserNotFound>` would be `Result<number, unknown>`, and one
`yield* $(success(1))` would widen a body's whole error union to
`unknown`. Read off the whole `Result`, every error of a union is kept and a
`Success`-only argument has error `never`, with nothing annotated.
**Rejected:** a class with
methods, neverthrow-style, which puts behaviour on the data and needs an
adapter for every other shape; `gen`, an explicit scope for `?` (an async
generator run whose yielded failure ended it as its result), which D42
retired: a body is the scope, and `gen` never called its generator's
`return()`, so the `finally` blocks of a run that failed did not run; a
thenable `$`, `await $(p)` with a declared `E`, which unwinds by exception
through every intermediate `catch` and needs the type declared; `$` lifting
functions (`$(getUser)(id)`), which loses `this`; making `Result` iterable,
so that `yield* r` works without `$`, which puts behaviour on the
data and still needs `$` for foreign results; `$` over a promise of a
`Result`, which would wait where the type `T` does not show it (a `$` takes
the `Result`, waited for first: `yield* $(yield* wait(p))`); an `Option`
type; `match`, `tap` and other combinators, since narrowing on `status` is
the combinator library and code that wants chaining wraps the plain object
in neverthrow in one line. **Cost.** Two concepts, `Result` and `$`, beside
`fail`. `fromThrowing`'s `catch` takes every error, and its promise never
rejects: over an op it runs the op through its `then`, a waiter nothing
halts, so the child's expected failure, its defect and its abort all become
a `failure` of type `unknown`, and a stored `fromThrowing(join(f))`
consumes `f`'s failure into a `Result` nothing may then read. TypeScript
compares types by structure, so error classes need a distinguishing member
to stay separate in an inferred union. A subpath of thirteen functions.
DESIGN.md §4.12, §4.13, §9.

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
  `then` getter throws (I26), and a fiber is a value, which the core does
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
  reads `SuccessOf<R>` and `ErrorOf<R>` (unexported), and so does `$`.
  **Rejected:** keeping the `Result<T, E>` parameters and requiring a
  fallible function to annotate its return type as one `Result<T, E1 |
  E2>`, a rule nothing enforces, broken by every unannotated function with
  an error far from its cause.

### D15. Pool intake stops at the signal

`pool.fork` throws `PoolClosedError` once the pool is delivered or `close()`
was requested, and `NodeCompletedError` after completion.

**Why.** A deliberate exception to I8 (operations work between delivery and
completion) for intake infrastructure: a fiber forked into a delivered
`freeze` pool would be born delivered and be halted at its first wait,
which is work accepted only to be thrown away. `close()` fires no signal, so
a fork into a closing pool would run normally; it is refused for another
reason: a graceful close waits for the pool's work, its queue included, so
open intake would let a producer that keeps forking hold the pool, and its
owner's shutdown, open indefinitely. Either way the caller learns it at
once. **Rejected:** accepting forks into a closing pool until its queue
drains. **Cost.** A producer that races shutdown must handle
`PoolClosedError`. DESIGN.md §4.10.

*`maxPending` bounds the queue.* Under `whenFull: 'wait'` the queue was
unbounded, so a producer faster than the pool grew it without limit; with
`maxPending` set, a fork that would queue beyond it throws `PoolFullError`,
as `'reject'` does at `concurrency`, before any node is made (`0` is
`'reject'`; beside `'reject'` it changes nothing).

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
once (below an `observe` node that has not exited, a running body or a
bodiless node before its exit, only its `restore` descendants; D20).
Not guaranteed: order among subscribers during the signal; anything about a
reference that escaped to a longer-lived scope, except that use fails
loudly.

**Why.** Provided values are registered lazily, at a time the body author
does not control: a handler forked before the pool existed may be the one
whose `lookup` creates it. Only "explicit before provided" makes G1 hold
whatever the order of registration; LIFO within each stack gives dependency
order wherever dependencies were acquired first (A5), by construction for DI
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
  fires their signals, then tells each suspended body's driver (I9). A listener on
  any of them, often foreign code reacting to an `AbortSignal`, therefore
  sees the whole delivery: every node it can reach in the subtree already
  reads as delivered, with the delivery's reason, so it cannot fork into a
  node about to be interrupted as if it were not (the birth rule, D12,
  applies), and an `abort(reason)` it makes on a child cannot replace the
  child's reason with its own. What an `observe` node holds back is not of
  that delivery: a bodiless `observe` node exits in the second pass and
  delivers the rest of its subtree then, so a listener of the first pass
  sees those nodes undelivered. **Rejected:** level-by-level propagation,
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
  the body's behalf, so `own(yield* wait(connections.acquire()))` (a producer's
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
  fiber's (D41).
- *An early release's error is unconsumed until the awaiter of `release(x)`
  or `releaseAll()` receives it.* The error rejects that call only when the
  call's awaiter is actually resumed; if its awaiter was applied (an
  interrupted body, handed the error without consuming it, D13′), or never
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
`NotOwnedError`, `AlreadyOwnedError`, `FiberNotAwaitableError`,
`FiberAbortedError`, `PoolClosedError`, `CreationViolationError`,
`AsyncRunError` and `PlacementError`, ramme
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
threw, including what its halted `finally` returned (D41); what that
`finally` throws is a release failure, which amends the outcome (D45); an
`observe` node's outcome is its body's result; a bodiless node is `success`
on `close()` and `aborted` on `abort()`. A body's throw is a `defect` and
its yielded `fail(e)` a `failure`, fixed at the fail (D42). The release phase amends the
outcome once, always to a `defect`: a body `failure` or `defect` plus
release failures becomes `defect(SuppressedError(releaseError, bodyError))`;
a `success`, bodiless or `aborted` outcome plus release failures becomes
`defect(releaseError)`, since a release failure is a thrown-class thing,
never the task's typed `E`.

**Why.** An error cannot tell whether its body was interrupted. A body
stopped mid-`fetch` may surface the fetch's `AbortError`, a `TimeoutError`,
a library's wrapper of either, or nothing at all; a real failure may be an
`AbortError` from an unrelated signal. The node's state knows whether it
was interrupted before the body finished, so the outcome follows state, and
an `aborted` outcome fires no failure destination (I12): what an
interrupted body leaves behind is not a failure. A halted body whose
`finally` returns a value is still interrupted: classified by what it
returned, a `return` in a `finally` would turn the interruption into a
`success`. The release amendment
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
appears, the seam can be rebuilt as a separate package over ramme's
public API and keys. DESIGN.md §8.

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

**Why.** The checks catch misuse that is otherwise silent (a lost halt, a
promise or a generator returned to `run`, a late read that creates a value)
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

*Amended by D41 (decision 14), D43 and D44: the four rules that served
`async` bodies went, five came, and then `no-generator-helper`, a
type-aware half of `no-unused-op` and the `style` preset.*

The hazards that are syntactic are lint rules, in the separate package
`eslint-plugin-ramme` in this repository (DESIGN.md §9), whose
`recommended` config turns all ten on, as errors: an `async` function
where a body is expected (`no-async-body`), a work op made and never yielded
(`no-unused-op`, which with type information also reads a dropped task's
call, D44), a generator function not written inline as a body
(`no-generator-helper`, D44), a discarded `attempt`, `settle` or `result`
outcome (`no-unused-outcome`), a platform timer (`no-timers`), a `lookup` result
stored in a field, on `this` or in a module variable (`no-stored-borrow`), a
value provided on the node that owns it (`no-owned-provider`), and, in ramme
code, the platform's bare forms `ramme/platform` replaces: a listener, the
global `fetch` and `for await` (`no-bare-listener`, `no-bare-fetch`,
`no-bare-async-iteration`, D43). The hazards that depend on run-time values
stay development-mode diagnostics (DESIGN.md §4.4, D30): a lost halt, a
halted `finally` that waits for itself, a late read that creates a value, a
promise or a generator returned to `run`; a stall stays `node:stalled`.

**Why.** Each of these hazards is visible where it is written and invisible
when it happens: an `async` function is no body, a forgotten `yield*` runs
nothing, a dropped outcome is silent by construction (D31), a timer only
delays a release, a stored borrow fails, if at all, after its node
completed, far from the line that stored it, and a bare platform wait or
callback is one a halt cannot stop or a node cannot see. Inside a body the
constructs look like plain JavaScript and behave differently (DESIGN.md
§2.6, §4.2), so a reader does not catch them either. A lint reports each one
before the code runs, at no run-time cost, and checks the timer half of A7.
The development-mode diagnostics stay because their hazards depend on what
syntax cannot see: a generator `yield*`ed from a body where the lint does
not look (an imported one, a disabled report), whether a read creates a
value. Every rule of `recommended` is an error, since what each flags is a
bug or missing work. Where a rule must choose, it is stricter
than the design, and an inline disable with a reason marks the cases that
are fine. One package in the same repository keeps the rules in step with
the design they enforce; it has no runtime dependencies (ESLint is a peer),
and ramme does not depend on it. **Rejected:** run-time checks for what the
syntax shows, a cost to every program at run time; a runtime patch of the
platform's globals, which changes what ramme does not own and costs every
program that loads ramme (D43); a type-aware rule for an op kept in a
variable, which the plugin's syntactic rules leave to a later variant (D41,
decision 14); `no-bare-task`, the rule DESIGN.md §9 once listed for a
function passed where a task belongs. `fork` and `attempt` accept inline
bodies by design (DESIGN.md §4.5), and `all`, `race` and `settle` take ops,
so the type already catches a bare function there; the named generator
function D8′ gave that rule (`fork(parse)`) is `no-generator-helper`'s
(D44, decision 5). **Cost.** The rules are
syntactic approximations, named per rule in the package's README. ramme's
functions are matched by name, not by import. Aliasing gives false
negatives (`const t = setTimeout`, a borrow stored through a local, an op
kept in a variable). `setTimeout`, `setInterval` and `setImmediate` in
application code are errors, and `fork` with a loop on `sleep` replaces
`setInterval` (D34). A helper the lint does not see (an imported one, a
disabled report) still loses a halt in its `finally`, which only
development mode reports (D41, decision 29). A lint binds only a project
that runs it. DESIGN.md §9.

**The `style` preset** (D44, decision 10). `configs.style` holds the rules
whose violation is an accepted form, `named-task` (a task whose node would
be named `anonymous`) and `no-function-key`, as warnings, and is off unless
a project adds it beside `recommended`. A rule belongs in `recommended`
when what it flags is a bug or missing work, and in `style` when what it
flags works and only leaves the canonical style. **Why.** A style is a
project's choice, which ramme recommends and does not impose: code in an
accepted form is correct, so an error there would be wrong, and a warning
in the default config would teach a project to read past the lint's
warnings. **Rejected:** the style rules in `recommended`, as errors or as
warnings (above); no style rules, which leaves the README's style unchecked
in a project that wants it. **Cost.** A second config to know of; the
preset checks only what syntax shows of the style.
