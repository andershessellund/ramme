// The one test file that does not import './node.js' (D-57): it exercises the
// no-storage path first, then registers the adapter dynamically. `isolate:
// true` and `pool: 'forks'` keep this file's module state its own.
import { describe, it, expect, beforeAll } from 'vitest';
// ambient.ts registers no adapter: its imports are context-storage and resource (§1.1).
import { call, current, fork, lookup, own, signal } from './ambient.js';
import { createInjectionKey } from './context-key.js';
import {
  NO_NODE,
  currentCreation,
  currentFrame,
  currentNode,
  hasStorage,
  peekCurrentNode,
  runInFrame,
} from './context-storage.js';
import type { Frame } from './context-storage.js';
import type { CreationState } from './inject.js';
import type { NodeImpl } from './node-impl.js';
import { NoCurrentNodeError } from './resource.js';
import { deferred, micro, tick } from './test/util.js';

function fakeNode(id: number): NodeImpl {
  return { id } as unknown as NodeImpl;
}

/** The part of CreationState that the storage reads: `node()` materialises, `nodeIfCreated` peeks, `ended` hides the frame (D-107). */
function fakeCreation(valueNode: NodeImpl): CreationState & { made: number } {
  const cs = {
    made: 0,
    ended: false,
    nodeIfCreated: undefined as NodeImpl | undefined,
    node(): NodeImpl {
      if (cs.nodeIfCreated === undefined) {
        cs.made++;
        cs.nodeIfCreated = valueNode;
      }
      return cs.nodeIfCreated;
    },
  };
  return cs as unknown as CreationState & { made: number };
}

describe('without a context storage adapter', () => {
  it('reads report no frame and never throw', () => {
    expect(hasStorage()).toBe(false);
    expect(currentFrame()).toBeUndefined();
    expect(currentCreation()).toBeUndefined();
    expect(peekCurrentNode()).toBeUndefined();
    expect(currentNode()).toBeUndefined();
  });

  it("runInFrame throws NoCurrentNodeError naming 'ramme/node' and does not run fn", () => {
    let ran = false;
    const run = () =>
      runInFrame({ node: fakeNode(1), creation: undefined }, () => {
        ran = true;
      });
    expect(run).toThrow(NoCurrentNodeError);
    expect(run).toThrow(/import 'ramme\/node'/);
    expect(run).toThrow(/ramme\/async-context/);
    expect(ran).toBe(false);
    try {
      run();
    } catch (e) {
      expect((e as Error).name).toBe('NoCurrentNodeError');
    }
  });

  it("current() and the other free functions throw NoCurrentNodeError naming 'ramme/node' (D-60(c))", () => {
    const ops: Record<string, () => unknown> = {
      current: () => current(),
      signal: () => signal(),
      lookup: () => lookup(createInjectionKey<string>('K')),
      own: () => own(() => {}),
      fork: () => fork(async () => 1),
      call: () => call(async () => 1),
    };
    for (const [op, fn] of Object.entries(ops)) {
      expect(fn, op).toThrow(NoCurrentNodeError);
      expect(fn, op).toThrow(/import 'ramme\/node'/);
    }
  });
});

