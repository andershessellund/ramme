# eslint-plugin-ramme

ESLint rules for [ramme](https://github.com/andershessellund/ramme#readme).
A ramme body is a generator function that the runtime steps: every wait is a
`yield*` of an op, and an interruption *halts* the body, returning it at the
`yield*` where it waits. Most mistakes are type errors already; these rules
flag what types do not see, or say it better: an `async` function passed as a
body, a work op made and never yielded (it runs nothing), an outcome thrown
away, a platform timer, and a few wiring errors visible in the syntax.

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
on, each as an error:

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

export default [{ plugins: { ramme }, rules: { 'ramme/no-unused-op': 'error', 'ramme/no-timers': 'error' } }];
```

Recommended alongside, both type-aware: `@typescript-eslint/no-floating-promises`,
for a forgotten `await` on a plain promise in top-level and test code, and
`@typescript-eslint/await-thenable`, for `await helper()` on a generator helper
there, which resolves to the generator object (ramme's DESIGN.md §4.14).

## Rules

| Rule | Severity | Flags |
| --- | --- | --- |
| [`no-async-body`](#no-async-body) | error | an `async` function where a body is expected |
| [`no-unused-op`](#no-unused-op) | error | a work op (`call(…)`, `sleep(…)`, …) as a statement, never yielded |
| [`no-unused-outcome`](#no-unused-outcome) | error | `yield* attempt(…)`, `settle(…)` or `result(f)` whose outcome is discarded |
| [`no-timers`](#no-timers) | error | `setTimeout`, `setInterval`, `setImmediate` |
| [`no-stored-borrow`](#no-stored-borrow) | error | a `lookup(…)` result stored in a field, on `this` or in a module variable |
| [`no-owned-provider`](#no-owned-provider) | error | `addProvider(valueProvider(K, x))` for an `x` the node owns |

The four rules of the async era (`no-swallowed-interruption`,
`no-finally-in-async`, `no-using-in-async`, `no-promise-combinators`) are
gone with async bodies: a halt never reaches a `catch`, a body's own `finally`
may wait, and there is no async code under a node (ramme's DECISIONS.md D41,
decision 14).

The severity is the one `configs.recommended` sets. Section numbers below are
those of ramme's
[DESIGN.md](https://github.com/andershessellund/ramme/blob/main/DESIGN.md)
(§) and [DECISIONS.md](https://github.com/andershessellund/ramme/blob/main/DECISIONS.md) (D).

### no-async-body

**Flags** an `async` function, `async` arrow or `async function*` that is the
first argument of `task`, `fork`, `call`, `attempt`, `shield`, `unshield`,
`promised` or `bind`, free or as a method (`ctx.call(…)`, `pool.fork(…)`,
`root.promised(…)`), written inline or named by an identifier whose
declaration in the file is one (a function declaration, or a `const` whose
initializer is one).

**Why.** ramme steps a body's generator and halts it by returning it at the
`yield*` where it waits; it cannot see an `await` (D41). An async function is
therefore no body: `Body`'s type refuses it, and the runtime fails the node
with a `TypeError` naming `function*`. Write it as a generator, run every op
with `yield*`, and wait for a foreign promise with `yield* wait(p)` (§4.14):

```ts
const handle = task(function* (req: Request) {   // instead of task(async (req) => …)
  const user = yield* call(loadUser, req.id);
  return yield* wait(render(user));
});
```

**Approximations.** A release or a failure handler may still be `async` (a
bare wait, current only until its first `await`), so `own(x, async …)` and
`onFailure: async …` are not flagged. Not flagged: a body reached through a
`let`, an import, a parameter or a property; a method named like a verb on
another object (`fn.call(async () => …)` is flagged, as `call`).

### no-unused-op

**Flags** a call of a work verb (`call`, `attempt`, `all`, `race`, `settle`,
`shield`, `unshield`, `join`, `result`, `sleep`, `interrupted`, `never`,
`wait`), free or as a method (`app.call(…)`, a task's `t.call(…)` and
`t.attempt(…)`), as an expression statement or under `void`: a free one inside
a function, a method one anywhere, module level included (an explicit receiver
needs no current node, so `app.call(main);` at the top of a script runs
nothing). `fork(…)` and the lifecycle verbs (`release`, `releaseAll`, `close`)
are not flagged: they are eager. Nor are the platform's methods of those names:
`Promise.all`, `Promise.race` and `Atomics.wait` on the globals, and
`Function.prototype.call` where the syntax shows it: through a prototype
(`Array.prototype.forEach.call(nodes, f)`), with a `this`-argument of `this`,
`null`, `undefined`, `void …` or `globalThis`, on a receiver the file declares
as a function (or a parameter typed as one), and on a receiver the file does not
show to be ramme's (a global, an untyped parameter, a property) whose first
argument is no task or body (`handler.call(self, e)`).

**Why.** A work op is lazy: making one runs nothing, and its consumer runs it,
the driver at `yield*` or `then` at `await` (D41, decision 2). `call(sendEmail,
user);` sends nothing. A forgotten `yield*` is missing work, silent at run
time; this rule is its report (§4.14).

```ts
const signup = task(function* (user: User) {
  yield* call(sendEmail, user);   // instead of call(sendEmail, user);
});
```

**Approximations.** Syntactic: an op kept in a variable or an array and never
yielded (`const op = call(t);`, `[1, 2].map(() => sleep(1))`) is not flagged;
a type-aware variant would see those. A free op at module level is not
flagged: no node is current there, so it throws `NoCurrentNodeError` when made.
Whether `x.call(…)` is ramme's is read from `x`'s declaration and the first
argument: an import, a variable made by `task`, `bind`, `createRootContext`,
`current`, `child` or `pool`, and a parameter typed `Task`, `Context` or
`Pool` are ramme's, and so is any receiver whose first argument is a function,
a `task(…)`, or a name bound to one or imported. So a dropped `t.call(x)` on an
untyped parameter `t`, with an `x` that is none of those, is not flagged, and
`handler.call(self, e)` on an imported `handler` is: write that one
`Reflect.apply(handler, self, [e])`.

### no-timers

**Flags** calls of `setTimeout`, `setInterval` and `setImmediate`, bare or
through `globalThis.`, `window.` or `global.`, when the file does not declare
the name itself; and named imports of those three from `timers`,
`node:timers`, `timers/promises` and `node:timers/promises`, reported once, at
the import. `queueMicrotask` and the `clear…` functions are allowed.

**Why.** A timer is a foreign wait (§4.14): a body waiting on one through
`yield* wait(p)` is let finish by a halt, so its node, and everything the
node holds (a connection lease, say), stays alive for the rest of the timer;
and nothing clears a timer when the node that set it ends (§4.4). ramme's
`sleep(ms)` is a wait the halt cuts: the body is returned at once and its
timer cleared (D34). Where no node is current the free `sleep` throws
`NoCurrentNodeError`; use `ctx.sleep(ms)` on a node you hold. For repetition,
`fork` a task that loops on `yield* sleep(ms)`: it ends with its node.

```ts
own(fork(function* () {
  for (;;) {
    yield* sleep(1_000);            // instead of setInterval(tick, 1_000)
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
const tx = own(yield* wait(db.begin()));
current().addProvider(valueProvider(Tx, tx));      // flagged
yield* call(work.with({ providers: [valueProvider(Tx, tx)] }));  // fine: a new node
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

**Flags** `attempt(…)`, `settle(…)` and `result(…)`, free or as a method, run
and their outcome discarded: `yield* attempt(t);` or `await attempt(t);` as an
expression statement, under `void` too.

**Why.** `attempt`, `settle` and `result` deliver a failure as a value and
consume it (§4.5, §4.8, §4.12). An outcome nobody reads is a failure dropped
silently, where `call`, `all` or `join` would have thrown it (D31). Use those,
or read the outcome. The op alone (`attempt(t);`) runs nothing:
`no-unused-op` reports that.

**Approximations.** Any method named `attempt`, `settle` or `result` matches,
ramme's or not. Not flagged: an outcome stored and never read
(`const r = yield* attempt(t)`; `no-unused-vars` catches the unused variable),
or passed to something that ignores it.

## Not covered

- A `yield*` in a helper's `finally` loses the halt: the body runs on past it
  as release work (D41, decision 29). Syntax could flag it; it is not in this
  package yet. ramme's development mode reports a lost halt.
- An async function that uses ramme after its first `await` (an `async`
  release, a library callback) throws `NoCurrentNodeError` there; write it as
  a generator release or a `promised(function* …)` callback (§4.14).
- The hazards that depend on what happens at run time (a lost halt, a late
  read that creates a value, a stalled halted `finally`) are ramme's
  development-mode diagnostics and `node:stalled` (§4.4).

## Development

The package lives in ramme's repository, `packages/eslint-plugin-ramme`.
`pnpm check:plugin` at the repository root runs its typecheck, lint, tests
and build. It has no ESLint config of its own: ESLint looks the config up
from each linted file, so the root `eslint.config.js` lints the package.
