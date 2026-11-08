// Tests for platform / frame cancellation.
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fork, interrupted, result, signal, sleep } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { nextFrame } from '../../src/platform.js';
import { within } from '../support/util.js';
import { labelError as label, showError as show } from '../support/observations.js';

const roots: Context[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** A fake `requestAnimationFrame`/`cancelAnimationFrame` pair: frames fire only on `flush`. */
function installFrames(): { readonly requested: number[]; readonly cancelled: number[]; flush(time: number): void } {
  const callbacks = new Map<number, FrameRequestCallback>();
  const requested: number[] = [];
  const cancelled: number[] = [];
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    const id = next++;
    requested.push(id);
    callbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    cancelled.push(id);
    callbacks.delete(id);
  });
  return {
    requested,
    cancelled,
    flush: (time) => {
      const cbs = [...callbacks.values()];
      callbacks.clear();
      for (const cb of cbs) cb(time);
    },
  };
}

// --- nextFrame -----------------------------------------------------------------------------------------------------

describe('platform: nextFrame', () => {
  it("an observe body, which no halt returns, has its frame cancelled at the delivery and the wait rejected with the reason; one that waits after the delivery requests no frame", async () => {
    const frames = installFrames();
    const stop = new Error('stop');
    const root = app();
    const seen = await within(
      root.call(function* () {
        const waiting = fork(
          task(
            function* () {
              try {
                yield* nextFrame();
                return 'framed';
              } catch (e) {
                return `caught ${label(e, { stop })}`;
              }
            },
            { interrupt: 'observe' },
          ),
        );
        const late = fork(
          task(
            function* () {
              yield* interrupted();
              try {
                yield* nextFrame();
                return 'framed';
              } catch (e) {
                return `caught ${label(e, { stop })}`;
              }
            },
            { interrupt: 'observe' },
          ),
        );
        while (frames.requested.length === 0) yield* sleep(1);
        waiting.abort(stop);
        late.abort(stop);
        return { waiting: show(yield* result(waiting)), late: show(yield* result(late)) };
      }),
    );
    expect({ ...seen, requested: frames.requested, cancelled: frames.cancelled }).toEqual({
      waiting: 'success("caught stop")',
      late: 'success("caught stop")',
      requested: [1],
      cancelled: [1],
    });
  });

  it("without requestAnimationFrame, a halt clears the 16 ms timer; a frame that fires leaves no listener on the node's signal", async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const root = app();
    const seen = await within(
      root.call(function* () {
        const before = getEventListeners(signal(), 'abort').length;
        for (let i = 0; i < 3; i++) yield* nextFrame();
        const afterFrames = getEventListeners(signal(), 'abort').length - before;
        const f = fork(
          task(function* () {
            yield* nextFrame();
          }),
        );
        const frameTimers = (): unknown[] => setSpy.mock.calls.flatMap((c, i) => (c[1] === 16 ? [setSpy.mock.results[i]!.value] : []));
        const known = frameTimers().length;
        while (frameTimers().length === known) yield* sleep(1);
        const timer = frameTimers()[known];
        f.abort();
        yield* result(f);
        return { afterFrames, cleared: clearSpy.mock.calls.some((c) => c[0] === timer) };
      }),
    );
    expect(seen).toEqual({ afterFrames: 0, cleared: true });
  });
});
