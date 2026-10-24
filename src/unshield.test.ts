// unshield.test.ts — the hole in a shield (D39 settled note; DESIGN.md §4.2).
//
// `shield` and `unshield` are Effect's `uninterruptibleMask` and `restore`. `unshield(t, …args)` is `attempt` on the
// current node whose child is also linked to the signal of the shield's owner, the node the nearest enclosing
// `shield` runs on (its release fiber's parent: the current node for the free `shield`, `ctx` for `ctx.shield`). So
// the owner's interruption delivers the hole (a `freeze` or `restore` hole ends `aborted`, an `observe` one hears it
// through `signal()`), an interruption that already came skips it, the branch is a value, and the shield's body goes
// on either way. Outside any shield it throws a TypeError. A shield inside a shield has the outer one as its owner.
//
// Each test first compares one observation object, so that a failure shows the whole of the behaviour in its diff.
import { afterEach, describe, expect, it } from 'vitest';
import './node.js';
import {
  all,
  attempt,
  call,
  child,
  current,
  fork,
  interrupted,
  join,
  lookup,
  never,
  shield,
  signal,
  sleep,
  unshield,
} from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber, Outcome } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { valueProvider } from './provider-util.js';
import { FiberAbortedError, UnawaitedCallError } from './resource.js';
import { events, impl, tick, trace, within } from './test/util.js';
import type { Trace } from './test/util.js';

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

