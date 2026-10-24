// freeze-gc.test.ts — DESIGN.md §4.2, A2: a frozen
// body is garbage. Each case freezes a body whose frame holds a large array,
// then asserts a FinalizationRegistry hears the array collected. It fails if
// any node field, listener or source reaction retains the continuation.
// Skipped when the worker runs without --expose-gc (vitest.config.ts).
import { describe, expect, it } from 'vitest';
import './node.js';
import type { Context, Fiber } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import type { NodeImpl } from './node-impl.js';
import { deferred, gcUntil, hasGc, here, tick } from './test/util.js';

function spawn<T>(on: Context, body: () => Promise<T> | T, opts: Parameters<typeof task>[1] = {}): Fiber<T> {
  return on.fork(task(body, { onFailure: 'link', ...opts }));
}

/** A big object registered for finalization; `collected()` reports whether the registry heard it. */
function tracked(): { make: () => number[]; collected: () => boolean } {
  let collected = false;
  const registry = new FinalizationRegistry<string>(() => {
    collected = true;
  });
  return {
    make: () => {
      const big = new Array<number>(1e6).fill(1);
      registry.register(big, 'big');
      return big;
    },
    collected: () => collected,
  };
}

describe.skipIf(!hasGc)('a frozen body is collectable (A2)', () => {
  it('frozen on managed(p); p settles after the owner completed', async () => {
    const big = tracked();
    const p = deferred<number>();
    const app = createRootContext();
    let B!: NodeImpl;
    const done = app
      .call(async () => {
        B = here();
        const arr = big.make();
        await here().managed(p.promise);
        return arr.length;
      })
      .catch(() => 'aborted');
    await tick();
    B.abort();
    expect(await done).toBe('aborted');
    expect(B.state).toBe('complete');
    p.resolve(1);
    await gcUntil(big.collected);
    expect(big.collected()).toBe(true);
    await app.close();
  });

  it('frozen on never()', async () => {
    const big = tracked();
    const app = createRootContext();
    const f = spawn(app, async () => {
      const arr = big.make();
      await here().never();
      return arr.length;
    });
    await tick();
    f.abort();
    await app.result(f);
    await gcUntil(big.collected);
    expect(big.collected()).toBe(true);
    await app.close();
  });

  it('frozen on join(f) of a foreign fiber that is still running when gc runs (the cut empties the cell while the source is pending)', async () => {
    const big = tracked();
    const app = createRootContext();
    const foreign = spawn(app, async () => {
      await here().never();
    });
    const B = spawn(app, async () => {
      const arr = big.make();
      await here().join(foreign);
      return arr.length;
    });
    await tick();
    B.abort();
    await app.result(B);
    expect(foreign.state).toBe('running');
    await gcUntil(big.collected);
    expect(big.collected()).toBe(true);
    expect(foreign.state).toBe('running');
    foreign.abort();
    await app.close();
  });

  it('the frozen node itself is collectable while the foreign fiber it joined still runs', async () => {
    const app = createRootContext();
    const foreign = spawn(app, async () => {
      await here().never();
    });
    const ref = await (async () => {
      const B = spawn(app, async () => {
        await here().join(foreign);
      });
      await tick();
      B.abort();
      expect((await app.result(B)).status).toBe('aborted');
      return new WeakRef(impl(B));
    })();
    expect(foreign.state).toBe('running');
    await gcUntil(() => ref.deref() === undefined);
    expect(foreign.state).toBe('running');
    foreign.abort();
    await app.close();
  });

  it("a frozen body's async-context values are not retained by a pending managed(p) it awaited", async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const als = new AsyncLocalStorage<number[]>();
    const big = tracked();
    const slow = deferred<number>();
    const app = createRootContext();
    const B = als.run(big.make(), () =>
      spawn(app, async () => {
        await here().managed(slow.promise);
      }),
    );
    await tick();
    B.abort();
    await app.result(B);
    await gcUntil(big.collected);
    expect(big.collected()).toBe(true);
    slow.resolve(1);
    await app.close();
  });

  it('frozen on call(slow) whose child is still running when gc runs', async () => {
    const big = tracked();
    const app = createRootContext();
    const gate = deferred();
    let slow!: NodeImpl;
    const B = spawn(app, async () => {
      const arr = big.make();
      await here().call(
        task(
          async () => {
            slow = here();
            await gate.promise; // bare, observe: keeps running after the caller froze
          },
          { interrupt: 'observe' },
        ),
      );
      return arr.length;
    });
    await tick();
    B.abort();
    expect(impl(B).frozen).toBe(true);
    expect(slow.state).toBe('running');
    await gcUntil(big.collected);
    expect(big.collected()).toBe(true);
    expect(B.state).toBe('releasing'); // still waiting for its child: the parent waits, whatever it costs
    gate.resolve();
    await app.close();
  });

  it('frozen at then time: a managed await requested after delivery', async () => {
    const big = tracked();
    const app = createRootContext();
    const gate = deferred();
    const p = deferred<number>();
    const B = spawn(app, async () => {
      const arr = big.make();
      await gate.promise; // bare: delivered meanwhile
      await here().managed(p.promise); // requested after delivery: never settles
      return arr.length;
    });
    await tick();
    B.abort();
    gate.resolve();
    await app.result(B);
    expect(impl(B).frozen).toBe(true);
    await gcUntil(big.collected);
    expect(big.collected()).toBe(true);
    p.resolve(1);
    await app.close();
  });
});

function impl(f: Fiber<unknown>): NodeImpl {
  return f as unknown as NodeImpl;
}
