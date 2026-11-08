// Tests for tasks / forking.
import { describe, expect, it } from 'vitest';
import { fork, join, lookup, own, signal, wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import type { Fiber } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { factoryProvider, valueProvider } from '../../src/provider-util.js';
import { NoCurrentNodeError } from '../../src/resource.js';
import { createScope } from '../../src/scope.js';
import { tick, trace } from '../support/util.js';

const link = { onFailure: 'link' } as const;

/** The rejection of `p`; throws if `p` fulfils. Awaits `p` directly, so a managed `p` is awaited by its own body, a direct await (DESIGN.md §4.2). */
async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

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

describe('spawn (fork with a destination, or inside a call)', () => {
  it('returns a fiber that can be joined', async () => {
    const ctx = createRootContext();
    expect(await ctx.call(function* () { return yield* join(fork(function* () { return 'spawned'; })); })).toBe('spawned');
    await ctx.close();
  });

  it('has a name', async () => {
    const ctx = createRootContext();
    const fiber = ctx.fork(task(function* () { return 'hi'; }, { name: 'my-fiber', ...link }));
    expect(fiber.name).toBe('my-fiber');
    expect(await ctx.result(fiber)).toEqual({ status: 'success', value: 'hi' });
    await ctx.close();
  });

  it("releases the fiber's node on completion", async () => {
    const ctx = createRootContext();
    let disposed = false;
    const KEY = createInjectionKey<string>('test');
    await ctx.call(function* () {
      const fiber = fork(
        task(
          function* () {
            lookup(KEY);
          },
          {
            providers: [
              factoryProvider(KEY, () => {
                own(() => {
                  disposed = true;
                });
                return 'value';
              }),
            ],
          },
        ),
      );
      yield* join(fiber);
      expect(disposed).toBe(true); // join resolves at completion, after the release
    });
    await ctx.close();
  });

  it("releases the fiber's node on error", async () => {
    const ctx = createRootContext();
    let disposed = false;
    const KEY = createInjectionKey<string>('test');
    await ctx.call(function* () {
      const fiber = fork(
        task(
          function* () {
            lookup(KEY);
            throw new Error('spawn error');
          },
          {
            providers: [
              factoryProvider(KEY, () => {
                own(() => {
                  disposed = true;
                });
                return 'value';
              }),
            ],
          },
        ),
      );
      expect(((yield* wait(rejection(join(fiber)))) as Error).message).toBe('spawn error');
      expect(disposed).toBe(true);
    });
    await ctx.close();
  });

  it('runs concurrently', async () => {
    const ctx = createRootContext();
    const order: string[] = [];
    await ctx.call(function* () {
      const f1 = fork(function* () {
        order.push('f1-start');
        yield* wait(sleep(30));
        order.push('f1-end');
      });
      const f2 = fork(function* () {
        order.push('f2-start');
        yield* wait(sleep(10));
        order.push('f2-end');
      });
      yield* join(f1);
      yield* join(f2);
    });
    expect(order).toEqual(['f1-start', 'f2-start', 'f2-end', 'f1-end']);
    await ctx.close();
  });

  it('abort() on the fiber fires its signal() and halts it at its wait', async () => {
    const ctx = createRootContext();
    const t = trace();
    let signalAborted = false;
    const fiber = ctx.fork(
      task(function* () {
        const s = signal();
        s.addEventListener('abort', () => {
          signalAborted = true;
        });
        yield* wait(sleep(1000, s), { abandon: true }); // the sleep resolves on abort: only the rejection keeps the body from going on
        t.push('resumed');
      }, link),
    );
    await tick();
    fiber.abort();
    expect((await ctx.result(fiber)).status).toBe('aborted');
    expect(signalAborted).toBe(true);
    await tick(3);
    expect(t.log).toEqual([]);
    await ctx.close();
  });

  it("close() on the parent waits for the fiber (the parent's wait is the drain)", async () => {
    const ctx = createRootContext();
    let completed = false;
    ctx.fork(
      task(function* () {
        yield* wait(sleep(50));
        completed = true;
      }, link),
    );
    await ctx.close();
    expect(completed).toBe(true);
  });

  it("abort() on the parent reaches the fiber's signal", async () => {
    const ctx = createRootContext();
    let signalAborted = false;
    ctx.fork(
      task(function* () {
        const s = signal();
        s.addEventListener('abort', () => {
          signalAborted = true;
        });
        yield* wait(sleep(1000, s), { abandon: true });
      }, link),
    );
    await tick();
    ctx.abort();
    await ctx.close();
    expect(signalAborted).toBe(true);
  });

  it("provides providers to the fiber's node", async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test');
    const r = await ctx.call(function* () { return yield* join(fork(task(function* () { return lookup(KEY); }, { providers: [valueProvider(KEY, 'spawn-provided')] }))); });
    expect(r).toBe('spawn-provided');
    await ctx.close();
  });

  it("supports scopes on the fiber's node", async () => {
    const ctx = createRootContext();
    const TestScope = createScope('test');
    const KEY = createInjectionKey<string>('scoped', { factory: () => 'scoped-val', scope: TestScope });
    const r = await ctx.call(function* () { return yield* join(fork(task(function* () { return lookup(KEY); }, { scopes: [TestScope] }))); });
    expect(r).toBe('scoped-val');
    await ctx.close();
  });

  it('throws NoCurrentNodeError when no node is current', () => {
    expect(() => fork(function* () { return 'hello'; })).toThrow(NoCurrentNodeError);
  });

  it('supports call inside a forked body', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('inner');
    const r = await ctx.call(function* () {
      const fiber = fork(function* () { return yield* task(function* () { return lookup(KEY); }, { providers: [valueProvider(KEY, 'from-call')] })(); });
      return yield* join(fiber);
    });
    expect(r).toBe('from-call');
    await ctx.close();
  });
});

