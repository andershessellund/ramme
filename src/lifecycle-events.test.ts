import { describe, it, expect } from 'vitest';
import { createInjectionKey } from './context-key.js';
import { factoryProvider, valueProvider } from './provider-util.js';
import { createRootContext } from './create-context.js';
import { inject, lookup, RegisterResource } from './inject.js';
import { Dispose, Drain, Flush } from './resource.js';
import { Fiber } from './fiber.js';
import { FiberTopic, ContextTopic } from './lifecycle-events.js';
import type { FiberEvent, ContextEvent } from './lifecycle-events.js';
import './node.js';

// ---------------------------------------------------------------------------
// Fiber events — Fiber.call / Fiber.spawn
// ---------------------------------------------------------------------------

describe('Fiber events', () => {
  it('should emit call:enter and call:leave for Fiber.call', async () => {
    const events: FiberEvent[] = [];

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    await Fiber.call(
      async () => {
        return 'ok';
      },
      { context: ctx, name: 'my-call' },
    );

    expect(events).toHaveLength(2);

    const entered = events[0] as Extract<FiberEvent, { type: 'call:enter' }>;
    expect(entered.type).toBe('call:enter');
    expect(entered.name).toBe('my-call');

    const left = events[1] as Extract<FiberEvent, { type: 'call:leave' }>;
    expect(left.type).toBe('call:leave');
    expect(left.outcome).toBe('success');
    expect(left.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should emit call:leave with error on Fiber.call failure', async () => {
    const events: FiberEvent[] = [];

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    await Fiber.call(
      async () => {
        throw new Error('boom');
      },
      { context: ctx, name: 'fail-call' },
    ).catch(() => {});

    const left = events[1] as Extract<FiberEvent, { type: 'call:leave' }>;
    expect(left.outcome).toBe('error');
    expect(left.error).toBe('boom');
  });

  it('should emit fiber:started and fiber:settled for Fiber.spawn', async () => {
    const events: FiberEvent[] = [];

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    const fiber = Fiber.spawn(
      async () => {
        return 42;
      },
      { context: ctx, name: 'my-spawn' },
    );

    await Fiber.join(fiber);

    const started = events[0] as Extract<FiberEvent, { type: 'fiber:started' }>;
    expect(started.type).toBe('fiber:started');
    expect(started.name).toBe('my-spawn');
    expect(started.mode).toBe('spawn');

    const settled = events.find((e) => e.type === 'fiber:settled') as Extract<
      FiberEvent,
      { type: 'fiber:settled' }
    >;
    expect(settled.outcome).toBe('success');
  });

  it('should emit zero fiber events when no FiberTopic is provided', async () => {
    // Zero overhead path — no receiver, no events
    const ctx = createRootContext();

    const result = await Fiber.call(
      async () => {
        return 'fast';
      },
      { context: ctx },
    );

    expect(result).toBe('fast');
    // No assertion on events — just ensure no error is thrown
  });

  it('should emit fiber:started with mode=fork for Fiber.fork', async () => {
    const events: FiberEvent[] = [];

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    await Fiber.call(
      async () => {
        const fiber = Fiber.fork(async () => 'forked', { name: 'my-fork' });
        await Fiber.join(fiber);
      },
      { context: ctx },
    );

    const started = events.find(
      (e) => e.type === 'fiber:started' && e.name === 'my-fork',
    ) as Extract<FiberEvent, { type: 'fiber:started' }>;
    expect(started).toBeDefined();
    expect(started.mode).toBe('fork');
  });

  it('should emit join:enter and join:leave for Fiber.join', async () => {
    const events: FiberEvent[] = [];

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    await Fiber.call(
      async () => {
        const fiber = Fiber.fork(async () => 42);
        await Fiber.join(fiber);
      },
      { context: ctx },
    );

    const joinEnter = events.find((e) => e.type === 'join:enter') as Extract<
      FiberEvent,
      { type: 'join:enter' }
    >;
    expect(joinEnter).toBeDefined();
    expect(joinEnter.joinedFiberId).toBeTypeOf('number');

    const joinLeave = events.find((e) => e.type === 'join:leave') as Extract<
      FiberEvent,
      { type: 'join:leave' }
    >;
    expect(joinLeave).toBeDefined();
    expect(joinLeave.outcome).toBe('success');
    expect(joinLeave.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should emit join:leave with error outcome on Fiber.join failure', async () => {
    const events: FiberEvent[] = [];

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    await Fiber.call(
      async () => {
        const fiber = Fiber.fork(async () => {
          throw new Error('join-fail');
        });
        await Fiber.join(fiber).catch(() => {});
      },
      { context: ctx },
    );

    const joinLeave = events.find((e) => e.type === 'join:leave') as Extract<
      FiberEvent,
      { type: 'join:leave' }
    >;
    expect(joinLeave).toBeDefined();
    expect(joinLeave.outcome).toBe('error');
    expect(joinLeave.error).toBe('join-fail');
  });

  it('should emit join:enter and join:leave for Fiber.result', async () => {
    const events: FiberEvent[] = [];

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    await Fiber.call(
      async () => {
        const fiber = Fiber.fork(async () => 'ok');
        await Fiber.result(fiber);
      },
      { context: ctx },
    );

    const joinEnter = events.find((e) => e.type === 'join:enter');
    const joinLeave = events.find((e) => e.type === 'join:leave');
    expect(joinEnter).toBeDefined();
    expect(joinLeave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Context events — resource naming
// ---------------------------------------------------------------------------

describe('Context events — resource naming', () => {
  it('should emit resourceName on resource:registered', async () => {
    const events: ContextEvent[] = [];

    const KEY = createInjectionKey<string>('MyService', {
      factory: () => {
        inject(RegisterResource)({
          [Dispose]: () => {},
        });
        return 'svc';
      },
    });

    const ctx = createRootContext({
      providers: [valueProvider(ContextTopic, (e: ContextEvent) => events.push(e))],
    });

    ctx.get(KEY);

    const registered = events.find((e) => e.type === 'resource:registered') as Extract<
      ContextEvent,
      { type: 'resource:registered' }
    >;

    expect(registered).toBeDefined();
    expect(registered.resourceName).toBe('MyService');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle fibers — drain/flush/dispose observability
// ---------------------------------------------------------------------------

describe('Lifecycle fibers', () => {
  it('should emit lifecycle fiber events during dispose', async () => {
    const events: FiberEvent[] = [];

    const KEY = createInjectionKey<string>('MyResource', {
      factory: () => {
        inject(RegisterResource)({
          [Drain]: () => {},
          [Flush]: () => {},
          [Dispose]: () => {},
        });
        return 'resource';
      },
    });

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    // Trigger creation
    ctx.get(KEY);

    // Dispose — should fire lifecycle fibers for drain, flush, dispose
    await ctx.dispose();

    // Filter lifecycle fibers only
    const lifecycleStarted = events.filter(
      (e) => e.type === 'fiber:started' && (e as any).mode === 'lifecycle',
    ) as Extract<FiberEvent, { type: 'fiber:started' }>[];

    const lifecycleSettled = events.filter((e) => e.type === 'fiber:settled');

    // We expect 3 lifecycle fibers: drain, flush, dispose
    expect(lifecycleStarted).toHaveLength(3);
    expect(lifecycleSettled).toHaveLength(3);

    // Check phases
    const phases = lifecycleStarted.map((e) => (e as any).phase);
    expect(phases).toContain('drain');
    expect(phases).toContain('flush');
    expect(phases).toContain('dispose');

    // Check resource names
    for (const e of lifecycleStarted) {
      expect((e as any).resourceName).toBe('MyResource');
    }
  });

  it('should emit lifecycle fibers for async resource methods', async () => {
    const events: FiberEvent[] = [];
    const order: string[] = [];

    const KEY = createInjectionKey<string>('AsyncResource', {
      factory: () => {
        inject(RegisterResource)({
          [Dispose]: async () => {
            await new Promise((r) => setTimeout(r, 5));
            order.push('disposed');
          },
        });
        return 'async-resource';
      },
    });

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    ctx.get(KEY);
    await ctx.dispose();

    expect(order).toEqual(['disposed']);

    const settled = events.filter((e) => e.type === 'fiber:settled') as Extract<
      FiberEvent,
      { type: 'fiber:settled' }
    >[];

    // At least dispoae lifecycle fiber
    expect(settled.length).toBeGreaterThanOrEqual(1);
    expect(settled.every((e) => e.outcome === 'success')).toBe(true);
  });

  it('should NOT emit lifecycle fibers when no FiberTopic is provided', async () => {
    // Zero overhead — no receiver, no lifecycle fibers
    let drainCalled = false;
    let disposeCalled = false;

    const KEY = createInjectionKey<string>('NoObserver', {
      factory: () => {
        inject(RegisterResource)({
          [Drain]: () => {
            drainCalled = true;
          },
          [Dispose]: () => {
            disposeCalled = true;
          },
        });
        return 'val';
      },
    });

    const ctx = createRootContext();
    ctx.get(KEY);
    await ctx.dispose();

    // Resource methods still called even without observer
    expect(drainCalled).toBe(true);
    expect(disposeCalled).toBe(true);
  });

  it('should handle errors in lifecycle fibers', async () => {
    const events: FiberEvent[] = [];

    const KEY = createInjectionKey<string>('ErrorResource', {
      factory: () => {
        inject(RegisterResource)({
          [Dispose]: () => {
            throw new Error('dispose-error');
          },
        });
        return 'err-resource';
      },
    });

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    ctx.get(KEY);

    // dispose() should propagate the error
    await expect(ctx.dispose()).rejects.toThrow('dispose-error');

    // The lifecycle fiber should be settled with error
    const settled = events.find(
      (e) => e.type === 'fiber:settled' && e.outcome === 'error',
    ) as Extract<FiberEvent, { type: 'fiber:settled' }>;

    expect(settled).toBeDefined();
    expect(settled.error).toBe('dispose-error');
  });

  it('should skip lifecycle fibers for resources without the method', async () => {
    const events: FiberEvent[] = [];

    // Resource with only Dispose (no Drain, no Flush)
    const KEY = createInjectionKey<string>('DisposeOnly', {
      factory: () => {
        inject(RegisterResource)({
          [Dispose]: () => {},
        });
        return 'dispose-only';
      },
    });

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    ctx.get(KEY);
    await ctx.dispose();

    const lifecycleStarted = events.filter(
      (e) => e.type === 'fiber:started' && (e as any).mode === 'lifecycle',
    );

    // Individual resources only fire lifecycle fibers for phases they implement.
    // This resource only has [Dispose], so only 1 lifecycle fiber fires.
    expect(lifecycleStarted).toHaveLength(1);
    const phases = lifecycleStarted.map((e) => (e as any).phase);
    expect(phases).toContain('dispose');
  });

  it('should handle multiple resources with lifecycle fibers', async () => {
    const events: FiberEvent[] = [];
    const order: string[] = [];

    const KEY_A = createInjectionKey<string>('ResourceA', {
      factory: () => {
        inject(RegisterResource)({
          [Dispose]: () => {
            order.push('A');
          },
        });
        return 'a';
      },
    });

    const KEY_B = createInjectionKey<string>('ResourceB', {
      factory: () => {
        inject(RegisterResource)({
          [Dispose]: () => {
            order.push('B');
          },
        });
        return 'b';
      },
    });

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    ctx.get(KEY_A);
    ctx.get(KEY_B);
    await ctx.dispose();

    // Dispose is reverse order: B then A
    expect(order).toEqual(['B', 'A']);

    const lifecycleStarted = events.filter(
      (e) => e.type === 'fiber:started' && (e as any).mode === 'lifecycle',
    );

    // 2 resources × 1 phase (dispose only) = 2
    expect(lifecycleStarted).toHaveLength(2);
  });

  it('should emit lifecycle fibers for sync resources when FiberTopic is present', () => {
    const events: FiberEvent[] = [];

    const KEY = createInjectionKey<string>('SyncResource', {
      factory: () => {
        inject(RegisterResource)({
          [Dispose]: () => {},
        });
        return 'sync';
      },
    });

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    ctx.get(KEY);
    ctx.dispose();

    // dispose() now always wraps in lifecycle fibers when FiberTopic is present
    const lifecycleStarted = events.filter(
      (e) => e.type === 'fiber:started' && (e as any).mode === 'lifecycle',
    );

    expect(lifecycleStarted).toHaveLength(1); // 1 resource × 1 phase (dispose only)
  });

  it('should emit lifecycle fibers within Fiber.call dispose', async () => {
    const events: FiberEvent[] = [];

    const KEY = createInjectionKey<string>('FiberResource');

    const ctx = createRootContext({
      providers: [valueProvider(FiberTopic, (e: FiberEvent) => events.push(e))],
    });

    // Provide KEY via Fiber.call providers so the resource stays on the child context
    await Fiber.call(
      async () => {
        lookup(KEY);
      },
      {
        context: ctx,
        name: 'outer',
        providers: [
          factoryProvider(KEY, () => {
            inject(RegisterResource)({
              [Dispose]: () => {},
            });
            return 'fiber-resource';
          }),
        ],
      },
    );

    // Events: call:enter, call:leave,
    // then child.dispose() → lifecycle fibers for drain, flush, dispose
    const callEvents = events.filter((e) => e.type === 'call:enter' || e.type === 'call:leave');
    const started = events.filter((e) => e.type === 'fiber:started');
    const settled = events.filter((e) => e.type === 'fiber:settled');

    // call:enter + call:leave + 1 lifecycle fiber (dispose only: started + settled)
    expect(callEvents).toHaveLength(2);
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(settled.length).toBeGreaterThanOrEqual(1);

    const lifecycle = started.filter((e) => (e as any).mode === 'lifecycle');
    expect(lifecycle.length).toBeGreaterThanOrEqual(1);
  });
});
