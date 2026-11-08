// Tests for platform / animation frames.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fork, result, sleep } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { nextFrame } from '../../src/platform.js';
import { start, tick, trace, within } from '../support/util.js';
import { showError as show } from '../support/observations.js';

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

afterEach(async () => {
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
  vi.unstubAllGlobals();
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** A fake `requestAnimationFrame`/`cancelAnimationFrame` pair: frames fire only on `flush`. */
interface Frames {
  /** The ids handed out, in order (from 1). */
  readonly requested: number[];
  /** The ids `cancelAnimationFrame` was called with. */
  readonly cancelled: number[];
  /** Requested, neither fired nor cancelled. */
  pending(): number;
  /** Fire every pending frame with `time`. */
  flush(time: number): void;
}

function installFrames(): Frames {
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
    pending: () => callbacks.size,
    flush: (time) => {
      const cbs = [...callbacks.values()];
      callbacks.clear();
      for (const cb of cbs) cb(time);
    },
  };
}

// --- nextFrame ---------------------------------------------------------------------------------------------------

describe('nextFrame', () => {
  it("nextFrame is a wait over requestAnimationFrame, run when yielded, resolving with the frame's timestamp", async () => {
    const frames = installFrames();
    const root = app();
    const p = start(
      root.call(function* () {
        const op = nextFrame();
        const requestedWhenMade = frames.requested.length; // a work op is lazy (decision 2)
        const time = yield* op;
        return { requestedWhenMade, time };
      }),
    );
    await tick();
    const requested = [...frames.requested];
    frames.flush(1234.5);
    expect({ ...(await within(p)), requested, cancelled: frames.cancelled }).toEqual({
      requestedWhenMade: 0,
      time: 1234.5,
      requested: [1],
      cancelled: [],
    });
  });

  it('a halted body waiting on nextFrame is returned at once (its finally run, nothing after) and its frame is cancelled; no frame ever fires into it', async () => {
    const frames = installFrames();
    const t = trace();
    const stop = new Error('stop');
    const root = app();
    const outcome = await within(
      root.call(function* () {
        const f = fork(
          task(
            function* () {
              try {
                yield* nextFrame();
                t.push('after nextFrame');
              } finally {
                t.push('finally');
              }
            },
            { name: 'animating' },
          ),
        );
        while (frames.requested.length === 0) yield* sleep(1);
        f.abort(stop);
        return show(yield* result(f), { stop }); // at once: no frame fires before the flush below
      }),
    );
    const pendingAfterHalt = frames.pending();
    frames.flush(1);
    await tick();
    expect({ outcome, log: t.log, requested: frames.requested, cancelled: frames.cancelled, pendingAfterHalt }).toEqual({
      outcome: 'aborted(stop)',
      log: ['finally'],
      requested: [1],
      cancelled: [1],
      pendingAfterHalt: 0,
    });
  });

  it('where requestAnimationFrame is absent (Node), nextFrame falls back to a 16 ms timer and resolves with a number', async () => {
    const root = app();
    const absent = typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    const seen = await within(
      root.call(function* () {
        const t0 = performance.now();
        const time = yield* nextFrame();
        return { type: typeof time, waitedAFrame: performance.now() - t0 >= 10 };
      }),
    );
    expect({ absent, ...seen }).toEqual({ absent: 'undefined', type: 'number', waitedAFrame: true });
  });
});
