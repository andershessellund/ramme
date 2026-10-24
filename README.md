# ramme

**One tree for services and work.** Dependency injection, structured
concurrency and resource lifetimes in one structure: a node's position in
the tree answers both *what it may depend on* and *when it dies*. Ancestors
outlive descendants, and you only ever resolve from ancestors, so nothing
you can resolve dies before you do.

*Ramme* is Danish for frame: scoped resolution is literally "inden for
rammerne af", within the frame of.

Zero dependencies. Requires async context propagation (below).

## Sixty seconds

```ts
import 'ramme/node'; // once, at startup: carries the current node across await
import { createRootContext, task, all, lookup, own, inject, signal } from 'ramme';

class Config {
  readonly apiUrl = 'https://api.example.com';
}

class Api {
  readonly #base = inject(Config).apiUrl;          // a dependency, declared where the service is built
  readonly #pool = own(openPool(this.#base));      // released with the service, never before its users

  async get(path: string): Promise<unknown> {
    const res = await fetch(this.#base + path, { signal: signal() });   // the running task's signal
    return res.json();
  }
}

const fetchUser = task(async (id: string) => lookup(Api).get(`/users/${id}`));
const fetchOrders = task(async (id: string) => lookup(Api).get(`/users/${id}/orders`));

const profile = task(async (id: string) => {
  const [user, orders] = await all([fetchUser.bind(id), fetchOrders.bind(id)]);
  return { user, orders };
});

await using app = createRootContext();
console.log(await app.call(profile, '42'));
```

What the example shows:

- **A task is a definition; each run is a node.** `task(body)` is not
  callable. `call` runs it in a new child node and awaits it; `fork` runs it
  concurrently; `all` runs several and returns the tuple, and `race` runs
  several and returns the first success. `fetchUser.bind(id)` is the same
  task with its arguments fixed, the form `all` and `race` take. Whatever a
  run attached is released when it finishes, however it finishes.
- **`lookup` borrows, `inject` depends.** Inside a running task,
  `lookup(Api)` resolves from the current node. In a constructor (or a
  factory), `inject(Config)` declares a dependency of the value being built.
  `Api` has no provider, so the class is its own default factory: it is built
  on first use and placed as deep in the tree as its dependencies require,
  here at the root.
- **Acquisition is ownership.** `own(x)` attaches `x` (an `AsyncDisposable`
  or `Disposable`) to the current node, which releases it. In a constructor
  that node is the service's own, so the pool lives exactly as long as `Api`.
- **Nothing is threaded through.** `signal()`, `lookup`, `own`, `fork` act on
  the *current node*, which the platform carries across `await`.
- **Shutdown lives on the root.** `await using app` releases the whole tree:
  running work first, then the services it used. `app.abort()` interrupts
  the tree without waiting, and `await app.close()` lets running work
  finish before releasing.

## A request

```ts
import { createInjectionKey, valueProvider, task, call, lookup, own } from 'ramme';

const Conn = createInjectionKey<Connection>('Conn');

const handle = task(async (req: Request, res: Response) => {
  const db = lookup(Connections);                   // your connection pool: a service, shared, outlives every request
  const lease = own(await db.acquire());            // returned to the pool when the handler ends
  return call(task(() => work(req), { providers: [valueProvider(Conn, lease.conn)] }));
});

server.on('request', (req, res) =>
  app.fork(handle.with({ name: req.url, signal: req.signal, onFailure: (e) => respond500(res, e) }), req, res));
```

- `Connections` is the application's own class, a service like `Api`
  above; its `acquire()` returns a lease that can be released.
- `work(req)` is a plain function. It runs in the call's node and reads the
  connection with `lookup(Conn)`.
- The server's callback runs outside any node, so it names one:
  `app.fork(...)` attaches the handler to the root. This is the only place a
  node is passed explicitly. `handle.with({...})` is the same task with
  options for this use: a `name`, a `signal` that interrupts it, and
  `onFailure`, where its failure goes.
