// Tests for integration / task lifetime.
import { describe, expect, it } from 'vitest';
import { fork, join, lookup, own, wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';

const link = { onFailure: 'link' } as const;

/** Resolves after `ms`, or as soon as `s` aborts (the timer is cleared then). */
function sleep(ms: number, s?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    s?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

describe('integration', () => {
  it('supports mixed call and fork patterns', async () => {
    const ctx = createRootContext();
    const results: string[] = [];
    await ctx.call(function* () {
      results.push('call-start');
      const f = fork(function* () {
        yield* wait(sleep(20));
        results.push('fork-done');
        return 'fork-result';
      });
      results.push('after-fork');
      results.push(`got-${yield* join(f)}`);
    });
    expect(results).toEqual(['call-start', 'after-fork', 'fork-done', 'got-fork-result']);
    await ctx.close();
  });

  it('cleans up everything when the parent closes', async () => {
    const ctx = createRootContext();
    const disposed: string[] = [];
    const KEY_A = createInjectionKey<string>('A', {
      factory: () => {
        own(() => {
          disposed.push('A');
        });
        return 'a';
      },
    });
    ctx.fork(
      task(function* () {
        lookup(KEY_A);
        yield* wait(sleep(30));
      }, link),
    );
    await ctx.close();
    expect(disposed).toEqual(['A']);
  });
});
