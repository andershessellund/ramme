// ---------------------------------------------------------------------------
// The public surface, checked by the compiler (DESIGN.md §7, I27); the name
// list is the surface check's list (scripts/check-surface.mjs). Never run: it is
// not a test file, and every check is a type.
//
// It imports the package by its own name and is compiled twice:
//
// - `pnpm typecheck`: tsconfig.tests.json maps 'ramme' to src/index.ts, so a
//   change to the source surface fails at once;
// - `pnpm check:surface` (part of `check:package`): scripts/tsconfig.surface.json
//   has no mapping, so 'ramme' resolves through package.json "exports" to
//   dist/index.d.ts, what a consumer compiles against.
//
// 'ramme/result' has no mapping in either: it resolves through the package's
// self-reference, to src/result.ts under `pnpm typecheck` (the output path
// maps back to its source) and to dist/result.d.ts under `pnpm check:surface`.
//
// scripts/check-surface.mjs then compares the export clauses of
// dist/index.d.ts, and the declarations of dist/result.d.ts, with its expected
// lists name by name.
// ---------------------------------------------------------------------------

import {
  aliasProvider,
  all,
  attempt,
  classProvider,
  createInjectionKey,
  createScope,
  createTopic,
  current,
  factoryProvider,
  fail,
  promised,
  settle,
  valueProvider,
  wait,
} from 'ramme';
import type {
  Body,
  Context,
  Fail,
  Failure,
  Fiber,
  Instruction,
  Op,
  Operation,
  Outcome,
  Provider,
  Public,
  Release,
  Result,
  SettleResult,
  Success,
  Task,
} from 'ramme';
import * as ramme from 'ramme';
import {
  $,
  andThen,
  collect,
  failure,
  fromThrowing,
  isFailure,
  isSuccess,
  map,
  mapFailure,
  orElse,
  success,
  unwrap,
  unwrapOr,
} from 'ramme/result';
import * as rammeResult from 'ramme/result';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Not<B extends boolean> = B extends true ? false : true;

/** The free `all`, the method `all` on a named node, and `current().all` all infer the tuple (DESIGN.md §4.8). */
export function d58(ctx: Context, a: Task<[number], number>, b: Task<[string], string>): void {
  const _viaFree = all([a.bind(1), b.bind('x')]);
  const _viaMethod = ctx.all([a.bind(1), b.bind('x')]);
  const _viaCurrent = current().all([b.bind('x'), a.bind(1)]);
  type _Free = Expect<Equal<typeof _viaFree, Op<[number, string]>>>;
  type _Method = Expect<Equal<typeof _viaMethod, Op<[number, string]>>>;
  type _Current = Expect<Equal<typeof _viaCurrent, Op<[string, number]>>>;
}

/** `attempt` resolves with the four-way outcome, free, as a method and on a task (DESIGN.md §4.5); `E = never` here (D42). */
export function attemptTypes(ctx: Context, a: Task<[number], number>): void {
  const _viaFree = attempt(a, 1);
  const _viaMethod = ctx.attempt(a, 1);
  const _viaTask = a.attempt(1);
  const _inline = attempt(function* (s: string) {
    return s.length;
  }, 'x');
  type _Free = Expect<Equal<typeof _viaFree, Op<Outcome<number, never>>>>;
  type _Method = Expect<Equal<typeof _viaMethod, Op<Outcome<number, never>>>>;
  type _Task = Expect<Equal<typeof _viaTask, Op<Outcome<number, never>>>>;
  type _Inline = Expect<Equal<typeof _inline, Op<Outcome<number, never>>>>;
  // @ts-expect-error -- the arguments are the task's
  void attempt(a, 'not a number');
}

/** `settle` infers the tuple of four-way outcomes, free and as a method; `SettleResult` names it (DESIGN.md §4.8). */
export function settleTypes(ctx: Context, a: Task<[number], number>, b: Task<[string], string>): void {
  const _viaFree = settle([a.bind(1), b.bind('x')]);
  const _viaMethod = ctx.settle([b.bind('x'), a.bind(1)], { timeoutMs: 100 });
  const _empty = settle([]);
  type _Free = Expect<Equal<typeof _viaFree, Op<[Outcome<number, never>, Outcome<string, never>]>>>;
  type _Method = Expect<Equal<typeof _viaMethod, Op<[Outcome<string, never>, Outcome<number, never>]>>>;
  type _Empty = Expect<Equal<typeof _empty, Op<[]>>>;
  type _Named = Expect<Equal<SettleResult<[Task<[], number>]>, [Outcome<number, never>]>>;
}

/** I27: a task is an object, never a callable bare promise. */
export function i27(t: Task<[number], number>): void {
  // @ts-expect-error -- I27: a Task has no call signature
  t(1);
  // @ts-expect-error -- I27: nor has one made by bind()
  t.bind(1)();
}

/** `Fiber` is an interface only; there is no `Fiber` namespace object (DESIGN.md §4.5). */
// @ts-expect-error -- Fiber is a type, never a value
export const fiberNamespace = ramme.Fiber;

/** `runSync` is the ambient function of DESIGN.md §4.11, `current().runSync(fn, ...args)`. */
type _RunSync = Expect<Equal<typeof ramme.runSync, <R, A extends unknown[]>(fn: (...args: A) => R, ...args: A) => R>>;

