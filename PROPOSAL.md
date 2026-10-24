# Proposal: generator bodies (D41)

**Status: a proposal, not a decision.** Base: branch
`proposal/generator-runtime` at 4310ad3, the code of PR #4 (sticky
rejection, D39); "today" means that code, and line numbers are its. Each
decision states the proposal, the alternatives with their costs, and a
recommendation. *(verified)* and *(measured)* mark results of scratch
probes on Node 26.3.0 and TypeScript 6.0.3 with the repository's tsconfig;
"review probe pN" names one of the review's probes (feas-probes/pN-*.mjs in
the session scratchpad). A review pass is recorded in the appendix.

A body becomes a generator function that the runtime steps. Every wait is a
`yield*` of an **Op**, which the driver sees, so an interruption no longer
travels as a rejection: the driver **halts** the body by calling its
generator's `return()`. A `finally` runs, and one in the body's own
generator function may wait, as release work; `catch` never sees the
interruption; nothing needs to be sticky. Work Ops are lazy, so a
forgotten `yield*` runs nothing and lending goes; the lifecycle verbs
(`release`, `releaseAll`, `close`, `[Symbol.asyncDispose]`) stay eager. The
current node is a synchronous slot set around each step, so bodies need no
async context. Async code still runs under nodes (top level, foreign
callbacks, releases): it awaits Ops through their `then` and sees PR #4's
rejection model. That is **the bridge** (§4).

## Reader's guide

This document is long because the research verified each claim against the
code; it need not be read in order. The decisions that are yours and change
the shape of the result are, in weight: **1** (open question 1, the bridge:
B1 keeps PR #4's rejection model for async code and the source grows; B0
drops it and the source and DESIGN shrink, which is where the "simpler"
claim is met or not, §3.2, §3.5), **15** (the typed error channel, §3.6, as
`yield* fail(e)`), **5** (whether async bodies survive at all), **10**
(whether a halted `wait(p)` lets the promise finish, today's bare await, or
stops at once as Effection does), and **11/16/29** (what a `finally` may do
during a halt and in which frame; the two-node unwind frame is the most
intricate piece of the proposal and the one most worth simplifying). The
measurements in §7.2 bound costs; the deletion inventory in §3.1 is the
honest account of what generators remove and what they add. §0.6 asks the
sceptic's question, what ramme offers beyond Effection plus a DI layer,
and open question 15 leaves it to the author.

## Decisions at a glance

