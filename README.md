# ramme

**Hierarchical contexts for JavaScript.** Dependency injection, structured
concurrency, and resource lifecycle in one tree: a context is a resolution
scope, an execution scope, and a lifetime — the same node answers "who
provides X here?", "where am I running?", and "when does this die?".

*Ramme* is Danish for frame: scoped resolution is literally "inden for
rammerne af" — within the frame of.

## Sixty seconds

```ts
import {
  createRootContext, createInjectionKey, valueProvider, factoryProvider,
  inject, lookup, RegisterResource, Fiber, Dispose,
} from 'ramme';
import 'ramme/node'; // AsyncLocalStorage context propagation, once

const Config = createInjectionKey<Config>('Config');
const Db = createInjectionKey<Db>('Db');

const app = createRootContext({
  providers: [
    valueProvider(Config, loadConfig()),
    factoryProvider(Db, () => {
      const db = connect(inject(Config).dbUrl);
      inject(RegisterResource)({ [Dispose]: () => db.close() });
      return db;
    }),
  ],
});

const fiber = Fiber.spawn(async () => {
  const db = lookup(Db);          // ambient resolution, across await
  return db.query('…');
}, { context: app });

await Fiber.join(fiber);
await app.dispose();              // drain → flush → dispose; fibers settle first
```

What the example shows:

- **DI with auto-placement.** `inject` declares dependencies during
  creation; an unscoped value is cached at the deepest context it actually
  depends on, never higher. Explicit scopes (`RequestScope`, your own
  `createScope`) override inference.
- **Resources follow values.** Whatever context caches the value disposes
  the resources its factory registered.
- **Fibers are contexts.** `Fiber.spawn`/`fork`/`call` each run in a child
  context: parent `dispose()` drains them, parent `abort()` reaches them,
  `withAbortSignal` bridges to `AbortSignal`-based APIs.
- **Ambient, pluggably.** `lookup` works wherever a context is ambient;
  propagation across `await` comes from `ramme/node` (or
  `ramme/async-context`); without one, context honestly ends at the first
  `await`.

## Serving ambient contracts

ramme serves [lookup-api](https://github.com/andershessellund/lookup-api)
contracts, so libraries that know nothing about ramme resolve through it:

```ts
import { contractProvider } from 'ramme';
import { OwnerContract } from 'some-library';

const app = createRootContext({
  providers: [contractProvider(OwnerContract, myOwner)],
});
app.run(() => someLibrary.doWork()); // its lookup(OwnerContract) sees myOwner
```

The resolver installs itself with the first root context, answers only
when a ramme context is ambient, and delegates everything else.

## Observability

Provide a receiver for `ContextTopic` / `FiberTopic` at the root to stream
structured lifecycle events (context created/status/aborted, resource
registered, fiber started/settled, call and join spans). No receiver, no
cost.

## Documentation

- [DESIGN.md](DESIGN.md) — the model, the invariants, how each mechanism
  works.
- [DECISIONS.md](DECISIONS.md) — why it is this way and not another way.

## License

Apache-2.0
