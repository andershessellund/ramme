// node-topic.test.ts — the NodeTopic event stream (DESIGN.md §5, D10′): the
// receiver is a construction-time provider on the root, resolved once per root;
// node:created is always a node's first event, and a pending value node emits
// events before placement; node:stalled is armed for every delivered body that
// has not settled (DESIGN.md §4.4); a throwing receiver is
// reported with console.error and the event dropped; with no receiver, no stall
// timer is armed.
// Also ported from the pre-redesign lifecycle-events suite: fiber events, entry
// naming, release fibers, and one FLIP (DESIGN.md §2.4, §5): release fibers
// exist whether or not a receiver is provided; events exist only with a
// receiver. FLIP marks a port whose expectation the redesign reversed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, current, fork, interrupted, join, never, own, release, result, signal, wait } from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { inject } from './inject.js';
import { NodeTopic } from './lifecycle-events.js';
import type { NodeEvent } from './lifecycle-events.js';
import type { NodeImpl } from './node-impl.js';
import { factoryProvider, valueProvider } from './provider-util.js';
import { deferred, events, impl, micro, tick } from './test/util.js';
import type { EventLog } from './test/util.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Lookups of `NodeTopic` in `n`'s cache from now on. Resolving the receiver reads the root's cache first
 * (`resolveFrom`), with or without a provider, so this counts resolutions, not factory runs: the cache
 * keeps a factory at one run however often the receiver is re-resolved.
 */
function topicLookups(n: NodeImpl): () => number {
  const spy = vi.spyOn(n.cache, 'get');
  return () => spy.mock.calls.filter(([k]) => k === NodeTopic).length;
}

/** The events about node `id`: its own, plus the `entry:*` events its owner emitted for its entry. */
function story(ev: EventLog, id: number): string[] {
  const created = ev.of('node:created').find((e) => e.id === id);
  const owner = created?.parentId;
  const name = created?.name ?? created?.task;
  return ev.log
    .filter(
      (e) =>
        e.id === id ||
        (owner !== null && e.id === owner && e.kind === 'entry' && 'entryName' in e && e.entryName === name),
    )
    .map((e) => (e.kind === 'entry' && e.id !== id ? `owner ${e.type}` : e.type));
}

