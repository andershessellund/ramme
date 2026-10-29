// stage6-pin.test.ts — the pinning tests of stage 6a of the generator runtime: callable tasks, `task(self, body)`, ops
// in the combinators, a task refused as a key, and `createKeyFor` (the stage-6a specification's decisions 1–4 and 6–8;
// D44 records them in stage 6b), written first, against the stage-5b tree (93c472a).
//
// Each test asserts a fact of stage 6a, which the stage-5b tree does not have:
//
// - A task is callable (decision 1): `t(…args)` is the lazy `Op<T, E>` that `call(t, …args)` was. Making it runs
//   nothing; each `yield*` of it runs it afresh, in a new child named after the task; `then` from plain async code runs
//   it under the node it was made through (`await app.run(() => t(4))`). Construction reads the slot: `t(…)` outside
//   any node throws `NoCurrentNodeError`, and in a factory `CreationViolationError`.
// - A task is a function object (decisions 3, 8): `isTask` accepts it, `t.name` is the task's name, `call` and `bind`
//   are `Function.prototype`'s (no own or inherited method shadows them), `fork` and `attempt` are gone, `with` stays;
//   `fork(t, …args)` still treats `t` as a task (its name), not as an inline body.
// - `task(self, body)` binds a receiver (decision 2): the body runs as `body.call(self, …args)`, so it reads a
//   `#private` field of the instance; `with` keeps the receiver; a class is a receiver too (a static field's `this`),
//   since resolution is by the second argument being a function. The name is `opts.name ?? body.name || 'anonymous'`.
// - The combinators take ops (decision 4): `all`, `race`, `settle`, `fork`, `attempt` and `pool.fork` take an op, a
//   task of no arguments still as itself. A task-call op forks the task itself: `all([t(1), u('x')])` makes two fibers
//   named after the tasks directly under the group, no node for the ops. Any other op runs in a fiber of its own,
//   named after the op (`sleep`, `wait`). `race([t(x), sleep(5)])` with the sleep winning aborts `t` and waits for it,
//   as D28 loses a loser: the timeout idiom.
// - A task is not an injection key (decision 7): `inject(t)` is a type error, and it and `lookup(t)` are a
//   `TypeError` ("a task is not an injection key") at run time.
// - `createKeyFor(impl, opts?)` (decision 6): an explicit key whose factory is `new impl()` for a class and `impl()` for
//   a function, named `opts.name ?? impl.name`, scoped `opts.scope ?? impl.scope`; its factory runs in the creation
//   phase, so `inject` inside `impl` works and placement follows `impl`'s dependencies; a task as `impl` is a
//   `TypeError` naming `createKeyFor`. The core exports it, and no longer the free verb `call` (the surface).
// - The types (the last describe, only type-checked, by `pnpm typecheck`): `t(…)` is `Op<T, E>`; `E` stays the exact
//   union through `yield* t(…)` and through `all`, `race` and `settle` of ops (a task written inside the array
//   included, the constraint above `BodyOf` in internal-context.ts); `fork`, `attempt` and `pool.fork` of an op keep
//   `T` and `E`; `AllResult` and `SettleResult` take ops; `task(self, body)` types `this` as `self`'s type, and a free
//   body's `this` is `void`; `Task` has no `fork` or `attempt`; `inject(t)` is refused; `createKeyFor` is typed by
//   `impl`, or by its explicit `I`.
//
// On the stage-5b tree every runtime test fails (`t(…)` is "not a function", `task(this, body)` is "task(body): body
// must be a function", `createKeyFor` is not exported, `inject(t)` throws `Error: Invalid key`), the types test only
// under `pnpm typecheck`, which reports this file's type pins: TS2349 for every `t(…)`, TS2305 for `createKeyFor`
// (which also makes the two `createKeyFor` type pins hold vacuously: an unresolved import has TypeScript's error type),
// TS2578 for each `@ts-expect-error` the stage-5b types do not satisfy, TS2344 for each `Expect<Equal<…>>` that does
// not hold. The `@ts-expect-error` on a stray `this` in a free body holds on both trees (an implicit `any` there, `void`
// here): a guard, not a pin.
//
// Amended once the runtime existed, without weakening a check: `subtree` leaves out release fibers (the `unwind:`
// fiber a halt or a fail makes, an entry's `release:` fiber at its owner's completion), which the pictures had not
// foreseen; and the pool test waits for the failure to be reported before its body returns, since the body's exit
// releases the pool and would abort `broken` before it throws (its `sleep(0)`, a 1 ms timer as Node clamps it, is
// armed after the `sleep(1)` the body joins). Strengthened after review: the shape test reads the tree under its
// `fork(double, 21)`, one fiber and nothing below it, since a callable forked as an inline body has the task's name
// and, running the op it returns, its value too.
//
// Each test first compares one observation object, so that a failure shows the whole of the behaviour in its diff.
// Outcomes are read as strings (`show`), errors named by identity among the test's own (`label`).
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { all, attempt, current, fail, fork, join, lookup, never, pool, race, settle, sleep, wait } from './ambient.js';
import { createKeyFor, getKeyScope } from './context-key.js';
import type { InjectionKey } from './context-key.js';
import type { AllResult, Context, Fiber, Op, Outcome, SettleResult, Task } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import * as core from './index.js';
import { inject } from './inject.js';
import { isTask } from './internal-context.js';
import { RequestScope, RootScope, createScope } from './scope.js';
import { events, impl, trace, within } from './test/util.js';
import type { EventLog } from './test/util.js';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Each error class has a distinct literal member: TypeScript compares classes by structure, so two bare
// `class X extends Error {}` are one type and an inferred union would collapse to one of them (result.test.ts).
class Boom extends Error {
  readonly name = 'Boom' as const;
}
class NotFound extends Error {
  readonly name = 'NotFound' as const;
}
class UserNotFound extends Error {
  readonly name = 'UserNotFound' as const;
}
class OrderNotFound extends Error {
  readonly name = 'OrderNotFound' as const;
}
class PaymentDeclined extends Error {
  readonly name = 'PaymentDeclined' as const;
}
class NotAnAdmin extends Error {
  readonly name = 'NotAnAdmin' as const;
}
interface User {
  readonly id: string;
}
interface Order {
  readonly user: User;
  readonly total: number;
}

