// Tests for tasks / interruption.
import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { current, interrupted, never, own, signal, wait } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { FiberAbortedError, NoCurrentNodeError } from '../../src/resource.js';
import { deferred, tick, trace } from '../support/util.js';

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

describe('interruption seen from a body (DESIGN.md §4.1–§4.4)', () => {
  it('interrupted() resolves with the reason in an observe body, which then settles on its own', async () => {
    const root = createRootContext();
    const f = root.fork(task(function* () { return `saw ${String(yield* interrupted())}`; }, { interrupt: 'observe', ...link }));
    await tick();
    f.abort('why');
    await root.close();
    expect(f.outcome).toEqual({ status: 'success', value: 'saw why' });
  });

  it('never() in a freeze body is halted at delivery: no catch runs, its finally does, and its node releases after the body has unwound (D39, D41)', async () => {
    const t = trace();
    const root = createRootContext();
    const f = root.fork(
      task(function* () {
        own(() => t.push('released'));
        t.push('before');
        try {
          yield* never();
          t.push('resumed');
        } catch (e) {
          t.push(`caught ${(e as Error).name}`);
          throw e;
        } finally {
          t.push('finally');
        }
      }, link),
    );
    await tick();
    expect(t.log).toEqual(['before']);
    f.abort('x');
    expect(t.log).toEqual(['before']); // nothing inside abort(): the return is a queued job
    expect(f.state).toBe('running');
    expect(await root.result(f)).toEqual({ status: 'aborted', reason: 'x' });
    expect(t.log).toEqual(['before', 'finally', 'released']);
    await root.close();
  });

  it('wait(p, { abandon: true }) passes a value or a rejection through, returns a delivered body at once, and plain code between a halted wait(p) and the next yield* still runs (DESIGN.md §4.2)', async () => {
    const t = trace();
    const err = new Error('p failed');
    const root = createRootContext();
    await root.call(function* () {
      expect(yield* wait(Promise.resolve(3), { abandon: true })).toBe(3);
      expect(yield* wait(rejection(wait(Promise.reject(err), { abandon: true })))).toBe(err);
    });

    const late = deferred<string>();
    const inFlight = root.fork(
      task(function* () {
        try {
          t.push(`in flight got ${yield* wait(late.promise, { abandon: true })}`);
        } catch (e) {
          t.push(`in flight caught: ${(e as Error).name}`);
          throw e;
        } finally {
          t.push('in flight returned');
        }
      }, link),
    );
    const bare = deferred();
    const after = root.fork(
      task(function* () {
        yield* wait(bare.promise); // the halt lets p finish: resumed after delivery (row 3)
        t.push('plain code after delivery');
        own(() => t.push('owned after delivery released'));
        yield* wait(new Promise<void>(() => {}), { abandon: true }); // returned here at once
        t.push('resumed');
      }, link),
    );
    await tick();
    inFlight.abort();
    after.abort();
    expect((await root.result(inFlight)).status).toBe('aborted');
    late.resolve('late'); // too late: the wait was abandoned at the delivery
    bare.resolve();
    expect((await root.result(after)).status).toBe('aborted');
    expect(t.log).toEqual(['in flight returned', 'plain code after delivery', 'owned after delivery released']);
    await root.close();
  });

  it('timeoutMs delivers a TimeoutError to the fiber; a timed-out call rejects with FiberAbortedError at top level', async () => {
    const root = createRootContext();
    const f = root.fork(
      task(function* () {
        yield* never();
      }, { timeoutMs: 5, ...link }),
    );
    const o = await root.result(f);
    expect(o.status).toBe('aborted');
    expect(((o as { reason: unknown }).reason as DOMException).name).toBe('TimeoutError');
    expect((f.signal.reason as DOMException).name).toBe('TimeoutError');

    const bounded = await rejection(
      root.call(
        task(
          function* () {
            yield* never();
          },
          { timeoutMs: 5 },
        ),
      ),
    );
    expect(bounded).toBeInstanceOf(FiberAbortedError);
    expect(((bounded as FiberAbortedError).reason as DOMException).name).toBe('TimeoutError');
    await root.close();
  });

  it('a pre-aborted { signal } settles the fiber aborted at once, without running its body (DESIGN.md §4.6)', async () => {
    const ac = new AbortController();
    ac.abort('pre');
    let ran = false;
    const root = createRootContext();
    const f = root.fork(
      task(() => {
        ran = true;
      }, { signal: ac.signal, ...link }),
    );
    expect(f.state).toBe('complete');
    expect(f.outcome).toEqual({ status: 'aborted', reason: 'pre' });
    const called = await rejection(root.call(task(() => (ran = true), { signal: ac.signal })));
    expect(called).toBeInstanceOf(FiberAbortedError);
    await tick();
    expect(ran).toBe(false);
    await root.close();
  });

  it('top level: `await app.call(main)` rejects with FiberAbortedError when a platform callback aborts the app, and the `await using` block completes (DESIGN.md §4.2)', async () => {
    const t = trace();
    let caught: unknown;
    let appRef: Context | undefined;
    {
      await using app = createRootContext();
      appRef = app;
      app.own(() => t.push('app released'));
      const main = task(function* () {
        own(() => t.push('main released'));
        yield* never();
      });
      setTimeout(() => app.abort('SIGTERM'), 5); // a platform callback: no current node
      try {
        await app.call(main);
      } catch (e) {
        caught = e;
      }
      t.push('after call');
    }
    t.push('after using');
    expect(caught).toBeInstanceOf(FiberAbortedError);
    expect((caught as FiberAbortedError).reason).toBe('SIGTERM');
    expect(t.log[0]).toBe('main released');
    expect(t.log.indexOf('after call')).toBeGreaterThan(0);
    expect(t.log.indexOf('app released')).toBeGreaterThan(0);
    expect(t.log.at(-1)).toBe('after using');
    expect(appRef?.state).toBe('complete');
    expect(appRef?.outcome?.status).toBe('aborted');
  });

  it("Promise.all([call(a), call(b)]) runs each op through its then, as a child of the body's node: concurrently, nothing lent; a's failure rejects the all, consumed by a's then, and is caught; never an unhandled rejection (D13′; D41, decision 4)", async () => {
    const aErr = new Error('a failed');
    const root = createRootContext();
    let caught: unknown;
    let parents: unknown[] = [];
    const out = await root.call(function* () {
      const me = current();
      const ran: Context[] = [];
      try {
        yield* wait(
          Promise.all([
            task(function* () {
              ran.push(current());
              yield* wait(tick());
              throw aErr;
            })(),
            task(function* () {
              ran.push(current());
              return 'b';
            })(),
          ]),
        ); // the structured form is yield* all([a, b]): Promise.all is the plain-async-code one
      } catch (e) {
        caught = e;
      }
      parents = ran.map((n) => (n.parent === me ? 'the body' : 'another node'));
      yield* wait(tick(3));
      return 'done';
    });
    expect({ out, caught, parents }).toEqual({ out: 'done', caught: aErr, parents: ['the body', 'the body'] });
    await expect(root.close()).resolves.toBeUndefined(); // consumed by the then that delivered it
    // The setup hook fails this test if anything was an unhandled rejection (I10).
  });
});

