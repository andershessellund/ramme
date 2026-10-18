import { describe, it, expect } from 'vitest';
import { createRootContext } from './create-context.js';
import { lookup } from './inject.js';
import { withAbortSignal } from './fiber.js';
import { createFiberSet } from './fiber-set.js';
import { setScope, createInjectionKey } from './context-key.js';
import { RootScope } from './scope.js';
import { valueProvider } from './provider-util.js';
import './node.js';

describe('createFiberSet', () => {
  it('should spawn fibers into the pool context', async () => {
    const results: number[] = [];

    class Worker {
      private pool = createFiberSet({
        name: 'worker-pool',
        onError: () => {},
      });

      run(n: number) {
        this.pool.spawn(
          async () => {
            results.push(n);
          },
          { name: `task-${n}` },
        );
      }
    }
    setScope(Worker, RootScope);

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    worker.run(1);
    worker.run(2);
    worker.run(3);

    // Dispose waits for drain (all fibers complete)
    await ctx.dispose();
    expect(results).toEqual([1, 2, 3]);
  });

  it('should call onError when a fiber rejects', async () => {
    const errors: unknown[] = [];

    class Worker {
      private pool = createFiberSet({
        name: 'error-pool',
        onError: (err) => errors.push(err),
      });

      fail() {
        this.pool.spawn(
          async () => {
            throw new Error('boom');
          },
          { name: 'failing-task' },
        );
      }
    }
    setScope(Worker, RootScope);

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    worker.fail();

    await ctx.dispose();

    // Give the microtask from .catch() a tick to run
    await new Promise((r) => setTimeout(r, 10));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('should pass the fiber to onError', async () => {
    let capturedFiber: unknown = null;

    class Worker {
      private pool = createFiberSet({
        name: 'fiber-ref-pool',
        onError: (_err, fiber) => {
          capturedFiber = fiber;
        },
      });

      fail() {
        this.pool.spawn(
          async () => {
            throw new Error('fail');
          },
          { name: 'ref-task' },
        );
      }
    }
    setScope(Worker, RootScope);

    const ctx = createRootContext();
    ctx.get(Worker).fail();
    await ctx.dispose();
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedFiber).not.toBeNull();
    expect((capturedFiber as { id: number }).id).toBeTypeOf('number');
    expect((capturedFiber as { name: string }).name).toBe('ref-task');
  });

  it('should abort all fibers when abort() is called', async () => {
    let abortSeen = false;

    class Worker {
      private pool = createFiberSet({
        name: 'abort-pool',
        onError: () => {},
      });

      start() {
        this.pool.spawn(
          async () => {
            // Long-running work — will be aborted via withAbortSignal
            await withAbortSignal(
              (signal) =>
                new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(resolve, 10_000);
                  signal.addEventListener(
                    'abort',
                    () => {
                      clearTimeout(timer);
                      reject(new Error('aborted'));
                    },
                    { once: true },
                  );
                }),
            );
          },
          { name: 'long-task' },
        );
      }

      stop() {
        this.pool.abort();
        abortSeen = true;
      }

      getPoolContext() {
        return this.pool.context;
      }
    }
    setScope(Worker, RootScope);

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    worker.start();
    worker.stop();

    expect(worker.getPoolContext().aborted).toBe(true);

    // Should resolve quickly since we aborted
    await ctx.dispose();
    expect(abortSeen).toBe(true);
  });

  it('should expose the pool context', async () => {
    class Worker {
      private pool = createFiberSet({
        name: 'ctx-pool',
        onError: () => {},
      });

      getContext() {
        return this.pool.context;
      }
    }
    setScope(Worker, RootScope);

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    const poolCtx = worker.getContext();

    expect(poolCtx).toBeDefined();
    expect(poolCtx.status).toBe('active');

    await ctx.dispose();
    expect(poolCtx.status).toBe('disposed');
  });

  it('should dispose pool when parent context disposes', async () => {
    const disposed: string[] = [];

    class Worker {
      private pool = createFiberSet({
        name: 'lifecycle-pool',
        onError: () => {},
      });

      run() {
        this.pool.spawn(
          async () => {
            disposed.push('fiber-done');
          },
          { name: 'lifecycle-task' },
        );
      }

      getPoolStatus() {
        return this.pool.context.status;
      }
    }
    setScope(Worker, RootScope);

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    worker.run();

    expect(worker.getPoolStatus()).toBe('active');
    await ctx.dispose();
    expect(worker.getPoolStatus()).toBe('disposed');
    expect(disposed).toContain('fiber-done');
  });

  it('should forward spawn options (providers, scopes)', async () => {
    const TestKey = createInjectionKey<string>('test-key');

    class Worker {
      private pool = createFiberSet({
        name: 'opts-pool',
        onError: () => {},
      });

      run(): Promise<string> {
        const fiber = this.pool.spawn(
          async () => {
            return lookup(TestKey);
          },
          {
            name: 'opts-task',
            providers: [valueProvider(TestKey, 'provided-value')],
          },
        );
        return fiber.promise;
      }
    }
    setScope(Worker, RootScope);

    const ctx = createRootContext();
    const worker = ctx.get(Worker);
    const result = await worker.run();

    expect(result).toBe('provided-value');
    await ctx.dispose();
  });
});
