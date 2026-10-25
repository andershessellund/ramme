// generator.test.ts — generator bodies beyond the pinning suite (D41, PRs 1 and 2; DESIGN.md §4.14).
//
// generator-pin.test.ts re-expresses PR #4's pins; this file pins the rest of what PR 1 decides: U3's answers to
// the review probes p1, p2 and p6–p9, the halted finally's ROLLBACK and deadline, groups and attempt there, the
// driver's refusals, `promised` after its node completed and inside a halted finally, the fixes of the PR 1 review
// (`wait(op)`, ramme's failures never recorded as release failures, `promised` under a halted node and during a
// creation), and that a halted body's frame is not retained. Each test compares one observation object first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { Sub, isInstruction } from './managed.js';
import type { InstructionImpl, WorkOp } from './managed.js';
import { factoryProvider } from './provider-util.js';
import { AsyncRunError, CreationViolationError, FiberAbortedError, FiberNotAwaitableError, NoCurrentNodeError, NodeCompletedError } from './resource.js';
import { deferred, events, gcUntil, hasGc, impl, tick, within } from './test/util.js';

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
  return o.status === 'defect' ? `defect: ${(o.error as Error).message}` : o.status;
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
    expect(outcomes).toEqual(['aborted', 'defect: cleanup threw']);
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
      outcomes: ['defect: rollback failed', 'defect: rollback failed', 'defect: rollback failed', 'defect: audit failed'],
      seen: 'defect',
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
      fails: { o: 'defect: rollback failed', log: ['BEGIN done', 'ROLLBACK done', 'caught', 'entry released'] },
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
      o: 'defect: The operation was aborted due to timeout',
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
    expect(outcomes).toEqual(['defect: 2 of 2 tasks failed', 'defect: Errors during release']);
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

  it('an op the body made before its halt and yields in its halted finally runs there, at that yield*, as release work: a sleep sleeps its full duration from the yield*, result(w) gives w’s outcome, wait(p, { abandon: true }) waits for p, interrupted() gives the reason, and nothing warns', async () => {
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
      interrupted: await shape('interrupted', () => interrupted()),
    };
    expect({ outcomes, got, caught, warnings: rammeWarnings() }).toEqual({
      outcomes: { sleep: 'aborted', result: 'aborted', abandon: 'aborted', interrupted: 'aborted' },
      got: { sleep: 'undefined', result: 'aborted', abandon: 'p settled', interrupted: 'hang up' },
      caught: [],
      warnings: [],
    });
    expect(waited.sleep).toBeGreaterThanOrEqual(35); // 40 ms from its yield*, which is after it was made
  });
});

