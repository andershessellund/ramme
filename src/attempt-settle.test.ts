// attempt-settle.test.ts — outcomes as values (DESIGN.md §4.5, §4.8, §4.12, D31). `attempt` is `call`
// with `result`'s resume step: it starts synchronously, lends the current node (D11, D22), resolves with
// the child's outcome and consumes its failure on resume (D13); an interrupted `freeze` or `restore` caller
// is rejected on it with `InterruptedError` once the child has completed (D39), so `aborted` describes the
// child, except that a `restore` child also hears an `observe` caller's interruption, or an `observe`
// ancestor's that a `freeze` caller below it does not, and hands it back as `aborted`. `settle` is `all`
// resolving with outcomes instead of rejecting: as in `all`, every member is waited for and none is aborted on
// a sibling's account; its members' failures wait on the group's parent for the caller's resume step, so an
// interrupted caller consumes nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import './node.js';
import { all, attempt, call, fork, interrupted, lookup, managed, never, own, settle, signal } from './ambient.js';
import { createInjectionKey } from './context-key.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import type { NodeImpl } from './node-impl.js';
import { factoryProvider, valueProvider } from './provider-util.js';
import { CreationViolationError, InterruptedError, NoCurrentNodeError, UnawaitedCallError } from './resource.js';
import type { SuppressedErrorLike } from './resource.js';
import { deferred, events, here, impl, tick, trace, within } from './test/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const link = { onFailure: 'link' } as const;

/** Each named operation run once; what it threw, or 'no error'. */
function attemptEach(ops: Record<string, () => unknown>): Record<string, unknown> {
  const caught: Record<string, unknown> = {};
  for (const [op, run] of Object.entries(ops))
    try {
      run();
      caught[op] = 'no error';
    } catch (e) {
      caught[op] = e;
    }
  return caught;
}

