# Proposal: generator bodies (D41)

**Status: a proposal whose shape is decided.** Base: `main` at d0bc2f8,
with PR #4 (sticky rejection, `unshield`) merged; "today" means that code,
and line numbers are its. The author's decisions on the first draft
(2026-10-24) are marked **decided**; where one overturned a
recommendation, the former recommendation is recorded as rejected. The
other decisions state the proposal, its alternatives and costs, and a
recommendation. *(verified)* and *(measured)* mark scratch probes on Node
26.3.0 and TypeScript 6.0.3; "review probe pN" is feas-probes/pN-*.mjs in
the session scratchpad, run against 4310ad3, which differs from d0bc2f8
only by `unshield`.

A body becomes a generator function that the runtime steps. Every wait is a
`yield*` of an **Op**, which the driver sees, so an interruption no longer
travels as a rejection: the driver **halts** the body by calling its
generator's `return()`. A `finally` runs, and one in the body's own
generator function may wait, as release work; `catch` never sees the
interruption; nothing is sticky. Work Ops are lazy, so a forgotten `yield*`
runs nothing and lending goes; the lifecycle verbs (`release`,
`releaseAll`, `close`, `[Symbol.asyncDispose]`) stay eager. An expected
failure is a fourth way for a body to end, `yield* fail(e)`, typed on the
task.

The current node is a synchronous slot the driver sets around each step.
ramme uses no async context, on any platform: `current()` is valid in a
step, in whatever a step calls synchronously, in `node.run(fn)` and in a
`promised` body, and never after an `await`. There is no async code under a
node. Plain async code reaches ramme through three entry points (§4): an Op
with an explicit receiver (`await app.call(main)`), `promised(body)` for a
library's async callback, and `listen`/`node.run` for a synchronous
callback. That deletes managed.ts's rejection protocol, `InterruptedError`,
lending, the storage adapters and four lint rules: about 900–1,000 source
lines go and 445–540 come (§3.2), and DESIGN.md shrinks by about 10–13%
(§3.5).

## Reader's guide

