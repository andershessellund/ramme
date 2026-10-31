# ramme

**One tree for services and work.** Dependency injection, structured
concurrency and resource lifetimes in one structure: a node's position in
the tree answers both *what it may depend on* and *when it dies*. Ancestors
outlive descendants, and you only ever resolve from ancestors, so nothing
you can resolve dies before you do.

Adopting ramme means writing bodies as generator functions, where every
wait is a `yield*` and every function that waits is a task. Async libraries
are reached through `wait`, `promised` and `ramme/platform`. It is an
execution model for the whole application, not a utility added to one
module, and the trade is that interruption, lifetime and dependency
placement become one structure the runtime enforces.

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

  readonly get = task(this, function* get(path: string) {   // an operation: yield* api.get(…)
    const res = yield* fetch(this.#base + path);    // an op: interrupting the task aborts the request
    return yield* wait(res.json());
  });
}

const profile = task(function* profile(id: string) {
  const api = lookup(Api);
  const [user, orders] = yield* all([api.get(`/users/${id}`), api.get(`/users/${id}/orders`)]);
  return { user, orders };
});

await using app = createRootContext();
console.log(await app.call(profile, '42'));
```

What the example shows:

- **A body is a generator function; every wait is a `yield*`.** A task's
  call, `all`, `sleep` and the rest return an *op*, which `yield*` runs and
  waits for; a foreign promise is `yield* wait(p)`. An op runs when it is
  yielded, so `api.get(path);` without the `yield*` does nothing (the lint
  catches it when it has type information, [below](#lint)). Outside a body,
  `await app.call(profile, '42')` runs one on a node you name.
- **A task is a value; calling it makes an op, and yielding the op runs it
  as a new node.** `api.get(path)` runs nothing until it is yielded:
  `yield* api.get(path)` runs it in a new child node and waits for it,
  `fork(api.get(path))` runs it concurrently, and `all` takes the ops and
  returns the tuple of their values (`race` returns the first success).
  `task(this, function* get(…) { … })` makes an operation of a service: its
  body runs with the service as `this`. Whatever a run attached is released
  when it finishes, however it finishes.
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
  the *current node*, which ramme sets while a body runs, on every platform,
  with no setup: ramme has no async context.
- **Shutdown lives on the root.** `await using app` releases the whole tree:
  running work first, then the services it used. `app.abort()` interrupts
  the tree without waiting, and `await app.close()` lets running work
  finish before releasing.

## A request

```ts
import { createInjectionKey, valueProvider, task, lookup, own, wait } from 'ramme';

const Conn = createInjectionKey<Connection>('Conn');

const handle = task(function* handle(req: Request, res: Response) {
  const db = lookup(Connections);                   // a driver's pool, provided as a service: shared, outlives every request
  const lease = own(yield* wait(db.acquire()));     // returned to the pool when the handler ends
  return yield* lookup(Orders).place.with({ providers: [valueProvider(Conn, lease.conn)] })(req);
});

server.on('request', (req, res) =>
  app.fork(handle.with({ name: req.url, signal: req.signal, onFailure: (e) => respond500(res, e) }), req, res));
```

- `Connections` is a database driver's pool, foreign code provided as a
  service; its `acquire()` is the driver's, a promise of a lease that can be
  released, so the handler waits for it as for any foreign promise.
- `Orders` is a service too, and `place` one of its operations, a
  `task(this, …)` field. `place.with({ providers })` is the same task with a
  provider for this run: it runs in a node of its own below the handler, so
  a `lookup(Conn)` there, or in a service it calls, reads this request's
  connection. The handler is the one standalone task; the work it does is
  the services'.
- The server's callback runs outside any node, so it names one:
  `app.fork(...)` attaches the handler to the root. This is the only place a
  node is passed explicitly. `handle.with({...})` is the same task with
  options for this use: a `name`, a `signal` that interrupts it, and
  `onFailure`, where its failure goes.
- When the client hangs up, `req.signal` interrupts the handler: ramme
  *halts* it, returning it at the `yield*` where it waits, once `place`,
  which it waits on, has stopped too; no `catch` sees that, every `finally`
  runs, and then the lease goes back to the pool. An interruption is not a
  failure, so `onFailure` is not called.
- If `place` throws, `onFailure` gets the error once.

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

A wait that callers share is a fiber the service owns. A per-session cache
of users, over an `Api` whose `getUser(id)` fails with `NotFound`:

```ts
import { ContextKey, inject, join, task, type Fiber } from 'ramme';

