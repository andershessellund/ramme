// Tests for runtime / body validation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attempt, createRootContext, fork, own, pool, promised, result, settle, shield, task, unshield, wait } from '../../src/index.js';
import type { Context, Instruction } from '../../src/index.js';
import { within } from '../support/util.js';

/** Every `console.warn` of the current test, first argument only; the spy keeps them off the console. */
const warnings: string[] = [];

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

beforeEach(() => {
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** A refusal of an async body, as the observation reads it: `TypeError naming function*`, or what came instead. */
function refusal(e: unknown): string {
  if (e instanceof TypeError && e.message.includes('function*')) return 'TypeError naming function*';
  return e instanceof Error ? `${e.name}: ${e.message}` : `not an error: ${String(e)}`;
}

describe('async bodies are refused (decision 5)', () => {
  it('an async function as a body is refused with a TypeError naming function*, wherever a body is run; an async release and an async failure handler are still waited for', async () => {
    /** An async body, cast to the body type so the test compiles where async bodies are a type error. */
    const asyncBody = (async () => 'ran') as unknown as () => Generator<Instruction, string, unknown>;
    const log: string[] = [];
    const root = app();
    const inBodies = await within(
      root.call(function* () {
        const seen: Record<string, string> = {};
        try {
          seen.call = `value ${yield* task(asyncBody)()}`;
        } catch (e) {
          seen.call = refusal(e);
        }
        try {
          const o = yield* attempt(asyncBody);
          seen.attempt = o.status === 'defect' ? refusal(o.error) : o.status;
        } catch (e) {
          seen.attempt = refusal(e);
        }
        try {
          const o = yield* result(fork(asyncBody));
          seen.fork = o.status === 'defect' ? refusal(o.error) : o.status;
        } catch (e) {
          seen.fork = refusal(e);
        }
        try {
          seen.shield = `value ${yield* shield(asyncBody)}`;
        } catch (e) {
          seen.shield = refusal(e);
        }
        seen.unshield = yield* shield(function* () {
          try {
            const o = yield* unshield(asyncBody);
            return o.status === 'defect' ? refusal(o.error) : o.status;
          } catch (e) {
            return refusal(e);
          }
        });
        try {
          const [o] = yield* settle([task(asyncBody)]);
          seen['settle member'] = o.status === 'defect' ? refusal(o.error) : o.status;
        } catch (e) {
          seen['settle member'] = refusal(e);
        }
        try {
          const failures: unknown[] = [];
          const p = pool({ name: 'p', onFailure: (e) => void failures.push(e) });
          p.fork(asyncBody);
          yield* p.close();
          seen['pool.fork'] = failures.length === 0 ? 'no failure' : failures.map(refusal).join('; ');
        } catch (e) {
          seen['pool.fork'] = refusal(e);
        }
        try {
          const callback = promised(asyncBody);
          seen.promised = yield* wait(callback().then((v) => `value ${v}`, refusal));
        } catch (e) {
          seen.promised = refusal(e);
        }
        // Still waited for: a release or a failure handler may return a promise, a bare wait (D41, decision 5).
        yield* task(function* () {
          own({}, async () => {
            await Promise.resolve();
            log.push('async release ran to its end');
          });
        })();
        return seen;
      }),
    );
    const topLevel = await within(root.call(asyncBody).then((v) => `value ${v}`, refusal));
    root.fork(
      task(
        function* () {
          throw new Error('fails');
        },
        {
          name: 'fails',
          onFailure: async () => {
            await Promise.resolve();
            log.push('async handler ran to its end');
          },
        },
      ),
    );
    await within(root.close());
    const refused = 'TypeError naming function*';
    expect({ inBodies, topLevel, log }).toEqual({
      inBodies: {
        call: refused,
        attempt: refused,
        fork: refused,
        shield: refused,
        unshield: refused,
        'settle member': refused,
        'pool.fork': refused,
        promised: refused,
      },
      topLevel: refused,
      log: ['async release ran to its end', 'async handler ran to its end'],
    });
  });
});