What remains the author's: whether U3, the simpler addressing of a halted
`finally` that the author prefers, survives PR 1's probes (decision 11);
what a node's `[Symbol.asyncDispose]()` means now that only the top level
and tests use it (decision 32); and the smaller Open questions. §3 counts
what generators remove and add (the deletions read from the files; the
additions and managed.ts's residual estimated), and §3.2 states the
"simpler" claim with them. §7.4 names the one capability
lost: using ramme from existing async code.

## Decisions at a glance

| # | Decision | Status | Outcome | § |
| --- | --- | --- | --- | --- |
| 1 | What an Op yields | recommended | a private `Instruction` record | 1.2 |
| 2 | When an Op runs | recommended | work Ops lazily, at `yield*` or `then`; the four lifecycle verbs eagerly, as today | 1.3 |
| 3 | A second consumption | recommended | `yield*` runs it again; `then` runs it once | 1.3 |
| 4 | The thenable | recommended | a plain `PromiseLike` on an Op that knows its node; the lifecycle Ops stay promises | 1.3 |
| 5 | Async bodies | **decided** | refused, with no deprecated release (rejected: one release that still runs them) | 1.4 |
| 6 | `this` | recommended | no overload on `call`, `fork`, `task` or `promised` | 1.5 |
| 7 | Resumption | recommended | in the source's reaction (S1); S2 if the benchmark asks for it | 2.2 |
| 8 | The halt at each wait | recommended | PR #4's three shapes, `return()` for the rejection | 2.3 |
| 9 | A body born delivered | recommended | stepped to its first `yield*` of an op not yet started, halted there | 2.3 |
| 10 | `wait(p)` at a halt | **decided** | `p` finishes and the body ends at its next `yield*`; `{ abandon: true }` stops at once; `wait((signal) => p)`; `managed` goes | 2.3 |
| 11 | What a halted `finally` addresses | recommended (the author's preference) | U3: every synchronous verb addresses the unwound node; ops the driver runs take the unwind fiber (alternative: the two-node frame, the former recommendation) | 2.4 |
| 12 | A finally-yield whose wait includes its own node | recommended | returned there, dev-mode warning | 2.4 |
| 13 | `shield`, `unshield` | **decided** | kept in tier 2 | 3.3 |
| 14 | The async-only lint rules | **decided** | deleted, not moved (rejected: a `bridge` config) | 3.4 |
| 15 | Expected failures | **decided** | (b′): `yield* fail(e)`, `E` inferred, a four-way `Outcome`, `gen` retired; `all` and `race` fail on it as on a defect (D28) | 3.6 |
| 16 | Async code under a node | **decided** | there is none; an Op that knows its node is thenable (rejected: the bridge, B1 as recommended and B0) | 4 |
| 17 | Where an Op checks its guards | **decided** | at construction, which reads the slot (rejected: pure construction, the former recommendation) | 4.1 |
| 18 | Async context | **decided** | none, on any platform: `ramme/node`, `ramme/async-context` and the storage registry go; D41 supersedes D9′; the floor is any ES2018 runtime (rejected: optional storage, the former recommendation) | 2.1 |
| 19–26 | Platform: placement, `fetch`, `listen`, `once`/`on`, `each`, observers, lint scope | recommended | `ramme/platform` | 5.3 |
| 27 | Type names | recommended; `wait` decided | `Operation<T>`, `Op<T>`, exported `Instruction` | 6 |
| 28 | An Op returned by a body, a release or a handler | **decided** | driven in the returning frame | 1.4 |
| 29 | A finally-yield in a helper | **decided** | not release work: the body's frame only, with a dev-mode detector | 2.4 |
| 30 | A library's async callback | **decided** | `promised(body)`, a core verb; `ctx.promised(body)` | 4.2 |
| 31 | `[Symbol.asyncDispose]` | **decided** | the contract for foreign resources and roots; D3′ amended, not reversed | 1.6 |
| 32 | What a node's `[Symbol.asyncDispose]()` does | open | recommended: abort, then wait, as today (alternative: `close()`) | 1.6 |

## 0. Why

### 0.1 What exists because the runtime cannot see an `await`

Native `await` resumes a function in a job userland cannot wrap (D9′), so
ramme learns of a body's waits only through the promises it hands out, and
of the body's position only through the async context. Each row
compensates for that.

| Mechanism | Where it lives | Size |
| --- | --- | --- |
| Bare vs managed awaits, `managed(p)`, the supported-shapes list | DESIGN §4.2 (763–1105, the longest section); D13 (1024–1082); managed.ts (`ManagedPromise` 285–546, the shape constructors 548–689) | §4.2 343 lines; managed.ts 689 |
| Freeze, then sticky rejection | D39 (1083–1373, the longest entry); managed.ts `#subscribe`'s applied branch (402–416), `#onDelivery` (534–545), `rejectSoon` (213–215); node-impl.ts `fire` pass 2b (474–479), `heldByUnwindingBody` (352–355); law 4, I6, I8 | D39 291 lines |
| `InterruptedError`, classification by awaiter | resource.ts (68–93); managed.ts `interruption()` (203–207), `Cell.foreign` (154), `thenFor` (366–372), `checkAwaiter` (187–195); DESIGN §4.4; README's second rule | |
| Call-shaped deferral | managed.ts `Shape.onMark` (115), `#onMark`/`#marked`/`#defers` (301–303, 525–532), `managedCall` (579–586); node-impl.ts `joinMark` (338–344), `subscribedBelow` (322–329), `callTask`'s mark (1566–1569) | ~75 src |
| Exempt awaits (release work) | managed.ts `Shape.exempt` (108), `managedRelease` (592–601), `discardsThrow` (198–200); node-impl.ts `strictlyBelow` (317–319) and the predicates in `release` (1108), `releaseAll` (1139), `close` (1393), `[Symbol.asyncDispose]` (1439) | ~55 src |
| `shield`, `unshield` | node-impl.ts `shield` (1580–1610), `shieldHolds`, `waitForShields` (1011–1017), `unshield` (1515–1529), `enclosingShield` (362–364); ambient.ts; README's third rule | ~110 src |
| Lending, `UnawaitedCallError` | node-impl.ts `lentTo`/`lender`, `callTask` (1546–1570), `assertNotLent` (2015–2041), `assertAwaitShaped` (2065–2069), `HANDLER_MAY_WHILE_LENT` (141); DESIGN §4.9; D11; I26 | ~113 src; lending.test.ts 632 |
| Lint rules tied to async bodies | `no-swallowed-interruption`, `no-finally-in-async`, `no-using-in-async`, `no-promise-combinators` (D35) | 211 rule, 308 test lines |
| Dev-mode await warnings | managed.ts `checkAwaiter` (187–195); `NodeImpl.run`'s `AsyncRunError` (1916–1922) | |
| `sleep`'s handler timer | managed.ts `timerUntil` (667–671), `ManagedPromise.sleep` (345–349), `thenAsHandler`'s sleep branch (440–441); D34's settled note | ~45 src |
| The adapter requirement, the browser boundary | D9′; law 3; A1; DESIGN §6, §9; node.ts, async-context.ts; context-storage.ts `runInFrame` (throws without an adapter, 154–157) | 91 + ~70 src |

### 0.2 What a generator body changes

Every wait is a `yield*` the driver steps. **Halt is `return()`**:
`finally` runs, `catch` does not. **Nothing is sticky**: a returned
generator has no later wait to reject. **An unyielded work Op does not
run**: a forgotten `yield*` is a no-op a lint catches. **Bodies need no
async context**: the driver sets the current node around each step, on
every platform. Of §0.1's rows, sticky rejection, `InterruptedError` and
classification by awaiter, lending, the four async-only lints, the
handler's sleep timer and the adapters are *deleted*. The supported-shapes
list is *reshaped* into the halt table of §2.3, decided by the same
predicates, and bare vs managed into an explicit choice at each foreign
wait, `wait(p)` or `wait(p, { abandon: true })`. `shield` and `unshield`
are *kept*, for a non-cancellable region on the normal path (§3.3).
Nothing is kept for async code under a node, because there is none (§4).

### 0.3 Adoption

**Effect**'s primary style is `Effect.gen` with effects `yield*`ed
directly, and it wraps every promise (`Effect.tryPromise`), the adapter
per call D40 objects to; it is adopted anyway, though it offers far more
(typed `E` and `R`, Layer, Schema): `yield*` is not the blocker, which is
not to say ramme's offer suffices. **Effection**, the nearest analogue,
buys exactly cancellation by construction, structured lifetimes and
browsers without AsyncContext, and stays niche. **ember-concurrency**
cancels generator tasks through `return()`, and its 4.x README requires a
Babel transform rewriting async-arrow tasks into generators: its users
pushed it toward `async` syntax. **redux-saga** (descriptors, untyped
`TNext`, from memory) and **co** declined.

| Package | npm downloads, last month (fetched 2026-10-24, direct and transitive) |
| --- | --- |
| `effect` | 185,808,634 |
| `redux-saga` | 5,437,571 |
| `ember-concurrency` | 502,320 |
| `effection` | 68,450 |

**No generator library offering only cancellation and lifetimes has
reached broad adoption**; Effect's comes bundled with a typed error
channel, Schema and an ecosystem. ramme's case rests on DI, the tree and,
with decision 15, typed expected failures (§0.6), not on the generator
runtime.

### 0.4 D40, re-read

| D40's reason for `async` | Under this proposal |
| --- | --- |
| Plain async functions | Conceded, further than the first draft: `function*`/`yield*` are noisier, there are no arrow generators, and async code cannot use ambient ramme (`current()`, `lookup`, the free functions) after an `await`; it reaches ramme only through a node it names or captured before the first `await` (§4.1, §4.4, §7.4). |
| Native stack traces | Parity (§7.1, measured): today's traces already stop at every task boundary. |
| Debuggers | Not measured: stepping over a `yield*` with the driver ignore-listed (§7.1). |
| TypeScript inference | Kept: `yield*` infers the delegate's return per step, and the expected-failure union across tasks (§6, verified). |
| Library interop | Conceded: every foreign promise is wrapped (`wait(p)`) and every async callback a library calls is `promised(function* …)`, a node per call: D40's "every library call an adapter". The gain is that the adapter is one generic wrapper, not a library-specific one. |
| `await using` | Lost in bodies (TS2852) and kept where it is legal, at the top level and in tests (decision 31); `own(x)` takes the same `AsyncDisposable`, and sync `using` runs on `return()`. |

### 0.5 What stays

The tree, the two stacks, DI, outcomes by state (D24), tasks, combinators,
pools, `Result`, lifecycle events, the `[Symbol.asyncDispose]` contract
(D3′, amended), and laws 1, 2 and 5. Law 3 ("async context propagation is
required") is replaced, law 4 rewritten, and law 6 restated for
synchronous re-entry (`listen`, `bind`; §3.5).

### 0.6 Against Effection

If generators, why not Effection plus a DI layer? After this proposal
ramme's concurrency core shares Effection's model: halt by `return()`,
`wait` (Effection's `until`, with the opposite default, §1.1),
`each`/`each.next()`, `once`/`on`, an `action`-style constructor for
platform Ops (§5.1), and `promised` where Effection has `run`. What ramme
keeps that Effection's agent contract (frontside.com/effection/AGENTS.md,
read 2026-10-24) does not document: DI with placement by dependencies
(Effection's `createContext` is a scope-local value), the two stacks and
their release order, outcomes by state, typed expected failures (§3.6),
call-shaped halts across child nodes (§2.3), pools and lifecycle events.
The proposal is worth making only if those are what users come for (open
question 10).

## 1. Operations and bodies

### 1.1 Op

An `Op<T>` is what every waiting verb returns, and the same methods on
`Context` and `Task`. **Work Ops** are `call`, `attempt`, `unshield`,
`all`, `race`, `settle`, `join`, `result`, `sleep`, `interrupted`,
`never`, `wait`, `shield` and `fail`; **lifecycle Ops** are `release`,
`releaseAll`, `close` and `[Symbol.asyncDispose]` (decision 2 treats them
differently). `wait(p)` is today's bare await made explicit and `wait(p, {
abandon: true })` today's `managed(p)`, whose name goes (decision 10). The
name follows Effection v4's `until`, whose default is the opposite:
Effection halts at once, so `until(p)` is ramme's `wait(p, { abandon: true
})`, and Effection's guide says `until` "does not make the promise
cancellable". An Op is **iterable** (`yield* op` in a body gives `T`) and,
when it knows its node, **thenable** (`await op` in plain async code,
§4.1). `fork`, `child`, `pool`, `own`, `lookup`, `current`, `signal`,
`run`, `runSync`, `inject` and `promised` stay synchronous.

### 1.2 The protocol

```ts
declare const INSTRUCTION: unique symbol;
export interface Instruction { readonly [INSTRUCTION]: true }       // what the driver receives
export interface Operation<T> { [Symbol.iterator](): Iterator<Instruction, T, unknown> }
export interface Op<T> extends Operation<T>, PromiseLike<T> {}       // what every verb returns
// an Op's iterator: next() yields its instruction once, then returns what the driver resumes it with;
// throw(e) rethrows (required); return(v) is forwarded by yield* on a halt, where the op drops its subscription
// fail(e) yields a Failure<E> under a second brand, disjoint from Instruction (§3.6, §6)
```

The driver runs the instruction for the yielding body and resumes with
`next(value)`, `throw(error)` (consumption decided by the resume step, as
`deliverTo` does, managed.ts 260–271) or, on a halt, `return()`. A yielded
value that is neither an instruction nor a failure gets a `TypeError`
thrown back. The iterator must have `throw`: without it `yield*` raises
`TypeError: The iterator does not provide a 'throw' method` in place of the
child's error (verified).

**Decision 1: what an Op yields.** *Proposed:* a private `Instruction`,
not the Op: `yield op` without the star is then a type error (TS2769) and
a runtime `TypeError`, an `async function*` (whose `yield*` awaits each
value, verified) cannot run the Op through `then`, and `fail`'s yield is
told apart. *Alternative:* the Op yields itself, as Effect's
`SingleShotGen` does. *Cost:* `yield op` and `yield* op` look alike to the
driver. *Recommended:* the `Instruction`.

### 1.3 Laziness, reuse, the thenable

**Decision 2: work Ops are lazy; lifecycle Ops are eager.** *Proposed:*
constructing a work Op runs nothing; its consumer runs it, the driver at
`yield*`, `then` at `await` (verified over PR #4's code: an Op built and
dropped ran nothing, and a later `fork()` did not throw
`UnawaitedCallError`). The four lifecycle verbs stay eager: the call starts
the release or close and returns an Op that only waits, and every
consumption waits for the same completion (C7's idempotence). Laziness
there would break C7 ("`release(x)` runs x's release now"), I8's pinned
`void release(y); // runs now` (invariants.test.ts 391), early release
from a factory, which cannot wait (D26; `void n.release(x)`,
creation.test.ts 99 and 835; I23), DESIGN §2.8's "synchronous prefix
delivers your signal", D16's "its promise exists before any dispose code
runs", and a platform callback's `void app.close()`. Being eager, the
lifecycle Ops stay promises with `[Symbol.iterator]` added, keeping
`.catch` on `close()` (node-core.test.ts 153, 188; rejection-pin.test.ts
40); their promise is what remains of managed.ts (§3.1). *Cost:* D22's
synchronous `call` start holds for `yield*` (§2.2) but not for `await`,
which calls `then` a job later (verified); and a forgotten `yield*` is
missing work, silent until a lint reports it (§7.3). *Alternative:* every
Op eager. *Cost:* lending stays; it is PR 1's transitional state (§8).
*Alternative:* lifecycle Ops lazy too. *Cost:* the contracts above are
restated ("runs when consumed"), and no synchronous code, factories
included, can release or close.
*Recommended:* lazy work Ops, eager lifecycle Ops.

**Decision 3: a second consumption.** *Proposed:* `yield*` runs a work Op
afresh, as a description; `then` runs it once per object, as a promise
must. Built in a step and reused, `const pause = sleep(50)` sleeps every
pass, and a retry around `yield* load` retries; at module level it throws
at construction (decision 17). *Alternatives:* memoize both sides (cost:
the loop spins after one sleep, a retry never retries); single use (cost: a
second `await op` throws). *Recommended:* the proposal. *Cost:* one more
rule, and an awaited Op holds its run's promise (A2).

**Decision 4: the thenable.** *Proposed:* a plain `PromiseLike<T>` on a
work Op that knows its node (§4.1), which `await`, `Promise.all` and an
async `return` reach (verified). *Alternative:* a `Promise` subclass, as
`ManagedPromise` is. *Cost:* a promise is eager by contract.
*Recommended:* plain (the eager lifecycle Ops excepted, decision 2).
*Cost:* `instanceof Promise` is false, `.catch` and `.finally` are absent,
and a framework that probes `then` runs the Op.

### 1.4 Bodies

A body is a generator function (`task(function* (req) { … })`) or a
synchronous function, run in one step. `NodeImpl.startBody` (825–861)
decides by the returned object, in this order: an Op, recognized by its
`Instruction` brand, is driven as the body in the node's frame (decision
28); a generator object is driven; a thenable is refused with a
`TypeError` naming `function*` (decision 5), except in a release fiber,
whose body is the entry's dispose (`releaseEntry`, 1038): a foreign
`[Symbol.asyncDispose]()` or an async release returns a promise, waited
for as a bare wait. The brand is tested, not `Symbol.iterator`, since a
body may return an array. So `task(() => helper(x))` is driven, and a
release or a failure handler may be a generator function.

**Decision 28 (decided): an Op returned by a callback is driven.** Three
sites consume a returned promise through a plain `then` with no frame:
`startBody` (856), `thenAsHandler` (managed.ts 608–616, from
`holdForHandler`, node-impl.ts 1269–1294) and `#listen` (managed.ts
484–489, gone in PR 2). Each tests `instanceof ManagedPromise`, which a
lazy Op is not: `task(() => call(leaf))` and `own({}, () => sleep(5))`
then fail with `NoCurrentNodeError` (review probe p2), and a handler
returning an Op that waits for its own parent never reports its
`waitsFor`, so the parent waits for a handler that waits for the parent
(review probe p1: "STILL OPEN after 300 ms"). `Release<T>` (context.ts 52)
accepts `() => Op<void>`, so types do not catch it. An internal brand test
`isOp(x)` runs before every such site and consumes the Op as the returning
frame's own `yield*`: under the body's node, inside the release fiber, or
in the handler frame `{ node: p, creation: undefined, handler: run }`
after reporting its `waitsFor`; `handleRejection` (119–128) skips Ops
(`run(fn)`'s value, 1916–1922; an event receiver's, 2107). *Rejected:*
forbidding a returned Op, which needs `Release<T>` narrowed and makes
`onFailure: function* () { yield* … }` the only spelling.

**Decision 5 (decided): async bodies are refused,** by a type error (§6),
a runtime `TypeError` naming `function*` for every node kind but
`release`, and `no-async-body` (§3.4). `Body`'s `Promise<T>` arm
(context.ts 49) and `startBody`'s `ManagedPromise` branch (849–856) go.
There is no deprecated release: ramme is pre-1.0, the codebase is the
author's, and the codemod converts (§7.4). A release or failure handler
may still be `async`, as a bare wait; one that uses ramme after its first
`await` throws `NoCurrentNodeError`, which dev mode reports naming the
cause, and the codemod rewrites as a generator release or handler.
*Rejected:* async bodies as Node-only sugar with PR #4's semantics
(two cancellation models under one `Task`, `InterruptedError` in tier 1,
DESIGN describing two runtimes); one deprecated release that still runs
them (the former recommendation), two body semantics for a migration a
codemod and a single owner make unnecessary.

### 1.5 Helpers and `this`

Helpers are `function*` functions and generator methods, called with
`yield*`; a closure body is `function* () {}`. **Decision 6.** *Proposed:*
no `this` overload on `call`, `fork`, `task` or `promised`: a generator
method or `.bind(this)` (typed, verified); `gen(thisArg, body)` goes with
`gen` (decision 15). *Alternative:* `call(this, function* () { … })`, after
Effect's `gen(self, …)`. *Cost:* `call(body, fnArg)` cannot be told from
`call(thisFn, body)` when `this` is a function. *Recommended:* none.

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

await using app = createRootContext();                  // top level: an explicit receiver (§4.1)
server.on('request', (req) => app.fork(handle.with({ signal: req.signal, onFailure: log }), req));
```

### 1.6 The release contract

**Decision 31 (decided): `[Symbol.asyncDispose]` stays the contract for
foreign resources and roots; D3′ is amended, not reversed.** `own(x)`
accepts anything with `[Symbol.asyncDispose]` or `[Symbol.dispose]`
(`toDispose`, resource.ts 182–193, unchanged): a library that adopted the
standard is attached with no adapter, its release fiber waiting on the
returned promise as a bare wait. Nodes implement both symbols for where
`await using` is legal: the top level, a test, a framework's lifecycle
hook. In a body `await using` is unavailable (TS2852); sync `using` is
legal and runs on `return()` (verified) but is invisible to ramme, so
`own` stays the idiom. ramme values are released through the tree
(`yield* release(x)` early) and need not implement the symbol unless they
serve plain async code. D3′'s clauses that assumed `await using` in
bodies go.

**Decision 32 (open): what a node's `[Symbol.asyncDispose]()` means.**
Today it aborts, then waits (1436–1450; a fiber's acts as `join`), while
`close()` drains (1389–1394: no signal, subscribers finish, then both
stacks). Used only at the top level and in tests, "I am done with this
scope" could mean drain, with abort the explicit word. *Proposed:* keep
abort-then-wait. A scope's exit then means what a body's exit means (D18:
it interrupts its subscribers), and a test or `main` that leaves work
running (a forgotten fork, a server loop) ends instead of hanging; drain
is `await app.close()`. *Alternative:* `close()`, as a Trio nursery or a
Kotlin `coroutineScope` waits for its children. *Cost:* a test that
forgets a fork hangs until its runner's timeout; a server's `await using`
needs `app.abort()` from its shutdown signal first (§5.2's idiom
already); DESIGN §2.7 and §2.8's entry contract ("whose synchronous
prefix delivers your signal") change for nodes. `[Symbol.dispose]()`
aborts either way. *Recommended:* abort-then-wait (open question 2).

## 2. The driver and the current node

### 2.1 A step and the slot

**Decision 18 (decided): no async context, ever** (D41 supersedes D9′).
A **step** is one `next(v)`, `throw(e)` or `return()` on the body's
generator, run with a synchronous module slot set to the body's frame and
restored in a `finally` (a `call` nests the child's first step inside the
parent's, `callTask` 1562). ramme registers no `AsyncLocalStorage` and no
`AsyncContext.Variable` on any platform: `ramme/node` (node.ts, 30 lines),
`ramme/async-context` (async-context.ts, 61), context-storage.ts's adapter
mechanism (47–89, 125–151), package.json's two `sideEffects` entries, its
`exports` entries `./node` and `./async-context`, and the async-context
wording in its `description` ("carried across await by the platform's
async context") and keywords (`async context`, `AsyncLocalStorage`) are
deleted, and the browser is a first-class target with no entry of its
own. The slot is valid in a step; in whatever a step calls synchronously
(constructors, factories, `inject`, `own`, `lookup`); in `node.run(fn)`;
in a `promised` body (§4.2); in creation and failure-handler frames
(inject.ts 325, `finishCompletion` 1230). It is never valid after an
`await`, where `current()` throws `NoCurrentNodeError`. *Rejected:*
optional storage, the former recommendation, kept for async code under a
node (§4.5); a `ramme/browser` import that only satisfies a check.

**The floor is any ES2018 runtime** (decided); the browser and every
server runtime are targets on equal terms. Today's build does not meet it,
so PR 2 pays for it. tsconfig's `target` goes from ES2022 to ES2018, which
downlevels the `#private` fields to WeakMaps (with
`useDefineForClassFields: true` made explicit, since its default follows
the target), and `lib` from ES2024 to ES2018 plus the disposable and DOM
declarations, so a later API is a compile error. A local `withResolvers()`
replaces `Promise.withResolvers` (ES2024) at the sites that survive PR 2
(nine today: managed.ts 646, 668; node-impl.ts 286, 621, 994, 1033, 1271,
1367, 1656); `settle`'s one `flatMap` (ES2019, node-impl.ts 1721) and the
`globalThis` reads (ES2020: node-impl.ts 106, resource.ts 166; managed.ts
170) are rewritten; `Symbol.asyncDispose` and `Symbol.dispose` are read
through a `Symbol.for` fallback where the runtime lacks them; and
`AggregateError` (ES2021) is shimmed, as `SuppressedError` already is
(resource.ts 148–166). `AbortSignal.any`/`timeout` are WHATWG, not
ECMAScript; they are shimmed where missing too, so A3 keeps only
`AbortController` and `queueMicrotask` beyond ES2018. About 35–50 lines in
all (§3.1). `engines` loses its `node >= 22` pin, and A3 is rewritten in
PR 5.