class UserCache {
  static readonly scope = SessionScope;
  readonly #api = inject(Api);
  readonly #self = inject(ContextKey);                 // the cache's own node
  readonly #entries = new Map<string, Fiber<User, NotFound>>();
  readonly get = task(this, function* get(id: string) {
    let f = this.#entries.get(id);
    if (f === undefined) {
      f = this.#self.fork(this.#api.getUser.with({ onFailure: () => this.#entries.delete(id) }), id);
      this.#entries.set(id, f);
    }
    return yield* join(f);                             // the user, or NotFound
  });
}
```

The check and the set have no wait between them, so they are atomic: two
callers never both fetch one user. The fetch is the cache's, forked on its
own node, not the caller's: a caller that is interrupted stops waiting and
leaves it running, and closing the session ends it. Every concurrent caller
joins the same fiber and gets the same user, or the same typed failure,
`NotFound`. The cache's node has no body to join a failure, so the fork names
where one goes (`onFailure`), and here that drops the entry: the next `get`
fetches again.

A unit of work that commits or rolls back with its request is a
per-request service whose release reads the request's outcome through
`parent`, the node that stores it:

```ts
import { RequestScope, current, inject, lookup, own, task, wait } from 'ramme';

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
  readonly query = task(this, function* query(sql: string) {
    return yield* wait((signal) => this.#lease.conn.query(sql, signal));
  });
  readonly commit = task(this, function* commit() { yield* wait(this.#lease.conn.query('COMMIT')); });
  readonly rollback = task(this, function* rollback() { yield* wait(this.#lease.conn.query('ROLLBACK')); });
}

const handle = task(function* handle(req: Request) {
  yield* lookup(UnitOfWork).query('…');           // every lookup in this request shares one
}, { scopes: [RequestScope] });                   // the request's own fiber carries the scope
```

Its release returns `this.commit()` or `this.rollback()`, an op, which ramme
runs as the release: in a node of its own, which no interruption cuts, and
to its end before the lease is returned.

The request's fiber must carry `RequestScope`, as `handle` does, so that
its outcome is how the request ended. A bodiless
`child({ scopes: [RequestScope] })` reports how it was ended, not how its
work ended: under `await using` every unit of work on it rolls back, and
after `close()` every one commits, even when a task run on it failed and the
error was caught ([DESIGN.md §2.6](DESIGN.md#26-ownership)).

**Structural and contextual.** `inject` is for what a service is made of,
its collaborators and its configuration; `lookup` is for what is true where
the work runs: the transaction, the connection, the request, the principal.
A service that declares no scope and `inject`s a contextual key becomes
contextual itself: it is placed under the node that provides the key and
re-created with it, one per transaction, say. That is a legitimate design, a
per-transaction repository, when it is the one you meant. A service that
declares its scope resolves what it injects from its scope's node, so a
provider below that node is not seen. A connection is the usual case, and its
`lookup` belongs in one place, the client: the client's `query` looks up the
current `Connection` (`lookup(Connection, { optional: true })`) and, when
there is none, acquires one for its task; repositories inject the client,
never the connection; and the client's `transaction(work)` runs `work` on a
child node that provides the `Connection`, so every repository `work` calls
shares the transaction.

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

A seam with two implementations (SMTP in production, a log in development)
is an interface, its classes, and a key for the interface over its default
class, made with `createKeyFor`. Call sites read `inject(Mailer)` exactly as
they would a class key, and a test or another environment provides its own:

```ts
import { createKeyFor, createRootContext, inject, task, valueProvider, wait, type Task } from 'ramme';

export interface Mailer {
  readonly send: Task<[to: string, body: string], void>;
}
class SmtpMailer implements Mailer {
  readonly #smtp = inject(SmtpClient);
  readonly send = task(this, function* send(to: string, body: string) {
    yield* wait(this.#smtp.deliver(to, body));
  });
}
export const Mailer = createKeyFor<Mailer>(SmtpMailer);   // the default: an SmtpMailer, placed by its own rules

class Signup {
  readonly #mailer = inject(Mailer);                  // the same call site as a class key
}

class FakeMailer implements Mailer {
  readonly sent: string[] = [];
  readonly send = task(this, function* send(to: string) { this.sent.push(to); });
}

const fake = new FakeMailer();
await using test = createRootContext({ providers: [valueProvider(Mailer, fake)] });
```

The interface and the key share the name `Mailer` because types and values
are separate namespaces: in a type it is the interface, in an expression the
key. `createKeyFor` checks `SmtpMailer` against the interface, and
`valueProvider(Mailer, fake)` checks the fake against it too, so `Public` is
not involved: an interface has no private members to leave out.

## Fork now, join later

```ts
const report = task(function* report(id: string) {
  const audit = fork(writeAudit(id));       // concurrent, in its own node
  const data = yield* buildReport(id);
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
const session = task(function* session(user: User) {
  fork(function* heartbeat() {
    for (;;) {
      yield* sleep(30_000);                 // an interrupted loop is halted here, its timer cleared
      yield* sendHeartbeat(user);
    }
  });
  yield* serve(user);                       // when serve returns, the heartbeat is interrupted
});
```

In a body, `yield* sleep(ms)` is the timer to use: a bare `setTimeout` is
one no interruption clears, so a body waiting on one keeps its node, and
everything attached to it, until the timer fires. Outside any node,
`await app.sleep(ms)` is a plain delay.

## Waiting, and what an interruption does

An interruption *halts* a body: ramme returns its generator at the `yield*`
where it waits. No `catch` sees it, every `finally` runs, and nothing after
that `yield*` does; the task's outcome is `aborted`, unless its cleanup
fails: a `finally` that throws, or a wait in it that fails, makes the
outcome a `defect`, which is reported. When the body is returned depends on
what it waits on: at once for a `sleep`, a `never()`, an owned fork's
`join`; once the awaited work has stopped for a task's call, an `all`, a
`join` of a fork it made; and for a release or a foreign promise, after it
finishes: the body is resumed with its value once, so it can own it, and
stops at its next wait. The `finally` the halt runs may wait, and the
interruption does not cut what it waits on, so cleanup can wait for a
rollback:

```ts
import { own, task, wait } from 'ramme';

const transfer = task(function* transfer(from: Id, to: Id, amount: number) {
  const conn = own(yield* wait(db.connect()), (c) => c.release());   // interrupted while connecting: still owned
  yield* wait((signal) => conn.query('BEGIN', signal));              // not started at all once interrupted
  let done = false;
  try {
    yield* debit(conn, from, amount);              // halted here: debit stops and completes first
    yield* credit(conn, to, amount);
    yield* wait((signal) => conn.query('COMMIT', signal));
    done = true;
  } catch (e) {
    throw translate(e);                            // a real failure of debit or credit, never the interruption
  } finally {
    if (!done) yield* wait((signal) => conn.query('ROLLBACK', signal));  // runs to its end; a failed ROLLBACK is reported
  }
});
```

Start foreign work with `wait((signal) => p)`: hand the signal on, and the
work stops when you do (`wait((signal) => driver.query(sql, { signal }))`;
for `fetch`, `yield* fetch(url)` from `ramme/platform` does it for you); an
interrupted body starts it only in the `finally` the halt runs, as the
`ROLLBACK` above. A promise that already exists is
`yield* wait(p)`, for acquisition you want to finish so you can own what it
produced, as `db.connect()` above: an interrupted body finishes the wait it
is in, then stops at its next. `wait(p, { abandon: true })` stops waiting at
once instead. Past the wait in flight, every `wait` an interrupted body
yields stops at once, except in the `finally` the halt runs, which waits for
everything it yields; a `finally` the body enters on its own after the
interruption, by a `return` or a throw, stops at its first wait, so cleanup
that must finish belongs in `own(...)`. A library that
calls you back with an async function gets `promised(function* …)`, which
runs your generator as a child of the current task and hands the library a
real promise:

```ts
import { promised, task, wait } from 'ramme';

const save = task(function* save(order: Order) {
  yield* wait(db.transaction(promised(function* (tx) {   // a child of this task per call
    yield* insertOrder(tx, order);
    yield* insertLines(tx, order.lines);
  })));
});
```

Interrupted mid-way, the callback is halted once `insertOrder` has stopped,
its promise rejects, the database driver rolls back, and only then is `save`
itself halted and its resources released. No `catch` in the callback can
swallow the interruption, so nothing can let the database driver commit.

## The rules

**The style.** One way to write a ramme application, the one this README
uses:

- **A service is a class, and its own key**: `readonly #x = inject(X)`
  fields for what it is made of,
  `readonly op = task(this, function* op(…) { … })` fields for what it
  does, and `static readonly scope` when it holds state for one session,
  request or other unit.
- **Separate an interface from its class only at two implementations**, and
  key it with `createKeyFor` ([above](#tests-and-overrides)).
- **Every function that waits is a task**; one that does not is a plain
  function.
- **A standalone task is an entry point**: a request handler, a job,
  `main`. The rest of the work is the services' operations.
- **`inject` for what a service is made of, `lookup` for what is true
  here**: the transaction, the connection, the request, the principal. A
  service that declares no scope and injects a contextual key is contextual
  itself, placed under the provider and re-created with it, a design you
  choose by name; one that declares its scope does not see a provider below
  its scope's node ([above](#services-that-hold-state)).

ramme accepts other forms too (a service made by a function, a function as
a key, a token with a factory), which
[DESIGN.md §3.1](DESIGN.md#31-keys-providers-scopes) lists; the lint's
style preset ([below](#lint)) reports a function key and an anonymous task,
not a token with a factory. The rules:

- **Own it before the work.** Anything that must be undone is attached with
  `own(...)` and released by its node, however the body ends. ramme cannot
  see what a `finally` cleans up, and an interruption cuts short a
  `finally` the body reached on its own (by finishing its `try`, a `return`
  or a throw) at its first wait, so keep invariants in `own`. `await using`
  for the root at the top level is fine.
- **Every wait is a `yield*`.** Run ramme's ops with `yield*`
  (`yield* api.get(path)`, `yield* sleep(ms)`): an op you make and do not
  yield runs nothing, and the lint reports `api.get(path);` alone when it
  has type information. Start foreign work with
  `yield* wait((signal) => work(signal))`, which an interrupted body starts
  only in the `finally` the halt runs; wait for a promise that already
  exists with `yield* wait(p)`: an
  interrupted body finishes the wait it is in, then stops at its next.
  `wait(p, { abandon: true })` stops waiting at once. Run concurrent work
  with `all([...])`.
- **Every function that waits is a task.** The tree is the call tree: each
  operation runs in a node of its own, which releases what it acquired, is
  interrupted and timed on its own, and shows in a trace. A synchronous
  function is a plain function, and the lint reports a generator function
  not written inline as a body. The `finally` an interruption runs in a
  task's body may wait: what it yields is not cut by the interruption.
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
- **`inject` for structural dependencies, `lookup` for contextual ones.**
  `inject` is legal only while a service is built (its fields, its
  constructor) and throws outside it; `lookup` throws there. Don't store a
  `lookup` result on anything that outlives the current task.

**Foreign code.** A driver's transaction callback is a `promised` body, as
above: interrupted, it is halted once its work has stopped, and the driver's
own `finally` rolls back before your task releases what the driver
borrowed. Two more things to know about libraries:

- A retry wrapper that retries on any error retries a halted callback: each
  retry starts already interrupted and is halted at its first `yield*` (or,
  when that is a `wait(p)`, at the next one after it), repeating the code up
  to there. Start writes with `wait((signal) => …)` or a task's call, which
  such a retry never runs.
- Cleanup that waits for a driver with no timeout of its own (a `ROLLBACK`
  on a dead connection) holds your task, and `await using app` shutdown with
  it, for as long as it hangs: `releaseTimeoutMs` only signals. Give such
  cleanup a driver-level timeout, or hand it the deadline:
  `yield* wait((signal) => conn.query('ROLLBACK', signal))`.

## The platform

Node 22+ or an evergreen browser, with nothing to import or register: the
current node is a slot ramme sets while a body runs, on every platform.
ramme needs ES2022 syntax and four runtime APIs, `Promise.withResolvers`,
`AbortSignal.any`, `AbortSignal.timeout` and the disposal symbols
(`Symbol.dispose`, `Symbol.asyncDispose`); it defines the two symbols itself
where they are missing and polyfills nothing else, so on an older runtime
polyfill the other three. CI runs the browser smoke test, the core and
`ramme/platform` through their public entries, in headless Chromium.

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

const search = task(function* search(q: string) {
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
    latest = fork(search.with({ onFailure: showError })(input.value)); // box has no body to join it: name a handler
  }),
);
```

A driver gets the same treatment in a few lines of your own: every
operation a task, every wait an op, every async callback it takes a
`promised` body. node-postgres
(`import pg from 'pg'`), say, behind a service:

```ts
import { inject, lookup, own, promised, task, wait, type Task } from 'ramme';

class Db {
  readonly #pool = own(new pg.Pool(inject(DbConfig)), (p) => p.end());   // closed with the service, after its users
  readonly query = task(this, function* query(sql: string, params: unknown[] = []) {   // yield* db.query(…) in any body
    return (yield* wait(this.#pool.query(sql, params))).rows;
  });
  readonly transaction = task(this, function* transaction(work: Task<[tx: pg.PoolClient], void>) {
    const client = own(yield* wait(this.#pool.connect()), (c) => c.release());   // back to the pool when the transaction ends
    yield* wait(withTx(client, promised(work)));   // your async withTx(client, fn): BEGIN, fn, then COMMIT or ROLLBACK
  });
}

const save = task(function* save(order: Order) {
  yield* lookup(Db).transaction(task(function* insert(tx: pg.PoolClient) {   // interrupted, it is halted and withTx rolls back
    yield* wait(tx.query('INSERT INTO orders (id) VALUES ($1)', [order.id]));
  }));
});
```

`await using` ends a node the way an exception would, by interruption; to
drain, call `close()`. That holds for the root at the top level and for any
node a test scopes with it.

## Errors you will meet

| Error | Means |
| --- | --- |
| `NoCurrentNodeError` | A free function ran outside any task: at top level, or in plain async code after its first `await`. |
| `CreationViolationError` | `lookup` (or a task's call) inside a constructor or factory, or `inject` outside one. |
| `NodeCompletedError` | A node, or a service, was used after it was released. |
| `FiberNotAwaitableError` | `await fiber`: use `join(fiber)` or `result(fiber)`. |
| `FiberAbortedError` | `join` / a task's call / `all` / `race` of work that was interrupted, by code that is not itself interrupted (top level, a platform callback, or a body whose own node was not aborted). Your own interruption is no error: it halts your task. |
| `TypeError` naming `function*` | An `async` function was passed as a body: write it as `function*`. |

To branch on how work ended instead of catching, `attempt` is a task's call
that resolves with the outcome, and `settle` is `all` that resolves with
every task's outcome instead of rejecting (both wait for every task, and
neither cancels the others when one fails):

```ts
const r = yield* attempt(fetchPrices.with({ timeoutMs: 500 })(sku));
if (r.status === 'defect') throw r.error;                              // a real failure stays a failure
if (r.status === 'failure') return yield* fail(r.error);               // and an expected one stays expected
const prices = r.status === 'success' ? r.value : cachedPrices(sku);   // 'aborted': the 500 ms ran out

const [user, orders] = yield* settle([api.get(`/users/${id}`), api.get(`/users/${id}/orders`)]);
if (orders.status === 'defect') log(orders.error);                     // all would have thrown; user is still here

let quote = yield* attempt(fetchQuote(sku));
for (let i = 0; quote.status === 'defect' && i < 3; i++) {
  yield* sleep(100 * 2 ** i);                                          // back off; an interrupted caller is halted here
  quote = yield* attempt(fetchQuote(sku));
}
```

`aborted` means the task's own abort (its `timeoutMs` or `signal`, or an
explicit abort), the abort of the context it runs in (`ctx.attempt(…)`), or,
for a `settle` member, `settle`'s own `timeoutMs` or `signal`: a body that
is itself interrupted is halted at `attempt` or `settle`, as at a call, once
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
why the plain call stays the default.

## Expected failures

A failure the caller is meant to branch on (no such user, a declined card)
is yielded, not thrown: `yield* fail(e)` ends the task at once with it, and
the task's type says so. Anything thrown is a defect: let it fail the task,
and translate it where the work is handed over (`attempt`, `onFailure`), not
in the middle of the domain code.

```ts
import { attempt, fail, inject, lookup, task, wait } from 'ramme';

class UserNotFound extends Error { readonly name = 'UserNotFound' as const; }
class OrderNotFound extends Error { readonly name = 'OrderNotFound' as const; }

class Users {
  readonly #db = inject(Database);
  readonly getUser = task(this, function* getUser(id: string) {
    const user = yield* wait(this.#db.findUser(id));
    if (user === undefined) return yield* fail(new UserNotFound(id));
    return user;
  });                                             // Task<[id: string], User, UserNotFound>

  readonly getOrder = task(this, function* getOrder(id: string) {
    const user = yield* this.getUser(id);         // the user, or this task ends here with UserNotFound
    const order = yield* wait(this.#db.findOrder(user));
    if (order === undefined) return yield* fail(new OrderNotFound(id));
    return order;
  });                                             // Task<[id: string], Order, UserNotFound | OrderNotFound>
}

const handle = task(function* handle(id: string) {
  const r = yield* attempt(lookup(Users).getOrder(id));
  if (r.status === 'success') return json(r.value);
  if (r.status === 'failure') return notFound(r.error);   // r.error: UserNotFound | OrderNotFound
  if (r.status === 'defect') throw r.error;               // a bug stays a bug
  return unavailable();                                   // 'aborted': interrupted
});
```

No `catch` sees a `fail`, and the task's `finally` blocks still run. Write
it as `return yield* fail(e)`: TypeScript does not narrow after a `yield*`,
so `return` is what tells it that `user` is defined below the check.
A call (`yield* this.getUser(id)`), `join`, `all` and `race` pass a child's expected failure on to the
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
import { inject, task, wait } from 'ramme';
import { $ } from 'ramme/result';

class Payments {
  readonly #gateway = inject(Gateway);
  readonly charge = task(this, function* charge(card: Card, amount: number) {
    const auth = yield* $(yield* wait(this.#gateway.authorize(card, amount)));  // Result<Auth, Declined>: the value, or Declined
    return yield* wait(this.#gateway.capture(auth));
  });                                             // Task<[card: Card, amount: number], Receipt, Declined>
}
```

`unwrap(r)` is the named conversion to a defect: the value, or the error
thrown. The other functions (`map`, `andThen`, `orElse`, `collect`,
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
op made and never yielded (`sleep(5);`, and, when the parser has type
information, a task's call, `api.get(path);`), a generator function not
written inline as a body, a discarded `attempt`, `settle` or `result` outcome,
`setTimeout` and its siblings (`requestAnimationFrame` included), a `lookup`
result stored on an object or in a module variable, a value provided on the
node that owns it, and, in code that uses ramme, the platform's bare forms
`ramme/platform` replaces: a listener (`addEventListener`, `.on(…)`,
`el.onclick =`), the global `fetch` in a body (fixed by importing ramme's),
and `for await`. Type information is typescript-eslint's
(`languageOptions: { parserOptions: { projectService: true } }`); without it
a dropped task's call goes unreported.

`ramme.configs.style`, off unless you add it
(`[…, ramme.configs.recommended, ramme.configs.style]`), warns where code
leaves the style above in a way syntax can see: a task whose node would be
named `anonymous` (`named-task`) and a function used as an injection key
(`no-function-key`). What it reports works; it is for a codebase that wants
one style. The [plugin's README](packages/eslint-plugin-ramme/README.md)
says what each rule flags, why, and where it is approximate.

## Documentation

- [DESIGN.md](DESIGN.md): the model, its rules and its guarantees,
  including the second tier for resource and library authors (pools,
  shutdown-aware tasks, release deadlines, lifecycle events).
- [DECISIONS.md](DECISIONS.md): why it is this way and not another way.

## License

Apache-2.0
