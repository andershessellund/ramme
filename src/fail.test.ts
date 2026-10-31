// fail.test.ts — `yield* fail(e)`, the fourth exit (D42, DESIGN.md §4.12, §4.13), beyond its pins
// (stage3-pin.test.ts): the rules the driver applies around a `Fail` and the paths an expected failure takes
// through the verbs.
//
// A `Fail` fixes the body's outcome as `failure(e)` at once and returns its generator as a halt does, so its
// `finally` blocks run as release work under an unwind fiber: a delivery then changes nothing, and what fails there
// (a throw, a second fail, a failed wait) is a release failure, which amends the outcome to a `defect`, a failure a
// wait handed the `finally` and its throw let through once (D45). A delivered
// body not yet halted is halted at its `Fail`, the error discarded as its throw would be (D24). `call`, `join`,
// `shield`, `wait(op)` and the groups re-yield a child's expected failure; `then` rejects with its error; a fiber's
// `[Symbol.asyncDispose]()`, whose op carries no `E`, throws it. Each test compares one observation object.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, current, fail, fork, join, never, own, race, shield, sleep, wait } from './ambient.js';
import type { Context, Fail, Instruction, Task } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { deferred, events, tick, trace, within } from './test/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

class NotFound extends Error {
  readonly name = 'NotFound' as const;
}
class Declined extends Error {
  readonly name = 'Declined' as const;
}

/** The test's own errors by name; a SuppressedError or AggregateError by its parts; anything else by class and message. */
function label(x: unknown, known: Readonly<Record<string, unknown>>): string {
  for (const [name, v] of Object.entries(known)) if (v === x) return name;
  if (typeof x === 'object' && x !== null && 'suppressed' in x && 'error' in x) {
    const s = x as { error: unknown; suppressed: unknown };
    return `SuppressedError(${label(s.error, known)}, ${label(s.suppressed, known)})`;
  }
  if (x instanceof AggregateError) return `AggregateError(${x.errors.map((e: unknown) => label(e, known)).join(', ')})`;
  if (x instanceof Error) return `${x.name}: ${x.message}`;
  return String(x);
}

/** An outcome as one string, `status(…)`. */
function show(o: unknown, known: Readonly<Record<string, unknown>>): string {
  const x = o as { status: string; value?: unknown; error?: unknown; reason?: unknown };
  const inner = x.status === 'success' ? x.value : x.status === 'aborted' ? x.reason : x.error;
  return `${x.status}(${label(inner, known)})`;
}