The yielded op **runs in the awaiter's frame**: today's node methods take
their target, lender and event node from `currentFrame()`, not the
receiver (`awaitTarget()`, managed.ts 553–558; `callTask`'s lender,
1550–1551; `awaiterNode()`, 1328–1331; `shield`, 1583–1584). Run outside
it, `fiber.sleep(60)` resolves after 62 ms though the fiber was aborted;
inside, it rejects after 1 ms (review probe p5).

```ts
function step(d: Driver, resume: (it: Iterator<unknown>) => IteratorResult<unknown>): void {
  for (;;) {
    let r: IteratorResult<unknown>;
    try { r = runInFrame(d.frame, () => resume(d.it)); }                    // the slot set, and restored in a finally
    catch (e) { return d.exit({ kind: 'threw', error: e }); }
    if (r.done) return d.exit({ kind: 'returned', value: r.value });        // dev mode: a lost halt is reported here (decision 29)
    const ins = r.value;
    if (isFailure(ins)) return d.exit({ kind: 'failed', error: ins.error }); // yield* fail(e) (decision 15)
    if (!isInstruction(ins)) { resume = (it) => it.throw(new TypeError('use yield*')); continue; }
    if (d.node.applied && !d.unwinding && !ins.started) return d.halt();   // state, not a flag (§2.3); a started wait(p) is still subscribed
    let src: Source<unknown>;
    try { src = runInFrame(d.opFrame(), () => ins.run(d.awaiter())); }      // the awaiter's frame: target, lender, event node, guards
    catch (e) { resume = (it) => it.throw(e); continue; }                  // a guard error or sleep's RangeError lands at the yield*
    return void src.subscribe(d.awaiter(),
      (v) => step(d, (it) => it.next(v)),
      (e) => (d.awaiter().applied ? d.halt() : step(d, (it) => it.throw(e))));
  }
}
```

`d.frame` is the frame a step runs in: the node's, while unwinding too, so
`current()` and every synchronous verb address the unwound node (U3,
§2.4). `d.opFrame()` is the frame an op runs in, the awaiter's: the
node's on the normal path, the unwind fiber's while unwinding. Today's
methods read target, lender and event node from `currentFrame()`, so this
makes the unwind fiber the op's parent and target: in PR 1 the
`ManagedPromise` that `ins.run` returns targets the unwind fiber, a
release fiber `awaitTarget()` never names, and is never rejected as the
applied node's would be (`#subscribe`'s applied branch, managed.ts
402–416). `d.awaiter()` is that frame's node. `ins.started` marks an op
whose work began when it was evaluated: `wait(p)` over a promise, and the
eager lifecycle Ops. In PR 1 `ins.run` returns the
`ManagedPromise` today's node method makes and `subscribe` is its
`thenFor`, so PR #4's predicates decide the halt; PR 2 replaces both with
the driver's own subscription.

