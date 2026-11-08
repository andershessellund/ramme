// Tests for lifecycle / body exit.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wait } from '../../src/ambient.js';
import type { Body, Context, Fiber } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import type { NodeImpl } from '../../src/node-impl.js';
import { OwnerInterrupt } from '../../src/resource.js';
import { deferred, here, impl, start, tick, trace } from '../support/util.js';

/** A fiber forked onto a bodiless node needs a destination other than 'join' (D14); 'link' surfaces failures. */
const linked = { onFailure: 'link' } as const;

/** Fork a body onto a bodiless node with the 'link' destination. */
function spawn<T>(on: Context, body: Body<T>, opts: Parameters<typeof task>[1] = {}): Fiber<T> {
  return on.fork(task(body, { ...linked, ...opts }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('unstarted fibers (DESIGN.md §4.6)', () => {
  it('abort() before the start microtask settles the fiber aborted; the body never runs', async () => {
    const app = createRootContext();
    let ran = false;
    const f = spawn(app, () => {
      ran = true;
    });
    f.abort('early');
    expect(f.outcome).toEqual({ status: 'aborted', reason: 'early' });
    await tick();
    expect(ran).toBe(false);
    await app.close();
  });

  it('a fiber forked under an already-delivered freeze parent is stepped to its first yield* of an op not yet started and halted there (D41 decision 9)', async () => {
    const t = trace();
    const app = createRootContext();
    const gate = deferred();
    let child!: NodeImpl;
    const P = spawn(app, function* () {
      yield* wait(gate.promise);
      child = impl(
        here().fork(function* () {
          t.push('child ran');
          here().own(t.at('child released'));
          yield* here().never();
          t.push('child resumed');
        }),
      );
      yield* here().join(child as unknown as Fiber<unknown>);
    });
    await tick();
    P.abort();
    gate.resolve();
    await app.close();
    expect(child.delivered).toBe(true);
    expect(t.log).toEqual(['child ran', 'child released']);
    expect(child.outcome?.status).toBe('aborted');
  });
});

// Keeps the OwnerInterrupt import honest: a parent's natural exit interrupts its subscribers with one (DESIGN.md §2.4).
describe('body exit (DESIGN.md §2.4)', () => {
  it("a parent's natural exit delivers an OwnerInterrupt to its subscribers and does not mark itself", async () => {
    const app = createRootContext();
    let sub!: Fiber<unknown>;
    let P!: NodeImpl;
    await app.call(function* () {
      P = here();
      sub = here().fork(function* () {
        yield* here().never();
      });
      yield* wait(tick());
    });
    expect(sub.signal.reason).toBeInstanceOf(OwnerInterrupt);
    expect((sub.signal.reason as OwnerInterrupt).owner).toBe(P);
    expect(P.delivered).toBe(false);
    expect(P.outcome?.status).toBe('success');
    await app.close();
  });

  it("childrenOnExit: 'await' waits for subscribers instead of interrupting them", async () => {
    const app = createRootContext();
    const gate = deferred();
    let sub!: Fiber<unknown>;
    const p = start(app.call(
      task(
        function* () {
          sub = here().fork(function* () {
            yield* wait(gate.promise);
            return 'natural';
          });
        },
        { childrenOnExit: 'await' },
      ),
    ));
    await tick();
    expect(sub.signal.aborted).toBe(false);
    gate.resolve();
    await p;
    expect(sub.outcome).toEqual({ status: 'success', value: 'natural' });
    await app.close();
  });
});