/** `sleep` is a free function and a method, both an op over a timer (DESIGN.md §4.14, D34). */
type _Sleep = Expect<Equal<typeof ramme.sleep, (ms: number) => Op<void>>>;
type _SleepMethod = Expect<Equal<ReturnType<Context['sleep']>, Op<void>>>;

/** `shield` takes a task or a body as `call` does, free and as a method, and resolves with its value (D39, DESIGN.md §4.2). */
export function shields(ctx: Context, t: Task<[number], string>): void {
  const _free = ramme.shield(t, 1);
  const _body = ramme.shield(function* (n: number) {
    return n * 2;
  }, 21);
  const _method = ctx.shield(() => 'done');
  type _Free = Expect<Equal<typeof _free, Op<string>>>;
  type _Body = Expect<Equal<typeof _body, Op<number>>>;
  type _Method = Expect<Equal<typeof _method, Op<string>>>;
  // @ts-expect-error -- the arguments are the task's, as for call
  void ramme.shield(t, 'one');
}

/** `unshield` takes a task or a body as `attempt` does, free and as a method, and resolves with the outcome (D39, DESIGN.md §4.2). */
export function unshields(ctx: Context, t: Task<[number], string>): void {
  const _free = ramme.unshield(t, 1);
  const _body = ramme.unshield(function* (n: number) {
    return n * 2;
  }, 21);
  const _method = ctx.unshield(() => 'done');
  type _Free = Expect<Equal<typeof _free, Op<Outcome<string, never>>>>;
  type _Body = Expect<Equal<typeof _body, Op<Outcome<number, never>>>>;
  type _Method = Expect<Equal<typeof _method, Op<Outcome<string, never>>>>;
  type _AsAttempt = Expect<Equal<typeof ramme.unshield, typeof ramme.attempt>>;
  // @ts-expect-error -- the arguments are the task's, as for attempt
  void ramme.unshield(t, 'one');
}

// --- Generator bodies (DESIGN.md §4.14, D41) ----------------------------------

/**
 * An op is an `Operation` and a plain thenable, no `Promise` (D41, decision 4); the lifecycle verbs return one that is a
 * `Promise` too (decision 2); a generator helper is an `Operation`; `Awaited` reads the value.
 */
type _OpIsOperation = Expect<Op<number> extends Operation<number> ? true : false>;
type _OpIsThenable = Expect<Op<number> extends PromiseLike<number> ? true : false>;
type _OpIsNoPromise = Expect<Not<Op<number> extends Promise<number> ? true : false>>;
type _CloseIsPromise = Expect<Equal<ReturnType<Context['close']>, Op<void> & Promise<void>>>;
type _ReleaseIsPromise = Expect<Equal<ReturnType<typeof ramme.release>, Op<void> & Promise<void>>>;
type _HelperIsOperation = Expect<Generator<Instruction, number, unknown> extends Operation<number> ? true : false>;
type _AwaitedOp = Expect<Equal<Awaited<Op<number>>, number>>;
/** `Instruction` is opaque: no plain object is one. */
type _Opaque = Expect<Not<{ readonly status: 'x' } extends Instruction ? true : false>>;

/** `yield*` infers through verbs, helpers and tasks; a generator that only throws is `never`; a plain body is its value. */
export function generatorBodies(t: Task<[string], number>): void {
  function* helper(n: number) {
    yield* ramme.sleep(n);
    return String(n);
  }
  const _fromGenerator = ramme.task(function* (id: string) {
    const n = yield* ramme.call(t, id);
    return yield* helper(n);
  });
  const _throws = ramme.task(function* (): Generator<Instruction, never, unknown> {
    throw new Error('x');
  });
  const _returnsOp = ramme.task(() => ramme.call(t, 'x'));
  const _plain = ramme.task(() => [1, 2]);
  const _text = ramme.task(() => 'x');
  type _Helper = Expect<Equal<ReturnType<typeof helper>, Generator<Instruction, string, unknown>>>;
  type _FromGenerator = Expect<Equal<typeof _fromGenerator, Task<[id: string], string>>>;
  type _Throws = Expect<Equal<typeof _throws, Task<[], never>>>;
  type _ReturnsOp = Expect<Equal<typeof _returnsOp, Task<[], number>>>;
  type _Plain = Expect<Equal<typeof _plain, Task<[], number[]>>>;
  type _Text = Expect<Equal<typeof _text, Task<[], string>>>;
  type _BodyArm = Expect<(() => Generator<Instruction, string, unknown>) extends Body<string> ? true : false>;
  // @ts-expect-error -- a yielded value that is not an op's instruction: `yield op` without the star
  void ramme.task(function* () {
    yield ramme.sleep(1);
  });
}

/** `wait` takes a promise or a function of the signal; `promised` keeps the arguments and returns a real promise. */
export function waitAndPromised(ctx: Context): void {
  const _w = wait(Promise.resolve(1));
  const _ws = wait((s: AbortSignal) => Promise.resolve(s.aborted), { abandon: true });
  const _wm = ctx.wait(Promise.resolve('x'));
  const _p = promised(function* (tx: string, n: number) {
    yield* ramme.sleep(n);
    return tx.length;
  });
  const _pm = ctx.promised(() => true);
  type _W = Expect<Equal<typeof _w, Op<number>>>;
  type _Ws = Expect<Equal<typeof _ws, Op<boolean>>>;
  type _Wm = Expect<Equal<typeof _wm, Op<string>>>;
  type _P = Expect<Equal<typeof _p, (tx: string, n: number) => Promise<number>>>;
  type _Pm = Expect<Equal<typeof _pm, () => Promise<boolean>>>;
}

