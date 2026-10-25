// stage3-pin.test.ts — the pinning tests of D41's stage 3, expected failures as a typed channel (PROPOSAL.md §3.6,
// decision 15 (b′), decided; §8 "PR 3"), written first.
//
// Each test asserts a fact of the runtime once an expected failure is a fourth way for a body to end, which stage 2
// does not have yet: `yield* fail(e)` ends the body with `failure(e)` and runs its `finally` as on a halt; a `fail` in a
// halted `finally` is a release failure (it cannot change `aborted`); `Outcome` is four-way, a throw a `defect`;
// `call`, `join`, `all` and `race` re-yield a child's `fail` into the caller, while `attempt`, `result` and `settle`
// return the four-way outcome; an unjoined fork's expected failure is routed as a defect is (a linked child's aborts
// the parent, which surfaces it as its own `defect`: a parent cannot be given a typed failure it did not declare); a
// release failure amends the outcome by the four-way table (DESIGN.md §4.12); `gen` is retired and `$` is a generator
// helper over a `Result` value. The types: `E` is inferred on `Task<A, T, E>` and `Fiber<T, E>` as the exact union of
// the yielded failures, through calls, helpers and the groups, `never` with no `fail`.
//
// `fail` comes from ambient.js and the types from context.js, so on the stage-2 tree this file fails to typecheck only
// for what stage 3 adds: the missing export and the types' new parameter. `$` is reached through a cast for the same
// reason (`unwrapResult`).
//
// Each test first compares one observation object, so that a failure shows the whole of the behaviour in its diff.
// Outcomes are read as strings (`show`), errors named by identity among the test's own (`label`).
import { afterEach, describe, expect, it } from 'vitest';
import {
  all,
  attempt,
  call,
  fail,
  fork,
  join,
  never,
  own,
  promised,
  race,
  result,
  settle,
  signal,
  sleep,
  wait,
} from './ambient.js';
import type { Context, Fiber, Operation, Outcome, Result, Task } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import * as core from './index.js';
import * as resultModule from './result.js';
import { $, failure, success } from './result.js';
import { events, trace, within } from './test/util.js';
import type { EventLog } from './test/util.js';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Each error class has a distinct literal member: TypeScript compares classes by structure, so two bare
// `class X extends Error {}` are one type and an inferred union would collapse to one of them (result.test.ts).
class Boom extends Error {
  readonly name = 'Boom' as const;
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
interface Receipt {
  readonly order: Order;
}

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

/** `x` as an observation reads it: a known value by its name; a SuppressedError or AggregateError by its parts; another error by class and message. */
function label(x: unknown, known: Known = {}): string {
  for (const [name, v] of Object.entries(known)) if (v === x) return name;
  if (typeof x === 'object' && x !== null && 'suppressed' in x && 'error' in x) {
    const s = x as { error: unknown; suppressed: unknown };
    return `SuppressedError(error: ${label(s.error, known)}, suppressed: ${label(s.suppressed, known)})`;
  }
  if (x instanceof AggregateError) return `AggregateError(${x.errors.map((e: unknown) => label(e, known)).join(', ')})`;
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

/**
 * `$` as a body runs it: `yield* $(r)` is `r`'s value, or ends the body with `r`'s failure (stage 3 makes `$` a
 * generator helper that yields it). Typed here as an `Operation` of the value alone, so that on the stage-2 tree, where
 * `$` is `gen`'s async iterator, the type errors of this file are only `fail`'s and the stage-3 types'; the runtime is
 * `$` itself.
 */
const unwrapResult = $ as unknown as <V>(r: Result<V, unknown>) => Operation<V>;

describe('stage 3: yield* fail(e), the fourth exit', () => {
  it('yield* fail(e) ends the body at once with failure(e): no catch sees it, nothing after it runs, and its finally runs, and may wait, as on a halt', async () => {
    const root = app();
    const e = new Boom('expected');
    const t = trace();
    const o = await within(
      root.attempt(function* () {
        try {
          t.push('before');
          yield* fail(e);
          t.push('after fail');
        } catch (x) {
          t.push(`catch ${label(x, { e })}`);
        } finally {
          t.push('finally');
          yield* sleep(1);
          t.push('finally waited');
        }
        t.push('after try');
        return 'returned';
      }),
    );
    expect({ outcome: show(o, { e }), log: t.log }).toEqual({
      outcome: 'failure(e)',
      log: ['before', 'finally', 'finally waited'],
    });
    await within(root.close()); // attempt consumed the failure
  });

  it('a fail in a halted finally is a release failure: the body settles aborted by state (D24), the fail ends that finally, and the release failure amends the outcome to defect(e)', async () => {
    const ev = recorded();
    const e = new Boom('in the halted finally');
    const stop = new Error('stop');
    const t = trace();
    const seen = await within(
      ev.root.call(function* () {
        const f = fork(
          task(
            function* () {
              try {
                t.push('body');
                yield* never();
              } finally {
                t.push('finally');
                yield* fail(e);
                t.push('after fail');
              }
            },
            { name: 'halted' },
          ),
        );
        yield* sleep(1);
        f.abort(stop);
        return { id: f.id, outcome: yield* result(f) };
      }),
    );
    expect({
      log: t.log,
      settled: ev.of('node:settled').filter((x) => x.id === seen.id).map((x) => x.outcome),
      outcome: show(seen.outcome, { e, stop }),
    }).toEqual({
      log: ['body', 'finally'],
      settled: ['aborted'], // the classification at settling: the fail cannot change aborted
      outcome: 'defect(e)', // aborted + a release failure → defect (the amendment table)
    });
  });

  it('attempt returns the four-way outcome: failure(e) for a fail, defect(d) for a throw, aborted for an abort, success otherwise', async () => {
    const root = app();
    const e = new Boom('expected');
    const d = new Error('defect');
    const stop = new Error('stop');
    const known = { e, d, stop };
    const seen = await within(
      root.call(function* () {
        const failed = show(
          yield* attempt(function* () {
            yield* sleep(0);
            yield* fail(e);
            return 1;
          }),
          known,
        );
        const threw = show(
          yield* attempt(function* () {
            yield* sleep(0);
            throw d;
          }),
          known,
        );
        const ac = new AbortController();
        setTimeout(() => ac.abort(stop), 1);
        const aborted = show(
          yield* attempt(
            task(
              function* () {
                yield* never();
              },
              { signal: ac.signal },
            ),
          ),
          known,
        );
        const succeeded = show(
          yield* attempt(function* () {
            yield* sleep(0);
            return 1;
          }),
          known,
        );
        return { fail: failed, throw: threw, abort: aborted, success: succeeded };
      }),
    );
    expect(seen).toEqual({ fail: 'failure(e)', throw: 'defect(d)', abort: 'aborted(stop)', success: 'success(1)' });
    await within(root.close()); // every failure was consumed by its attempt
  });
});

describe('stage 3: propagation through call and join', () => {
  it("call and join re-yield a child's fail: the caller ends failure(e), no catch run, its finally run; a child's defect is thrown into the caller, which catches it", async () => {
    const root = app();
    const e = new Boom('expected');
    const d = new Error('defect');
    const known = { e, d };
    const failing = task(
      function* () {
        yield* sleep(0);
        yield* fail(e);
      },
      { name: 'failing' },
    );
    const throwing = task(
      function* () {
        yield* sleep(0);
        throw d;
      },
      { name: 'throwing' },
    );
    const logs = { callFail: [] as string[], callDefect: [] as string[], joinFail: [] as string[], joinDefect: [] as string[] };
    const callFail = await within(
      root.attempt(function* () {
        try {
          yield* call(failing);
          logs.callFail.push('after call');
        } catch (x) {
          logs.callFail.push(`catch ${label(x, known)}`);
        } finally {
          logs.callFail.push('finally');
        }
        return 'returned';
      }),
    );
    const callDefect = await within(
      root.attempt(function* () {
        try {
          yield* call(throwing);
          logs.callDefect.push('after call');
        } catch (x) {
          logs.callDefect.push(`catch ${label(x, known)}`);
        } finally {
          logs.callDefect.push('finally');
        }
        return 'returned';
      }),
    );
    const joinFail = await within(
      root.attempt(function* () {
        const f = fork(failing);
        try {
          yield* join(f);
          logs.joinFail.push('after join');
        } catch (x) {
          logs.joinFail.push(`catch ${label(x, known)}`);
        } finally {
          logs.joinFail.push('finally');
        }
        return 'returned';
      }),
    );
    const joinDefect = await within(
      root.attempt(function* () {
        const f = fork(throwing);
        try {
          yield* join(f);
          logs.joinDefect.push('after join');
        } catch (x) {
          logs.joinDefect.push(`catch ${label(x, known)}`);
        } finally {
          logs.joinDefect.push('finally');
        }
        return 'returned';
      }),
    );
    expect({
      callFail: { outcome: show(callFail, known), log: logs.callFail },
      callDefect: { outcome: show(callDefect, known), log: logs.callDefect },
      joinFail: { outcome: show(joinFail, known), log: logs.joinFail },
      joinDefect: { outcome: show(joinDefect, known), log: logs.joinDefect },
    }).toEqual({
      // exactly failure(e): the re-yield consumed the child's failure, or the caller's completion would amend it
      callFail: { outcome: 'failure(e)', log: ['finally'] },
      callDefect: { outcome: 'success("returned")', log: ['catch d', 'finally'] },
      joinFail: { outcome: 'failure(e)', log: ['finally'] },
      joinDefect: { outcome: 'success("returned")', log: ['catch d', 'finally'] },
    });
    await within(root.close());
  });
});

describe('stage 3: all, race and settle', () => {
  it("all fails on a member's fail as on a defect (D28: the sibling runs to its end either way), and re-yields it: the caller ends failure(e), no catch run", async () => {
    const root = app();
    const e = new Boom('expected');
    const d = new Error('defect');
    const known = { e, d };
    async function once(kind: 'fail' | 'defect'): Promise<{ outcome: string; caller: string[]; sibling: string[] }> {
      const caller: string[] = [];
      const sibling: string[] = [];
      const member = task(
        function* () {
          yield* sleep(0);
          if (kind === 'fail') yield* fail(e);
          else throw d;
          return 1;
        },
        { name: 'member' },
      );
      const other = task(
        function* () {
          try {
            sibling.push('start');
            yield* sleep(5);
            sibling.push('end');
          } finally {
            sibling.push('finally');
          }
          return 2;
        },
        { name: 'sibling' },
      );
      const o = await within(
        root.attempt(function* () {
          try {
            yield* all([member.bind(), other.bind()]);
            caller.push('after all');
          } catch (x) {
            caller.push(`catch ${label(x, known)}`);
          } finally {
            caller.push('finally');
          }
          return 'returned';
        }),
      );
      return { outcome: show(o, known), caller, sibling };
    }
    const onDefect = await once('defect');
    const onFail = await once('fail');
    expect({ onDefect, onFail }).toEqual({
      onDefect: { outcome: 'success("returned")', caller: ['catch AggregateError(d)', 'finally'], sibling: ['start', 'end', 'finally'] },
      onFail: { outcome: 'failure(e)', caller: ['finally'], sibling: ['start', 'end', 'finally'] },
    });
    await within(root.close());
  });

  it("race: a member's fail does not beat a later success (as a defect does not, D28); a race with no success re-yields its member's fail: the caller ends failure(e)", async () => {
    const root = app();
    const e = new Boom('expected');
    const won = await within(
      root.attempt(function* () {
        return yield* race([
          task(
            function* () {
              yield* fail(e);
              return 'fast';
            },
            { name: 'fast' },
          ).bind(),
          task(
            function* () {
              yield* sleep(5);
              return 'won';
            },
            { name: 'slow' },
          ).bind(),
        ]);
      }),
    );
    const lost = await within(
      root.attempt(function* () {
        try {
          return yield* race([
            task(
              function* () {
                yield* sleep(0);
                yield* fail(e);
                return 'never';
              },
              { name: 'only' },
            ).bind(),
          ]);
        } catch (x) {
          return `caught ${label(x, { e })}`;
        }
      }),
    );
    expect({ won: show(won, { e }), lost: show(lost, { e }) }).toEqual({ won: 'success("won")', lost: 'failure(e)' });
    await within(root.close()); // the loser's failure is not the race's, and is consumed
  });

  it('settle resolves with the four-way outcomes in order, never failing the caller: failure(e), defect(d), aborted, success', async () => {
    const root = app();
    const e = new Boom('expected');
    const d = new Error('defect');
    const stop = new Error('stop');
    const known = { e, d, stop };
    const seen = await within(
      root.call(function* () {
        const ac = new AbortController();
        setTimeout(() => ac.abort(stop), 5);
        const outcomes = yield* settle([
          task(function* () {
            yield* sleep(0);
            yield* fail(e);
            return 1;
          }).bind(),
          task(function* () {
            yield* sleep(0);
            throw d;
          }).bind(),
          task(
            function* () {
              yield* never();
            },
            { signal: ac.signal },
          ).bind(),
          task(function* () {
            yield* sleep(0);
            return 1;
          }).bind(),
        ]);
        return outcomes.map((o) => show(o, known));
      }),
    );
    expect(seen).toEqual(['failure(e)', 'defect(d)', 'aborted(stop)', 'success(1)']);
    await within(root.close()); // settle consumed every member's failure
  });
});

describe('stage 3: routing an unjoined fork’s expected failure (D14, D23, D28, D42)', () => {
  it("a linked child's fail aborts its parent, which surfaces it as its own defect(e) (a parent cannot be given a typed failure it did not declare): halted, no catch run, its finally run", async () => {
    const root = app();
    const e = new Boom('expected');
    const t = trace();
    const o = await within(
      root.attempt(function* () {
        fork(
          task(
            function* () {
              yield* sleep(0);
              yield* fail(e);
            },
            { name: 'linked', onFailure: 'link' },
          ),
        );
        try {
          yield* never();
          t.push('after never');
        } catch (x) {
          t.push(`catch ${label(x, { e })}`);
        } finally {
          t.push(`finally, reason ${label(signal().reason, { e })}`);
        }
      }),
    );
    expect({ outcome: show(o, { e }), log: t.log }).toEqual({ outcome: 'defect(e)', log: ['finally, reason e'] });
    await within(root.close());
  });

  it('a failure handler receives the error of a fail, with the fiber; the fiber’s outcome is failure(e)', async () => {
    const root = app();
    const e = new Boom('expected');
    const handled: string[] = [];
    const f = root.fork(
      task(
        function* () {
          yield* sleep(0);
          yield* fail(e);
        },
        {
          name: 'supervised',
          onFailure: (err, fiber) => void handled.push(`${label(err, { e })} from ${fiber === f ? 'the fiber' : 'another node'}`),
        },
      ),
    );
    const o = await within(root.result(f));
    expect({ handled, outcome: show(o, { e }) }).toEqual({ handled: ['e from the fiber'], outcome: 'failure(e)' });
    await within(root.close()); // the handler consumed it
  });

  it("a pooled fiber's fail reaches the pool's onFailure, as a defect does (D15)", async () => {
    const root = app();
    const e = new Boom('expected');
    const handled: string[] = [];
    const p = root.pool({
      name: 'jobs',
      onFailure: (err, fiber) => void handled.push(`${label(err, { e })} from ${fiber === f ? 'the fiber' : 'another node'}`),
    });
    const f = p.fork(function* () {
      yield* sleep(0);
      yield* fail(e);
    });
    await within(p.close());
    expect({ handled, outcome: show(f.outcome, { e }) }).toEqual({ handled: ['e from the fiber'], outcome: 'failure(e)' });
    await within(root.close());
  });
});

describe('stage 3: promised and $', () => {
  it('promised of a body that fails rejects with e, which it consumes', async () => {
    const root = app();
    const e = new Boom('expected');
    const seen = await within(
      root.call(function* () {
        const cb = promised(function* () {
          yield* sleep(0);
          yield* fail(e);
          return 1;
        });
        return yield* wait(
          cb().then(
            (v) => `resolved with ${label(v, { e })}`,
            (x: unknown) => `rejected with ${label(x, { e })}`,
          ),
        );
      }),
    );
    expect(seen).toBe('rejected with e');
    await within(root.close()); // consumed by the promise: nothing surfaces from the node
  });

  it("yield* $(r) in a body is a success's value, and ends the body with a failure's error: failure(e), no catch run, its finally run", async () => {
    const root = app();
    const e = new Boom('expected');
    const t = trace();
    const o = await within(
      root.attempt(function* () {
        const v = yield* unwrapResult(success(1));
        t.push(`value ${v}`);
        try {
          yield* unwrapResult(failure(e));
          t.push('after $');
        } catch (x) {
          t.push(`catch ${label(x, { e })}`);
        } finally {
          t.push('finally');
        }
        return v;
      }),
    );
    expect({ outcome: show(o, { e }), log: t.log }).toEqual({ outcome: 'failure(e)', log: ['value 1', 'finally'] });
  });
});

describe('stage 3: the release amendment, four-way (DESIGN.md §4.12)', () => {
  it('success + release failure → defect(r); failure + release failure → the release-primary SuppressedError(r, e), a defect; defect + release failure → defect(SuppressedError(r, d)); aborted + release failure → defect(r)', async () => {
    const root = app();
    const e = new Boom('expected');
    const d = new Error('defect');
    const r = new Error('release');
    const stop = new Error('stop');
    const known = { e, d, r, stop };
    /** An entry whose release throws `r`, on the current node. */
    const failingRelease = (): void => {
      own(() => {
        throw r;
      });
    };
    const rows = await within(
      root.call(function* () {
        const onSuccess = show(
          yield* attempt(function* () {
            failingRelease();
            yield* sleep(0);
            return 1;
          }),
          known,
        );
        const onFailure = show(
          yield* attempt(function* () {
            failingRelease();
            yield* sleep(0);
            yield* fail(e);
          }),
          known,
        );
        const onDefect = show(
          yield* attempt(function* () {
            failingRelease();
            yield* sleep(0);
            throw d;
          }),
          known,
        );
        const ac = new AbortController();
        setTimeout(() => ac.abort(stop), 1);
        const onAborted = show(
          yield* attempt(
            task(
              function* () {
                failingRelease();
                yield* never();
              },
              { signal: ac.signal },
            ),
          ),
          known,
        );
        return { success: onSuccess, failure: onFailure, defect: onDefect, aborted: onAborted };
      }),
    );
    expect(rows).toEqual({
      success: 'defect(r)',
      failure: 'defect(SuppressedError(error: r, suppressed: e))',
      defect: 'defect(SuppressedError(error: r, suppressed: d))',
      aborted: 'defect(r)',
    });
    await within(root.close());
  });
});

describe('stage 3: the surface', () => {
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
      const user = yield* call(getUser, id);
      return yield* call(getOrder, user);
    }
    const order = task(function* (id: string) {
      return yield* loadOrder(id);
    });
    const checkout = task(function* (id: string) {
      const o = yield* order.call(id);
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
      return yield* all([getUser.bind(id), getOrder.bind(user)]);
    });
    const viaRace = task(function* (id: string) {
      return yield* race([getUser.bind(id), getAdmin.bind(id)]);
    });
    const viaSettle = task(function* (id: string) {
      const user: User = { id };
      return yield* settle([getUser.bind(id), getOrder.bind(user)]);
    });
    // A middle level that both calls a failing task and fails itself, twice over, and the groups over such tasks.
    const getAccount = task(function* (id: string) {
      const user = yield* call(getUser, id);
      if (user.id === 'locked') yield* fail(new NotAnAdmin());
      return user;
    });
    const getAccountOrder = task(function* (id: string) {
      const user = yield* call(getAccount, id);
      if (user.id === 'unpaid') yield* fail(new PaymentDeclined());
      const accountOrder: Order = { user, total: 1 };
      return accountOrder;
    });
    const allMiddle = task(function* (id: string) {
      return yield* all([getAccount.bind(id), getAccountOrder.bind(id), plain.bind(1)]);
    });
    const raceMiddle = task(function* (id: string) {
      return yield* race([getAccount.bind(id), getAccountOrder.bind(id)]);
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
        plain.bind(2),
      ]);
    });
    function forked(id: string) {
      return fork(getUser, id);
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
    type _Bind = Expect<Equal<ReturnType<typeof getUser.bind>, Task<[], User, UserNotFound>>>;
    type _With = Expect<Equal<ReturnType<typeof getUser.with>, Task<[id: string], User, UserNotFound>>>;
    type _Fork = Expect<Equal<ReturnType<typeof getUser.fork>, Fiber<User, UserNotFound>>>;
    type _FreeFork = Expect<Equal<ReturnType<typeof forked>, Fiber<User, UserNotFound>>>;
    type _Call = Expect<Equal<Awaited<ReturnType<typeof getUser.call>>, User>>;
    type _Attempt = Expect<Equal<Awaited<ReturnType<typeof getUser.attempt>>, Outcome<User, UserNotFound>>>;
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
    // Making a task runs nothing: each is a Task object, and no body above ran.
    const made = [checkout, failsOnly, plain, sync, caught, viaJoin, viaAll, viaRace, viaSettle];
    const middle = [getAccountOrder, allMiddle, raceMiddle, caughtMiddle, inlineAll];
    expect([...made.map((t) => typeof t.fork), ...middle.map((t) => typeof t.fork), typeof forked, typeof resulted]).toEqual(
      Array(16).fill('function'),
    );
  });
});
