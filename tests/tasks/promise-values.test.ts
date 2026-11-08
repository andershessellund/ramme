// Tests for tasks / promise values.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, attempt, fork, join, promised, result, settle, sleep, wait } from '../../src/ambient.js';
import type { AllResult, Context, Op, Outcome, SettleResult, Task } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { within } from '../support/util.js';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

type Expect<T extends true> = T;

/** Every `console.warn` of the current test, first argument only; the spy keeps them off the console. */
const warnings: string[] = [];

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

beforeEach(() => {
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

describe('all and settle keep a promise a generator body returns', () => {
  it('the member value of all([p()]), all([p]), settle([p()]) and settle([p]) is the promise p’s body returned, unflattened; promised’s real promise flattens it', async () => {
    const made: Promise<number>[] = [];
    const p = task(function* p() {
      yield* sleep(0);
      const promise = Promise.resolve(1); // a value: `return promise`, never `return yield* wait(promise)`
      made.push(promise);
      return promise;
    });
    const seen = await within(
      app().call(function* () {
        const [viaOp] = yield* all([p()]);
        const [viaTask] = yield* all([p]);
        const [outcome] = yield* settle([p()]);
        const [taskOutcome] = yield* settle([p]);
        const viaPromised: unknown = yield* wait(promised(p)()); // a real promise: resolved with p's promise, it adopts it
        return {
          viaOp: viaOp as unknown,
          viaTask: viaTask as unknown,
          viaSettle: outcome.status === 'success' ? (outcome.value as unknown) : outcome,
          viaSettleTask: taskOutcome.status === 'success' ? (taskOutcome.value as unknown) : taskOutcome,
          viaPromised,
        };
      }),
    );
    expect({
      viaOp: seen.viaOp === made[0],
      viaTask: seen.viaTask === made[1],
      viaSettle: seen.viaSettle === made[2],
      viaSettleTask: seen.viaSettleTask === made[3],
      viaPromised: seen.viaPromised,
      resolved: await Promise.all(made),
    }).toEqual({ viaOp: true, viaTask: true, viaSettle: true, viaSettleTask: true, viaPromised: 1, resolved: [1, 1, 1, 1, 1] });
  });
});

describe('the types', () => {
  it('all([p()]) with p: Task<[], Promise<number>> is Op<[Promise<number>]>, settle([p()]) and settle([p]) Op<[Outcome<Promise<number>, never>]>; AllResult and SettleResult apply no Awaited, to an op member or a task member; join, result and attempt carry none; then and promised’s real promise flatten', () => {
    // Never run: the bodies below are only type-checked (`pnpm typecheck`; vitest's expectTypeOf is a no-op).
    function types(): void {
      const p = task(function* p() {
        yield* sleep(0);
        return Promise.resolve(1);
      });
      const viaOp = all([p()]);
      const viaTask = all([p]);
      const viaSettle = settle([p()]);
      const viaSettleTask = settle([p]);
      const viaPromised = promised(p);
      type _SettleTask = Expect<Equal<typeof viaSettleTask, Op<[Outcome<Promise<number>, never>], never>>>;
      // promised's function returns a real promise, which adopts the one the body returned.
      type _Promised = Expect<Equal<typeof viaPromised, () => Promise<number>>>;
      function* verbs() {
        const f = fork(p);
        const joined = yield* join(f);
        const resulted = yield* result(f);
        const attempted = yield* attempt(p());
        type _Join = Expect<Equal<typeof joined, Promise<number>>>;
        type _Result = Expect<Equal<typeof resulted, Outcome<Promise<number>, never>>>;
        type _Attempt = Expect<Equal<typeof attempted, Outcome<Promise<number>, never>>>;
        return [joined, resulted, attempted];
      }
      type _P = Expect<Equal<typeof p, Task<[], Promise<number>, never>>>;
      type _All = Expect<Equal<typeof viaOp, Op<[Promise<number>], never>>>;
      type _AllTask = Expect<Equal<typeof viaTask, Op<[Promise<number>], never>>>;
      type _Settle = Expect<Equal<typeof viaSettle, Op<[Outcome<Promise<number>, never>], never>>>;
      type _AllResult = Expect<Equal<AllResult<readonly [Op<Promise<number>>, Task<[], Promise<string>>]>, [Promise<number>, Promise<string>]>>;
      type _SettleResult = Expect<
        Equal<
          SettleResult<readonly [Op<Promise<number>>, Task<[], Promise<string>>]>,
          [Outcome<Promise<number>, never>, Outcome<Promise<string>, never>]
        >
      >;
      // The two legitimate Awaited: a promise consumer of an op, and promised's real promise (above), since a promise
      // resolving with a promise flattens.
      type _Then = Expect<Equal<Awaited<Op<Promise<number>>>, number>>;
      expect([typeof verbs, viaOp, viaTask, viaSettle, viaSettleTask, viaPromised].length).toBe(6);
    }
    expect(typeof types).toBe('function');
  });
});