const roots: Context[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** A module-level fail: `fail` reads no node, so it may be made anywhere, and each `yield*` yields afresh. */
const notFoundAnywhere = new NotFound('made at module level');
const failAnywhere = fail(notFoundAnywhere);

describe('the finally a fail runs: release work (D42)', () => {
  it('a throw from it, a second fail in it and a failed wait in it are release failures, reported beside the fail: the outcome is defect(SuppressedError(release, e)); its node:settled is failure; a callee’s failure it lets through is reported once (D45)', async () => {
    const ev = events();
    roots.push(ev.root);
    const e = new NotFound('the fail');
    const thrown = new Error('cleanup threw');
    const second = new Declined('a second fail');
    const rejected = new Error('rollback rejected');
    const known = { e, thrown, second, rejected };
    const cleanup = task(function* (): Generator<Instruction, never, unknown> {
      yield* sleep(0);
      throw thrown;
    });
    const run = async (body: () => Generator<Instruction | Fail<unknown>, void, unknown>) => {
      const f = ev.root.fork(task(body, { onFailure: () => {} }));
      const o = await within(ev.root.result(f));
      return { o: show(o, known), settled: ev.of('node:settled').find((x) => x.id === f.id)?.outcome };
    };
    const rows = {
      throw: await run(function* () {
        try {
          yield* fail(e);
        } finally {
          throw thrown;
        }
      }),
      secondFail: await run(function* () {
        try {
          yield* fail(e);
        } finally {
          yield* fail(second);
        }
      }),
      failedWait: await run(function* () {
        try {
          yield* fail(e);
        } finally {
          try {
            yield* wait(Promise.reject(rejected));
          } catch {
            // caught, and still recorded once, as a halted finally records p's own failure
          }
        }
      }),
      // The callee's failure is its holder's record, and the generator's throw of it the same failure: one, not two.
      calleeThrew: await run(function* () {
        try {
          yield* fail(e);
        } finally {
          yield* cleanup();
        }
      }),
    };
    expect(rows).toEqual({
      throw: { o: 'defect(SuppressedError(thrown, e))', settled: 'failure' },
      secondFail: { o: 'defect(SuppressedError(second, e))', settled: 'failure' },
      failedWait: { o: 'defect(SuppressedError(rejected, e))', settled: 'failure' },
      calleeThrew: { o: 'defect(SuppressedError(thrown, e))', settled: 'failure' },
    });
  });

  it('a callee’s fail re-yielded in a halted finally ends that finally and is reported once, by the callee’s own record: aborted + e → defect(e)', async () => {
    const root = app();
    const e = new NotFound('the cleanup’s');
    const t = trace();
    const cleanup = task(function* () {
      yield* sleep(0);
      yield* fail(e);
    });
    const f = root.fork(
      task(
        function* () {
          try {
            yield* never();
          } finally {
            t.push('finally');
            yield* cleanup(); // release work on the unwind fiber: its record stays with its holder
            t.push('after the cleanup');
          }
        },
        { onFailure: () => {} },
      ),
    );
    await tick();
    f.abort('stop');
    const o = await within(root.result(f));
    expect({ o: show(o, { e }), log: t.log }).toEqual({ o: 'defect(e)', log: ['finally'] });
  });

  it('a delivery while it runs changes nothing: the finally runs to its end, unhalted, and the outcome stays failure(e)', async () => {
    const root = app();
    const e = new NotFound('the fail');
    const t = trace();
    const inFinally = deferred();
    const f = root.fork(
      task(
        function* () {
          try {
            yield* fail(e);
          } finally {
            t.push('finally');
            inFinally.resolve();
            yield* sleep(5); // release work: the delivery below does not halt it
            t.push('finally waited');
          }
        },
        { onFailure: () => {} },
      ),
    );
    await within(inFinally.promise);
    f.abort('late');
    const o = await within(root.result(f));
    expect({ o: show(o, { e }), log: t.log }).toEqual({ o: 'failure(e)', log: ['finally', 'finally waited'] });
  });

  it('a delivered body that has not been halted yet (resumed by release work) is halted at its fail: aborted, the error discarded as its throw would be (D24)', async () => {
    const root = app();
    const e = new NotFound('after the delivery');
    const t = trace();
    const gate = deferred<string>();
    const f = root.fork(
      task(
        function* () {
          try {
            const v = yield* wait(gate.promise); // release-shaped: the halt lets it finish
            t.push(`resumed with ${v}`);
            yield* fail(e);
            t.push('after fail');
          } finally {
            t.push('finally');
          }
        },
        { onFailure: () => {} },
      ),
    );
    await tick();
    f.abort('stop');
    gate.resolve('v');
    const o = await within(root.result(f));
    expect({ o: show(o, { e }), log: t.log }).toEqual({ o: 'aborted(stop)', log: ['resumed with v', 'finally'] });
  });

  it('a return in it loses the fail’s return: dev mode reports it, and the outcome stays failure(e)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = app();
    const e = new NotFound('the fail');
    const o = await within(
      root.attempt(function* () {
        try {
          yield* fail(e);
        } finally {
          return 'overridden';
        }
      }),
    );
    expect({
      o: show(o, { e }),
      reported: warn.mock.calls.map((c) => /return after a fail of .* was lost/.test(String(c[0])) && /failure\(e\) all the same/.test(String(c[0]))),
    }).toEqual({ o: 'failure(e)', reported: [true] });
  });
});

describe('telling a Fail apart (D42)', () => {
  it('a yielded object that claims the brand but whose read throws is no fail: the driver throws its TypeError back at the yield, never escapes', async () => {
    const root = app();
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => ({ value: 1, configurable: true, enumerable: true, writable: true }),
        get: () => {
          throw new Error('hostile get');
        },
      },
    );
    const o = await within(
      root.attempt(function* () {
        try {
          yield hostile as never;
          return 'not thrown';
        } catch (x) {
          return x instanceof TypeError && /yielded an object that is not an op/.test(x.message) ? 'TypeError' : String(x);
        }
      }),
    );
    expect(o).toEqual({ status: 'success', value: 'TypeError' });
  });
});

