// Tests for lifecycle / releases.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import type { Body, Context, Fiber } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import type { NodeImpl } from '../../src/node-impl.js';
import { factoryProvider, valueProvider } from '../../src/provider-util.js';
import { AlreadyOwnedError, NodeCompletedError, NotOwnedError } from '../../src/resource.js';
import { deferred, events, here, impl, micro, start, tick, trace } from '../support/util.js';

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
describe('the release loop (DESIGN.md §2.4)', () => {
  it('explicit LIFO, then provided LIFO (I3, I5)', async () => {
    const t = trace();
    const K1 = createInjectionKey<object>('K1');
    const K2 = createInjectionKey<object>('K2');
    const app = createRootContext({
      providers: [
        factoryProvider(K1, () => here().own({}, () => t.push('K1'))),
        factoryProvider(K2, () => here().own({}, () => t.push('K2'))),
      ],
    });
    app.get(K1);
    app.own(t.at('a'));
    app.get(K2);
    app.own(t.at('b'));
    await app.close();
    expect(t.log).toEqual(['b', 'a', 'K2', 'K1']);
  });

  it('a release that own()s onto its owner has that entry released next (C2, DESIGN.md §2.4)', async () => {
    const t = trace();
    const app = createRootContext();
    app.own(t.at('first'));
    app.own(() => {
      t.push('second');
      app.own(t.at('pushed during release'));
    });
    await app.close();
    expect(t.log).toEqual(['second', 'pushed during release', 'first']);
  });

  it('an own() from the microtask drain after the last async release is released or refused, never left live on a complete node (I7)', async () => {
    const app = createRootContext();
    const N = impl(app.child());
    N.own(async () => {
      await micro();
    });
    const results: string[] = [];
    let chain = Promise.resolve();
    for (let i = 0; i < 16; i++)
      chain = chain.then(() => {
        try {
          N.own({ [Symbol.dispose]: () => void (results[i] = 'released') });
          results[i] = 'owned';
        } catch (e) {
          results[i] = e instanceof NodeCompletedError ? 'refused' : `other: ${String(e)}`;
        }
      });
    await N.close();
    await chain;
    await tick();
    expect(results.every((r) => r === 'released' || r === 'refused')).toBe(true);
    expect(results).toContain('released');
    expect(results).toContain('refused');
    expect(N.explicit.size).toBe(0);
    await app.close();
  });

  it("a release fiber's lookup that creates a value during the provided phase has it released before older provided values", async () => {
    const t = trace();
    const OLD = createInjectionKey<object>('OLD');
    const A = createInjectionKey<object>('A');
    const LATE = createInjectionKey<object>('LATE');
    const app = createRootContext({
      providers: [
        factoryProvider(OLD, () => here().own({}, () => t.push('OLD'))),
        factoryProvider(A, () =>
          here().own({}, () => {
            t.push('A');
            here().get(LATE); // the release fiber resolves through the releasing owner (DESIGN.md §3.3)
          }),
        ),
        factoryProvider(LATE, () => here().own({}, () => t.push('LATE'))),
      ],
    });
    app.get(OLD);
    app.get(A);
    await app.close();
    expect(t.log).toEqual(['A', 'LATE', 'OLD']);
  });

  it('a value created during the explicit phase is released at the top of the provided phase (I3)', async () => {
    const t = trace();
    const OLD = createInjectionKey<object>('OLD');
    const NEW = createInjectionKey<object>('NEW');
    const app = createRootContext({
      providers: [
        factoryProvider(OLD, () => here().own({}, () => t.push('OLD'))),
        factoryProvider(NEW, () => here().own({}, () => t.push('NEW'))),
      ],
    });
    app.get(OLD);
    app.own(() => {
      t.push('explicit');
      here().get(NEW);
    });
    await app.close();
    expect(t.log).toEqual(['explicit', 'NEW', 'OLD']);
  });

  for (const [label, kinds] of [
    ['sync-only', ['s', 's', 's']],
    ['async-only', ['a', 'a', 'a']],
    ['mixed', ['s', 'a', 's', 'a']],
  ] as const)
    it(`${label} stacks release in reverse order`, async () => {
      const t = trace();
      const app = createRootContext();
      kinds.forEach((k, i) =>
        app.own(
          k === 's'
            ? t.at(`${i}`)
            : async () => {
                await tick();
                t.push(`${i}`);
              },
        ),
      );
      await app.close();
      expect(t.log).toEqual(kinds.map((_, i) => `${i}`).reverse());
    });

  it('synchronous releases complete synchronously inside abort(), nested child() and unstarted fiber entries included (DESIGN.md §2.4)', async () => {
    const t = trace();
    const app = createRootContext();
    const outer = app.child();
    outer.own(t.at('outer-1'));
    const inner = outer.child();
    inner.own(t.at('inner-1'));
    const deeper = inner.child();
    deeper.own(t.at('deeper-1'));
    const unstarted = outer.fork(
      task(
        () => {
          t.push('never runs');
        },
        linked,
      ),
    );
    unstarted.own(t.at('fiber-own')); // attached on behalf of the fiber before it starts
    outer.own(t.at('outer-2'));
    outer.abort();
    expect(outer.state).toBe('complete'); // no microtask was needed
    expect(t.log).toEqual(['outer-2', 'fiber-own', 'deeper-1', 'inner-1', 'outer-1']);
    expect(unstarted.outcome?.status).toBe('aborted');
    await app.close();
  });

  it('releaseAll() racing release(x) on one entry runs that release once, and both settle (D16)', async () => {
    const app = createRootContext();
    let n = 0;
    const d = deferred();
    const x = app.own({}, async () => {
      n++;
      await d.promise;
    });
    const p1 = app.release(x);
    const p2 = app.releaseAll();
    d.resolve();
    await p1;
    await p2;
    expect(n).toBe(1);
    await app.close();
    expect(n).toBe(1);
  });

  it('an abort() arriving in the middle of a releaseAll() runs every release once (D16)', async () => {
    const ev = events();
    const N = ev.root.child({ name: 'N' });
    const counts = { a: 0, b: 0, c: 0 };
    const gates = { a: deferred(), b: deferred(), c: deferred() };
    for (const k of ['a', 'b', 'c'] as const)
      N.own({ name: k }, async () => {
        counts[k]++;
        await gates[k].promise;
      });
    const all = N.releaseAll(); // starts c
    await micro();
    N.abort(); // N's loop finds c releasing and waits on it
    gates.c.resolve();
    await tick();
    gates.b.resolve();
    await tick();
    gates.a.resolve();
    await all;
    await N.close();
    expect(counts).toEqual({ a: 1, b: 1, c: 1 });
    expect(ev.of('entry:released').filter((e) => e.id === N.id)).toHaveLength(3);
    await ev.root.close();
  });

  it('a release that synchronously calls owner.abort() does not throw, and the owner completes (e.done exists first, D16)', async () => {
    const app = createRootContext();
    const N = app.child();
    const x = N.own({}, () => N.abort());
    await N.release(x);
    await tick();
    expect(N.state).toBe('complete');
    await app.close();
  });
});

