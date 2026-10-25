// storage.test.ts — the current-node slot of context-storage.ts (DESIGN.md §6; D41 decision 18): a synchronous
// module slot that `runInFrame` sets for a synchronous `fn` and restores, re-entrant and on throw. Nothing carries
// it across an `await`, a microtask or a timer: ramme registers no async context on any platform.
import { describe, it, expect } from 'vitest';
import { call, current, fork, lookup, own, signal } from './ambient.js';
import { createInjectionKey } from './context-key.js';
import {
  NO_NODE,
  currentCreation,
  currentFrame,
  currentNode,
  peekCurrentNode,
  runDetached,
  runInFrame,
} from './context-storage.js';
import type { Frame } from './context-storage.js';
import { defineDisposalSymbols } from './disposal-symbols.js';
import type { CreationState } from './inject.js';
import type { NodeImpl } from './node-impl.js';
import { NoCurrentNodeError } from './resource.js';
import { deferred, micro, tick } from './test/util.js';

function fakeNode(id: number): NodeImpl {
  return { id } as unknown as NodeImpl;
}

/** The part of CreationState that the storage reads: `node()` materialises, `nodeIfCreated` peeks, `ended` hides the frame (DESIGN.md §3.5). */
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

describe('the slot (DESIGN.md §6, D41 decision 18)', () => {
  it('outside any frame nothing is current, and the reads never throw: nothing needs registering', () => {
    expect(currentFrame()).toBeUndefined();
    expect(currentCreation()).toBeUndefined();
    expect(peekCurrentNode()).toBeUndefined();
    expect(currentNode()).toBeUndefined();
  });

  it('current() and the other free functions outside any frame throw NoCurrentNodeError naming the cause, not an import', () => {
    const ops: Record<string, () => unknown> = {
      current: () => current(),
      signal: () => signal(),
      lookup: () => lookup(createInjectionKey<string>('K')),
      own: () => own(() => {}),
      fork: () => fork(function* () {}),
      call: () => call(function* () {}),
    };
    for (const [op, fn] of Object.entries(ops)) {
      expect(fn, op).toThrow(NoCurrentNodeError);
      expect(fn, op).toThrow(/no async context/);
      expect(fn, op).not.toThrow(/import 'ramme\/node'/);
    }
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

  it('a frame does not survive an await, a microtask or a timer: the slot is synchronous', async () => {
    const frame: Frame = { node: fakeNode(3), creation: undefined };
    const fromTimer = deferred<Frame | undefined>();
    const fromMicrotask = deferred<Frame | undefined>();
    const seen: (Frame | undefined)[] = [];
    await runInFrame(frame, async () => {
      seen.push(currentFrame()); // before the first await: still the step's
      queueMicrotask(() => fromMicrotask.resolve(currentFrame()));
      setTimeout(() => fromTimer.resolve(currentFrame()), 1);
      await micro();
      seen.push(currentFrame());
      await tick();
      seen.push(currentFrame());
    });
    expect(seen).toEqual([frame, undefined, undefined]);
    expect(await fromMicrotask.promise).toBeUndefined();
    expect(await fromTimer.promise).toBeUndefined();
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
      // Continuations the factory schedules run after the slot is restored: none sees the creation
      queueMicrotask(() => inMicrotask.resolve(read()));
      void Promise.resolve().then(() => inReaction.resolve(read()));
      setTimeout(() => inTimer.resolve(read()), 0);
      cs.ended = true; // and the creation ends when the factory returns (DESIGN.md §3.5)
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

  it('runDetached and runInFrame(NO_NODE, fn) hide an outer frame inside fn and restore it after (DESIGN.md §6)', () => {
    expect(Object.isFrozen(NO_NODE)).toBe(true);
    const outer: Frame = { node: fakeNode(7), creation: undefined };
    const seen: unknown[] = [];
    runInFrame(outer, () => {
      runInFrame(NO_NODE, () => seen.push(currentFrame(), currentNode(), currentCreation()));
      seen.push(currentFrame() === outer);
      expect(runDetached(() => currentFrame())).toBeUndefined();
      seen.push(currentFrame() === outer);
    });
    expect(seen).toEqual([undefined, undefined, undefined, true, true]);
  });

  it('runDetached in a creation frame hides the creation (I16, DESIGN.md §6)', () => {
    const cs = fakeCreation(fakeNode(8));
    let seen: CreationState | undefined | 'unread' = 'unread';
    runInFrame({ node: undefined, creation: cs }, () => {
      runDetached(() => (seen = currentCreation()));
    });
    expect(seen).toBeUndefined();
  });
});

describe('the floor’s one guard (DESIGN.md §1.2; D41, decision 18)', () => {
  it('defines Symbol.dispose and Symbol.asyncDispose as the registered symbols where a runtime lacks them, and leaves present ones alone', () => {
    const bare: { dispose?: symbol; asyncDispose?: symbol } = {};
    defineDisposalSymbols(bare);
    const own = Symbol('own');
    const present: { dispose?: symbol; asyncDispose?: symbol } = { dispose: own, asyncDispose: own };
    defineDisposalSymbols(present);
    expect({ bare, present, runtime: [typeof Symbol.dispose, typeof Symbol.asyncDispose] }).toEqual({
      bare: { dispose: Symbol.for('Symbol.dispose'), asyncDispose: Symbol.for('Symbol.asyncDispose') },
      present: { dispose: own, asyncDispose: own },
      runtime: ['symbol', 'symbol'],
    });
  });
});