/** A release may be a generator function or return an op; a failure handler may be a generator function. */
export function generatorReleases(ctx: Context): void {
  const _gen: Release<{ id: number }> = function* (v) {
    yield* ramme.sleep(v.id);
  };
  const _op: Release<object> = () => ramme.sleep(1);
  ctx.own({ id: 1 }, function* (v) {
    yield* ramme.sleep(v.id);
  });
  void ramme.task(() => 1, {
    onFailure: function* (e) {
      yield* ramme.sleep(e instanceof Error ? 1 : 2);
    },
  });
}

/**
 * The core's values, exactly: 56 of the 87 names the surface check lists (scripts/check-surface.mjs), which also
 * checks the 31 types, which a namespace object does not carry.
 */
type _CoreValues = Expect<
  Equal<
    keyof typeof ramme,
    | 'createRootContext' | 'task'
    | 'current' | 'signal' | 'lookup' | 'own' | 'release' | 'releaseAll' | 'fork' | 'call' | 'attempt' | 'all'
    | 'race' | 'settle' | 'shield' | 'unshield' | 'pool' | 'child' | 'join' | 'result' | 'interrupted' | 'never'
    | 'sleep' | 'wait' | 'promised' | 'fail' | 'runSync'
    | 'inject' | 'ContextKey'
    | 'NoCurrentNodeError' | 'NodeCompletedError' | 'PendingNodeError' | 'NotOwnedError' | 'AlreadyOwnedError'
    | 'FiberNotAwaitableError' | 'FiberAbortedError' | 'PoolClosedError'
    | 'PoolFullError' | 'CreationViolationError' | 'FactoryReturnedUndefinedError' | 'AsyncRunError'
    | 'PlacementError' | 'OwnerInterrupt'
    | 'createInjectionKey' | 'setScope' | 'setDependencies'
    | 'classProvider' | 'factoryProvider' | 'valueProvider' | 'aliasProvider'
    | 'createScope' | 'SelfScope' | 'RootScope' | 'RequestScope'
    | 'createTopic' | 'NodeTopic'
  >
>;

/** An async function is no body (D41, decision 5): a type error wherever a body is taken, the `Promise` arm gone. */
export function asyncBodiesRefused(ctx: Context): void {
  // @ts-expect-error -- an async task body
  void ramme.task(async () => 1);
  // @ts-expect-error -- an async call body
  void ramme.call(async () => 1);
  // @ts-expect-error -- an async fork body, through a node
  void ctx.fork(async () => 1);
  // @ts-expect-error -- an async promised body
  void promised(async (n: number) => n);
  // @ts-expect-error -- a synchronous body returning a promise is no body either
  void ramme.shield(() => Promise.resolve(1));
  // @ts-expect-error -- an async generator task body (PROPOSAL.md §6: the guard refuses an async iterator too)
  void ramme.task(async function* () {
    yield 1;
  });
  // @ts-expect-error -- an async generator call body that yields nothing
  void ramme.call(async function* () {});
  // @ts-expect-error -- an async generator fork body, through a node
  void ctx.fork(async function* () {});
  // @ts-expect-error -- an async generator promised body
  void promised(async function* (n: number) {
    yield n;
  });
}

/** `parent` is the resolution parent, a node or `undefined` (DESIGN.md §2.1, D33). */
type _Parent = Expect<Equal<Context['parent'], Context | undefined>>;

// --- Result (DESIGN.md §4.12, §4.13, D38) ------------------------------------

/** `Result` is plain data; `Outcome` is `Result` plus `defect` and `aborted`, four-way (D42). */
type _Result = Expect<Equal<Result<number, string>, Success<number> | Failure<string>>>;
type _ResultDefault = Expect<Equal<Result<number>, Result<number, unknown>>>;
type _Members = Expect<
  Equal<
    [Success<number>, Failure<string>, Failure],
    [
      { readonly status: 'success'; readonly value: number },
      { readonly status: 'failure'; readonly error: string },
      { readonly status: 'failure'; readonly error: unknown },
    ]
  >
>;
type _Outcome = Expect<
  Equal<
    Outcome<number, string>,
    | { readonly status: 'success'; readonly value: number }
    | { readonly status: 'failure'; readonly error: string }
    | { readonly status: 'defect'; readonly error: unknown }
    | { readonly status: 'aborted'; readonly reason: unknown }
  >
>;
type _OutcomeDefault = Expect<Equal<Outcome<number>, Outcome<number, unknown>>>;
type _OutcomeMinusDefectAborted = Expect<
  Equal<Exclude<Outcome<number, string>, { readonly status: 'defect' | 'aborted' }>, Result<number, string>>
>;