describe("with 'ramme/node' registered", () => {
  beforeAll(async () => {
    await import('./node.js');
  });

  it('the adapter registers storage; outside any frame nothing is current', () => {
    expect(hasStorage()).toBe(true);
    expect(currentFrame()).toBeUndefined();
    expect(currentNode()).toBeUndefined();
  });

  it('a body frame is current inside runInFrame and gone after it returns', () => {
    const node = fakeNode(2);
    const frame: Frame = { node, creation: undefined };
    const r = runInFrame(frame, () => {
      expect(currentFrame()).toBe(frame);
      expect(currentNode()).toBe(node);
      expect(peekCurrentNode()).toBe(node);
      expect(currentCreation()).toBeUndefined();
      return 42;
    });
    expect(r).toBe(42);
    expect(currentFrame()).toBeUndefined();
  });

  it('a frame survives await and setTimeout', async () => {
    const frame: Frame = { node: fakeNode(3), creation: undefined };
    const fromTimer = deferred<Frame | undefined>();
    await runInFrame(frame, async () => {
      await micro();
      expect(currentFrame()).toBe(frame);
      await tick();
      expect(currentFrame()).toBe(frame);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentFrame()).toBe(frame);
      setTimeout(() => fromTimer.resolve(currentFrame()), 1);
    });
    expect(await fromTimer.promise).toBe(frame);
    expect(currentFrame()).toBeUndefined();
  });

  it('nested runInFrame restores the outer frame on return and on throw', () => {
    const outer: Frame = { node: fakeNode(4), creation: undefined };
    const inner: Frame = { node: fakeNode(5), creation: undefined };
    runInFrame(outer, () => {
      runInFrame(inner, () => expect(currentFrame()).toBe(inner));
      expect(currentFrame()).toBe(outer);
      expect(() =>
        runInFrame(inner, () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(currentFrame()).toBe(outer);
    });
    expect(currentFrame()).toBeUndefined();
  });

  it('currentCreation() is visible only synchronously inside the creation frame; peek never materialises', async () => {
    const valueNode = fakeNode(6);
    const cs = fakeCreation(valueNode);
    const frame: Frame = { node: undefined, creation: cs };
    const inMicrotask = deferred<unknown[]>();
    const inReaction = deferred<unknown[]>();
    const inTimer = deferred<unknown[]>();
    const read = (): unknown[] => [currentCreation(), currentFrame(), currentNode(), peekCurrentNode()];
    runInFrame(frame, () => {
      expect(currentFrame()).toBe(frame);
      expect(currentCreation()).toBe(cs);
      expect(peekCurrentNode()).toBeUndefined();
      expect(cs.made).toBe(0);
      expect(currentNode()).toBe(valueNode);
      expect(cs.made).toBe(1);
      expect(peekCurrentNode()).toBe(valueNode);
      expect(currentNode()).toBe(valueNode);
      expect(cs.made).toBe(1);
      // Continuations the factory schedules carry the creation frame in the platform's async context ...
      queueMicrotask(() => inMicrotask.resolve(read()));
      void Promise.resolve().then(() => inReaction.resolve(read()));
      setTimeout(() => inTimer.resolve(read()), 0);
      cs.ended = true; // ... and the creation ends when the factory returns (D-107)
      expect(currentCreation()).toBeUndefined(); // from here on, even synchronously
    });
    expect(currentCreation()).toBeUndefined();
    expect(currentFrame()).toBeUndefined();
    const none = [undefined, undefined, undefined, undefined];
    expect(await inMicrotask.promise).toEqual(none);
    expect(await inReaction.promise).toEqual(none);
    expect(await inTimer.promise).toEqual(none);
    expect(cs.made).toBe(1);
  });

  it('runInFrame(NO_NODE, fn) hides an outer frame inside fn, and a microtask queued there carries no frame (D-46)', async () => {
    expect(Object.isFrozen(NO_NODE)).toBe(true);
    const outer: Frame = { node: fakeNode(7), creation: undefined };
    const inMicrotask = deferred<Frame | undefined>();
    const inReaction = deferred<Frame | undefined>();
    const inOuterMicrotask = deferred<Frame | undefined>();
    runInFrame(outer, () => {
      runInFrame(NO_NODE, () => {
        expect(currentFrame()).toBeUndefined();
        expect(currentNode()).toBeUndefined();
        expect(currentCreation()).toBeUndefined();
        queueMicrotask(() => inMicrotask.resolve(currentFrame()));
        void Promise.resolve().then(() => inReaction.resolve(currentFrame()));
      });
      expect(currentFrame()).toBe(outer);
      queueMicrotask(() => inOuterMicrotask.resolve(currentFrame()));
    });
    expect(await inMicrotask.promise).toBeUndefined();
    expect(await inReaction.promise).toBeUndefined();
    expect(await inOuterMicrotask.promise).toBe(outer);
  });

  it('a microtask queued under NO_NODE from a creation frame does not see the creation (I16, D-46)', async () => {
    const cs = fakeCreation(fakeNode(8));
    const seen = deferred<CreationState | undefined>();
    runInFrame({ node: undefined, creation: cs }, () => {
      runInFrame(NO_NODE, () => queueMicrotask(() => seen.resolve(currentCreation())));
    });
    expect(await seen.promise).toBeUndefined();
  });
});
