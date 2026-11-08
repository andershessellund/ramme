// Tests for contracts / expected failure types.
import { afterEach, describe, expect, it } from 'vitest';
import { all, attempt, fail, fork, join, race, result, settle, sleep } from '../../src/ambient.js';
import type { Context, Fiber, Outcome, Result, Task } from '../../src/context.js';
import { task } from '../../src/fiber.js';
import * as core from '../../src/index.js';
import * as resultModule from '../../src/result.js';
import { within } from '../support/util.js';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

type Expect<T extends true> = T;

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

interface Receipt {
  readonly order: Order;
}

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

afterEach(async () => {
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

describe('the surface', () => {
  it('ramme/result exports exactly its 13 functions, gen gone; the core exports fail', () => {
    expect({ result: Object.keys(resultModule).sort(), coreFail: typeof Reflect.get(core, 'fail') }).toEqual({
      result: [
        '$',
        'andThen',
        'collect',
        'failure',
        'fromThrowing',
        'isFailure',
        'isSuccess',
        'map',
        'mapFailure',
        'orElse',
        'success',
        'unwrap',
        'unwrapOr',
      ],
      coreFail: 'function',
    });
  });

  it('types: E is the exact union of the yielded failures, through two call levels and a helper, join, all, race and settle, and never with no fail; Outcome<T, E> is four-way; Task<A, T, E> and Fiber<T, E> carry E', () => {
    // Never run: the bodies below are only type-checked (task() runs nothing).
    const getUser = task(function* (id: string) {
      yield* sleep(0);
      if (id === '') yield* fail(new UserNotFound());
      const user: User = { id };
      return user;
    });
    const getAdmin = task(function* (id: string) {
      yield* sleep(0);
      if (!id.startsWith('admin')) yield* fail(new NotAnAdmin());
      const user: User = { id };
      return user;
    });
    const getOrder = task(function* (user: User) {
      yield* sleep(0);
      if (user.id === 'nobody') yield* fail(new OrderNotFound());
      const order: Order = { user, total: 1 };
      return order;
    });
    /** A helper: shares the caller's node, and its failures join the caller's union. */
    function* loadOrder(id: string) {
      const user = yield* getUser(id);
      return yield* getOrder(user);
    }
    const order = task(function* (id: string) {
      return yield* loadOrder(id);
    });
    const checkout = task(function* (id: string) {
      const o = yield* order(id);
      if (o.total > 100) yield* fail(new PaymentDeclined());
      const receipt: Receipt = { order: o };
      return receipt;
    });
    const failsOnly = task(function* () {
      return yield* fail(new UserNotFound());
    });
    const plain = task(function* (n: number) {
      yield* sleep(0);
      return n;
    });
    const sync = task((n: number) => n * 2);
    const caught = task(function* (id: string) {
      return yield* attempt(getUser, id);
    });
    const viaJoin = task(function* (id: string) {
      const f = fork(getUser, id);
      return yield* join(f);
    });
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
    // A middle level that both calls a failing task and fails itself, twice over, and the groups over such tasks.
    const getAccount = task(function* (id: string) {
      const user = yield* getUser(id);
      if (user.id === 'locked') yield* fail(new NotAnAdmin());
      return user;
    });
    const getAccountOrder = task(function* (id: string) {
      const user = yield* getAccount(id);
      if (user.id === 'unpaid') yield* fail(new PaymentDeclined());
      const accountOrder: Order = { user, total: 1 };
      return accountOrder;
    });
    const allMiddle = task(function* (id: string) {
      return yield* all([getAccount(id), getAccountOrder(id), plain(1)]);
    });
    const raceMiddle = task(function* (id: string) {
      return yield* race([getAccount(id), getAccountOrder(id)]);
    });
    const caughtMiddle = task(function* (id: string) {
      return yield* attempt(getAccountOrder, id);
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
    function forked(id: string) {
      return fork(getUser, id);
    }
    function _forkedCall(id: string) {
      return fork(getUser(id));
    }
    function _attempted(id: string) {
      return attempt(getUser(id));
    }
    function resulted(f: Fiber<User, UserNotFound>) {
      return result(f);
    }

    // E inferred, exactly: a fail, a helper, two levels of call
    type _GetUser = Expect<Equal<typeof getUser, Task<[id: string], User, UserNotFound>>>;
    type _Helper = Expect<Equal<typeof order, Task<[id: string], Order, UserNotFound | OrderNotFound>>>;
    type _TwoLevels = Expect<Equal<typeof checkout, Task<[id: string], Receipt, UserNotFound | OrderNotFound | PaymentDeclined>>>;
    type _FailOnly = Expect<Equal<typeof failsOnly, Task<[], never, UserNotFound>>>;
    // E = never: no fail, a synchronous body, every failure caught by attempt
    type _NoFail = Expect<Equal<typeof plain, Task<[n: number], number, never>>>;
    type _Sync = Expect<Equal<typeof sync, Task<[n: number], number, never>>>;
    type _Caught = Expect<Equal<typeof caught, Task<[id: string], Outcome<User, UserNotFound>, never>>>;
    // a middle level that both calls and fails: E is the plain union at every level, which Exclude and Extract take
    // apart, and so are the groups over such tasks
    type ErrorOfTask<X> = X extends Task<never, unknown, infer E> ? E : never;
    type _Middle = Expect<Equal<typeof getAccount, Task<[id: string], User, UserNotFound | NotAnAdmin>>>;
    type _MiddleTwice = Expect<
      Equal<typeof getAccountOrder, Task<[id: string], Order, UserNotFound | NotAnAdmin | PaymentDeclined>>
    >;
    type _AllMiddle = Expect<
      Equal<typeof allMiddle, Task<[id: string], [User, Order, number], UserNotFound | NotAnAdmin | PaymentDeclined>>
    >;
    type _RaceMiddle = Expect<
      Equal<typeof raceMiddle, Task<[id: string], User | Order, UserNotFound | NotAnAdmin | PaymentDeclined>>
    >;
    type _CaughtMiddle = Expect<
      Equal<typeof caughtMiddle, Task<[id: string], Outcome<Order, UserNotFound | NotAnAdmin | PaymentDeclined>, never>>
    >;
    type _Exclude = Expect<Equal<Exclude<ErrorOfTask<typeof getAccountOrder>, UserNotFound>, NotAnAdmin | PaymentDeclined>>;
    type _Extract = Expect<Equal<Extract<ErrorOfTask<typeof allMiddle>, NotAnAdmin>, NotAnAdmin>>;
    type _InlineAll = Expect<Equal<typeof inlineAll, Task<[], [number, number], UserNotFound>>>;
    // join, all and race re-yield; settle returns the outcomes
    type _Join = Expect<Equal<typeof viaJoin, Task<[id: string], User, UserNotFound>>>;
    type _All = Expect<Equal<typeof viaAll, Task<[id: string], [User, Order], UserNotFound | OrderNotFound>>>;
    type _Race = Expect<Equal<typeof viaRace, Task<[id: string], User, UserNotFound | NotAnAdmin>>>;
    type _Settle = Expect<
      Equal<typeof viaSettle, Task<[id: string], [Outcome<User, UserNotFound>, Outcome<Order, OrderNotFound>], never>>
    >;
    // Task<A, T, E = never> and Fiber<T, E>
    type _TaskDefault = Expect<Equal<Task<[], number>, Task<[], number, never>>>;
    type _With = Expect<Equal<ReturnType<typeof getUser.with>, Task<[id: string], User, UserNotFound>>>;
    type _Fork = Expect<Equal<ReturnType<typeof _forkedCall>, Fiber<User, UserNotFound>>>;
    type _FreeFork = Expect<Equal<ReturnType<typeof forked>, Fiber<User, UserNotFound>>>;
    type _Call = Expect<Equal<Awaited<ReturnType<typeof getUser>>, User>>;
    type _Attempt = Expect<Equal<Awaited<ReturnType<typeof _attempted>>, Outcome<User, UserNotFound>>>;
    type _Result = Expect<Equal<Awaited<ReturnType<typeof resulted>>, Outcome<User, UserNotFound>>>;
    type _FiberOutcome = Expect<Equal<Fiber<User, UserNotFound>['outcome'], Outcome<User, UserNotFound> | undefined>>;
    // Outcome<T, E = unknown>: success(T) | failure(E) | defect(unknown) | aborted; minus defect and aborted, a Result
    type O = Outcome<number, UserNotFound>;
    type _Statuses = Expect<Equal<O['status'], 'success' | 'failure' | 'defect' | 'aborted'>>;
    type _SuccessValue = Expect<Equal<Extract<O, { status: 'success' }>['value'], number>>;
    type _FailureError = Expect<Equal<Extract<O, { status: 'failure' }>['error'], UserNotFound>>;
    type _DefectError = Expect<Equal<Extract<O, { status: 'defect' }>['error'], unknown>>;
    type _DefectKeys = Expect<Equal<keyof Extract<O, { status: 'defect' }>, 'status' | 'error'>>;
    type _AbortedReason = Expect<Equal<Extract<O, { status: 'aborted' }>['reason'], unknown>>;
    type _IsResult = Expect<Equal<Exclude<O, { status: 'defect' | 'aborted' }>, Result<number, UserNotFound>>>;
    type _OutcomeDefault = Expect<Equal<Outcome<number>, Outcome<number, unknown>>>;
    // Making a task runs nothing: each is a task, a function, and no body above ran.
    const made = [checkout, failsOnly, plain, sync, caught, viaJoin, viaAll, viaRace, viaSettle];
    const middle = [getAccountOrder, allMiddle, raceMiddle, caughtMiddle, inlineAll];
    expect([...made.map((t) => typeof t.with), ...middle.map((t) => typeof t.with), typeof forked, typeof resulted]).toEqual(
      Array(16).fill('function'),
    );
  });
});