// The readers the `ramme/result` signatures name, unexported there: the value and the error types of a `Result`'s
// members, `never` for a member of the other kind. Taken from the module's own signatures, since two conditional
// types declared apart are never `Equal`; `_Readers` pins what they compute.
type SuccessOf<R extends Result<unknown, unknown>> = ReturnType<typeof unwrap<R>>;
type ErrorOf<R extends Result<unknown, unknown>> = Parameters<Parameters<typeof mapFailure<R, unknown>>[1]>[0];
type _Readers = Expect<
  Equal<
    [
      SuccessOf<Result<number, string>>,
      ErrorOf<Result<number, string>>,
      ErrorOf<Success<number>>,
      SuccessOf<Failure<string>>,
      SuccessOf<Failure<1> | Failure<2> | Success<3>>,
      ErrorOf<Failure<1> | Failure<2> | Success<3>>,
    ],
    [number, string, never, never, 3, 1 | 2]
  >
>;

/**
 * The `ramme/result` signatures, exact. Each helper takes the whole `Result` as one type parameter and reads the
 * value and error types off it, so a `Success`-only argument has error `never` (never `unknown`), and the several
 * `Failure` members of an unannotated function's return type keep every error (`unannotatedSteps` below).
 */
type _Signatures = Expect<
  Equal<
    [
      typeof success,
      typeof failure,
      typeof isSuccess,
      typeof isFailure,
      typeof map,
      typeof mapFailure,
      typeof andThen,
      typeof orElse,
      typeof unwrap,
      typeof unwrapOr,
      typeof collect,
    ],
    [
      <T>(value: T) => Success<T>,
      <E>(error: E) => Failure<E>,
      <R extends Result<unknown, unknown>>(r: R) => r is Extract<R, Success<unknown>>,
      <R extends Result<unknown, unknown>>(r: R) => r is Extract<R, Failure<unknown>>,
      <R extends Result<unknown, unknown>, U>(r: R, f: (v: SuccessOf<R>) => U) => Result<U, ErrorOf<R>>,
      <R extends Result<unknown, unknown>, F>(r: R, f: (e: ErrorOf<R>) => F) => Result<SuccessOf<R>, F>,
      <R extends Result<unknown, unknown>, S extends Result<unknown, unknown>>(
        r: R,
        f: (v: SuccessOf<R>) => S,
      ) => Result<SuccessOf<S>, ErrorOf<R> | ErrorOf<S>>,
      <R extends Result<unknown, unknown>, S extends Result<unknown, unknown>>(
        r: R,
        f: (e: ErrorOf<R>) => S,
      ) => Result<SuccessOf<R> | SuccessOf<S>, ErrorOf<S>>,
      <R extends Result<unknown, unknown>>(r: R) => SuccessOf<R>,
      <R extends Result<unknown, unknown>, U>(r: R, fallback: U) => SuccessOf<R> | U,
      <R extends Result<unknown, unknown>>(rs: readonly R[]) => Result<SuccessOf<R>[], ErrorOf<R>>,
    ]
  >
>;

/**
 * `$` is a generator helper over a `Result` value (D42): the success value as its return, each error yielded as a
 * `Fail`, none for a `Success`. Checked at instantiations, since its signature names an unexported reader.
 */
type _Unwrap = Expect<
  Equal<
    [
      ReturnType<typeof $<Result<number, string>>>,
      ReturnType<typeof $<Success<number>>>,
      ReturnType<typeof $<Failure<1> | Failure<2> | Success<3>>>,
    ],
    [Generator<Fail<string>, number, unknown>, Generator<never, number, unknown>, Generator<Fail<1> | Fail<2>, 3, unknown>]
  >
>;
// @ts-expect-error -- a promise of a Result is no Result: wait for it first, yield* $(yield* wait(p))
void $(Promise.resolve(success(1)));

/** `ramme/result` has no default export and no namespace object: its names are the functions above, `fromThrowing` and `$`; `gen` is retired (D42). */
type _ResultNames = Expect<
  Equal<
    keyof typeof rammeResult,
    | 'success' | 'failure' | 'isSuccess' | 'isFailure' | 'map' | 'mapFailure' | 'andThen' | 'orElse'
    | 'unwrap' | 'unwrapOr' | 'fromThrowing' | 'collect' | '$'
  >
>;

// Each error class has a distinct literal member: TypeScript compares classes by structure, so two bare
// `class X extends Error {}` are one type and the inferred union collapses to one of them.
class UserNotFound extends Error {
  readonly name = 'UserNotFound' as const;
}
class OrderNotFound extends Error {
  readonly name = 'OrderNotFound' as const;
}
interface User {
  readonly id: string;
}
interface Order {
  readonly user: User;
}
declare function getUser(id: string): Promise<Result<User, UserNotFound>>;

/** `fail` is the fourth exit (D42): an `Operation` of `never`, whose `E` is the error's type. */
type _FailVerb = Expect<Equal<typeof fail, <E>(error: E) => Operation<never, E>>>;
type _FailIsNoInstruction = Expect<Not<Fail<unknown> extends Instruction ? true : false>>;
type _InstructionIsNoFail = Expect<Not<Instruction extends Fail<unknown> ? true : false>>;

/** A task's `E` is the exact union of what its body yields, through `$`, `fail` and `call`: `Equal`, not assignability. */
export function bodyUnion(): void {
  const _t = ramme.task(function* (u: Result<User, UserNotFound>, o: Result<Order, OrderNotFound>) {
    const user = yield* $(u);
    const order = yield* $(o);
    if (order.user !== user) yield* fail(new UserNotFound());
    return order;
  });
  type _Union = Expect<Equal<typeof _t, Task<[u: Result<User, UserNotFound>, o: Result<Order, OrderNotFound>], Order, UserNotFound | OrderNotFound>>>;
  type _NotNarrower = Expect<Not<Equal<typeof _t, Task<[u: Result<User, UserNotFound>, o: Result<Order, OrderNotFound>], Order, UserNotFound>>>>;
}

