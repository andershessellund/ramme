// Tests for runtime / unwind context.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, attempt, current, fork, interrupted, join, never, own, promised, release, releaseAll, result, settle, shield, signal, sleep, unshield, wait } from '../../src/ambient.js';
import type { Context, Instruction, Op, Outcome } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { tick, within } from '../support/util.js';

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

/** A source whose `then` throws: a `Promise` subclass that overrides it. */
class Hostile<T> extends Promise<T> {
  override then(): never {
    throw new Error('hostile then');
  }
}

const failing = (name: string, ms = 1) =>
  task(
    function* (): Generator<Instruction, never, unknown> {
      yield* sleep(ms);
      throw new Error(`${name} failed`);
    },
    { name },
  );

describe('halted-finally context and cleanup', () => {
  it('the generator’s own throw in its halted finally is a release failure (defect); a shield’s failure caught there is not consumed, and is the outcome; rethrown, it is reported once', async () => {
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
      await halt(function* () {
        try {
          yield* never();
        } finally {
          try {
            yield* shield(function* (): Generator<Instruction, never, unknown> {
              throw new Error('cleanup threw');
            });
          } catch (e) {
            throw e; // the failure the wait handed it: one release failure, not two
          }
        }
      }),
      await halt(function* () {
        try {
          yield* never();
        } finally {
          try {
            yield* wait(new Hostile<void>((resolve) => resolve())); // its `then` throws: p's own failure, recorded
          } catch (e) {
            throw e; // one release failure, not two
          }
        }
      }),
    ];
    expect(outcomes).toEqual(['defect: cleanup threw', 'defect: cleanup threw', 'defect: cleanup threw', 'defect: hostile then']);
  });

  it('release(x) and releaseAll() in the halted finally address the node, so they find its entries and run now', async () => {
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

  it('a failure the halted finally catches from release(tx), call(t), attempt(t) or join(f) is not consumed: it is the outcome, once', async () => {
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
            yield* failing('rollback')();
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

  it('decision 12 while a helper’s finally is suspended skips the rest of that block; the body’s own finally still runs and may yield, and nothing reports a lost halt', async () => {
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

  it('a shield made in the halted finally runs on the node, not on the unwind fiber: its owner was interrupted, so a hole in it is skipped at once', async () => {
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