afterEach(async () => {
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** A handler for forks onto the bodiless root (D14). */
const quiet = { onFailure: () => {} } as const;

/** `f`'s outcome, read from top level; pushes `complete` to `t` when it arrives, a microtask or two after the node completed. */
function completion<T>(root: Context, f: Fiber<T>, t: Trace): Promise<Outcome<T>> {
  return root.result(f).then((o) => {
    t.push('complete');
    return o;
  });
}

/** The work in flight when the owner is interrupted: a `call` that never ends on its own. */
const slow = task(
  async () => {
    await never();
  },
  { name: 'slow' },
);

describe('unshield: a hole in the enclosing shield (D39, DESIGN.md §4.2)', () => {
  it('cut mid-hole: the owner’s interruption ends the hole, aborted with the owner’s reason; the shield body goes on to its end, and the owner completes after the shield', async () => {
    const ev = events();
    roots.push(ev.root);
    const t = trace();
    const reason = new Error('owner cut');
    let shieldNode: Context | undefined;
    let hole: Context | undefined;
    let r: Outcome<string> | undefined;
    const owner = ev.root.fork(
      task(
        async () => {
          const v = await shield(async () => {
            shieldNode = current();
            t.push('buffer flushed');
            r = await unshield(async () => {
              hole = current();
              t.push('peer notified');
              await sleep(10_000); // the owner's interruption rejects it, and clears its timer
              t.push('peer acknowledged');
              return 'ack';
            });
            t.push('offset written');
            return 'shielded';
          });
          t.push(`after the shield: ${v}`);
          await sleep(1); // the owner's own managed await: rejected, since it is interrupted
          t.push('unreachable');
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['buffer flushed', 'peer notified']);
    const done = completion(ev.root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    const ids = [impl(shieldNode!).id, impl(owner).id];
    expect({
      log: t.log,
      hole: r,
      holeOutcome: hole?.outcome,
      holeParentIsShield: hole?.parent === shieldNode,
      owner: o,
      completed: ev.of('node:complete').flatMap((e) => (ids.includes(e.id) ? [e.id === ids[0] ? 'shield' : 'owner'] : [])),
    }).toEqual({
      log: ['buffer flushed', 'peer notified', 'offset written', 'after the shield: shielded', 'complete'],
      hole: { status: 'aborted', reason },
      holeOutcome: { status: 'aborted', reason },
      holeParentIsShield: true,
      owner: { status: 'aborted', reason },
      completed: ['shield', 'owner'],
    });
  });

  // The D39 note supersedes the draft's birth rule here (a hole born delivered, run up to its first managed await):
  // a linked signal already aborted settles the child unstarted, `observe` or not (DESIGN.md §4.6).
  it('owner already interrupted: the hole is skipped at once, its body never runs whatever its interrupt mode, it lends nothing, and the outcome is aborted with the owner’s reason', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const ran: string[] = [];
    let r: Outcome<string> | undefined;
    let observeHole: Outcome<string> | undefined;
    let lentAfter: unknown = 'unread';
    const root = app();
    const owner = root.fork(
      task(
        async () => {
          try {
            await call(slow);
          } catch (e) {
            await shield(async () => {
              const p = unshield(async () => {
                ran.push('hole started');
                await sleep(10_000);
                ran.push('past its first await');
                return 'ack';
              });
              lentAfter = impl(current()).lentTo; // a hole settled at birth lends nothing
              r = await p;
              observeHole = await unshield(
                task(
                  async () => {
                    ran.push('observe hole started'); // an observe child is not born delivered, but it is not born at all
                    return 'ack';
                  },
                  { name: 'observe hole', interrupt: 'observe' },
                ),
              );
              t.push('shield goes on');
            });
            throw e;
          }
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({ ran, hole: r, observeHole, lentAfter, log: t.log, owner: o }).toEqual({
      ran: [],
      hole: { status: 'aborted', reason },
      observeHole: { status: 'aborted', reason },
      lentAfter: undefined,
      log: ['shield goes on', 'complete'],
      owner: { status: 'aborted', reason },
    });
  });

  it('a hole that succeeds resolves with its value, and one that fails with its failure as a value, consumed: nothing is left unconsumed on any node', async () => {
    const boom = new Error('peer refused');
    const notifyPeer = task(
      async () => {
        throw boom;
      },
      { name: 'notifyPeer' },
    );
    let ok: Outcome<number> | undefined;
    let bad: Outcome<never> | undefined;
    const unconsumed: Record<string, number> = {};
    const root = app();
    const v = await within(
      root.call(async () => {
        const body = current();
        return shield(async () => {
          const s = current();
          ok = await unshield(async (n: number) => n * 2, 21);
          bad = await current().unshield(notifyPeer); // the method form, on the shield's node
          unconsumed.shield = impl(s).unconsumed.size;
          unconsumed.body = impl(body).unconsumed.size;
          return 'done';
        });
      }),
    );
    await root.close(); // rejects with anything that surfaced unconsumed
    expect({ v, ok, bad, unconsumed, root: root.outcome }).toEqual({
      v: 'done',
      ok: { status: 'success', value: 42 },
      bad: { status: 'failure', error: boom },
      unconsumed: { shield: 0, body: 0 },
      root: { status: 'success', value: undefined },
    });
  });

  it('nesting: shield > unshield > shield > unshield; the inner hole links to the inner shield’s owner, a child of the outer hole, and aborting that node alone ends it', async () => {
    const t = trace();
    const reason = new Error('inner owner cut');
    const n: Record<'owner' | 'outerShield' | 'outerHole' | 'innerOwner' | 'innerShield' | 'innerHole', Context | undefined> = {
      owner: undefined,
      outerShield: undefined,
      outerHole: undefined,
      innerOwner: undefined,
      innerShield: undefined,
      innerHole: undefined,
    };
    let outer: Outcome<string> | undefined;
    let inner: Outcome<void> | undefined;
    let callError: unknown;
    const root = app();
    const owner = root.fork(
      task(
        async () => {
          n.owner = current();
          await shield(async () => {
            n.outerShield = current();
            outer = await unshield(async () => {
              n.outerHole = current();
              try {
                await call(async () => {
                  n.innerOwner = current();
                  await shield(async () => {
                    n.innerShield = current();
                    inner = await unshield(async () => {
                      n.innerHole = current();
                      t.push('inner hole waiting');
                      await never();
                    });
                    t.push('inner shield goes on');
                  });
                  t.push('inner owner after its shield');
                  await sleep(1); // rejected: the inner owner is interrupted
                });
              } catch (e) {
                callError = e;
              }
              return 'outer hole done';
            });
            t.push('outer shield goes on');
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['inner hole waiting']);
    const parents = {
      innerHole: n.innerHole?.parent === n.innerShield,
      innerShield: n.innerShield?.parent === n.innerOwner,
      innerOwner: n.innerOwner?.parent === n.outerHole,
      outerHole: n.outerHole?.parent === n.outerShield,
      outerShield: n.outerShield?.parent === n.owner,
    };
    const done = completion(root, owner, t);
    n.innerOwner!.abort(reason); // that node only: not the outer hole, not the owner
    const o = await within(done);
    expect({
      parents,
      log: t.log,
      inner,
      outer,
      callError: callError instanceof FiberAbortedError ? (callError as FiberAbortedError).reason : callError,
      delivered: [n.owner, n.outerShield, n.outerHole].map((x) => impl(x!).delivered),
      owner: o,
    }).toEqual({
      parents: { innerHole: true, innerShield: true, innerOwner: true, outerHole: true, outerShield: true },
      log: ['inner hole waiting', 'inner shield goes on', 'inner owner after its shield', 'outer shield goes on', 'complete'],
      inner: { status: 'aborted', reason },
      outer: { status: 'success', value: 'outer hole done' },
      callError: reason, // the outer hole's call of the aborted inner owner: another node's abort
      delivered: [false, false, false],
      owner: { status: 'success', value: undefined },
    });
  });

  it('from a call made inside the shield body, the hole links to the shield’s owner, not to the shield’s release fiber (current().parent) nor to the call’s node', async () => {
    const t = trace();
    const reason = new Error('owner cut');
    const n: Record<'owner' | 'shield' | 'call' | 'hole', Context | undefined> = {
      owner: undefined,
      shield: undefined,
      call: undefined,
      hole: undefined,
    };
    let linked: AbortSignal | undefined;
    let r: Outcome<string> | undefined;
    const root = app();
    const owner = root.fork(
      task(
        async () => {
          n.owner = current();
          await shield(async () => {
            n.shield = current();
            r = await call(async () => {
              n.call = current();
              const o = await unshield(async () => {
                n.hole = current();
                linked = impl(current()).linkedSignal;
                t.push('hole waiting');
                await sleep(10_000);
                return 'unreachable';
              });
              t.push('call goes on');
              return o;
            });
            t.push('shield goes on');
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['hole waiting']);
    const links = {
      holeParentIsCall: n.hole?.parent === n.call,
      callParentIsShield: n.call?.parent === n.shield,
      owner: linked === n.owner!.signal,
      shield: linked === n.shield!.signal,
      call: linked === n.call!.signal,
    };
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({ links, hole: r, log: t.log, owner: o }).toEqual({
      links: { holeParentIsCall: true, callParentIsShield: true, owner: true, shield: false, call: false },
      hole: { status: 'aborted', reason },
      log: ['hole waiting', 'call goes on', 'shield goes on', 'complete'],
      owner: { status: 'aborted', reason },
    });
  });

  it('outside any shield it throws a TypeError before anything runs: in a body, in an entry’s release fiber (a release fiber, but no shield), and after a shield has ended', async () => {
    let ran = 0;
    const thrown: string[] = [];
    const attemptHole = (where: string): void => {
      try {
        void unshield(async () => {
          ran++;
        });
        thrown.push(`${where}: nothing thrown`);
      } catch (e) {
        thrown.push(`${where}: ${e instanceof TypeError && /outside any shield/.test(e.message) ? 'TypeError' : String(e)}`);
      }
    };
    const root = app();
    await within(
      root.call(async () => {
        attemptHole('body');
        const scope = child();
        scope.own(() => attemptHole('entry release'));
        await scope.close();
        await shield(async () => {});
        attemptHole('after a shield');
      }),
    );
    expect({ thrown, ran }).toEqual({
      thrown: ['body: TypeError', 'entry release: TypeError', 'after a shield: TypeError'],
      ran: 0,
    });
  });

  it('lending: while an unawaited unshield is in flight, a second body-shaped operation throws UnawaitedCallError naming the hole; awaited, the lending ends', async () => {
    let hole: Context | undefined;
    let refused: unknown;
    let after: number | undefined;
    const root = app();
    await within(
      root.call(async () => {
        await shield(async () => {
          const p = unshield(async () => {
            hole = current();
            await sleep(5);
            return 'ack';
          });
          try {
            void call(async () => 1);
          } catch (e) {
            refused = e;
          }
          await p;
          after = await call(async () => 2); // returned: no longer lent
        });
      }),
    );
    expect({
      refused: refused instanceof UnawaitedCallError,
      child: (refused as UnawaitedCallError | undefined)?.child === hole,
      holeKind: hole === undefined ? undefined : impl(hole).kind,
      after,
    }).toEqual({ refused: true, child: true, holeKind: 'fiber', after: 2 });
  });

  it('the hole is a subscribed child of the current node: lookup through it resolves the owner’s providers', async () => {
    const Greeting = createInjectionKey<string>('greeting');
    let shieldNode: Context | undefined;
    let hole: Context | undefined;
    let seen: Outcome<string> | undefined;
    const root = app();
    await within(
      root.call(
        task(
          async () => {
            await shield(async () => {
              shieldNode = current();
              seen = await unshield(async () => {
                hole = current();
                return lookup(Greeting);
              });
            });
          },
          { name: 'owner', providers: [valueProvider(Greeting, 'from the owner')] },
        ),
      ),
    );
    expect({
      seen,
      parentIsShield: hole?.parent === shieldNode,
      subscribed: hole === undefined ? undefined : impl(hole).subscribed,
    }).toEqual({
      seen: { status: 'success', value: 'from the owner' },
      parentIsShield: true,
      subscribed: true,
    });
  });

  it('a hole keeps its task’s own signal: that signal ends it as well, with its own reason, and the owner is not interrupted', async () => {
    const peer = new AbortController();
    const reason = new Error('peer gone');
    let r: Outcome<string> | undefined;
    let ownerDelivered: boolean | undefined;
    const notifyPeer = task(
      async () => {
        await sleep(10_000);
        return 'ack';
      },
      { name: 'notifyPeer', signal: peer.signal },
    );
    const root = app();
    await within(
      root.call(async () => {
        const owner = current();
        await shield(async () => {
          const p = unshield(notifyPeer);
          setTimeout(() => peer.abort(reason), 1);
          r = await p;
          ownerDelivered = impl(owner).delivered;
        });
      }),
    );
    expect({ hole: r, ownerDelivered }).toEqual({ hole: { status: 'aborted', reason }, ownerDelivered: false });
  });

  it('from a fork inside the shield body too: the walk passes the fork, and the hole links to the shield’s owner', async () => {
    const t = trace();
    const reason = new Error('owner cut');
    let r: Outcome<string> | undefined;
    const root = app();
    const owner = root.fork(
      task(
        async () => {
          await shield(async () => {
            r = await join(
              fork(async () =>
                unshield(async () => {
                  t.push('hole waiting');
                  await sleep(10_000);
                  return 'unreachable';
                }),
              ),
            );
            t.push('shield goes on');
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['hole waiting']);
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({ hole: r, log: t.log, owner: o }).toEqual({
      hole: { status: 'aborted', reason },
      log: ['hole waiting', 'shield goes on', 'complete'],
      owner: { status: 'aborted', reason },
    });
  });

  it('an observe hole hears the owner’s interruption through signal() and interrupted() and runs on: its outcome is its own', async () => {
    const t = trace();
    const reason = new Error('owner cut');
    let heard: Record<string, boolean> | undefined;
    let r: Outcome<string> | undefined;
    const root = app();
    const owner = root.fork(
      task(
        async () => {
          await shield(async () => {
            r = await unshield(
              task(
                async () => {
                  t.push('hole waiting');
                  const why = await interrupted(); // the resolving form: an observe body is not rejected by its delivery
                  heard = { aborted: signal().aborted, signalReason: signal().reason === reason, why: why === reason };
                  await sleep(1); // not its interruption's to reject
                  return 'finished the step';
                },
                { name: 'notifyPeer', interrupt: 'observe' },
              ),
            );
            t.push('shield goes on');
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['hole waiting']);
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({ heard, hole: r, log: t.log, owner: o }).toEqual({
      heard: { aborted: true, signalReason: true, why: true },
      hole: { status: 'success', value: 'finished the step' },
      log: ['hole waiting', 'shield goes on', 'complete'],
      owner: { status: 'aborted', reason },
    });
  });

  it('the owner is the node the shield runs on: under ctx.shield called from another body, the hole follows ctx, not the body that called shield', async () => {
    const t = trace();
    const reqReason = new Error('request cut');
    const scopeReason = new Error('scope closed');
    let hole: Context | undefined;
    let r: Outcome<string> | undefined;
    const root = app();
    const scope = root.child({ name: 'scope' });
    const req = root.fork(
      task(
        async () => {
          await scope.shield(async () => {
            r = await unshield(async () => {
              hole = current();
              t.push('hole waiting');
              await sleep(10_000);
              return 'ran to end';
            });
            t.push('shield goes on');
          });
        },
        { name: 'req', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['hole waiting']);
    req.abort(reqReason); // the body that called shield: not the owner
    await tick(2);
    const afterReq = { log: [...t.log], holeDelivered: impl(hole!).delivered, hole: r };
    scope.abort(scopeReason); // the node the shield runs on: the owner
    const o = await within(root.result(req));
    expect({ afterReq, hole: r, log: t.log, req: o }).toEqual({
      afterReq: { log: ['hole waiting'], holeDelivered: false, hole: undefined },
      hole: { status: 'aborted', reason: scopeReason },
      log: ['hole waiting', 'shield goes on'],
      req: { status: 'aborted', reason: reqReason },
    });
  });

  it('a shield inside a shield has the outer shield as its owner: the task’s interruption neither skips nor cuts its hole (Effect’s restore under a nested mask)', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const n: Record<'outer' | 'inner', Context | undefined> = { outer: undefined, inner: undefined };
    let linked: AbortSignal | undefined;
    let r: Outcome<string> | undefined;
    /** A library helper, non-cancellable except for one step, used where its caller wrapped it in a shield of its own. */
    const helper = (): Promise<void> =>
      shield(async () => {
        n.inner = current();
        r = await unshield(async () => {
          linked = impl(current()).linkedSignal;
          t.push('peer notified');
          await sleep(5);
          t.push('peer acknowledged');
          return 'notified';
        });
      });
    const root = app();
    const owner = root.fork(
      task(
        async () => {
          try {
            await call(slow);
          } catch (e) {
            await shield(() => {
              n.outer = current();
              return helper();
            });
            throw e;
          }
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({
      innerOwnerIsOuterShield: n.inner?.parent === n.outer,
      linkedToOuterShield: linked === n.outer?.signal,
      log: t.log,
      hole: r,
      owner: o,
    }).toEqual({
      innerOwnerIsOuterShield: true,
      linkedToOuterShield: true,
      log: ['peer notified', 'peer acknowledged', 'complete'], // not skipped, though the owner was interrupted
      hole: { status: 'success', value: 'notified' },
      owner: { status: 'aborted', reason },
    });
  });

  it('inside a call made under a shield, a shield’s owner is the call’s node: the task’s interruption mid-hole does not cut its hole', async () => {
    const t = trace();
    const reason = new Error('owner cut');
    let callNode: Context | undefined;
    let linked: AbortSignal | undefined;
    let r: Outcome<string> | undefined;
    const root = app();
    const owner = root.fork(
      task(
        async () => {
          await shield(async () => {
            await call(async () => {
              callNode = current();
              await shield(async () => {
                r = await unshield(async () => {
                  linked = impl(current()).linkedSignal;
                  t.push('hole waiting');
                  await sleep(20);
                  t.push('hole done');
                  return 'ran to end';
                });
              });
            });
            t.push('shield goes on');
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(t.log).toEqual(['hole waiting']);
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({ linkedToCall: linked === callNode?.signal, log: t.log, hole: r, owner: o }).toEqual({
      linkedToCall: true,
      log: ['hole waiting', 'hole done', 'shield goes on', 'complete'],
      hole: { status: 'success', value: 'ran to end' },
      owner: { status: 'aborted', reason },
    });
  });

  it('a nested shield’s hole is bounded by its owner’s own signal: the outer shield’s release deadline, or the delivery of the call it runs on', async () => {
    const peer = async (): Promise<string> => {
      await sleep(10_000); // a peer that never answers
      return 'unreachable';
    };
    const timedOut = (o: Outcome<unknown> | undefined): string =>
      o?.status === 'aborted' ? `aborted: ${(o.reason as Error).name}` : JSON.stringify(o);
    let inShield: Outcome<string> | undefined;
    let inCall: Outcome<string> | undefined;
    let step: Outcome<string> | undefined;
    const root = app();
    const v = await within(
      root.call(
        task(
          async () => {
            await shield(() =>
              shield(async () => {
                inShield = await unshield(peer); // the outer shield's signal: the deadline
              }),
            );
            return 'owner done';
          },
          { name: 'owner', releaseTimeoutMs: 30 },
        ),
      ),
    );
    await within(
      root.call(async () => {
        await shield(async () => {
          step = await attempt(
            task(
              async () => {
                await shield(async () => {
                  inCall = await unshield(peer); // the call's signal: its own timeout, which no shield deadline fires
                });
                return 'step done';
              },
              { name: 'step', timeoutMs: 30 },
            ),
          );
        });
      }),
    );
    expect({ v, inShield: timedOut(inShield), inCall: timedOut(inCall), step: timedOut(step) }).toEqual({
      v: 'owner done',
      inShield: 'aborted: TimeoutError',
      inCall: 'aborted: TimeoutError',
      step: 'aborted: TimeoutError',
    });
  });

  it('lending hint: a second unshield during an unawaited one names the fix that keeps the link, one hole around an all(), whose members the owner’s interruption reaches', async () => {
    const reason = new Error('owner cut');
    let hint = '';
    let r: Outcome<unknown> | undefined;
    const members: Context[] = [];
    const step = (name: string) =>
      task(
        async () => {
          members.push(current());
          await never();
        },
        { name },
      );
    const root = app();
    const owner = root.fork(
      task(
        async () => {
          await shield(async () => {
            const p = unshield(async () => 'a');
            try {
              void unshield(async () => 'b');
            } catch (e) {
              hint = e instanceof UnawaitedCallError ? e.message.slice(e.message.indexOf('the call was not awaited')) : String(e);
            }
            await p;
            r = await unshield(() => all([step('a'), step('b')])); // the hint, followed
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(members.length).toBe(2);
    owner.abort(reason);
    await within(root.result(owner));
    expect({ hint, hole: r, members: members.map((m) => m.outcome) }).toEqual({
      hint:
        'the call was not awaited (two concurrent unshields on one node? await each one, or make one hole: ' +
        'unshield(() => all([...])))',
      hole: { status: 'aborted', reason },
      members: [
        { status: 'aborted', reason },
        { status: 'aborted', reason },
      ],
    });
  });
});