/** A `Success`-only step adds `never`, not `unknown`: mixing `$(success(1))` with `$(r)` is exact. */
export function bodyMixed(): void {
  const _t = ramme.task(function* (r: Result<User, UserNotFound>) {
    const one = yield* $(success(1));
    const user = yield* $(r);
    return { one, user };
  });
  type _Mixed = Expect<Equal<typeof _t, Task<[r: Result<User, UserNotFound>], { one: number; user: User }, UserNotFound>>>;
}

/** `Result` is the interchange type: a body that returns one succeeds with it, data, beside the failures it yields. */
export function bodyReturnsResult(): void {
  const _t = ramme.task(function* (r: Result<User, UserNotFound>) {
    const user = yield* $(r);
    if (user.id === '') return failure('empty id' as const);
    return success(user);
  });
  type _Returned = Expect<Equal<typeof _t, Task<[r: Result<User, UserNotFound>], Failure<'empty id'> | Success<User>, UserNotFound>>>;
}

/** `yield*` over `$` evaluates to `T` itself, a promise included, as the runtime does: never `Awaited<T>`. */
export function bodyUnawaited(p: Promise<number>): void {
  void ramme.task(function* () {
    const v = yield* $(success(p));
    type _V = Expect<Equal<typeof v, Promise<number>>>;
    return v;
  });
}

/** A generator method helper keeps its `this` and its failures: its type names `Fail`, which a library's declaration emit needs. */
export class Repo {
  readonly #prefix = 'u';
  *load(r: Result<User, UserNotFound>) {
    const user = yield* $(r);
    return `${this.#prefix}${user.id}`;
  }
}
type _This = Expect<Equal<ReturnType<Repo['load']>, Generator<Fail<UserNotFound>, string, unknown>>>;

/** A release may yield any `E`: its expected failure is a release failure of its owner, a defect there (D42). */
export function releasesTakeAnyE(ctx: Context, t: Task<[], void, UserNotFound>): void {
  ctx.own({ id: 1 }, function* () {
    yield* ramme.call(t);
  });
  const _release: Release<object> = function* () {
    yield* fail(new UserNotFound());
  };
}

/** `join` and `result` default `E` to `never`: a written `join<T>(f)` is the join of a fiber with no expected failure. */
export function joinTypeArguments(ctx: Context, f: Fiber<number>, g: Fiber<number, UserNotFound>): void {
  const _join = ramme.join<number>(f);
  const _method = ctx.join<number>(f);
  const _result = ramme.result<number>(f);
  const _inferred = ramme.join(g);
  type _Join = Expect<Equal<[typeof _join, typeof _method], [Op<number, never>, Op<number, never>]>>;
  type _Result = Expect<Equal<typeof _result, Op<Outcome<number, never>>>>;
  type _Inferred = Expect<Equal<typeof _inferred, Op<number, UserNotFound>>>;
}

/** `E` comes from the body alone: a `task(…)` inside the array `all` takes is not widened by its contextual type. */
export function inlineMembers(): void {
  const _all = all([ramme.task(function* () { return 1; }), ramme.task(function* () { yield* fail(new UserNotFound()); return 'x'; })]); // prettier-ignore
  const _race = ramme.race([ramme.task(function* () { return 1; })]);
  type _All = Expect<Equal<typeof _all, Op<[number, string], UserNotFound>>>;
  type _Race = Expect<Equal<typeof _race, Op<number, never>>>;
}

/** An annotated helper: `Operation<T, E>` for one that is only `yield*`ed, `Generator<Instruction | Fail<E>, T, unknown>` for a body. */
export function annotations(t: Task<[string], User, UserNotFound>): void {
  function* loadUser(id: string): Operation<User, UserNotFound> {
    return yield* ramme.call(t, id);
  }
  const _body = ramme.task(function* (id: string): Generator<Instruction | Fail<UserNotFound>, string, unknown> {
    return (yield* loadUser(id)).id;
  });
  type _Body = Expect<Equal<typeof _body, Task<[id: string], string, UserNotFound>>>;
  type _OpE = Expect<Equal<ReturnType<typeof t.call>, Op<User, UserNotFound>>>;
}


/** The defaults keep `E`: `andThen` over a success-returning step, `orElse` over a recovery that cannot fail. */
export function resultCombinators(r: Result<number, UserNotFound>): void {
  const _then = andThen(r, (v) => success(v + 1));
  const _else = orElse(r, () => success('fallback'));
  const _map = map(success(1), (v) => v + 1);
  const _collected = collect([r, r]);
  type _Then = Expect<Equal<typeof _then, Result<number, UserNotFound>>>;
  type _Else = Expect<Equal<typeof _else, Result<number | string, never>>>;
  type _Map = Expect<Equal<typeof _map, Result<number, never>>>;
  type _Collected = Expect<Equal<typeof _collected, Result<number[], UserNotFound>>>;
}

class InvalidCard extends Error {
  readonly name = 'InvalidCard' as const;
}
class Insufficient extends Error {
  readonly name = 'Insufficient' as const;
}
class AdminNotFound extends Error {
  readonly name = 'AdminNotFound' as const;
}
interface Admin {
  readonly admin: true;
}
type Receipt = { receipt: number };
declare function getAdmin(id: string): Promise<Result<Admin, AdminNotFound>>;

