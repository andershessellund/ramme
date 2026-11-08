// Tests for runtime / wait interop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { child, current, lookup, never, own, promised, release, sleep, wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import type { Context, Instruction, Op } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { factoryProvider } from '../../src/provider-util.js';
import { CreationViolationError } from '../../src/resource.js';
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

describe('wait interoperability and cleanup', () => {
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
          yield* task(function* () {
            yield* never();
          }, { timeoutMs: 5 })(); // release work on the unwind fiber, which its own timeout aborts
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
      yield* task(body)('tx');
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
