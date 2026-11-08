// Tests for runtime / generator collection.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleep, wait } from '../../src/ambient.js';
import type { Context, Fiber, Instruction } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { deferred, gcUntil, hasGc, tick, within } from '../support/util.js';

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

describe('A1: a halted body retains nothing', () => {
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