describe('task signals', () => {
  it("signal() is the current node's AbortSignal", async () => {
    const ctx = createRootContext();
    await ctx.call(function* () {
      const s = signal();
      expect(s).toBeInstanceOf(AbortSignal);
      expect(s.aborted).toBe(false);
      expect(s).toBe(current().signal);
    });
    await ctx.close();
  });

  it('signal() fires when the node is aborted', async () => {
    const ctx = createRootContext();
    let signalAborted = false;
    const fiber = ctx.fork(
      task(function* () {
        signal().addEventListener('abort', () => {
          signalAborted = true;
        });
        yield* wait(sleep(1000, signal()), { abandon: true });
      }, link),
    );
    await tick();
    fiber.abort();
    await ctx.result(fiber);
    expect(signalAborted).toBe(true);
    await ctx.close();
  });

  it('signal() throws NoCurrentNodeError when no node is current', () => {
    expect(() => signal()).toThrow(NoCurrentNodeError);
  });

  it('works with a fetch-like abort pattern', async () => {
    const ctx = createRootContext();
    const fetchLike = async (s: AbortSignal): Promise<string> => {
      if (s.aborted) throw new Error('aborted');
      return 'data';
    };
    expect(await ctx.call(function* () { return yield* wait(fetchLike(signal())); })).toBe('data');
    await ctx.close();
  });
});

describe('external abort signals', () => {
  it('aborts the fiber when the signal fires', async () => {
    const ctx = createRootContext();
    const controller = new AbortController();
    let signalAborted = false;
    const fiber = ctx.fork(
      task(
        function* () {
          signal().addEventListener('abort', () => {
            signalAborted = true;
          });
          yield* wait(sleep(5000, signal()), { abandon: true });
        },
        { signal: controller.signal, ...link },
      ),
    );
    await tick();
    controller.abort('linked');
    const o = await ctx.result(fiber);
    expect(o).toEqual({ status: 'aborted', reason: 'linked' });
    expect(signalAborted).toBe(true);
    await ctx.close();
  });

  it('an already-aborted signal settles the fiber aborted before its body runs (DESIGN.md §4.6)', async () => {
    const ctx = createRootContext();
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const fiber = ctx.fork(
      task(
        function* () {
          ran = true;
        },
        { signal: controller.signal, ...link },
      ),
    );
    expect(fiber.outcome?.status).toBe('aborted');
    await ctx.close();
    expect(ran).toBe(false);
  });

  it('removes the listener when the fiber settles normally', async () => {
    const ctx = createRootContext();
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const fiber = ctx.fork(task(function* () { return 'done'; }, { signal: controller.signal, ...link }));
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    expect(await ctx.result(fiber)).toEqual({ status: 'success', value: 'done' });
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0][0]).toBe('abort');
    expect(removed.mock.calls[0][1]).toBe(added.mock.calls[0][1]); // the very listener that was added
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0); // nothing keeps the node reachable from the signal
    controller.abort(); // harmless now
    expect(fiber.signal.aborted).toBe(false);
    await ctx.close();
  });
});