describe('the driver: returned ops, handlers, refusals', () => {
  it('an async release or failure handler is a bare wait: current until its first await, and one that uses ramme after it fails with NoCurrentNodeError naming the cause, reported as a release failure and a handler exception (D41, decision 5)', async () => {
    const root = app();
    const seen: string[] = [];
    const n = root.child({ name: 'n' });
    n.own({}, async () => {
      seen.push(`release before its await: ${current().parent === n ? 'its fiber' : 'another node'}`);
      await Promise.resolve();
      lookup(createInjectionKey<string>('K')); // no current node after the first await
    });
    const released = await n.close().then(
      () => 'closed clean',
      (e: unknown) => e,
    );
    root.fork(
      task(
        function* (): Generator<Instruction, never, unknown> {
          throw new Error('fails');
        },
        {
          name: 'fails',
          onFailure: async () => {
            await Promise.resolve();
            current(); // the handler has no current node here either
          },
        },
      ),
    );
    const handled = await root.close().then(
      () => 'closed clean',
      (e: unknown) => e,
    );
    const describe = (e: unknown): string =>
      e instanceof NoCurrentNodeError && /no async context/.test(e.message) && /async release or handler/.test(e.message)
        ? 'NoCurrentNodeError naming the cause'
        : String(e);
    expect({ seen, released: describe(released), handled: describe(handled) }).toEqual({
      seen: ['release before its await: its fiber'],
      released: 'NoCurrentNodeError naming the cause',
      handled: 'NoCurrentNodeError naming the cause',
    });
  });

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
    const op = root.wait(src.promise) as unknown as WorkOp<number>;
    const it = op[Symbol.iterator]();
    const first = it.next();
    const ins = first.value as unknown as InstructionImpl;
    const resumed: unknown[] = [];
    const owner = impl(root);
    ins.sub = new Sub(op.start(owner, owner), (ok, x) => void resumed.push(ok, x)); // as the driver subscribes
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
    names.returnsFiber = fiber.status === 'defect' && fiber.error instanceof FiberNotAwaitableError ? 'FiberNotAwaitableError' : fiber.status;
    const asyncGen = await root.attempt(task(async function* () {} as unknown as () => Generator<Instruction, void, unknown>));
    names.asyncGenerator =
      asyncGen.status === 'defect' && asyncGen.error instanceof TypeError && /async generator/.test(asyncGen.error.message) ? 'TypeError' : asyncGen.status;
    const notAPromise = await root.attempt(function* () {
      yield* wait(42 as unknown as Promise<number>);
    });
    names.waitOfANumber = notAPromise.status === 'defect' && notAPromise.error instanceof TypeError ? 'TypeError' : notAPromise.status;
    const aFiber = await root.attempt(function* () {
      const f = fork(function* () {});
      yield* wait(f as unknown as Promise<void>); // never probes the fiber's `then` trap
    });
    names.waitOfAFiber = aFiber.status === 'defect' ? (aFiber.error as Error).name : aFiber.status;
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
      error: o.status === 'defect' && o.error instanceof TypeError && /async generator/.test(o.error.message) && /function\*/.test(o.error.message),
      ran,
    }).toEqual({ status: 'defect', error: true, ran: [] });
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
        'db.close(), wait': 'defect: db release failed',
        'release(tx), wait': 'defect: rollback failed',
        'db.close(), wait, caught': 'defect: db release failed',
        'release(tx), wait, caught': 'defect: rollback failed',
        'db.close(), abandon': 'defect: db release failed',
        'release(tx), abandon': 'defect: rollback failed',
        'db.close(), abandon, caught': 'defect: db release failed',
        'release(tx), abandon, caught': 'defect: rollback failed',
      },
      self: ['aborted', 'aborted'],
      log: [],
      warned: [true, true],
    });
  });

  it('wait(fn) whose fn returns a ramme op waits as that op, run for the body: a halt returns the body from wait(() => sleep(10_000)) at once, as from the sleep itself, never as a promise the halt lets finish', async () => {
    const started = Date.now();
    const status = await halt(function* () {
      yield* wait(() => sleep(10_000));
    });
    expect({ status, prompt: Date.now() - started < 1000 }).toEqual({ status: 'aborted', prompt: true });
  });

  it('a failure ramme hands the halted finally is never recorded as a release failure: a call there whose child ends aborted throws FiberAbortedError in, the finally catches it, and the node ends aborted, nothing recorded', async () => {
    let seen = '';
    const o = await halt(function* () {
      try {
        yield* never();
      } finally {
        try {
          yield* call(
            task(function* () {
              yield* never();
            }, { timeoutMs: 5 }), // release work on the unwind fiber, which its own timeout aborts
          );
        } catch (e) {
          seen = (e as Error).name;
        }
      }
    });
    expect({ seen, o }).toEqual({ seen: 'FiberAbortedError', o: 'aborted' });
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
    expect(o).toMatch(/^defect: .* was aborted$/);
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
      viaPromised: 'defect: ROLLBACK failed: connection reset',
      viaCall: 'defect: ROLLBACK failed: connection reset',
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

describe('the fixes of the stage 2 review', () => {
  it('wait(fn) whose fn returns a ramme op keeps that op’s waitsFor: a failure handler’s wait(() => root.close()) holds nothing, so the close completes, and in a halted finally wait(() => current()[Symbol.asyncDispose]()) is decision 12’s return, with the warning, as the op yielded bare is', async () => {
    const shapes: [string, (root: Context) => Op<void>][] = [
      ['bare', (root) => root.close()],
      ['wait(op)', (root) => wait(root.close())],
      ['wait(fn)', (root) => wait(() => root.close())],
    ];
    const closes: Record<string, string> = {};
    for (const [name, closing] of shapes) {
      const root = app();
      root.fork(
        task(
          function* (): Generator<Instruction, never, unknown> {
            throw new Error('boom');
          },
          {
            onFailure: function* () {
              yield* closing(root); // waits for its parent's completion: holds nothing from here on (DESIGN.md §4.7)
            },
          },
        ),
      );
      await tick();
      closes[name] = await within(root.close(), 300).then(
        () => 'closed',
        (e: Error) => e.message,
      );
    }
    const log: string[] = [];
    const disposals: [string, () => Op<void>][] = [
      ['bare', () => current()[Symbol.asyncDispose]()],
      ['wait(fn)', () => wait(() => current()[Symbol.asyncDispose]())],
      ['wait(fn), close', () => wait(() => current().close())],
    ];
    const self: Record<string, string> = {};
    for (const [name, disposing] of disposals)
      self[name] = await halt(function* () {
        try {
          yield* never();
        } finally {
          yield* disposing(); // its completion waits for this finally
          log.push(`${name}: unreachable`);
        }
      });
    expect({ closes, self, log, warned: rammeWarnings().filter((w) => /waits for its own/.test(w)).length }).toEqual({
      closes: { bare: 'closed', 'wait(op)': 'closed', 'wait(fn)': 'closed' },
      self: { bare: 'aborted', 'wait(fn)': 'aborted', 'wait(fn), close': 'aborted' },
      log: [],
      warned: 3,
    });
  });

  it('U3 for then: work ops made in the halted finally and run through their then (Promise.all, an async helper) run on the unwind fiber, as yield* all([…]) does: each cleanup runs to its end, the node ends aborted with nothing recorded, wait’s function there is handed the live deadline, and a cleanup’s failure is reported once', async () => {
    const log: string[] = [];
    const cleanup = (name: string) =>
      task(
        function* () {
          yield* sleep(5); // a child born delivered is returned here, before its cleanup
          log.push(`${name} cleaned`);
        },
        { name },
      );
    const outcomes: Record<string, string> = {
      'Promise.all': await halt(function* () {
        try {
          yield* never();
        } finally {
          yield* wait(Promise.all([call(cleanup('a')), call(cleanup('b'))]));
        }
      }),
      'async helper': await halt(function* () {
        try {
          yield* never();
        } finally {
          const op = call(cleanup('c'));
          yield* wait((async () => await op)());
        }
      }),
      'yield* all': await halt(function* () {
        try {
          yield* never();
        } finally {
          yield* all([cleanup('d'), cleanup('e')]);
        }
      }),
      'a failing cleanup': await halt(function* () {
        try {
          yield* never();
        } finally {
          yield* wait(Promise.all([call(failing('f', 20)), call(cleanup('g'))])); // f fails after g has cleaned
        }
      }),
    };
    let handedAborted: boolean | undefined;
    outcomes['wait(fn) through then'] = await halt(function* () {
      try {
        yield* never();
      } finally {
        const op = wait((signal) => {
          handedAborted = signal.aborted; // the unwind fiber's deadline, not the node's fired signal
          return bare(1);
        });
        yield* wait(Promise.resolve(op));
      }
    });
    expect({ outcomes, log: [...log].sort(), handedAborted }).toEqual({
      outcomes: {
        'Promise.all': 'aborted',
        'async helper': 'aborted',
        'yield* all': 'aborted',
        'a failing cleanup': 'defect: f failed', // once: the then consumed it, and the wait(p) recorded it
        'wait(fn) through then': 'aborted',
      },
      log: ['a cleaned', 'b cleaned', 'c cleaned', 'd cleaned', 'e cleaned', 'g cleaned'],
      handedAborted: false,
    });
  });

  it('a then whose op was made in a step of a body that is halted when the work settles leaves the failure with its holder: Promise.all over call, release or shield in a halted wait(p) still fails the node once, as yield* all([…]) does; the maker, not the receiver, decides (D39’s two cases)', async () => {
    const rollback = () => new Error('rollback failed');
    /** Fork `body` on a fresh root, abort it once it is suspended, and read its outcome and its handler's calls. */
    const interrupted = async (name: string, body: (log: string[]) => Generator<Instruction, unknown, unknown>, abortAfterMs = 0) => {
      const root = app();
      const handled: string[] = [];
      const log: string[] = [];
      const f = root.fork(task(() => body(log), { name, onFailure: (e: unknown) => void handled.push((e as Error).message) }));
      await (abortAfterMs > 0 ? bare(abortAfterMs) : tick());
      f.abort(new Error('hang up'));
      const o = await within(root.result(f));
      await within(root.close());
      return { outcome: o.status === 'defect' ? `defect: ${(o.error as Error).message}` : o.status, handled, log };
    };
    const child = task(
      function* () {
        own(() => {
          throw rollback(); // the child's release fails: aborted plus a release failure is failure (§4.12)
        });
        yield* sleep(1000);
      },
      { name: 'child' },
    );
    const other = task(
      function* () {
        yield* sleep(1000);
      },
      { name: 'other' },
    );
    const slowRollback = function* (): Generator<Instruction, never, unknown> {
      yield* sleep(5);
      throw rollback();
    };
    const cases = {
      call: await interrupted('call', function* () {
        yield* wait(Promise.all([call(child), call(other)]));
      }),
      release: await interrupted('release', function* () {
        const x = own({}, slowRollback);
        yield* wait(Promise.all([release(x)]));
      }),
      shield: await interrupted('shield', function* () {
        yield* wait(Promise.all([shield(slowRollback)]));
      }),
      'yield* all': await interrupted('all', function* () {
        yield* all([child, other]);
      }),
      // D39: an aborted fork awaiting its live parent's release(x): the failure is the parent's, not lost in the
      // fork's discarded wait.
      'a fork’s then of its live parent’s release(x)': await interrupted('parent', function* () {
        const parent = current();
        const x = own({}, slowRollback);
        const releaser = fork(
          task(
            function* () {
              yield* wait(Promise.all([parent.release(x)]));
            },
            { name: 'releaser' },
          ),
        );
        yield* sleep(1);
        releaser.abort(new Error('stop'));
        yield* sleep(20);
        return 'done';
      }, 100),
      // D39: a shield awaiting its interrupted body's release(x) consumes what it handles.
      'a shield’s then of its halted body’s release(x)': await interrupted('body', function* (log) {
        const body = current();
        const x = own({}, slowRollback);
        yield* shield(function* () {
          yield* sleep(10); // the body is halted meanwhile; the shield is release work
          try {
            yield* wait(Promise.all([body.release(x)]));
          } catch (e) {
            log.push(`shield handled: ${(e as Error).message}`);
          }
        });
      }),
    };
    expect(cases).toEqual({
      call: { outcome: 'defect: rollback failed', handled: ['rollback failed'], log: [] },
      release: { outcome: 'defect: rollback failed', handled: ['rollback failed'], log: [] },
      shield: { outcome: 'defect: rollback failed', handled: ['rollback failed'], log: [] },
      'yield* all': { outcome: 'defect: rollback failed', handled: ['rollback failed'], log: [] },
      'a fork’s then of its live parent’s release(x)': { outcome: 'defect: rollback failed', handled: ['rollback failed'], log: [] },
      'a shield’s then of its halted body’s release(x)': { outcome: 'aborted', handled: [], log: ['shield handled: rollback failed'] },
    });
  });

  it('decision 12 covers an observe fork made in the halted finally and joined there: not born delivered, it is delivered only by the node’s release, which waits for that finally, so the join or result returns the generator with the warning and the release then ends the fork; one that already ended gives its value, and one left unjoined ends with the release', async () => {
    const log: string[] = [];
    const obs = task(
      function* () {
        yield* interrupted();
        log.push('obs heard');
        return 'obs done';
      },
      { name: 'obs', interrupt: 'observe' },
    );
    const quick = task(
      function* () {
        return 'quick done';
      },
      { name: 'quick', interrupt: 'observe' },
    );
    const outcomes = {
      join: await halt(function* () {
        try {
          yield* never();
        } finally {
          const o = fork(obs);
          log.push(`join: ${yield* join(o)}`);
        }
      }),
      result: await halt(function* () {
        try {
          yield* never();
        } finally {
          const o = fork(obs);
          log.push(`result: ${(yield* result(o)).status}`);
        }
      }),
      'ended first': await halt(function* () {
        try {
          yield* never();
        } finally {
          const o = fork(quick);
          yield* sleep(1); // its body has ended: it completes on its own
          log.push(`ended first: ${yield* join(o)}`);
        }
      }),
      unjoined: await halt(function* () {
        try {
          yield* never();
        } finally {
          fork(obs);
        }
      }),
    };
    expect({ outcomes, log: [...log].sort(), warned: rammeWarnings().filter((w) => /waits for its own/.test(w)).length }).toEqual({
      outcomes: { join: 'aborted', result: 'aborted', 'ended first': 'aborted', unjoined: 'aborted' },
      log: ['ended first: quick done', 'obs heard', 'obs heard', 'obs heard'],
      warned: 2,
    });
  });

  it('the hazard that stays: a call, in the halted finally, of an observe task that waits for its own interruption is release work on the unwind fiber, which nothing delivers, so it holds the node, past root.abort(), until that task is aborted directly', async () => {
    const root = app();
    let callee: Context | undefined;
    const obs = task(
      function* () {
        callee = current();
        yield* interrupted();
        return 'obs done';
      },
      { name: 'obs', interrupt: 'observe' },
    );
    const f = root.fork(
      task(
        function* () {
          try {
            yield* never();
          } finally {
            yield* call(obs);
          }
        },
        { name: 'halted', onFailure: () => {} },
      ),
    );
    await tick();
    f.abort(new Error('hang up'));
    const done = deferred<string>();
    void root.result(f).then((o) => done.resolve(o.status));
    let state = 'pending';
    void done.promise.then((s) => (state = s));
    await bare(30);
    const stuck = state;
    root.abort(new Error('shutdown')); // stops at f, delivered already; the unwind fiber is never delivered
    await bare(30);
    const afterRootAbort = state;
    callee!.abort(new Error('direct'));
    expect({ stuck, afterRootAbort, final: await within(done.promise) }).toEqual({ stuck: 'pending', afterRootAbort: 'pending', final: 'aborted' });
  });

  it('a source whose then throws (a Promise subclass that overrides it) fails the wait at the yield*, never escaping the driver: the body catches it, an uncaught one fails the node, a halted body is returned, a halted finally records it as p’s own failure, and a failure handler’s wait fails the handler', async () => {
    class Hostile<T> extends Promise<T> {
      override then(): never {
        throw new Error('hostile then');
      }
    }
    const hostile = () => new Hostile<number>((resolve) => resolve(1));
    const root = app();
    const caught = await within(
      root.call(function* () {
        try {
          yield* wait(hostile());
          return 'not reached';
        } catch (e) {
          return `caught: ${(e as Error).message}`;
        }
      }),
    );
    const uncaught = await within(
      root.attempt(function* () {
        yield* wait(hostile());
      }),
    );
    const log: string[] = [];
    const halted = root.fork(
      task(
        function* () {
          try {
            current().abort(new Error('hang up')); // delivered inside its own step
            yield* wait(hostile()); // a started wait: subscribed, and its failure returns the halted body (row 3)
            log.push('unreachable');
          } catch {
            log.push('caught'); // never: a halted body's failed wait is not thrown in
          } finally {
            log.push('finally');
          }
        },
        { name: 'self-abort', onFailure: () => {} },
      ),
    );
    const haltedOutcome = (await within(root.result(halted))).status;
    const inHaltedFinally = await halt(function* () {
      try {
        yield* never();
      } finally {
        try {
          yield* wait(hostile());
        } catch {
          // caught: still p's own failure, recorded as a release failure, as its rejection would be
        }
      }
    });
    const handlerRoot = createRootContext();
    handlerRoot.fork(
      task(
        function* (): Generator<Instruction, never, unknown> {
          throw new Error('boom');
        },
        {
          onFailure: function* () {
            yield* sleep(1); // the next step runs in a source's reaction, outside the handler's call
            yield* wait(hostile());
          },
        },
      ),
    );
    await tick();
    const handlerClose = await within(handlerRoot.close()).then(
      () => 'closed',
      (e: Error) => `rejected: ${e.message}`,
    );
    expect({
      caught,
      uncaught: uncaught.status === 'defect' ? (uncaught.error as Error).message : uncaught.status,
      haltedOutcome,
      log,
      inHaltedFinally,
      handlerClose,
    }).toEqual({
      caught: 'caught: hostile then',
      uncaught: 'hostile then',
      haltedOutcome: 'aborted',
      log: ['finally'],
      inHaltedFinally: 'defect: hostile then',
      handlerClose: 'rejected: hostile then', // a handler's failure is collected with its parent's release failures (§4.7)
    });
  });

  it('a stored join or result run after its receiver completed refuses with NodeCompletedError, as a stored call does: the receiver’s completion surfaced the fiber’s failure already, and nothing is emitted on the receiver after its node:complete', async () => {
    const ev = events();
    roots.push(ev.root);
    const boom = new Error('boom');
    let outerId = -1;
    const stored: Record<string, PromiseLike<unknown>> = {};
    const outer = await within(
      ev.root.attempt(
        task(
          function* () {
            outerId = impl(current()).id;
            const f = fork(
              task(
                function* (): Generator<Instruction, never, unknown> {
                  yield* sleep(1);
                  throw boom;
                },
                { name: 'failing' },
              ),
            );
            stored.join = join(f);
            stored.result = result(f);
            stored.call = call(task(() => 1));
            yield* sleep(5);
            return 1;
          },
          { name: 'outer' },
        ),
      ),
    );
    const later: Record<string, string> = {};
    for (const [name, op] of Object.entries(stored))
      later[name] = await within(
        Promise.resolve(op).then(
          (v) => `resolved: ${JSON.stringify(v)}`,
          (e: Error) => e.name,
        ),
      );
    const types = ev.typesOf(outerId);
    expect({ outer: outer.status === 'defect' ? outer.error : outer.status, later, last: types[types.length - 1] }).toEqual({
      outer: boom, // surfaced once, from the receiver's completion (I11)
      later: { join: 'NodeCompletedError', result: 'NodeCompletedError', call: 'NodeCompletedError' },
      last: 'node:complete',
    });
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