describe('fork', () => {
  it('forks from the current node', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test', { factory: () => 'forked' });
    expect(await ctx.call(function* () { return yield* join(fork(function* () { return lookup(KEY); })); })).toBe('forked');
    await ctx.close();
  });

  it('accepts providers and scopes', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test');
    const TestScope = createScope('test');
    const SCOPED = createInjectionKey<string>('scoped', { factory: () => 'scoped-val', scope: TestScope });
    const r = await ctx.call(function* () {
      const fiber = fork(
        task(function* () { return `${lookup(KEY)}-${lookup(SCOPED)}`; }, { providers: [valueProvider(KEY, 'provided')], scopes: [TestScope] }),
      );
      return yield* join(fiber);
    });
    expect(r).toBe('provided-scoped-val');
    await ctx.close();
  });

  it('throws NoCurrentNodeError when no node is current', () => {
    expect(() => fork(function* () { return 'hello'; })).toThrow(NoCurrentNodeError);
  });

  it("explicit join lets a fork finish naturally; explicit abort stops it and the call waits for cleanup", async () => {
    const ctx = createRootContext();
    let completed = false;
    await ctx.call(
      task(
        function* () {
          const f = fork(function* () {
            yield* wait(sleep(30));
            completed = true;
          });
          yield* join(f);
        },
        { childrenOnExit: 'await' },
      ),
    );
    expect(completed).toBe(true);

    const t = trace();
    let forked: Fiber<void> | undefined;
    await ctx.call(function* () {
      forked = fork(function* () {
        own(() => t.push('fork released'));
        yield* wait(sleep(1000, signal()), { abandon: true });
        t.push('resumed');
      });
      yield* wait(tick()); // let it start
      forked.abort();
    });
    expect(t.log).toEqual(['fork released']); // released before the call resolved
    expect(forked?.state).toBe('complete');
    expect(forked?.outcome?.status).toBe('aborted');
    await ctx.close();
  });
});
