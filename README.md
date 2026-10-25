# ramme

**One tree for services and work.** Dependency injection, structured
concurrency and resource lifetimes in one structure: a node's position in
the tree answers both *what it may depend on* and *when it dies*. Ancestors
outlive descendants, and you only ever resolve from ancestors, so nothing
you can resolve dies before you do.

*Ramme* is Danish for frame: scoped resolution is literally "inden for
rammerne af", within the frame of.

Zero dependencies. Node 22+ or an evergreen browser ([below](#the-platform)).

## Sixty seconds

```ts
import { createRootContext, task, all, lookup, own, inject, wait } from 'ramme';
import { fetch } from 'ramme/platform';

class Config {
  readonly apiUrl = 'https://api.example.com';
}

class Api {
  readonly #base = inject(Config).apiUrl;          // a dependency, declared where the service is built
  readonly #pool = own(openPool(this.#base));      // released with the service, never before its users

  *get(path: string) {                              // an operation: yield* api.get(…)
    const res = yield* fetch(this.#base + path);    // an op: interrupting the task aborts the request
    return yield* wait(res.json());
  }
}

const fetchUser = task(function* (id: string) { return yield* lookup(Api).get(`/users/${id}`); });
const fetchOrders = task(function* (id: string) { return yield* lookup(Api).get(`/users/${id}/orders`); });

const profile = task(function* (id: string) {
  const [user, orders] = yield* all([fetchUser.bind(id), fetchOrders.bind(id)]);
  return { user, orders };
});

await using app = createRootContext();
console.log(await app.call(profile, '42'));
```

What the example shows:

- **A body is a generator function; every wait is a `yield*`.** `call`,
  `all`, `sleep` and the rest return an *op*, which `yield*` runs and
  waits for; a foreign promise is `yield* wait(p)`. An op runs when it is
  yielded, so `call(t);` without the `yield*` does nothing (a lint catches
  it). Outside a body, `await app.call(profile, '42')` runs one on a node you
  name.
- **A task is a definition; each run is a node.** `task(body)` is not
  callable. `call` runs it in a new child node and waits for it; `fork` runs
  it concurrently; `all` runs several and returns the tuple, and `race` runs
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
  the *current node*, which ramme sets while a body runs, on every platform:
  no setup, no async context.
- **Shutdown lives on the root.** `await using app` releases the whole tree:
  running work first, then the services it used. `app.abort()` interrupts
  the tree without waiting, and `await app.close()` lets running work
  finish before releasing.

## A request

```ts
import { createInjectionKey, valueProvider, task, call, lookup, own, wait } from 'ramme';

const Conn = createInjectionKey<Connection>('Conn');

const handle = task(function* (req: Request, res: Response) {
  const db = lookup(Connections);                   // your connection pool: a service, shared, outlives every request
  const lease = own(yield* wait(db.acquire()));     // returned to the pool when the handler ends
  return yield* call(task(() => work(req), { providers: [valueProvider(Conn, lease.conn)] }));
});

server.on('request', (req, res) =>
  app.fork(handle.with({ name: req.url, signal: req.signal, onFailure: (e) => respond500(res, e) }), req, res));
```

- `Connections` is the application's own class, a service like `Api`
  above; its `acquire()` returns a lease that can be released.
- `work(req)` is a generator helper (`function* work(req) { … }`). It runs in
  the call's node and reads the connection with `lookup(Conn)`.
- The server's callback runs outside any node, so it names one:
  `app.fork(...)` attaches the handler to the root. This is the only place a
  node is passed explicitly. `handle.with({...})` is the same task with
  options for this use: a `name`, a `signal` that interrupts it, and
  `onFailure`, where its failure goes.
- When the client hangs up, `req.signal` interrupts the handler: ramme
  *halts* it, returning it at the `yield*` where it waits, once the call it
  waits on has stopped too; no `catch` sees that, every `finally` runs, and
  then the lease goes back to the pool. An interruption is not a failure, so
  `onFailure` is not called.
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
import { RequestScope, current, inject, lookup, own, signal, task, wait } from 'ramme';

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
  done() { return this.#node.release(this); }     // commit now, while the request runs: yield* uow.done()
  query(sql: string) { return this.#lease.conn.query(sql, signal()); }
  async commit(): Promise<void> { … }
  async rollback(): Promise<void> { … }
}

const handle = task(function* (req: Request) {
  yield* wait(lookup(UnitOfWork).query('…'));     // every lookup in this request shares one
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
const report = task(function* (id: string) {
  const audit = fork(writeAudit, id);       // concurrent, in its own node
  const data = yield* call(buildReport, id);
  yield* join(audit);                       // its value, or its failure passed on here
  return data;
});
```

A fiber is not a promise: `await audit` throws. Use `join(f)` for the value
or `result(f)` for the outcome (`success` / `failure` / `defect` /
`aborted`, below). A fork
you never join is interrupted when its parent's body returns, and its
failure, if any, surfaces from the parent. It is never an unhandled
rejection.

Something that repeats is a fork that loops on `sleep`:

```ts
const session = task(function* (user: User) {
  fork(function* () {
    for (;;) {
      yield* sleep(30_000);                 // an interrupted loop is halted here, its timer cleared
      yield* call(sendHeartbeat, user);
    }
  });
  yield* call(serve, user);                 // when serve returns, the heartbeat is interrupted
});
```

In a body, `yield* sleep(ms)` is the timer to use: a bare `setTimeout` is
one no interruption clears, so a body waiting on one keeps its node, and
everything attached to it, until the timer fires. Outside any node,
`await app.sleep(ms)` is a plain delay.

## Waiting, and what an interruption does

An interruption *halts* a body: ramme returns its generator at the `yield*`
where it waits. No `catch` sees it, every `finally` runs, and nothing after
that `yield*` does; the task's outcome is `aborted`, whatever it then does.
When the body is returned depends on what it waits on: at once for a
`sleep`, a `never()`, an owned fork's `join`; once the awaited work has
stopped for a `call`, an `all`, a `join` of a fork it made; and after it
finishes for a release or a foreign promise. A `finally` in the body itself
may wait, and what it waits on runs to its end, so cleanup can wait for a
rollback:

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

A foreign promise is `yield* wait(p)`: the halt lets `p` finish, so what it
produced can still be owned, and `wait(p, { abandon: true })` stops waiting
at once instead. `wait((signal) => driver.query(sql, { signal }))` hands the
work the task's signal (for `fetch`, `yield* fetch(url)` from
`ramme/platform` does it for you). A library that calls you back with an
async function gets `promised(function* …)`, which runs your generator as a
child of the current task and hands the library a real promise:

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

## The rules

- **Own it before the work.** Anything that must be undone is attached with
  `own(...)` and released by its node, however the body ends. ramme cannot
  see what a `finally` cleans up, and an interruption that halts a
  `finally` reached by normal completion cuts it short, so keep invariants
  in `own`. `await using` for the root at the top level is fine.
- **Every wait is a `yield*`.** Run ramme's ops with `yield*`
  (`yield* call(t)`, `yield* sleep(ms)`): an op you make and do not yield
  runs nothing. Wait for a foreign promise with `yield* wait(p)`, which an
  interruption lets finish, or `wait(p, { abandon: true })`, which it stops
  waiting for. Run concurrent work with `all([...])`.
- **A `finally` in the body may wait; a helper's may not.** What the body's
  own `finally` yields after an interruption runs to its end. A `yield*` in
  the `finally` of a generator helper the body called loses the
  interruption, and the body runs on (development mode reports it): put
  waiting cleanup in `own(value, function* (v) { … })`, or run the helper as
  `yield* call(helper)`.
- **A library's async callback is `promised(function* …)`.** Plain async
  code has no current node after its first `await`: `lookup`, `own` and the
  other free functions throw there. Reach ramme from plain async code
  through a node you name (`await app.call(main)`), `promised`, or
  `node.run(fn)` for a synchronous callback.
- **Use `ramme/platform` for the platform; pass `signal()` on to drivers; use
  `sleep` for timers**, so work stops promptly when interrupted:
  `yield* fetch(url)`, `listen(target, type, handler)`, `yield* nextFrame()`
  and `each(source)` ([below](#the-platform)), and
  `wait((signal) => driver.query(sql, { signal }))`.
- **Release early whenever you like.** `yield* release(x)` runs `x`'s release
  now, exactly once.
- **`inject` in constructors, `lookup` in bodies.** `lookup` throws during
  creation and `inject` throws outside it. Don't store a `lookup` result on
  anything that outlives the current task.

**Foreign code.** A driver's transaction callback is a `promised` body, as
above: interrupted, it is halted once its work has stopped, and the driver's
own `finally` rolls back before your task releases what the driver
borrowed. Two more things to know about libraries:

- A retry wrapper that retries on any error retries a halted callback: each
  retry starts already interrupted and is halted at its first `yield*`,
  repeating only the code before it. Keep writes behind a `yield*`.
- Cleanup that waits for a driver with no timeout of its own (a `ROLLBACK`
  on a dead connection) holds your task, and `await using app` shutdown with
  it, for as long as it hangs: `releaseTimeoutMs` only signals. Give such
  cleanup a driver-level timeout, or hand it the deadline:
  `yield* wait((signal) => conn.query('ROLLBACK', { signal }))`.

## The platform

Node 22+ or an evergreen browser, with nothing to import or register: the
current node is a slot ramme sets while a body runs, on every platform.
ramme needs ES2022 syntax and four runtime APIs, `Promise.withResolvers`,
`AbortSignal.any`, `AbortSignal.timeout` and the disposal symbols
(`Symbol.dispose`, `Symbol.asyncDispose`); it defines the two symbols itself
where they are missing and polyfills nothing else, so on an older runtime
polyfill the other three.

Every platform primitive that waits or calls back has a ramme spelling,
because waiting is where an interruption stops a task and calling back is
where the current node is lost. `ramme/platform` has four, and imports nothing
from Node:

- `yield* fetch(input, init)`: the global's `fetch` as an op, handed the
  task's signal, so interrupting the task aborts the request.
- `listen(target, type, handler)`: an `EventTarget` or an emitter (`on`/`off`);
  the handler runs inside the node that registered it (`lookup`, `own` and
  `fork` work there; nothing waits, so fork a task for work that does), and is
  removed when that node ends. A throw from it ends the node, never the
  emitter. Each call is its own registration, as an emitter's `on` is: unlike
  `addEventListener`, listening twice with the same handler runs it twice.
- `yield* nextFrame()`: the next animation frame's timestamp, its frame
  cancelled if the task is interrupted (a 16 ms timer where there are no
  frames).
- `for (const x of yield* each(source)) { …; yield* each.next(); }`: `for
  await` for a body; leaving the loop, or an interruption, returns the source.

A search box, in a browser:

```ts
import { createRootContext, fork, task, sleep, wait, type Fiber } from 'ramme';
import { fetch, listen } from 'ramme/platform';

const search = task(function* (q: string) {
  yield* sleep(200);                                               // debounce: a newer keystroke stops this run here
  const res = yield* fetch(`/search?q=${encodeURIComponent(q)}`);  // or aborts its request here
  show(yield* wait(res.json()));
});

const app = createRootContext();
const box = app.child({ name: 'search-box' });
let latest: Fiber<void> | undefined;
box.run(() =>
  listen(input, 'input', () => {                                   // runs inside box; removed when box ends
    latest?.abort();
    latest = fork(search.with({ onFailure: showError }), input.value); // box has no body to join it: name a handler
  }),
);
```

`await using` ends a node the way an exception would, by interruption; to
drain, call `close()`. That holds for the root at the top level and for any
node a test scopes with it.

## Errors you will meet

| Error | Means |
| --- | --- |
| `NoCurrentNodeError` | A free function ran outside any task: at top level, or in plain async code after its first `await`. |
| `CreationViolationError` | `lookup` (or `call`) inside a constructor or factory, or `inject` outside one. |
| `NodeCompletedError` | A node, or a service, was used after it was released. |
| `FiberNotAwaitableError` | `await fiber`: use `join(fiber)` or `result(fiber)`. |
| `FiberAbortedError` | `join` / `call` / `all` / `race` of work that was interrupted, by code that is not itself interrupted (top level, a platform callback, or a body whose own node was not aborted). Your own interruption is no error: it halts your task. |
| `TypeError` naming `function*` | An `async` function was passed as a body: write it as `function*`. |

To branch on how work ended instead of catching, `attempt` is `call` that
resolves with the outcome, and `settle` is `all` that resolves with every
task's outcome instead of rejecting (both wait for every task, and neither
cancels the others when one fails):

```ts
const r = yield* attempt(fetchPrices.with({ timeoutMs: 500 }), sku);
if (r.status === 'defect') throw r.error;                              // a real failure stays a failure
if (r.status === 'failure') return yield* fail(r.error);               // and an expected one stays expected
const prices = r.status === 'success' ? r.value : cachedPrices(sku);   // 'aborted': the 500 ms ran out

const [user, orders] = yield* settle([fetchUser.bind(id), fetchOrders.bind(id)]);
if (orders.status === 'defect') log(orders.error);                     // all would have thrown; user is still here

let quote = yield* attempt(fetchQuote, sku);
for (let i = 0; quote.status === 'defect' && i < 3; i++) {
  yield* sleep(100 * 2 ** i);                                          // back off; an interrupted caller is halted here
  quote = yield* attempt(fetchQuote, sku);
}
```

`aborted` means the task's own abort (its `timeoutMs` or `signal`, or an
explicit abort), the abort of the context it runs in (`ctx.attempt(…)`), or,
for a `settle` member, `settle`'s own `timeoutMs` or `signal`: a body that
is itself interrupted is halted at `attempt` or `settle`, as at `call`, once
the task has stopped; its own interruption never comes back as an outcome.
The
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
is yielded, not thrown: `yield* fail(e)` ends the task at once with it, and
the task's type says so. Anything thrown is a defect: let it fail the task,
and translate it where the work is handed over (`attempt`, `onFailure`), not
in the middle of the domain code.

```ts
import { attempt, call, fail, task, wait } from 'ramme';

class UserNotFound extends Error { readonly name = 'UserNotFound' as const; }
class OrderNotFound extends Error { readonly name = 'OrderNotFound' as const; }

const getUser = task(function* (id: string) {
  const user = yield* wait(db.findUser(id));
  if (user === undefined) return yield* fail(new UserNotFound(id));
  return user;
});                                               // Task<[id: string], User, UserNotFound>

const getOrder = task(function* (id: string) {
  const user = yield* call(getUser, id);          // the user, or this task ends here with UserNotFound
  const order = yield* wait(db.findOrder(user));
  if (order === undefined) return yield* fail(new OrderNotFound(id));
  return order;
});                                               // Task<[id: string], Order, UserNotFound | OrderNotFound>

const handle = task(function* (req: Request) {
  const r = yield* attempt(getOrder, req.params.id);
  if (r.status === 'success') return json(r.value);
  if (r.status === 'failure') return notFound(r.error);   // r.error: UserNotFound | OrderNotFound
  if (r.status === 'defect') throw r.error;               // a bug stays a bug
  return unavailable();                                   // 'aborted': interrupted
});
```

No `catch` sees a `fail`, and the task's `finally` blocks still run. Write
it as `return yield* fail(e)`: TypeScript does not narrow after a `yield*`,
so `return` is what tells it that `user` is defined below the check.
`call`, `join`, `all` and `race` pass a child's expected failure on to the
caller, and its type joins the caller's (two or more failures in one `all`
are reported together, as a defect); `attempt`, `result` and `settle`
hand it over as an outcome, one of four: `success`, `failure`, `defect` (a
throw) and `aborted`. A fork nobody joins hands its failure to its parent,
which reports it as its own defect, as it does a thrown one. TypeScript
compares types by structure, so error classes need a distinguishing member,
like the literal `name` above, to stay separate in the inferred union.

Where an expected failure crosses a boundary a task does not (a function's
return value, a library, JSON), it is a `Result`: `{ status: 'success',
value }` or `{ status: 'failure', error }`, in the words an outcome uses.
`ramme/result` is optional, and any object of the shape works with it. Its
`$` turns a `Result` you hold back into the task's failure:

```ts
import { $ } from 'ramme/result';

const charge = task(function* (card: Card, amount: number) {
  const auth = yield* $(yield* wait(gateway.authorize(card, amount)));  // Result<Auth, Declined>: the value, or Declined
  return yield* wait(gateway.capture(auth));
});                                               // Task<[card: Card, amount: number], Receipt, Declined>
```

`unwrap(r)` is the named conversion to a defect: the value, or the error
thrown. The other helpers (`map`, `andThen`, `orElse`, `collect`,
`fromThrowing`, …) are in
[DESIGN.md §4.13](DESIGN.md#413-expected-failures-result-and--d38-d42).

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

`ramme.configs.recommended` reports an `async` function passed as a body, an
op made and never yielded (`call(t);`), a discarded `attempt`, `settle` or
`result` outcome, `setTimeout` and its siblings (`requestAnimationFrame`
included), a `lookup` result stored on an object or in a module variable, a
value provided on the node that owns it, and, in code that uses ramme, the
platform's bare forms `ramme/platform` replaces: a listener
(`addEventListener`, `.on(…)`, `el.onclick =`), the global `fetch` in a body
(fixed by importing ramme's), and `for await`. The
[plugin's README](packages/eslint-plugin-ramme/README.md) says what each rule
flags, why, and where it is approximate.

## Documentation

- [DESIGN.md](DESIGN.md): the model, the guarantees, and how each mechanism
  works, including the second tier for resource and library authors (pools,
  shutdown-aware tasks, release deadlines, lifecycle events).
- [DECISIONS.md](DECISIONS.md): why it is this way and not another way.

## License

Apache-2.0