/** Unannotated: its inferred return type is `Promise<Failure<InvalidCard> | Failure<Insufficient> | Success<Receipt>>`. */
async function charge(n: number) {
  if (n < 0) return failure(new InvalidCard());
  if (n > 100) return failure(new Insufficient());
  return success({ receipt: n });
}

/**
 * An unannotated fallible function has one `Failure` member per error. A `Result<T, E>` parameter takes one
 * candidate for `E` and refuses it; every step here takes it, and a body's task infers the union, as it does over a
 * union of `Result`s.
 */
export async function unannotatedSteps(c: boolean, id: string): Promise<void> {
  const _paid = ramme.task(function* () {
    return yield* $(yield* wait(charge(5)));
  });
  const _either = ramme.task(function* () {
    return yield* $(c ? yield* wait(getUser(id)) : yield* wait(getAdmin(id)));
  });
  type _Paid = Expect<Equal<typeof _paid, Task<[], Receipt, InvalidCard | Insufficient>>>;
  type _Either = Expect<Equal<typeof _either, Task<[], User | Admin, UserNotFound | AdminNotFound>>>;
  const s = await charge(1);
  const _map = map(s, (v) => v.receipt);
  const _mapFailure = mapFailure(s, (e) => e.name);
  const _then = andThen(s, (v) => (v.receipt > 1 ? success(v.receipt) : failure('small' as const)));
  const _else = orElse(s, () => success('none'));
  const _unwrap = unwrap(s);
  const _unwrapOr = unwrapOr(s, 'none' as const);
  const _collected = collect([s, s]);
  type _Map = Expect<Equal<typeof _map, Result<number, InvalidCard | Insufficient>>>;
  type _MapFailure = Expect<Equal<typeof _mapFailure, Result<Receipt, 'InvalidCard' | 'Insufficient'>>>;
  type _Then = Expect<Equal<typeof _then, Result<number, InvalidCard | Insufficient | 'small'>>>;
  type _Else = Expect<Equal<typeof _else, Result<Receipt | string, never>>>;
  type _Unwrap = Expect<Equal<typeof _unwrap, Receipt>>;
  type _UnwrapOr = Expect<Equal<typeof _unwrapOr, Receipt | 'none'>>;
  type _Collected = Expect<Equal<typeof _collected, Result<Receipt[], InvalidCard | Insufficient>>>;
  if (isSuccess(s)) {
    type _Success = Expect<Equal<typeof s, Success<Receipt>>>;
  } else {
    type _Failure = Expect<Equal<typeof s, Failure<InvalidCard> | Failure<Insufficient>>>;
  }
  if (isFailure(s)) {
    type _Failure = Expect<Equal<typeof s, Failure<InvalidCard> | Failure<Insufficient>>>;
  }
}

/**
 * `fromThrowing`: an async function or a promise gives a promise of the `Result`; a plain function, the `Result`; a
 * function whose return type may or may not be a promise, either, as the runtime chains a returned thenable.
 */
export function fromThrowingTypes(fiber: Fiber<number>): void {
  const _async = fromThrowing(async () => 1);
  const _sync = fromThrowing(() => 'x');
  const _promise = fromThrowing(Promise.resolve(true));
  const _any = fromThrowing(() => JSON.parse('1'));
  const _maybe = fromThrowing((): number | Promise<number> => 1);
  const _mixed = fromThrowing((): string | Promise<number> => 'x');
  const _unknown = fromThrowing((): unknown => 1);
  const _fiber = fromThrowing(() => fiber);
  type _Async = Expect<Equal<typeof _async, Promise<Result<number, unknown>>>>;
  type _Sync = Expect<Equal<typeof _sync, Result<string, unknown>>>;
  type _Promise = Expect<Equal<typeof _promise, Promise<Result<boolean, unknown>>>>;
  type _Any = Expect<Equal<typeof _any, Result<any, unknown>>>;
  type _Maybe = Expect<Equal<typeof _maybe, Result<number, unknown> | Promise<Result<number, unknown>>>>;
  type _Mixed = Expect<Equal<typeof _mixed, Result<string, unknown> | Promise<Result<number, unknown>>>>;
  type _Unknown = Expect<Equal<typeof _unknown, Result<unknown, unknown>>>; // says nothing of a thenable (D38)
  type _Fiber = Expect<Equal<typeof _fiber, Result<Fiber<number>, unknown>>>; // a fiber is a value, never chained
}

/** `attempt` on a task returning a `Result` is two layers read with one vocabulary (DESIGN.md §4.12). */
export function attemptResult(t: Task<[string], Result<User, UserNotFound>>): void {
  const _o = attempt(t, 'id');
  type _O = Expect<Equal<typeof _o, Op<Outcome<Result<User, UserNotFound>, never>>>>;
}

// ---------------------------------------------------------------------------
// Providers are checked against the public surface (D37), and take no options (D36)
// ---------------------------------------------------------------------------