const SessionScope = createScope('session');

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

afterEach(async () => {
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** A root that records its tree's events (test/util.ts `events`), closed after the test. */
function recorded(): EventLog {
  const ev = events();
  roots.push(ev.root);
  return ev;
}

/** The test's own values, by name: `label` names what it finds among them by identity. */
type Known = Readonly<Record<string, unknown>>;

/** `x` as an observation reads it: a known value by its name; another error by class and message. */
function label(x: unknown, known: Known = {}): string {
  for (const [name, v] of Object.entries(known)) if (v === x) return name;
  if (x instanceof Error) return `${x.name}: ${x.message}`;
  return typeof x === 'string' ? JSON.stringify(x) : String(x);
}

/** An outcome as one string: `success(…)`, `failure(…)`, `defect(…)` or `aborted(…)`; anything else says what it is. */
function show(o: unknown, known: Known = {}): string {
  const x = o as { status?: unknown; value?: unknown; error?: unknown; reason?: unknown } | undefined;
  switch (x?.status) {
    case 'success':
      return `success(${label(x.value, known)})`;
    case 'failure':
      return `failure(${label(x.error, known)})`;
    case 'defect':
      return `defect(${label(x.error, known)})`;
    case 'aborted':
      return `aborted(${label(x.reason, known)})`;
    default:
      return `not an outcome: ${label(o, known)}`;
  }
}

/** What `f()` did: `'returned'`, or the class name of what it threw. */
function outcomeOf(f: () => unknown): string {
  try {
    f();
    return 'returned';
  } catch (e) {
    return e instanceof Error ? e.constructor.name : String(e);
  }
}

/** What `f()` threw: its class name and its message; `'returned'` when it did not throw. */
function thrownBy(f: () => unknown): { readonly cls: string; readonly message: string } | 'returned' {
  try {
    f();
    return 'returned';
  } catch (e) {
    return e instanceof Error ? { cls: e.constructor.name, message: e.message } : { cls: typeof e, message: String(e) };
  }
}

/** A property of `x` as plain JavaScript reads it, whatever `x`'s type says it has. */
function prop(x: unknown, key: string): unknown {
  return (x as Record<string, unknown>)[key];
}

/** A node in `subtree`'s picture: `'<kind> <name>'`, with its children when it has any. */
type Shape = string | { readonly [node: string]: Shape[] };

/**
 * The nodes created under node `id`, in creation order, each as `'<kind> <name>'`, its own children nested. Release
 * fibers are left out (a halted or failed body's `unwind:` fiber, an entry's `release:` fiber): they are release
 * work, made by the halt and by the owner's completion whatever made the node, not the tree of calls the picture is of.
 */
function subtree(ev: EventLog, id: number): Shape[] {
  return ev
    .of('node:created')
    .filter((e) => e.parentId === id && e.kind !== 'release')
    .map((e) => {
      const below = subtree(ev, e.id);
      const node = `${e.kind} ${e.name ?? '(unnamed)'}`;
      return below.length === 0 ? node : { [node]: below };
    });
}

/** The `node:settled` outcomes of the nodes named `name`, in settling order. */
function settledAs(ev: EventLog, name: string): string[] {
  const ids = new Set(ev.of('node:created').filter((e) => e.name === name).map((e) => e.id));
  return ev.of('node:settled').filter((e) => ids.has(e.id)).map((e) => e.outcome);
}

/** Resolve `key` from a request fiber (it carries RequestScope) run under `session`. */
async function fromRequest<T>(session: Context, key: InjectionKey<T>): Promise<T> {
  return session.call(task(function* request() { return lookup(key); }, { scopes: [RequestScope] }));
}

/** The nodes a resolved key is cached on, among `nodes`. */
function storedOn(key: object, nodes: Record<string, Context>): string[] {
  return Object.entries(nodes)
    .filter(([, n]) => impl(n).cache.has(key as never))
    .map(([name]) => name);
}

describe('stage 6a: a task is callable, and its call is a lazy op (decisions 1, 3, 8)', () => {
  it('t(…) is the lazy op call(t, …) was: making it runs nothing, each yield* runs it afresh in a new child named after the task, and then from plain async code runs it under the node it was made through', async () => {
    const t = trace();
    const double = task(function* double(n: number) {
      t.push(`double(${n}) ran`);
      yield* sleep(0);
      return n * 2;
    });
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* main() {
        const op = double(21);
        const dropped = double(99); // made and never yielded: it runs nothing
        t.push('made');
        yield* sleep(1);
        t.push('slept');
        const a = yield* op;
        const b = yield* op; // the same op again: a second run, a second node
        return { a, b, dropped: typeof dropped, me: current().id };
      }),
      2000,
    );
    const viaThen = ev.root.run(() => double(4)); // made through the root, run by its `then`
    t.push('made through the root');
    const c = await within(viaThen, 2000);
    expect({
      log: t.log,
      values: { a: seen.a, b: seen.b, c },
      dropped: seen.dropped,
      underMain: subtree(ev, seen.me),
      fibersUnderRoot: ev.of('node:created').filter((e) => e.parentId === ev.root.id && e.kind === 'fiber').map((e) => e.name),
    }).toEqual({
      log: ['made', 'slept', 'double(21) ran', 'double(21) ran', 'made through the root', 'double(4) ran'],
      values: { a: 42, b: 42, c: 8 },
      dropped: 'object',
      underMain: ['fiber double', 'fiber double'],
      fibersUnderRoot: ['main', 'double'],
    });
  });

  it('t(…) reads the slot when it is made: outside any node it throws NoCurrentNodeError, in a factory CreationViolationError', async () => {
    const double = task(function* double(n: number) {
      return n * 2;
    });
    class Eager {
      readonly made = outcomeOf(() => double(1));
    }
    const outside = outcomeOf(() => double(1));
    const inFactory = await within(app().call(function* () { return lookup(Eager).made; }), 2000);
    expect({ outside, inFactory }).toEqual({ outside: 'NoCurrentNodeError', inFactory: 'CreationViolationError' });
  });

  it('a task is a function object: isTask accepts it, its name is the task’s, call and bind are Function.prototype’s, fork and attempt are gone, with stays; fork(t, …) still forks it as a task', async () => {
    const double = task(function* double(n: number) {
      return n * 2;
    });
    const anonymous = task(function* () {
      return 1;
    });
    const byOption = task(
      function* body() {
        return 1;
      },
      { name: 'byOption' },
    );
    const renamed = double.with({ name: 'renamed' });
    const shape = (x: unknown) => ({
      typeof: typeof x,
      isTask: isTask(x),
      name: prop(x, 'name'),
      call: prop(x, 'call') === Function.prototype.call,
      bind: prop(x, 'bind') === Function.prototype.bind,
      fork: prop(x, 'fork'),
      attempt: prop(x, 'attempt'),
      with: typeof prop(x, 'with'),
    });
    const callable = (name: string) => ({
      typeof: 'function',
      isTask: true,
      name,
      call: true,
      bind: true,
      fork: undefined,
      attempt: undefined,
      with: 'function',
    });
    const ev = recorded();
    const forked = await within(
      ev.root.call(function* () {
        const f = fork(double, 21);
        // An inline body would carry the callable's name and return its op's 42 too: only the tree tells them apart.
        return { name: f.name, value: yield* join(f), tree: subtree(ev, current().id) };
      }),
      2000,
    );
    expect({
      double: shape(double),
      anonymous: shape(anonymous),
      byOption: shape(byOption),
      renamed: shape(renamed),
      notTasks: [isTask(function* () {}), isTask(() => 1), isTask({}), isTask(sleep)],
      forked,
    }).toEqual({
      double: callable('double'),
      anonymous: callable('anonymous'),
      byOption: callable('byOption'),
      renamed: callable('renamed'),
      notTasks: [false, false, false, false],
      forked: { name: 'double', value: 42, tree: ['fiber double'] },
    });
  });
});

