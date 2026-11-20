// Tests for `ctx.acquire(make, release?)` (DESIGN.md §2.6, D48): an asynchronous creation attached to the node its
// caller names. A function that creates a resource is handed its owner (`connect(owner)` below, a producer), and
// `owner.acquire(make)` is `wait(make)` whose result is attached to `owner` in the step that receives it. What the
// verb exists for is the cases where attaching by hand goes wrong: a creation whose consumer was interrupted, or
// that lost a race, releases what it made at once, so the owner never holds an entry nobody was handed, and a
// creation whose owner is gone releases it and says so.
import { describe, expect, it } from 'vitest';
import { all, current, fail, fork, join, own, race, sleep, wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { CreationViolationError, FiberAbortedError, NodeCompletedError, PendingNodeError, Resource } from '../../src/resource.js';
import { deferred, events, impl, tick, trace, within } from '../support/util.js';
import type { Trace } from '../support/util.js';

/** A connection: a native resource whose release is recorded. */
class Conn implements Resource {
  constructor(
    readonly id: number,
    readonly log: Trace,
  ) {}
  [Resource.release](): void {
    this.log.push(`conn ${this.id} released`);
  }
}

/** A driver: `connect()` resolves when the test lets it, and records the signal it was handed. */
function driver(t: Trace) {
  let opened = 0;
  const gates: PromiseWithResolvers<void>[] = [];
  const signals: AbortSignal[] = [];
  return {
    signals,
    get opened(): number {
      return opened;
    },
    /** Let the `n`th `connect()` in flight finish (the first by default). */
    arrive(n = 0): void {
      gates[n]?.resolve();
    },
    async connect(s: AbortSignal): Promise<Conn> {
      signals.push(s);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      const conn = new Conn(++opened, t);
      t.push(`conn ${conn.id} opened`);
      return conn;
    },
  };
}

/** The entries a node holds, on its explicit stack. */
const entries = (node: Context): number => impl(node).explicit.size;

describe('owner.acquire(make): the creation is attached to the owner its caller names (D48)', () => {
  it('make is called when the op is yielded, handed the creation’s signal; its value is the op’s, and the owner releases it', async () => {
    const t = trace();
    const d = driver(t);
    const root = createRootContext();
    /** A producer: a function that creates a resource takes its owner. */
    const connect = (owner: Context) => owner.acquire((s) => d.connect(s));
    await within(
      root.call(function* () {
        const op = connect(current());
        yield* sleep(0);
        expect(d.signals).toHaveLength(0); // lazy: nothing started by making the op
        queueMicrotask(() => d.arrive());
        const conn = yield* op;
        expect(conn).toBeInstanceOf(Conn);
        expect(d.signals[0]!.aborted).toBe(false);
        expect(entries(current())).toBe(1);
        t.push(`using conn ${conn.id}`);
      }),
    );
    expect(t.log).toEqual(['conn 1 opened', 'using conn 1', 'conn 1 released']);
    await within(root.close());
  });

  it('the owner is the node named, whoever yields the op and however: another node, inside all, a fork', async () => {
    const t = trace();
    const root = createRootContext();
    const session = root.child({ name: 'session' });
    let made = 0;
    const make = (): Promise<Conn> => Promise.resolve(new Conn(++made, t));
    await within(
      root.call(function* () {
        const me = current();
        yield* session.acquire(make); // for a longer-lived node
        const [, inGroup] = yield* all([sleep(0), me.acquire(make)]); // for this body: it outlives the group
        const forked = fork(me.acquire(make)); // and the fork that ran the creation
        const viaFork = yield* join(forked);
        expect([inGroup.id, viaFork.id]).toEqual([2, 3]);
        expect([entries(session), entries(me)]).toEqual([1, 2]);
        t.push('body done');
      }),
    );
    expect(t.log).toEqual(['body done', 'conn 3 released', 'conn 2 released']);
    await within(session.close());
    expect(t.log.at(-1)).toBe('conn 1 released');
    await within(root.close());
  });

  it('takes a release for a value that has none of its own, a value made synchronously, and a task’s op, whose expected failure it re-yields', async () => {
    const t = trace();
    const root = createRootContext();
    class Refused extends Error {
      override readonly name = 'Refused' as const;
    }
    const open = task(function* open(ok: boolean) {
      yield* sleep(0);
      if (!ok) return yield* fail(new Refused());
      return new Conn(3, t);
    });
    const outcome = await within(
      root.attempt(function* () {
        const me = current();
        const plain = yield* me.acquire(
          () => Promise.resolve({ id: 1 }),
          (v) => void t.push(`plain ${v.id} released`),
        );
        const idle = yield* me.acquire(() => new Conn(2, t)); // no promise: an idle resource a pool hands back
        const opened = yield* me.acquire(() => me.call(open, true)); // ramme work, through a node make names
        expect([plain.id, idle.id, opened.id, entries(me)]).toEqual([1, 2, 3, 3]);
        yield* me.acquire(() => me.call(open, false)); // ends this body with Refused
        t.push('unreachable');
      }),
    );
    expect(outcome).toMatchObject({ status: 'failure', error: { name: 'Refused' } });
    expect(t.log).toEqual(['conn 3 released', 'conn 2 released', 'plain 1 released']);
    await within(root.close());
  });

  it('what make throws, or its promise rejects with, is thrown at the yield*, and nothing is attached', async () => {
    const root = createRootContext();
    const boom = new Error('refused');
    const caught: unknown[] = [];
    await within(
      root.call(function* () {
        const me = current();
        for (const make of [() => Promise.reject(boom), (): never => { throw boom; }]) {
          try {
            yield* me.acquire(make, () => {});
          } catch (e) {
            caught.push(e);
          }
        }
        expect(entries(me)).toBe(0);
      }),
    );
    expect(caught).toEqual([boom, boom]);
    await within(root.close());
  });

  it('make runs under no node: an ambient own, a producer’s defaulted owner or a task’s call there throws NoCurrentNodeError, and nothing is attached', async () => {
    const t = trace();
    const root = createRootContext();
    /** A producer that attaches for whoever is current: inside make that would be the creation’s fiber, which ends at once. */
    const selfAttaching = (owner: Context = current()): Promise<Conn> => Promise.resolve(owner.own(new Conn(1, t)));
    const leaf = task(function* leaf() {
      return new Conn(2, t);
    });
    const names: string[] = [];
    await within(
      root.call(function* () {
        const me = current();
        for (const make of [() => selfAttaching(), () => Promise.resolve(own(new Conn(3, t))), () => leaf()]) {
          try {
            yield* me.acquire(make);
          } catch (e) {
            names.push((e as Error).name);
          }
        }
        expect(entries(me)).toBe(0);
      }),
    );
    expect(names).toEqual(['NoCurrentNodeError', 'NoCurrentNodeError', 'NoCurrentNodeError']);
    expect(t.log).toEqual([]);
    await within(root.close());
  });

  it('plain async code acquires through a node it names: await owner.acquire(make)', async () => {
    const t = trace();
    const root = createRootContext();
    const conn = await root.acquire(() => Promise.resolve(new Conn(1, t)));
    expect([conn.id, entries(root)]).toEqual([1, 1]);
    await within(root.close());
    expect(t.log).toEqual(['conn 1 released']);
  });
});

describe('a creation nobody is handed releases what it made, and its owner holds nothing for it', () => {
  it('a consumer interrupted while the creation runs is halted once it has completed: make finishes, hears the signal, and the value is released', async () => {
    const t = trace();
    const d = driver(t);
    const root = createRootContext();
    const work = task(function* work() {
      try {
        const conn = yield* current().acquire((s) => d.connect(s));
        t.push(`using conn ${conn.id}`); // never: the body is not resumed with a value it could not keep
      } finally {
        t.push(`consumer halted, holding ${entries(current())}`);
      }
    });
    const fiber = root.fork(work.with({ onFailure: () => {} }));
    await tick();
    fiber.abort();
    await tick();
    expect(d.signals[0]!.aborted).toBe(true); // a driver that takes the signal can stop sooner
    expect(t.log).toEqual([]); // the consumer waits for its creation, as for a callee
    d.arrive();
    await within(fiber.close().catch(() => {}));
    expect(t.log).toEqual(['conn 1 opened', 'conn 1 released', 'consumer halted, holding 0']);
    expect(fiber.outcome?.status).toBe('aborted');
    await within(root.close());
  });

  it('a creation that loses a race leaves no entry on its owner, where one attached by hand stays until the owner ends', async () => {
    const t = trace();
    const root = createRootContext();
    let made = 0;
    const slow = async (): Promise<Conn> => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Conn(++made, t);
    };
    /** The producer written by hand: it attaches whatever arrives, also when nobody waits for it any more. */
    const byHand = task(function* byHand(owner: Context) {
      const conn = yield* wait(slow());
      owner.own(conn);
      return conn;
    });
    const held: Record<string, number[]> = { acquire: [], byHand: [] };
    await within(
      root.call(function* () {
        const me = current();
        for (const [name, connect] of [
          ['acquire', () => me.acquire(slow)],
          ['byHand', () => byHand(me)],
        ] as const) {
          for (let i = 0; i < 3; i++) {
            expect(yield* race([connect(), sleep(1)])).toBeUndefined(); // the deadline wins
            yield* sleep(30); // the abandoned creation still arrives
            held[name]!.push(entries(me));
          }
        }
      }),
      2000,
    );
    expect(held).toEqual({ acquire: [0, 0, 0], byHand: [1, 2, 3] });
    await within(root.close());
  });

  it('a consumer already interrupted never starts the creation', async () => {
    const t = trace();
    const d = driver(t);
    const root = createRootContext();
    const outcome = await within(
      root.attempt(
        task(
          function* late() {
            yield* wait(new Promise((resolve) => setTimeout(resolve, 20))); // interrupted here; resumed once, its grant
            yield* current().acquire((s) => d.connect(s));
          },
          { timeoutMs: 2 },
        ),
      ),
    );
    expect(outcome.status).toBe('aborted');
    expect(d.signals).toHaveLength(0);
    await within(root.close());
  });

  it('an owner interrupted while a creation for it runs: the value is released, and a consumer that goes on hears FiberAbortedError', async () => {
    const t = trace();
    const d = driver(t);
    const root = createRootContext();
    const session = root.child({ name: 'session' });
    const result = within(
      root.attempt(function* () {
        try {
          yield* session.acquire((s) => d.connect(s));
        } catch (e) {
          return e;
        }
      }),
    );
    await tick();
    session.abort();
    d.arrive();
    const outcome = await result;
    expect(outcome).toMatchObject({ status: 'success' });
    expect((outcome as { value: unknown }).value).toBeInstanceOf(FiberAbortedError);
    expect(t.log).toEqual(['conn 1 opened', 'conn 1 released']);
    await within(session.close());
    await within(root.close());
  });

  it('an owner that has completed: NodeCompletedError at the yield*, nothing created; one that completes while a member of a group creates for it: the value is released and the group fails with it', async () => {
    const t = trace();
    const d = driver(t);
    const root = createRootContext();
    const gone = root.child({ name: 'gone' });
    const op = gone.acquire((s) => d.connect(s)); // made while the owner lives
    await within(gone.close());
    await expect(within(root.call(() => op))).rejects.toBeInstanceOf(NodeCompletedError);
    expect(() => gone.acquire((s) => d.connect(s))).toThrow(NodeCompletedError);
    expect(d.signals).toHaveLength(0);

    const other = root.child({ name: 'other' });
    const result = within(root.attempt(() => all([other.acquire((s) => d.connect(s))]))); // run under the group, not the owner
    await tick();
    await within(other.close());
    d.arrive();
    const outcome = await result;
    expect(outcome).toMatchObject({ status: 'defect', error: { name: 'AggregateError' } });
    expect(((outcome as { error: AggregateError }).error.errors[0] as Error).name).toBe('NodeCompletedError');
    expect(t.log).toEqual(['conn 1 opened', 'conn 1 released']);
    await within(root.close());
  });

  it('a release failure of a value nobody was handed surfaces from the node that held the creation', async () => {
    const root = createRootContext();
    const broken = new Error('release failed');
    const gate = deferred();
    const work = task(function* work() {
      yield* current().acquire(
        () => gate.promise.then(() => ({ id: 1 })),
        () => {
          throw broken;
        },
      );
    });
    const failures: unknown[] = [];
    const fiber = root.fork(work.with({ onFailure: (e) => void failures.push(e) }));
    await tick();
    fiber.abort();
    gate.resolve();
    await within(fiber.close().catch(() => {}));
    expect(fiber.outcome).toEqual({ status: 'defect', error: broken }); // the release phase amends `aborted` (DESIGN.md §4.12)
    expect(failures).toEqual([broken]);
    await within(root.close());
  });
});