/** The class a test fakes: its `#entries` is private, so no other class can have it. */
class SessionCache {
  readonly #entries = new Map<string, string>();
  get(k: string): string | undefined {
    return this.#entries.get(k);
  }
  set(k: string, v: string): void {
    this.#entries.set(k, v);
  }
}
/** SessionCache's public members and a test-only extra: assignable to `Public<SessionCache>`, never to `SessionCache`. */
class FakeSessionCache {
  readonly calls: string[] = [];
  get(k: string): string | undefined {
    this.calls.push(k);
    return undefined;
  }
  set(): void {}
}
/** No `set`: a supertype of SessionCache, from which `T` would be inferred without `NoInfer` (`Provider<MissingMethod>`). */
class MissingMethod {
  get(_k: string): string | undefined {
    return undefined;
  }
}
/** `get` returns a number. */
class WrongReturn {
  get(): number {
    return 0;
  }
  set(): void {}
}
/** `set` takes an unrelated parameter type (method parameters are bivariant: a narrower one would compile). */
class WrongParameter {
  get(): string | undefined {
    return undefined;
  }
  set(_k: { readonly unrelated: true }): void {}
}

/** `Public<T>` is the consumer's view: `#private` members are gone; functions, primitives, `any` and `unknown` pass through. */
export function publicType(fake: FakeSessionCache): void {
  const _view: Public<SessionCache> = fake;
  // @ts-expect-error -- the class itself has #entries, which the fake cannot have
  const _strict: SessionCache = fake;
  type _Fn = Expect<Equal<Public<(e: { id: number }) => void>, (e: { id: number }) => void>>;
  type _Class = Expect<Equal<Public<typeof SessionCache>, typeof SessionCache>>;
  type _String = Expect<Equal<Public<string>, string>>;
  type _Any = Expect<Equal<Public<any>, any>>;
  type _Unknown = Expect<Equal<Public<unknown>, unknown>>;
}

/** A fake with an extra member compiles in each helper, and the provider is still the key's (D37). */
export function providerFakes(): void {
  const _value = valueProvider(SessionCache, new FakeSessionCache());
  const _factory = factoryProvider(SessionCache, () => new FakeSessionCache());
  const _class = classProvider(SessionCache, FakeSessionCache);
  const _alias = aliasProvider(SessionCache, FakeSessionCache);
  type _Value = Expect<Equal<typeof _value, Provider<SessionCache>>>;
  type _Factory = Expect<Equal<typeof _factory, Provider<SessionCache>>>;
  type _Class = Expect<Equal<typeof _class, Provider<SessionCache>>>;
  type _Alias = Expect<Equal<typeof _alias, Provider<SessionCache>>>;
}

/** A fake missing a public method, or with a wrong signature, fails in each helper (D37). */
export function providerMismatches(): void {
  // @ts-expect-error -- missing set
  valueProvider(SessionCache, new MissingMethod());
  // @ts-expect-error -- missing set
  factoryProvider(SessionCache, () => new MissingMethod());
  // @ts-expect-error -- missing set
  classProvider(SessionCache, MissingMethod);
  // @ts-expect-error -- missing set
  aliasProvider(SessionCache, MissingMethod);
  // @ts-expect-error -- get returns a number
  valueProvider(SessionCache, new WrongReturn());
  // @ts-expect-error -- get returns a number
  factoryProvider(SessionCache, () => new WrongReturn());
  // @ts-expect-error -- get returns a number
  classProvider(SessionCache, WrongReturn);
  // @ts-expect-error -- get returns a number
  aliasProvider(SessionCache, WrongReturn);
  // @ts-expect-error -- set takes an unrelated type
  valueProvider(SessionCache, new WrongParameter());
  // @ts-expect-error -- set takes an unrelated type
  factoryProvider(SessionCache, () => new WrongParameter());
  // @ts-expect-error -- set takes an unrelated type
  classProvider(SessionCache, WrongParameter);
  // @ts-expect-error -- set takes an unrelated type
  aliasProvider(SessionCache, WrongParameter);
}

/** An alias target is a class, a function or a token of the key's public type; nothing else (D37). */
export function aliasTargets(): void {
  const Token = createInjectionKey<FakeSessionCache>('Token');
  const _token = aliasProvider(SessionCache, Token);
  const _fn = aliasProvider(SessionCache, () => new FakeSessionCache());
  type _Token = Expect<Equal<typeof _token, Provider<SessionCache>>>;
  type _Fn = Expect<Equal<typeof _fn, Provider<SessionCache>>>;
  // @ts-expect-error -- a token of the wrong type
  aliasProvider(SessionCache, createInjectionKey<number>('n'));
  // @ts-expect-error -- a plain function returning the wrong type
  aliasProvider(SessionCache, () => 42);
}

/** An interface key bound to an implementation class (D37). */
export function interfaceKey(): void {
  interface Mailer {
    send(to: string): Promise<void>;
  }
  const Mailer = createInjectionKey<Mailer>('Mailer');
  class SmtpMailer {
    readonly #host = 'smtp.example.com';
    readonly sent: string[] = [];
    async send(to: string): Promise<void> {
      this.sent.push(`${this.#host}: ${to}`);
    }
  }
  const _class = classProvider(Mailer, SmtpMailer);
  const _alias = aliasProvider(Mailer, SmtpMailer);
  type _Class = Expect<Equal<typeof _class, Provider<Mailer>>>;
  type _Alias = Expect<Equal<typeof _alias, Provider<Mailer>>>;
}