describe('stage 6a: task(self, body) binds a receiver (decision 2)', () => {
  it('the body runs with this = self: it reads a #private field of the instance, with keeps the receiver, a class is a receiver too, and the node is named after the body or opts.name', async () => {
    class Api {
      static readonly label = 'Api';
      // In a static field `this` is the class, a function: the second argument being a function makes it the receiver.
      static readonly describe = task(this, function* describe() {
        return `class ${this.label}`;
      });
      readonly #base: string;
      readonly get = task(this, function* get(path: string) {
        yield* sleep(0);
        return `${this.#base}${path}`;
      });
      readonly getAgain = this.get.with({ name: 'getAgain' });
      readonly base = task(
        this,
        function* () {
          return this.#base;
        },
        { name: 'base' },
      );
      constructor(base: string) {
        this.#base = base;
      }
    }
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const a = new Api('https://a');
        const b = new Api('https://b');
        return {
          values: {
            a: yield* a.get('/users'),
            b: yield* b.get('/orders'),
            again: yield* a.getAgain('/again'),
            base: yield* b.base(),
            describe: yield* Api.describe(),
          },
          names: [a.get.name, a.getAgain.name, a.base.name, Api.describe.name],
          me: current().id,
        };
      }),
      2000,
    );
    expect({ values: seen.values, names: seen.names, fibers: subtree(ev, seen.me) }).toEqual({
      values: { a: 'https://a/users', b: 'https://b/orders', again: 'https://a/again', base: 'https://b', describe: 'class Api' },
      names: ['get', 'getAgain', 'base', 'describe'],
      fibers: ['fiber get', 'fiber get', 'fiber getAgain', 'fiber base', 'fiber describe'],
    });
  });
});