describe('release errors that String() cannot convert (DESIGN.md §2.4, I2, I10)', () => {
  const unprintable = (): unknown[] => [
    Object.create(null),
    {
      toString(): string {
        throw new Error('no toString');
      },
    },
  ];
  for (const asyncRelease of [false, true])
    for (const withReceiver of [false, true])
      it(`${asyncRelease ? 'an async' : 'a sync'} release that throws one still finishes ${withReceiver ? 'with' : 'without'} a receiver: abort() returns, the owner completes, the error surfaces`, async () => {
        for (const bad of unprintable()) {
          const ev = withReceiver ? events() : undefined;
          const app = ev?.root ?? createRootContext();
          const c = app.child({ name: 'c' });
          c.own(
            asyncRelease
              ? async () => {
                  await null;
                  throw bad;
                }
              : () => {
                  throw bad;
                },
          );
          expect(() => c.abort()).not.toThrow();
          await tick();
          expect(c.state).toBe('complete');
          expect(c.outcome?.status).toBe('defect');
          expect((c.outcome as { error: unknown }).error).toBe(bad);
          if (ev !== undefined) expect(ev.of('entry:released').find((e) => e.id === c.id)?.error).toBe('[object Object]');
          await expect(app.close()).rejects.toBe(bad);
        }
      });
});

// ---------------------------------------------------------------------------
describe('release fibers (DESIGN.md §2.4, I14)', () => {
  it('own(x, release), own({[Symbol.asyncDispose]}) and own(fn) run in a release fiber: current, child of the owner, its own deadline, owner.outcome readable', async () => {
    const OWNER = createInjectionKey<string>('OWNER');
    const app = createRootContext();
    const N = app.child({ providers: [valueProvider(OWNER, 'N')], releaseTimeoutMs: 15 });
    const seen: Record<string, unknown>[] = [];
    const probe = async (label: string): Promise<void> => {
      const rf = here();
      const row: Record<string, unknown> = {
        label,
        kind: rf.kind,
        parentIsOwner: rf.parent === impl(N),
        lookup: rf.get(OWNER),
        ownerOutcome: N.outcome?.status,
        freshSignal: rf.signal !== N.signal && !rf.signal.aborted,
      };
      await new Promise((r) => setTimeout(r, 40));
      row.deadlineFired = rf.signal.aborted && (rf.signal.reason as DOMException).name === 'TimeoutError';
      seen.push(row);
    };
    N.own({}, () => probe('pair'));
    N.own({ [Symbol.asyncDispose]: () => probe('asyncDispose') });
    N.own(() => probe('defer'));
    await N.close();
    const expected = { kind: 'release', parentIsOwner: true, lookup: 'N', ownerOutcome: 'success', freshSignal: true, deadlineFired: true };
    expect(seen).toEqual([
      { label: 'defer', ...expected },
      { label: 'asyncDispose', ...expected },
      { label: 'pair', ...expected },
    ]);
    await app.close();
  });

  it("what a release owns is released when the release finishes, before the outer entry's entry:released", async () => {
    const ev = events();
    const N = ev.root.child({ name: 'N' });
    N.own(function outerRelease() {
      here().own(function innerRelease() {});
    });
    await N.close();
    const released = ev.of('entry:released').map((e) => e.entryName);
    expect(released.indexOf('innerRelease')).toBeGreaterThanOrEqual(0);
    expect(released.indexOf('innerRelease')).toBeLessThan(released.indexOf('outerRelease'));
    await ev.root.close();
  });
});