describe('the creation is one fiber, named acquire, and the verb keeps the guards of a work op', () => {
  it('yielded, it is a child of the owner; as a member of a group it is the member, and no second node stands for the op', async () => {
    const ev = events({ name: 'app' });
    const t = trace();
    const session = ev.root.child({ name: 'session' });
    let made = 0;
    const make = (): Promise<Conn> => Promise.resolve(new Conn(++made, t));
    await within(
      ev.root.call(
        task(
          function* body() {
            yield* session.acquire(make);
            yield* all([session.acquire(make)]);
          },
          { name: 'body' },
        ),
      ),
    );
    const created = ev.of('node:created').filter((e) => e.name === 'acquire');
    const nameOf = (id: number | null): string | undefined => ev.of('node:created').find((e) => e.id === id)?.name;
    expect(created.map((e) => [e.kind, nameOf(e.parentId)])).toEqual([
      ['fiber', 'session'],
      ['fiber', 'all'],
    ]);
    expect(entries(session)).toBe(2);
    await within(session.close());
    await within(ev.root.close());
  });

  it('refuses a creation frame, a make that is no function and a value that cannot be owned; a value the owner already owns is not owned twice', async () => {
    const root = createRootContext();
    // A factory is synchronous (DESIGN.md §3.5): it attaches what it makes with `own`, and no op is made there, through
    // the value's own node, still pending, or through any other.
    const make = (): Promise<Resource> => Promise.resolve({ [Resource.release]() {} });
    const onItsNode = createInjectionKey('service', { factory: () => (current().acquire(make), {}) });
    const onAnother = createInjectionKey('other service', { factory: () => (root.acquire(make), {}) });
    expect(() => root.get(onItsNode)).toThrow(PendingNodeError);
    expect(() => root.get(onAnother)).toThrow(CreationViolationError);
    expect(() => root.acquire(undefined as never)).toThrow('acquire(make): make must be a function of the signal that creates the resource');
    expect(() => root.acquire(() => ({}), 'nope' as never)).toThrow('acquire(make, release): release must be a function');
    // @ts-expect-error -- a value with no release of its own needs one
    await expect(root.acquire(() => Promise.resolve({ id: 1 }))).rejects.toThrow('own(): value is not a Resource');
    const shared = { [Resource.release]() {} };
    expect(await root.acquire(() => shared)).toBe(shared);
    expect(await root.acquire(() => shared)).toBe(shared); // `own(x)` of an object the node owns is a no-op (D16)
    expect(entries(root)).toBe(1);
    await within(root.close());
  });
});