/** A topic receiver keeps its contextual typing; a non-function is refused (D37). */
export function topicProviders(): void {
  const T = createTopic<{ readonly id: number }>('t');
  const _value = valueProvider(T, (_e) => {
    type _E = Expect<Equal<typeof _e, { readonly id: number }>>;
  });
  const _factory = factoryProvider(T, () => (e) => void e.id);
  // @ts-expect-error -- a topic's value is a receiver
  valueProvider(T, 42);
}

/** A provider takes no options: its value is stored where it is registered (D36). */
export function noProviderScope(): void {
  const S = createScope('s');
  const K = createInjectionKey<string>('K');
  // @ts-expect-error -- removed (D36)
  valueProvider(K, 'x', { scope: S });
  // @ts-expect-error -- removed (D36)
  factoryProvider(K, () => 'x', { scope: S });
  // @ts-expect-error -- removed (D36)
  classProvider(SessionCache, SessionCache, { scope: S });
  // @ts-expect-error -- removed (D36)
  aliasProvider(K, K, { scope: S });
  // @ts-expect-error -- removed (D36): a Provider has no scope member
  const _p: Provider<string> = { key: K, provide: () => 'x', scope: S };
}

// Names removed by the redesign: one import per name, which fails if the
// name comes back as a value or as a type. Then the internal names that
// must never leak.

// @ts-expect-error -- removed
import { createContext as _createContext } from 'ramme';
// @ts-expect-error -- removed
import { withAbortSignal as _withAbortSignal } from 'ramme';
// @ts-expect-error -- removed
import { linkAbortSignal as _linkAbortSignal } from 'ramme';
// @ts-expect-error -- removed
import { createFiberSet as _createFiberSet } from 'ramme';
// @ts-expect-error -- removed
import { RegisterResource as _RegisterResource } from 'ramme';
// @ts-expect-error -- removed
import { ContextRefKey as _ContextRefKey } from 'ramme';
// @ts-expect-error -- removed
import { create as _create } from 'ramme';
// @ts-expect-error -- removed
import { registerResource as _registerResource } from 'ramme';
// @ts-expect-error -- removed: the free addProvider; ctx.addProvider stays
import { addProvider as _addProvider } from 'ramme';
// @ts-expect-error -- removed
import { createRefCountedKey as _createRefCountedKey } from 'ramme';
// @ts-expect-error -- removed
import { refCountedProvider as _refCountedProvider } from 'ramme';
// @ts-expect-error -- removed
import { Drain as _Drain } from 'ramme';
// @ts-expect-error -- removed
import { Flush as _Flush } from 'ramme';
// @ts-expect-error -- removed
import { Dispose as _Dispose } from 'ramme';
// @ts-expect-error -- removed
import { Abort as _Abort } from 'ramme';
// @ts-expect-error -- removed
import { resourceProvider as _resourceProvider } from 'ramme';
// @ts-expect-error -- removed
import { ContextTopic as _ContextTopic } from 'ramme';
// @ts-expect-error -- removed
import { FiberTopic as _FiberTopic } from 'ramme';
// @ts-expect-error -- removed
import type { FiberType as _FiberType } from 'ramme';
// @ts-expect-error -- removed
import type { FiberOptions as _FiberOptions } from 'ramme';
// @ts-expect-error -- removed
import type { ForkOptions as _ForkOptions } from 'ramme';
// @ts-expect-error -- removed
import type { FiberResult as _FiberResult } from 'ramme';
// @ts-expect-error -- removed
import type { FiberSet as _FiberSet } from 'ramme';
// @ts-expect-error -- removed
import type { FiberSetOptions as _FiberSetOptions } from 'ramme';
// @ts-expect-error -- removed
import type { FiberSetSpawnOptions as _FiberSetSpawnOptions } from 'ramme';
// @ts-expect-error -- removed
import type { RefCountedKeyOptions as _RefCountedKeyOptions } from 'ramme';
// @ts-expect-error -- removed
import type { ContextRef as _ContextRef } from 'ramme';
// @ts-expect-error -- removed
import type { ManagedResource as _ManagedResource } from 'ramme';
// @ts-expect-error -- removed
import type { ResourceHandle as _ResourceHandle } from 'ramme';
// @ts-expect-error -- removed
import type { RegisterResourceFunction as _RegisterResourceFunction } from 'ramme';
// @ts-expect-error -- removed
import type { ContextEvent as _ContextEvent } from 'ramme';
// @ts-expect-error -- removed
import type { FiberEvent as _FiberEvent } from 'ramme';
// @ts-expect-error -- removed
import type { Created as _Created } from 'ramme';
// @ts-expect-error -- removed
import type { ContextStatus as _ContextStatus } from 'ramme';
// @ts-expect-error -- removed
import type { RunSyncOptions as _RunSyncOptions } from 'ramme';
// @ts-expect-error -- removed
import type { CreateContextOptions as _CreateContextOptions } from 'ramme';
// @ts-expect-error -- removed (D36)
import type { ProviderOptions as _ProviderOptions } from 'ramme';
// @ts-expect-error -- internal: ambient.ts's current-node lookup
import { requireCurrent as _requireCurrent } from 'ramme';
// @ts-expect-error -- internal: NodeImpl is never public; nodes are Contexts
import { NodeImpl as _NodeImpl } from 'ramme';
// @ts-expect-error -- internal: the frame marker is a context-storage detail
import { NO_NODE as _NO_NODE } from 'ramme';
