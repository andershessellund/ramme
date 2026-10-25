// attempt-settle.test.ts — outcomes as values (DESIGN.md §4.5, §4.8, §4.12, D31). `attempt` is `call`
// with `result`'s resume step: lazy, its `yield*` starts the child synchronously (D22, D41), resumes with the
// child's outcome and consumes its failure on resume (D13); an interrupted `freeze` or `restore` caller is
// halted on it once the child has completed (D39, D41), never resumed, so `aborted` describes the child,
// except that a `restore` child also hears an `observe` caller's interruption, or an `observe` ancestor's that
// a `freeze` caller below it does not, and hands it back as `aborted`. `settle` is `all` resolving with
// outcomes instead of rejecting: as in `all`, every member is waited for and none is aborted on a sibling's
// account; its members' failures wait on the group's parent for the caller's resume step, so a halted caller
// consumes nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, attempt, call, fork, interrupted, lookup, never, own, settle, signal, wait } from './ambient.js';
import { createInjectionKey } from './context-key.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import type { NodeImpl } from './node-impl.js';
import { factoryProvider } from './provider-util.js';
import { CreationViolationError, NoCurrentNodeError } from './resource.js';
import type { SuppressedErrorLike } from './resource.js';
import { deferred, events, here, impl, start, tick, trace, within } from './test/util.js';

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
  it('success: lazy, as call; its yield* starts the body synchronously in a new child of the current node, and the outcome resolves', async () => {
    const t = trace();
    const root = createRootContext();
    await root.call(function* () {
      const me = here();
      let inner: NodeImpl | undefined;
      const p = attempt(function* (n: number) {
        inner = here();
        t.push('body start');
        yield* wait(tick());
        return n * 2;
      }, 21);
      t.push('after attempt');
      expect(inner).toBeUndefined(); // made, not run (D41, decision 2)
      const o = yield* p; // DESIGN.md §4.6: synchronous at the yield*, as call
      expect(inner!.parent).toBe(me);
      expect(inner!.kind).toBe('fiber');
      expect(o).toEqual({ status: 'success', value: 42 });
      expect(inner!.state).toBe('complete');
    });
    expect(t.log).toEqual(['after attempt', 'body start']);
    await root.close();
  });

  it("failure: the error is delivered as a value, never thrown, and consumed: the caller and the root complete with nothing unconsumed; the task's own destination does not apply", async () => {
    const err = new Error('boom');
    const handler = vi.fn();
    const root = createRootContext();
    let caller!: NodeImpl;
    let child!: NodeImpl;
    const out = await root.call(function* () {
      caller = here();
      const plain = yield* attempt(function* () {
        child = here();
        throw err;
      });
      // The attempt is the child's reader, as for call: a declared 'link' or handler is not used (DESIGN.md §4.7).
      const linked = yield* attempt(task(function* () { return yield* wait(Promise.reject(err)); }, link));
      const handled = yield* attempt(task(function* () { return yield* wait(Promise.reject(err)); }, { onFailure: handler }));
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
      function* () {
        yield* never();
        return 'fresh';
      },
      { name: 'slow' },
    );
    const ac = new AbortController();
    const out = await within(
      root.call(function* () {
        const timed = yield* attempt(slow.with({ timeoutMs: 5 }));
        const signalled = attempt(slow.with({ signal: ac.signal }));
        ac.abort('hung up'); // before the op runs: its child is born with an aborted signal, settled unstarted (§4.6)
        const bySignal = yield* signalled;
        let child!: NodeImpl;
        fork(function* () {
          yield* wait(tick()); // the attempt below has started by now
          child.abort('explicit');
        });
        const byAbort = yield* attempt(function* () {
          child = here();
          yield* never();
        });
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

  it('an interrupted caller is halted on attempt as on call, never resumed with an outcome, once the child is aborted and released: no catch runs, its finally does (D39, D41)', async () => {
    const t = trace();
    const root = createRootContext();
    let child!: NodeImpl;
    let caught: unknown = 'no catch ran';
    const y = root.fork(
      task(function* () {
        try {
          const o = yield* attempt(function* () {
            child = here();
            own(t.at('child released'));
            yield* never();
          });
          t.push(`resumed with ${o.status}`); // never: 'aborted' would describe the caller's interruption (D31)
        } catch (e) {
          caught = e;
          throw e;
        } finally {
          t.push(`finally; child ${child.state}`);
        }
      }, link),
    );
    await tick();
    y.abort('caller interrupted');
    await within(root.result(y));
    expect(child.outcome).toEqual({ status: 'aborted', reason: 'caller interrupted' });
    expect(t.log).toEqual(['child released', 'finally; child complete']);
    expect(caught).toBe('no catch ran');
    expect(y.outcome?.status).toBe('aborted');
    await expect(root.close()).resolves.toBeUndefined();
  });

  it("a caller that is not interrupted can be handed an interruption that is not the child's own: a restore child hears every delivery on its subscription path, so under an observe caller or an observe ancestor its aborted carries that reason (DESIGN.md §4.3, §4.5)", async () => {
    const root = createRootContext();
    const hang = task(
      function* () {
        yield* never();
      },
      { interrupt: 'restore', name: 'hang' },
    );
    const observe = { interrupt: 'observe', onFailure: 'link' } as const;
    const seen: Record<string, { r: unknown; mine: boolean }> = {};
    // An observe caller is never rejected (§4.3): its own interruption reaches the restore child and comes back.
    const a = root.fork(
      task(function* () {
        const r = yield* attempt(hang);
        seen.attempt = { r, mine: signal().aborted };
      }, observe),
    );
    const b = root.fork(
      task(function* () {
        const r = yield* settle([hang, task(function* () { return 'done'; })]);
        seen.settle = { r, mine: signal().aborted };
      }, observe),
    );
    // A freeze caller under an observe ancestor is not delivered at all; its restore child is.
    const c = root.fork(
      task(function* () {
        yield* call(function* () {
          const r = yield* attempt(hang);
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
      function* (sku: string) {
        if (sku === 'bad') throw bug;
        yield* never();
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
    expect(await within(root.call(function* () { return yield* wait(prices('slow')); }))).toBe('cached');
    let caller!: NodeImpl;
    const p = start(root.call(function* () {
      caller = here();
      return yield* wait(prices('bad'));
    }));
    await expect(p).rejects.toBe(bug); // not also surfaced as an unconsumed child failure
    expect(caller.outcome).toEqual({ status: 'failure', error: bug });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('an interrupted caller consumes nothing: an observe child that fails after the caller was delivered surfaces from the caller, which is halted, never handed it as a value (D13, D39)', async () => {
    const root = createRootContext();
    const err = new Error('late observe failure');
    let P!: NodeImpl;
    let seen: unknown = 'nothing';
    const p = start(root.call(function* () {
      P = here();
      try {
        seen = yield* attempt(
          task(
            function* () {
              yield* interrupted();
              yield* wait(tick());
              throw err;
            },
            { interrupt: 'observe' },
          ),
        );
      } catch (e) {
        seen = e;
        throw e;
      }
    }));
    await tick();
    P.abort();
    await expect(p).rejects.toBe(err);
    expect(seen).toBe('nothing'); // halted: not { status: 'failure', error: err }, and no catch
    expect(P.outcome).toEqual({ status: 'failure', error: err });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('as for call, a stored ctx.attempt first awaited after its receiver completed runs then, on a completed node: NodeCompletedError, and nothing ran (D41, decision 2)', async () => {
    const seen: Record<string, unknown> = {};
    let ran = 0;
    for (const via of ['attempt', 'call'] as const) {
      const root = createRootContext();
      const ctx = root.child({ name: via });
      const body = function* () {
        ran++;
        return 'ran';
      };
      const p: PromiseLike<unknown> = via === 'attempt' ? ctx.attempt(body) : ctx.call(body); // stored, not awaited: lazy
      ctx.abort(); // nothing to release: ctx completes inside abort()
      try {
        seen[via] = await p;
      } catch (e) {
        seen[via] = e instanceof Error ? e.name : e;
      }
      await expect(root.close(), via).resolves.toBeUndefined();
    }
    expect({ seen, ran }).toEqual({ seen: { attempt: 'NodeCompletedError', call: 'NodeCompletedError' }, ran: 0 });
  });

  it('t.attempt(...args) is attempt(t, ...args); ctx.attempt runs in a child of ctx; at top level, through its then, in a child of the receiver', async () => {
    const root = createRootContext();
    const other = root.child({ name: 'other' });
    const parents: (NodeImpl | undefined)[] = [];
    let me!: NodeImpl;
    const probe = task(
      function* (n: number) {
        const c = here();
        parents.push(c.parent);
        return n * 2;
      },
      { name: 'probe' },
    );
    const out = await root.call(function* () {
      me = here();
      return [yield* probe.attempt(2), yield* attempt(probe, 3), yield* other.attempt(probe, 4)];
    });
    expect(out).toEqual([
      { status: 'success', value: 4 },
      { status: 'success', value: 6 },
      { status: 'success', value: 8 },
    ]);
    expect(parents[0]).toBe(me);
    expect(parents[1]).toBe(me);
    expect(parents[2]).toBe(impl(other));

    expect(await root.attempt(probe, 5)).toEqual({ status: 'success', value: 10 }); // no current node: the receiver's child
    expect(parents[3]).toBe(impl(root));
    expect(() => attempt(probe, 1)).toThrow(NoCurrentNodeError);
    expect(() => probe.attempt(1)).toThrow(NoCurrentNodeError);
    await other.close();
    await root.close();
  });

  it("join:enter and join:leave, with the outcome, on the waiting body's node; ctx.attempt emits them on the body, and a halted caller emits no join:leave (DESIGN.md §5)", async () => {
    const ev = events();
    const other = ev.root.child({ name: 'other' });
    let me!: NodeImpl;
    const children: NodeImpl[] = [];
    await ev.root.call(function* () {
      me = here();
      yield* attempt(function* () {
        children.push(here());
        throw new Error('x');
      });
      yield* other.attempt(function* () { return void children.push(here()); });
    });
    const kinds = ev.log.filter((e) => e.id === me.id && ['join:enter', 'join:leave'].includes(e.type)).map((e) => e.type);
    expect(kinds).toEqual(['join:enter', 'join:leave', 'join:enter', 'join:leave']);
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
      task(function* () {
        Y = here();
        yield* attempt(function* () {
          yield* never();
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
        task(function* () { return 'first'; }),
        task(function* () {
          throw err;
        }),
        task(function* () {
          slow[via] = here();
          yield* wait(tick(3)); // bare: still running well after its sibling failed
          t.push(`${via}: slow done, aborted: ${signal().aborted}`);
          return 'slow';
        }),
      ] as const;
    let rejected: unknown;
    const out = await within(
      root.call(function* () {
        try {
          yield* all(members('all'));
        } catch (e) {
          rejected = e;
        }
        return yield* settle(members('settle'));
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
        task(function* () {
          yield* wait(tick(3));
          done.push('a');
          return 'a';
        }),
        task(function* () {
          yield* wait(tick(2));
          done.push('b');
          throw errB;
        }),
        task(function* () {
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
      root.call(function* () {
        const r = yield* settle(
          [
            task(function* () {
              own(t.at('a released'));
              yield* never();
            }),
            task(function* () {
              group = here().parent!;
              own(t.at('b released'));
              yield* wait(new Promise<never>(() => {}), { abandon: true });
            }),
            task(function* () {
              throw err;
            }),
            task(
              function* () {
                const reason = yield* interrupted(); // an observe member hears the deadline and settles on its own (§4.3)
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
          task(function* () {
            ran = true;
            return 1;
          }),
          task(function* () { return 'two'; }),
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
    const out = await root.call(function* () {
      caller = here();
      return yield* settle([
        task(function* () {
          group = here().parent!;
          throw err1;
        }, link),
        task(function* () { return yield* wait(Promise.reject(err2)); }, { onFailure: handler }),
        task(function* () {
          yield* wait(tick());
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

  it("an interrupted caller is halted on settle as on all, never resumed, and a member's failure, never delivered, surfaces from the caller (D13, D39)", async () => {
    const t = trace();
    const err = new Error('early member failure');
    const root = createRootContext();
    let P!: NodeImpl;
    let group!: NodeImpl;
    let caught: unknown = 'no catch ran';
    const p = start(root.call(function* () {
      P = here();
      try {
        const r = yield* settle([
          task(function* () {
            group = here().parent!;
            throw err;
          }),
          task(function* () {
            yield* never();
          }),
        ]);
        t.push(`resumed with ${r.length} outcomes`);
      } catch (e) {
        caught = e;
        throw e;
      }
    }));
    await tick();
    expect(P.unconsumed.size).toBe(1); // the failed member's record waits on the group's parent for the resume step (D31)
    P.abort();
    await expect(p).rejects.toBe(err);
    expect(caught).toBe('no catch ran');
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
      task(function* () {
        Y = here();
        const r = yield* other.settle([
          task(
            function* () {
              group = here().parent!;
              yield* wait(gate.promise); // bare: the member outlives the caller's interruption
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
    expect(Y.state).toBe('running'); // call-shaped: Y is returned once the group has completed
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
      task(function* () { return lookup(K).v; }),
      task(function* () {
        if (fail) throw memberErr;
        return 2;
      }),
    ];
    const caught: Record<string, unknown> = {};
    let caller!: NodeImpl;
    const out = await root.call(function* () {
      caller = here();
      for (const [name, run] of [
        ['settle', () => settle(members(true), opts)],
        ['all', () => all(members(true), opts)],
        ['settle, no member failed', () => settle(members(false), opts)],
      ] as const)
        try {
          yield* run();
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

  it("a member whose fork throws (an invalid option on its task) is a failure of the group's own: the group's body fails in its first step, before any member it forked has started (forks start in a microtask, I20), so those are aborted unstarted, and settle and all reject with the fork's error alone; a caller that catches it recovers, nothing left unconsumed", async () => {
    const root = createRootContext();
    let ran = 0;
    // Member 1's timeoutMs is refused when its node is built, in the group's body (DESIGN.md §2.1).
    const members = () => [
      task(() => {
        ran++;
        throw new Error('member failed');
      }),
      task(function* () { return 1; }, { timeoutMs: -1 }),
      task(function* () { return 2; }),
    ];
    const caught: Record<string, unknown> = {};
    let caller!: NodeImpl;
    const out = await root.call(function* () {
      caller = here();
      for (const [name, run] of [
        ['settle', () => settle(members())],
        ['all', () => all(members())],
      ] as const)
        try {
          yield* run();
        } catch (e) {
          caught[name] = e;
        }
      return 'recovered';
    });
    expect(out).toBe('recovered');
    expect(caller.outcome?.status).toBe('success');
    expect(caller.unconsumed.size).toBe(0);
    expect({ ran, settle: (caught.settle as Error)?.name, all: (caught.all as Error)?.name }).toEqual({
      ran: 0,
      settle: 'TypeError',
      all: 'TypeError',
    });
    expect((caught.settle as Error).message).toMatch(/^timeoutMs must be/);
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('a group delivered at birth whose member fork throws reports every member as aborted with the group\'s reason: the one it forked never started, the one whose fork threw never existed; nothing surfaces from the receiver', async () => {
    const root = createRootContext();
    const gate = deferred();
    let F!: NodeImpl;
    let ran = 0;
    const f = root.fork(
      task(function* () {
        F = here();
        yield* wait(gate.promise); // the halt lets p finish: F stays running after its delivery
      }, link),
    );
    await tick();
    f.abort('stop'); // F is delivered but running, so a freeze group forked on it is delivered at birth (DESIGN.md §4.3)
    expect(F.state).toBe('running');
    const out = await within(
      F.settle([
        task(
          function* () {
            ran++; // an observe member is not delivered at birth, but it never starts: the group fails first
            yield* wait(tick());
          },
          { interrupt: 'observe' },
        ),
        task(function* () { return 1; }, { timeoutMs: -1 }),
      ]),
    ); // top level: nothing halts the waiter, the resume step runs
    expect({ out, ran }).toEqual({
      out: [
        { status: 'aborted', reason: 'stop' },
        { status: 'aborted', reason: 'stop' },
      ],
      ran: 0,
    });
    gate.resolve();
    await within(F.completion);
    expect(F.outcome).toEqual({ status: 'aborted', reason: 'stop' });
    await expect(root.close()).resolves.toBeUndefined();
  });

  it('ctx.settle runs the group in a child of ctx; opts name the group; no current node is NoCurrentNodeError', async () => {
    const root = createRootContext();
    const other = root.child({ name: 'other' });
    let group: NodeImpl | undefined;
    const out = await root.call(function* () {
      return yield* other.settle(
        [
          task(function* () {
            group = here().parent;
            return 'member';
          }),
        ],
        { name: 'mine' },
      );
    });
    expect(out).toEqual([{ status: 'success', value: 'member' }]);
    expect(group?.parent).toBe(impl(other));
    expect(group?.name).toBe('mine');
    expect(() => settle([])).toThrow(NoCurrentNodeError);
    await other.close();
    await root.close();
  });
});

// ---------------------------------------------------------------------------
describe('attempt and settle are body-shaped (DESIGN.md §3.5, §4.7)', () => {
  it('a factory gets CreationViolationError before any node is touched', () => {
    const root = createRootContext();
    let errors: Record<string, unknown> = {};
    const V = createInjectionKey<object>('V', {
      factory: () => {
        errors = attemptEach({
          attempt: () => attempt(function* () { return 1; }),
          'task.attempt': () => task(function* () { return 1; }).attempt(),
          'root.attempt': () => root.attempt(function* () { return 1; }),
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

  it("a failure handler may attempt and settle through its parent while the parent's body waits on a call: nothing is lent (D41), and a generator handler runs them", async () => {
    const root = createRootContext();
    const got: unknown[] = [];
    const done = start(
      root.call(function* () {
        fork(
          task(
            function* () {
              throw new Error('child failed');
            },
            {
              onFailure: function* () {
                got.push(yield* attempt(function* () {
                  return 1;
                }));
                got.push(yield* settle([]));
              },
            },
          ),
        );
        yield* call(function* () {
          yield* wait(tick(3));
        });
        return 'Y ok';
      }),
    );
    await expect(done).resolves.toBe('Y ok');
    expect(got).toEqual([{ status: 'success', value: 1 }, []]);
    await expect(root.close()).resolves.toBeUndefined();
  });
});