`currentFrame()` (context-storage.ts 103–106) reads the slot; `runInFrame`
(154–157) saves, sets and restores it (PR 2's form: in PR 1 `runInFrame`
is today's, through the registered storage, §8); `outsideFrames`
(node-impl.ts 110–112, managed.ts 628–630) becomes an unconditional
`runInFrame(NO_NODE, …)`, so ramme's detached sections running inside a
step (`holdForHandler`, `scheduleStart`, the release loop's
continuations, timers) never read the stepping body's frame.
`runDetached` and `captureContext` go: a reaction ramme registers retains
nothing but its closure (A2 holds for the context by construction), and
`creation.ended` (inject.ts 166–170) guards nothing, since no
continuation can carry a creation frame. This is the synchronous fallback
D9′ rejected, and D9′'s reasons do not apply: the old stack could
be left entered (a bleed), while the slot is restored in `finally` and a
step never spans a microtask checkpoint; the old stack lost the node at a
body's first `await`, and a generator body has none; and outside bodies
ramme states the limit instead of hiding it (§4.4).

### 2.2 Scheduling

`yield* call(t)` keeps D22 by construction: the driver runs
`child.startBody()` before the parent's step returns. `fork` is unchanged
(`scheduleStart`, 864–868).

**Decision 7: when a suspended body resumes.** *Proposed (S1):* in the
source's reaction, registered detached. A body then resumes earlier than
the async body it replaces: a callback subscribed synchronously at
`yield*` runs in the source's reaction, before job 1, where an `await` of
a `ManagedPromise`-shaped thenable resumes after job 2 (review probe p10),
so a generator body is 2–3 jobs ahead, and PR #4's tests re-expressed for
bodies assert event order (node events, log order relative to
`node:complete`), never microtask counts. *Cost:* a microtask per wait.
*Alternative (S2):* resume in a loop within the step when an op completed
during its start, so a synchronous `yield* call(t)` behaves as a function
call (~19 against ~51 ns, §7.2). *Cost:* timing differs from today's
tests. *Alternative:* Effection v4's parent priority. *Cost:* a scheduler
of ramme's own, where D22's microtask start already meets D22's reasons
and the call-shaped rule (§2.3) makes a parent unwind after its child.
*Recommended:* S1; S2 if PR 5's benchmark shows the difference matters.
Since the pins assert event order, a later S2 breaks none of them.

### 2.3 Halt

A **halt** is the driver's response to its node being *applied*
(`markDelivered`, node-impl.ts 808–818). The driver reads that state
rather than waiting for a signal, since a node born delivered goes through
`markDelivered` with `deferFire` false (from the constructor, 714), which
never runs `fire()`'s `onApplied` loop (474–479); for a body suspended on
an op, the halt is an entry in that set. A delivery inside the body's own
step (it aborts its own node; a `'link'` failure escalates) cannot call
`return()`, which would throw `Generator is already running` (verified):
the step's next `yield*` finds the node applied and does not run the op
(row 4). In PR 1 rows 1–3 come from PR #4's code through `thenFor`
(`#onDelivery` → `rejectSoon`, a job under no frame, so no body code runs
inside `abort()`; `#marked`; the `exempt` shape with `discardsThrow`), and
a rejection that arrives while the node is applied is the halt; PR 2
moves the rows into the driver (about 30 lines), with the same predicates.

**Decision 8: the halt at each wait.** *Proposed:* PR #4's three shapes,
with `return()` in place of the rejection, decided by the same predicates
(`subscribedBelow`, `strictlyBelow`, and the `completionOf`/`waitsFor`
tests of `release`, `releaseAll`, `close` and `[Symbol.asyncDispose]`):

| The body waits on | PR #4, an async body | A generator body |
| --- | --- | --- |
| `sleep`, `never`, its own `interrupted()`; `join`/`result` of a fiber not subscribed below it; `wait(p, { abandon: true })` (today's `managed(p)`); a `close()` or `[Symbol.asyncDispose]()` of the node itself, an ancestor or an unrelated node (not strictly below, `strictlyBelow` 317; rejection-pin.test.ts 1292), and a `release` or `releaseAll` whose wait includes the node | rejects at the delivery | returned at once (a sleep's timer cleared) |
| `call`, `attempt`, `unshield`, `all`, `race`, `settle`; `join`/`result` of a fiber subscribed below it | rejects when the awaited fiber has completed; a fiber the delivery missed is delivered (`callTask`'s mark, `joinMark`) | returned when the awaited fiber has completed; the same delivery of a missed fiber |
| release work (`release`, `releaseAll`, `close()`/`[Symbol.asyncDispose]()` of a node strictly below, `shield`); `wait(p)`; `wait((signal) => p)` | not rejected: the body resumes and its next managed await rejects | on success, resumed with the value and returned at its next `yield*`; on failure, returned (a release-work failure is not consumed and surfaces at completion, DESIGN §4.12) |
| plain code (delivered during a step) | its next managed await rejects | its next `yield*` of an op not yet started is not run: returned there |
| `wait(p)` yielded after the delivery, including by a body born delivered | a bare await: resumed when `p` settles | as the third row, since `p` started when it was evaluated: subscribed, `p` marked handled; on success resumed and returned at the next `yield*`, on failure returned. With `{ abandon: true }`: `p` marked handled, returned at once. A lifecycle Op yielded then is started too, and rows 1 and 3 decide |

*Alternative:* return at once from every wait, as Effection halts.
*Cost:* a `finally` around `yield* call(t)` (an unlock, a rollback) runs
while the callee still writes, which D39 rejected, and an acquisition in
flight is lost. *Recommended:* the table. It deviates from PR #4 twice,
more narrowly: a failure of a wait the halt let finish is not thrown into
the body, so no `catch` runs after a halt; and an op not yet started that
is yielded after the delivery never starts, where PR #4 starts a `call`
made then, born delivered (rejection-pin.test.ts A.2, line 492). The fifth
row keeps D13's rule that an awaited `managed(p)` marks `p` handled
(`#subscribe`'s `src.then(undefined, noop)`, managed.ts 410): without it a
signalled fetch's `AbortError` would be an unhandled rejection, and law
1's `own(yield* wait(p))` would hold only before the delivery.

In PR 1, with every Op eager (§8), the op at row 4's `yield*` and a
born-delivered body's first op have already started when evaluated: a
`call` made then is a child born delivered, as in PR #4, and the body is
returned at that `yield*`. The "not run" reading of row 4 and of decision 9
holds from PR 2.

**Decision 9: a body born delivered.** *Proposed:* stepped once, to its
first `yield*` of an op that has not started, and halted there without
running it; a `wait(p)` on the way runs as the fifth row (D12 and DESIGN
§4.6 unchanged, "first managed await" read as "first `yield*` of an op not
yet started"); `return()` on an unstarted generator runs no code
(verified), hence the step. *Alternative:* settle it unstarted. *Cost:*
changes D12 and DESIGN §4.6, which D39 declined for calls. *Recommended:*
step once. *Cost:* its synchronous prefix runs for nothing, and may run
past several `wait(p)`s, each bounded by `p`, as PR #4's bare awaits did;
a fork born delivered that runs §1.5's `handle` owns its temp file.

**Decision 10 (decided): `wait(p)` at a halt.** `wait(p)` is today's bare
await: the halt lets `p` finish, and a success resumes the body until its
next `yield*`, so `own(yield* wait(pool.connect()), (c) => c.release())`
attaches the connection. `wait((signal) => p)` hands the work `signal()`,
and its rejection after the halt ends the body. `wait(p, { abandon: true
})` is today's `managed(p)`, which stops waiting at once (D13); the name
`managed` goes. *Rejected:* stopping at once by default, as Effection's
`until` does: the connection is never owned, and a transaction callback
(§4.2) is abandoned mid-unwind, so the node releases the connection during
the rollback, the hazard D39 fixed. *Accepted costs:* a promise that never
settles holds the halted node (`node:stalled`, A8); code between a halted
`wait(p)` and the next `yield*` runs (a debounced
`show(yield* wait(img.decode()))` shows a stale result; guard with
`signal().aborted`, or use `{ abandon: true }`); and the default is the
opposite of Effection's.

### 2.4 Unwinding: a `finally` in the body may wait

After `return()`, every `yield*` is inside a `finally`: a `yield` there
suspends the return, and `return()` reaches helpers' `finally` blocks
through `yield*`, innermost first (verified). **Only the body's own
generator function keeps the halt across such a yield.** By the
ECMAScript `yield*` algorithm, once a delegate's `return()` has yielded,
the caller's next resumption is a normal completion: resumed with
`next()`, the body runs on past the halt; resumed with `return()`, the
rest of the delegate's `finally` is skipped (review probe finally-yield:
`body continued past the halted helper with x=undefined`, then `op
charge`). So the driver runs a finally-yield to completion as **release
work** in the body's frame only (decision 29). Effection's current
contract (frontside.com/effection/AGENTS.md) says "You must not `yield*`
inside a `finally`" ("The halt is lost") and puts waiting cleanup in
`ensure()`; ramme permits it one frame deep, in the body.

**Decision 11: what a halted `finally` addresses.** At a halt the driver
makes an **unwind fiber**, a release fiber of the node (kind `release`,
`observe`, `stack: 'none'`, signal `releaseDeadline(…)`, as `shield`
builds one, node-impl.ts 1586–1593) of its own variant (`unwinding:
true`), the parent of the ops the driver runs from `return()` on. Built
literally as `shield`'s, it would break the rules below: a release fiber
is never an applied awaiter (D39), so `call`'s `take(child)` (1487)
consumes a failure the `finally` catches, which never folds in (review
probe p8: `aborted`, the failure gone, where A.3's `release(tx)` ends
`failure rollback failed`); and routing its final failure as a shield's
(1217) makes the generator's final throw the node's failure (p6: `failure
cleanup threw` where a body's throw gives `aborted`).

*Recommended (U3, the author's preference):* `current()` and every
synchronous verb (`own`, `release`, `releaseAll`, `lookup`, `fork`,
`child`, `pool`, `signal()`) address the unwound node, so a `finally`
behaves the same however it was entered (law 2, I21) and `finally {
yield* release(tx) }` finds the body's entry. Only the ops the driver runs
take the unwind fiber as parent (an op whose receiver is the unwound node
runs on the unwind fiber instead) and its deadline as their signal
(`wait((signal) => p)`). The rules:

- **It runs release work, never interrupted.** The ops' parent is
  undelivered and unsubscribed, so they are not born delivered, and its
  deadline fires and applies nothing (D21). Slow or unbounded work in a
  halted `finally` cannot be cancelled and holds every owner up to the root
  (`node:stalled` reports it; `releaseTimeoutMs` only signals). D39's "a
  swallowed interruption cannot complete more ramme work" becomes "no
  `catch` sees the interruption".
- **Its failures are reported once.** `discardsThrow` (managed.ts 198–200
  in PR 1) is true for an unwinding awaiter, and every resume step takes
  the `applied` flag, as the exempt ones do: `call`, `all` and `race`
  `take(child, !applied)` (1487, 1641, 1686), `join` (1344), `outcomeStep`
  (259–265), `settle`'s member loop (1716). A failure is thrown into the
  generator unconsumed, so a `finally` may catch it and it still folds in:
  `aborted` plus release failures is `failure` (rejection-pin A.3, line
  567). A failed `wait(p)` is recorded on the unwind fiber, so a failed
  ROLLBACK is reported, caught or not; `yield* attempt(t)` returns the
  outcome with the failure unconsumed; a plain `throw` is discarded (D24).
  `shield` keeps A.3's "consumes what it catches" (rejection-pin.test.ts
  953).
- **Its outcome is the body's.** The unwind fiber's body is a source that
  never rejects, resolved when the generator completes; it carries only its
  entries' and unconsumed children's failures, routed to the node once.
  The generator's completion is the node's `onBodyExit`, after the unwind,
  so `classify` gives `aborted` (238), and `heldByUnwindingBody`
  (352–355), D18 and "outcome fixed at settling" keep their meaning. The
  unwind hold sits beside `shieldHolds` (DESIGN §2.4 step 2: "once its
  unwind fiber and every shield it started have completed").

*What U3 costs:* a `fork` in a halted `finally` is born delivered (D12),
as one in PR #4's `catch` is, so concurrent cleanup is `yield* all([…])`,
whose group runs on the unwind fiber; and a synchronous `signal()` handed
to a driver in
cleanup is already aborted, so cleanup that needs a deadline writes
`wait((signal) => fetch(u, { signal }))`. No probe refutes U3: p7's
`NotOwnedError` and empty `releaseAll()` arise only when `release`
addresses the unwind fiber, which U3 does not do, and p6, p8 and p9
concern consumption and throw routing, which U3 keeps; PR 1 re-runs them
against U3 (open question 1). *Alternative (the two-node frame, the former
recommendation):* `current()`, `release`, `releaseAll` and `lookup`
address the node, and `own`, `fork`, `call`, `child`, `pool` and
`signal()` the unwind fiber, through a frame carrying both. *Cost:* two
nodes in one frame; ambient `fork(t)` and `current().fork(t)` differ, as
`signal()` and `current().signal` do. It buys an undelivered `fork` and a
live `signal()` in cleanup. *Alternative (U1):* the node stays current and
its ops exempt. *Cost:* a `call` in the `finally` is born delivered and
halted; only leaf ops work.

**Decision 12: a finally-yield whose wait includes its own node.** Any op
whose wait includes the unwind fiber, the node or an ancestor deadlocks
the unwind (D21): `close()` or `[Symbol.asyncDispose]()` of the node or an
ancestor (`current()[Symbol.asyncDispose]()` included), `release` or
`releaseAll` of such an entry (`root.release(current())`), `join(f)` or
`result(f)` of the node or an ancestor fiber (`completionOf`, 308–310).
*Proposed:* the instruction's `waitsFor` is tested against the unwind
fiber before the op runs, the predicate `HandlerHold.awaits` (377–381)
applies for handlers; the generator is returned at that yield with a
dev-mode warning, as today's uncaught `InterruptedError` ends it there
(rejection-pin.test.ts A.3, line 652). A second `return()` while a
helper's `finally` is suspended skips the rest of that block, and the
outer `finally` still runs and may yield (review probe p9).
*Alternative:* throw a `TypeError` into it. *Cost:* a `finally` may catch
it. *Recommended:* return. *Cost:* in production the rest of that
`finally` is skipped silently.

**Decision 29 (decided): a finally-yield in a helper is not release
work.** Helper cleanup that waits goes in an entry, `own(value, function*
(v) { … })` (a generator release), released with the node; or the helper
runs as `yield* call(helper, …)`, so its `finally` is a body's. The
driver halts with `it.return(HALT)`, a private sentinel, and dev mode
reports a generator that finishes with any other value, naming the body
(a `return` in a `finally` too). An Op's `return()` never suspends the
halt: an Op that needs waiting cleanup (`each` closing its source, §5.2)
hands it to the driver as release work, since it knows it is returning.
*Rejected:* wrapping helper calls in an Op that tracks the return mode, a
wrapper at every call. *Cost:* in production a lost halt runs the rest of
the body as release work; the detector and PR 1's pinning test are the
guard. A lint could flag `yield*` in a helper's `finally`; it is not in
decision 14's list.

Two costs remain. **A halt cuts a normal-path `finally`**: a `finally`
reached by normal completion and suspended on a `yield*` at the delivery
is halted there, and `return()` skips the rest of the block (verified), so
cleanup the design relies on stays an entry (A7). **`await using` is gone
from bodies** (TS2852); sync `using` disposes on `return()` (decision 31).

```ts
// the idiom stays own (the README's UnitOfWork); this shows what a finally in the body may now do
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
bodies of `all`, `race` and `settle` (1612–1736), async today, become
generator bodies that wait with `wait(p, { abandon: true })` (today's
`managedFor`, 1625, 1667, 1671, 1675, 1710): a halt returns them at once
and member failures stay with their holder, where the default `wait(p)`
would let an interrupted `all` consume them (1628–1634) into an
`AggregateError` that `classify` discards (I11). `run(fn)` gains a twin of
`AsyncRunError` (1916–1922) for a returned generator; `armStallTimer`
stays; the driver nulls its one subscription on a halt (A2).

## 3. Consequences

### 3.1 The inventory

Under decisions 18 (no async context), 16 (no bridge), 30 (`promised`), 5
(no async bodies) and 15 (the typed error channel). Line counts are read
from d0bc2f8 and count gross source lines in src/, tests excluded.

| Mechanism | Today | After | Lines |
| --- | --- | --- | --- |
| Async-context adapters | node.ts (30), async-context.ts (61); context-storage.ts `ContextRunner`, `ContextStorage`, `registerContextStorage`, `hasStorage`, `NO_STORAGE_MESSAGE` (47–89), `runDetached`, `captureContext` (125–151); `requireCurrent`'s adapter message (ambient.ts 50–55); index.ts's storage exports (75–76) | the slot, saved, set and restored by `runInFrame` | −165, +10 |
| `ManagedPromise`'s rejection protocol | managed.ts (689): targets (`FreezeTarget` 75–91, `awaitTarget` 548–558); cells and context capture (135–231); stickiness (`#subscribe`'s applied branch, 402–416); call-shaped deferral (`#defers` 520–532, `managedCall` 574–586); the exempt shape (`managedRelease` 588–601); rejection jobs (`interruption`, `rejectSoon`, `#onDelivery`); classification by awaiter (`Cell.foreign`, `checkAwaiter` 177–195, `thenFor` 360–372); the handler's sleep timer; `managedNever`, `managedSleep`, `managedSignal` (618–684) | the driver's halt over node-impl.ts's predicates, which stay; a promise of about 90–200 lines for the eager lifecycle Ops (the resume step, D16's watch, the handler's `waitsFor`) | −490 to −600 net: the ranges named (272 lines) and the 68-line header are read; the other ~350 lines are estimated to shrink to the lifecycle promise, ~90 lines if it is written afresh, ~200 if it keeps the resume-step helpers (233–271) and `thenAsHandler` (433–475) close to their present form |
| `InterruptedError` | resource.ts 68–93; index.ts 66 | the halt is `return()` | −27 |
| Lending, `UnawaitedCallError` | node-impl.ts `CallOp` (92), `HANDLER_MAY_WHILE_LENT` (134–141), `lentTo`/`lender` (570–572), the shield lending in `onBodyExit` (882–889) and `finishCompletion` (1189–1201), `callTask`'s (1547–1560) and `shield`'s (1583–1585, 1599–1603), `assertNotLent` (2015–2041) and its callers, `assertAwaitShaped` (2057–2069); resource.ts 36–46; `node:lent`/`node:returned` (lifecycle-events.ts 40–41) | an unyielded work Op does not run | −113 |
| Async bodies, `managed(p)` | `Body`'s `Promise<T>` arm (context.ts 49); `startBody`'s `ManagedPromise` branch (849–856); `managed` (ambient.ts 253–256, node-impl.ts 1384–1387, context.ts 248) | a `TypeError` (decision 5); `wait` | −15 |
| `gen`, the async `$` | result.ts `Unwrap` (39–46), `$` and `unwrapStep` (196–235), `gen` (237–265), the managed-promise notes in `fromThrowing` | `fail` and a generator `$` (§3.6) | −85 |
| The driver | — | the step loop, halt rows 1–3 over the predicates, the born-delivered step, the lost-halt detector | +150 to +200 |
| Op constructors | today's node methods | a lazy Op per work verb over them; `then` with a known node (§4.1) | +80 to +110 |
| The unwind fiber (U3) | — | the `unwinding` variant, the applied flag in five resume steps, the unwind hold | +30 |
| Ops returned by callbacks | the `instanceof ManagedPromise` sites | `isOp` at four sites (decision 28) | +20 |
| `wait`, `promised` | `managed` | three `wait` forms; `promised`, `ctx.promised` | +55 |
| Expected failures | — | `fail`, `defect`, the four-way `Outcome`, `E` routing, the generator `$` | +50 |
| Body checks | `AsyncRunError` | the async-body `TypeError`; `run`'s twin of `AsyncRunError` | +15 |
| The ES2018 floor (§2.1) | ES2022 output, ES2024 APIs | a local `withResolvers`, the `AggregateError`, `AbortSignal.any` and `AbortSignal.timeout` shims, the disposal-symbol fallback | +35 to +50 |

Kept: the halt predicates (`completionOf`, `strictlyBelow`,
`subscribedBelow`, `joinMark`, 307–344), `heldByUnwindingBody`,
`HandlerHold`, `EarlyAwait` (D16, 396–438: the lifecycle Ops stay eager),
`fire`'s `onApplied` loop (the driver's halt hook), `shieldHolds`,
`unshield`.
Tests: lending.test.ts (632 lines) is deleted; managed.test.ts (1,051),
which fakes `FreezeTarget`, is replaced by driver tests; storage.test.ts
(207) loses its adapter cases; rejection-pin.test.ts (1,438) is
re-expressed in PR 1. The lint package loses four rules (211 lines, 308
test lines) and `isInAsyncFunction` (ast.ts 83–87), keeps four
(`no-stored-borrow`, `no-owned-provider`, `no-timers`,
`no-unused-outcome`) and gains five, two in PR 2 and three in PR 4: nine
rules after, against eight today (§3.4).

### 3.2 Totals, and the "simpler" claim

**Source.** About 900–1,000 lines go (165 + 490–600 + 27 + 113 + 15 +
85 = 895–1,005) and 445–540 come (410–490, plus 35–50 for the ES2018
floor): src/ (5,885 lines, tests excluded) shrinks by about 355–560 lines,
6–10%, the low end if managed.ts's lifecycle promise keeps today's
resume-step helpers and `thenAsHandler` (about 200 lines). managed.ts
falls from 689 lines to about 90–200. The driver and managed.ts's residual are estimates;
the other deletions are read from the files. The first draft's bridge (B1)
would have grown the source by 200–300 lines; the difference is decisions
16 and 18.

**DESIGN.md** falls from 1,871 lines to about 1,630–1,680 (−190 to −240,
−10 to −13%; §3.5). Removed: §4.9 (lending, 31 lines); from §4.2 (343
lines, to about 210–255): sticky rejection, the rejection's timing, the target rule, shapes and the
`Promise` combinators, derived promises, `gen` and `fromThrowing` over
managed promises, foreign code's catch, retry and swallow; from §4.4: the
swallowed interruption, both derived-promise hazards, the foreign-awaiter
warning; from §6 the adapters, from §9 the AsyncContext bullet and `gen`'s
lint paragraph, from §1.2 two entry points.

**Concepts removed** (eleven): (1) bare vs managed awaits, and
`managed(p)`; (2) sticky rejection, every later managed await rejecting
again; (3) `InterruptedError`, and the rule to rethrow it from every
`catch`; (4) classification by awaiter: the target fixed when a promise is
made, "a managed promise belongs to the body that made it", another body's
`FiberAbortedError`, and the dev-mode warning; (5) derived promises and
their two hazards, floating and shared; (6) the `Promise`-combinator rules
(members whose failures are dropped); (7) lending and
`UnawaitedCallError`; (8) async-context propagation: the adapters,
`registerContextStorage`, law 3, A1, D9′; (9) `gen` as a second scope;
(10) `shield` as the place for cleanup that must wait after an
interruption (README's third rule); (11) the `throwIfAborted` rule for a
transaction callback.

**Concepts added** (five): `Op` (with `Operation` and `Instruction` as type
names), `wait`, `promised`, `fail`, `defect`. **Rules added** (two): a
`finally` in the body's own generator may wait and a helper's may not
(decision 29); async code cannot use ambient ramme (`current()`, `lookup`,
the free functions) after an `await`, and reaches ramme only through a
node it names or captured before the first `await` (§4.1, §4.4).
**Kept, reshaped:** D39's three shapes, as the halt table (§2.3); bare vs
managed, as the explicit choice between `wait(p)` and `wait(p, { abandon:
true })`.

The claim holds with a qualification: a body author no longer meets
`UnawaitedCallError`, the swallowed `catch`, the rules for derived
promises and combinators, or an adapter import, but still chooses at every
foreign wait between `wait(p)` and `{ abandon: true }`, learns which waits
a halt lets finish (§2.3), and that only the body's own `finally` may
wait; and plain async code cannot use ambient ramme (`current()`,
`lookup`, the free functions) after an `await`, reaching ramme only
through a node it names or captured before the first `await` (§4.1, §4.4,
§7.4).

### 3.3 `shield` and `unshield`

**Decision 13 (decided): both stay, in tier 2,** for the rare
non-cancellable region in a body that is not a `finally` (`yield*
shield(function* () { yield* call(charge); yield* call(record); })`):
release work, which a halt lets finish. The halted `finally` covers the
common case, so the README's "cleanup that must await goes in `shield`"
goes, and `shield`'s lending with lending. `unshield` (1515–1529: `attempt`
linked to the shield owner's signal) keeps its meaning inside a `shield`;
the unwind fiber is not a shield, so in a halted `finally`, where every
hole would be skipped at once, `unshield` throws its `TypeError`, as
outside any shield. *Rejected:* deleting them, which leaves `try {}
finally { … }` as the only spelling of a non-cancellable region.

### 3.4 Lints

**Decision 14 (decided): the async-only rules are deleted, not moved.**
There is no async profile for them to serve. The package registers eight
rules today (src/index.ts 19–28).

| Rule | Under the proposal |
| --- | --- |
| `no-swallowed-interruption`, `no-finally-in-async`, `no-using-in-async`, `no-promise-combinators` | deleted (211 rule, 308 test lines), with `isInAsyncFunction` (ast.ts 83–87) |
| `no-stored-borrow`, `no-owned-provider` | kept |
| `no-unused-outcome` | kept, extended (PR 2): `yield* attempt(…)`, `yield* settle(…)` and `yield* result(f)` as expression statements discard a failure the outcome consumed (D31); today it flags `attempt` and `settle` alone or under `await` or `void` |
| `no-unused-op` | new (PR 2), syntactic: a work verb as an expression statement, not yielded, awaited or stored (the eager lifecycle verbs are not flagged: `void release(x)` is legitimate); later, a type-aware variant for Ops in variables and arrays (the plugin has no type-aware rule today, and D35 scopes its rules as syntactic) |
| `no-async-body` | new (PR 2): an `async` function passed where a body is expected (`task`, `fork`, `call`, `attempt`, `shield`, `unshield`, `promised`); mostly a type error already (§6), so it is the message for untyped code |
| `no-timers` | kept as a platform rule; extended in PR 4 to `requestAnimationFrame`, `requestIdleCallback`, `scheduler.postTask`, its message naming `nextFrame`/`idle` |
| `no-bare-listener`, `no-bare-fetch` | new platform rules (PR 4; §5.3, decision 26) |
| `no-bare-async-iteration` | new platform rule (PR 4): TS1103 already refuses `for await` in a generator, so it flags a hand-stepped async iterator in a generator function (`yield* wait(it.next())`), which `each` replaces |

The platform rules land with `ramme/platform` (PR 4), since `recommended`
turns every rule on (index.test.ts 33) and a rule whose fix does not exist
yet would flag code PR 2 gives no way to fix.

*Rejected:* a `bridge` config holding the async-only rules (the former
recommendation), and a narrowed `no-swallowed-interruption` kept in
`recommended`: both served async code under a node, which decision 16
removes. Recommended alongside, as `no-floating-promises` is today:
`@typescript-eslint/await-thenable`, for `await helper()` on a generator
helper in top-level and test code (§4.4).

### 3.5 Documents

DESIGN.md, estimated by section (the "simpler" claim and its concept
lists are §3.2):

| Section | Today | After | Change |
| --- | --- | --- | --- |
| §1 intro and sample, §1.1–§1.3 | 63 | ~60 | generator sample; two adapter rows go, `ramme/platform` comes; tier 1 loses `InterruptedError`, gains `wait`, `promised`, `fail` |
| §2.4, §2.6, §2.7, §2.8 | 286 | ~275 | the halt for "unwound by rejection"; a body's `finally` may wait, a helper's may not; `[Symbol.asyncDispose]`'s row loses its `InterruptedError` clause |
| §4.1, §4.2 | 367 | ~235–280 | Ops, the halt table, unwinding (U3), `wait`, `promised`, `shield`, `unshield`, `sleep`; everything listed in §3.2 goes |
| §4.4 | 58 | ~30 | the lost-halt detector and the unconsumed Op come; the four async hazards go |
| §4.5, §4.7, §4.8 | 166 | ~165 | typed `E`; the body guards move here from §4.9; generator handlers |
| §4.9 | 31 | 0 | lending goes |
| §4.12, §4.13 | 186 | ~140 | four statuses; `gen` retired, `$` and `fromThrowing` as fences |
| §6 | 30 | ~25 | the slot and the three entry points |
| platform (new) | 0 | ~40 | §5 |
| §9 | 47 | ~35 | the lint list; typed task failures; the AsyncContext bullet and `gen`'s lint paragraph go |
| §10 | 65 | ~62 | laws 3, 4, 6; I6, I8, I10, I14, I25, I26; A1, A2, A3, A7, A8 |
| the rest (header, §2.1–§2.3, §2.5, §3, §4.3, §4.6, §4.10, §4.11, §5, §7, §8) | 572 | ~565 | "first managed await" read as "first `yield*`"; §7's module table |
| **Total** | **1,871** | **~1,630–1,680** | **−190 to −240 (−10 to −13%)** |

Today is d0bc2f8, read per section. PR 1's interim §4.14 is folded into
these rows by PR 5, which measures against 1,871. The §4.1–§4.2 range is
wide because the new content (Ops, the halt table, U3's unwinding, `wait`,
`promised`, `sleep`) takes about 300 lines in this proposal, and the
passage on `shield`, `unshield` and `sleep` (868–984, 117 lines) is
largely kept.

The outline's target, "DESIGN.md materially shorter", is met: §4.2's
lines on which awaits reject go, where the first draft's B1 would have
moved them to a bridge section (about flat).

Law 3 becomes *the current node is a synchronous slot: valid in a step, in
what a step calls synchronously, in `node.run(fn)` and in a `promised`
body; never after an `await`*. Law 4 becomes *interruption ends a body's
normal path by `return()`; a `finally` in the body's own frame runs as
release work; no `catch` sees it; the outcome is `aborted` by state*, with
its last three sentences kept. Law 6 and I25 become *every asynchronous
hook is a fiber, or a synchronous re-entry of its node through a ramme
wrapper (`listen`, `bind`)*, law 6 keeping "`Symbol.asyncDispose` is the
interop contract". I6 becomes "once a `freeze` or `restore` node is
delivered, its body runs no op it yields on its normal path, except one
already started (§2.3's fifth row); what its own `finally` yields is
release work, never interrupted (D21)". I8's "the unwinding body may still
await release work" becomes "its own `finally` may wait". I10 adds "a work
Op nobody consumes never runs". I14 becomes "every release is a fiber,
current while it runs synchronously or steps". I26 and A1 go; A3 becomes
*the platform is any ES2018 runtime with `AbortController` and
`queueMicrotask`* (the rest shimmed, §2.1); A2 drops the
stored managed promise; A7 drops "invisible to ramme" and "can await only
release work"; A8 reads "pass `signal()` on or yield often enough".

DECISIONS.md completes **D41** (provisional since PR 1; about 250–350
lines, on the precedent of D39's 291 for one change of model), which
supersedes D9′, D11, and D13 and D39 (their body halves become the halt
table); amends D3′ (decision 31) and D38 (`gen` retired, the task
boundary typed); answers D40; and records the costs (unbounded work in a
halted `finally` holds every owner; async code cannot use ambient ramme
after an `await`, and reaches it only through a node it names or captured
before the first `await`). D34's note on the handler timer goes and D35's
lint list changes. Kept in full as history, the superseded entries (D9′
41, D11 29, D13 59, D39 291: 420 lines) leave DECISIONS.md 250–350 lines
longer; reduced to stubs (420 → ~20), it is about 50–150 shorter (PR 5's
choice). README.md's eight rules (258–306) become seven: own it before the work; every wait is
a `yield*` (`wait` lets `p` finish, `abandon` stops waiting); a `finally`
in the body may wait, a helper's may not; a library's async callback is
`promised(function* …)`; pass `signal()` on; release early; `inject` in
constructors, `lookup` in bodies. Its "Foreign code" passage (308–346)
shrinks to §4.2's example. The sample's `import 'ramme/node'` (17) and
"Requires async context propagation" (12) go; "The platform" (348–365)
becomes `ramme/platform` and the browser; "Errors you will meet" loses
`UnawaitedCallError` and `InterruptedError` (371, 376) and its
`NoCurrentNodeError` row its adapter clause; "Expected failures"
(414–455) is rewritten for `fail`; and "Lint" (456–482) takes §3.4's
list.

### 3.6 Expected failures

Today `$` (result.ts 213–227) is a hand-written async iterator and `gen`
(251–265) an async function that never calls `return()` (A7).

**Decision 15 (decided): option (b′).** An expected failure is a **fourth
way for a body to end**, beside `return v`, `throw e` and the halt:
`yield* fail(e)` ends the body with outcome `failure(e)`. The failure is
yielded, so `Failure<E>` enters the generator's yield union and the task
is `Task<A, T, E>` with `E` inferred, never declared; a body with no
`fail` has `E = never`. Propagation is `yield*`: `const user = yield*
call(getUser, id)` is a `User` and re-yields `Failure<UserNotFound>` into
the caller's union, through helpers and tasks alike (Effect's `E` without
`R` or the wrapper; Rust's `?` with inferred unions; verified, §6).
Catching is `yield* attempt(t)`. `Outcome<T, E>` becomes `success(T) |
failure(E) | defect(unknown) | aborted`, the split DESIGN §4.12 states in
prose made a status; `attempt`, `settle` and `result` return it, and
`Fiber<T, E>` carries `E`. An unjoined fork's expected failure is routed
as a defect is, the handler receiving `E | unknown`. `gen` is retired: a
body is the scope. `$` stays as "unwrap a `Result` value I hold" (`yield*
$(r)` is the value, or `fail(r.error)`), `fromThrowing` as the fence that
turns a throw into a `failure` of type `unknown` (it can no longer swallow
a halt), and the data-only `Result` as the interchange type. `all` and
`race` fail on an expected failure, rather than returning it as a value,
exactly as they do on a defect (decided): by D28's rules `all` waits for
every member and reports every failure, and `race` takes the first
success. The decision's "fail fast … as on a defect" is read as naming
that behaviour, since on a defect D28's `all` already waits ("`all` does
not stop at the first failure"); a first-failure `all` would change D28
for defects too, and remains a body that forks with `'link'`.

```ts
const order = task(function* (id: string) {
  const user = yield* call(getUser, id);          // User; a UserNotFound ends this body with it
  return yield* call(getOrder, user);             // Order; or OrderNotFound
}); // Task<[id: string], Order, UserNotFound | OrderNotFound>
```

*Accepted costs:* `Task`, `Fiber` and `Outcome` gain a parameter, visible
in hovers and written signatures; deep graphs accumulate unions and
`mapFailure` them at module boundaries (the Effect experience; tagged
error classes become the convention); `Outcome`'s shape change is
breaking, cheapest now. *What (b′) is not:* adopting Effect: `R` stays
absent because DI is ambient, `Scope` because the tree is, the wrapper
because a body is a plain generator function. *Rejected:* (a) `gen` as the
explicit scope with the task boundary untyped (D38): Effect's syntax
without its main type benefit, and a second scope concept; (b) a body that
may `yield* $(r)`, typed `Task<A, Result<T, E>>`: a `$` in a helper ends
the whole task, so `gen` is still needed, and the value is wrapped.

## 4. Plain async code: three entry points

**Decision 16 (decided): there is no async code under a node.** Plain
async code (top-level code, a test, a framework's entry point, a
library's callback) uses ramme only where it names a node, or where ramme
runs it as a body.

### 4.1 An explicit receiver

`await app.call(main)`, `await using app = createRootContext()`, `return
root.call(handle, req)` in a Workers `fetch` handler. An Op knows its node
when it was made with an explicit receiver or inside a step, and its
`then` runs the verb as a top-level `await` does today: `call`, `attempt`,
`all`, `race`, `settle`, `shield` and `unshield` make their child under
the receiver and settle by its outcome (its error on `failure` or
`defect`, `FiberAbortedError` on `aborted`, `take` 247–253); `join` and
`result` wait for the fiber; `sleep`, `never`, `interrupted` and `wait`
are plain waits. Nothing halts the awaiter, so there is no
`InterruptedError`: `app.abort()` from a signal handler makes a top-level
`await app.call(main)` reject with `FiberAbortedError` once `main` has
unwound, and the surrounding `await using` runs (DESIGN §4.2, 985–990).

**Decision 17 (decided): construction reads the slot.** A free-function
Op is `current().verb(…)` evaluated when it is made: its receiver is fixed
and its guards run then, so outside any step it throws
`NoCurrentNodeError` at construction, and in a creation frame
`CreationViolationError` (DESIGN §3.5, I16 and I18 unchanged). A
module-level `const pause = sleep(50)` is illegal; `sleep(50)` is written
where it is yielded. `yield*` runs an Op for the yielding body, the
awaiter whose halt §2.3 decides; `then` runs it for plain async code.
*Cost:* one frame read per Op. *Rejected:* pure construction, the former
recommendation, which made module-level Ops legal at the cost of
`CreationViolationError` in factories (a factory's `void call(t)` silently
doing nothing) and of a shared Op's run belonging to its first awaiter.

### 4.2 `promised`

**Decision 30 (decided): `promised(body)` is a core verb.**
`promised<A, T>(body: Body<T, A>): (...args: A) => Promise<T>` captures
`current()` when `promised(body)` is evaluated, which must be where the
slot is set, in a step or `node.run(fn)` (elsewhere it throws
`NoCurrentNodeError`, as a free-function Op does, decision 17), and on
each call of the returned function runs `body` as a `call`-shaped child
of the captured node, returning a promise of its result, rejected with
the failure (an expected failure's `E`, or a defect) or with
`FiberAbortedError` on `aborted`. `ctx.promised(body)` names the node,
for module-level entry points (`app.get('/x', root.promised(handle))`).
It is how a library's async callback is written:

```ts
const save = task(function* (order: Order) {
  yield* wait(db.transaction(promised(function* (tx) {   // a child of this node per call
    yield* call(insertOrder, tx, order);
    yield* call(insertLines, tx, order.lines);
  })));
});
```

The halt lets `wait(p)` finish (row 3). The callback's node is a
subscribed child of `save`'s, so the same delivery reaches it: its
generator is halted once `insertOrder` has completed (row 2), its
`finally` blocks run as release work, its promise rejects with
`FiberAbortedError`, the driver rolls back, `p` rejects, and `save` is
returned with no `catch` run, before the node releases its connection. No
`catch` in the callback sees the halt, so the first draft's residue (a
callback that swallows the interruption and lets the driver commit) and
its `signal().throwIfAborted()` rule go. A foreign retry wrapper can still
retry a halted callback; each retry is born delivered (D12) and halted at
its first `yield*`, repeating only the synchronous prefix. Called after
the captured node completed, the function returns a promise rejected with
`NodeCompletedError`. *Cost:* a node per call (~1,650 ns today, §7.2).

### 4.3 `listen` and `node.run`

Synchronous callbacks re-enter a node through the slot: `node.run(fn)`
(1913–1925) for any callback, `listen(target, type, handler)` for a
platform event (decision 21, §5.3), and `bind(fn)` for an observer.
Inside, `lookup`, `own`, `fork`, `child` and `signal()` work, and nothing
waits; a callback that must wait forks a task, as §1.5's
`server.on('request', (req) => app.fork(…))` does.

### 4.4 What async code cannot do

It cannot use ramme after an `await`: the slot is empty there, and
`current()`, `lookup` and every free function throw `NoCurrentNodeError`,
loudly rather than on a wrong node. A node captured before the first
`await` still works through its methods (`const node = current(); await
x; node.fork(t)`): D9′'s half idiom, confined to plain async code. An
async release or failure handler is a bare wait and loses its frame at its
first `await`; an async handler that then awaits its parent's or an
ancestor's completion holds the parent forever, since the handler detach
(`HandlerHold.awaits`) needs the handler frame, while a generator handler
detaches (decision 28). `await getName(id)` on a generator helper
resolves to the generator object, failing only where the value is used
(TS2339, review typing probe), hence `await-thenable` (§3.4); top-level
code runs a helper as `await app.call(function* () { return yield*
getName(id); })`, a node per call (open question 7, `op(fn)`).

### 4.5 Rejected: the bridge, and async context

The first draft kept async code under a node (top-level code, foreign
callbacks, releases and handlers) as **the bridge**. B1, its
recommendation, kept PR #4's rejection model there (managed.ts,
`InterruptedError`, call-shaped deferral, the exemption, classification by
awaiter, the handler's sleep timer, a target fixed at the first `then`),
growing the source by 200–300 lines and keeping DESIGN about flat; B0
reduced it to a thenable whose only interruption was the child's
`FiberAbortedError`. Either needed async context for a callback to find
its node, so `ramme/node` stayed, optional, a forgotten import failing at
the first bridge use, possibly in a rollback callback (the first draft
also measured a per-step `als.run` above the driver's cost). Decisions 16
and 18 remove
both: the async code that mattered under a node is the transaction
callback, which `promised` makes a body, and the top level, which names its
node. The cost is §7.4's.

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
on halt. A callback that expects a promise is the core's `promised`
(§4.2), not a platform verb.

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
| callbacks expecting a promise (Workers `fetch`, Express, test runners, a driver's transaction); process signals | `ctx.promised(handle)` or `promised(function* …)` (core, §4.2), or `return app.call(handle, req)`; top-level `process.once('SIGTERM', () => app.abort())` |

### 5.3 Decisions

| # | Decision | Proposed (recommended) | Alternative: cost |
| --- | --- | --- | --- |
| 19 | Placement | `ramme/platform`, no dependencies, no `node:` imports; `sleep`, `wait` and `promised` stay in the core | the core entry: surface in every import; a package: version skew |
| 20 | `fetch` | a wrapper, `Op<Response>`, `signal: AbortSignal.any([signal(), init.signal])` (A3), its rejection after a halt the halt's echo; cost: shadows a global | `yield* wait((signal) => fetch(u, { signal }))`: noise, a lint must check the signal; Op body methods: surface the signal already covers |
| 21 | The frame a `listen` callback runs in | synchronous, on the node (the slot, as `node.run`): it may `lookup`, `own`, `fork`, `child`, read `signal()`, call `preventDefault()`, not wait. A throw is caught by the wrapper and routed as a `'link'` failure of the node, which aborts it and surfaces at its completion (I11, as C5 does for an owned fiber), never rethrown into the emitter. A generator handler is forked per event with `opts.onFailure`, required when the node is bodiless (D14), or into a pool `listen` owns | a fiber per event: starts in a microtask (D22, I20), too late for `preventDefault()`; an `onError` option on `listen`: later, if needed, defaulting to the same route |
| 22 | `listen`'s removal | both `{ signal: AbortSignal.any([signal(), opts.signal]) }` and an `own` entry removing the listener | `{ signal }` only: a node's signal does not fire at a natural exit or under `close()` (DESIGN §2.4; `onBodyExit` delivers only to subscribers), so it leaks; `own` only: the handler runs between delivery and release |
| 23 | `once`, `on` | `once(target, type)` an Op; `on(target, type)` an async iterable for `each`, buffering as `events.on` does, removed at close | `wait(events.once(em, name, { signal }))`: Node only |
| 24 | `each` | Effection's `for (const x of yield* each(src)) { …; yield* each.next(); }`, with a dev-mode error when `each.next()` is skipped, over an explicit-stepping primitive | a callback form: no `break`, `return` leaves the callback; explicit stepping only: verbose |
| 25 | Observers | a generic `bind(fn)` through decision 21's frame, with `own(obs, (o) => o.disconnect())` | a helper per observer: the surface grows |
| 26 | Lint scope | `no-bare-listener` (with `on*` assignments, `new *Observer(` outside `own`) and `no-bare-fetch` inside generator functions only | everywhere: flags the README's top-level `server.on('request', …)` |

Behind the table: `NodeImpl.run` and `fork` check `assertNotLent` today
(1914, 1470), so decision 21 needs lending gone (PR 2). Its synchronous
re-entry is an asynchronous hook that is not a fiber, hence law 6 and I25
as restated (§3.5), with the wrapper's failure route above (DESIGN §2.8,
"routed or collected"). An event reaching a completed node is dropped by a
live flag, since an `EventEmitter` still calls a listener removed during
the same `emit` (verified). An async generator queues `return()` behind an
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

const app = createRootContext();                                  // no adapter exists; a browser needs none
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
onto bodiless node … with the default 'join' destination` (node-impl.ts
1474–1479): with a bare DOM listener it reaches `window.onerror`; under
decision 21 it is a `'link'` failure that ends `box`. `app.pool({ name:
'search-box', onFailure: showError })` is the other spelling. PR 4 runs
this example as written, in a browser.

## 6. Typing

```ts
type Deferred = PromiseLike<unknown> | Iterator<unknown, unknown, never> | AsyncIterator<unknown, unknown, never>;
type Plain<T> = T extends Deferred ? never : T;
type ErrorOf<Y> = Y extends Failure<infer E> ? E : never;
export type Body<T, A extends unknown[] = []> =
  | ((...args: A) => Generator<Instruction | Failure<unknown>, Plain<T>, unknown>)
  | ((...args: A) => Plain<T>);
declare function task<A extends unknown[], T, Y extends Instruction | Failure<unknown> = never>(
  body: (...args: A) => Generator<Y, Plain<T>, unknown>, opts?: TaskOptions): Task<A, T, ErrorOf<Y>>;
declare function task<A extends unknown[], T>(body: (...args: A) => Plain<T>, opts?: TaskOptions): Task<A, T, never>;
declare function promised<A extends unknown[], T>(body: Body<T, A>): (...args: A) => Promise<T>;
```

- **Inference through `yield*`** (verified, tsc 6.0.3 strict) needs no
  annotations: `task(function* (id: string) { return (yield*
  loadUser.call(id)).name; })` is `Task<[id: string], string>`; a helper
  infers `Generator<Instruction, string, unknown>`; `yield* all([…])` is
  the tuple; `Awaited<Op<User>>` is `User`.
- **`E` is inferred through yielded failures, under two conditions**
  (verified, a scratch probe of §3.6's example: `getUser` is `Task<[id:
  string], User, UserNotFound>`, `order` `Task<[id: string], Order,
  UserNotFound | OrderNotFound>` through `call` and a helper, a body with
  no `fail` `E = never`). The task infers the whole yield union as one
  type parameter and reads `E` off it, D38's pattern: a separate `E`
  parameter takes one candidate and refuses two failure types. And the
  failure brand is disjoint from `Instruction`'s: a `Failure` that is
  structurally an `Instruction` is absorbed, and `E` infers as `never` in
  any body that also yields an ordinary op. The brand lives in a leaf
  module, so `ramme/result`'s `$` stays a leaf (DESIGN §7).
- **The guard is needed.** Without `Plain<T>`, `task(async function* …)`
  passed as a synchronous body and `return loadUser.call(id)` typed as
  `Task<A, Op<User>>`; with it both fail (TS2769), as do an async body and
  a returned generator. The message for an async body is "Type
  'Promise<string>' is not assignable to type 'never'"; a branded guard
  (`T extends Deferred ? 'ramme: a body is function*' : T`) would say what
  to do, and `no-async-body` says it for untyped code.
- **A returned Op: types and runtime disagree.** `task((id: string) =>
  loadUser.call(id))` is TS2769, while decision 28 drives an Op an arrow
  returns and §7.3 has libraries return Ops: `Body` gains an arm, `(...a:
  A) => Operation<Plain<T>>`, as Effection's `() => Operation<T>` is a
  body, or §7.3 is narrowed to `yield*` callers (open question 6).
- **Annotations are optional.** `Operation<number>` on a helper compiles,
  `Op<number>` does not (TS2741), and a recursive helper needs one
  (TS7023). `Instruction` must be exported, or a library helper fails
  declaration emit (TS4058). Construction reading the slot (decision 17)
  changes no type.

| Mistake | Under the proposal |
| --- | --- |
| `await` in a body | TS1308 |
| `for await`, `await using` in a body | TS1103, TS2852 |
| an `async` function as a body | TS2769 (the `Plain<T>` guard); `no-async-body`; a runtime `TypeError` |
| `yield*` of a promise; `yield* sleep` uncalled | TS2488 |
| a forgotten `yield*` whose value is used | TS2739 |
| `yield op`, as a statement or with its value used | TS2769 in a task body, and through any helper `yield*`ed into one (review typing probes n_yop_stmt, n_yop_helper); a helper never passed to a task compiles, and the driver's `TypeError` covers it and untyped code |
| an unyielded `call(…);`, `[1, 2].map(() => sleep(1))` | compiles; `call(…);` caught by `no-unused-op`; the array's Ops only by a later type-aware variant (§3.4) |
| a free-function Op at module level | compiles; `NoCurrentNodeError` at construction (decision 17) |
| `await helper()` on a generator helper, in top-level code | compiles; TS2339 only where the value is used; caught by `@typescript-eslint/await-thenable` |

**Decision 27: names.** *Proposed:* `Operation<T>` (iterable, what helpers
return), `Op<T>` (iterable and, with a known node, thenable, what verbs
return), `Instruction` (an exported type over a private brand); `wait` is
decided (decision 10). *Alternative:* one name, verbs returning
`Operation<T> & PromiseLike<T>`. *Cost:* long hovers. *Recommended:* two
names. The brand is a `Symbol(…)`, not `Symbol.for(…)`, as `TASK` is
(internal-context.ts 87), so A4 (one copy per realm) extends to Ops.

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
| today: a bare `await` in a ramme body, under `ramme/node` | ~28 |
| today: `await managed(Promise.resolve(i))` in a body | ~940 |
| today: `await call(syncTask)` in a body (a node made and completed) | ~1,650 |
| lean driver, `yield*` of a single-shot op | ~51 |
| through 10 delegating helpers | ~497 (~45 per level) |
| synchronous fast path, settled op (S2) | ~19 |

Today's per-wait cost is the `ManagedPromise` protocol (a `Cell`, an
`AsyncLocalStorage.snapshot()` per `then`, a detached reaction, a derived
promise), not propagation. Decision 18 removes async context outright, so
the first draft's per-step `als.run` measurement no longer bears on the
design.

### 7.3 Laziness, iteration, libraries

Laziness turns a forgotten await from a runtime-detected error, where the
work still ran (`UnawaitedCallError`), into silent missing work:
`call(sendEmail, u);` runs nothing until `no-unused-op` reports it, and a
syntactic rule misses Ops in variables. A possible dev-mode check, not
proposed: the driver records the work Ops constructed in each step and
warns at body exit about any never consumed. Third-party async iterables
go through `each` (§5.3); p-limit and p-retry do not compose with Ops.
kilde (D6′) and ramme-native libraries are to return Ops, which serve
bodies through `yield*`. Top-level and test code can `await` them only
when they are made through a node the code names (`lib.query(app, q)`, or
a service whose methods use its own node); a free-function Op made outside
a step throws `NoCurrentNodeError` (decision 17). Otherwise top-level code
writes `await app.call(function* () { return yield* lib.query(q); })`. No
public constructor makes an Op from a generator helper: `op(fn)` would run
`fn`'s generator inline under `yield*`, and under `then` as a child of the
node it was made under, or of a named receiver (`app.op(fn)`); made at top
level with no receiver, it throws like every free-function Op (open
question 7). A bundled second copy of ramme makes Ops the driver
does not recognize (A4).

### 7.4 The lost capability, and migration

**What is lost: sprinkling ramme into existing async code.** Today any
async function running under a node can use ramme after any number of
`await`s, since the async context carries the node: ORM middleware that
awaits a query and
then calls `lookup(Logger)`, a helper three async calls deep that does
`own(…)` or `fork(…)`, a test fixture that awaits and then calls `sleep`.
That is what D9′ was built for. After D41 ramme is usable in a generator
body, in synchronous code a step calls, in `node.run(fn)`, in a `promised`
body and through an explicit receiver; an async function that uses ramme
after an `await` throws `NoCurrentNodeError` there and must become a
generator helper, a `promised` body, or code holding a node captured
before the first `await` (§4.4). Libraries whose hooks are async
(middleware, ORM extensions, test fixtures) reach ramme only that way.

| Async form | Generator form |
| --- | --- |
| `async (…) =>` | `function* (…)` |
| `await <verb>(…)` | `yield* <verb>(…)` |
| `await p`; `await managed(p)` | `yield* wait(p)`; `yield* wait(p, { abandon: true })` |
| `for await (const x of src)` | `for (const x of yield* each(src)) { …; yield* each.next(); }` |
| `await using x = …` | `const x = own(…)` |
| an async callback a library calls | `promised(function* (…) { … })` |
| an arrow capturing `this` | a generator method, or `.bind(this)` |

The table is partially mechanizable: a ts-morph codemod converts the
functions passed to `task`, `fork`, `call`, `attempt`, `shield` and
`unshield`, the generator-eligible helpers they await, an async callback
a body passes to a library (as `promised`), and `async` releases (`own(x,
async (v) => …)`) and failure handlers (`onFailure: async …`) that use
ramme after an `await`, rewritten as generator functions (decision 5);
the rest needs review, since choosing which async functions become
generators is whole-program and type-directed (D35; `await p` → `yield* wait(p)` needs
to know whether `p` is an Op). `this`-capturing arrows and `for await`
with `continue` (which needs `each.next()` on every path) are manual. The
test suite (src/*.test.ts, 20,851 lines in 26 files, every one using async
arrows, about 1,485 of them) passes about 612 inline async bodies to
`task`/`fork`/`call`/`attempt`/`shield`/`unshield`, and 99 lines in 11
files mention `InterruptedError`; PR 1 re-expresses the pinning suite, PR
2 converts the rest.

## 8. Plan

Each PR lands its pinning tests first, then the code.

**Dependencies.** PR 2 needs PR 1. PR 3 needs PR 1's driver (a `fail` is
yielded) and not PR 2, so it may land before or after it. PR 4 needs PR 2:
without an adapter today's `runInFrame` throws (context-storage.ts
154–157), so a browser runs no body until the slot replaces the storage,
and decision 21 needs lending gone (`assertNotLent` in `run` and `fork`,
node-impl.ts 1914, 1470); its names and `listen`'s destination wait on
open questions 4 and 8. PR 5 needs all four.

**Documents between PR 1 and PR 5.** PR 1 starts an interim DESIGN §4.14
and a provisional D41. Each of PRs 2–4 updates §4.14 and marks the
sections it invalidates as superseded, so DESIGN.md never presents a
deleted API as current: PR 2 §1.2's adapter rows, §4.2's rejection
paragraphs, §4.9 and §6; PR 3 §4.12–§4.13; PR 4 the platform section;
§9's lint list in the PR that changes it. PR 5 folds §4.14 into §4 as
§3.5 lays out.

1. **PR 1 (in progress, branch `feat/generator-bodies`): Ops and the
   driver.** `Op` iterable; the node's frame entered around each step
   through today's `runInFrame`, so in PR 1 a generator body needs the
   adapter as an async one does, and the synchronous slot replaces the
   storage in PR 2 (§2.1); the driver running each op in the awaiter's
   frame (`d.opFrame()`) and subscribing through `ManagedPromise.thenFor`
   (§2.1); generator bodies, releases and failure handlers accepted
   alongside async bodies, with decision 28's Op recognition; halt by
   `return()` for generator bodies (§2.3), the halted `finally` as release
   work under U3 (§2.4); `wait`; `promised`; `managed` kept, deprecated in
   its JSDoc. With async bodies still present PR 1 cannot make any work
   verb a lazy `PromiseLike` (review probe p3, with lending present:
   `Promise.all([call(a), call(b)])` turns from a synchronous
   `UnawaitedCallError` into a rejection; D22's order flips; `const p =
   call(x); fork(y)` stops throwing), so every Op stays eager in PR 1: each
   verb returns today's `ManagedPromise` with `[Symbol.iterator]` added,
   started when called, and `yield*` consumes it. Laziness and
   construction reading the slot (decision 17) land together in PR 2. The
   surface grows by five (`wait`, `promised`, `Op`, `Operation`,
   `Instruction`), checked by `check:package`. Documents: DESIGN §4.14
   (interim), §4.5's generator spelling, §1.3's tier table, D41 as
   provisional, and a README "Generator bodies" section. PROPOSAL.md,
   today only on `proposal/generator-runtime`, lands on main with PR 1,
   and D41-provisional links to it there, so PR 5's deletion is real.
   Tests first: §6's type tests; the protocol facts the driver relies on
   (re-entrant and unstarted `return()`, a yield in `finally`, `throw`
   forwarding, a synchronous throw from running an op landing at the
   `yield*`); D22's synchronous `call` start; outcome parity with async
   bodies; PR #4's pinning suite re-expressed for generator bodies,
   asserting event order, never microtask counts: tests 1, 4 (now a
   finally-yield) and 5 with `return()` for the rejection; A.3's 567 as
   `finally { yield* release(tx) }` with a failing rollback, `failure`
   reported once; A.3's 652 with decision 12's return; A.3's 953 for
   `shield`; 2 and 3 as "no `catch` runs; nothing after the halted
   `yield*` runs"; A.2's late call as transitional (a call made in a step
   after the delivery starts born delivered, and the body is returned at
   that `yield*`); 7 (I10) as "a stored, never-yielded Op is never an
   unhandled rejection". New: `yield* call(t)` in a halted `finally` is
   not rejected (U3); review probes p1, p2, and p6–p9 against U3; the
   finally-yield probe with dev mode's report; a `wait(p)` after the
   delivery (a born-delivered `handle` owns its temp file; a signalled
   fetch's `AbortError` is handled); an interrupted `all` whose members
   fail while unwinding reports them once; `promised` (a halted callback
   rejects with `FiberAbortedError` after its `finally` ran; a call after
   the node completed rejects with `NodeCompletedError`).
2. **PR 2: removal.** Async bodies refused (decision 5); `ramme/node`,
   `ramme/async-context` and the storage adapters deleted (decision 18),
   with their `exports` and `sideEffects` entries, and the synchronous
   slot in the storage's place; the ES2018 floor (§2.1); the bridge
   machinery deleted (managed.ts's targets, stickiness, call-shaped
   deferral, exempt shape, rejection jobs, classification and handler
   timer), with `InterruptedError`, lending and `UnawaitedCallError`;
   `managed` removed (decision 10); the driver takes rows 1–3 (§2.3);
   `Op` construction reads the slot (decision 17); every work verb a lazy
   Op, thenable only with a known node (§4.1); `run`'s generator twin of
   `AsyncRunError` (here, since PR 1's specification does not carry it);
   the codemod (§7.4); lints: the four async-only rules deleted with
   `isInAsyncFunction`, `no-unused-outcome` extended to `yield*` and
   `result`, `no-unused-op` (syntactic) and `no-async-body` added (§3.4).
   Tests first: A.2's late call "not started"; 7 as "an unconsumed work Op
   never runs"; row 4 and decision 9 as stated (§2.3). Then, as its own
   green commit, the codemod run over src/*.test.ts while async bodies are
   still accepted, with the manual cases (`this`-capturing arrows, `for
   await`) and the `InterruptedError` expectations rewritten; then the
   removal. The codemod lives in scripts/, with ts-morph as a root
   devDependency, so the published package stays dependency-free. Rewrite
   list: `UnawaitedCallError`'s 21 assertion lines in 8 test files (60
   mentions and 33 assertions in 9 files today; lending.test.ts, with 17
   mentions and 12 assertions, is deleted), the `Promise.all([call…])`
   cases (lending.test.ts 36, fiber.test.ts 1038), D22's order, the ~612
   inline async bodies, managed.test.ts (replaced by driver tests),
   storage.test.ts's adapter cases (44–175; its `NO_NODE` case, 177, stays
   for the slot). The unawaited `release`/`releaseAll`/`close` statements
   (ambient.test.ts 641, 643; creation.test.ts 99, 1002, 1039;
   outcome.test.ts 745; node-core.test.ts 1424) and `.catch` on `close()`
   (node-core.test.ts 153, 188; rejection-pin.test.ts 40) stay valid: the
   lifecycle Ops stay eager promises.
3. **PR 3: expected failures** (decision 15): `fail`, the four-way
   `Outcome` with `defect`, `E` on `Task`, `Fiber` and `Outcome`, `gen`
   retired, `$` over a held `Result`, an unjoined fork's expected failure
   routed as a defect, `all`/`race`/`settle` per §3.6. Tests first: §6's
   inference cases, `attempt` in a halted `finally`, `settle`'s four-way
   tuple. Rewrite list: the outcome and event assertions on thrown errors,
   which become `defect` (up to 81 `'failure'` literals in 12 test files,
   less result.test.ts's `Result` values, which keep `failure`, and
   managed.test.ts's, gone in PR 2); node-impl.ts's 14 `'failure'` sites,
   sorted into the `fail` and defect paths; `gen` removed from
   check-surface's `resultExpected`.
4. **PR 4: `ramme/platform`** (`fetch`, `listen`, `nextFrame`, `each`, then
   the rest of §5.2) and the browser smoke test. Lints: `no-bare-listener`,
   `no-bare-fetch` and `no-bare-async-iteration` added, and `no-timers`
   extended to `requestAnimationFrame`, `requestIdleCallback` and
   `scheduler.postTask`, each message naming its replacement. Tooling: the
   smoke test runs under vitest's browser mode with Playwright (new
   devDependencies; the repo has no browser runner today) as a new gate,
   `pnpm test:browser`; `ramme/platform` gets a package.json `exports`
   entry and a `platformExpected` list in scripts/check-surface.mjs (which
   checks only dist/index.d.ts and dist/result.d.ts today), which also
   asserts that dist/platform.js imports no `node:` module (decision 19).
   Tests first: each platform op's halt, the dropped-event live flag, a
   `listen` handler's throw routed to the node, §5.4 run as written in a
   browser.
5. **PR 5: documents and benchmark.** DESIGN.md and DECISIONS.md rewritten
   (D41 completed; D3′ and D38 amended; D9′, D11, D13 and D39 superseded;
   §4.14 folded into §4) and measured against §3.5; README; A3 rewritten
   (§2.1); PROPOSAL.md deleted from main, its record now in D41. The
   benchmark: mitata on Node 22, 24, 26, Bun and Deno, Effection and
   Effect as references (N waits on a settled op; N synchronous `call`s; a
   request; delegation depth 1, 5, 20; `promised` per call; heap per 10⁵
   suspended fibers). It decides S2 (decision 7).

## Open questions

The author's to decide; the proposal recommends but cannot settle them.

1. **The halted `finally`** (decision 11): U3, as the author prefers and
   this revision recommends, unless PR 1's re-run of p6–p9 against it
   finds a breakage; the two-node frame is the alternative.
2. **A node's `[Symbol.asyncDispose]()`** (decision 32): abort, then wait,
   as today and recommended, or `close()`, a drain.
3. **A second consumption** (decision 3): "`yield*` runs, `then`
   remembers", or one rule for both.
4. **Names** (decision 27, §5): `Op`/`Operation`/`Instruction`, `each`,
   `listen`, a `fetch` that shadows the global.
5. **The normal-path `finally`** (§2.4): whether a halt cutting a
   `finally` reached by normal completion is an acceptable cost.
6. **Whether `() => Operation<T>` is a body** (§6): the runtime drives a
   returned Op (decision 28) while the type refuses it; add the arm, or
   narrow §7.3.
7. **A public `op(fn)`** (§7.3), so generator helpers and service methods
   serve top-level and test code through a named receiver (`app.op(fn)`)
   without `call(function* …)`, a node per call.
8. **The destination of `listen`'s per-event forks** on a bodiless node
   (decision 21): `opts.onFailure` required, or a pool `listen` owns.
9. **What ramme offers over Effection plus a DI layer** once bodies are
   generators (§0.6), and whether that is what users come for.

## Appendix: Review notes

The first draft's review (37 findings, B blocking and A advisory, each
checked against 4310ad3 and, for Effection and npm, against
frontside.com/effection/AGENTS.md and api.npmjs.org on 2026-10-24) was
applied before the author's decisions. Their status now:

- **Stand as applied:** 1, 2, 3, 5, 6, 8, 12, 13, 14, 24 (B) and 9, 10,
  18, 19, 21, 22, 26, 30, 31, 32, 35 (A): the fifth halt row, eager
  lifecycle Ops, the unwind fiber's outcome and consumption, I6/law 4/law
  6/I25 restated, decision 28, ops run in the frame, `onFailure` in §5.4,
  the halt table's and decision 12's sets, the group bodies' `abandon`,
  §6's table, the slot's detached sections, §0.3 and §0.6, a failed
  `wait(p)` in cleanup, decision 10's costs, laziness's cost, the partial
  codemod (counts updated to d0bc2f8).
- **Changed by the author's decisions:** 4 and 15 (U3 now recommended; it
  addresses `release`/`releaseAll` on the node, as 15 required); 7 and 11
  (construction reads the slot, decision 17); 16 (the transitional state
  ends in PR 2); 20 (the benchmark moves to PR 5, which event-order pins
  allow); 23 (decision 29, decided); 17, 25, 33 and 34 (§3.1–§3.5
  recomputed under decisions 5, 15, 16, 18 and 30); 27 (§0.4); 28 (moot:
  a callback is a `promised` generator); 29 (open questions 6 and 7); 36
  (§4.2's transaction example, with no `import 'ramme/node'`); 37 (the
  list revised).
- **Declined in application:** `startBody` tests a brand rather than
  calling `[Symbol.iterator]()` (from 29), since a body may return an
  array; the dev-mode unconsumed-Op check is described, not proposed (from
  32); `ensure` is not a verb (from 23).

The second review (22 findings, R1–R22, 6 blocking, of this revision and
the PR 1 specification) was checked against d0bc2f8 and applied:

- R1 (B, the floor): applied. "Any ES2018 runtime" is stated as decided,
  its costs in PR 2 and §3.1 (+35 to +50); beyond the finding's list,
  `settle`'s `flatMap` (ES2019), the `globalThis` reads (ES2020) and an
  explicit `useDefineForClassFields`; `AbortSignal.any`/`timeout` shimmed
  rather than kept in A3; no open question added. Not carried: "as
  TypeScript's downlevel `using` does", since TypeScript's emitted helper
  throws when the symbol is missing.
- R2 (B, the step's two frames): applied: `d.frame` and `d.opFrame()`, the
  op in the awaiter's frame, the PR 1 pin.
- R3 (B, top-level Ops in §7.3): applied, open question 7 (was 8)
  reworded.
- R4 (A, the `als.run` row): applied; §4.5 marks it as the first draft's.
- R5 (A, the slot in PR 1): applied in part. §2.1's `runInFrame` is marked
  PR 2's form, and PR 1 says it sets the frame through today's
  `runInFrame`, as the PR 1 specification (C.1) has it. Declined: a
  synchronous slot beside the storage in PR 1. Decision 11's "no
  transitional ALS state" is the first draft's optional-storage PR, and
  PR 1 keeps the adapters for async bodies anyway.
- R6 (A, the adapter inventory): applied, with `NoCurrentNodeError`'s
  adapter clause added.
- R7 (A, `no-unused-outcome`): applied: kept, extended to `yield*` and
  `result`; `no-unused-op` new.
- R8 (A, `all`/`race`): applied by closing: "as on a defect" read under
  D28 and stated as decided (§3.6, row 15); open question 3 deleted, 4–10
  renumbered 3–9.
- R9 (A, `promised`'s capture): applied, with `node.run(fn)` beside a
  step.
- R10 (A, the codemod's scope): applied (§7.4, §1.4).
- R11 (A, "at all"): applied in §0.4, §3.2 (twice) and §3.5.
- R12 (B, PR 1's eager Ops): applied (§8, §1.3, §2.3).
- R13 (B, lints by PR): applied, adjusted for R7: nine rules after, not
  eight; the type-aware variant marked as later.
- R14 (B, the `UnawaitedCallError` counts): applied; re-counted 60
  mentions, 33 assertion lines, 21 outside lending.test.ts.
- R15 (A, managed.ts's residual): applied; totals recomputed with R1's
  shims: 895–1,005 lines go, 445–540 come, 355–560 net (6–10%).
- R16 (A, the DESIGN table): applied; the finding's "shield and unshield
  (868–984)" corrected to the passage that also holds `sleep`.
- R17 (A, PR 1 against its specification): applied; `run`'s twin of
  `AsyncRunError` moved to PR 2.
- R18 (A, dependencies, PR 4's tooling): applied; PR 3 waits on no open
  question after R8.
- R19 (A, PR 3's rewrite list): applied, re-counted: 81 `'failure'`
  literals in 12 test files is the ceiling, less result.test.ts's
  `Result` values, which keep `failure`.
- R20 (A, PR 2's commit order, the codemod's home): applied.
- R21 (A, documents between PRs, D41's size): applied; D9′ 41, D11 29,
  D13 59 and D39 291 re-measured.
- R22 (A, PROPOSAL.md not on main): applied with the first option:
  PROPOSAL.md lands on main with PR 1, so D41-provisional's pointer (the
  branch, in the PR 1 specification's F) names main's copy.