describe('stage 6a: all, race, settle, fork, attempt and pool.fork take ops (decision 4)', () => {
  const double = task(function* double(n: number) {
    yield* sleep(0);
    return n * 2;
  });
  const shout = task(function* shout(s: string) {
    yield* sleep(0);
    return s.toUpperCase();
  });
  const zero = task(function* zero() {
    return 0;
  });
  const missing = task(function* missing(id: string) {
    yield* sleep(0);
    return yield* fail(new NotFound(id));
  });
  const boom = new Boom('boom');
  const broken = task(function* broken() {
    yield* sleep(0);
    throw boom;
  });

  it('all([t(1), u(‘x’)]) forks the two tasks directly under the group: two fibers named after the tasks, no node for the ops; a task of no arguments is taken as itself, and any other op runs in a fiber named after it', async () => {
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const pair = yield* all([double(1), shout('x')]);
        const mixed = yield* all([zero, double(2), sleep(1)]);
        return { pair, mixed, me: current().id };
      }),
      2000,
    );
    expect({ pair: seen.pair, mixed: seen.mixed, tree: subtree(ev, seen.me) }).toEqual({
      pair: [2, 'X'],
      mixed: [0, 4, undefined],
      tree: [{ 'fiber all': ['fiber double', 'fiber shout'] }, { 'fiber all': ['fiber zero', 'fiber double', 'fiber sleep'] }],
    });
  });

  it('race([t(x), sleep(5)]): the sleep wins, and t is aborted and awaited, its finally run before race returns, as D28 loses a loser (the timeout idiom); t winning aborts the sleep', async () => {
    const t = trace();
    const slow = task(function* slow(id: string) {
      t.push(`slow(${id}) started`);
      try {
        yield* never();
        return id;
      } finally {
        t.push(`slow(${id}) finally`);
      }
    });
    const fast = task(function* fast(id: string) {
      yield* sleep(0);
      return id;
    });
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const timedOut = yield* race([slow('x'), sleep(5)]);
        t.push('race returned');
        const won = yield* race([fast('y'), sleep(10_000)]); // its timer is cleared by the abort: no 10 s wait
        return { timedOut, won, me: current().id };
      }),
      2000,
    );
    expect({
      log: t.log,
      values: { timedOut: seen.timedOut, won: seen.won },
      tree: subtree(ev, seen.me),
      settled: { slow: settledAs(ev, 'slow'), fast: settledAs(ev, 'fast'), sleep: settledAs(ev, 'sleep') },
    }).toEqual({
      log: ['slow(x) started', 'slow(x) finally', 'race returned'],
      values: { timedOut: undefined, won: 'y' },
      tree: [{ 'fiber race': ['fiber slow', 'fiber sleep'] }, { 'fiber race': ['fiber fast', 'fiber sleep'] }],
      settled: { slow: ['aborted'], fast: ['success'], sleep: ['success', 'aborted'] },
    });
  });

  it('settle of ops resolves with the four-way outcomes in order, a non-task op among them, each member a fiber of the group', async () => {
    const hang = task(
      function* hang() {
        yield* never();
      },
      { timeoutMs: 5 },
    );
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const outcomes = yield* settle([double(1), missing('u1'), broken(), hang(), sleep(1)]);
        return { outcomes: outcomes.map((o) => show(o, { boom })), me: current().id };
      }),
      2000,
    );
    expect({ outcomes: seen.outcomes, tree: subtree(ev, seen.me) }).toEqual({
      outcomes: ['success(2)', 'failure(NotFound: u1)', 'defect(boom)', 'aborted(TimeoutError: Timed out)', 'success(undefined)'],
      tree: [{ 'fiber settle': ['fiber double', 'fiber missing', 'fiber broken', 'fiber hang', 'fiber sleep'] }],
    });
  });

  it('fork(op) runs the op in a new child of the current node, a task-call op as the task itself; attempt(op) resolves with its four-way outcome', async () => {
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const f = fork(double(21));
        const g = fork(sleep(1));
        const forked = { names: [f.name, g.name], values: [yield* join(f), yield* join(g)] };
        const attempted = [
          show(yield* attempt(double(2))),
          show(yield* attempt(missing('u2'))),
          show(yield* attempt(wait(() => Promise.reject(boom))), { boom }),
        ];
        return { forked, attempted, me: current().id };
      }),
      2000,
    );
    expect({ forked: seen.forked, attempted: seen.attempted, forks: subtree(ev, seen.me).slice(0, 2) }).toEqual({
      forked: { names: ['double', 'sleep'], values: [42, undefined] },
      attempted: ['success(4)', 'failure(NotFound: u2)', 'defect(boom)'],
      forks: ['fiber double', 'fiber sleep'],
    });
  });

  it('pool.fork(op) forks the op into the pool, a task-call op as the task itself; a failure reaches the pool’s onFailure', async () => {
    const failures: string[] = [];
    const reported = Promise.withResolvers<void>();
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const jobs = pool({
          name: 'jobs',
          onFailure: (e) => {
            failures.push(label(e, { boom }));
            reported.resolve();
          },
        });
        const f = jobs.fork(double(5));
        const g = jobs.fork(sleep(1));
        jobs.fork(broken());
        const values = [yield* join(f), yield* join(g)];
        yield* wait(reported.promise); // the body's exit releases the pool, which would abort broken before it throws
        return { names: [f.name, g.name], values, me: current().id };
      }),
      2000,
    );
    expect({ names: seen.names, values: seen.values, failures, tree: subtree(ev, seen.me) }).toEqual({
      names: ['double', 'sleep'],
      values: [10, undefined],
      failures: ['boom'],
      tree: [{ 'pool jobs': ['fiber double', 'fiber sleep', 'fiber broken'] }],
    });
  });
});

