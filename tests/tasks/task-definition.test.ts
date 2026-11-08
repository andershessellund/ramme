// Tests for tasks / task definition.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { current, fork, join, signal, wait } from '../../src/ambient.js';
import type { Context, Op } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { NoCurrentNodeError } from '../../src/resource.js';
import { impl, tick, trace } from '../support/util.js';

describe('task() (DESIGN.md §4.5, I26)', () => {
  it('a task is a function whose call is a lazy op, never a bare promise (I26): outside any node it throws NoCurrentNodeError, and a task made by with() is one too', async () => {
    let ran = 0;
    const t = task(function* (n: number) {
      ran++;
      return n;
    });
    const w = t.with({ name: 'w' });
    const thrown = (f: () => unknown): string => {
      try {
        f();
        return 'returned';
      } catch (e) {
        return e instanceof Error ? e.constructor.name : String(e);
      }
    };
    const root = createRootContext();
    const op = root.run(() => w(1)); // made through the root, run by its then
    expect({
      kinds: [typeof t, typeof w],
      outside: [thrown(() => t(1)), thrown(() => w(1))],
      op: { promise: op instanceof Promise, then: typeof op.then, ranWhenMade: ran },
      value: await op,
      ran,
    }).toEqual({
      kinds: ['function', 'function'],
      outside: ['NoCurrentNodeError', 'NoCurrentNodeError'],
      op: { promise: false, then: 'function', ranWhenMade: 0 },
      value: 1,
      ran: 1,
    });
    await root.close();
  });

  it('task(body) refuses something that is not a function', () => {
    expect(() => task(42 as unknown as () => number)).toThrow(TypeError);
  });

  it("the name defaults to opts.name, else the body's name, else 'anonymous'; the fiber carries it", async () => {
    function* handle() {
      return current().name;
    }
    const named = function* () { return current().name; };
    expect(task(handle).name).toBe('handle');
    expect(task(named).name).toBe('named');
    expect(task(handle, { name: 'h' }).name).toBe('h');
    expect(task(function* () { return 1; }).name).toBe('anonymous');

    const root = createRootContext();
    expect(await root.call(task(handle))).toBe('handle');
    expect(await root.call(task(handle, { name: 'h' }))).toBe('h');
    expect(await root.call(task(handle).with({ name: 'w' }))).toBe('w');
    await root.close();
  });

  it("with() merges its options over the definition's and overrides the name; the definition is unchanged", async () => {
    const shape = (): { name: string | undefined; mode: string; childrenOnExit: string } => {
      const n = impl(current());
      return { name: n.name, mode: n.mode, childrenOnExit: n.childrenOnExit };
    };
    const base = task(shape, { name: 'base', interrupt: 'observe' });
    const over = base.with({ name: 'over', childrenOnExit: 'await' });
    const keep = base.with({ childrenOnExit: 'await' });
    expect(base.name).toBe('base');
    expect(over.name).toBe('over');
    expect(keep.name).toBe('base');

    const root = createRootContext();
    expect(await root.call(base)).toEqual({ name: 'base', mode: 'observe', childrenOnExit: 'interrupt' });
    expect(await root.call(over)).toEqual({ name: 'over', mode: 'observe', childrenOnExit: 'await' });
    expect(await root.call(keep)).toEqual({ name: 'base', mode: 'observe', childrenOnExit: 'await' });
    expect(await root.call(base)).toEqual({ name: 'base', mode: 'observe', childrenOnExit: 'interrupt' });
    await root.close();
  });

  it('a call fixes the arguments: the op runs the task under its name and options, awaited through a node or forked, and with() keeps them', async () => {
    const add = task(function* (a: number, b: number) { return a + b; }, { name: 'add', interrupt: 'observe' });
    expectTypeOf<ReturnType<typeof add>>().toEqualTypeOf<Op<number>>();
    expectTypeOf<Parameters<typeof add>>().toEqualTypeOf<[a: number, b: number]>();
    const root = createRootContext();
    expect(await root.run(() => add(1, 2))).toBe(3);
    expect(await root.call(add, 20, 22)).toBe(42);
    const modes = await root.call(function* () {
      const f = fork(add(1, 2));
      const g = fork(add.with({ name: 'b2' })(3, 4));
      return [f.name, impl(f).mode, yield* join(f), g.name, impl(g).mode, yield* join(g)];
    });
    expect(modes).toEqual(['add', 'observe', 3, 'b2', 'observe', 7]);
    await root.close();
  });

  it('fork(t(…)) and t(…) make children of the current node; no current node → NoCurrentNodeError', async () => {
    const parents: unknown[] = [];
    const t = task(function* (x: number) {
      parents.push(impl(current()).parent); // the body's own node's parent
      return x;
    });
    expect(() => fork(t(1))).toThrow(NoCurrentNodeError);
    expect(() => t(1)).toThrow(NoCurrentNodeError);
    const root = createRootContext();
    await root.call(function* () {
      const me = current();
      const f = fork(t(7));
      expect(impl(f).parent).toBe(me);
      expect(yield* join(f)).toBe(7);
      expect(yield* t(8)).toBe(8);
      expect(parents).toHaveLength(2);
      expect(parents[0], 'fork(t(…))').toBe(me);
      expect(parents[1], 't(…)').toBe(me);
    });
    await root.close();
  });
});