describe('event sequences per operation', () => {
  it('fork: node:created → entry:registered → node:started → node:settled → node:releasing → node:complete', async () => {
    const ev = events();
    let id = -1;
    await ev.root.call(function* () {
      const f = fork(
        task(
          function* () {
            own(() => {});
            return 1;
          },
          { name: 'worker' },
        ),
      );
      id = f.id;
      expect(yield* join(f)).toBe(1);
    });
    expect(story(ev, id)).toEqual([
      'node:created',
      'owner entry:registered',
      'node:started',
      'entry:registered',
      'node:settled',
      'node:releasing',
      'entry:released',
      'node:complete',
    ]);
    const settled = ev.of('node:settled').find((e) => e.id === id)!;
    expect(settled.outcome).toBe('success');
    expect(ev.of('node:complete').find((e) => e.id === id)?.outcome).toBe('success');
    await ev.root.close();
  });

  it('join: join:enter and join:leave on the joiner; a halted joiner emits no join:leave, and settles after it unwound', async () => {
    const ev = events();
    let joinerId = -1;
    let joinedId = -1;
    await ev.root.call(function* () {
      joinerId = current().id;
      const f = fork(function* () { return 'v'; });
      joinedId = f.id;
      yield* join(f);
    });
    expect(ev.of('join:enter').map((e) => [e.id, e.joinedId])).toEqual([[joinerId, joinedId]]);
    expect(ev.of('join:leave').map((e) => [e.id, e.joinedId, e.outcome])).toEqual([[joinerId, joinedId, 'success']]);

    const gate = deferred();
    let rejectedId = -1;
    const joiner = ev.root.fork(
      task(
        function* () {
          const slow = fork(function* () { return yield* wait(gate.promise); });
          yield* join(slow);
        },
        { onFailure: 'link' },
      ),
    );
    rejectedId = joiner.id;
    await tick();
    joiner.abort();
    gate.resolve();
    await ev.root.close();
    expect(ev.of('join:enter').filter((e) => e.id === rejectedId)).toHaveLength(1);
    expect(ev.of('join:leave').filter((e) => e.id === rejectedId)).toHaveLength(0);
    expect(ev.of('node:settled').filter((e) => e.id === rejectedId).map((e) => e.outcome)).toEqual(['aborted']);
  });

  it("a DI value: node:created (kind 'value', stack 'none') → entry:registered for what its constructor owned → node:placed → node:started of its constructor's forks (D10′)", async () => {
    const Name = createInjectionKey<string>('Name');
    class Service {
      name = inject(Name);
      constructor() {
        own({ [Symbol.dispose]() {} });
        own(fork(() => never()));
      }
    }
    const ev = events({ providers: [valueProvider(Name, 'svc')] });
    await ev.root.call(function* () {
      ev.root.get(Service);
    });
    const v = ev.of('node:created').find((e) => e.kind === 'value')!;
    expect(v).toMatchObject({ name: 'Service', stack: 'none', subscribed: false, mode: 'freeze' });
    const reaper = ev.of('node:created').find((e) => e.parentId === v.id)!;
    expect(reaper.kind).toBe('fiber');
    const types = ev.log
      .filter((e) => e.id === v.id || (e.id === reaper.id && e.type === 'node:started'))
      .map((e) => (e.id === reaper.id ? `fork ${e.type}` : e.type));
    expect(types.slice(0, 5)).toEqual([
      'node:created',
      'entry:registered', // the passive entry
      'entry:registered', // the owned fork
      'node:placed',
      'fork node:started',
    ]);
    expect(ev.of('node:placed').find((e) => e.id === v.id)?.storageId).toBe(ev.root.id);
    expect(ev.of('node:complete').filter((e) => e.kind === 'value')).toHaveLength(0);
    await ev.root.close();
    expect(ev.of('node:complete').filter((e) => e.id === v.id)).toHaveLength(1);
    // the call fiber completed on its own and left the explicit stack; only the provided stack remained
    expect(ev.of('node:releasing').filter((e) => e.id === ev.root.id).map((e) => e.stack)).toEqual(['provided']);
  });

  it("releases: a kind 'release' node runs every release; entry:released carries the error of a failed one", async () => {
    const ev = events();
    const N = ev.root.child({ name: 'N' });
    N.own(function closeSocket() {});
    N.own(async function flushBuffer() {
      await tick();
      throw new Error('disk full');
    });
    await expect(N.close()).rejects.toThrow('disk full');
    const releases = ev.of('node:created').filter((e) => e.kind === 'release');
    expect(releases.map((e) => [e.name, e.parentId, e.stack, e.subscribed, e.mode])).toEqual([
      ['release:flushBuffer', N.id, 'none', false, 'observe'],
      ['release:closeSocket', N.id, 'none', false, 'observe'],
    ]);
    const released = ev.of('entry:released').filter((e) => e.id === N.id);
    expect(released.map((e) => [e.entryName, e.stack, e.error])).toEqual([
      ['flushBuffer', 'explicit', 'Error: disk full'],
      ['closeSocket', 'explicit', undefined],
    ]);
    await ev.root.close();
  });

  it('entry names: a defer function’s name, a value’s constructor name, a node’s name (ported resource naming)', async () => {
    const ev = events();
    class Socket {
      [Symbol.dispose](): void {}
    }
    const N = ev.root.child({ name: 'N' });
    N.own(function stopTimer() {});
    N.own(new Socket());
    N.own({ [Symbol.dispose]() {} });
    N.child({ name: 'scope' });
    await N.close();
    expect(ev.of('entry:registered').filter((e) => e.id === N.id).map((e) => e.entryName)).toEqual([
      'stopTimer',
      'Socket',
      'entry',
      'scope',
    ]);
    await ev.root.close();
  });
});