describe('stage 6a: a task is not an injection key (decision 7)', () => {
  it('inject(t) is a type error, and inject(t) and lookup(t) throw a TypeError at run time', async () => {
    const getUser = task(function* getUser(id: string) {
      return id;
    });
    class Holder {
      // @ts-expect-error a task is not an injection key (decision 7)
      readonly user = inject(getUser);
    }
    const seen = await within(
      app().call(function* () {
        return { inject: thrownBy(() => lookup(Holder)), lookup: thrownBy(() => lookup(getUser as never)) };
      }),
      2000,
    );
    const read = (t: ReturnType<typeof thrownBy>) => (t === 'returned' ? t : { cls: t.cls, saysTask: /a task is not an injection key/.test(t.message) });
    expect({ inject: read(seen.inject), lookup: read(seen.lookup) }).toEqual({
      inject: { cls: 'TypeError', saysTask: true },
      lookup: { cls: 'TypeError', saysTask: true },
    });
  });
});

describe('stage 6a: createKeyFor(impl, opts?) (decision 6)', () => {
  it('is an explicit key named after impl: a class is constructed with new and a function called without; its value is cached as a default is, under a key of its own', async () => {
    interface Clock {
      now(): number;
    }
    class SystemClock implements Clock {
      now(): number {
        return 1;
      }
    }
    function makeConfig() {
      return { url: 'https://example.com', calledWithNew: new.target !== undefined };
    }
    const ClockKey = createKeyFor<Clock>(SystemClock);
    const ConfigKey = createKeyFor(makeConfig);
    const seen = await within(
      app().call(function* () {
        const clock = lookup(ClockKey);
        return {
          names: [ClockKey.name, ConfigKey.name],
          constructed: clock instanceof SystemClock,
          cached: lookup(ClockKey) === clock,
          ownKey: lookup(SystemClock) !== clock,
          config: lookup(ConfigKey),
        };
      }),
      2000,
    );
    expect(seen).toEqual({
      names: ['SystemClock', 'makeConfig'],
      constructed: true,
      cached: true,
      ownKey: true,
      config: { url: 'https://example.com', calledWithNew: false },
    });
  });

  it('is scoped by the impl’s declared scope, read as D32 reads it; opts.scope and opts.name win', async () => {
    class SessionThing {
      static readonly scope = SessionScope;
    }
    function plain() {
      return { plain: true };
    }
    const Declared = createKeyFor(SessionThing);
    const Overridden = createKeyFor(SessionThing, { name: 'RootThing', scope: RootScope });
    const Unscoped = createKeyFor(plain);
    const root = app();
    const s1 = root.child({ name: 's1', scopes: [SessionScope] });
    const s2 = root.child({ name: 's2', scopes: [SessionScope] });
    const d1 = await fromRequest(s1, Declared);
    const d2 = await fromRequest(s2, Declared);
    const o1 = await fromRequest(s1, Overridden);
    const o2 = await fromRequest(s2, Overridden);
    expect({
      scopes: [getKeyScope(Declared), getKeyScope(Overridden), getKeyScope(Unscoped)].map((s) => s?.name),
      names: [Declared.name, Overridden.name, Unscoped.name],
      declared: { stored: storedOn(Declared, { root, s1, s2 }), perSession: d1 !== d2 },
      overridden: { stored: storedOn(Overridden, { root, s1, s2 }), shared: o1 === o2 },
    }).toEqual({
      scopes: ['session', 'root', undefined],
      names: ['SessionThing', 'RootThing', 'plain'],
      declared: { stored: ['s1', 's2'], perSession: true },
      overridden: { stored: ['root'], shared: true },
    });
  });

  it('runs its factory in the creation phase: inject inside impl works, and a key whose impl injects a session-scoped value is placed under the session', async () => {
    class SessionCache {
      static readonly scope = SessionScope;
    }
    class Report {
      readonly cache = inject(SessionCache);
    }
    const ReportKey = createKeyFor(Report);
    const SummaryKey = createKeyFor(() => ({ cache: inject(SessionCache) }), { name: 'Summary' });
    const root = app();
    const s1 = root.child({ name: 's1', scopes: [SessionScope] });
    const s2 = root.child({ name: 's2', scopes: [SessionScope] });
    const r1 = await fromRequest(s1, ReportKey);
    const r1again = await fromRequest(s1, ReportKey);
    const r2 = await fromRequest(s2, ReportKey);
    const m1 = await fromRequest(s1, SummaryKey);
    const cache1 = await fromRequest(s1, SessionCache);
    expect({
      report: { stored: storedOn(ReportKey, { root, s1, s2 }), sharedInSession: r1 === r1again, perSession: r1 !== r2, cache: r1.cache === cache1 },
      summary: { stored: storedOn(SummaryKey, { root, s1, s2 }), cache: m1.cache === cache1 },
    }).toEqual({
      report: { stored: ['s1', 's2'], sharedInSession: true, perSession: true, cache: true },
      summary: { stored: ['s1'], cache: true },
    });
  });

  it('refuses a task as impl with a TypeError naming createKeyFor', () => {
    const getUser = task(function* getUser(id: string) {
      return id;
    });
    const thrown = thrownBy(() => createKeyFor(getUser as never));
    expect({
      exported: typeof createKeyFor,
      thrown: thrown === 'returned' ? thrown : { cls: thrown.cls, namesCreateKeyFor: thrown.message.includes('createKeyFor') },
    }).toEqual({ exported: 'function', thrown: { cls: 'TypeError', namesCreateKeyFor: true } });
  });
});