// ---------------------------------------------------------------------------
describe('attempt (DESIGN.md §4.5, D31)', () => {
  it('success: the body starts synchronously in a new child of the current node, which is lent until the child completes; the outcome resolves', async () => {
    const t = trace();
    const root = createRootContext();
    await root.call(async () => {
      const me = here();
      let inner: NodeImpl | undefined;
      const p = attempt(async (n: number) => {
        inner = here();
        t.push('body start');
        await tick();
        return n * 2;
      }, 21);
      t.push('after attempt');
      expect(inner).toBeDefined();
      expect(inner!.parent).toBe(me);
      expect(inner!.kind).toBe('fiber');
      expect(me.lentTo).toBe(inner); // DESIGN.md §4.9
      expect(await p).toEqual({ status: 'success', value: 42 });
      expect(me.lentTo).toBeUndefined();
      expect(inner!.state).toBe('complete');
    });
    expect(t.log).toEqual(['body start', 'after attempt']); // DESIGN.md §4.6: synchronous, as call
    await root.close();
  });

  it("failure: the error is delivered as a value, never thrown, and consumed: the caller and the root complete with nothing unconsumed; the task's own destination does not apply", async () => {
    const err = new Error('boom');
    const handler = vi.fn();
    const root = createRootContext();
    let caller!: NodeImpl;
    let child!: NodeImpl;
    const out = await root.call(async () => {
      caller = here();
      const plain = await attempt(async () => {
        child = here();
        throw err;
      });
      // The attempt is the child's reader, as for call: a declared 'link' or handler is not used (DESIGN.md §4.7).
      const linked = await attempt(task(async () => Promise.reject(err), link));
      const handled = await attempt(task(async () => Promise.reject(err), { onFailure: handler }));
      return [plain, linked, handled];
    });
    const failed = { status: 'failure', error: err };
    expect(out).toEqual([failed, failed, failed]);
    expect(handler).not.toHaveBeenCalled();
    expect(child.outcome).toEqual(failed);
    expect(child.failure?.consumed).toBe(true);
    expect(caller.outcome?.status).toBe('success');
    expect(caller.unconsumed.size).toBe(0);
    await expect(root.close()).resolves.toBeUndefined();
  });

  it("aborted describes the child's own abort (its timeoutMs, its signal, an explicit abort), and the caller goes on: a deadline with a fallback", async () => {
    const root = createRootContext();
    const slow = task(
      async () => {
        await never();
        return 'fresh';
      },
      { name: 'slow' },
    );
    const ac = new AbortController();
    const out = await within(
      root.call(async () => {
        const timed = await attempt(slow.with({ timeoutMs: 5 }));
        const signalled = attempt(slow.with({ signal: ac.signal }));
        ac.abort('hung up'); // a foreign signal: not a body-shaped use of the lent node
        const bySignal = await signalled;
        let child!: NodeImpl;
        const explicit = attempt(async () => {
          child = here();
          await never();
        });
        child.abort('explicit'); // abort is allowed while lent (DESIGN.md §4.9)
        const byAbort = await explicit;
        return { timed, bySignal, byAbort, value: timed.status === 'success' ? timed.value : 'cached' };
      }),
    );
    expect(out.timed.status).toBe('aborted');
    expect(((out.timed as { reason: unknown }).reason as DOMException).name).toBe('TimeoutError');
    expect(out.bySignal).toEqual({ status: 'aborted', reason: 'hung up' });
    expect(out.byAbort).toEqual({ status: 'aborted', reason: 'explicit' });
    expect(out.value).toBe('cached');
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('an interrupted caller is rejected on attempt as on call, with InterruptedError and never an outcome, once the child is aborted, released and has given the lending back (D39)', async () => {
    const t = trace();
    const root = createRootContext();
    let Y!: NodeImpl;
    let child!: NodeImpl;
    let caught: unknown;
    const y = root.fork(
      task(async () => {
        Y = here();
        try {
          const o = await attempt(async () => {
            child = here();
            own(t.at('child released'));
            await never();
          });
          t.push(`resumed with ${o.status}`); // never: 'aborted' would describe the caller's interruption (D31)
        } catch (e) {
          caught = e;
          t.push(`rejected; child ${child.state}, lent to ${String(Y.lentTo)}`);
          throw e;
        }
      }, link),
    );
    await tick();
    expect(Y.lentTo).toBe(child);
    y.abort('caller interrupted');
    await within(root.result(y));
    expect(child.outcome).toEqual({ status: 'aborted', reason: 'caller interrupted' });
    expect(child.lender).toBeUndefined();
    expect(t.log).toEqual(['child released', 'rejected; child complete, lent to undefined']);
    expect(caught).toBeInstanceOf(InterruptedError);
    expect((caught as InterruptedError).reason).toBe('caller interrupted');
    expect(y.outcome?.status).toBe('aborted');
    await expect(root.close()).resolves.toBeUndefined();
  });

  it("a caller that is not interrupted can be handed an interruption that is not the child's own: a restore child hears every delivery on its subscription path, so under an observe caller or an observe ancestor its aborted carries that reason (DESIGN.md §4.3, §4.5)", async () => {
    const root = createRootContext();
    const hang = task(
      async () => {
        await never();
      },
      { interrupt: 'restore', name: 'hang' },
    );
    const observe = { interrupt: 'observe', onFailure: 'link' } as const;
    const seen: Record<string, { r: unknown; mine: boolean }> = {};
    // An observe caller is never rejected (§4.3): its own interruption reaches the restore child and comes back.
    const a = root.fork(
      task(async () => {
        const r = await attempt(hang);
        seen.attempt = { r, mine: signal().aborted };
      }, observe),
    );
    const b = root.fork(
      task(async () => {
        const r = await settle([hang, task(async () => 'done')]);
        seen.settle = { r, mine: signal().aborted };
      }, observe),
    );
    // A freeze caller under an observe ancestor is not delivered at all; its restore child is.
    const c = root.fork(
      task(async () => {
        await call(async () => {
          const r = await attempt(hang);
          seen.ancestor = { r, mine: signal().aborted };
        });
      }, observe),
    );
    await tick();
    a.abort('a stops');
    b.abort('b stops');
    c.abort('c stops');
    await within(Promise.all([a, b, c].map((f) => (f as unknown as NodeImpl).completion)));
    expect(seen.attempt).toEqual({ r: { status: 'aborted', reason: 'a stops' }, mine: true }); // signal() tells it apart
    expect(seen.settle).toEqual({
      r: [
        { status: 'aborted', reason: 'b stops' },
        { status: 'success', value: 'done' },
      ],
      mine: true,
    });
    expect(seen.ancestor).toEqual({ r: { status: 'aborted', reason: 'c stops' }, mine: false });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('the deadline with a fallback rethrows a real failure: attempt consumed it, so the caller fails with that error once, and only aborted takes the fallback (DESIGN.md §4.5)', async () => {
    const bug = new TypeError('upstream bug');
    const fetchPrices = task(
      async (sku: string) => {
        if (sku === 'bad') throw bug;
        await never();
        return 'fresh';
      },
      { name: 'fetchPrices' },
    );
    // The documented idiom, in a plain function: it shares the caller's node.
    const prices = async (sku: string): Promise<string> => {
      const r = await attempt(fetchPrices.with({ timeoutMs: 5 }), sku);
      if (r.status === 'failure') throw r.error;
      return r.status === 'success' ? r.value : 'cached';
    };
    const root = createRootContext();
    expect(await within(root.call(() => prices('slow')))).toBe('cached');
    let caller!: NodeImpl;
    const p = root.call(async () => {
      caller = here();
      return prices('bad');
    });
    await expect(p).rejects.toBe(bug); // not also surfaced as an unconsumed child failure
    expect(caller.outcome).toEqual({ status: 'failure', error: bug });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('an interrupted caller consumes nothing: an observe child that fails after the caller was delivered surfaces from the caller, not as a value (D13, D39)', async () => {
    const root = createRootContext();
    const err = new Error('late observe failure');
    let P!: NodeImpl;
    let seen: unknown;
    const p = root.call(async () => {
      P = here();
      try {
        seen = await attempt(
          task(
            async () => {
              await interrupted();
              await tick();
              throw err;
            },
            { interrupt: 'observe' },
          ),
        );
      } catch (e) {
        seen = e;
        throw e;
      }
    });
    await tick();
    P.abort();
    await expect(p).rejects.toBe(err);
    expect(seen).toBeInstanceOf(InterruptedError); // not { status: 'failure', error: err }
    expect(P.outcome).toEqual({ status: 'failure', error: err });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('as for call, a stored ctx.attempt first awaited after its receiver completed is handed a failure the receiver has already reported (DESIGN.md §4.5, §4.12)', async () => {
    const err = new Error('boom');
    const seen: Record<string, unknown> = {};
    for (const via of ['attempt', 'call'] as const) {
      const root = createRootContext();
      const ctx = root.child({ name: via });
      const failing = async (): Promise<never> => {
        await tick();
        throw err;
      };
      const p: Promise<unknown> = via === 'attempt' ? ctx.attempt(failing) : ctx.call(failing); // stored, not awaited
      await tick(2); // the child has failed; its record waits on ctx
      ctx.abort(); // nothing left to release: ctx completes inside abort(), surfacing the record
      expect(impl(ctx).outcome, via).toEqual({ status: 'failure', error: err });
      try {
        seen[via] = await p;
      } catch (e) {
        seen[via] = { thrown: e };
      }
      await expect(root.close(), via).rejects.toBe(err); // reported by the receiver as well
    }
    expect(seen).toEqual({ attempt: { status: 'failure', error: err }, call: { thrown: err } });
  });

  it('lending: body-shaped use during an unawaited attempt throws UnawaitedCallError naming the child; a second attempt is pointed at settle(); own is allowed (D11)', async () => {
    const K = createInjectionKey<number>('K');
    const root = createRootContext({ providers: [valueProvider(K, 1)] });
    let caught: Record<string, unknown> = {};
    let child!: NodeImpl;
    let after: number | undefined;
    await root.call(async () => {
      const gate = deferred();
      const p = attempt(async () => {
        child = here();
        await gate.promise; // bare
        return 'a';
      });
      caught = attemptEach({
        lookup: () => lookup(K),
        fork: () => fork(async () => 1),
        call: () => call(async () => 1),
        attempt: () => attempt(async () => 1),
        settle: () => settle([]),
        own: () => own(() => {}),
      });
      gate.resolve();
      expect(await p).toEqual({ status: 'success', value: 'a' });
      after = lookup(K); // given back
    });
    for (const op of ['lookup', 'fork', 'call', 'attempt', 'settle']) {
      expect(caught[op], op).toBeInstanceOf(UnawaitedCallError);
      expect((caught[op] as UnawaitedCallError).child, op).toBe(child);
    }
    expect((caught.attempt as Error).message).toMatch(/^attempt\(\) on .*use settle\(\)/);
    expect((caught.settle as Error).message).toMatch(/^settle\(\) on .*one settle\(\)/);
    expect(caught.own).toBe('no error');
    expect(after).toBe(1);
    await root.close();
  });

  it('t.attempt(...args) is attempt(t, ...args); ctx.attempt runs in a child of ctx and lends the awaiting body, not ctx; top level lends nothing (D11)', async () => {
    const root = createRootContext();
    const other = root.child({ name: 'other' });
    const parents: (NodeImpl | undefined)[] = [];
    let lent: boolean[] = [];
    let me!: NodeImpl;
    const probe = task(
      async (n: number) => {
        const c = here();
        parents.push(c.parent);
        lent.push(me?.lentTo === c);
        return n * 2;
      },
      { name: 'probe' },
    );
    const out = await root.call(async () => {
      me = here();
      return [await probe.attempt(2), await attempt(probe, 3), await other.attempt(probe, 4)];
    });
    expect(out).toEqual([
      { status: 'success', value: 4 },
      { status: 'success', value: 6 },
      { status: 'success', value: 8 },
    ]);
    expect(parents[0]).toBe(me);
    expect(parents[1]).toBe(me);
    expect(parents[2]).toBe(impl(other));
    expect(lent).toEqual([true, true, true]);
    expect(impl(other).lentTo).toBeUndefined();

    lent = [];
    me = impl(root);
    expect(await root.attempt(probe, 5)).toEqual({ status: 'success', value: 10 }); // no current node: nothing lent
    expect(lent).toEqual([false]);
    expect(() => attempt(probe, 1)).toThrow(NoCurrentNodeError);
    expect(() => probe.attempt(1)).toThrow(NoCurrentNodeError);
    await other.close();
    await root.close();
  });

  it("join:enter and join:leave, with the outcome, on the awaiting body's node, after node:lent; ctx.attempt emits them on the body, and a rejected caller emits no join:leave (DESIGN.md §5)", async () => {
    const ev = events();
    const other = ev.root.child({ name: 'other' });
    let me!: NodeImpl;
    const children: NodeImpl[] = [];
    await ev.root.call(async () => {
      me = here();
      await attempt(async () => {
        children.push(here());
        throw new Error('x');
      });
      await other.attempt(async () => void children.push(here()));
    });
    const kinds = ev.log
      .filter((e) => e.id === me.id && ['node:lent', 'node:returned', 'join:enter', 'join:leave'].includes(e.type))
      .map((e) => e.type);
    expect(kinds).toEqual(['node:lent', 'join:enter', 'node:returned', 'join:leave', 'node:lent', 'join:enter', 'node:returned', 'join:leave']);
    expect(ev.of('join:enter').map((e) => [e.id, e.joinedId])).toEqual([
      [me.id, children[0].id],
      [me.id, children[1].id],
    ]);
    expect(ev.of('join:leave').map((e) => [e.id, e.joinedId, e.outcome])).toEqual([
      [me.id, children[0].id, 'failure'],
      [me.id, children[1].id, 'success'],
    ]);

    let Y!: NodeImpl;
    const y = ev.root.fork(
      task(async () => {
        Y = here();
        await attempt(async () => {
          await never();
        });
      }, link),
    );
    await tick();
    y.abort();
    await within(ev.root.result(y));
    expect(ev.of('join:enter').filter((e) => e.id === Y.id)).toHaveLength(1);
    expect(ev.of('join:leave').filter((e) => e.id === Y.id)).toHaveLength(0); // the resume step never ran
    await other.close();
    await ev.root.close();
  });
});

// ---------------------------------------------------------------------------
describe('settle (DESIGN.md §4.8, D31)', () => {
  it("as in all, a member's failure aborts no sibling: the slow sibling runs to completion under both; the difference is the report, all rejecting with an AggregateError and settle resolving with each outcome (D28)", async () => {
    const t = trace();
    const err = new Error('fast failure');
    const root = createRootContext();
    const slow: Record<string, NodeImpl> = {};
    const members = (via: string) =>
      [
        task(async () => 'first'),
        task(async () => {
          throw err;
        }),
        task(async () => {
          slow[via] = here();
          await tick(3); // bare: still running well after its sibling failed
          t.push(`${via}: slow done, aborted: ${signal().aborted}`);
          return 'slow';
        }),
      ] as const;
    let rejected: unknown;
    const out = await within(
      root.call(async () => {
        try {
          await all(members('all'));
        } catch (e) {
          rejected = e;
        }
        return settle(members('settle'));
      }),
    );
    expect(out).toEqual([
      { status: 'success', value: 'first' },
      { status: 'failure', error: err },
      { status: 'success', value: 'slow' },
    ]);
    expect(rejected).toBeInstanceOf(AggregateError);
    expect((rejected as AggregateError).errors).toEqual([err]);
    expect(t.log).toEqual(['all: slow done, aborted: false', 'settle: slow done, aborted: false']);
    for (const via of ['all', 'settle']) expect(slow[via].outcome, via).toEqual({ status: 'success', value: 'slow' });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('the tuple is in task order, whatever order the members complete in', async () => {
    const root = createRootContext();
    const done: string[] = [];
    const errB = new Error('b');
    const out = await root.call(() =>
      settle([
        task(async () => {
          await tick(3);
          done.push('a');
          return 'a';
        }),
        task(async () => {
          await tick(2);
          done.push('b');
          throw errB;
        }),
        task(async () => {
          done.push('c');
          return 'c';
        }),
      ]),
    );
    expect(done).toEqual(['c', 'b', 'a']);
    expect(out).toEqual([
      { status: 'success', value: 'a' },
      { status: 'failure', error: errB },
      { status: 'success', value: 'c' },
    ]);
    await root.close();
  });

  it('settle([]) resolves with [], as all([]) does, in a body and at top level', async () => {
    const root = createRootContext();
    expect(await root.call(() => settle([]))).toEqual([]);
    expect(await root.settle([])).toEqual([]);
    await expect(root.close()).resolves.toBeUndefined();
  });

  it("the group's own deadline is delivered to every member still running: a freeze member's outcome is aborted, an observe member's is what its body settles with, an earlier failure stays a value, and settle still resolves, since its caller is alive", async () => {
    const t = trace();
    const err = new Error('failed before the deadline');
    const root = createRootContext();
    let group!: NodeImpl;
    const out = await within(
      root.call(async () => {
        const r = await settle(
          [
            task(async () => {
              own(t.at('a released'));
              await never();
            }),
            task(async () => {
              group = here().parent!;
              own(t.at('b released'));
              await managed(new Promise<never>(() => {}));
            }),
            task(async () => {
              throw err;
            }),
            task(
              async () => {
                const reason = await interrupted(); // an observe member hears the deadline and settles on its own (§4.3)
                t.push('d shut down');
                return `clean after ${(reason as DOMException).name}`;
              },
              { interrupt: 'observe' },
            ),
          ],
          { timeoutMs: 5, name: 'deadline' },
        );
        t.push('caller resumed');
        return r;
      }),
    );
    expect(out.map((o) => o.status)).toEqual(['aborted', 'aborted', 'failure', 'success']);
    for (const o of out.slice(0, 2)) expect(((o as { reason: unknown }).reason as DOMException).name).toBe('TimeoutError');
    expect(out[2]).toEqual({ status: 'failure', error: err });
    expect(out[3]).toEqual({ status: 'success', value: 'clean after TimeoutError' });
    expect([...t.log].sort()).toEqual(['a released', 'b released', 'caller resumed', 'd shut down']);
    expect(t.log.at(-1)).toBe('caller resumed');
    expect(group.name).toBe('deadline');
    expect(group.outcome?.status).toBe('aborted'); // the members' failure is not the group's (D31)
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('a group whose signal is already aborted runs no member: every outcome is aborted with that reason (DESIGN.md §4.6)', async () => {
    const ac = new AbortController();
    ac.abort('gone');
    let ran = false;
    const root = createRootContext();
    const out = await root.call(() =>
      settle(
        [
          task(async () => {
            ran = true;
            return 1;
          }),
          task(async () => 'two'),
        ],
        { signal: ac.signal },
      ),
    );
    expect(out).toEqual([
      { status: 'aborted', reason: 'gone' },
      { status: 'aborted', reason: 'gone' },
    ]);
    await tick();
    expect(ran).toBe(false);
    await expect(root.close()).resolves.toBeUndefined();
  });

  it("every member failure is consumed by the resume step: none surfaces from the group, the caller or the root; members declared with 'link' or a handler run as 'join' members", async () => {
    const err1 = new Error('one');
    const err2 = new Error('two');
    const handler = vi.fn();
    const root = createRootContext();
    let caller!: NodeImpl;
    let group!: NodeImpl;
    const out = await root.call(async () => {
      caller = here();
      return settle([
        task(async () => {
          group = here().parent!;
          throw err1;
        }, link),
        task(async () => Promise.reject(err2), { onFailure: handler }),
        task(async () => {
          await tick();
          return 'survivor';
        }),
      ]);
    });
    expect(out).toEqual([
      { status: 'failure', error: err1 },
      { status: 'failure', error: err2 },
      { status: 'success', value: 'survivor' },
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(group.outcome?.status).toBe('success'); // the members' failures are not the group's (D31)
    expect(caller.outcome?.status).toBe('success');
    expect(caller.unconsumed.size).toBe(0);
    await expect(root.close()).resolves.toBeUndefined();
  });

  it("an interrupted caller is rejected on settle as on all, never resumed, and a member's failure, never delivered, surfaces from the caller (D13, D39)", async () => {
    const t = trace();
    const err = new Error('early member failure');
    const root = createRootContext();
    let P!: NodeImpl;
    let group!: NodeImpl;
    let caught: unknown;
    const p = root.call(async () => {
      P = here();
      try {
        const r = await settle([
          task(async () => {
            group = here().parent!;
            throw err;
          }),
          task(async () => {
            await never();
          }),
        ]);
        t.push(`resumed with ${r.length} outcomes`);
      } catch (e) {
        caught = e;
        throw e;
      }
    });
    await tick();
    expect(P.unconsumed.size).toBe(1); // the failed member's record waits on the group's parent for the resume step (D31)
    P.abort();
    await expect(p).rejects.toBe(err);
    expect(caught).toBeInstanceOf(InterruptedError);
    expect(P.outcome).toEqual({ status: 'failure', error: err });
    expect(group.outcome?.status).toBe('aborted');
    expect(t.log).toEqual([]);
    await expect(root.close()).resolves.toBeUndefined();
  });

  it("an interrupted caller's members' failures surface from the receiver, not lost: the call's mark delivers a group on another node, the caller waits for it, and a member failing then reaches the receiver's completion (I11, D31, D39)", async () => {
    const t = trace();
    const err = new Error('member failed after its caller was interrupted');
    const root = createRootContext();
    const other = root.child({ name: 'other' });
    const gate = deferred();
    let Y!: NodeImpl;
    let group!: NodeImpl;
    const y = root.fork(
      task(async () => {
        Y = here();
        const r = await other.settle([
          task(
            async () => {
              group = here().parent!;
              await gate.promise; // bare: the member outlives the caller's interruption
              throw err; // observe: delivered with its group, but its own result stands (DESIGN.md §4.3)
            },
            { interrupt: 'observe' },
          ),
        ]);
        t.push(`resumed with ${r.length} outcomes`);
      }, link),
    );
    await tick();
    expect(group.parent).toBe(impl(other)); // the group is other's child, not Y's: Y's delivery does not reach it
    y.abort('caller interrupted');
    expect(group.delivered).toBe(true); // the call's mark delivers it (D39, A.2)
    expect(group.state).toBe('running');
    await tick();
    expect(Y.state).toBe('running'); // lent to the group until it completes (D11)
    gate.resolve();
    await within(group.completion);
    expect(group.outcome).toEqual({ status: 'aborted', reason: 'caller interrupted' }); // the member's failure is not the group's (D31)
    await within(root.result(y));
    expect(Y.outcome).toEqual({ status: 'aborted', reason: 'caller interrupted' });
    await expect(other.close()).rejects.toBe(err); // surfaced once, from the receiver: nobody resumed to consume it
    expect(t.log).toEqual([]);
    await expect(root.close()).resolves.toBeUndefined();
  });

  it("a failure of the group's own (a value provided through opts whose release throws) rejects settle with every failure once, in all's shape: the members' are consumed with it, so a caller that catches it recovers", async () => {
    const K = createInjectionKey<{ v: number }>('K');
    const releaseErr = new Error('release failed');
    const memberErr = new Error('member failed');
    const root = createRootContext();
    const opts = {
      providers: [
        factoryProvider(K, () =>
          own({ v: 1 }, () => {
            throw releaseErr;
          }),
        ),
      ],
    };
    const members = (fail: boolean) => [
      task(async () => lookup(K).v),
      task(async () => {
        if (fail) throw memberErr;
        return 2;
      }),
    ];
    const caught: Record<string, unknown> = {};
    let caller!: NodeImpl;
    const out = await root.call(async () => {
      caller = here();
      for (const [name, run] of [
        ['settle', () => settle(members(true), opts)],
        ['all', () => all(members(true), opts)],
        ['settle, no member failed', () => settle(members(false), opts)],
      ] as const)
        try {
          await run();
        } catch (e) {
          caught[name] = e;
        }
      return 'recovered';
    });
    expect(out).toBe('recovered'); // nothing held on the caller surfaces past its catch (D31)
    expect(caller.unconsumed.size).toBe(0);
    for (const name of ['settle', 'all']) {
      const s = caught[name] as SuppressedErrorLike;
      expect(s.name, name).toBe('SuppressedError');
      expect(s.error, name).toBe(releaseErr);
      expect(s.suppressed, name).toBeInstanceOf(AggregateError);
      expect((s.suppressed as AggregateError).errors, name).toEqual([memberErr]);
    }
    expect(caught['settle, no member failed']).toBe(releaseErr);
    await expect(root.close()).resolves.toBeUndefined();
  });

  it("a member whose fork throws (an invalid option on its task) is a failure of the group's own: settle rejects with it over the failures of the members already forked, consumed with it, so a caller that catches it recovers, as with all", async () => {
    const memberErr = new Error('member failed');
    const root = createRootContext();
    // Member 0 fails synchronously in its start microtask, before the group's body exit is handled; member 1's
    // timeoutMs is refused when its node is built, in the group's body (DESIGN.md §2.1).
    const members = () => [
      task(() => {
        throw memberErr;
      }),
      task(async () => 1, { timeoutMs: -1 }),
      task(async () => 2),
    ];
    const caught: Record<string, unknown> = {};
    let caller!: NodeImpl;
    const out = await root.call(async () => {
      caller = here();
      for (const [name, run] of [
        ['settle', () => settle(members())],
        ['all', () => all(members())],
      ] as const)
        try {
          await run();
        } catch (e) {
          caught[name] = e;
        }
      return 'recovered';
    });
    expect(out).toBe('recovered'); // the forked member's failure does not surface past the caller's catch (D31)
    expect(caller.outcome?.status).toBe('success');
    expect(caller.unconsumed.size).toBe(0);
    const s = caught.settle as SuppressedErrorLike;
    expect(s.name).toBe('SuppressedError');
    expect(s.error).toBeInstanceOf(TypeError);
    expect((s.error as Error).message).toMatch(/^timeoutMs must be/);
    expect(s.suppressed).toBeInstanceOf(AggregateError);
    expect((s.suppressed as AggregateError).errors).toEqual([memberErr]);
    expect((s.suppressed as AggregateError).message).toBe('1 of 3 tasks failed');
    expect((caught.all as SuppressedErrorLike).name).toBe('SuppressedError'); // all hands over both errors too
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('a group delivered at birth whose member fork throws still reports the members it forked: a forked member that failed is a failure outcome, one never forked is aborted with the group\'s reason, and nothing surfaces from the receiver', async () => {
    const memberErr = new Error('observe member failed');
    const root = createRootContext();
    const gate = deferred();
    let F!: NodeImpl;
    const f = root.fork(
      task(async () => {
        F = here();
        await gate.promise; // bare: F stays running after its delivery
      }, link),
    );
    await tick();
    f.abort('stop'); // F is delivered but running, so a freeze group forked on it is delivered at birth (DESIGN.md §4.3)
    expect(F.state).toBe('running');
    const out = await within(
      F.settle([
        task(
          async () => {
            await tick(); // an observe member is not delivered at birth and runs on (DESIGN.md §4.3)
            throw memberErr;
          },
          { interrupt: 'observe' },
        ),
        task(async () => 1, { timeoutMs: -1 }),
      ]),
    ); // top level: nothing is interrupted, the resume step runs
    expect(out).toEqual([
      { status: 'failure', error: memberErr },
      { status: 'aborted', reason: 'stop' },
    ]);
    gate.resolve();
    await within(F.completion);
    expect(F.outcome).toEqual({ status: 'aborted', reason: 'stop' }); // the member's failure was delivered, not left on F
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('lending: body-shaped use during an unawaited settle throws UnawaitedCallError naming the group, and the error names settle (D11)', async () => {
    const root = createRootContext();
    let caught: Record<string, unknown> = {};
    let group: NodeImpl | undefined;
    await root.call(async () => {
      const me = here();
      const gate = deferred();
      const p = settle([
        task(async () => {
          await gate.promise; // bare
          return 1;
        }),
      ]);
      group = me.lentTo;
      caught = attemptEach({
        call: () => call(async () => 1),
        attempt: () => attempt(async () => 1),
        settle: () => settle([]),
        fork: () => fork(async () => 1),
      });
      gate.resolve();
      expect(await p).toEqual([{ status: 'success', value: 1 }]);
      expect(me.lentTo).toBeUndefined();
    });
    expect(group?.name).toBe('settle');
    expect(group?.state).toBe('complete');
    for (const op of ['call', 'attempt', 'settle', 'fork']) {
      expect(caught[op], op).toBeInstanceOf(UnawaitedCallError);
      expect((caught[op] as UnawaitedCallError).child, op).toBe(group);
    }
    expect((caught.settle as Error).message).toMatch(/^settle\(\) on .*one settle\(\)/);
    await root.close();
  });

  it('ctx.settle runs the group in a child of ctx and lends the awaiting body, not ctx; opts name the group; no current node is NoCurrentNodeError', async () => {
    const root = createRootContext();
    const other = root.child({ name: 'other' });
    let group: NodeImpl | undefined;
    const out = await root.call(async () => {
      const me = here();
      return other.settle(
        [
          task(async () => {
            group = here().parent;
            return me.lentTo === group;
          }),
        ],
        { name: 'mine' },
      );
    });
    expect(out).toEqual([{ status: 'success', value: true }]);
    expect(group?.parent).toBe(impl(other));
    expect(group?.name).toBe('mine');
    expect(impl(other).lentTo).toBeUndefined();
    expect(() => settle([])).toThrow(NoCurrentNodeError);
    await other.close();
    await root.close();
  });
});

// ---------------------------------------------------------------------------
describe('attempt and settle are body-shaped (DESIGN.md §3.5, §4.7, §4.9)', () => {
  it('a factory gets CreationViolationError before any node is touched', () => {
    const root = createRootContext();
    let errors: Record<string, unknown> = {};
    const V = createInjectionKey<object>('V', {
      factory: () => {
        errors = attemptEach({
          attempt: () => attempt(async () => 1),
          'task.attempt': () => task(async () => 1).attempt(),
          'root.attempt': () => root.attempt(async () => 1),
          settle: () => settle([]),
          'root.settle': () => root.settle([]),
        });
        return {};
      },
    });
    root.child().get(V);
    for (const op of ['attempt', 'task.attempt', 'root.attempt', 'settle', 'root.settle'])
      expect(errors[op], op).toBeInstanceOf(CreationViolationError);
  });

  it("a failure handler cannot attempt or settle through its parent while the parent's body is lent", async () => {
    const root = createRootContext();
    let caught: Record<string, unknown> = {};
    let lent: NodeImpl | undefined;
    const done = root.call(async () => {
      const Y = here();
      fork(
        task(
          async () => {
            throw new Error('child failed');
          },
          {
            onFailure: () => {
              lent = Y.lentTo;
              caught = attemptEach({ attempt: () => attempt(async () => 1), settle: () => settle([]) });
            },
          },
        ),
      );
      await call(async () => {
        await tick(3);
      });
      return 'Y ok';
    });
    await expect(done).resolves.toBe('Y ok');
    expect(lent).toBeDefined();
    for (const op of ['attempt', 'settle']) {
      expect(caught[op], op).toBeInstanceOf(UnawaitedCallError);
      expect((caught[op] as UnawaitedCallError).child, op).toBe(lent);
      expect((caught[op] as Error).message, op).toMatch(/failure handler/);
    }
    await expect(root.close()).resolves.toBeUndefined();
  });
});