describe('an expected failure through the verbs (D42)', () => {
  it('fail is pure: made outside any node, it is yielded afresh by every body that yields it', async () => {
    const root = app();
    const outcomes = await within(
      Promise.all([
        root.attempt(function* () {
          yield* failAnywhere;
        }),
        root.attempt(function* () {
          yield* sleep(0);
          yield* failAnywhere;
        }),
      ]),
    );
    expect(outcomes.map((o) => show(o, { notFoundAnywhere }))).toEqual(['failure(notFoundAnywhere)', 'failure(notFoundAnywhere)']);
  });

  it('shield, wait(op) and a helper’s join re-yield a child’s fail: each caller ends failure(e), its catch never run', async () => {
    const root = app();
    const e = new NotFound('the child’s');
    const failing = task(function* () {
      yield* sleep(0);
      yield* fail(e);
    });
    function* joinOf(t: typeof failing) {
      return yield* join(fork(t));
    }
    const caught: string[] = [];
    const via = (name: string, body: () => Generator<Instruction | Fail<unknown>, void, unknown>) =>
      root.attempt(
        task(function* () {
          try {
            yield* body();
          } catch {
            caught.push(name);
          }
        }),
      );
    const rows = await within(
      Promise.all([
        via('shield', function* () {
          yield* shield(failing);
        }),
        via('wait(op)', function* () {
          yield* wait(failing());
        }),
        via('helper join', function* () {
          yield* joinOf(failing);
        }),
      ]),
    );
    expect({ rows: rows.map((o) => show(o, { e })), caught }).toEqual({ rows: ['failure(e)', 'failure(e)', 'failure(e)'], caught: [] });
  });

  it('wait(fn) whose fn returns an op is that op’s own wait, typed by its E: the free wait and a node’s wait re-yield its fail, the caller ends failure(e); a fn returning a promise adds no E', async () => {
    const root = app();
    const e = new NotFound('waited');
    const fails = true as boolean;
    const failing = task(function* () {
      yield* sleep(0);
      if (fails) return yield* fail(e);
      return 1;
    });
    const viaCall = task(function* () {
      return yield* wait(() => failing());
    });
    const viaMethod = task(function* () {
      return yield* wait((_signal) => current().call(failing)); // a node's call: the task's call made through a named node
    });
    const viaJoin = task(function* () {
      const f = fork(failing);
      return yield* wait(() => join(f));
    });
    const viaNode = task(function* () {
      return yield* current().wait(() => failing());
    });
    const viaPromise = task(function* () {
      return yield* wait(() => Promise.resolve('resolved'));
    });
    type _types = [
      Expect<Equal<typeof viaCall, Task<[], number, NotFound>>>,
      Expect<Equal<typeof viaMethod, Task<[], number, NotFound>>>,
      Expect<Equal<typeof viaJoin, Task<[], number, NotFound>>>,
      Expect<Equal<typeof viaNode, Task<[], number, NotFound>>>,
      Expect<Equal<typeof viaPromise, Task<[], string, never>>>,
    ];
    const outcomes = await within(
      Promise.all([root.attempt(viaCall), root.attempt(viaMethod), root.attempt(viaJoin), root.attempt(viaNode), root.attempt(viaPromise)]),
    );
    expect(outcomes.map((o) => show(o, { e }))).toEqual(['failure(e)', 'failure(e)', 'failure(e)', 'failure(e)', 'success(resolved)']);
  });

  it('all and race with no success report every failure (D28): a lone fail is re-yielded, the caller ends failure(e); two fails, or a fail and a defect, throw the AggregateError of every failure in task order, none dropped', async () => {
    const root = app();
    const first = new NotFound('first');
    const second = new Declined('second');
    const d = new Error('defect');
    const known = { first, second, d };
    const succeeds = task(function* () {
      yield* sleep(0);
      return 'ok';
    });
    const aborted = task(
      function* () {
        yield* never();
      },
      { timeoutMs: 0 },
    );
    const failsLate = task(function* () {
      yield* sleep(5);
      yield* fail(first);
    });
    const failsEarly = task(function* () {
      yield* sleep(0);
      yield* fail(second);
    });
    const throws = task(function* () {
      yield* sleep(0);
      throw d;
    });
    const outcomes = await within(
      Promise.all([
        root.attempt(function* () {
          return yield* all([succeeds, failsLate]);
        }),
        root.attempt(function* () {
          return yield* all([failsLate, failsEarly]);
        }),
        root.attempt(function* () {
          return yield* all([failsLate, throws]);
        }),
        root.attempt(function* () {
          return yield* race([aborted, failsEarly]);
        }),
        root.attempt(function* () {
          return yield* race([failsLate, failsEarly]);
        }),
      ]),
    );
    const [, , , , raced] = outcomes;
    expect({
      outcomes: outcomes.map((o) => show(o, known)),
      message: raced.status === 'defect' && raced.error instanceof AggregateError ? raced.error.message : undefined,
    }).toEqual({
      outcomes: [
        'failure(first)',
        'defect(AggregateError(first, second))', // task order, not completion order
        'defect(AggregateError(first, d))',
        'failure(second)', // an aborted member is no failure
        'defect(AggregateError(first, second))',
      ],
      message: 'every task failed',
    });
  });

  it("a 'link' child's fail aborts its parent when the child settles, before the child's own releases have run, as a defect does (DESIGN.md §4.7)", async () => {
    const root = app();
    const e = new NotFound('linked');
    const t = trace();
    const o = await within(
      root.attempt(function* () {
        fork(
          task(
            function* () {
              own({ slow: true }, function* () {
                yield* sleep(10); // a slow release: the child completes only after it
                t.push('child released');
              });
              yield* sleep(0);
              yield* fail(e);
            },
            { onFailure: 'link' },
          ),
        );
        try {
          yield* never();
        } finally {
          t.push('parent halted');
        }
      }),
    );
    expect({ o: show(o, { e }), log: t.log }).toEqual({ o: 'defect(e)', log: ['parent halted', 'child released'] });
  });

  it("an unjoined 'join' fork's fail is held as a defect is, and surfaces from the parent's completion as the parent's defect(e)", async () => {
    const root = app();
    const e = new NotFound('unjoined');
    const o = await within(
      root.attempt(function* () {
        fork(function* () {
          yield* fail(e);
        });
        yield* sleep(1);
        return 'parent done';
      }),
    );
    expect(show(o, { e })).toBe('defect(e)');
  });

  it("a fiber's [Symbol.asyncDispose](), whose op carries no E, throws its expected failure into the caller, which may catch it; a top-level then rejects with it", async () => {
    const root = app();
    const e = new NotFound('disposed');
    const caught = await within(
      root.call(function* () {
        const f = fork(function* () {
          yield* fail(e);
        });
        yield* sleep(0);
        try {
          yield* f[Symbol.asyncDispose]();
          return 'not thrown';
        } catch (x) {
          return x === e ? 'caught e' : `caught ${String(x)}`;
        }
      }),
    );
    const rejected = await within(
      root
        .call(function* () {
          yield* fail(e);
        })
        .then(
          () => 'resolved',
          (x: unknown) => (x === e ? 'rejected with e' : `rejected with ${String(x)}`),
        ),
    );
    expect({ caught, rejected }).toEqual({ caught: 'caught e', rejected: 'rejected with e' });
  });

  it('a fail in an entry’s release is a release failure: the owner’s outcome is defect(e)', async () => {
    const root = app();
    const e = new NotFound('in a release');
    const o = await within(
      root.attempt(function* () {
        own({ conn: 1 }, function* () {
          yield* sleep(0);
          yield* fail(e);
        });
        return 'owner done';
      }),
    );
    expect(show(o, { e })).toBe('defect(e)');
  });

  it('a fail(e) returned rather than yielded is driven as its own yield*, as a returned op is: an entry’s release or a defer returning it is a release failure, the owner’s defect(e); a handler returning it is a handler exception, the parent’s defect(e); a body returning it ends failure(e)', async () => {
    const root = app();
    const released = new NotFound('a release’s');
    const deferredFail = new NotFound('a defer’s');
    const handled = new Declined('a handler’s');
    const returned = new NotFound('a body’s');
    const known = { released, deferredFail, handled, returned };
    // A body's type has no arm for an operation it returns, so the body is reached as untyped code reaches it.
    const returnsFail = (() => fail(returned)) as unknown as () => never;
    const outcomes = await within(
      Promise.all([
        root.attempt(function* () {
          own({ conn: 1 }, () => fail(released));
          return 'owner done';
        }),
        root.attempt(function* () {
          own(() => fail(deferredFail));
          return 'owner done';
        }),
        root.attempt(function* () {
          fork(
            task(
              function* () {
                throw new Error('worker threw');
              },
              { onFailure: () => fail(handled) },
            ),
          );
          yield* sleep(5);
          return 'parent done';
        }),
        root.attempt(returnsFail),
      ]),
    );
    expect(outcomes.map((o) => show(o, known))).toEqual(['defect(released)', 'defect(deferredFail)', 'defect(handled)', 'failure(returned)']);
  });

  it('a generator failure handler that fails, by its own fail or a callee’s re-yielded, ends there, no catch run, its finally run: the error is a handler exception, the parent’s defect', async () => {
    const root = app();
    const worker = new Error('worker threw');
    const ownFail = new NotFound('the handler’s own');
    const callee = new Declined('the handler’s callee’s');
    const log: string[] = [];
    const failingCallee = task(function* () {
      yield* sleep(0);
      yield* fail(callee);
    });
    const run = (name: string, handler: () => Generator<Instruction | Fail<unknown>, void, unknown>) =>
      root.attempt(function* () {
        fork(
          task(
            function* () {
              throw worker;
            },
            {
              onFailure: function* () {
                try {
                  yield* handler();
                  log.push(`${name}: after`);
                } catch {
                  log.push(`${name}: catch`); // a fail is no exception: never runs
                } finally {
                  log.push(`${name}: finally`);
                }
              },
            },
          ),
        );
        yield* sleep(5);
        return 'parent done';
      });
    const outcomes = await within(
      Promise.all([
        run('own', function* () {
          yield* fail(ownFail);
        }),
        run('callee', function* () {
          yield* failingCallee();
        }),
      ]),
    );
    expect({ outcomes: outcomes.map((o) => show(o, { ownFail, callee })), log: [...log].sort() }).toEqual({
      outcomes: ['defect(ownFail)', 'defect(callee)'],
      log: ['callee: finally', 'own: finally'],
    });
  });

  it('what fails in the finally a handler’s fail runs, a second fail, a callee’s fail re-yielded there or a throw, is reported beside the fail, as in a body: the parent’s defect(SuppressedError(later, first))', async () => {
    const root = app();
    const first = new NotFound('the handler’s fail');
    const second = new Declined('a second fail');
    const callee = new Declined('a callee’s fail');
    const thrown = new Error('a throw');
    const known = { first, second, callee, thrown };
    const failingCallee = task(function* () {
      yield* sleep(0);
      yield* fail(callee);
    });
    const run = (inFinally: () => Generator<Instruction | Fail<unknown>, void, unknown>) =>
      root.attempt(function* () {
        fork(
          task(
            function* () {
              throw new Error('worker threw');
            },
            {
              onFailure: function* () {
                try {
                  yield* fail(first);
                } finally {
                  yield* inFinally();
                }
              },
            },
          ),
        );
        yield* sleep(5);
        return 'parent done';
      });
    const outcomes = await within(
      Promise.all([
        run(function* () {
          yield* fail(second);
        }),
        run(function* () {
          yield* failingCallee();
        }),
        run(function* () {
          throw thrown;
        }),
      ]),
    );
    expect(outcomes.map((o) => show(o, known))).toEqual([
      'defect(SuppressedError(second, first))',
      'defect(SuppressedError(callee, first))',
      'defect(SuppressedError(thrown, first))',
    ]);
  });
});