describe('stage 6a: the surface', () => {
  it('the core exports createKeyFor, and no longer the free verb call', () => {
    expect({ createKeyFor: typeof Reflect.get(core, 'createKeyFor'), call: Reflect.has(core, 'call') }).toEqual({
      createKeyFor: 'function',
      call: false,
    });
  });
});

describe('stage 6a: the types (decisions 1–4, 6, 7)', () => {
  it('t(…) is an Op of the task’s value and failures; E stays exact through yield* and through all, race and settle of ops; fork, attempt and pool.fork take ops; task(self, body) types this; Task has no fork or attempt; createKeyFor is typed by impl', () => {
    // Never run: the bodies below are only type-checked (`pnpm typecheck`; vitest's expectTypeOf is a no-op).
    function types(): void {
      const getUser = task(function* getUser(id: string) {
        yield* sleep(0);
        if (id === '') yield* fail(new UserNotFound());
        const user: User = { id };
        return user;
      });
      const getAdmin = task(function* getAdmin(id: string) {
        yield* sleep(0);
        if (!id.startsWith('admin')) yield* fail(new NotAnAdmin());
        const user: User = { id };
        return user;
      });
      const getOrder = task(function* getOrder(user: User) {
        yield* sleep(0);
        if (user.id === 'nobody') yield* fail(new OrderNotFound());
        const order: Order = { user, total: 1 };
        return order;
      });
      const plain = task(function* plain(n: number) {
        yield* sleep(0);
        return n;
      });
      const zero = task(function* zero() {
        return 0;
      });
      // a call of a task is the op of its value and its failures, and a yield* of it joins them to the caller's
      const op = getUser('a');
      const viaCall = task(function* (id: string) {
        return yield* getUser(id);
      });
      // a middle level that both calls and fails, twice over
      const getAccount = task(function* (id: string) {
        const user = yield* getUser(id);
        if (user.id === 'locked') yield* fail(new NotAnAdmin());
        return user;
      });
      const getAccountOrder = task(function* (id: string) {
        const user = yield* getAccount(id);
        if (user.id === 'unpaid') yield* fail(new PaymentDeclined());
        const order: Order = { user, total: 1 };
        return order;
      });
      // the groups over ops
      const viaAll = task(function* (id: string) {
        const user: User = { id };
        return yield* all([getUser(id), getOrder(user)]);
      });
      const viaRace = task(function* (id: string) {
        return yield* race([getUser(id), getAdmin(id)]);
      });
      const viaSettle = task(function* (id: string) {
        const user: User = { id };
        return yield* settle([getUser(id), getOrder(user)]);
      });
      const allMiddle = task(function* (id: string) {
        return yield* all([getAccount(id), getAccountOrder(id), plain(1)]);
      });
      const mixed = task(function* (id: string) {
        return yield* all([getUser(id), sleep(1), zero]);
      });
      const timeout = task(function* (id: string) {
        return yield* race([getUser(id), sleep(5)]);
      });
      /** A task written inside the array `all` takes: its `E` is its body's, not the array's contextual `unknown`. */
      const inlineAll = task(function* () {
        return yield* all([
          task(function* () {
            yield* sleep(0);
            if (Math.random() > 1) yield* fail(new UserNotFound());
            return 1;
          }),
          plain(2),
        ]);
      });
      function* verbs(id: string) {
        const forked = fork(getUser(id));
        const forkedOp = fork(sleep(1));
        const attempted = attempt(getUser(id));
        const pooled = pool({ name: 'jobs', onFailure: () => {} }).fork(getUser(id));
        const user = yield* getUser(id);
        type _Fork = Expect<Equal<typeof forked, Fiber<User, UserNotFound>>>;
        type _ForkOp = Expect<Equal<typeof forkedOp, Fiber<void, never>>>;
        type _Attempt = Expect<Equal<typeof attempted, Op<Outcome<User, UserNotFound>>>>;
        type _PoolFork = Expect<Equal<typeof pooled, Fiber<User, UserNotFound>>>;
        type _Yield = Expect<Equal<typeof user, User>>;
        return [forked, forkedOp, attempted, pooled, user];
      }
      // task(self, body): `this` is self's type; a free body's `this` is void
      const self = { base: 'https://x' };
      const bound = task(self, function* (path: string) {
        expectTypeOf(this).toEqualTypeOf<{ base: string }>();
        return `${this.base}${path}`;
      });
      task(function* () {
        expectTypeOf(this).toEqualTypeOf<void>();
        return 1;
      });
      // @ts-expect-error a stray this in a free body is a type error: this is void
      task(function* () { return this.base; });
      // @ts-expect-error Task.fork is gone: fork(t(…)) (decision 3)
      getUser.fork('a');
      // @ts-expect-error Task.attempt is gone: attempt(t(…)) (decision 3)
      getUser.attempt('a');
      // @ts-expect-error the free verb call is retired: yield* t(…) (decision 4)
      const _call = core.call;
      // createKeyFor is typed by impl, or by its explicit I
      interface Clock {
        now(): number;
      }
      class SystemClock implements Clock {
        now(): number {
          return 1;
        }
      }
      const ClockKey = createKeyFor<Clock>(SystemClock);
      const ConfigKey = createKeyFor(() => ({ url: 'x' }));

      type _Op = Expect<Equal<typeof op, Op<User, UserNotFound>>>;
      type _Callable = Expect<Equal<ReturnType<typeof getUser>, Op<User, UserNotFound>>>;
      type _Parameters = Expect<Equal<Parameters<typeof getUser>, [id: string]>>;
      type _ViaCall = Expect<Equal<typeof viaCall, Task<[id: string], User, UserNotFound>>>;
      type _Middle = Expect<Equal<typeof getAccount, Task<[id: string], User, UserNotFound | NotAnAdmin>>>;
      type _MiddleTwice = Expect<
        Equal<typeof getAccountOrder, Task<[id: string], Order, UserNotFound | NotAnAdmin | PaymentDeclined>>
      >;
      type _All = Expect<Equal<typeof viaAll, Task<[id: string], [User, Order], UserNotFound | OrderNotFound>>>;
      type _Race = Expect<Equal<typeof viaRace, Task<[id: string], User, UserNotFound | NotAnAdmin>>>;
      type _Settle = Expect<
        Equal<typeof viaSettle, Task<[id: string], [Outcome<User, UserNotFound>, Outcome<Order, OrderNotFound>], never>>
      >;
      type _AllMiddle = Expect<
        Equal<typeof allMiddle, Task<[id: string], [User, Order, number], UserNotFound | NotAnAdmin | PaymentDeclined>>
      >;
      type _Mixed = Expect<Equal<typeof mixed, Task<[id: string], [User, void, number], UserNotFound>>>;
      type _Timeout = Expect<Equal<typeof timeout, Task<[id: string], User | void, UserNotFound>>>;
      type _InlineAll = Expect<Equal<typeof inlineAll, Task<[], [number, number], UserNotFound>>>;
      type _AllResult = Expect<Equal<AllResult<readonly [Op<User, UserNotFound>, Task<[], number>]>, [User, number]>>;
      type _SettleResult = Expect<
        Equal<SettleResult<readonly [Op<User, UserNotFound>, Task<[], number>]>, [Outcome<User, UserNotFound>, Outcome<number, never>]>
      >;
      type _Bound = Expect<Equal<typeof bound, Task<[path: string], string, never>>>;
      type _ClockKey = Expect<Equal<typeof ClockKey, InjectionKey<Clock>>>;
      type _ConfigKey = Expect<Equal<typeof ConfigKey, InjectionKey<{ url: string }>>>;
      const made = [op, viaCall, viaAll, viaRace, viaSettle, allMiddle, mixed, timeout, inlineAll, bound, ClockKey, ConfigKey];
      expect([typeof verbs, made.length]).toEqual(['function', 12]);
    }
    expect(typeof types).toBe('function');
  });
});
