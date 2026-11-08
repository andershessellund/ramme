// Tests for runtime / shielding.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, attempt, child, current, fork, interrupted, join, lookup, never, shield, signal, sleep, unshield } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import type { Context, Fiber, Instruction, Op, Outcome } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { valueProvider } from '../../src/provider-util.js';
import { FiberAbortedError } from '../../src/resource.js';
import { events, impl, tick, trace, within } from '../support/util.js';
import type { Trace } from '../support/util.js';

/** Every `console.warn` of the current test, first argument only; the spy keeps them off the console. */
const warnings: string[] = [];

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

beforeEach(() => {
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
});

afterEach(async () => {
  vi.restoreAllMocks();
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

/** `f`'s outcome, read from top level. It pushes `complete` to `t` when it arrives, which is a microtask or two after the node completed. */
function completion<T>(root: Context, f: Fiber<T>, t: Trace): PromiseLike<Outcome<T>> {
  return root.result(f).then((o) => {
    t.push('complete');
    return o;
  });
}

/** The work in flight when the body is halted: a `call` that never ends on its own; `state()` reads its node's state. */
function slowTask(t?: Trace) {
  let node: Context | undefined;
  const slow = task(
    function* () {
      node = current();
      t?.push('slow running');
      yield* never();
    },
    { name: 'slow' },
  );
  return { slow, state: () => node?.state };
}

describe('shield and unshield', () => {
  it('cut mid-hole: the owner’s interruption ends the hole, aborted with the owner’s reason; the shield body goes on to its end, the owner is resumed after it and returned at its next yield*, and completes after the shield', async () => {
    const ev = events();
    roots.push(ev.root);
    const t = trace();
    const reason = new Error('owner cut');
    let shieldNode: Context | undefined;
    let hole: Context | undefined;
    let r: Outcome<string> | undefined;
    const owner = ev.root.fork(
      task(
        function* () {
          const v = yield* shield(function* () {
            shieldNode = current();
            t.push('buffer flushed');
            r = yield* unshield(function* () {
              hole = current();
              t.push('peer notified');
              yield* sleep(10_000); // the owner's interruption halts it, and clears its timer
              t.push('peer acknowledged');
              return 'ack';
            });
            t.push('offset written');
            return 'shielded';
          });
          t.push(`after the shield: ${v}`); // release work is not returned at the halt: resumed with its value
          yield* sleep(1); // returned here
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

  it('owner already interrupted: a hole made in a shield its halted finally runs is skipped at once, its body never runs whatever its interrupt mode, and its outcome is aborted with the owner’s reason', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const ran: string[] = [];
    let r: Outcome<string> | undefined;
    let observeHole: Outcome<string> | undefined;
    const root = app();
    const owner = root.fork(
      task(
        function* () {
          try {
            yield* never(); // halted here
          } finally {
            yield* shield(function* () {
              // release work of the halted node: the shield's owner, whose interruption has come
              const p = unshield(function* () {
                ran.push('hole started');
                yield* sleep(10_000);
                ran.push('past its first yield*');
                return 'ack';
              });
              r = yield* p;
              observeHole = yield* unshield(
                task(
                  function* () {
                    ran.push('observe hole started'); // an observe child is not born delivered, but it is not born at all
                    return 'ack';
                  },
                  { name: 'observe hole', interrupt: 'observe' },
                ),
              );
              t.push('shield goes on');
            });
          }
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, owner, t);
    owner.abort(reason);
    const o = await within(done);
    expect({ ran, hole: r, observeHole, log: t.log, owner: o }).toEqual({
      ran: [],
      hole: { status: 'aborted', reason },
      observeHole: { status: 'aborted', reason },
      log: ['shield goes on', 'complete'],
      owner: { status: 'aborted', reason },
    });
  });

  it('a hole that succeeds gives its value, and one that fails its failure as a value, consumed: nothing is left unconsumed on any node', async () => {
    const boom = new Error('peer refused');
    const notifyPeer = task(
      function* (): Generator<Instruction, never, unknown> {
        throw boom;
      },
      { name: 'notifyPeer' },
    );
    let ok: Outcome<number> | undefined;
    let bad: Outcome<never> | undefined;
    const unconsumed: Record<string, number> = {};
    const root = app();
    const v = await within(
      root.call(function* () {
        const body = current();
        return yield* shield(function* () {
          const s = current();
          ok = yield* unshield(function* (n: number) {
            return n * 2;
          }, 21);
          bad = yield* current().unshield(notifyPeer); // the method form, on the shield's node
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
      bad: { status: 'defect', error: boom },
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
        function* () {
          n.owner = current();
          yield* shield(function* () {
            n.outerShield = current();
            outer = yield* unshield(function* () {
              n.outerHole = current();
              try {
                yield* task(function* () {
                  n.innerOwner = current();
                  yield* shield(function* () {
                    n.innerShield = current();
                    inner = yield* unshield(function* () {
                      n.innerHole = current();
                      t.push('inner hole waiting');
                      yield* never();
                    });
                    t.push('inner shield goes on');
                  });
                  t.push('inner owner after its shield'); // resumed after its release work
                  yield* sleep(1); // returned here: the inner owner is interrupted
                })();
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
      callError: reason, // the outer hole's call of the aborted inner owner: another node's abort, thrown in
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
        function* () {
          n.owner = current();
          yield* shield(function* () {
            n.shield = current();
            r = yield* task(function* () {
              n.call = current();
              const o = yield* unshield(function* () {
                n.hole = current();
                linked = impl(current()).linkedSignal;
                t.push('hole waiting');
                yield* sleep(10_000);
                return 'unreachable';
              });
              t.push('call goes on');
              return o;
            })();
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

  it('outside any shield it throws a TypeError before anything runs: in a generator body, in an entry’s release fiber, in a generator release, and after a shield has ended', async () => {
    let ran = 0;
    const thrown: string[] = [];
    const attemptHole = (where: string): void => {
      try {
        void unshield(function* () {
          ran++;
        });
        thrown.push(`${where}: nothing thrown`);
      } catch (e) {
        thrown.push(`${where}: ${e instanceof TypeError && /outside any shield/.test(e.message) ? 'TypeError' : String(e)}`);
      }
    };
    const root = app();
    await within(
      root.call(function* () {
        attemptHole('body');
        const scope = child();
        scope.own(() => attemptHole('entry release'));
        scope.own({}, function* () {
          attemptHole('generator release');
        });
        yield* scope.close();
        yield* shield(function* () {});
        attemptHole('after a shield');
      }),
    );
    expect({ thrown, ran }).toEqual({
      thrown: ['body: TypeError', 'generator release: TypeError', 'entry release: TypeError', 'after a shield: TypeError'],
      ran: 0,
    });
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
          function* () {
            yield* shield(function* () {
              shieldNode = current();
              seen = yield* unshield(function* () {
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
      function* () {
        yield* sleep(10_000);
        return 'ack';
      },
      { name: 'notifyPeer', signal: peer.signal },
    );
    const root = app();
    await within(
      root.call(function* () {
        const owner = current();
        yield* shield(function* () {
          const p = unshield(notifyPeer);
          setTimeout(() => peer.abort(reason), 1);
          r = yield* p;
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
        function* () {
          yield* shield(function* () {
            r = yield* join(
              fork(function* () {
                return yield* unshield(function* () {
                  t.push('hole waiting');
                  yield* sleep(10_000);
                  return 'unreachable';
                });
              }),
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
        function* () {
          yield* shield(function* () {
            r = yield* unshield(
              task(
                function* () {
                  t.push('hole waiting');
                  const why = yield* interrupted(); // the resolving form: an observe body is never halted
                  heard = { aborted: signal().aborted, signalReason: signal().reason === reason, why: why === reason };
                  yield* sleep(1); // not its interruption's to halt
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

  it('the owner is the node the shield runs on: under ctx.shield yielded by another body, the hole follows ctx, and the halted body waits for the shield', async () => {
    const t = trace();
    const reqReason = new Error('request cut');
    const scopeReason = new Error('scope closed');
    let hole: Context | undefined;
    let r: Outcome<string> | undefined;
    const root = app();
    const scope = root.child({ name: 'scope' });
    const req = root.fork(
      task(
        function* () {
          yield* scope.shield(function* () {
            r = yield* unshield(function* () {
              hole = current();
              t.push('hole waiting');
              yield* sleep(10_000);
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
    req.abort(reqReason); // the body that yielded the shield: not the owner, and release work is not returned at its halt
    await tick(2);
    const afterReq = { log: [...t.log], holeDelivered: impl(hole!).delivered, hole: r, req: req.state };
    scope.abort(scopeReason); // the node the shield runs on: the owner
    const o = await within(root.result(req));
    expect({ afterReq, hole: r, log: t.log, req: o }).toEqual({
      afterReq: { log: ['hole waiting'], holeDelivered: false, hole: undefined, req: 'running' },
      hole: { status: 'aborted', reason: scopeReason },
      log: ['hole waiting', 'shield goes on'],
      req: { status: 'aborted', reason: reqReason },
    });
  });

  it('a shield inside a shield has the outer shield as its owner: in the halted finally the task’s interruption neither skips nor cuts its hole (Effect’s restore under a nested mask)', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const n: Record<'outer' | 'inner', Context | undefined> = { outer: undefined, inner: undefined };
    let linked: AbortSignal | undefined;
    let r: Outcome<string> | undefined;
    const { slow } = slowTask();
    /** A library helper, non-cancellable except for one step, used where its caller wrapped it in a shield of its own. */
    const helper = (): Op<void> =>
      shield(function* () {
        n.inner = current();
        r = yield* unshield(function* () {
          linked = impl(current()).linkedSignal;
          t.push('peer notified');
          yield* sleep(5);
          t.push('peer acknowledged');
          return 'notified';
        });
      });
    const root = app();
    const owner = root.fork(
      task(
        function* () {
          try {
            yield* slow();
          } finally {
            yield* shield(() => {
              n.outer = current();
              return helper(); // a body returning an op: driven in the outer shield's frame (decision 28)
            });
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
        function* () {
          yield* shield(function* () {
            yield* task(function* () {
              callNode = current();
              yield* shield(function* () {
                r = yield* unshield(function* () {
                  linked = impl(current()).linkedSignal;
                  t.push('hole waiting');
                  yield* sleep(20);
                  t.push('hole done');
                  return 'ran to end';
                });
              });
            })();
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
    function* peer(): Generator<Instruction, string, unknown> {
      yield* sleep(10_000); // a peer that never answers
      return 'unreachable';
    }
    const timedOut = (o: Outcome<unknown> | undefined): string =>
      o?.status === 'aborted' ? `aborted: ${(o.reason as Error).name}` : JSON.stringify(o);
    let inShield: Outcome<string> | undefined;
    let inCall: Outcome<string> | undefined;
    let step: Outcome<string> | undefined;
    const root = app();
    const v = await within(
      root.call(
        task(
          function* () {
            yield* shield(() =>
              shield(function* () {
                inShield = yield* unshield(peer); // the outer shield's signal: the deadline
              }),
            );
            return 'owner done';
          },
          { name: 'owner', releaseTimeoutMs: 30 },
        ),
      ),
    );
    await within(
      root.call(function* () {
        yield* shield(function* () {
          step = yield* attempt(
            task(
              function* () {
                yield* shield(function* () {
                  inCall = yield* unshield(peer); // the call's signal: its own timeout, which no shield deadline fires
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

  it('one hole around an all(), a body returning an op (decision 28): the owner’s interruption reaches its members, and the hole ends aborted with the owner’s reason', async () => {
    const reason = new Error('owner cut');
    let r: Outcome<unknown> | undefined;
    const members: Context[] = [];
    const step = (name: string) =>
      task(
        function* () {
          members.push(current());
          yield* never();
        },
        { name },
      );
    const root = app();
    const owner = root.fork(
      task(
        function* () {
          yield* shield(function* () {
            r = yield* unshield(() => all([step('a'), step('b')])); // one hole: a body returning an op
          });
        },
        { name: 'owner', ...quiet },
      ),
    );
    await tick();
    expect(members.length).toBe(2);
    owner.abort(reason);
    await within(root.result(owner));
    expect({ hole: r, members: members.map((m) => m.outcome) }).toEqual({
      hole: { status: 'aborted', reason },
      members: [
        { status: 'aborted', reason },
        { status: 'aborted', reason },
      ],
    });
  });
});
