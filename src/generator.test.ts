// generator.test.ts — generator bodies beyond the pinning suite (D41, PR 1; DESIGN.md §4.14).
//
// generator-pin.test.ts re-expresses PR #4's pins; this file pins the rest of what PR 1 decides: U3's answers to
// the review probes p1, p2 and p6–p9, the halted finally's ROLLBACK and deadline, groups and attempt there, the
// driver's refusals, `promised` after its node completed and inside a halted finally, the fixes of the PR 1 review
// (`wait(op)`, ramme's rejections never recorded as release failures, `promised` under a halted node and during a
// creation), and that a halted body's frame is not retained. Each test compares one observation object first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './node.js';
import {
  all,
  attempt,
  call,
  child,
  current,
  fork,
  interrupted,
  join,
  lookup,
  managed,
  never,
  own,
  promised,
  release,
  releaseAll,
  result,
  settle,
  shield,
  signal,
  sleep,
  unshield,
  wait,
} from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber, Instruction, Op, Outcome } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { isInstruction } from './managed.js';
import type { InstructionImpl, ManagedPromise } from './managed.js';
import { factoryProvider } from './provider-util.js';
import { AsyncRunError, CreationViolationError, FiberAbortedError, FiberNotAwaitableError, NodeCompletedError } from './resource.js';
import { deferred, gcUntil, hasGc, impl, tick, within } from './test/util.js';

const warnings: string[] = [];
const roots: Context[] = [];