- When the client hangs up, `req.signal` interrupts the handler: its next
  *managed await* rejects with `InterruptedError`, and so does every one
  after it, so the handler unwinds; then the lease goes back to the pool. A
  managed await is an `await` on a promise ramme returned (`call`, `join`,
  `all`, `race`, `release`, `sleep`, …); `await fetch(...)` is not one,
  which is why you pass `signal()` on, and a timer is one only as
  `await sleep(ms)` ([DESIGN.md
  §4.2](DESIGN.md#42-sticky-rejection-and-managed-awaits-d13-d39)). An
  interruption is not a failure, so `onFailure` is not called.
- If `work` throws, `onFailure` gets the error once.

## Services that hold state

A service is placed as deep as its dependencies require, so one whose
fields inject only root-level things is shared by the whole application.
That is right for a stateless service and wrong for state. A service that
holds state for one session, one request or another unit declares its
scope:

```ts
import { createScope, inject } from 'ramme';

const SessionScope = createScope('session');

class SessionCache {
  static readonly scope = SessionScope;              // one per session, whatever it injects
  readonly #config = inject(Config);
  readonly #entries = new Map<string, unknown>();
  get(key: string): unknown { return this.#entries.get(key); }
}

const session = app.child({ scopes: [SessionScope] });   // lookup(SessionCache) below it is this session's
```

The value is stored on the nearest node that carries the scope. Leave
stateless and derived services undeclared. For a class you do not own,
`setScope(TheirClass, SessionScope)` declares it from outside; a token
takes `createInjectionKey(name, { scope })`.

A unit of work that commits or rolls back with its request is a
per-request service whose release reads the request's outcome through
`parent`, the node that stores it:

```ts
import { RequestScope, current, inject, lookup, own, signal, task } from 'ramme';

class UnitOfWork {
  static readonly scope = RequestScope;
  readonly #node = current();                     // this value's own node; its parent is the request's node
  readonly #lease = inject(DbPool).acquire();     // a synchronous acquire(owner = current()): owned by #node, returned after the commit
  constructor() {
    own(this, () => {
      const o = this.#node.parent!.outcome;       // how the request ended
      if (o === undefined) return this.#node.signal.aborted ? this.rollback() : this.commit();   // done(), or this unit aborted early
      return o.status === 'success' ? this.commit() : this.rollback();
    });
  }
  done(): Promise<void> { return this.#node.release(this); }   // commit now, while the request runs
  query(sql: string) { return this.#lease.conn.query(sql, signal()); }
  async commit(): Promise<void> { … }
  async rollback(): Promise<void> { … }
}

const handle = task(async (req: Request) => {
  await lookup(UnitOfWork).query('…');            // every lookup in this request shares one
}, { scopes: [RequestScope] });                   // the request's own fiber carries the scope
```

The request's fiber must carry `RequestScope`, as `handle` does, so that
its outcome is how the request ended. A bodiless
`child({ scopes: [RequestScope] })` reports how it was ended, not how its
work ended: under `await using` every unit of work on it rolls back, and
after `close()` every one commits, even when a `call` on it failed and the
error was caught ([DESIGN.md §2.6](DESIGN.md#26-ownership)).

### Tests and overrides

A provider lives where it is registered: `valueProvider`, `factoryProvider`
and `classProvider` store their value on the node you give them to (in
`providers`, or with `addProvider`), whatever the key declares as its
scope. A child or a task that provides a key overrides it for everything
below, a request's unit of work included. To replace a service with one
that keeps a lifetime of its own, alias the key to it: `aliasProvider`
redirects, so the replacement is placed by its own declaration.

```ts
import { aliasProvider, createRootContext } from 'ramme';

class FakeSessionCache {
  static readonly scope = SessionScope;               // the fake declares its lifetime too
  readonly reads: string[] = [];                      // a test-only member is fine
  get(key: string): unknown { this.reads.push(key); return undefined; }
}

await using app = createRootContext({ providers: [aliasProvider(SessionCache, FakeSessionCache)] });
// below each session, lookup(SessionCache) is that session's own FakeSessionCache
```

A provider is checked against the key's public members (`Public<T>`): the
fake needs `SessionCache`'s `get`, with its type, and cannot have its
`#entries`, so it needs no cast. Since a fake is not an instance of the
class, code should not test an injected service with `instanceof`.

For a seam with no class of its own, declare an interface and a token of
the same name whose default is the implementation. Call sites read
`inject(Mailer)` exactly as they would a class key, and a test or another
environment provides its own:

```ts
import { createInjectionKey, inject, valueProvider } from 'ramme';

export interface Mailer {
  send(to: string, body: string): Promise<void>;
}
export const Mailer = createInjectionKey<Mailer>('Mailer', { factory: () => inject(SmtpMailer) });

class Signup {
  readonly #mailer = inject(Mailer);                  // the same call site as a class key
}

const sent: string[] = [];
await using test = createRootContext({
  providers: [valueProvider(Mailer, { send: async (to) => void sent.push(to) })],
});
```

## Fork now, join later

```ts
const report = task(async (id: string) => {
  const audit = fork(writeAudit, id);      // concurrent, in its own node
  const data = await call(buildReport, id);
  await join(audit);                        // its value, or its failure thrown here
  return data;
});
```

A fiber is not a promise: `await audit` throws. Use `join(f)` for the value
or `result(f)` for the outcome (`success` / `failure` / `aborted`). A fork
you never join is interrupted when its parent's body returns, and its
failure, if any, surfaces from the parent. It is never an unhandled
rejection.

Something that repeats is a fork that loops on `sleep`:

```ts
const session = task(async (user: User) => {
  fork(async () => {
    for (;;) {
      await sleep(30_000);                  // an interrupted loop stops here: its timer is cleared, the sleep rejects
      await call(sendHeartbeat, user);
    }
  });
  await call(serve, user);                  // when serve returns, the heartbeat is interrupted
});
```

In a body, `await sleep(ms)` is the timer to use: a bare `setTimeout` is
not a managed await, so an interrupted body waiting on one keeps its node,
and everything attached to it, until the timer fires. Outside any node,
`app.sleep(ms)` is a plain delay.

## The rules

- **Own it before the work.** Anything that must be undone is attached with
  `own(...)` and released by its node, however the body ends. An interrupted
  body is unwound, so its `finally` does run, but ramme cannot see what a
  `finally` (or a `using` / `await using` inside an async body) cleans up,
  and inside one every managed await other than release work rejects again.
  Keep invariants in `own`. `await using` for the root at the top level is
  fine.
- **A `catch` can see your own interruption: rethrow it.** After an
  interruption, every managed await of the body rejects with
  `InterruptedError`. Swallowing it gets you nowhere: the next managed await
  rejects again, and the task's outcome is `aborted` whatever it returns.
  Write `if (e instanceof InterruptedError) throw e`, or branch on outcomes
  with `attempt` and `settle` and keep `catch` for translating errors.
  Awaiting other work that was interrupted throws `FiberAbortedError`
  (below), which is a real error of yours to handle. One exception: a promise
  another task's code made and shares with yours (a memoized loader's cached
  promise, a batched load) carries *that* task's `InterruptedError` when it
  is interrupted. `signal().aborted` tells your own, so where tasks share
  such promises write `if (e instanceof InterruptedError && signal().aborted)
  throw e`, and handle the other as a failed load.
- **Cleanup that must await goes in `shield`.** After an interruption only
  release work still completes: `release(x)`, `releaseAll()`, `close()` or
  `[Symbol.asyncDispose]()` of a node below your task, and
  `shield(async () => …)`, which runs its body to the end (its `signal()` is
  the release deadline) and hands you its result. Inside a `shield(…)` your
  task's own body opens, `await unshield(step)` runs the one step your
  task's interruption should still stop, skips it if that interruption
  already came, and hands you its outcome (`aborted` then) instead of ending
  the shield; elsewhere it follows the node the shield runs on (`ctx` for
  `ctx.shield`, and for a shield nested in another the outer one, which
  only the release deadline stops).
- **Await every `call`.** A forgotten await is detected: the next
  body-shaped operation in that body (`lookup`, `fork`, `call`, `join`, …)
  throws `UnawaitedCallError`. `own`, `release`, `abort` and `close` stay
  allowed, so they do not reveal it. Use `all([...])` for concurrent calls.
- **Await derived promises at once.** An async helper, a `Promise`
  combinator, a `.then` chain or a `gen(…)` over a managed await rejects
  when the task is interrupted. Stored and awaited later, it is an unhandled
  rejection in the meantime. Await it where you make it, or combine with
  `all()`.
- **Release early whenever you like.** `await release(x)` runs `x`'s release
  now, exactly once.
- **Pass `signal()` on to `fetch` and drivers; use `sleep` for timers**, so
  work stops promptly when interrupted.
- **`inject` in constructors, `lookup` in bodies.** `lookup` throws during
  creation and `inject` throws outside it. Don't store a `lookup` result on
  anything that outlives the current task.

**Foreign code.** A library's code runs inside your task, in its async
context, so ramme cannot tell it from yours. A driver's transaction callback
(Prisma's `$transaction`, Knex's or Drizzle's `transaction`; with
node-postgres, which has no callback API, your own `withTx(client, fn)`
helper) around a `call` that is interrupted sees the rejection, so its
`finally` commits or rolls back as it would on any error, after the call
has completed. The same holds around a `join` of a task you forked, and a
connection your task got from a `child()` scope is still open then: the
scope is released after your task has unwound. Around a `join` of an owned
fork (`own(fork(t))`), or a `managed(p)`, the `finally` runs at once while
that work goes on, so hand a driver call inside a transaction or a mutex
`signal()`.

Three more things to know about libraries:

- A retry wrapper that retries on any error retries the interruption too.
  Every attempt's managed awaits are rejected again, but the retried task's
  plain work, such as a driver write not handed `signal()`, still runs to its
  end each time: a non-idempotent write is repeated once per attempt. Give
  such helpers, and the writes inside them, `signal()`, and watch for
  `node:stalled`.
- A helper that swallows errors inside a transaction callback (a
  `safe(() => …)` returning a fallback) lets the rest of the callback run, and
  the driver then commits half a transaction. End every transaction callback
  with `signal().throwIfAborted()`, or any managed await, so an interrupted
  callback always rejects into the rollback.
- Cleanup that awaits a driver with no timeout of its own (a `ROLLBACK` on a
  dead connection) holds your task, and `await using app` shutdown with it,
  for as long as it hangs: `releaseTimeoutMs` does not reach a task's own
  code. Give such cleanup a driver-level timeout.

```ts
const save = task(async (order: Order) => {
  await withTx(db, async (tx) => {               // its finally runs on interruption, after the call completed
    await call(insertOrder, tx, order);
    signal().throwIfAborted();                   // if anything above swallowed an interruption, still no COMMIT
  });
});
```

## Generator bodies

A body may also be a generator function, where every wait is a `yield*`.
This is where ramme is heading (DECISIONS.md, D41): async bodies still work
in this release, and both kinds need the platform setup below
(`import 'ramme/node'`). In a generator body an interruption never arrives as
an error. ramme *halts* the body by returning it at the `yield*` where it
waits: no `catch` runs, every `finally` does, and a `finally` in the body
itself may wait, as release work that runs to its end:

```ts
import { call, own, task, wait } from 'ramme';

const transfer = task(function* (from: Id, to: Id, amount: number) {
  const conn = own(yield* wait(pool.connect()), (c) => c.release()); // halted while connecting: still owned
  yield* wait(conn.query('BEGIN'));
  let done = false;
  try {
    yield* call(debit, conn, from, amount);        // halted here: debit stops and completes first
    yield* call(credit, conn, to, amount);
    yield* wait(conn.query('COMMIT'));
    done = true;
  } catch (e) {
    throw translate(e);                            // a real failure of debit or credit, never the interruption
  } finally {
    if (!done) yield* wait(conn.query('ROLLBACK'));  // runs to its end; a failed ROLLBACK is reported
  }
});
```

Every ramme operation (`call`, `all`, `sleep`, `join`, …) is `yield*`ed in
a generator body and `await`ed in async code. A foreign promise is
`yield* wait(p)`: the halt lets `p` finish, so what it produced can still be
owned, and `wait(p, { abandon: true })` stops waiting at once instead.
`wait((signal) => fetch(url, { signal }))` hands the work the task's
signal. A library that calls you back with an async function gets
`promised(function* …)`, which runs your generator as a child of the current
task and hands the library a real promise:

```ts
import { call, promised, task, wait } from 'ramme';

const save = task(function* (order: Order) {
  yield* wait(db.transaction(promised(function* (tx) {   // a child of this task per call
    yield* call(insertOrder, tx, order);
    yield* call(insertLines, tx, order.lines);
  })));
});
```

Interrupted mid-way, the callback is halted once `insertOrder` has stopped,
its promise rejects, the database driver rolls back, and only then is `save`
itself halted and its resources released. No `catch` in the callback can
swallow the interruption, so nothing can let the database driver commit.

## The platform

ramme needs the platform's async context to carry the current node across
`await`. Import an adapter once at startup:

| Import | Runtime |
| --- | --- |
| `ramme/node` | `AsyncLocalStorage`: Node ≥ 22, Bun, Deno, Cloudflare Workers (`nodejs_compat`) |
| `ramme/async-context` | TC39 `AsyncContext`, where it ships |

Without one, every operation that needs the current node (the free
functions, bodies, factories, releases) throws `NoCurrentNodeError`, and the
message names the import. Code that only names nodes (`createRootContext()`,
`root.child()` to make a child node, `node.own(x)` to attach `x` to a named
node) does not need it and runs, so a missing import
can first show up when a body, a factory or a release runs, as late as
shutdown. Import the adapter before anything else.

## Errors you will meet

| Error | Means |
| --- | --- |
| `NoCurrentNodeError` | A free function ran outside any task, or no adapter is imported. |
| `UnawaitedCallError` | A `call` was not awaited before the body used its node again. |
| `CreationViolationError` | `lookup` (or `call`) inside a constructor or factory, or `inject` outside one. |
| `NodeCompletedError` | A node, or a service, was used after it was released. |
| `FiberNotAwaitableError` | `await fiber`: use `join(fiber)` or `result(fiber)`. |
| `FiberAbortedError` | `join` / `call` / `all` / `race` of work that was interrupted, by code that is not itself interrupted (top level, a platform callback, or a body whose own node was not aborted). |
| `InterruptedError` | Your own task was interrupted: every managed await it makes now rejects with this. Rethrow it. Through a promise another task made and shared with yours (a cached load), it is that task's interruption: then your `signal().aborted` is not set, unless your task was interrupted too. |

To branch on how work ended instead of catching, `attempt` is `call` that
resolves with the outcome, and `settle` is `all` that resolves with every
task's outcome instead of rejecting (both wait for every task, and neither
cancels the others when one fails):

```ts
const r = await attempt(fetchPrices.with({ timeoutMs: 500 }), sku);
if (r.status === 'failure') throw r.error;                             // a real failure stays a failure
const prices = r.status === 'success' ? r.value : cachedPrices(sku);   // 'aborted': the 500 ms ran out

const [user, orders] = await settle([fetchUser.bind(id), fetchOrders.bind(id)]);
if (orders.status === 'failure') log(orders.error);                    // all would have rejected; user is still here

let quote = await attempt(fetchQuote, sku);
for (let i = 0; quote.status === 'failure' && i < 3; i++) {
  await sleep(100 * 2 ** i);                                           // back off; an interrupted caller is rejected here
  quote = await attempt(fetchQuote, sku);
}
```

`aborted` means the task's own abort (its `timeoutMs` or `signal`, or an
explicit abort), the abort of the context it runs in (`ctx.attempt(…)`), or,
for a `settle` member, `settle`'s own `timeoutMs` or `signal`: a body that
is itself interrupted is rejected at `attempt` or `settle` with
`InterruptedError`, as at `call`, once the task has stopped; its own
interruption never comes back as an outcome. The
exception is a task declared `interrupt: 'restore'` inside a shutdown-aware
body (`interrupt: 'observe'`, DESIGN.md §4.3), whether that body is the
caller or encloses it: the body's shutdown reaches the task without stopping
the caller, and comes back as `aborted`. A shutdown-aware caller sees its
own shutdown in `signal().aborted`; a caller inside one does not, so a
deadline fallback there checks that the reason is a `TimeoutError`
`DOMException`, which is what `timeoutMs` delivers. A failure delivered as a
value is yours to look at; ignore `status` and the error is gone, which is
why `call` stays the default.

## Expected failures

A failure the caller is meant to branch on (no such user, a declined card)
is a return value, not a throw: a `Result`, `{ status: 'success', value }`
or `{ status: 'failure', error }`, in the words an outcome uses. Anything
thrown is a defect: let it fail the task, and translate it where the work
is handed over (`attempt`, `onFailure`), not in the middle of the domain
code. `ramme/result` is optional, and any `{ status, value | error }`
object of the shape works with it. Its `gen` and `$` are the `?` operator:

```ts
import type { Result } from 'ramme';
import { $, gen, success } from 'ramme/result';

class UserNotFound extends Error { readonly name = 'UserNotFound' as const; }
class OrderNotFound extends Error { readonly name = 'OrderNotFound' as const; }

// getUser(id): Promise<Result<User, UserNotFound>>; getOrder(user): Promise<Result<Order, OrderNotFound>>
const r = await gen(async function* () {
  const user = yield* $(getUser(id));       // the user, or the run ends here with the failure as its result
  const order = yield* $(getOrder(user));
  return success(order);
});
// r: Result<Order, UserNotFound | OrderNotFound>
if (r.status === 'failure') return notFound(r.error);
```

TypeScript compares types by structure, so error classes need a
distinguishing member, like the literal `name` above, to stay separate in
the inferred union. `unwrap(r)` is the named conversion to a defect: the
value, or the error thrown. Await or return `gen(…)` at once: it is an
ordinary async function, so a dropped `gen(…)` whose body throws is an
unhandled rejection, and so is a stored one when the task is interrupted,
since the `InterruptedError` propagates out of `gen` (it never becomes a
`Result`). `@typescript-eslint/no-floating-promises`, which needs
type-aware linting (`recommendedTypeChecked`, or
`parserOptions.projectService`), flags a bare `gen(…)` statement, but not
`void gen(…)` or an awaited `gen` whose `Result` is discarded. The other
helpers (`map`, `andThen`, `orElse`, `collect`, `fromThrowing`, …) and how
`gen` behaves when the body is interrupted are in [DESIGN.md
§4.13](DESIGN.md#413-results-and-gen-d38).

## Lint

An ESLint plugin, `eslint-plugin-ramme` (ESLint 9 or later, flat config),
checks what syntax can see of the rules above:

```sh
pnpm add -D eslint-plugin-ramme
```

```js
// eslint.config.js
import ramme from 'eslint-plugin-ramme';
import tseslint from 'typescript-eslint';

export default [...tseslint.configs.recommended, ramme.configs.recommended];
```

`ramme.configs.recommended` reports a `catch` in an async function that can
swallow the task's own `InterruptedError`, `setTimeout` and its siblings, a
`lookup` result stored on an object or in a module variable, a value
provided on the node that owns it, and a discarded `attempt` or `settle`;
and it warns on `finally` and `using` in async functions and on `Promise`
combinators, which work but which ramme cannot see or structure. Some rules
are stricter than ramme itself: a top-level `Promise.all` is flagged too.
The [plugin's README](packages/eslint-plugin-ramme/README.md) says what each
rule flags, why, and where it is approximate.

## Documentation

- [DESIGN.md](DESIGN.md): the model, the guarantees, and how each mechanism
  works, including the second tier for resource and library authors (pools,
  shutdown-aware tasks, release deadlines, lifecycle events).
- [DECISIONS.md](DECISIONS.md): why it is this way and not another way.

## License

Apache-2.0
