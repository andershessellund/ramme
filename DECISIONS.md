# Decisions

Why ramme is built the way it is, and not some other way. One entry per
decision, in its final form: what was chosen, the alternatives that were
rejected, and the cost accepted. When a decision changes, its entry is
rewritten and the old choice becomes a rejected alternative; git history
keeps the sequence. The `D` numbers are stable identifiers, not an order.

How the mechanisms work is [DESIGN.md](DESIGN.md)'s job; an entry here
states the decision and points there. ramme is the extraction of the
DI/fiber/lifecycle core of a private monorepo package (internally
"spindle"); entries note where a choice was made at extraction time versus
inherited from that lineage.

## Shape

### D1. One package, internally layered: lifetime tree → DI → fibers

ramme ships contexts, dependency injection and fibers together, with the
layering kept as module structure (`resource`/`scope` under the context
cluster under `fiber*`), not as package boundaries.

**Why.** The layers couple one-way but tightly. Fibers use all three faces
of a context (a fiber *is* a child context, registered as a resource,
found ambiently); DI's creation machinery hands its collected resources to
the tree node that resolution's placement chooses — a "DI without
lifecycle" base would need creation hooks and post-placement callbacks
consumed by exactly one client. Consumer evidence from the source monorepo
agreed: there are DI-mostly consumers (Cloudflare workers) and
fibers-lightly consumers, but no consumer of DI-sans-lifecycle, and a
standalone structured-concurrency library without contexts would be
rebuilding Effect/effection while giving up the one distinctive idea
(fiber = context = scope = lifetime). **Rejected:** three published
packages (scope-tree, DI, fibers): version-skew and a plugin API with one
plugin, purchasable later at low cost because the dependencies are one-way.
**Rejected:** fibers as a separate package over a public tree API: near-100%
co-use with DI, and the observability back-edge (`context-impl` wrapping
lifecycle phases in fibers) would force a hook design nobody else needs.
**Cost.** DI-only consumers carry fiber code they may not call
(tree-shaking mitigates); the internal layering is discipline, not
enforcement. DESIGN.md §1, §7.

### D6. Streams are out; the async-DI glue waits for kilde

The streams/signals/channels layer that lived beside this code moved to
kilde (dependency-free, with its `Owner` seam). The async-DI glue —
`Requirement`, `Boundary`, `resolveAsync`, DI-flavored reactive
derivations — is deliberately not in this extraction; it lands later as a
kilde-integration entry (`ramme/kilde`). `StreamTopic` was dropped from
the lifecycle topics.

**Why.** The glue depends on both kilde and ramme; porting it before
kilde's own extraction settles would freeze kilde API guesses into ramme's
first release. An entry point (rather than a third package) matches D1's
reasoning: one deliberate integration surface, extractable later if a
bare-DI audience materializes. `StreamTopic` described another library's
events; stream instrumentation is kilde's to define, bridged in the
integration step. **Cost.** ramme v0 alone cannot express
"context derived from async requirements"; consumers of that pattern wait
for the integration entry. DESIGN.md §9.

### D2. The name: ramme

**Why.** Danish for *frame*, in the family of kilde, valsem, spor. A
context is literally a ramme: "inden for rammerne af" — within the frame
of — is what scoped resolution means, and the frame metaphor covers all
three faces (a frame you resolve in, run in, and that is torn down as
one). The internal codename "spindle" was English in a Danish-named
ecosystem, and its best Danish rendering (*spindel*) is taken on npm.
**Accepted:** one-letter adjacency to the sibling package `samme`; they
are different domains (codec vs DI) and rarely meet in an import block.
**Noted for the future:** *karm* (the fixed frame a window's ramme mounts
into) was reserved conceptually for the neutral facade during naming; the
facade shipped as `lookup-api` instead (its D9). Extraction-time decision.

### D3. Lifecycle symbols are `Symbol.for('ramme.<phase>.v1')`

`Drain`, `Flush`, `Dispose`, `Abort` are cross-realm registered symbols,
renamed from the lineage's `spindle.*` and versioned on the valsem
convention.

**Why.** Any object should implement `ManagedResource` without importing
ramme, and duplicate installs must agree on the protocol — that is what
`Symbol.for` buys. The `.v1` suffix lets an incompatible protocol change
ship as `.v2` while old copies keep seeing plain objects, and it is free
now and impossible to retrofit later (registered keys are forever). The
rename breaks wire-compat with the unpublished lineage, which has no
external users; done at extraction, before first publish, for the same
reason valsem renamed its protocol symbols then. **Cost.** The monorepo
migrates its symbol keys when it adopts ramme. DESIGN.md §2.2.

## Semantics

### D4. `inject` asserts and tracks; `lookup` reads; the planned convergence is scope-tracked reads

`inject` is creation-time only (throws elsewhere), declares a tracked
dependency, and participates in placement. `lookup` is legal anywhere a
context is ambient and tracks nothing — including during creation, where
it exists for creation-relative and placement-invariant reads.

