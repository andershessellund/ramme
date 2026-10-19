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
- When the client hangs up, `req.signal` interrupts the handler: it stops at
  its next *managed await* and never resumes, and the lease goes back to the
  pool. A managed await is an `await` on a promise ramme returned (`call`,
  `join`, `all`, `race`, `release`, …); `await fetch(...)` or a timer is
  not one, which is why you pass `signal()` on ([DESIGN.md
  §4.2](DESIGN.md#42-freeze-and-managed-awaits-d13)). An interruption is not
  a failure, so `onFailure` is not called.
- If `work` throws, `onFailure` gets the error once.

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

## The rules

- **Own it before the work; don't clean up in `finally`.** An interrupted
  body never resumes, so its `finally` never runs. Anything that must be
  undone is attached with `own(...)` and released by its node. The same goes
  for `using` / `await using` inside async bodies. `await using` for the
  root at the top level is fine.
- **Release early whenever you like.** `await release(x)` runs `x`'s release
  now, exactly once.
- **`try/catch` is fine.** A `catch` sees real errors, never its own
  body's interruption. Awaiting other work that was interrupted does throw
  (`FiberAbortedError`, below).
- **Await every `call`.** A forgotten await is detected: the next
  body-shaped operation in that body (`lookup`, `fork`, `call`, `join`, …)
  throws `UnawaitedCallError`. `own`, `release`, `abort` and `close` stay
  allowed, so they do not reveal it. Use `all([...])` for concurrent calls.
- **Pass `signal()` on** to `fetch`, timers and drivers, so work stops
  promptly when interrupted.
- **`inject` in constructors, `lookup` in bodies.** `lookup` throws during
  creation and `inject` throws outside it. Don't store a `lookup` result on
  anything that outlives the current task.

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

## Documentation

- [DESIGN.md](DESIGN.md): the model, the guarantees, and how each mechanism
  works, including the second tier for resource and library authors (pools,
  shutdown-aware tasks, release deadlines, lifecycle events).
- [DECISIONS.md](DECISIONS.md): why it is this way and not another way.

## License

Apache-2.0