describe('delivery, halt and stall events', () => {
  it('node:delivered for every node of a delivery, then node:settled for a body halted at its wait', async () => {
    const ev = events();
    const f = ev.root.fork(
      task(
        function* () {
          yield* never();
        },
        { onFailure: 'link', name: 'sleeper' },
      ),
    );
    const c = ev.root.child({ name: 'scope' });
    await tick();
    ev.root.abort('stop');
    await ev.root.close();
    for (const id of [ev.root.id, f.id, c.id])
      expect(ev.of('node:delivered').filter((e) => e.id === id).map((e) => e.reason)).toEqual(['stop']);
    expect(ev.of('node:settled').filter((e) => e.id === f.id).map((e) => e.outcome)).toEqual(['aborted']);
    const deliveredSeqs = [ev.root.id, f.id, c.id].map((id) => ev.of('node:delivered').find((e) => e.id === id)!.seq);
    const settledSeq = ev.of('node:settled').find((e) => e.id === f.id)!.seq;
    expect(Math.max(...deliveredSeqs)).toBeLessThan(settledSeq); // every signal fires before any body settles (I9)
  });

  it('node:stalled for a delivered freeze body whose wait(p) the halt lets finish and p never settles, and for a delivered observe body that never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const ev = events({ stallWarningMs: 100 });
    const gate = deferred();
    const stuck = ev.root.fork(task(function* () { return yield* wait(gate.promise); }, { onFailure: 'link', name: 'stuck' }));
    const watcher = ev.root.fork(
      task(
        function* () {
          yield* interrupted();
          yield* wait(gate.promise); // a shutdown that never finishes
        },
        { onFailure: 'link', interrupt: 'observe', name: 'watcher' },
      ),
    );
    await micro();
    await micro();
    stuck.abort();
    watcher.abort();
    vi.advanceTimersByTime(100);
    expect(ev.of('node:stalled').map((e) => e.id).sort()).toEqual([stuck.id, watcher.id].sort());
    expect(ev.of('node:stalled').every((e) => e.sinceMs === 100)).toBe(true);
    gate.resolve();
    vi.useRealTimers();
    await ev.root.close();
  });
});

describe('order pins (DESIGN.md §5)', () => {
  it('a born-delivered child emits node:created → node:delivered', async () => {
    const ev = events();
    const ids: number[] = [];
    // A delivered freeze body's outcome is `aborted` whatever it does (I13), so nothing is asserted inside it.
    const outcome = await ev.root.result(
      ev.root.fork(
        task(
          function* () {
            current().abort('gone');
            ids.push(fork(function* () {}).id, current().child().id);
          },
          { onFailure: 'link' },
        ),
      ),
    );
    expect(outcome).toEqual({ status: 'aborted', reason: 'gone' });
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(ev.typesOf(id).slice(0, 2)).toEqual(['node:created', 'node:delivered']);
    await ev.root.close();
  });

  it('a fiber built on an already-aborted signal emits node:created → node:delivered → node:settled → node:complete', async () => {
    const ev = events();
    const ac = new AbortController();
    ac.abort('pre');
    let ran = false;
    const f = ev.root.fork(
      task(
        () => {
          ran = true;
        },
        { signal: ac.signal, onFailure: 'link' },
      ),
    );
    expect(ev.typesOf(f.id)).toEqual(['node:created', 'node:delivered', 'node:settled', 'node:complete']);
    expect(ev.of('node:settled').find((e) => e.id === f.id)?.outcome).toBe('aborted');
    await tick();
    expect(ran).toBe(false);
    await ev.root.close();
  });

  it('node:created is every node’s first event and node:complete its last', async () => {
    const ev = events();
    await ev.root.call(function* () {
      own(() => {});
      yield* join(fork(function* () { return own(() => {}); }));
      const c = current().child();
      c.own(() => {});
      yield* c.close();
    });
    await ev.root.close();
    const ids = new Set(ev.of('node:created').map((e) => e.id));
    for (const id of ids) {
      const types = ev.log.filter((e) => e.id === id && e.kind !== 'entry').map((e) => e.type);
      expect(types[0], `node ${id}`).toBe('node:created');
      expect(types.at(-1), `node ${id}`).toBe('node:complete');
    }
  });
});