| # | Decision | Recommended | § |
| --- | --- | --- | --- |
| 1 | What an Op yields | a private `Instruction` record | 1.2 |
| 2 | When an Op runs | work Ops lazily, at `yield*` or `then`; the four lifecycle verbs eagerly, as today | 1.3 |
| 3 | A second consumption | `yield*` runs it again; `then` runs it once | 1.3 |
| 4 | The thenable | a plain `PromiseLike` (the eager lifecycle verbs may stay promises) | 1.3 |
| 5 | Async bodies | refused, after one release that still runs them | 1.4 |
| 6 | `this` | no overload on `call`/`fork`/`task`; `gen` keeps its own | 1.5 |
| 7 | Resumption | in the source's reaction (earlier than an async body resumes) | 2.2 |
| 8 | The halt at each wait | PR #4's three shapes, `return()` for the rejection, through `ManagedPromise.thenFor` | 2.3 |
| 9 | A body born delivered | stepped to its first `yield*` of an op not yet started, halted there | 2.3 |
| 10 | `wait(p)` at a halt | today's bare await: `p` finishes, the body ends at its next `yield*`; yielded after the halt, still subscribed | 2.3 |
| 11 | Where a `finally` runs | an unwind fiber of the node; `current()`, `release`, `releaseAll`, `lookup` address the node | 2.4 |
| 12 | A finally-yield whose wait includes its own node | returned there, dev-mode warning | 2.4 |
| 13 | `shield` | kept in tier 2 as the non-cancellable region | 3.3 |
| 14 | The async-only lint rules | out of `recommended`, into a `bridge` config | 3.4 |
| 15 | Result | (b′): an expected failure is `yield* fail(e)`; `E` inferred on tasks; a four-way `Outcome`; `gen` retired (the author's direction; (a) is the alternative) | 3.6 |
| 16 | The bridge's profile | B1, PR #4's semantics, the target fixed at first consumption | 4.2 |
| 17 | Where an Op checks its guards | at consumption (a creation-frame check at construction is open) | 4.2 |
| 18 | The storage import | none for bodies; no `ramme/browser` | 4.3 |
| 19–26 | Platform: placement, `fetch`, `listen`, `once`/`on`, `each`, observers, lint scope | `ramme/platform` | 5.3 |
| 27 | Type names | `Operation<T>`, `Op<T>`, exported `Instruction` | 6 |
| 28 | An Op returned by a body, a release or a handler | driven in the returning frame | 1.4 |
| 29 | A finally-yield in a helper | not release work: body frame only, a dev-mode detector | 2.4 |

## 0. Why

### 0.1 What exists because the runtime cannot see an `await`

Native `await` resumes a function in a job userland cannot wrap (D9′), so
ramme learns of a body's waits only through the promises it hands out, and
of the body's position only through the async context. Each row
compensates for that.

| Mechanism | Where it lives | Size |
| --- | --- | --- |
| Bare vs managed awaits, `managed(p)`, the supported-shapes list | DESIGN §4.2 (762–1042, the longest section); D13 (1024–1082); src/managed.ts (`ManagedPromise` 284–549, the shape constructors 552–688) | §4.2 281 lines; managed.ts 688 |
| Freeze, then sticky rejection | D39 (1083–1320, the longest entry); managed.ts `#subscribe`'s applied branch (401–414), `#onDelivery` (534–544), `rejectSoon`; node-impl.ts `fire` pass 2b (455–487), `heldByUnwindingBody` (352); law 4, I6, I8 | D39 238 lines |
| `InterruptedError`, classification by awaiter | resource.ts (68–84); managed.ts `interruption()` (202–206), `Cell.foreign`, `thenFor`; DESIGN §4.4; README's second rule | |
| Call-shaped deferral | managed.ts `Shape.onMark`, `#onMark`/`#marked`/`#defers`, `managedCall`; node-impl.ts `joinMark`, `subscribedBelow`, `callTask`'s mark (1519–1522) | ~75 src |
| Exempt awaits (release work) | managed.ts `Shape.exempt`, `managedRelease`, `discardsThrow`; node-impl.ts `strictlyBelow` and the predicates in `release`, `releaseAll`, `close`, `[Symbol.asyncDispose]` | ~55 src |
| `shield` | node-impl.ts `shield` (1533–1563), `shieldHolds`, `waitForShields`; ambient.ts; README's third rule | ~75 src |
| Lending, `UnawaitedCallError` | node-impl.ts `lentTo`/`lender`, `callTask`, `assertNotLent` (1968–1991), `assertAwaitShaped`, `HANDLER_MAY_WHILE_LENT` (141); DESIGN §4.9; D11; I26 | ~105 src; lending.test.ts 632 |
| Lint rules tied to async bodies | `no-swallowed-interruption`, `no-finally-in-async`, `no-using-in-async`, `no-promise-combinators` (D35) | 211 rule, 308 test lines |
| Dev-mode await warnings | managed.ts `checkAwaiter` (186–194); `NodeImpl.run`'s `AsyncRunError` | |
| `sleep`'s handler timer | managed.ts `timerUntil`, `ManagedPromise.sleep`, `thenAsHandler`'s sleep branch; D34's settled note | ~45 src |
| The adapter requirement, the browser boundary | D9′; law 3; A1; DESIGN §6, §9; context-storage.ts `runInFrame` (throws without an adapter, 154–157) | |

### 0.2 What a generator body changes

Every wait is a `yield*` the driver steps. **Halt is `return()`**:
`finally` runs, `catch` does not. **Nothing is sticky**: a returned
generator has no later wait to reject. **An unyielded work Op does not
run**: a forgotten `yield*` is a no-op a lint catches. **Bodies need no
async context**: browsers, Deno, Bun and workerd run them without an
adapter. Each row of §0.1 is therefore *deleted for bodies* (stickiness
and the swallowed `catch`, cleanup in `shield`, lending), *reshaped* (the
supported-shapes list becomes the halt table of §2.3, decided by the same
predicates; bare vs managed becomes an explicit choice at each foreign
wait, `wait(p)` or `wait(p, { abandon: true })`), *optional* (the adapter,
needed wherever async code runs under a node, §4.3), or *kept for the
bridge*, where async code under a node still awaits invisibly (rejection,
`InterruptedError`, call-shaped deferral, the exemption, classification by
awaiter, `sleep`'s handler timer), as far as decision 16 keeps it.

### 0.3 Adoption

**Effect**'s primary style is `Effect.gen` with effects `yield*`ed
directly, and it wraps every promise (`Effect.tryPromise`), the adapter
per call D40 objects to; it is adopted anyway, though it offers far more
(typed `E` and `R`, Layer, Schema), so it shows `yield*` is not the
blocker, not that ramme's offer suffices. **Effection**, the nearest
analogue, buys exactly cancellation by construction, structured lifetimes
and browsers without AsyncContext, and stays niche. **ember-concurrency**
cancels generator tasks through `return()`; it added async-arrow tasks in
2.3.0, and its 4.x README requires a Babel transform rewriting them into
generators so users need not write `function*`: its users pushed it toward
`async` syntax. **redux-saga** declined for reasons partly specific to it
(`yield` of descriptors, untyped `TNext`; its uses moved to RTK; from
memory, not verified) and partly not (unfamiliar syntax, boilerplate), as
did **co**, which offered only what `await` then did.

| Package | npm downloads, last month (fetched 2026-10-24, direct and transitive) |
| --- | --- |
| `effect` | 185,808,634 |
| `redux-saga` | 5,437,571 |
| `ember-concurrency` | 502,320 |
| `effection` | 68,450 |

The conclusion is narrower than "generator libraries survive when they buy
what `await` cannot": **no generator library offering only cancellation
and lifetimes has reached broad adoption**; Effect's comes bundled with a
typed error channel, Schema and an ecosystem. ramme's case rests on DI and
the tree (§0.6), not on the generator runtime.

### 0.4 D40, re-read

| D40's reason for `async` | Under this proposal |
| --- | --- |
| Plain async functions | Conceded: `function*`/`yield*` are noisier; no arrow generators. |
| Native stack traces | Parity (§7.1, measured): today's traces already stop at every task boundary. |
| Debuggers | Not measured: stepping over a `yield*` with the driver ignore-listed (§7.1). |
| TypeScript inference | Kept: `yield*` infers the delegate's return per step (§6, verified). |
| Library interop | Conceded: every foreign promise is wrapped (`wait(p)`), the per-call adapter D40 named ("every library call an adapter"). The gain is one generic wrapper, not a library-specific one; foreign callbacks await Ops through `then` (§4). |
| `await using` | Lost in bodies (TS2852) and redundant: `own(x)` takes an `AsyncDisposable`; sync `using` runs on `return()`. |

### 0.5 What stays

The tree, the two stacks, DI, outcomes by state (D24), tasks, combinators,
pools, `Result`, lifecycle events, and laws 1, 2 and 5. Law 6 is restated
for synchronous re-entry (`listen`, `bind`, §5.3). The outline kept law 3,
which is "async context propagation is required": laws 3 and 4 are
rewritten (§3.5).

### 0.6 Against Effection

The sceptic's first question: if generators, why not Effection plus a DI
layer? After this proposal ramme's concurrency core shares Effection's
model: halt by `return()`, `wait` (Effection's `until`, with the opposite
default, §1.1), `each`/`each.next()`, `once`/`on`, an `action`-style
constructor for platform Ops (§5.1). What ramme keeps that Effection's
agent contract (frontside.com/effection/AGENTS.md, read 2026-10-24) does
not document: DI with placement by dependencies (Effection's
`createContext` is a scope-local value), the two stacks and their release
order, outcomes by state (`aborted` is not `failure`), call-shaped halts
across child nodes (a `finally` around `yield* call(t)` runs after `t` has
unwound, §2.3), pools, lifecycle events, and the bridge for async code
under a node (§4). The proposal is worth making only if those are what
users come for; the generator runtime alone does not distinguish ramme.

## 1. Operations and bodies

### 1.1 Op

An `Op<T>` is what every waiting verb returns, and the same methods on
`Context` and `Task`. **Work Ops** are `call`, `attempt`, `all`, `race`,
`settle`, `join`, `result`, `sleep`, `interrupted`, `never`, `wait(p)` and
`shield`; **lifecycle Ops** are `release`, `releaseAll`, `close` and
`[Symbol.asyncDispose]` (decision 2 treats them differently). `wait(p)` is
today's bare await made explicit and `wait(p, { abandon: true })` today's
`managed(p)` (decision 10). The name follows Effection v4's `until`, whose
default is the opposite: Effection halts at once, so `until(p)` is ramme's
`wait(p, { abandon: true })`, and Effection's guide says `until` "does not
make the promise cancellable" (decision 27 weighs the name). An Op is
**iterable** (`yield* op` in a body gives `T`) and **thenable** (`await
op` in async code). `fork`, `child`, `pool`, `own`, `lookup`, `current`,
`signal`, `run`, `runSync` and `inject` stay synchronous.

### 1.2 The protocol

```ts
declare const INSTRUCTION: unique symbol;
export interface Instruction { readonly [INSTRUCTION]: true }       // what the driver receives
export interface Operation<T> { [Symbol.iterator](): Iterator<Instruction, T, unknown> }
export interface Op<T> extends Operation<T>, PromiseLike<T> {}       // what every verb returns
// an Op's iterator: next() yields its instruction once, then returns what the driver resumes it with;
// throw(e) rethrows (required); return(v) is forwarded by yield* on a halt, where the op drops its subscription
```

The driver runs the instruction for the yielding body and resumes with
`next(value)`, `throw(error)` (consumption decided by the resume step, as
`deliverTo` does, managed.ts 259–270) or, on a halt, `return()`. A yielded
non-instruction gets a `TypeError` thrown back. The iterator must have
`throw`: without it `yield*` raises `TypeError: The iterator does not
provide a 'throw' method` in place of the child's error (verified).

**Decision 1: what an Op yields.** *Proposed:* a private `Instruction`,
not the Op: `yield op` without the star is then a type error (TS2769) and
a runtime `TypeError`, an `async function*` (whose `yield*` awaits each
value, verified) cannot run the Op through `then`, and `$`'s `Fail`
(§3.6) is told apart. *Alternative:* the Op yields itself, as Effect's
`SingleShotGen` does. *Cost:* `yield op` and `yield* op` look alike to the
driver. *Recommended:* the `Instruction`.

### 1.3 Laziness, reuse, the thenable

**Decision 2: work Ops are lazy; lifecycle Ops are eager.** *Proposed:*
constructing a work Op does nothing; its consumer runs it as a child of its
node, the driver at `yield*`, `then` at `await` (verified over PR #4's
code: an Op built and dropped ran nothing, and a later `fork()` did not
throw `UnawaitedCallError`). The four lifecycle verbs stay eager: the call
starts the release or close, as today, and returns an Op that only waits;
`yield*` and `then` subscribe, and every consumption waits for the same
completion, which C7's idempotence already allows. Laziness there would
break settled contracts: C7 ("`release(x)` runs x's release now"); I8's
pinned `void release(y); // runs now` after delivery (invariants.test.ts
391); early release from a factory (`void n.release(x)`, creation.test.ts
99 and 835), which DESIGN §3.5 allows and which a factory, unable to wait
(D26), has no other way to do (I23); DESIGN §2.8's entry contract, whose
`[Symbol.asyncDispose]()` "synchronous prefix delivers your signal"; D16's
"its promise exists before any dispose code runs"; and a platform callback
doing `void app.close()`, which would be a silent no-op. Being eager, the
lifecycle Ops are exempt from decision 4's objection to a promise and may
stay `ManagedPromise`s with `[Symbol.iterator]` added, keeping `.catch` on
`close()` (node-core.test.ts 153, 188; rejection-pin.test.ts 40).
`no-unused-op` does not flag them. *Cost:* D22's synchronous `call` start
holds for `yield*` (§2.2) but not for `await`, which calls `then` a job
later (verified); code that starts work early and awaits it later
serializes; and a forgotten `await` of a work Op is missing work, silent
until a lint reports it, where today the work runs and `UnawaitedCallError`
reports it at the next body operation (§7.3). *Alternative:* every Op
eager outside a driver. *Cost:* lending returns for async code (it is
PRs 1–3's transitional state, §8). *Alternative:* lifecycle Ops lazy too.
*Cost:* C7, I8, I23, DESIGN §2.7's table, §2.8 and §3.5's list are
restated ("runs when consumed"), and no synchronous code, factories
included, can release or close without calling `then`. *Recommended:*
lazy work Ops, eager lifecycle Ops.

**Decision 3: a second consumption.** *Proposed:* `yield*` runs a work Op
afresh, as a description; `then` runs it once per object, as a promise
must. A reused `const pause = sleep(50)` sleeps every pass, and a retry
around `yield* load` retries. *Alternatives:* memoize both sides (cost:
the loop spins after one sleep, a retry never retries, and an Op yielded
by a second body is a cross-body wait); single use (cost: a second `await
op` throws). *Recommended:* the proposal. *Cost:* one more rule; an
awaited Op holds its run's promise (A2); and, with decision 17's pure
construction, an Op shared across nodes and awaited shares its first
awaiter's run, interruption included (`FiberAbortedError` for the others,
§4.1), so a module-level `const pause = sleep(50)` is safe only under
`yield*`.

**Decision 4: the thenable.** *Proposed:* a plain `PromiseLike<T>` for work
Ops, which `await`, `Promise.all` and an async `return` reach in the
awaiter's store (verified). *Alternative:* a `Promise` subclass, as
`ManagedPromise` is. *Cost:* a promise is eager by contract. *Recommended:*
plain (the eager lifecycle Ops excepted, decision 2). *Cost:* `instanceof
Promise` is false, `.catch` and `.finally` are absent, and a framework that
probes `then` runs the Op through the bridge.

### 1.4 Bodies

A body is a generator function (`task(function* (req) { … })`) or a
synchronous function, run in one step. `NodeImpl.startBody` (812–848)
decides by the returned object, in this order: an Op, recognized by its
`Instruction` brand (decision 27), is driven as the body in the node's
frame (decision 28); a generator object is driven; a thenable keeps
today's branch, which release fibers need (`releaseEntry` runs
`e.dispose`, which may return a promise). The brand is tested, not
`Symbol.iterator`, since a body may return an array. So `task(() =>
helper(x))` is driven, and a release may be a generator.

**Decision 28: an Op returned by a callback.** Today three sites consume a
returned or forwarded promise through a plain `then` with no frame:
`startBody` (843, under `runInFrame(NO_NODE, …)`), `thenAsHandler`
(managed.ts 607–615, called from `holdForHandler` inside `runDetached`,
node-impl.ts 1256–1281), and `#listen` (managed.ts 487). Each tests
`instanceof ManagedPromise`, which a lazy Op is not. Consumed there, an Op
finds no node, or misses the handler-detach rule: `task(() => call(leaf))`
and `own({}, () => sleep(5))` succeed today and fail with
`NoCurrentNodeError` with a lazy Op (review probe p2), breaking I14 and
D39 A.7; and a handler returning a lazy Op that waits for its own parent
(`onFailure: () => join(f)` of an ancestor fiber, or `() => app.close()`
were `close` lazy) never reaches `ManagedPromise#thenAsHandler`, so
`run.awaits(waitsFor)` never detaches the hold and the parent waits for a
handler that waits for the parent (review probe p1: the app is "STILL OPEN
after 300 ms"). `Release<T>` (context.ts 52) accepts `() => Op<void>`,
since a `void` return admits any value, so types do not catch the release
case. *Proposed:* an internal brand test `isOp(x)` before every
`isPromise`/`instanceof ManagedPromise` site, consuming the Op as the
returning frame's own `yield*`: `startBody` drives a returned Op under its
own node (replacing the deleted `thenFor(this, …)`, not with a plain
`then`); a release function's Op is driven inside its release fiber;
`thenAsHandler` materializes the Op's `ManagedPromise` inside the handler
frame `{ node: p, creation: undefined, handler: run }` and calls its
`thenAsHandler(run, …)`, keeping the `waitsFor` detach; `#listen`
materializes an Op source and subscribes with `thenFor(cell.awaiter, …)`;
`handleRejection` (119–128) skips Ops, which never reject unconsumed (its
`x.then(…)` would otherwise run an Op returned to `run(fn)`, 1869–1872, or
by an event receiver, 2057). Generator functions are accepted as release
functions and failure handlers. *Alternative:* forbid returning an Op from a body, a release or
a handler, with a type error and a dev-mode `TypeError`. *Cost:* §4.7's
idioms become `onFailure: function* () { yield* … }`, and `Release<T>`
must be narrowed to catch it. *Recommended:* recognize Ops. I14 is
restated: "every release is a fiber, current while it runs; across an
`await` only where an adapter is registered" (§4.3).

**Decision 5: async bodies.** *Proposed:* refused, a type error (§6) and a
runtime `TypeError` naming `function*` for every node kind but `release`,
deleting `Body`'s `Promise<T>` arm (context.ts 49), `startBody`'s
`thenFor(this, …)` (843, replaced by decision 28's Op branch) and every
body-facing row of §0.1.
*Alternative:* accept them as Node-only sugar with PR #4's semantics.
*Cost:* one `Task<A, T>` over two cancellation models the type cannot tell
apart, `InterruptedError` in tier 1, DESIGN describing two runtimes
(§3.5). *Recommended:* refuse, accepting both during PRs 1–3 and for one
deprecated release, with a codemod (§7.4).

### 1.5 Helpers and `this`

Helpers are `function*` functions and generator methods, called with
`yield*`; a closure body is `function* () {}`. **Decision 6.** *Proposed:*
no `this` overload on `call`, `fork` or `task`: a generator method or
`.bind(this)` (typed, verified); `gen(thisArg, body)` keeps its overload,
unambiguous since `gen` takes no arguments. *Alternative:* `call(this,
function* () { … })`, after Effect's `gen(self, …)`. *Cost:* `call(body,
fnArg)` cannot be told from `call(thisFn, body)` when `this` is a
function. *Recommended:* none.

DESIGN §1's example, rewritten:

```ts
class Api {
  readonly #base = inject(Config).apiUrl;               // unchanged: creation is synchronous (D26)
  readonly #pool = own(openPool(this.#base));
  *get(path: string) {                                  // an operation helper: yield* api.get(…)
    const res = yield* fetch(this.#base + path);        // ramme/platform: signal() merged in (§5)
    return yield* wait(res.json());
  }
}

const handle = task(function* (req: Request) {
  const api = lookup(Api);                              // a borrow for this run
  const file = own(yield* wait(openTemp()));            // an AsyncDisposable, released when the run ends, however it ends
  return yield* call(render, yield* api.get(req.url));  // a child node, awaited
});

await using app = createRootContext();                  // top level is async code: it awaits Ops (§4); a close() is eager
server.on('request', (req) => app.fork(handle.with({ signal: req.signal, onFailure: log }), req));
```

## 2. The driver and the current node

### 2.1 A step and the slot

A **step** is one `next(v)`, `throw(e)` or `return()` on the body's
generator. The driver runs it with a synchronous module slot set to the
body's frame, restored in a `finally` (a `call` nests the child's first
step inside the parent's, `callTask` 1515), and inside `storage.run(frame,
…)` when an adapter is registered, so callbacks the step starts inherit
the node. The yielded op also **runs in the frame**: today's node methods
choose their target, lender and event node from `currentFrame()`, not from
the receiver (`awaitTarget()`, managed.ts 552–557, behind every shape
constructor; `callTask`'s lender, 1503–1505; `awaiterNode()` for
`join:enter`/`join:leave`, 1315–1318; `assertAwaitShaped`, 2015–2019;
`shield`, 1536–1537). Run outside it, `fiber.sleep(60)` is untargeted and
resolves after 62 ms though the fiber was aborted; inside, it rejects after
1 ms (review probe p5).

```ts
function step(d: Driver, resume: (it: Iterator<unknown>) => IteratorResult<unknown>): void {
  for (;;) {
    let r: IteratorResult<unknown>;
    try { r = runInFrame(d.frame(), () => resume(d.it)); }                 // slot set and restored; storage.run when registered
    catch (e) { return d.exit({ kind: 'threw', error: e }); }
    if (r.done) return d.exit({ kind: 'returned', value: r.value });       // dev mode: a lost halt is reported here (decision 29)
    const ins = r.value;
    if (!isInstruction(ins)) { resume = (it) => it.throw(new TypeError('use yield*')); continue; }
    if (d.node.applied && !d.unwinding && !ins.started) return d.halt();  // state, not a flag (§2.3); a started wait(p) is still subscribed
    let mp: ManagedPromise<unknown>;
    try { mp = runInFrame(d.frame(), () => ins.run()); }                    // target, lender, event node read in the frame
    catch (e) { resume = (it) => it.throw(e); continue; }                  // a guard error or sleep's RangeError lands at the yield*
    return void mp.thenFor(d.awaiter(),
      (v) => step(d, (it) => it.next(v)),
      (e) => (d.awaiter().applied ? d.halt() : step(d, (it) => it.throw(e))));
  }
}
```

`d.frame()` and `d.awaiter()` are the node, or the unwind fiber while
unwinding (§2.4). `ins.started` is true for an op whose work began when it
was evaluated: `wait(p)` over a promise and the eager lifecycle Ops
(decision 2).

`currentFrame()` (context-storage.ts 103–106) reads the slot, then the
storage. `runInFrame`, `outsideFrames` (node-impl.ts 110–112, managed.ts
627–629) and `runDetached` (context-storage.ts 131–134) save, set and
restore the slot (`NO_NODE` for the last two), with or without storage,
and without storage `captureContext` (136–151) captures the slot: today
they set only the storage, or nothing, so with "slot first" ramme's own
detached sections (`#listen`, `thenAsHandler`, `holdForHandler`,
`scheduleStart`, timers), which now run inside a step, would read the
stepping body's frame. The slot and the storage then never disagree inside
ramme's code. Without an adapter, `runInFrame` stops throwing (PR 3).
Creation (inject.ts `runCreation`) and failure handlers (`finishCompletion`
1217–1219) are synchronous frames, covered by the slot alone, and every
other consumer of `currentFrame` is unchanged. This is the synchronous
fallback D9′ rejected. D9′'s reasons do not apply to bodies: the old stack
could be left entered, a bleed, while the slot is restored in `finally` and
a step never spans a microtask checkpoint; and the old stack lost the node
at the first `await`, which a generator body does not have. They still
apply to async code without storage (§4.3).

### 2.2 Scheduling

`yield* call(t)` keeps D22 by construction: the driver runs
`child.startBody()` before the parent's step returns. `fork` is unchanged
(`scheduleStart`, 851–855).

**Decision 7: when a suspended body resumes.** *Proposed (S1):* in the
source's reaction, registered detached. A body then resumes earlier than
the async body it replaces: a callback subscribed synchronously at
`yield*` runs in the source's reaction, before job 1, where an `await` of
a `ManagedPromise`-shaped thenable resumes after job 2 (review probe p10),
so a generator body is 2–3 jobs ahead and PR #4's tests re-expressed for
bodies assert event order (node events, log order relative to
`node:complete`), never microtask counts. *Cost:* a microtask per wait.
*Alternative (S2):* resume in
a loop within the step when an op completed during its start, so a
synchronous `yield* call(t)` behaves as a function call (~19 against ~51
ns, §7.2). *Cost:* timing differs from today's tests. *Alternative:*
Effection v4's parent priority. *Cost:* a scheduler of ramme's own, where
D22's microtask start already meets D22's reasons and the call-shaped rule
(§2.3) makes a parent unwind after its child. *Recommended:* S1; S2 by the
benchmark, whose harness runs right after PR 1 so that S1/S2 and per-step
`storage.run` are settled before PR 2 pins timing (§8).

### 2.3 Halt

A **halt** is the driver's response to its node being *applied*
(`markDelivered`, node-impl.ts 795–805, sets `applied` for a `freeze` or
`restore` node). The driver reads that state; it does not wait for a
signal of its own, since a node born delivered goes through
`markDelivered` with `deferFire` false (from the constructor, 701), which
never runs `fire()`'s `onApplied` loop (465–470). The driver subscribes to
each op through `ManagedPromise.thenFor` (§2.1), so decision 8's rows come
from PR #4's code unchanged: row 1 is `#onDelivery` → `rejectSoon`, a job
queued under no frame, so no body code runs inside `abort()`; row 2 is
`#marked`; row 3 is the `exempt` shape plus `discardsThrow`, a success
resuming `next(v)`; row 4 is the `applied` test before an op runs. A
rejection that arrives while the node is applied is the halt. A delivery
inside the body's own step (it aborts its own node; a `'link'` failure
escalates) cannot call `return()`, which would throw `Generator is already
running` (verified): the step's next `yield*` finds the node applied, and
the op it yields is not run (row 4).

**Decision 8: the halt at each wait.** *Proposed:* PR #4's three shapes,
with `return()` in place of the rejection, decided by the same predicates
(`subscribedBelow`, `strictlyBelow`, and the `completionOf`/`waitsFor`
tests of `release`, `releaseAll`, `close` and `[Symbol.asyncDispose]`):

| The body waits on | PR #4, an async body | A generator body |
| --- | --- | --- |
| `sleep`, `never`, its own `interrupted()`; `join`/`result` of a fiber not subscribed below it; `wait(p, { abandon: true })` (today's `managed(p)`); a `close()` or `[Symbol.asyncDispose]()` of the node itself, an ancestor or an unrelated node (not strictly below, `strictlyBelow` 317; rejection-pin.test.ts 1292), and a `release` or `releaseAll` whose wait includes the node | rejects at the delivery | returned at once (a sleep's timer cleared) |
| `call`, `attempt`, `all`, `race`, `settle`; `join`/`result` of a fiber subscribed below it | rejects when the awaited fiber has completed; a fiber the delivery missed is delivered (`callTask`'s mark, `joinMark`) | returned when the awaited fiber has completed; the same delivery of a missed fiber |
| release work (`release`, `releaseAll`, `close()`/`[Symbol.asyncDispose]()` of a node strictly below, `shield`); `wait(p)`; `wait((signal) => p)` | not rejected: the body resumes and its next managed await rejects | on success, resumed with the value and returned at its next `yield*`; on failure, returned (a release-work failure is not consumed and surfaces at completion, DESIGN §4.12) |
| plain code (delivered during a step) | its next managed await rejects | its next `yield*` of an op not yet started is not run: returned there |
| `wait(p)` yielded after the delivery, including by a body born delivered | a bare await: resumed when `p` settles | as the third row, since `p` started when it was evaluated: subscribed, `p` marked handled; on success resumed and returned at the next `yield*`, on failure returned. With `{ abandon: true }`: `p` marked handled, returned at once. A lifecycle Op yielded then is started too, and rows 1 and 3 decide |

*Alternative:* return at once from every wait, as Effection halts.
*Cost:* a `finally` around `yield* call(t)` (an unlock, a rollback) runs
while the callee still writes, which D39 rejected, and an acquisition in
flight is lost. *Recommended:* the table, implemented through
`ManagedPromise.thenFor`, so PRs 1–3 reuse PR #4's predicates and code
unchanged (B0 would move rows 1–3 into the driver, about 30 lines, before
managed.ts is cut). It deviates from PR #4 twice, more narrowly: a failure
of a wait the halt let finish is not thrown into the body, so no `catch`
runs after a halt (the outcome is `aborted` either way); and an op not yet
started that is yielded after the delivery is never started, where PR #4
starts a `call` made then, born delivered (rejection-pin.test.ts A.2, line
492). The fifth row is not a deviation: without it a `wait(p)` dropped at
the halt would leave `p` with no handler, against D13 (an awaited
`managed(p)` marks `p` handled even when its awaiter is rejected,
`#subscribe`'s `src.then(undefined, noop)`), so a signalled fetch's
`AbortError` would be an unhandled rejection, ending the process under
Node's default; and law 1's `own(yield* wait(p))` would hold only before
the delivery.

**Decision 9: a body born delivered.** *Proposed:* stepped once, to its
first `yield*` of an op that has not started (every op but a `wait(p)`
over a promise and a lifecycle Op), and halted there without running that
op; a `wait(p)` on the way runs as the fifth row (D12 and DESIGN §4.6
unchanged, "first managed await" read as "first `yield*` of an op not yet
started"); `return()` on an unstarted generator runs no code (verified),
hence the step. *Alternative:* settle it unstarted. *Cost:* changes D12
and DESIGN §4.6, which D39 declined for calls. *Recommended:* step once.
*Cost:* its synchronous prefix runs for nothing, and it may run past
several `wait(p)`s, as PR #4's bare awaits did, each bounded by `p`
(`node:stalled` reports a long one). A fork born delivered that runs
§1.5's `handle` therefore owns the temp file `openTemp()` created, as
under PR #4.

**Decision 10: `wait(p)` at a halt.** *Proposed:* `wait(p)` is today's
bare await: the halt lets `p` finish, and a success resumes the body until
its next `yield*`, so `own(yield* wait(pool.connect()), (c) =>
c.release())` attaches the connection. `wait((signal) => p)` hands the
work `signal()`, and its rejection after the halt ends the body. `wait(p,
{ abandon: true })` is today's `managed(p)`: it stops waiting at once
(D13). *Alternative:* stop at once by default, as Effection's `until`
does. *Cost:* the connection is never owned, and a foreign bracket around
bridge work, a transaction callback (§4.4), is abandoned mid-unwind, so
the node releases the connection during the rollback: the hazard D39
fixed. *Recommended:* the proposal. *Cost:* a promise that never settles
holds the halted node, reported by `node:stalled`, as a bare await does
today (A8); synchronous code between a halted `wait(p)` and the next
`yield*` runs, side effects included (in a debounced task,
`show(yield* wait(img.decode()))` shows a stale result after a newer event
halted the run; guard with `signal().aborted`, or use `{ abandon: true }`);
and the default is the opposite of Effection's, which readers of its
documentation will assume.

### 2.4 Unwinding: a `finally` in the body may wait

After `return()`, every `yield*` is inside a `finally`: a `yield` there
suspends the return, and `return()` reaches helpers' `finally` blocks
through `yield*`, innermost first (verified). **Only the body's own
generator function keeps the halt across such a yield.** By the
ECMAScript `yield*` algorithm, once a delegate's `return()` has yielded,
the caller's next resumption is a normal completion: resumed with `next()`,
the delegate's final `done: true` becomes the value of the caller's
`yield*`, and the body runs on past the halt; resumed with `return()`, the
rest of the delegate's `finally` is skipped (review probe finally-yield,
Node 26.3: `body continued past the halted helper with x=undefined`, then
`op charge`, then a normal return). A `finally` in the body's own frame
keeps its return completion and works. So the driver runs a finally-yield
to completion as **release work** in the body's frame only (decision 29).
The outline's "stronger than Effection's 'must not yield* inside finally'"
is half right: Effection v3's guide allowed it ("Effection handles this
case for you"), but Effection's current contract
(frontside.com/effection/AGENTS.md) says "You must not `yield*` inside a
`finally`" and, under "Why `yield*` in a `finally` is unsafe", "The halt is
lost"; waiting cleanup goes in `ensure()`. ramme permits it one frame
deep, in the body, and adds the specification below.

**Decision 11: what a `finally` runs in.** *Proposed (U2, amended):* at a
halt the driver makes an **unwind fiber**, a release fiber of the node
(kind `release`, `observe`, `stack: 'none'`, signal
`releaseDeadline(…)`, `routesFailure`, as `shield` builds one,
node-impl.ts 1539–1547) but its own variant (`unwinding: true`), the
parent of every op the driver runs from `return()` on. Built literally as
`shield`'s fiber, it would contradict the rules below: a release fiber is
never an applied awaiter (D39: "a shield or another release fiber … are
never applied bodies"), so `call`'s resume step `take(child)` (1474)
consumes a failure the `finally` catches, which then never folds in
(review probe p8: `try { await call(rollback) } catch {}` in a
release-fiber awaiter ends `aborted`, the failure gone, where A.3's `try {
await release(tx) } catch {}` ends `failure rollback failed`); and
`routesFailure` would make the generator's final throw the node's failure
(review probe p6: `failure cleanup threw` where a body's own throw gives
`aborted`). The rules:

- **The frame addresses two nodes.** `current()`, `release`, `releaseAll`
  and `lookup` address the body's node (its explicit stack, its
  providers), so `finally { yield* release(tx) }` (DESIGN §4.2, 859) finds
  the body's entry, as on the normal path; literal U2 throws
  `NotOwnedError` there (`NodeImpl.release` looks only at
  `this.explicit`, 1083–1086) and `releaseAll()` releases the unwind
  fiber's empty stack (review probe p7). `own`, `fork`, `call`, `child`,
  `pool` and `signal()` address the unwind fiber. It is an unwinding
  frame carrying both nodes (`{ node: unwindFiber, unwound: node }`),
  where those four verbs read `unwound`. Ambient `fork(t)` and
  `current().fork(t)` therefore differ in a halted `finally` (the second
  is born delivered, D12), as `signal()` and `current().signal` do.
- **It runs release work, never interrupted.** Ops the driver runs are
  children of an undelivered, unsubscribed fiber, so they are not born
  delivered, and its deadline fires and applies nothing (D21); `signal()`
  reads that deadline. Slow or unbounded work in a halted `finally` cannot
  be cancelled and holds every owner up to the root (D21; `node:stalled`
  reports it; `releaseTimeoutMs` only signals). A swallowed interruption
  can no longer complete more ramme work through stickiness; what replaces
  D39's property is that no `catch` sees the interruption.
- **Its failures are reported once.** `discardsThrow` (managed.ts
  196–199) is true for an unwinding awaiter, and every resume step takes
  the `applied` flag, as the exempt ones do today: `call`, `all` and
  `race` `take(child, !applied)` (1474, 1594, 1639), `join` (1330),
  `outcomeStep` (259–265), `settle`'s member loop (1669). An op's failure
  is then thrown into the generator unconsumed, so a `finally` may catch
  it and it still folds in at completion: body `aborted` plus release
  failures is `failure` (DESIGN §4.12; rejection-pin A.3, line 567), not
  the outline's `SuppressedError`, which arises only over a body failure.
  A failed `wait(p)`, which has no holder, is recorded on the unwind fiber
  as a release failure, so a failed ROLLBACK is reported, caught or not
  (today's `shield` routes it the same way). `yield* attempt(t)` in a
  halted `finally` returns the outcome as a value with the failure left
  unconsumed, which is new. A plain `throw` from the `finally` is
  discarded (D24). `shield` keeps A.3's "consumes what it catches"
  (rejection-pin.test.ts 953), so the two release-fiber kinds differ.
- **Its outcome is the body's.** The unwind fiber's body is an internal
  promise that never rejects, resolved by the driver when the generator
  completes; its outcome carries only its own entries' release failures
  and its unconsumed children's, which `routesFailure` routes to the node
  once. The generator's completion, what it returned or threw, is the
  node's own `onBodyExit`, after the unwind, so `classify` gives `aborted`
  (238), the throw is discarded, and `heldByUnwindingBody` (352–355,
  `!b.bodyDone` while the body unwinds), D18 and "outcome fixed at
  settling" keep their meaning. `shieldHolds` stays for shields, and the
  unwind hold sits beside it: DESIGN §2.4 step 2 reads "once its unwind
  fiber and every shield it started have completed".

*Alternative (U1):* the node stays current, its ops exempt. *Cost:* the
node is delivered, so a `call` in the `finally` is born delivered
(constructor 690–701) and halted; only leaf ops work. *Alternative (U3):*
`current()` and every synchronous verb (`own`, `release`, `releaseAll`,
`signal()`) stay the unwound node, so a `finally` behaves the same however
it was entered (law 2, I21); only ops the driver runs take the unwind
fiber as parent and its deadline as their signal. *Cost:* a `fork` in a
halted `finally` is born delivered, as one in PR #4's `catch` is (DESIGN
§4.2), and a synchronous `signal()` handed to `fetch` in cleanup is
already aborted. *Recommended:* U2 with the two-node frame, the minimal
change that keeps the outline's "release deadline as `signal()`" and makes
`finally { yield* release(tx) }` work (open question 16).

**Decision 12: a finally-yield whose wait includes its own node.** Any op
whose wait includes the unwind fiber, the unwound node or one of its
ancestors deadlocks the unwind (D21): `close()` or `[Symbol.asyncDispose]()`
of the node or an ancestor (`current()[Symbol.asyncDispose]()` included,
since `current()` is the node), `release` or `releaseAll` of such an entry
(`root.release(current())`), and `join(f)` or `result(f)` where `f` is the
node or an ancestor fiber (`completionOf`, 308–310, holds since the unwind
fiber's `up` is the node). *Proposed:* the test is the instruction's
`waitsFor` evaluated against the unwind fiber before the op runs, the
predicate `HandlerHold.awaits` (363–373) already applies to the same set
for handlers; the generator is then returned at that yield, with a
dev-mode warning, as today's uncaught `InterruptedError` ends it there
(rejection-pin.test.ts A.3, line 652). A second `return()` while a
helper's `finally` is suspended skips the rest of that block, and the
outer `finally` still runs and may yield (review probe p9).
*Alternative:* throw a `TypeError` into it. *Cost:* a `finally` may catch
it, and uncaught it is discarded. *Recommended:* return. *Cost:* in
production the rest of that `finally` is skipped silently.

**Decision 29: a finally-yield in a helper.** *Proposed:* a `yield*` in a
`finally` is release work only in the body's own generator function.
Helper cleanup that waits goes in an entry, `own(value, function* (v) { …
})` (a generator release, decision 28), released when the node releases,
not when the helper returns; or the helper is run with `yield* call(helper,
…)`, so its `finally` is a body's. The driver halts with `it.return(HALT)`,
a private sentinel, and in dev mode reports a generator that finishes with
any other value, naming the body (a `return` in a `finally` is reported
too). An Op iterator's `return()` never suspends the halt: an Op that
needs waiting cleanup (`each` closing its source, §5.2; `gen`'s scope,
§3.6) hands it to the driver as release work, which an Op can do because,
unlike a plain helper, it knows it is returning. *Alternative:* helper
calls wrapped in a ramme Op that tracks return mode. *Cost:* a wrapper at
every helper call, and `yield* helper()` no longer the spelling.
*Recommended:* body frame only, with the detector (open question 11). A
lint can flag `yield*` in the `finally` of a generator method, or of a
`function*` not passed inline to a body verb. *Cost:* in production a lost
halt runs the rest of the body as release work, `yield* call(charge)`
included; the detector and PR 2's pinning test are the guard.

Two costs remain. **A halt cuts a normal-path `finally`**: a `finally`
reached by normal completion and suspended on a `yield*` at the delivery
is halted there, and `return()` skips the rest of the block (verified), so
cleanup the design relies on stays an entry (A7). **`await using` is gone
from bodies** (TS2852); sync `using` disposes on `return()`.

```ts
// the idiom stays own (the README's UnitOfWork, §4.1); this shows what a finally in the body may now do
const transfer = task(function* (from: Id, to: Id, amount: number) {
  const conn = own(yield* wait(pool.connect()), (c) => c.release()); // halted while connecting: resumed, owned, ended at the next yield*
  yield* wait(conn.query('BEGIN'));                // before the try: a failed BEGIN leaves nothing to roll back; halted, it still finishes (row 5)
  let done = false;
  try {
    yield* call(debit, conn, from, amount);        // halted here: debit is delivered, completes, then return()
    yield* call(credit, conn, to, amount);
    yield* wait(conn.query('COMMIT'));
    done = true;
  } catch (e) {
    throw translate(e);                            // a real failure of debit or credit, never the interruption
  } finally {
    if (!done) yield* wait(conn.query('ROLLBACK'));  // the body's own frame; on halt, release work run to its end,
  }                                                  // and a failed ROLLBACK is reported as a release failure
});
```

### 2.5 Modes, outcomes, and what else changes

`observe` bodies are not halted; `restore` bodies are, as `freeze` ones.
The birth rule (D12) and outcomes by state (D24) are unchanged. The group
bodies of `all`, `race` and `settle` (1573–1664), internal async bodies,
become generator bodies that wait with `wait(p, { abandon: true })`
(today's `managedFor`, 1578, 1620–1628, 1663): a halt returns them at once
and member failures stay with their holder. With the default `wait(p)` an
interrupted `all` would resume after its members complete, consume their
failures in its loop (1581–1587, `f.consumeFailure()`), then throw an
`AggregateError` that `classify` discards, losing them (I11); `race` and
`settle` (`memberFailuresTo`) have the same shape. `run(fn)` gains a twin
of `AsyncRunError` (1869–1876) for a returned generator; `armStallTimer`
stays, since unwinding can hang; the driver nulls its one subscription on
a halt (A2).

## 3. Consequences: the deletion inventory

### 3.1 The inventory

With bridge B1 (decision 16); "removed" is source lines, estimated from
the ranges.

| Mechanism | Today | Bodies | Bridge (B1) | Removed |
| --- | --- | --- | --- | --- |
| Lending, `UnawaitedCallError` | `lentTo`/`lender`, `callTask` (1500–1513), `shield` lending, `onBodyExit` (869–876), `finishCompletion` (1176–1188), `assertNotLent`, `assertAwaitShaped`, `HANDLER_MAY_WHILE_LENT`; resource.ts; `node:lent`/`node:returned` | deleted: an unyielded Op does not run | deleted: lazy | ~105 |
| Freeze targets | managed.ts `FreezeTarget`, `awaitTarget` | read in the step's frame (§2.1) | kept | 0 |
| Cells, hand-written promise protocol | `Cell`, `take`, `rejectSoon`, `fulfilWith`/`rejectWith`/`deliverTo`, `#listen`/`#settle`/`#forget` (~140) | reused: the driver subscribes through `thenFor` (§2.1) | kept | 0 |
| Stickiness | `#subscribe`'s applied branch, `managedSleep`'s applied target, `managedNever` | by construction | kept, per op | 0 |
| `InterruptedError` delivery | `interruption()`, `#onDelivery`, `fire`'s `onApplied` loop | `return()`; the rejection reaching the driver is the halt | kept | 0 |
| Exempt awaits | `Shape.exempt`, `managedRelease`, `discardsThrow`, `strictlyBelow`, the predicates (~55) | §2.3's third row, reused; the unwind fiber's applied flag | kept | 0 |
| Call-shaped deferral | `Shape.onMark`, `#onMark`/`#marked`/`#defers`, `managedCall`, `joinMark`, `callTask`'s mark (~75) | §2.3's second row, reused (`#marked`) | kept | 0 |
| Classification by awaiter, its warning | `Cell.foreign`, `thenFor`, `checkAwaiter`, `startBody`'s `thenFor` | gone: `yield*` runs for the yielder | kept: `then` memoizes | ~10 |
| `shield`'s lending and cleanup role | `shield`, `shieldHolds`, `waitForShields` | finally-yields; `shieldHolds` kept, the unwind hold beside it | kept as an Op | 0 (its lending is in the first row) |
| D16's provisional hold | `EarlyAwait`'s `hold`/`#drop`/`#provisional` (401–412) | kept: the lifecycle Ops stay eager (decision 2), and `hold` covers the gap before `then` | kept | 0 |
| `sleep`'s handler timer | `timerUntil`, `#sleep`, `ManagedPromise.sleep`, the handler branch (managed.ts 439–440, 650–670) | each `yield*` arms its own timer | kept: a handler awaiting the body's memoized sleep Op reaches the `#sleep` branch after the body's delivery cleared the body's timer (review probe p4: resumed at ~82 ms against an 80 ms deadline); without `timerUntil` it would wait forever | 0 |
| The async body path | `Body`'s `Promise` arm; `startBody`'s returned-`ManagedPromise` branch | a `TypeError`; the Op branch (decision 28) | thenable branch kept for releases | ~10 |
| The adapter requirement | `runInFrame`, `NO_STORAGE_MESSAGE` | the slot | storage optional | +20 |
| Ops returned by callbacks (decision 28) | the three `instanceof ManagedPromise` sites | `isOp` at four sites | the same | +20 |
| The unwind fiber | — | the `unwinding` variant, the two-node frame, the applied flag in five resume steps, the unwind hold (§2.4) | — | +40 |
| The driver, Op constructors | — | new | `then` over today's methods | +250 to +350 |

`EarlyAwait`'s live count stays. Alternatively `sleep`'s `then` could be
unmemoized, each `then` arming its own timer as each `yield*` does, as an
exception to decision 3; the timer could then go (~45). The outline's
"cuts" (`cutOnlyFor`, `markFrozen`) are not in the base: PR #4 replaced
them with `#onDelivery` and `rejectSoon`.

### 3.2 Totals

With B1, about 125 lines go and 330–430 come: **the source grows by about
200–300 lines**, and managed.ts becomes the bridge and the driver's
subscription. The driver estimate is an upper bound: reusing `thenFor`
replaces the separate subscription and second-row code (+15, +15) of the
first draft. With B0 (§4.2) managed.ts falls to about 90 lines and the
driver takes rows 1–3 of its own (+30), a net of about −250 to −350.
lending.test.ts (632 lines) is deleted; rejection-pin.test.ts is
re-expressed for bodies and, under B1, kept for the bridge.

The deletions are conceptual first. In generator frames a body author no
longer meets `UnawaitedCallError`, the swallowed `catch`, or the rules for
derived promises and `Promise` combinators. They still choose at every
foreign wait between `wait(p)` (today's bare await) and `wait(p, {
abandon: true })` (today's `managed(p)`), now explicitly. They still learn
which waits a halt lets finish (§2.3), and that only the body's own
`finally` may wait (decision 29). And they still meet `InterruptedError`
and the `throwIfAborted` rule in any async callback they hand a driver
(§4.4).

### 3.3 `shield` and `unshield`

**Decision 13.** *Proposed:* keep `shield` in tier 2, as an Op, for a
non-cancellable region on the normal path (`yield* shield(function* () {
yield* call(charge); yield* call(record); })`): release work, which a halt
lets finish. Its lending goes, and its README rule moves to the bridge
section. `unshield` (proposed after PR #4, not in the code: a child linked
to the owner's signal) stays meaningful inside a `finally` or a `shield`. *Alternative:* delete it.
*Cost:* the only spelling left is `try {} finally { … }`, which hides
intent. *Recommended:* keep.

### 3.4 Lints

The package registers eight rules (src/index.ts 19–28); the outline's
`no-bare-listener`, `no-bare-fetch` and `no-bare-async-iteration` do not
exist yet. The three async-only rules match `async` functions alone
(ast.ts `isInAsyncFunction`, 84–87), so they never fire on `function*`.

| Rule | Under the proposal |
| --- | --- |
| `no-timers` | kept; extended to `requestAnimationFrame`, `requestIdleCallback`, `scheduler.postTask` |
| `no-stored-borrow`, `no-owned-provider` | kept |
| `no-unused-outcome` | becomes `no-unused-op`: a work verb as an expression statement, not yielded, awaited or stored (the eager lifecycle verbs are not flagged: `void release(x)` is legitimate); a type-aware variant for Ops in variables and arrays |
| `no-promise-combinators` | narrowed to Ops inside `function*` (`Promise.all([call(a), call(b)])` runs both through the bridge, unseen by the driver); error |
| the three async-only rules | inert on bodies; bridge hygiene (decision 14) |
| `no-bare-listener`, `no-bare-fetch` | new (§5) |
| a finally-yield in a helper | new, syntactic: `yield*` in the `finally` of a generator method, or of a `function*` not passed inline to a body verb (decision 29) |
| `@typescript-eslint/await-thenable` | added to `recommended`: catches `await helper()` on a generator helper in async code (§6) |
| `no-await-in-body`, `no-bare-async-iteration` | not needed: TS1308, TS1103 and the `Body` type (§6) |

**Decision 14.** *Proposed:* move the three async-only rules to a `bridge`
config, since most async functions will not be under a node and D35's
cost ("every async function counts as a body") becomes the common case.
*Cost:* `no-swallowed-interruption` leaves `recommended` exactly where B1
keeps the hazard: today it fires on a `catch` inside `async (tx) => { … }`
nested in a body (ast.ts `isInAsyncFunction`, 84–87; severity `'error'` in
src/index.ts), the transaction callback where a foreign catch-all can
commit (§4.4), so a user on `recommended` is warned in fewer places than
today, and in the most dangerous one. *Alternative:* keep them in
`recommended`. *Cost:* false positives in every async function.
*Alternative:* keep `no-swallowed-interruption` in `recommended`, narrowed
to async functions lexically inside a `function*` or containing an `await`
of a verb imported from `'ramme'` (both syntactic), and move only
`no-finally-in-async` and `no-using-in-async`. *Cost:* async helpers
defined outside a body are not covered. *Recommended:* the `bridge`
config, as before; the narrowed rule is the review's suggestion (open
question 9).

### 3.5 Documents

DESIGN.md, estimated by section, with B1:

| Section | Today | Proposed | Change |
| --- | --- | --- | --- |
| §1 sample, §1.2, §1.3 | 62 | 62 | generator sample; adapters optional; tier 1 loses `shield`, `InterruptedError`, gains `wait` |
| §2.4, §2.6's `finally` passage | 83 | 75 | "after every shield" becomes "after its unwind fiber and every shield"; a body's `finally` may wait, a helper's may not |
| §4.1, §4.2 | 305 | ~330 | Ops, the halt table, unwinding and its two-node frame (~120); the bridge (~210), which keeps nearly all of today's §4.2 (sticky rejection, call-shaped deferral, the exemptions and their deadlock exceptions, the applied-awaiter rule, `sleep`'s target, classification by awaiter, derived promises, combinators), citing the halt table's predicates where it can |
| §4.4 | 57 | 45 | the swallowed interruption leaves bodies, stays for the bridge with the shared-promise caveat |
| §4.7, §4.9 | 81 | 45 | lending goes; the handler timer stays |
| §4.12, §4.13 interplay | ~45 | ~35 | `fromThrowing` can no longer swallow a halt |
| §6 | 30 | 35 | slot, its rules for detached sections, optional storage |
| platform (new) | 0 | 40 | §5 |
| §9, §10 | 112 | 110 | the lint list; laws 3, 4, 6; I6, I8, I10, I14, I25, I26; A1, A2, A7 |
| **Total** | **1,808** | **~1,810** | **about flat (±5%)** |

With B0, whose bridge shrinks to `FiberAbortedError` (~60 lines), about
1,660 (−8%); keeping async bodies as sugar, about +100 over B1, since both
runtimes are described. The outline's target, "DESIGN.md materially
shorter", is met only with B0: under B1 the 281 lines DESIGN §4.2 spends on
which awaits reject when move to the bridge rather than go, so the size
claim depends on decision 16.

Law 3 becomes *the driver carries the current node through a body; async
code finds it through the async context where an adapter is registered*.
Law 4 becomes *interruption ends a body's normal path; `finally` blocks
entered by the halt run as release work; the outcome is `aborted` by
state*, keeping its last three sentences (the runtime releases the node's
stacks; delivery reaches the subscribed subtree at once; completion
propagates up). Law 6 and I25 become *every asynchronous hook is a fiber,
or a synchronous re-entry of its node through a ramme wrapper (`listen`,
`bind`)* (decision 21). I6 becomes "once a `freeze` or `restore` node is
delivered, its body runs no op it yields on its normal path, except one
already started when it was evaluated (§2.3's fifth row); what its
unwinding yields in its own frame is release work of its unwind fiber,
never interrupted, signalled by the release deadline, and waited for
(D21)". I8 keeps "between delivery and completion every synchronous
operation works" and its pinned `void release(y)`, and "the unwinding body
may still await release work" becomes "its own `finally` may wait, as
release work of its unwind fiber". I10 adds "a work Op nobody consumes
never runs". I14 becomes "every release is a fiber, current while it runs;
across an `await` only where an adapter is registered". I26 goes. A1
applies to async code only. A7 keeps "cleanup the design relies on is an
entry" and drops "invisible to ramme" (a body's finally-yields run in a
node) and "can await only release work".

DECISIONS.md gains **D41** (~120 lines), which supersedes D9′, retires
D11, takes the body half of D13 and D39 (both stay as the bridge's
specification) and answers D40. D41 records these costs and changes: slow
or unbounded work in a halted `finally` cannot be cancelled and holds
every owner up to the root (mitigated by `node:stalled`; `releaseTimeoutMs`
only signals); D39's swallowed-interruption property ("cannot complete more
ramme work") becomes "no `catch` sees the interruption"; a new clause in
D39's applied-awaiter rule, "for an op a driver runs during an unwind, the
awaiter is the unwound body"; and a bridge Op's target is fixed at its
first `then`, the alternative D39 rejected (§4.1), with D13 and DESIGN
§4.2 ("`current()` when the promise is made" becomes "when the Op is first
consumed"), §4.4's shared-promise caveat and `checkAwaiter`'s message
("created in the body of …") amended. D22 gains the lazy-bridge note
(§1.3), D34's settled note stays (the handler timer is kept), D35's lint
list changes, and D30's stale "unsupported await shape" (1985) is fixed.
DESIGN §3.5's creation list, I16, I18 and the error table are restated
for decision 17's pure construction, or unchanged with its refinement
(§4.2). README.md's eight rules (258–298) become six (own
it before the work; every wait is a `yield*`, where `wait` lets `p` finish
and `abandon` stops waiting; a `finally` in the body may wait; pass
`signal()` on; release early; `inject` in constructors, `lookup` in
bodies), plus a bridge section that keeps the `catch` rule, `shield` and
`throwIfAborted` for callbacks, and adds that generator helpers are not
awaitable from async code (§4.3) and that `each.next()` runs on every
iteration, `continue` included.

### 3.6 Result

Today `$` (result.ts 213–227) is a hand-written async iterator and `gen`
(251–265) an async function that never calls `return()` (A7). Under
generator bodies `$` becomes a plain `function*` that `yield*`s an op it is
given and returns the success value or yields a private `Fail<E>`.

**Decision 15.** Three options. *Option (a):* `gen` stays the explicit
scope, an Op that forwards instructions to the outer driver, turns a yielded
`Fail` into `it.return(failure)` (the scope's `finally` runs), and forwards
a halt into the scope (verified). The scope is a helper-depth frame, so its
`finally` may `yield*` only because `gen`, being an Op, hands the scope's
unwinding to the driver as release work (decision 29). It types as
`Op<Result<SuccessOf<R>, ErrorsOf<Y> | ErrorOf<R>>>`, a bare `yield*
$(r)` in a task body is a type error (verified), result.ts stays a leaf,
and the task boundary stays untyped (D38). *Option (b):* a task body may
`yield* $(r)`, ended by `return(failure)`, making it `Task<A, Result<T,
E>>` (verified); a `$` in a helper ends the whole task, so `gen` is still
needed inside, and the success value is wrapped.

*Option (b′), the author's direction, recommended:* an expected failure is
a **fourth way for a body to end**, beside `return v`, `throw e` and the
halt: `yield* fail(e)`. The driver ends the body there and the task's
outcome is `failure(e)`. Because the failure is yielded, `Failure<E>` enters
the generator's yield union and the task's type is `Task<A, T, E>` with `E`
inferred, never declared; a body with no `fail` has `E = never` and nothing
about it changes. Propagation is `yield*`: `const user = yield*
call(getUser, id)` evaluates to `User` and re-yields `Failure<UserNotFound>`
into the caller's union, through helpers and tasks alike, so `E` grows
across the graph with no code (Effect's `E` channel without `R` or the
wrapper; Rust's `?` with inferred unions). Catching is `yield* attempt(t)`,
which returns the outcome. For that to stay typed, `Outcome` separates what
it folds together today: `success(T) | failure(E) | defect(unknown) |
aborted`, the split §4.12 already states in prose made a status. `gen` is
retired (a body is the scope); `$` stays as "unwrap a `Result` value I
hold" (a sync helper's return, a foreign `{ status, value }`) and
`fromThrowing` as the fence that turns a defect into a `failure` of type
`unknown`; the data-only `Result` stays as the interchange shape and what a
non-task function returns.

*Cost of (b′):* `Task<A, T, E>`, `Fiber<T, E>`, `Outcome<T, E>` gain a
parameter, inferred but visible in hovers and written signatures; deep
graphs accumulate unions and `mapFailure` them at module boundaries (the
Effect experience; tagged error classes with a literal member become the
convention, README §"Expected failures"); an unjoined fork's expected
failure must be routed like a defect (`'join' | 'link' | handler`, with the
handler receiving `E | unknown`); `all` fails fast on an expected failure
as on a defect; `settle` returns four-way outcomes; `Outcome`'s shape change
is breaking, cheapest now. *Cost of (a):* ramme pays Effect's `yield*`
syntax without Effect's main type benefit, and `gen` remains a second
scope concept. *What (b′) is not:* adopting Effect. `R` stays absent
because DI is ambient, `Scope` because the tree is, the wrapper because a
body is a plain generator function; one verb (`fail`), one status
(`defect`) and one type parameter are added. The example below shows (a);
under (b′) it reads `const user = yield* call(getUser, id)` with no `gen`,
`$` or `success`, and the task types as `Task<[id: string], Order,
UserNotFound | OrderNotFound>`. Async code keeps today's `$`, whose
parameter is `Result | Promise<Result>` (result.ts 213–215): a work Op, a
`PromiseLike`, is refused there (TS2345, review typing probe res.ts), so PR
4, which makes work Ops plain `PromiseLike`s, widens it.

```ts
const order = task(function* (id: string) {
  return yield* gen(function* () {
    const user = yield* $(getUser.call(id));       // the user, or the scope ends with the failure
    return success(yield* $(getOrder.call(user)));
  });
}); // Task<[id: string], Result<Order, UserNotFound | OrderNotFound>>
```

## 4. The bridge: async code under a node

### 4.1 What `then` does

Async code runs under nodes in four places: top-level code with a named
node (`await app.call(main)`), foreign callbacks a step started (a
driver's transaction callback), releases (`own(value, async (v) => …)`),
and failure handlers. It may use the synchronous verbs and `await` Ops.
The README's unit of work keeps its async release and moves its waits:

```ts
class UnitOfWork {
  static readonly scope = RequestScope;
  readonly #node = current();
  readonly #lease = inject(DbPool).acquire();
  constructor() { own(this, () => this.#settle()); }   // a release: async code under its release fiber
  done() { return this.#node.release(this); }          // an eager Op: yield* uow.done() in a body, await elsewhere
  *query(sql: string) { return yield* wait((signal) => this.#lease.conn.query(sql, signal)); }
  async #settle(): Promise<void> { … }                 // commit or roll back by parent!.outcome, as today
}
const handle = task(function* (req: Request) { yield* lookup(UnitOfWork).query('…'); }, { scopes: [RequestScope] });
```

A work Op's `then` runs the verb's node method as it exists today
(`NodeImpl.callTask`, `NodeImpl.shield`, `managedSleep`, …) at `then`
time and forwards to the `ManagedPromise` it returns; a lifecycle Op's
`then` subscribes to the `ManagedPromise` its call already made (decision
2). `await`, `Promise.all` and an async `return` call `then` from a job
carrying the awaiter's store (verified), so `callTask`'s lender and
`ManagedPromise.then`'s `peekCurrentNode()` read the awaiter's frame.
Verified over PR #4's code: the child is made under the awaiting node; an
interrupted awaiter gets `InterruptedError` after the child's `finally`
ran; the next `await` rejects again; a memoized Op awaited by a second
body gets `FiberAbortedError` and `checkAwaiter`'s warning; a top-level
`await call(t)` rejects with `NoCurrentNodeError`. Such a frame is foreign
by definition, the user's own async helper and Prisma's callback alike,
and PR #4's model specifies what it sees, with one change.

**A bridge Op's managed promise is made at its first `then`, so its
target is the first awaiter's node**, not the node where the Op was made.
Today the target is fixed in the `ManagedPromise` constructor
(`awaitTarget()`, managed.ts 552–557, reading the frame when the promise is
made; DESIGN §4.2, 928–932: "a managed promise belongs to the body that
made it"), and D39 rejected "deciding the target at `then` time, which
would change 'the node is fixed when it is made'". This proposal adopts
that alternative for work Ops. D39's reason no longer applies: a work Op is
made when it is consumed, so "made" and "first consumed" coincide for
every Op not shared, and for a shared one the memoized run belongs to its
first consumer, whose interruption the others see as `FiberAbortedError`.
D13 and DESIGN §4.2 ("`current()` when the promise is made" becomes "when
the Op is first consumed"), §4.4's shared-promise caveat (now covering a
shared Op's memoized `then`) and `checkAwaiter`'s message ("created in the
body of …") are amended (§3.5). Lifecycle Ops keep today's rule: their
promise is made at the call.

### 4.2 The bridge's profile, and guards

**Decision 16.** *Proposed (B1):* PR #4's semantics, as above, with the
target fixed at first consumption; managed.ts and `InterruptedError` (tier
2) stay. *Alternative (B0):* a plain thenable whose only interruption is
the awaited child's own `aborted` outcome, thrown by `take()` as
`FiberAbortedError` (node-impl.ts 247–253), which covers the transaction
case; managed.ts falls to about 90 lines, and `InterruptedError` and
classification by awaiter go. *What separates them:* under B0, non-call
waits in async code under a halted node (`sleep`, `never`, `interrupted`,
joins of owned forks, `wait`/`managed`) run to their end, and a callback
sees `FiberAbortedError` where B1 gives `InterruptedError`, so `instanceof
InterruptedError` checks in callbacks change meaning; a `call` made after
a swallow is still born delivered (D12) and aborted, so stickiness for
calls survives through the birth rule. *Under both*, a foreign catch-all
can swallow the error and commit (§4.4). *Recommended:* B1 through PR 4,
since it is built and pinned; B0 once it is known how much async code
still runs under nodes. Under either, `Promise.all([call(a), call(b)])` in
async code is two concurrent children where today it throws
`UnawaitedCallError`; with PRs 1–3's transitional state (§8) that change
arrives only in PR 4. B0's "about 90 lines" must keep the handler detach
(decision 28).

**Decision 17: guards.** *Proposed:* an Op checks `requireBodyShaped`'s
guards when consumed, and construction is pure, so a module-level `const
pause = sleep(50)` is legal. *Alternative:* check every guard at
construction. *Cost:* Ops cannot be built outside a node. *Recommended:*
at consumption. *Cost:* a misplaced Op is reported at its `yield*`, not
where it was made; and pure construction removes DESIGN §3.5's
`CreationViolationError` for body-shaped verbs in a factory (`call`,
`attempt`, `all`, `race`, `settle`, `join`, `result`, `interrupted`,
`never`, `sleep`, `managed`), on which I16 and I18 rely: a factory's `void
call(t)` builds an Op nobody consumes and does nothing, silently. With the
recommendation as it stands, §3.5, I16, I18 and the error table are
restated and `no-unused-op` covers factories. *Refinement (the review's):*
construction reads the frame once and throws only while a creation is
current, which keeps module-level Ops legal and §3.5 unchanged, at one
frame read per Op (open question 4).

### 4.3 Without storage

The slot covers all synchronous code: steps, `node.run(fn)`, creation,
failure handlers, `listen` callbacks. Async code without storage loses the
node at its first `await`, after which `current()` throws
`NoCurrentNodeError`: D9′'s half idiom, confined to async code, failing
loudly rather than on a wrong node, since the slot is empty whenever a
continuation runs. Browser async code names its node (`const node =
current()` before the first `await`); an async release or failure handler
without an adapter loses its frame after its first `await` (I14 as
restated, decision 28). `await getName(id)` on a generator helper resolves
to the generator object: there is no error as a statement, and only a use
of the value fails (TS2339 on a property access, review typing probe), so
`@typescript-eslint/await-thenable` joins `recommended` (§3.4). Async code
writes `await call(function* () { return yield* getName(id); })`, a child
node per call (~1,650 ns today, §7.2). No public constructor makes an Op
from a generator helper, so "libraries serving both return Ops" (§7.3)
needs one: `op(fn)` (open question 13).

**Decision 18: the storage import.** *Proposed:* bodies need none and
there is no `ramme/browser`; `ramme/node` and `ramme/async-context` become
optional, needed by async code under a node, and `NoCurrentNodeError`
there names them. *Alternative:* `ramme/browser`, so every entry file
chooses (D9′). *Cost:* an import that only satisfies a check.
*Recommended:* none. *Cost:* a Node application that forgets `ramme/node`
fails at its first bridge use, possibly in a rollback callback.

### 4.4 The foreign transaction

```ts
import 'ramme/node';                               // required: the callback is async code under the node (decision 18)

const save = task(function* (order: Order) {
  yield* wait(db.transaction(async (tx) => {       // foreign async code under this node: the bridge
    await call(insertOrder, tx, order);            // an Op through then: PR #4's semantics
    signal().throwIfAborted();                     // a swallowed interruption still never commits
  }));
});
```

The halt lets `wait(p)` finish (decision 10). Inside, `await call(…)`
rejects with `InterruptedError` once `insertOrder` has completed, the
driver rolls back, `p` rejects, the body is returned with no `catch` run,
and only then does the node release its connection. D39's residue stays:
a foreign catch-all can swallow the error and commit, hence the last line.

## 5. The platform layer (`ramme/platform`)

### 5.1 The rule for DESIGN

Every platform primitive that waits or calls back has a ramme spelling. A
**wait is an Op**, and the type system refuses the bare one (`yield*` of a
promise is TS2488). A **callback re-enters its node** synchronously, and
an `own` entry removes the registration. An **async iteration is `each`**
(`for await` is TS1103 in a generator). A **lint refuses the bare
callback** inside generator functions. Platform Ops share one internal
constructor modelled on Effect's `Effect.async` (v4 `Effect.callback`): a
register function given `resume` and a signal, returning a canceller run
on halt.

### 5.2 Catalogue

| Primitive | ramme spelling |
| --- | --- |
| `setTimeout`, `setInterval`, `setImmediate`, `scheduler.postTask` | `yield* sleep(ms)` (core); a loop is a `fork` over `sleep` (D34) |
| `requestAnimationFrame`, `requestIdleCallback` | `yield* nextFrame()`, `yield* idle({ timeout })` (`sleep` where rIC is missing) |
| `fetch`; body reads | `yield* fetch(input, init)` (decision 20); `yield* wait(res.json())` |
| promise APIs taking a signal (`fs/promises`, `pipeline`, `child_process`, `pipeTo`, `navigator.locks`) | `yield* wait((signal) => p)` |
| promise APIs without cancellation (`crypto.subtle`, `image.decode`, most driver queries) | `yield* wait(p)`, or `{ abandon: true }` |
| `addEventListener`, `on*` properties | `listen(target, type, handler, opts)`; `yield* once(target, type)` |
| Node `EventEmitter` | `listen`, `once` overloads typed structurally on `on`/`off`, no `node:` import; `once` rejects on `'error'` |
| observers; `WebSocket`, `Worker`, `MessagePort` | `own(new ResizeObserver(bind(cb)), (o) => o.disconnect())`; `own(x, release)`, then `listen` |
| async iterables (`ReadableStream`, `Readable`, `readline`, cursors, SDK streams) | `each(source)`: a halt or `break` closes the source as release work, handed to the driver, never from `each`'s own `return()` (decision 29) |
| callbacks expecting a promise (Workers `fetch`, Express, test runners); process signals | the thenable Op, `return app.call(handle, req)`; top-level `process.once('SIGTERM', () => app.abort())` |

### 5.3 Decisions

| # | Decision | Proposed (recommended) | Alternative: cost |
| --- | --- | --- | --- |
| 19 | Placement | `ramme/platform`, no dependencies, no `node:` imports; `sleep` stays in the core | the core entry: surface in every import; a package: version skew |
| 20 | `fetch` | a wrapper, `Op<Response>`, `signal: AbortSignal.any([signal(), init.signal])` (A3), its rejection after a halt the halt's echo; cost: shadows a global | `yield* wait((signal) => fetch(u, { signal }))`: noise, a lint must check the signal; Op body methods: surface the signal already covers |
| 21 | The frame a `listen` callback runs in | synchronous, on the node (the slot, as `node.run`): it may `lookup`, `own`, `fork`, `child`, read `signal()`, call `preventDefault()`, not wait. A throw is caught by the wrapper and routed as a `'link'` failure of the node, which aborts it and surfaces at its completion (I11, as C5 does for an owned fiber), never rethrown into the emitter. A generator handler is forked per event with `opts.onFailure`, required when the node is bodiless (D14), or into a pool `listen` owns | a fiber per event: starts in a microtask (D22, I20), too late for `preventDefault()`; an `onError` option on `listen`: later, if needed, defaulting to the same route |
| 22 | `listen`'s removal | both `{ signal: AbortSignal.any([signal(), opts.signal]) }` and an `own` entry removing the listener | `{ signal }` only: a node's signal does not fire at a natural exit or under `close()` (DESIGN §2.4; `onBodyExit` delivers only to subscribers), so it leaks; `own` only: the handler runs between delivery and release |
| 23 | `once`, `on` | `once(target, type)` an Op; `on(target, type)` an async iterable for `each`, buffering as `events.on` does, removed at close | `wait(events.once(em, name, { signal }))`: Node only |
| 24 | `each` | Effection's `for (const x of yield* each(src)) { …; yield* each.next(); }`, with a dev-mode error when `each.next()` is skipped, over an explicit-stepping primitive | a callback form: no `break`, `return` leaves the callback; explicit stepping only: verbose |
| 25 | Observers | a generic `bind(fn)` through decision 21's frame, with `own(obs, (o) => o.disconnect())` | a helper per observer: the surface grows |
| 26 | Lint scope | `no-bare-listener` (with `on*` assignments, `new *Observer(` outside `own`) and `no-bare-fetch` inside generator functions only | everywhere: flags the README's top-level `server.on('request', …)` |

Behind the table: today `NodeImpl.run` and `fork` check `assertNotLent`,
so decision 21 needs lending gone. Decision 21's synchronous re-entry is
an asynchronous hook that is not a fiber, so law 6 ("every asynchronous
hook is a fiber") and I25 ("no bare callbacks") are restated (§3.5):
"every asynchronous hook is a fiber, or a synchronous re-entry of its node
through a ramme wrapper (`listen`, `bind`)", with the wrapper's failure
route above, so a handler's throw neither escapes `emit()` nor the node's
outcome (DESIGN §2.8, "routed or collected"). An event reaching a
completed node is dropped by a live flag, since an `EventEmitter` still
calls a listener removed during the same `emit` (verified). An async
generator queues `return()` behind an
in-flight `next()` (verified), so `each` over a source stuck in a read not
handed `signal()` holds the node until the read settles (`node:stalled`).

### 5.4 Example: a search box, in a browser

```ts
import { createRootContext, fork, task, sleep, wait, type Fiber } from 'ramme';
import { fetch, listen } from 'ramme/platform';

const search = task(function* (q: string) {
  yield* sleep(200);                                              // debounce: a newer keystroke halts this run here
  const res = yield* fetch(`/search?q=${encodeURIComponent(q)}`); // a halt aborts the request
  show(yield* wait(res.json()));
});

const app = createRootContext();                                  // no adapter: the browser has none and needs none
const box = app.child({ name: 'search-box' });
let latest: Fiber<void> | undefined;
box.run(() =>
  listen(input, 'input', () => {                                  // re-enters box synchronously; removed with box
    latest?.abort();                                              // the previous run stops at its sleep or its fetch
    latest = fork(search.with({ onFailure: showError }), input.value); // box is bodiless: a 'join' fork is refused (D14)
  }),
);
```

Without `onFailure` the first keystroke throws `TypeError: fork(search)
onto bodiless node … with the default 'join' destination` (`NodeImpl.fork`,
node-impl.ts 1459–1465): with a bare DOM listener it reaches
`window.onerror` and the page silently does nothing; under decision 21 it
is routed as a `'link'` failure that ends `box`. `app.pool({ name:
'search-box', onFailure: showError })` is the other spelling. PR 3 runs
this example as written.

## 6. Typing

```ts
type Deferred = PromiseLike<unknown> | Iterator<unknown, unknown, never> | AsyncIterator<unknown, unknown, never>;
type Plain<T> = T extends Deferred ? never : T;
export type Body<T, A extends unknown[] = []> =
  | ((...args: A) => Generator<Instruction, Plain<T>, unknown>)
  | ((...args: A) => Plain<T>);
declare function task<A extends unknown[], T>(body: (...args: A) => Generator<Instruction, Plain<T>, unknown>, opts?: TaskOptions): Task<A, T>;
declare function task<A extends unknown[], T>(body: (...args: A) => Plain<T>, opts?: TaskOptions): Task<A, T>;
```

- **Inference through `yield*`** (all verified, tsc 6.0.3 strict) needs
  no annotations: `task(function* (id: string) { return (yield*
  loadUser.call(id)).name; })` is `Task<[id: string], string>`; a helper
  infers `Generator<Instruction, string, unknown>`; `yield* all([…])` is
  the tuple. On the thenable side `Awaited<Op<User>>` is `User` and
  `Promise.all` over Ops is the tuple.
- **The guard is needed.** Without `Plain<T>`, `task(async function* …)`
  passed as a synchronous body and `return loadUser.call(id)` typed as
  `Task<A, Op<User>>`; with it both fail (TS2769), as do an async body and
  a returned generator, and inference is kept. The message for an async
  body is "Type 'Promise<string>' is not assignable to type 'never'", with
  no hint to write `function*`; a branded guard, `T extends Deferred ?
  'ramme: a body is function*; use yield*, not await' : T`, would say what
  to do.
- **A returned Op: types and runtime disagree.** `task((id: string) =>
  loadUser.call(id))` is TS2769 (an `Op<User>` lacks `next`/`return`/
  `throw`), while decision 28's `startBody` drives an Op an arrow returns,
  and §7.3 has libraries return Ops. Either `Body` gains an arm, `(...a:
  A) => Operation<Plain<T>>`, as Effection's `() => Operation<T>` is a
  body, or §7.3 is narrowed to `yield*` callers (open question 12).
- **Annotations are optional.** `Operation<number>` on a helper compiles,
  `Op<number>` does not (TS2741), and a recursive helper needs one
  (TS7023). `Instruction` must be exported, or a library helper fails
  declaration emit (TS4058).

| Mistake | Proposed |
| --- | --- |
| `await` in a body | TS1308 |
| `for await`, `await using` in a body | TS1103, TS2852 |
| `yield*` of a promise; `yield* sleep` uncalled | TS2488 |
| a forgotten `yield*` whose value is used | TS2739 |
| `yield op`, as a statement or with its value used | TS2769 in a task body, and through any helper `yield*`ed into one (review typing probes n_yop_stmt, n_yop_helper); a helper never passed to a task compiles, and the driver's `TypeError` covers it and untyped code |
| an unyielded `call(…);`, `[1, 2].map(() => sleep(1))` | compiles; caught by `no-unused-op` and its type-aware variant |
| `await helper()` on a generator helper, in async code | compiles; TS2339 only where the value is used; caught by `@typescript-eslint/await-thenable` |

**Decision 27: names.** *Proposed:* `Operation<T>` (iterable, what helpers
return), `Op<T>` (iterable and thenable, what verbs return), `Instruction`
(an exported type over a private brand), `wait` for `managed`.
*Alternative:* one name, verbs returning `Operation<T> & PromiseLike<T>`.
*Cost:* long hovers. *Recommended:* two names. The brand is a `Symbol(…)`,
not `Symbol.for(…)`, as `TASK` is (internal-context.ts 87), so A4 (one
copy per realm) extends to Ops. On `wait`: it echoes Effection's `until`
but defaults the other way (§1.1), which favours a name of ramme's own;
`until` itself would mislead more.

## 7. Risks

### 7.1 Adoption and debugging

`function*`, no arrow generators, `this` only through methods or `bind`;
tutorials and code assistants default to `async`. Most mistakes are
compile errors (§6); the alternative is ember-concurrency's build-time
transform, a build step for everyone. Stack traces (measured):

| Shape | `error.stack` |
| --- | --- |
| a native `await` chain | the full async chain |
| an `await` on a `Promise` subclass overriding `then` (`ManagedPromise`'s shape) | the leaf frame only |
| ramme today: body → `call` → body → async helper → throw | the helper and `async leafBody`, then nothing |
| a generator with `yield*` helpers | the whole helper chain, plus `next` and driver frames |
| a generator across a task boundary | the child body and the driver |

Parity: both keep the chain within a task and lose it across tasks.
Mitigations: `x_google_ignoreList` to hide the driver, and in development
mode the node path on errors leaving a body. Not verified: stepping over a
`yield*` with the driver ignore-listed.

### 7.2 Performance (measured, indicative)

Node 26.3, best of 3, 2×10⁵–5×10⁵ iterations; the toy driver has none of
ramme's bookkeeping, so these bound costs rather than predict them.

| Wait | ns |
| --- | --- |
| native `await Promise.resolve(i)` | ~30 |
| bare `await` in a ramme body, `ramme/node` | ~28 |
| `await managed(Promise.resolve(i))` in a body | ~940 |
| `await call(syncTask)` in a body (a node made and completed) | ~1,650 |
| lean driver, `yield*` of a single-shot op | ~51 |
| the same, `als.run(frame, step)` per step | ~274 |
| through 10 delegating helpers | ~497 (~45 per level) |
| synchronous fast path, settled op (S2) | ~19 |

Today's per-wait cost is the `ManagedPromise` protocol (a `Cell`, an
`AsyncLocalStorage.snapshot()` per `then`, a detached reaction, a derived
promise), not propagation, nearly free on Node 24+. A per-step `als.run`
costs more than the driver: enter storage only when registered, or
register reactions in the step's context, which retains the node (A2).
Node 22 without `AsyncContextFrame` was not measured.

### 7.3 Laziness, iteration, libraries

Laziness turns a forgotten await from a runtime-detected error, where the
work still ran (`UnawaitedCallError` at the next body operation, README's
"Await every `call`"), into silent missing work: `call(sendEmail, u);`
runs nothing, with no runtime signal, until `no-unused-op` reports it, and
a syntactic rule misses Ops in variables. A possible dev-mode check, not
proposed here: the driver records the work Ops constructed during each
step under its slot and, at body exit, warns about any never consumed,
naming the verb. Third-party async iterables go through `each`, with its
quirk (§5.3). p-limit and p-retry do not compose with Ops. kilde (D6′) and
ramme-native libraries are to return Ops, which serve both kinds of
caller, but the proposal defines no public way to make an Op from a
generator helper: `op(fn)` would return an `Op<T>` that runs `fn`'s
generator inline under `yield*` and through a child node under `then`
(open question 13). A bundled second copy of ramme makes Ops the driver
does not recognize (A4).

### 7.4 The bridge, and migration

Two halt models remain, `return()` in bodies and PR #4's rejection in
async code under a node: the complexity removed from bodies, kept for
foreign and top-level code (B0 would shrink it to `FiberAbortedError`).

| Async form | Generator form |
| --- | --- |
| `async (…) =>` | `function* (…)` |
| `await <verb>(…)` | `yield* <verb>(…)` |
| `await p`; `await managed(p)` | `yield* wait(p)`; `yield* wait(p, { abandon: true })` |
| `for await (const x of src)` | `for (const x of yield* each(src)) { …; yield* each.next(); }` |
| `await using x = …` | `const x = own(…)` |
| an arrow capturing `this` | a generator method, or `.bind(this)` |

The table is partially mechanizable: a ts-morph codemod converts the
functions passed to `task`, `fork`, `call` and `shield` and the
generator-eligible helpers they await; the rest stays bridge code and
needs review, since choosing which async functions become generators is
whole-program and type-directed (D35: syntax cannot tell, "every async
function counts as a body"; `await p` → `yield* wait(p)` needs to know
whether `p` is an Op). `this`-capturing arrows and `for await` with
`continue` (which needs `each.next()` on every path) are manual.
`instanceof InterruptedError` in bodies becomes dead code. The test suite
(src/*.test.ts, about 20,000 lines) passes about 570 inline async bodies
to `task`/`fork`/`call`/`attempt`/`shield`, all 25 test files use async
arrows (about 1,400), and 99 lines mention `InterruptedError`; those that
pin body semantics are re-expressed in PR 4, with the README and DESIGN
samples. One release with both body kinds buys incremental migration at
the cost of two body semantics in that release.

## 8. Plan

Each PR lands its pinning tests first, then the code.

PR 1 cannot make every verb a lazy plain `PromiseLike` and still land
without deletions: that changes async-body behaviour PR #4's tests pin
before anything is removed (review probe p3, run with lending present).
`Promise.all([call(a), call(b)])` goes from a synchronous
`UnawaitedCallError` to a rejection; D22's order flips ("child started,
after call()" becomes "after call(), child started"); `const p = call(x);
fork(y)` stops throwing. `UnawaitedCallError` appears 55 times across 8
test files (17 in lending.test.ts). `$`'s parameter refuses a
`PromiseLike` (TS2345, §3.6). So **PRs 1–3 use decision 2's alternative as
a transitional state**: a work verb called outside a driver step returns
today's eager `ManagedPromise` with `[Symbol.iterator]` added, a `Promise`
and an Op at once, so async bodies, lending, D16, D22, `.catch` and `$`
are unchanged; a work verb built during a driver step (a slot read) is
lazy. PR 4 makes every work verb a lazy plain `PromiseLike`, together with
the lending deletion and the async-body refusal. *Alternative:* lazy from
PR 1, with those test rewrites and `$`'s widening moved into PR 1.
*Cost:* PR 1 is no longer "no deletions" and loses the parity check.

1. **Ops and the driver.** `Op`, `then` over today's node methods, the
   transitional laziness above, the slot (set alongside storage; the
   no-adapter path waits for PR 3), the driver running ops in the frame
   and subscribing through `thenFor` (§2.1), decision 28's Op recognition,
   generator bodies beside async ones, `run`'s twin of `AsyncRunError`; no
   deletions. Tests first: §6's type tests; the protocol facts the driver
   relies on (re-entrant and unstarted `return()`, a yield in `finally`,
   `throw` forwarding, a synchronous throw from running an op landing at
   the `yield*`); D22's synchronous `call` start; outcome parity with
   async bodies; review probes p1 and p2's cases (`onFailure` returning an
   Op that waits for its parent completes; `task(() => call(leaf))` and
   `own({}, () => sleep(5))` succeed).
2. **Halt and unwinding.** The halt table with its fifth row, decisions
   8–12 and 29, the unwind fiber variant and its two-node frame. Tests
   first: PR #4's pinning tests re-expressed, asserting event order, never
   microtask counts (decision 7). Tests 1, 4 (now a finally-yield) and 5
   transfer with `return()` for the rejection; A.3's 567 transfers as
   `finally { yield* release(tx) }` with a failing rollback, ending
   `failure` reported once; A.3's 652 transfers with decision 12's return
   in place of the rejection (`root.release(current())`,
   `current()[Symbol.asyncDispose]()`); A.3's 953 stays, for `shield`; 2
   and 3 become "no `catch` runs, no op not yet started runs"; A.2's call
   after the delivery becomes "not started"; 7 (I10) becomes "an
   unconsumed work Op never runs". New: review probes p6 and p8's cases
   (a plain throw from a halted `finally` gives `aborted`; a caught
   rollback failure in a halted `finally` still folds in); the
   finally-yield probe (a helper's finally-yield loses the halt, and dev
   mode reports it); a `wait(p)` after the delivery (a born-delivered fork
   running §1.5's `handle` owns its temp file; a signalled fetch's
   `AbortError` is handled); an interrupted `all` whose members fail while
   unwinding reports their failures once. The async versions stay as
   bridge tests.
3. **The surface.** Optional storage (`runInFrame` no longer throws
   without an adapter: storage.test.ts 53 and 70 change; 177's case
   extended to the no-storage slot); `ramme/platform` (`fetch`, `listen`,
   `once`, `on`/`each`, `nextFrame`, `bind`); `gen` and `$` over
   generators; the lint changes of §3.4 and §5. Tests first: each platform
   op's halt, the dropped-event live flag, a `listen` handler's throw
   routed to the node, §5.4 run as written, `gen`'s `finally` on a yielded
   failure.
4. **Removal.** Every work verb a lazy plain `PromiseLike`; async bodies
   refused (the release with PRs 1–3 ships them deprecated, with the
   codemod); lending deleted; the inventory of §3.1; DESIGN, DECISIONS
   (D41) and README rewritten and measured against §3.5's estimate. Its
   rewrite list: the 55 `UnawaitedCallError` assertions (lending.test.ts is
   deleted), the `Promise.all([call…])` cases (lending.test.ts 36,
   fiber.test.ts 1038), D22's order in async code, `$`'s parameter widened
   to `PromiseLike`, and the ~570 inline async bodies of §7.4. The
   unawaited `release`/`releaseAll`/`close` statements (ambient.test.ts
   641, 643; creation.test.ts 99, 1002, 1039; outcome.test.ts 745;
   node-core.test.ts 1424; lending.test.ts 128 and 400 go with that file)
   and the `.catch` on `close()` (node-core.test.ts 153, 188;
   rejection-pin.test.ts 40) stay valid, since the lifecycle Ops stay eager
   promises (decision 2).
5. **Benchmark.** Its harness is written against PR 1 and run before PR 2
   lands, so S1/S2 and per-step `storage.run` are settled before PR 2's
   re-expressed pins fix any timing: mitata on Node 22, 24, 26, Bun and
   Deno, Effection and Effect as references: N waits on a settled op; N
   synchronous `call`s; a request (fork, lookup, own, five calls,
   release); delegation depth 1, 5, 20; the bridge's `await op`; heap per
   10⁵ suspended fibers. It decides S2 (decision 7) and how the driver
   enters storage (§7.2); the PR itself records the harness and results.

## Open questions

The author's to decide; the proposal recommends but cannot settle them.

1. **The bridge's profile** (decision 16): B1 keeps PR #4 for async code
   and grows the source by about 200–300 lines; B0 deletes about 590 lines
   of managed.ts and `InterruptedError`. The difference for async code
   under a halted node: under B0 its non-call waits (`sleep`, `never`,
   `interrupted`, joins of owned forks, `wait`) run to their end, and a
   callback sees `FiberAbortedError` where B1 gives `InterruptedError`.
   Under both, a foreign catch-all can commit. It turns on how much async
   code will still run under nodes, and DESIGN's size claim depends on it
   (§3.5).
2. **Async bodies** (decision 5): removed after one deprecated release, or
   kept as Node-only sugar with two cancellation models under one `Task`.
3. **`wait(p)` at a halt** (decision 10): today's bare-await meaning or
   Effection's stop-at-once, and the opt-out's name (`{ abandon: true }`).
   The bare-await meaning runs plain code after a halted `wait(p)`: in a
   debounced task, `show(yield* wait(img.decode()))` shows a stale result
   after a newer event halted the run.
4. **A second consumption and pure construction** (decisions 3 and 17):
   "`yield*` runs, `then` remembers", or one rule for both; and since
   construction is pure, a module-level Op awaited by several nodes shares
   its first awaiter's run and interruption. Whether construction reads
   the frame once to keep `CreationViolationError` in factories (§4.2).
5. **Result** (decision 15): (b′), the typed error channel as `yield*
   fail(e)` with a four-way `Outcome` and `gen` retired, as the author
   leaned in discussion; or (a), `gen` as the explicit scope and the task
   boundary untyped, as D38 decided before bodies were generators.
6. **`shield` and `unshield`** (decision 13): kept in tier 2, or deleted.
7. **The storage import** (decision 18): none for bodies, or an explicit
   import everywhere, keeping D9′'s "the choice is in the entry file".
8. **Names** (decision 27, §5): `wait`, `Op`/`Operation`/`Instruction`,
   `each`, `listen`, a `fetch` that shadows the global.
9. **The lint config** (decision 14): whether the async-only rules leave
   `recommended`, or `no-swallowed-interruption` stays there, narrowed to
   async functions inside a `function*` or awaiting a ramme verb.
10. **The normal-path `finally`** (§2.4): whether a halt cutting a
    `finally` reached by normal completion is an acceptable cost.
11. **A finally-yield in a helper** (decision 29): release work only in the
    body's frame, with `own`/`call` (or an `ensure` sugar) for helper
    cleanup and a dev-mode detector, or helper calls wrapped in an Op that
    tracks return mode, at a wrapper per call.
12. **Whether `() => Operation<T>` is a body** (§6): the runtime drives a
    returned Op (decision 28) while the type refuses it; add the arm, or
    narrow §7.3.
13. **A public `op(fn)`** (§7.3), so generator helpers and service methods
    serve async callers without `call(function* …)`, a node per call.
14. **The destination of `listen`'s per-event forks** on a bodiless node
    (decision 21): `opts.onFailure` required, or a pool `listen` owns.
15. **What ramme offers over Effection plus a DI layer** once bodies are
    generators (§0.6), and whether that is what users come for.
16. **What a halted `finally` addresses** (decision 11): the two-node
    frame (`current()`, `release`, `releaseAll`, `lookup` on the node;
    `own`, `fork`, `signal()` on the unwind fiber), or U3 (every
    synchronous verb on the node, only driver-run ops on the unwind fiber).

## Appendix: Review notes

Each finding of the review, checked against the code at 4310ad3 (and, for
Effection and npm, against frontside.com/effection/AGENTS.md and
api.npmjs.org on 2026-10-24) before it was applied. B marks a blocking
finding, A an advisory one.

Applied:

1. B, `wait(p)` after the delivery dropped: §2.3's fifth row, decision 9 restated, the `ins.started` guard (§2.1).
2. B, lazy lifecycle verbs break C7, I8, I23, §2.8, D16: decision 2 makes `release`, `releaseAll`, `close`, `[Symbol.asyncDispose]` eager; D16's row reverts.
3. B, a shield-built unwind fiber contradicts D24 and I11: decision 11 gives the generator's completion to the node's `onBodyExit` and the unwind fiber a never-rejecting body.
4. B, the current node in a halted `finally` (U3): the breakages fixed by the two-node frame; U3 recorded as the alternative and open question 16, not recommended (its synchronous `signal()` is already aborted).
5. B, I6 and law 4 contradict decision 11: both restated (§3.5), with D41's new costs and D39's changed property; "invisible to ramme" dropped from A7.
6. B, an Op returned by a sync body, release or handler: decision 28 (Op recognition); I14 restated.
7. B, the bridge target moves to the first awaiter: stated in §4.1 and D41 as adopting D39's rejected alternative; decision 16 amended.
8. B, `listen` breaks law 6 and I25: both restated; decision 21 gains the `'link'` failure route; §0.5 corrected.
9. A, the halt table omits unrelated nodes: row 1 extended.
10. A, decision 12 misses `join`/`result`: decision 12 defined by `waitsFor`.
11. A, pure construction loses `CreationViolationError` in factories: the cost stated; the creation check given as a refinement and open question 4; recommendation unchanged.
12. B, the driver runs ops outside the frame and reads a flag: §2.1's sketch rewritten (ops in the frame, throws at the `yield*`, `applied` read from state, `thenFor` reuse); §3.1 rows updated.
13. B, three `instanceof ManagedPromise` sites: merged into decision 28; review probes p1 and p2 added to PR 1.
14. B, the unwind fiber's consumption and throw routing: the `unwinding` variant, `discardsThrow` and the applied flag in five resume steps; `shield` keeps A.3; `attempt` in a `finally` stated; p6 and p8 added to PR 2.
15. B, `release`/`releaseAll` in a halted `finally` throw `NotOwnedError`: the two-node frame; A.3's 567 re-expressed in PR 2.
16. B, PR 1 cannot land on its own: PRs 1–3 use decision 2's alternative as a transitional state; PR 4's rewrite list named.
17. A, the inventory and totals: the handler-timer row kept, totals recomputed (B1 grows the source), the `take()` citation fixed; the `watch.awaiting()` ordering note is moot with eager lifecycle Ops.
18. A, the group bodies' wait: `wait(p, { abandon: true })` stated in §2.5; a PR 2 test added.
19. A, `yield sleep(1);` is a compile error: §6's table corrected.
20. A, S1 does not keep PR #4's timing: decision 7 reworded; event-order assertions required; the benchmark run before PR 2; the no-adapter path moved to PR 3.
21. A, the slot and ramme's detached sections: §2.1 gains the save/set/restore rule.
22. A, decision 12's list is incomplete: merged with 10.
23. B, a helper's finally-yield loses the halt: decision 29, §2.4 rewritten, the Effection sentence corrected, the README rule restated, open question 11.
24. B, §5.4 forks a `'join'` fiber onto a bodiless node: `onFailure` added; decision 21 names the destination; a PR 3 test added.
25. B, §3.2's conceptual claims: rewritten; README's eight rules (not seven) become six plus a bridge section; §0.2's adapter line corrected.
26. A, adoption omits Effection: §0.3 gains the download figures and the narrower conclusion; §0.6 added.
27. A, D40 re-read answers weaker versions: §0.4's interop and debugger rows and §2.1's D9′ sentence corrected.
28. A, decision 14 leaves transaction callbacks unlinted: the cost and the narrowed alternative added; recommendation unchanged.
29. A, the `Body` type refuses a returned Op; no `op(fn)`: the contradiction stated (§6), `await-thenable` added, `op(fn)` and the `Operation` arm left as open questions 12 and 13.
30. A, a failed `wait(p)` in a halted `finally` is lost: decision 11 records it on the unwind fiber as a release failure.
31. A, decision 10's costs and `until`'s opposite default: both added (decision 10, §1.1, decision 27).
32. A, laziness hides forgotten awaits; §6's "compile:" label; shared module-level Ops: decision 2's and 3's costs added, §6's row relabelled, the dev-mode check listed as an option only.
33. A, decision 16 overstates B1's advantage: only the differences listed, in decision 16 and open question 1.
34. A, the DESIGN estimate: B1 given as about flat; the −8% attributed to B0.
35. A, the codemod overclaim: §7.4 says "partially mechanizable", with the test-suite counts.
36. A, the transfer and transaction examples: `own(…, (c) => c.release())`, `BEGIN` before the `try`, `import 'ramme/node'`.
37. A, missing open questions: 11–16 added; 4 merged with decisions 3 and 17.

Declined or changed in application:

- From 4 (U3): not recommended; the two-node frame of 15 is the smaller change and keeps the outline's "release deadline as `signal()`".
- From 11, 14 and 28: no recommendation changed on an advisory finding; each alternative is recorded, with its cost, for the author.
- From 29: the suggestion to make `startBody` call `[Symbol.iterator]()` before probing `then` became a brand test, since a body may return an array.
- From 32: the dev-mode unconsumed-Op check is described, not proposed.
- From 23: `ensure` is not added as a verb; `own(value, function* …)` and `call` cover helper cleanup, with `ensure` as possible sugar (open question 11).