**Why.** The verbs encode assumption sets, not timing: `inject` asserts "I
am inside a creation and this is a dependency of the product"; `lookup`
asserts nothing, which is what library code that must run standalone can
honestly say. The hazard of the current split is documented rather than
hidden: an untracked read of a *scope-varying* value inside a factory
whose product is cached can bake one scope's answer into a shared value
(placement never learns about the read). The legitimate `lookup`-in-
creation cases are exactly (a) creation-relative services (the resource
bag, the context ref — served relative to the creation, correct under any
placement) and (b) placement-invariant values (root-level diagnostics),
for which tracking would also be a no-op. **Planned convergence,** decided
with lookup-api's D2: track *every* read during creation — for invariant
reads tracking is free, for scope-varying ones it is the correctness fix —
and give the over-pinning escape to the wiring (an explicit scope on the
key), never to the caller (no `untracked` verb; placement is not the
library author's decision). `inject` then remains as assertive sugar. Not
done in this extraction because it changes placement behavior and deserves
its own measured change with the monorepo's suites ported. **Cost.** Until
then the hazard stands, documented; a dev-mode diagnostic (warn when a
product hoists above a context that answered an untracked creation-time
read) is the interim option if it bites. DESIGN.md §3.2–3.3.

### D8. A fiber is a child context (inherited, kept deliberately)

`Fiber.call/spawn/fork` each create a child context; the fiber registers
as a `ManagedResource` on the parent; abort flows through the context;
ambient nesting is discovered through an injection key.

**Why.** This is the load-bearing unification: parent drain waiting for
fibers, fiber abort reaching resources, and `lookup` working inside fiber
bodies all fall out of "fiber = context" without integration code. The
alternative — fibers over a bare scope tree with DI bolted beside —
is the Effect shape, a crowded space whose occupants lack exactly this
property. Kept at extraction after re-examination. **Cost.** A context per
fiber (fibers are not free); acceptable at the granularity fibers are used
here (units of concurrent work, not per-element stream operations).
DESIGN.md §4.

### D9. Ambient storage is pluggable, and the default loses context at `await`

The built-in context storage is a synchronous stack; `ramme/node`
(AsyncLocalStorage) and `ramme/async-context` (TC39) are opt-in
side-effect imports.

**Why.** Inherited, kept: the core stays platform-neutral, hosts pay only
for the propagation they have, and the sync default is *honestly* limited
rather than half-working — the same stance lookup-api takes for its frames
(its D5/D6). Side-effect imports are the idiom for "register a platform
binding once"; `sideEffects` in package.json names exactly those two
files. **Cost.** Forgetting the import yields context loss at the first
`await`, a classic first-hour stumble; the error messages at the
`lookup`-outside-context site name the fix. DESIGN.md §6.

## Integration

### D5. The lookup-api bridge: one conditional resolver, installed by `createRootContext`

`contractKey` memoizes an `InjectionKey` per contract object;
`contractProvider` binds values; `installContractResolver` installs one
root resolver — answering only when a ramme creation or execution context
is ambient and the key resolves there, delegating everything else — and is
idempotent, called from `createRootContext()`.

**Why.** The bridge follows lookup-api's attribution rule (its D4): keyed
on ramme's own dynamic ambient state, it is inert outside ramme's
territory, so other frameworks, other ramme copies, and the no-ramme case
all compose. Installing from `createRootContext` puts the wiring at the
composition point every ramme application already has — no import-order
ceremony, and a library that creates no root context installs nothing.
Creation-time resolution goes through the creation context so factories
transparently serve the libraries they call. **Deferred:** unifying
contract fallbacks with ramme default factories (`contractKey` carrying
the contract's fallback as its default factory, giving per-scope placement
of default-built values instead of lookup-api's process-global memo). It
needs lookup-api to expose fallbacks to integrators; worth doing when a
real consumer shows the process-global memo mattering. **Cost.** ramme
carries a hard dependency on lookup-api (zero-dep, ~2 kB — accepted as
the cost of being servable); contracts default-built under ramme are
process-global for now. DESIGN.md §8.

## Placement (inherited, restated for the record)

### D7. Auto-hoisted values store at the deepest tracked dependency

A default-factory value with no declared scope is cached on the deepest
context that served one of its `inject`ed dependencies, clamped by the
nearest `captureAutoScoped` boundary; sibling contexts above that depth
share it.

**Why.** Inherited from the lineage and kept: it is the rule that makes
"placement follows dependencies" (DESIGN.md law 2) mechanical — sharing as
wide as dependencies allow, never wider, without per-key scope
annotations. `captureAutoScoped` exists for harnesses (a test context that
must not leak instances upward). The rule is also why D4's hazard is
specifically about *untracked* reads: tracked ones are safe by
construction. **Cost.** Placement depends on what a factory actually
injected on its first run; a factory whose dependency set varies by input
gets first-run placement — declared scopes are the way out. DESIGN.md §3.3.