describe('fields', () => {
  it('kind, task, stack, subscribed, mode, parentId and a strictly increasing seq', async () => {
    const ev = events();
    const work = task(function* () { return 'w'; }, { name: 'work', interrupt: 'observe' });
    let callId = -1;
    let forkId = -1;
    await ev.root.call(function* () {
      callId = current().id;
      const f = own(fork(work)); // unsubscribed after own()
      forkId = f.id;
      yield* join(f);
      current().pool({ name: 'jobs', onFailure: () => {} });
    });
    await ev.root.close();
    const created = (id: number) => ev.of('node:created').find((e) => e.id === id)!;
    expect(created(ev.root.id)).toMatchObject({ kind: 'context', stack: 'none', subscribed: false, parentId: null });
    expect(created(callId)).toMatchObject({ kind: 'fiber', task: 'anonymous', stack: 'explicit', subscribed: true });
    expect(created(forkId)).toMatchObject({
      kind: 'fiber',
      name: 'work',
      task: 'work',
      stack: 'explicit',
      subscribed: true, // at construction; own() flips it afterwards
      mode: 'observe',
      parentId: callId,
    });
    expect(ev.of('node:created').find((e) => e.kind === 'pool')).toMatchObject({ name: 'jobs', subscribed: false, stack: 'explicit' });
    expect(ev.of('entry:registered').every((e) => e.kind === 'entry')).toBe(true);
    const seqs = ev.log.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });
});

