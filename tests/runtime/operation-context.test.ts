// Tests for runtime / operation context.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoCurrentNodeError, all, attempt, createInjectionKey, createRootContext, current, fork, interrupted, join, lookup, never, own, race, result, settle, shield, signal, sleep, task, unshield, valueProvider, wait } from '../../src/index.js';
import type { Context } from '../../src/index.js';
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

/** A handler for forks onto the bodiless root (D14). */
const quiet = { onFailure: () => {} } as const;

/** The class name of what `make` throws, or `no error`. */
function thrownBy(make: () => unknown): string {
  try {
    make();
    return 'no error';
  } catch (e) {
    return e instanceof Error ? e.name : String(e);
  }
}

describe('construction reads the slot; there is no async context (decisions 17, 18)', () => {
  it('decision 17: a free-function work op made outside any frame throws NoCurrentNodeError at construction, its message naming the cause and the three entry points; in a creation frame CreationViolationError; ctx.verb(…) made at top level runs under its receiver', async () => {
    const v = task(
      function* () {
        return 'v';
      },
      { name: 'v' },
    );
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    roots.push(root);
    const f = root.fork(v.with(quiet));
    await within(root.result(f));
    const makers: Record<string, () => unknown> = {
      call: () => v(),
      attempt: () => attempt(v),
      all: () => all([v]),
      race: () => race([v]),
      settle: () => settle([v]),
      shield: () => shield(v),
      unshield: () => unshield(v),
      join: () => join(f),
      result: () => result(f),
      sleep: () => sleep(1),
      interrupted: () => interrupted(),
      never: () => never(),
      wait: () => wait(Promise.resolve(1)),
    };
    /** The class thrown, and, for NoCurrentNodeError, what its message fails to say (D41, decision 18). */
    const outsideOf = (make: () => unknown): string => {
      try {
        make();
        return 'no error';
      } catch (e) {
        if (!(e instanceof NoCurrentNodeError)) return e instanceof Error ? e.name : String(e);
        const missing = Object.entries({
          'no async context': /no async context/i,
          await: /\bawait\b/,
          'an explicit receiver': /receiver/i,
          promised: /\bpromised\b/,
          'node.run': /\.run\b/,
        })
          .filter(([, re]) => !re.test(e.message))
          .map(([what]) => what);
        return missing.length === 0 ? 'NoCurrentNodeError' : `NoCurrentNodeError, its message missing: ${missing.join(', ')}`;
      }
    };
    const outside = Object.fromEntries(Object.entries(makers).map(([name, make]) => [name, outsideOf(make)]));
    const creation: Record<string, string> = {};
    const V = createInjectionKey<object>('V', {
      factory: () => {
        for (const [name, make] of Object.entries(makers)) creation[name] = thrownBy(make);
        return {};
      },
    });
    root.child().get(V);
    const receiver = {
      call: await root.call(v),
      attempt: await root.attempt(v),
      all: await root.all([v]),
      race: await root.race([v]),
      settle: await root.settle([v]),
      shield: await root.shield(v),
      join: await root.join(f),
      result: await root.result(f),
      sleep: await root.sleep(1),
      wait: await root.wait(Promise.resolve(2)),
    };
    const success = { status: 'success', value: 'v' };
    expect({ outside, creation, receiver }).toEqual({
      outside: Object.fromEntries(Object.keys(makers).map((name) => [name, 'NoCurrentNodeError'])),
      creation: Object.fromEntries(Object.keys(makers).map((name) => [name, 'CreationViolationError'])),
      receiver: {
        call: 'v',
        attempt: success,
        all: ['v'],
        race: 'v',
        settle: [success],
        shield: 'v',
        join: 'v',
        result: success,
        sleep: undefined,
        wait: 2,
      },
    });
  });

  it('decision 18: async code a step starts sees the step’s node until its first await and none after it: current() and every free function throw NoCurrentNodeError there', async () => {
    const v = task(
      function* () {
        return 'v';
      },
      { name: 'v' },
    );
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    roots.push(root);
    const seen: { before?: string; after?: Record<string, string> } = {};
    const out = await within(
      root.call(function* () {
        const node = current();
        const plain = (async () => {
          seen.before = current() === node ? 'the step’s node' : 'another node'; // still inside the step: the slot is set
          await Promise.resolve();
          const after: Record<string, () => unknown> = {
            current: () => current(),
            signal: () => signal(),
            lookup: () => lookup(K),
            own: () => own({}, () => {}),
            fork: () => fork(v),
            sleep: () => sleep(1),
            wait: () => wait(Promise.resolve(1)),
            call: () => v(),
          };
          seen.after = Object.fromEntries(Object.entries(after).map(([name, make]) => [name, thrownBy(make)]));
        })();
        yield* wait(plain);
        return 'done';
      }),
    );
    expect({ out, seen }).toEqual({
      out: 'done',
      seen: {
        before: 'the step’s node',
        after: {
          current: 'NoCurrentNodeError',
          signal: 'NoCurrentNodeError',
          lookup: 'NoCurrentNodeError',
          own: 'NoCurrentNodeError',
          fork: 'NoCurrentNodeError',
          sleep: 'NoCurrentNodeError',
          wait: 'NoCurrentNodeError',
          call: 'NoCurrentNodeError',
        },
      },
    });
  });
});

describe('the slot alone (decision 18)', () => {
  it('in a module graph where nothing registered any storage and nothing imported ./node.js, a generator body runs: current() names its node across its yield*s, a fork’s body sees its parent, and node.run re-enters it', async () => {
    vi.resetModules(); // a fresh module graph: the registration at the top of this file is not in it
    const m = await import('../../src/index.js');
    const root = m.createRootContext();
    const seen = await within(
      root
        .call(function* () {
          const node = m.current();
          yield* m.sleep(1);
          const same = m.current() === node;
          const f = m.fork(
            m.task(function* () {
              yield* m.wait(Promise.resolve());
              return m.current().parent === node;
            }),
          );
          const forkSawParent = yield* m.join(f);
          const reentered = node.run(() => m.current() === node);
          return { same, forkSawParent, reentered };
        })
        .then(
          (v) => v,
          (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
        ),
    );
    await within(root.close().then(undefined, () => {}));
    expect(seen).toEqual({ same: true, forkSawParent: true, reentered: true });
  });
});
