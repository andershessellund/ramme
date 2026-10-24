# eslint-plugin-ramme

ESLint rules for [ramme](https://github.com/andershessellund/ramme#readme).
Inside a ramme body, `finally`, `using`, timers and `Promise` combinators look
like plain JavaScript and behave differently, and a few wiring errors are
visible in the syntax. These rules flag them where they are written.

The rules are syntactic: they need no type information and work on
JavaScript and TypeScript alike. They recognize ramme's functions by name
(`lookup`, `own`, `attempt`, …), not by where they were imported from, and
each has known approximations, listed below. Where a rule has to choose, it
is stricter than ramme's design; an inline disable with a reason marks a
case that is fine.

## Install

```sh
pnpm add -D eslint eslint-plugin-ramme
```

ESLint 9 or later, flat config. The plugin has no runtime dependencies.

## Configure

`configs.recommended` registers the plugin as `ramme` and turns every rule
on as an error:

```js
// eslint.config.js
import ramme from 'eslint-plugin-ramme';
import tseslint from 'typescript-eslint';

export default [
  ...tseslint.configs.recommended, // or any other config that parses your files
  ramme.configs.recommended,
];
```

To pick rules yourself:

```js
import ramme from 'eslint-plugin-ramme';

export default [{ plugins: { ramme }, rules: { 'ramme/no-timers': 'error', 'ramme/no-finally-in-async': 'error' } }];
```

Recommended alongside: `@typescript-eslint/no-floating-promises`
(type-aware), for a forgotten `await` on a plain function call, which ramme
cannot see (ramme's DESIGN.md §4.9).

## Rules

| Rule | Flags |
| --- | --- |
| [`no-finally-in-async`](#no-finally-in-async) | a `finally` in an async function |
| [`no-using-in-async`](#no-using-in-async) | `using` / `await using` in an async function |
| [`no-timers`](#no-timers) | `setTimeout`, `setInterval`, `setImmediate` |
| [`no-promise-combinators`](#no-promise-combinators) | `Promise.race`, `.any`, `.allSettled`, `.all` |
| [`no-stored-borrow`](#no-stored-borrow) | a `lookup(…)` result stored in a field, on `this` or in a module variable |
| [`no-owned-provider`](#no-owned-provider) | `addProvider(valueProvider(K, x))` for an `x` the node owns |
| [`no-unused-outcome`](#no-unused-outcome) | a discarded `attempt(…)` or `settle(…)` |

Section numbers below are those of ramme's
[DESIGN.md](https://github.com/andershessellund/ramme/blob/main/DESIGN.md)
(§) and [DECISIONS.md](https://github.com/andershessellund/ramme/blob/main/DECISIONS.md) (D).

### no-finally-in-async

**Flags** a `try` with a `finally` block lexically inside an `async`
function, method or arrow, async generators included, unless a non-async
function or a class static block lies in between.

**Why.** ramme interrupts a body by freezing it at its next managed await:
the await never settles and the body never resumes (§4.2, D13). A `finally`
around that await never runs, in the body or in a plain async function it
called that is suspended on the body's await. Cleanup that must happen
belongs to the node, as an entry: `own(() => …)` runs whether the body
returned, threw or was frozen (§2.6, assumption A7).

```ts
const job = task(async () => {
  const lock = await mutex.lock();
  own(() => lock.release());       // instead of try { … } finally { lock.release() }
  await call(work);
});
```

**Approximations.** Every async function counts as a body. A `finally` in
async code that ramme never freezes is flagged too: a release callback, an
`interrupt: 'observe'` body, a `[Symbol.asyncDispose]` method, an async test
callback, and a `try` whose block contains no `await`. A sync callback inside
an async function is not flagged, which is right: plain code cannot be
frozen.

### no-using-in-async

**Flags** `using` and `await using` declarations, `for (await using …)`
included, inside an `async` function, method or arrow, unless a non-async
function lies in between. Module level is not flagged.

**Why.** A `using` declaration's disposal runs when its block exits: it is a
`finally` in disguise, and a frozen body never runs it (§2.6). Attach the
resource with `own(…)`. `await using app = createRootContext()` at module
level, for the root, is the intended use and is not flagged.

**Approximations.** As for `no-finally-in-async`: every async function counts
as a body. A root in an async test callback (`test('…', async () => { await
using app = createRootContext(); … })`) is flagged though the callback is
top-level code, not a body; disable it there with a reason.

### no-timers

**Flags** calls of `setTimeout`, `setInterval` and `setImmediate`, bare or
through `globalThis.`, `window.` or `global.`, when the file does not declare
the name itself; and named imports of those three from `timers`,
`node:timers`, `timers/promises` and `node:timers/promises`, reported once, at
the import. `queueMicrotask` and the `clear…` functions are allowed.

**Why.** A timer is a bare await, not a managed one (§4.2). A `freeze` body
waiting on a timer is not frozen by an interruption while the timer runs,
so its node, and everything the node holds (a connection lease, say), stays
alive for the rest of the wait; and nothing clears a timer when the node
that set it ends (§4.4). ramme's `sleep(ms)` is a managed await whose timer
is cleared at the interruption (D34). Where no node is current the free
`sleep` throws `NoCurrentNodeError`; use `ctx.sleep(ms)` on a node you hold.
For repetition, `fork` a task that loops on `await sleep(ms)`: it ends with
its node.

```ts
own(fork(async () => {
  for (;;) {
    await sleep(1_000);             // instead of setInterval(tick, 1_000)
    tick();
  }
}));
```

**Approximations.** Timers are flagged wherever they are, in code that is
not a body as well (a script's top level, a platform callback, a library's
internals); use `ctx.sleep`, or disable with a reason. Not flagged: a timer
reached through an alias (`const t = setTimeout`), passed as a value
(`promisify(setTimeout)`), imported as a namespace or default
(`import timers from 'node:timers'`), or `scheduler.wait` from
`timers/promises`.

### no-promise-combinators

**Flags** `Promise.race`, `Promise.any`, `Promise.allSettled` and
`Promise.all`, called or referenced (`Promise.all.bind(Promise)`), when
`Promise` is the global.

**Why.** A combinator resumes the awaiting body on its own terms. It can
resume a body while one of its managed promises is still pending, so that a
later interruption counts a running body frozen and releases its node under
it; and it can consume a member's failure that a frozen body then never
sees (§4.2, D13). ramme's `all`, `race` and `settle` run tasks as members of
a group node, which joins them itself, and the body awaits that one group
(§4.8).

```ts
const [user, orders] = await all([fetchUser.bind(id), fetchOrders.bind(id)]);   // instead of Promise.all
```

**Deliberately stricter than the design.** DESIGN.md §4.2 supports a
`Promise.all` that fulfils, over managed promises whose resume step consumes
nothing unless it throws (`join`, `call`, `close()`, `release(x)`). Syntax
cannot tell that one from one that rejects, nor managed members from bare
ones, so the rule flags every combinator. Its known false positives:

- the supported fulfilling `Promise.all` over managed members;
- a combinator whose members are all bare
  (`Promise.all(urls.map((u) => fetch(u, { signal: signal() })))`);
- top-level code, where nothing freezes.

For these, disable the line with a reason:

```ts
// eslint-disable-next-line ramme/no-promise-combinators -- top level: no body freezes here
const outcomes = await Promise.all(fibers.map((f) => app.result(f)));
```

**Approximations.** Not flagged: a combinator reached through an alias
(`const { all } = Promise`) or through `globalThis.Promise`.

### no-stored-borrow

**Flags** a `lookup(…)` call, or a property read on one (`lookup(X).y`), as
a class field initializer (instance or static, an auto-accessor
`accessor x = …` included), as the right side of an assignment to
`this.<prop>` (`=`, `??=`, …), as the default of a TypeScript parameter
property (`constructor(private readonly db = lookup(Db))`), or as the
initializer of a module-scope variable.

**Why.** `lookup` returns a borrow: it is guaranteed to live as long as the
current node, and no longer (§3.2, D4′). Stored on an object, it can outlive
the node it was borrowed for, and a use after its release fails far from
where it was stored, at best loudly (§2.7). What an object keeps is a
dependency: `inject` it in the constructor or a field, which places the
object where its dependencies live (§3.3). A service that needs borrows for
its own lifetime keeps `#ctx = current()` and reads through it (§3.2).

**Approximations.** `lookup` is recognized as a free call by name; `ctx.get(…)`
is not checked. Not flagged: a borrow stored through a local
(`const db = lookup(Db); this.db = db`), assigned to a module variable later
(`x = lookup(X)` inside a function), stored on another object, in a
collection or a closure, or the result of a call on a borrow
(`lookup(X).create()`).

### no-owned-provider

**Flags** `<expr>.addProvider(valueProvider(K, x))` (`current().addProvider`,
`ctx.addProvider`, …) where `x` is an `own(…)` or `<ctx>.own(…)` call, or a
variable whose initializer, in the same function, is one:

```ts
const tx = own(await db.begin());
current().addProvider(valueProvider(Tx, tx));      // flagged
await call(work.with({ providers: [valueProvider(Tx, tx)] }));   // fine: a new node
```

**Why.** This is the wiring error of DESIGN.md §2.5. The value is owned by
the node's explicit stack; values built from the provider are placed on the
same node's provided stack, which is released after the explicit stack
(§2.4, D16), so they outlive the resource they use. Provide it on a new node
instead, with `providers:` on `call`, `child` or `task.with`: that node ends
inside the owner's lifetime. `providers:` options are never flagged.

**Approximations.** Only `valueProvider`, and only those two shapes of `x`.
Not flagged: an owned value reached through a member
(`valueProvider(K, lease.conn)`) or assigned after its declaration
(`let tx; tx = own(…)`); a value a producer attached before returning it
(§2.6); `factoryProvider`, `classProvider` and object-literal providers. The
rule does not compare the node that owns `x` with the node that receives
`addProvider`: `const x = a.own(y)` followed by
`b.addProvider(valueProvider(K, x))` is flagged. ramme has only the method form of `addProvider`; a free
`addProvider(…)` call is not checked.

### no-unused-outcome

**Flags** `attempt(…)`, `settle(…)`, `<x>.attempt(…)` and `<x>.settle(…)` as
an expression statement, alone or under `await` or `void`.

**Why.** `attempt` and `settle` deliver a failure as a value and consume it
(§4.5, §4.8, §4.12). An outcome nobody reads is a failure dropped silently,
where `call` or `all` would have thrown it (D31). Use `call`, or read the
outcome.

**Approximations.** Any method named `attempt` or `settle` matches, ramme's
or not. Not flagged: an outcome stored and never read
(`const r = await attempt(t)`; `no-unused-vars` catches the unused variable),
or passed to something that ignores it.

## Not covered

- A named async function passed to `fork` or `call` (`fork(parse)`) compiles
  and is not flagged. ramme accepts inline bodies by design (§4.5), and the
  `Task` type already catches a bare function where only a task is accepted
  (`all`, `race`, `settle`); the named case stays an open gap (D8′, D35).
- The hazards that depend on what happens at run time (an await shape that
  misfired, a managed promise awaited by another body, a late read that
  creates a value) are ramme's development-mode diagnostics (§4.4).

## Development

The package lives in ramme's repository, `packages/eslint-plugin-ramme`.
`pnpm check:plugin` at the repository root runs its typecheck, lint, tests
and build. It has no ESLint config of its own: ESLint looks the config up
from each linted file, so the root `eslint.config.js` lints the package.