beforeEach(() => {
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(opts: { releaseTimeoutMs?: number } = {}): Context {
  const root = createRootContext(opts);
  roots.push(root);
  return root;
}

function rammeWarnings(): string[] {
  return warnings.filter((w) => w.startsWith('ramme:'));
}

/** A platform timer: a foreign promise. */
function bare(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fork `body` on a fresh root, halt it once it is suspended, and read its outcome (the failure's message, if any). */
async function halt(body: () => Generator<Instruction, unknown, unknown>, opts: { releaseTimeoutMs?: number } = {}) {
  const root = app(opts);
  const f = root.fork(task(body, { name: 'halted', onFailure: () => {} }));
  await tick();
  f.abort(new Error('hang up'));
  const o = await within(root.result(f), 2000);
  return o.status === 'failure' ? `failure: ${(o.error as Error).message}` : o.status;
}

const failing = (name: string, ms = 1) =>
  task(
    function* (): Generator<Instruction, never, unknown> {
      yield* sleep(ms);
      throw new Error(`${name} failed`);
    },
    { name },
  );

describe('U3: the halted finally, against the review probes', () => {
  it('p6: the generator’s own throw in its halted finally is discarded (aborted, D24); a shield’s failure caught there is not consumed, and is the outcome', async () => {
    const outcomes = [
      await halt(function* () {
        try {
          yield* never();
        } finally {
          throw new Error('cleanup threw');
        }
      }),
      await halt(function* () {
        try {
          yield* never();
        } finally {
          try {
            yield* shield(function* (): Generator<Instruction, never, unknown> {
              throw new Error('cleanup threw');
            });
          } catch {
            // caught: still a release failure of the node
          }
        }
      }),
    ];
    expect(outcomes).toEqual(['aborted', 'failure: cleanup threw']);
  });

  it('p7: release(x) and releaseAll() in the halted finally address the node, so they find its entries and run now', async () => {
    const log: string[] = [];
    const o = await halt(function* () {
      const conn = own({ n: 1 }, () => void log.push('conn released'));
      own({ n: 2 }, () => void log.push('other released'));
      try {
        yield* never();
      } finally {
        yield* release(conn);
        log.push('after release');
        yield* releaseAll();
        log.push('after releaseAll');
      }
    });
    expect({ o, log }).toEqual({ o: 'aborted', log: ['conn released', 'after release', 'other released', 'after releaseAll'] });
  });

  it('p8: a failure the halted finally catches from release(tx), call(t), attempt(t) or join(f) is not consumed: it is the outcome, once', async () => {
    let seen = '';
    const outcomes = [
      await halt(function* () {
        const tx = own({}, function* () {
          yield* wait(tick());
          throw new Error('rollback failed');
        });
        try {
          yield* never();
        } finally {
          try {
            yield* release(tx);
          } catch {
            // caught
          }
        }
      }),
      await halt(function* () {
        try {
          yield* never();
        } finally {
          try {
            yield* call(failing('rollback'));
          } catch {
            // caught
          }
        }
      }),
      await halt(function* () {
        try {
          yield* never();
        } finally {
          seen = (yield* attempt(failing('rollback'))).status; // the outcome is a value, the record stays
        }
      }),
      await halt(function* () {
        const audit = fork(failing('audit', 5).with({ interrupt: 'observe' })); // not halted: it fails on its own
        try {
          yield* never();
        } finally {
          try {
            yield* join(audit); // its failure is thrown in, not consumed
          } catch {
            // caught
          }
        }
      }),
    ];
    expect({ outcomes, seen }).toEqual({
      outcomes: ['failure: rollback failed', 'failure: rollback failed', 'failure: rollback failed', 'failure: audit failed'],
      seen: 'failure',
    });
  });

  it('p9: decision 12 while a helper’s finally is suspended skips the rest of that block; the body’s own finally still runs and may yield, and nothing reports a lost halt', async () => {
    const log: string[] = [];
    function* helper(): Generator<Instruction, void, unknown> {
      try {
        yield* never();
      } finally {
        log.push('helper finally start');
        yield* current()[Symbol.asyncDispose](); // waits for its own node: returned there
        log.push('helper finally rest');
      }
    }
    const o = await halt(function* () {
      try {
        yield* helper();
      } finally {
        log.push('body finally');
        yield* sleep(1);
        log.push('body finally rest');
      }
    });
    expect({ o, log, warnings: rammeWarnings().map((w) => (/lost/.test(w) ? 'lost halt' : 'decision 12')) }).toEqual({
      o: 'aborted',
      log: ['helper finally start', 'body finally', 'body finally rest'],
      warnings: ['decision 12'],
    });
  });

  it('the ROLLBACK idiom: finally { yield* wait(conn.query(ROLLBACK)) } runs to its end before the entries are released; a failed ROLLBACK is a release failure, caught or not', async () => {
    const logs: Record<string, unknown> = {};
    for (const fails of [false, true]) {
      const log: string[] = [];
      const query = (sql: string): Promise<void> =>
        bare(10).then(() => {
          log.push(`${sql} done`);
          if (fails && sql === 'ROLLBACK') throw new Error('rollback failed');
        });
      const o = await halt(function* () {
        own(() => void log.push('entry released'));
        yield* wait(query('BEGIN'));
        let done = false;
        try {
          yield* never();
          done = true;
        } finally {
          if (!done)
            try {
              yield* wait(query('ROLLBACK'));
            } catch {
              log.push('caught');
            }
        }
      });
      logs[fails ? 'fails' : 'ok'] = { o, log };
    }
    expect(logs).toEqual({
      ok: { o: 'aborted', log: ['BEGIN done', 'ROLLBACK done', 'entry released'] },
      fails: { o: 'failure: rollback failed', log: ['BEGIN done', 'ROLLBACK done', 'caught', 'entry released'] },
    });
  });

  it('in the halted finally, wait((signal) => p) is handed the unwind fiber’s release deadline, not the body’s fired signal; its expiry is a release failure', async () => {
    let handed: AbortSignal | undefined;
    let body: AbortSignal | undefined;
    let abortedWhenHanded: boolean | undefined;
    const o = await halt(
      function* () {
        body = signal();
        try {
          yield* never();
        } finally {
          yield* wait(
            (s) =>
              new Promise<void>((_, reject) => {
                handed = s;
                abortedWhenHanded = s.aborted;
                s.addEventListener('abort', () => reject(s.reason as Error), { once: true });
              }),
          );
        }
      },
      { releaseTimeoutMs: 20 },
    );
    expect({ o, handedIsBody: handed === body, bodyAborted: body?.aborted, abortedWhenHanded, abortedAtEnd: handed?.aborted }).toEqual({
      o: 'failure: The operation was aborted due to timeout',
      handedIsBody: false,
      bodyAborted: true,
      abortedWhenHanded: false,
      abortedAtEnd: true,
    });
  });

  it('all and settle in the halted finally: their members run on the unwind fiber, and the members’ failures are reported once', async () => {
    const outcomes = [
      await halt(function* () {
        try {
          yield* never();
        } finally {
          try {
            yield* all([failing('a'), failing('b')]);
          } catch {
            // caught: the group's AggregateError is still the outcome
          }
        }
      }),
      await halt(function* () {
        try {
          yield* never();
        } finally {
          yield* settle([failing('a'), failing('b')]); // outcomes as values; the records stay with the unwind fiber
        }
      }),
    ];
    expect(outcomes).toEqual(['failure: 2 of 2 tasks failed', 'failure: Errors during release']);
  });

  it('a shield made in the halted finally runs on the node, not on the unwind fiber: its owner was interrupted, so a hole in it is skipped at once, as in PR #4’s cleanup path', async () => {
    const ran: string[] = [];
    let hole: unknown;
    let shieldParentIsBody: boolean | undefined;
    const o = await halt(function* () {
      const body = current();
      try {
        yield* never();
      } finally {
        yield* shield(function* () {
          shieldParentIsBody = current().parent === body;
          hole = yield* unshield(function* () {
            ran.push('hole ran');
            return 'ack';
          });
          ran.push('shield goes on');
        });
      }
    });
    expect({ o, ran, hole: (hole as { status?: string })?.status, shieldParentIsBody }).toEqual({
      o: 'aborted',
      ran: ['shield goes on'],
      hole: 'aborted',
      shieldParentIsBody: true,
    });
  });

  it('promised made in the halted finally captures the unwind fiber: its callback is release work, not born delivered', async () => {
    const log: string[] = [];
    const lib = {
      async transaction<T>(fn: (n: number) => Promise<T>): Promise<T> {
        log.push('BEGIN');
        try {
          return await fn(1);
        } finally {
          log.push('END');
        }
      },
    };
    const o = await halt(function* () {
      try {
        yield* never();
      } finally {
        const v = yield* wait(
          lib.transaction(
            promised(function* (n: number) {
              log.push(`callback delivered ${String(signal().aborted)}`);
              yield* sleep(2);
              return n + 1;
            }),
          ),
        );
        log.push(`got ${v}`);
      }
    });
    expect({ o, log }).toEqual({ o: 'aborted', log: ['BEGIN', 'callback delivered false', 'END', 'got 2'] });
  });

  it('transitional (eager ops): an op the body made before its halt and yields in its halted finally is release work there, never rejected with the node’s own interruption: a sleep sleeps to its deadline, result(w) gives w’s outcome, wait(p, { abandon: true }) and managed(p) wait for p, interrupted() gives the reason, and never(), which nothing settles any more, returns the generator with a warning', async () => {
    const got: Record<string, string> = {};
    const waited: Record<string, number> = {};
    const caught: string[] = [];
    const show = (v: unknown): string =>
      v instanceof Error ? v.message : typeof v === 'object' && v !== null && 'status' in v ? (v as Outcome<unknown>).status : String(v);
    /** Halt a body whose halted finally yields the op `make` made before the halt; record what the yield* gave, and when. */
    const shape = (name: string, make: () => Op<unknown>) =>
      halt(function* () {
        const op = make();
        const made = Date.now();
        try {
          yield* never();
        } finally {
          try {
            got[name] = show(yield* op);
            waited[name] = Date.now() - made;
          } catch (e) {
            caught.push(`${name}: ${(e as Error).name}`);
          }
        }
      });
    const outcomes = {
      sleep: await shape('sleep', () => sleep(40)),
      result: await shape('result', () =>
        result(
          fork(
            task(function* () {
              yield* never(); // subscribed below the body: the halt delivers it
            }),
          ),
        ),
      ),
      abandon: await shape('abandon', () => wait(bare(10).then(() => 'p settled'), { abandon: true })),
      managed: await shape('managed', () => managed(bare(10).then(() => 'm settled'))),
      interrupted: await shape('interrupted', () => interrupted()),
      never: await shape('never', () => never()),
    };
    expect({ outcomes, got, caught, warnings: rammeWarnings().map((w) => /made before its halt/.test(w)) }).toEqual({
      outcomes: { sleep: 'aborted', result: 'aborted', abandon: 'aborted', managed: 'aborted', interrupted: 'aborted', never: 'aborted' },
      got: { sleep: 'undefined', result: 'aborted', abandon: 'p settled', managed: 'm settled', interrupted: 'hang up' },
      caught: [],
      warnings: [true], // never(): returned there, with a warning
    });
    expect(waited.sleep).toBeGreaterThanOrEqual(35); // to the sleep's deadline, 40 ms after it was made
  });
});

describe('the driver: returned ops, handlers, refusals', () => {
  it('p1, p2: a handler returning an op, or a generator handler, that waits for its parent’s close() does not hold the parent; a body or a release returning an op is driven', async () => {
    const closed: Record<string, string> = {};
    for (const shape of ['returns an op', 'generator'] as const) {
      const root = createRootContext({ name: 'app' });
      root.fork(
        task(
          function* (): Generator<Instruction, never, unknown> {
            throw new Error('boom');
          },
          {
            name: 'boom',
            onFailure:
              shape === 'returns an op'
                ? () => root.close()
                : function* () {
                    yield* root.close();
                  },
          },
        ),
      );
      closed[shape] = await Promise.race([impl(root).completion.then(() => 'completed'), bare(300).then(() => 'still open')]);
    }
    const root = app();
    const leaf = task(function* () {
      return 'leaf';
    });
    const returned = await root.attempt(task(() => call(leaf)));
    const released = await root.attempt(
      task(function* () {
        own({}, () => sleep(5));
      }),
    );
    expect({ closed, returned, released: released.status }).toEqual({
      closed: { 'returns an op': 'completed', generator: 'completed' },
      returned: { status: 'success', value: 'leaf' },
      released: 'success',
    });
  });

  it('a body that aborts itself mid-step is halted at its next yield*; an op yielded twice gives its value twice', async () => {
    const log: string[] = [];
    const root = app();
    const o = await root.attempt(function* () {
      current().abort(new Error('self'));
      log.push('after abort');
      try {
        yield* sleep(1000);
        log.push('unreachable');
      } finally {
        log.push('finally');
      }
    });
    const twice = await root.call(function* () {
      const p = call(function* () {
        yield* sleep(1);
        return 7;
      });
      return [yield* p, yield* p];
    });
    expect({ o: o.status, log, twice }).toEqual({ o: 'aborted', log: ['after abort', 'finally'], twice: [7, 7] });
  });

  it('a body born delivered owns what its wait(p) produced: p finishes, the value is attached, and released with the node; a synchronous throw from making an op lands at its yield*', async () => {
    const log: string[] = [];
    const openTemp = (): Promise<{ name: string } & Disposable> =>
      bare(5).then(() => ({ name: 'tmp-1', [Symbol.dispose]: () => void log.push('temp file removed') }));
    const handle = task(
      function* () {
        const file = own(yield* wait(openTemp())); // started when evaluated: the halt lets it finish (decision 9, row 5)
        log.push(`owns ${file.name}; delivered ${String(signal().aborted)}`);
        yield* sleep(1); // halted here
        log.push('unreachable');
      },
      { name: 'handle' },
    );
    const root = app();
    let caught = '';
    const parent = root.fork(
      task(
        function* () {
          try {
            yield* sleep(-1); // RangeError from making the op, in this step
          } catch (e) {
            caught = (e as Error).name;
          }
          current().abort(new Error('hang up'));
          yield* join(fork(handle)); // a freeze fork of a delivered node: born delivered (D12); call-shaped join
        },
        { name: 'parent', onFailure: () => {} },
      ),
    );
    const o = await within(root.result(parent));
    expect({ o: o.status, caught, log }).toEqual({
      o: 'aborted',
      caught: 'RangeError',
      log: ['owns tmp-1; delivered true', 'temp file removed'],
    });
  });

  it('a generator failure handler’s failed wait is thrown into it, where its catch runs, and an observe body’s real failure is thrown in after its delivery, never a halt', async () => {
    const log: string[] = [];
    const root = app();
    const parent = root.fork(
      task(
        function* () {
          fork(
            task(
              function* (): Generator<Instruction, never, unknown> {
                throw new Error('child failed');
              },
              {
                name: 'child',
                onFailure: function* () {
                  try {
                    yield* wait(Promise.reject(new Error('report failed')));
                  } catch (e) {
                    log.push(`handler caught ${(e as Error).message}`);
                  }
                },
              },
            ),
          );
          yield* sleep(5);
        },
        { name: 'parent', onFailure: () => {} },
      ),
    );
    const observer = root.fork(
      task(
        function* () {
          yield* interrupted(); // delivered: an observe body runs on
          try {
            yield* call(failing('step'));
          } catch (e) {
            return `observer caught ${(e as Error).message}`;
          }
        },
        { name: 'observer', interrupt: 'observe', onFailure: () => {} },
      ),
    );
    await tick();
    observer.abort(new Error('hang up'));
    const outcomes = await within(Promise.all([root.result(parent), root.result(observer)]));
    expect({ log, outcomes }).toEqual({
      log: ['handler caught report failed'],
      outcomes: [
        { status: 'success', value: undefined },
        { status: 'success', value: 'observer caught step failed' },
      ],
    });
  });

  it('an op’s iterator: next() yields an instruction once, then returns what it is resumed with; return() drops the driver’s subscription, so a later settlement resumes nothing', async () => {
    const src = deferred<number>();
    const root = app();
    const op = root.wait(src.promise) as unknown as ManagedPromise<number, number>;
    const it = op[Symbol.iterator]();
    const first = it.next();
    const ins = first.value as unknown as InstructionImpl;
    const resumed: unknown[] = [];
    const owner = impl(root);
    ins.sub = op.drive(
      owner,
      (v) => void resumed.push(v),
      (e) => void resumed.push(e),
    );
    const returned = it.return!(99);
    src.resolve(1);
    await tick();
    const again = op[Symbol.iterator]();
    expect({
      first: { done: first.done, isInstruction: isInstruction(first.value), isTheOp: (first.value as unknown) === op },
      returned,
      resumed,
      fresh: again.next(5).done === false && again.next(5).value === 5,
    }).toEqual({
      first: { done: false, isInstruction: true, isTheOp: false },
      returned: { done: true, value: 99 },
      resumed: [],
      fresh: true,
    });
  });

  it('refusals: a generator returning a fiber, an async generator body, wait of a non-promise, and run(fn) returning a generator', async () => {
    const root = app();
    const names: Record<string, string> = {};
    const fiber = await root.attempt(function* () {
      return current().fork(function* () {}) as unknown as Fiber<void>;
    });
    names.returnsFiber = fiber.status === 'failure' && fiber.error instanceof FiberNotAwaitableError ? 'FiberNotAwaitableError' : fiber.status;
    const asyncGen = await root.attempt(task(async function* () {} as unknown as () => Generator<Instruction, void, unknown>));
    names.asyncGenerator =
      asyncGen.status === 'failure' && asyncGen.error instanceof TypeError && /async generator/.test(asyncGen.error.message) ? 'TypeError' : asyncGen.status;
    const notAPromise = await root.attempt(function* () {
      yield* wait(42 as unknown as Promise<number>);
    });
    names.waitOfANumber = notAPromise.status === 'failure' && notAPromise.error instanceof TypeError ? 'TypeError' : notAPromise.status;
    const aFiber = await root.attempt(function* () {
      const f = fork(function* () {});
      yield* wait(f as unknown as Promise<void>); // never probes the fiber's `then` trap
    });
    names.waitOfAFiber = aFiber.status === 'failure' ? (aFiber.error as Error).name : aFiber.status;
    try {
      root.run(function* () {} as unknown as () => void);
      names.runGenerator = 'nothing thrown';
    } catch (e) {
      names.runGenerator = e instanceof AsyncRunError ? 'AsyncRunError' : String(e);
    }
    expect(names).toEqual({
      returnsFiber: 'FiberNotAwaitableError',
      asyncGenerator: 'TypeError',
      waitOfANumber: 'TypeError',
      waitOfAFiber: 'TypeError',
      runGenerator: 'AsyncRunError',
    });
  });

  it('refusals: an async generator failure handler, which nothing can step, is a handler exception naming function*, so the failure it was handed is not lost', async () => {
    const ran: string[] = [];
    const root = app();
    const o = await within(
      root.attempt(function* () {
        fork(
          task(
            function* (): Generator<Instruction, never, unknown> {
              throw new Error('worker failed');
            },
            {
              name: 'worker',
              onFailure: async function* (e: unknown) {
                ran.push((e as Error).message); // never runs: an async generator object is neither driven nor a thenable
              },
            },
          ),
        );
        yield* sleep(5);
        return 'owner done';
      }),
    );
    expect({
      status: o.status,
      error: o.status === 'failure' && o.error instanceof TypeError && /async generator/.test(o.error.message) && /function\*/.test(o.error.message),
      ran,
    }).toEqual({ status: 'failure', error: true, ran: [] });
  });

  it('promised: a call after the captured node completed rejects with NodeCompletedError; ctx.wait at top level is a bare wait', async () => {
    const root = createRootContext();
    const late = root.promised(function* () {
      return 1;
    });
    const bareWait = await root.wait(Promise.resolve('bare'));
    await root.close();
    const settled = await late().then(
      () => 'resolved',
      (e: unknown) => (e instanceof NodeCompletedError ? 'NodeCompletedError' : String(e)),
    );
    expect({ bareWait, settled }).toEqual({ bareWait: 'bare', settled: 'NodeCompletedError' });
  });

  it('the boundary between the profiles: an async body catches a generator task’s failure and vice versa; an interrupted async caller of a generator child is rejected once the child has unwound', async () => {
    const root = app();
    const asyncCatches = await root.call(async () => {
      try {
        await call(failing('generator'));
      } catch (e) {
        return (e as Error).message;
      }
    });
    const generatorCatches = await root.call(function* () {
      try {
        yield* call(
          task(async () => {
            await sleep(1);
            throw new Error('async failed');
          }),
        );
      } catch (e) {
        return (e as Error).message;
      }
    });
    const log: string[] = [];
    const f = root.fork(
      task(
        async () => {
          try {
            await call(function* () {
              try {
                yield* never();
              } finally {
                log.push('generator child finally');
              }
            });
          } catch (e) {
            log.push(`async caller rejected with ${(e as Error).name}`);
            throw e;
          }
        },
        { onFailure: () => {} },
      ),
    );
    await tick();
    f.abort();
    const o = await within(root.result(f));
    expect({ asyncCatches, generatorCatches, o: o.status, log }).toEqual({
      asyncCatches: 'generator failed',
      generatorCatches: 'async failed',
      o: 'aborted',
      log: ['generator child finally', 'async caller rejected with InterruptedError'],
    });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('a promised callback’s aborted child rejects its promise with FiberAbortedError, its reason the delivery’s', async () => {
    const reason = new Error('hang up');
    const root = app();
    let p: Promise<string> | undefined;
    const f = root.fork(
      task(
        function* () {
          const cb = promised(function* () {
            yield* never();
            return 'unreachable';
          });
          p = cb();
          yield* never();
        },
        { onFailure: () => {} },
      ),
    );
    await tick();
    f.abort(reason);
    const e = await within(p!.then(() => undefined, (x: unknown) => x));
    expect({ fiberAborted: e instanceof FiberAbortedError, reason: (e as FiberAbortedError).reason === reason }).toEqual({
      fiberAborted: true,
      reason: true,
    });
  });
});

describe('the fixes of the PR 1 review', () => {
  it('wait(op) of a ramme op is that op’s own wait, with or without abandon: in the halted finally a failure of wait(db.close()) or wait(release(tx)) is reported once, caught or not, and wait(current().close()) returns the generator there with the decision-12 warning', async () => {
    const outcomes: Record<string, string> = {};
    for (const abandon of [false, true])
      for (const catches of [false, true]) {
        const how = `${abandon ? 'abandon' : 'wait'}${catches ? ', caught' : ''}`;
        /** Yield `op` wrapped in wait(), in the halted finally, its failure caught or not. */
        const finallyWaits = function* (op: Op<void>): Generator<Instruction, void, unknown> {
          if (!catches) return yield* wait(op, { abandon });
          try {
            yield* wait(op, { abandon });
          } catch {
            // caught: still reported, once
          }
        };
        outcomes[`db.close(), ${how}`] = await halt(function* () {
          const db = child({ name: 'db' });
          db.own({}, function* () {
            yield* sleep(5);
            throw new Error('db release failed');
          });
          try {
            yield* never();
          } finally {
            yield* finallyWaits(db.close());
          }
        });
        outcomes[`release(tx), ${how}`] = await halt(function* () {
          const tx = own({}, function* () {
            yield* sleep(5);
            throw new Error('rollback failed');
          });
          try {
            yield* never();
          } finally {
            yield* finallyWaits(release(tx));
          }
        });
      }
    const log: string[] = [];
    const self = [false, true].map((abandon) =>
      halt(function* () {
        try {
          yield* never();
        } finally {
          yield* wait(current().close(), { abandon }); // its completion waits for this finally
          log.push('unreachable');
        }
      }),
    );
    expect({ outcomes, self: await Promise.all(self), log, warned: rammeWarnings().map((w) => /waits for its own/.test(w)) }).toEqual({
      outcomes: {
        'db.close(), wait': 'failure: db release failed',
        'release(tx), wait': 'failure: rollback failed',
        'db.close(), wait, caught': 'failure: db release failed',
        'release(tx), wait, caught': 'failure: rollback failed',
        'db.close(), abandon': 'failure: db release failed',
        'release(tx), abandon': 'failure: rollback failed',
        'db.close(), abandon, caught': 'failure: db release failed',
        'release(tx), abandon, caught': 'failure: rollback failed',
      },
      self: ['aborted', 'aborted'],
      log: [],
      warned: [true, true],
    });
  });

  it('a rejection ramme makes is never a release failure: another body’s wait(p, { abandon: true }), yielded in the halted finally, rejects with FiberAbortedError when that body is interrupted; the finally catches it and the node ends aborted', async () => {
    const root = app();
    let handed: Op<never> | undefined;
    let seen = '';
    const b = root.fork(
      task(
        function* () {
          handed = wait(new Promise<never>(() => {}), { abandon: true }); // targeted at b
          yield* never();
        },
        { name: 'maker', onFailure: () => {} },
      ),
    );
    const a = root.fork(
      task(
        function* () {
          try {
            yield* never();
          } finally {
            try {
              yield* handed!;
            } catch (e) {
              seen = (e as Error).name;
            }
          }
        },
        { name: 'unwinder', onFailure: () => {} },
      ),
    );
    await tick();
    a.abort(new Error('hang up'));
    await tick();
    b.abort(new Error('maker stopped')); // a foreign interruption of the wait a's finally is suspended on
    const outcomes = await within(Promise.all([root.result(a), root.result(b)]));
    expect({ seen, outcomes: outcomes.map((o) => o.status), warned: rammeWarnings().filter((w) => w.includes("'maker'")).length }).toEqual({
      seen: 'FiberAbortedError',
      outcomes: ['aborted', 'aborted'],
      warned: 1, // the cross-body await (D39, A.7)
    });
  });

  it('a promised callback made before the halt and called in the halted finally is born delivered (its node was interrupted): its FiberAbortedError, come back through the library’s promise, is a failed wait(p) there, a release failure', async () => {
    const lib = {
      async transaction<T>(fn: () => Promise<T>): Promise<T> {
        return await fn(); // a library that rethrows
      },
    };
    const o = await halt(function* () {
      const cb = promised(function* () {
        yield* sleep(1);
        return 'committed';
      });
      try {
        yield* never();
      } finally {
        yield* wait(lib.transaction(cb));
      }
    });
    expect(o).toMatch(/^failure: .* was aborted$/);
  });

  it('promised leaves a halted callback’s failure unconsumed while its node is halted: a failed ROLLBACK in the callback’s finally, rethrown by the library into the node’s halted wait(p), is still the node’s failure, as under yield* call(body)', async () => {
    const lib = {
      async transaction<T>(fn: (tx: string) => Promise<T>): Promise<T> {
        return await fn('tx'); // rethrows the callback's rejection
      },
    };
    const body = function* (_tx: string): Generator<Instruction, void, unknown> {
      let done = false;
      try {
        yield* never(); // the insert, in flight at the halt
        done = true;
      } finally {
        if (!done)
          yield* wait(
            bare(5).then(() => {
              throw new Error('ROLLBACK failed: connection reset');
            }),
          );
      }
    };
    const viaPromised = await halt(function* () {
      yield* wait(lib.transaction(promised(body)));
    });
    const viaCall = await halt(function* () {
      yield* call(body, 'tx');
    });
    expect({ viaPromised, viaCall }).toEqual({
      viaPromised: 'failure: ROLLBACK failed: connection reset',
      viaCall: 'failure: ROLLBACK failed: connection reset',
    });
  });

  it('a promised callback called during a creation rejects with CreationViolationError and runs nothing: no body is entered from a creation frame (I16)', async () => {
    const ran: string[] = [];
    const Client = createInjectionKey<{ ready: Promise<unknown> }>('client');
    const root = app();
    root.addProvider(
      factoryProvider(Client, () => {
        const onReady = root.promised(function* () {
          ran.push('callback ran');
          yield* sleep(1);
        });
        return { ready: onReady() }; // a constructor that calls its callback synchronously
      }),
    );
    const settled = await within(
      root.call(function* () {
        const client = lookup(Client);
        return yield* wait(
          client.ready.then(
            () => 'resolved',
            (e: unknown) => (e instanceof CreationViolationError ? 'CreationViolationError' : String(e)),
          ),
        );
      }),
    );
    expect({ settled, ran }).toEqual({ settled: 'CreationViolationError', ran: [] });
  });
});

describe('A2: a halted body retains nothing', () => {
  it.skipIf(!hasGc)('a generator halted on wait(p, { abandon: true }) is not retained by p: with p still pending, the generator and what its finally held are collectible once the node completed', async () => {
    const root = app();
    const pending = deferred<void>(); // never settles while the test looks
    const refs: WeakRef<object>[] = [];
    function* body(): Generator<Instruction, void, unknown> {
      const held = { big: new Array<number>(100_000).fill(1) };
      refs.push(new WeakRef(held));
      try {
        yield* wait(pending.promise, { abandon: true }); // its cell is p's reaction's, until p settles
      } finally {
        yield* sleep(1); // a wait in the halted finally: the unwind fiber's
        void held;
      }
    }
    let f: Fiber<void> | undefined = root.fork(
      task(
        () => {
          const g = body();
          refs.push(new WeakRef(g));
          return g; // driven (decision 28)
        },
        { onFailure: () => {} },
      ),
    );
    await tick();
    f.abort();
    await within(root.result(f));
    f = undefined;
    await gcUntil(() => refs.every((r) => r.deref() === undefined));
    expect(refs.map((r) => r.deref())).toEqual([undefined, undefined]);
    pending.resolve();
  });
});