describe('start semantics (DESIGN.md §4.6, I20)', () => {
  it("fork never runs any part of the body in the forker's frame; the body sees its own node current from its first line", async () => {
    const t = trace();
    const root = createRootContext();
    await root.call(function* () {
      const me = current();
      let first: Context | undefined;
      let firstSignal: AbortSignal | undefined;
      const f = fork(function* () {
        first = current();
        firstSignal = signal();
        t.push('body');
        yield* wait(tick());
        return 1;
      });
      t.push('after fork');
      expect(first).toBeUndefined();
      expect(current()).toBe(me); // the forker's frame is untouched
      expect(impl(f).parent).toBe(me);
      expect(yield* join(f)).toBe(1);
      expect(first).toBe(f);
      expect(firstSignal).toBe(f.signal);
    });
    expect(t.log).toEqual(['after fork', 'body']);
    await root.close();
  });

  it('call is lazy: made, it runs nothing; its yield* starts the body synchronously, before the step returns, with the child current, and resumes with the value (D22)', async () => {
    const t = trace();
    const root = createRootContext();
    await root.call(function* () {
      const me = current();
      let inner: Context | undefined;
      const p = task(function* () {
        inner = current();
        t.push('body start');
        yield* wait(tick());
        return 42;
      })();
      t.push('after call');
      expect(inner).toBeUndefined(); // nothing ran yet (D41, decision 2)
      queueMicrotask(() => t.push('a microtask queued before the yield*'));
      const v = yield* p; // the child's first step runs inside this step (D22)
      expect(inner).not.toBe(me);
      expect(impl(inner!).parent).toBe(me);
      expect(v).toBe(42);
    });
    expect(t.log).toEqual(['after call', 'body start', 'a microtask queued before the yield*']);
    await root.close();
  });

  it('a body cannot tell whether it was forked or called', async () => {
    const shapes: Record<string, unknown>[] = [];
    const probe = task(
      function* () {
        const n = impl(current());
        shapes.push({
          kind: n.kind,
          name: n.name,
          parentKind: n.parent?.kind,
          subscribed: n.subscribed,
          stack: n.entryOnOwner?.stack.kind,
          state: n.state,
          mode: n.mode,
          aborted: signal().aborted,
          outcome: n.outcome,
        });
        yield* wait(tick());
        return 'done';
      },
      { name: 'probe' },
    );
    const root = createRootContext();
    await root.call(function* () {
      expect(yield* join(fork(probe()))).toBe('done');
      expect(yield* probe()).toBe('done');
    });
    expect(shapes).toHaveLength(2);
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[0]).toMatchObject({ kind: 'fiber', name: 'probe', parentKind: 'fiber', subscribed: true, stack: 'explicit' });
    await root.close();
  });
});