// ---------------------------------------------------------------------------
describe('ownership contracts (DESIGN.md §2.6)', () => {
  it('C1: own is synchronous — the entry exists before own returns; a value without a dispose protocol throws at the call', async () => {
    const app = createRootContext();
    const x = { [Symbol.dispose]() {} };
    expect(app.own(x)).toBe(x);
    expect(impl(app).explicit.find(x)).toBeDefined();
    expect(() => app.own({} as Disposable)).toThrow(TypeError);
    expect(() => app.own(42 as unknown as Disposable)).toThrow(TypeError);
    await app.close();
  });

  it('C2: own on a delivered but incomplete node succeeds; the entry is released at completion', async () => {
    const t = trace();
    const app = createRootContext();
    const gate = deferred();
    const f = spawn(app, function* () { return yield* wait(gate.promise); });
    await tick();
    f.abort();
    f.own(t.at('late'));
    expect(t.log).toEqual([]);
    gate.resolve();
    await app.close();
    expect(t.log).toEqual(['late']);
  });

  it('C3: own on a complete node throws NodeCompletedError', async () => {
    const app = createRootContext();
    const c = app.child();
    await c.close();
    expect(() => c.own(() => {})).toThrow(NodeCompletedError);
    await app.close();
  });

  it('C4: one release per entry, in a release fiber, after everything above it; provided entries after the whole explicit stack', async () => {
    const t = trace();
    const P = createInjectionKey<object>('P');
    const app = createRootContext({ providers: [factoryProvider(P, () => here().own({}, () => t.push(`P:${here().kind}`)))] });
    app.get(P);
    app.own(() => void t.push(`low:${here().kind}`));
    app.own(() => void t.push(`high:${here().kind}`));
    await app.close();
    await app.close();
    expect(t.log).toEqual(['high:release', 'low:release', 'P:release']);
  });

  it('C5: an owned fiber that fails while its owner is open aborts the owner; one that succeeds is removed', async () => {
    const app = createRootContext();
    const gate = deferred();
    let ownerNode!: NodeImpl;
    let ok!: NodeImpl;
    const p = start(app.call(function* () {
      ownerNode = here();
      ok = impl(here().own(here().fork(function* () { return 'ok'; })));
      yield* wait(tick());
      expect(ok.state).toBe('complete');
      expect(ownerNode.explicit.find(ok)).toBeUndefined(); // removed
      here().own(
        here().fork(function* () {
          yield* wait(gate.promise);
          throw new Error('owned failed');
        }),
      );
      yield* here().never();
    }));
    await tick();
    gate.resolve();
    await expect(p).rejects.toThrow('owned failed'); // aborted, then the failure surfaced (DESIGN.md §4.12, C5)
    expect(ownerNode.signal.aborted).toBe(true);
    await app.close();
  });

  it('C6: a release that throws does not stop the remaining releases', async () => {
    const t = trace();
    const app = createRootContext();
    app.own(t.at('first'));
    app.own(() => {
      throw new Error('bad release');
    });
    app.own(t.at('third'));
    await expect(app.close()).rejects.toThrow('bad release');
    expect(t.log).toEqual(['third', 'first']);
  });

  it('C7: release(x) runs the release now, exactly once; concurrent calls share one promise; release of a stranger throws NotOwnedError', async () => {
    const app = createRootContext();
    let n = 0;
    const d = deferred();
    const x = app.own({}, async () => {
      n++;
      await d.promise;
    });
    const p1 = app.release(x);
    expect(n).toBe(1); // now
    const p2 = app.release(x);
    d.resolve();
    await Promise.all([p1, p2]);
    expect(n).toBe(1);
    expect(() => app.release(x)).toThrow(NotOwnedError); // released: no longer owned
    expect(() => app.release({})).toThrow(NotOwnedError);
    for (const v of [null, undefined, 5, 'x']) expect(() => app.release(v as never), String(v)).toThrow(NotOwnedError);
    await app.close();
  });

  it('C8: a second release for one object throws AlreadyOwnedError; own(x) with one argument on an owned x is a no-op (D16)', async () => {
    const app = createRootContext();
    let n = 0;
    const x = { [Symbol.dispose]: () => void n++ };
    app.own(x);
    expect(app.own(x)).toBe(x);
    expect(impl(app).explicit.size).toBe(1);
    expect(() => app.own(x, () => {})).toThrow(AlreadyOwnedError);
    await app.close();
    expect(n).toBe(1);
  });
});
