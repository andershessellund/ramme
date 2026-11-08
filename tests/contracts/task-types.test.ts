// Tests for contracts / task types.
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { all, attempt, fail, fork, pool, race, settle, sleep } from '../../src/ambient.js';
import { createKeyFor } from '../../src/context-key.js';
import type { InjectionKey } from '../../src/context-key.js';
import type { AllResult, Context, Fiber, Op, Outcome, SettleResult, Task } from '../../src/context.js';
import { task } from '../../src/fiber.js';
import * as core from '../../src/index.js';
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

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

afterEach(async () => {
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

describe('the surface', () => {
  it('the core exports createKeyFor and excludes the free verb call', () => {
    expect({ createKeyFor: typeof Reflect.get(core, 'createKeyFor'), call: Reflect.has(core, 'call') }).toEqual({
      createKeyFor: 'function',
      call: false,
    });
  });
});

describe('the types (decisions 1–4, 6, 7)', () => {
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