describe('no receiver, no cost (DESIGN.md §5)', () => {
  it('without a receiver nothing is emitted, the receiver is resolved once per root, and no stall timer is armed', async () => {
    const received: NodeEvent[] = [];
    const other = createRootContext({ providers: [valueProvider(NodeTopic, (e: NodeEvent) => void received.push(e))] });
    const root = createRootContext();
    expect(impl(root).receiver).toBeUndefined(); // resolved by the root's own node:created: "none"
    const lookups = topicLookups(impl(root));
    const gate = deferred();
    const f = root.fork(task(function* () { return yield* wait(gate.promise); }, { onFailure: 'link' }));
    await tick();
    f.abort();
    expect(impl(f).stallTimer).toBeUndefined(); // nobody could hear node:stalled
    gate.resolve();
    await root.close();
    expect(lookups()).toBe(0); // "none" is remembered: no event of the tree resolves NodeTopic again
    expect(received.filter((e) => e.id !== other.id)).toEqual([]); // another tree's receiver hears nothing of this one
    await other.close();
  });

  it('a receiver is resolved once per root, however many events the tree emits', async () => {
    let resolved = 0;
    const log: NodeEvent[] = [];
    const root = createRootContext({
      providers: [
        factoryProvider(NodeTopic, () => {
          resolved++;
          return (e: NodeEvent) => void log.push(e);
        }),
      ],
    });
    expect(typeof impl(root).receiver).toBe('function'); // resolved by the root's own node:created
    const lookups = topicLookups(impl(root));
    await root.call(function* () {
      for (let i = 0; i < 5; i++) yield* join(fork(function* () { return i; }));
    });
    await root.close();
    expect(lookups()).toBe(0); // not re-resolved per event (the factory count alone cannot tell: the cache keeps it at 1)
    expect(resolved).toBe(1);
    expect(log.length).toBeGreaterThan(20);
  });

  it('release fibers exist whether or not a receiver is provided; events exist only with one (DESIGN.md §5)', async () => {
    for (const withReceiver of [false, true]) {
      const log: NodeEvent[] = [];
      const root = createRootContext(
        withReceiver ? { providers: [valueProvider(NodeTopic, (e: NodeEvent) => void log.push(e))] } : {},
      );
      const seen: { kind: string; parent: unknown; deadline: AbortSignal }[] = [];
      const N = root.child();
      N.own(() => {
        seen.push({ kind: impl(current()).kind, parent: impl(current()).parent, deadline: signal() });
      });
      await N.close();
      expect(seen, `receiver: ${withReceiver}`).toHaveLength(1);
      expect(seen[0].kind).toBe('release');
      expect(seen[0].parent).toBe(N);
      expect(seen[0].deadline).not.toBe(N.signal);
      expect(log.some((e) => e.kind === 'release'), `receiver: ${withReceiver}`).toBe(withReceiver);
      await root.close();
    }
  });

  it('a throwing receiver is reported and the event dropped; the tree completes', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args));
    const root = createRootContext({
      providers: [
        valueProvider(NodeTopic, () => {
          throw new Error('receiver bug');
        }),
      ],
    });
    await root.call(function* () {
      own(() => {});
      yield* join(fork(function* () { return 1; }));
    });
    await root.close();
    expect(root.state).toBe('complete');
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('ported lifecycle-events cases', () => {
  it('fork, call and join events of one tree, in order', async () => {
    const ev = events();
    let main: Context | undefined;
    await ev.root.call(
      task(
        function* () {
          main = current();
          const f = fork(task(function* () { return 'f'; }, { name: 'child' }));
          yield* call(task(function* () { return 'c'; }, { name: 'inline' }));
          yield* join(f);
        },
        { name: 'main' },
      ),
    );
    await ev.root.close();
    const mainId = main!.id;
    const kinds = ev.log.filter((e) => e.id === mainId && ['join:enter', 'join:leave'].includes(e.type)).map((e) => e.type);
    expect(kinds).toEqual(['join:enter', 'join:leave']); // a call emits no join event on its caller
    expect(ev.of('node:created').filter((e) => e.kind === 'fiber').map((e) => e.task)).toEqual(['main', 'child', 'inline']);
  });

  it('a failing call: the child settles and completes with defect, and the caller catches it (ported "call:leave with error on failure")', async () => {
    const ev = events();
    let childId = -1;
    let caught: unknown;
    await ev.root.call(function* () {
      try {
        yield* call(
          task(
            function* () {
              childId = current().id;
              throw new Error('boom');
            },
            { name: 'fail-call' },
          ),
        );
      } catch (e) {
        caught = e;
      }
    });
    await ev.root.close();
    expect((caught as Error).message).toBe('boom');
    expect(ev.of('node:created').find((e) => e.id === childId)?.task).toBe('fail-call');
    expect(ev.of('node:settled').find((e) => e.id === childId)?.outcome).toBe('defect');
    expect(ev.of('node:complete').find((e) => e.id === childId)?.outcome).toBe('defect');
  });

  it('join:leave carries the defect outcome of a joined fiber that threw (ported "join:leave with error outcome on join failure")', async () => {
    const ev = events();
    let joinerId = -1;
    let joinedId = -1;
    let caught: unknown;
    await ev.root.call(function* () {
      joinerId = current().id;
      const f = fork(function* () {
        throw new Error('join-fail');
      });
      joinedId = f.id;
      try {
        yield* join(f);
      } catch (e) {
        caught = e;
      }
    });
    await ev.root.close();
    expect((caught as Error).message).toBe('join-fail');
    expect(ev.of('join:enter').map((e) => [e.id, e.joinedId])).toEqual([[joinerId, joinedId]]);
    expect(ev.of('join:leave').map((e) => [e.id, e.joinedId, e.outcome])).toEqual([[joinerId, joinedId, 'defect']]);
  });

  it('result(f) emits join:enter and join:leave on the awaiter, and a halted awaiter no join:leave (ported "join:enter and join:leave for Fiber.result")', async () => {
    const ev = events();
    let awaiterId = -1;
    const ids: number[] = [];
    const statuses: string[] = [];
    await ev.root.call(function* () {
      awaiterId = current().id;
      const ok = fork(function* () { return 'ok'; });
      const bad = fork(function* () {
        throw new Error('bad');
      });
      ids.push(ok.id, bad.id);
      statuses.push((yield* result(ok)).status, (yield* result(bad)).status);
    });
    expect(statuses).toEqual(['success', 'defect']);
    expect(ev.of('join:enter').map((e) => [e.id, e.joinedId])).toEqual([
      [awaiterId, ids[0]],
      [awaiterId, ids[1]],
    ]);
    expect(ev.of('join:leave').map((e) => [e.id, e.joinedId, e.outcome])).toEqual([
      [awaiterId, ids[0], 'success'],
      [awaiterId, ids[1], 'defect'],
    ]);

    const gate = deferred();
    let slowId = -1;
    const waiter = ev.root.fork(
      task(
        function* () {
          const slow = fork(function* () { return yield* wait(gate.promise); });
          slowId = slow.id;
          yield* result(slow);
        },
        { onFailure: 'link' },
      ),
    );
    await tick();
    waiter.abort();
    gate.resolve();
    await ev.root.close();
    expect(ev.of('join:enter').filter((e) => e.id === waiter.id).map((e) => e.joinedId)).toEqual([slowId]);
    expect(ev.of('join:leave').filter((e) => e.id === waiter.id)).toHaveLength(0);
    expect(ev.of('node:settled').filter((e) => e.id === waiter.id).map((e) => e.outcome)).toEqual(['aborted']);
  });

  it('join/result in method form on another node emit on the awaiting body, not on the receiver; with no body, on the receiver (DESIGN.md §4.2)', async () => {
    const ev = events();
    const other = ev.root.child({ name: 'other' });
    let bodyId = -1;
    const ids: number[] = [];
    await ev.root.call(function* () {
      bodyId = current().id;
      const a = fork(function* () { return 'a'; });
      const b = fork(function* () { return 'b'; });
      ids.push(a.id, b.id);
      expect(yield* other.join(a)).toBe('a');
      expect((yield* other.result(b)).status).toBe('success');
    });
    expect(ev.of('join:enter').map((e) => [e.id, e.joinedId])).toEqual([
      [bodyId, ids[0]],
      [bodyId, ids[1]],
    ]);
    expect(ev.of('join:leave').map((e) => [e.id, e.joinedId, e.outcome])).toEqual([
      [bodyId, ids[0], 'success'],
      [bodyId, ids[1], 'success'],
    ]);
    expect(ev.typesOf(other.id).filter((t) => t.startsWith('join:'))).toEqual([]);
    // no body awaits at top level: the events name the receiver
    const g = other.fork(task(function* () { return 'g'; }, { onFailure: 'link' }));
    expect(await other.join(g)).toBe('g');
    expect(ev.of('join:enter').filter((e) => e.joinedId === g.id).map((e) => e.id)).toEqual([other.id]);
    expect(ev.of('join:leave').filter((e) => e.joinedId === g.id).map((e) => e.id)).toEqual([other.id]);
    await ev.root.close();
  });

  it('async releases report entry:released when they finish, not when they start', async () => {
    const ev = events();
    const gate = deferred();
    const N = ev.root.child();
    N.own(async function slow() {
      await gate.promise;
    });
    const closing = N.close();
    await tick();
    expect(ev.of('entry:released').filter((e) => e.id === N.id)).toHaveLength(0);
    expect(ev.of('node:started').filter((e) => e.kind === 'release')).toHaveLength(1);
    gate.resolve();
    await closing;
    expect(ev.of('entry:released').filter((e) => e.id === N.id).map((e) => e.entryName)).toEqual(['slow']);
    await ev.root.close();
  });

  it('an early release(x) runs in a release fiber and emits entry:released at once', async () => {
    const ev = events();
    let body: NodeImpl | undefined;
    let ran: { id: number; kind: string; parent: NodeImpl | undefined } | undefined;
    let releasedBeforeResume = -1;
    await ev.root.call(function* () {
      body = impl(current());
      const x = own({
        [Symbol.dispose]() {
          const n = impl(current()); // the release fiber, not the body that called release(x) (I14, DESIGN.md §2.4)
          ran = { id: n.id, kind: n.kind, parent: n.parent };
        },
      });
      yield* release(x);
      releasedBeforeResume = ev.of('entry:released').filter((e) => e.id === current().id).length;
    });
    await ev.root.close();
    expect(releasedBeforeResume).toBe(1);
    expect(ran?.kind).toBe('release');
    expect(ran?.parent).toBe(body);
    const created = ev.of('node:created').find((e) => e.id === ran!.id)!;
    expect(created).toMatchObject({ kind: 'release', parentId: body!.id, stack: 'none' });
    const released = ev.of('entry:released').find((e) => e.id === body!.id)!;
    expect(created.seq).toBeLessThan(released.seq);
    expect(ev.of('node:complete').find((e) => e.id === ran!.id)!.seq).toBeLessThan(released.seq);
  });
});
