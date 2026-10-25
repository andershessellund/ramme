// request-example.test.ts — the request of README.md 'A request', end to
// end. The handler is the README's request handler verbatim (its unused `res`
// parameter is spelled `_res` for the lint rule); `Pool` is a class key whose
// default factory has an owned reaper; `work(req)` is a generator helper that
// `lookup`s `Conn`; a fake server delivers its request callback to the listener
// and its other callbacks in a later job, with no current node, and the one
// place a node is named is `app.fork(...)` there (line 4). Each root is created
// under `await using` and each test body runs as a top-level
// `await app.call(main)`.
import { describe, expect, it } from 'vitest';
import { call, current, fork, join, lookup, own, result, signal, sleep, wait } from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber, Instruction } from './context.js';
import { task } from './fiber.js';
import type { NodeImpl } from './node-impl.js';
import { valueProvider } from './provider-util.js';
import { FiberAbortedError, NoCurrentNodeError, PoolClosedError } from './resource.js';
import { deferred, events, impl, tick, trace, within } from './test/util.js';
import type { EventLog, Trace } from './test/util.js';

interface Req {
  readonly url: string;
  readonly signal: AbortSignal;
}
interface Res {
  status: number;
  error?: unknown;
}

/**
 * A platform event source. A request is handed to the listener at once, so a test can read the handler's fiber;
 * its other callbacks (a signal handler, a socket event) run in a later job, as a platform's do, where no node is
 * current: the current node is a synchronous slot, set only while a body steps (DESIGN.md §6).
 */
class FakeServer {
  readonly #listeners: ((req: Req, res: Res) => Fiber<unknown>)[] = [];

  on(_event: 'request', cb: (req: Req, res: Res) => Fiber<unknown>): void {
    this.#listeners.push(cb);
  }

  /** A request arrives; returns what the listener returned (the handler's fiber) and a way to hang up. */
  request(url: string): { req: Req; res: Res; fiber: Fiber<unknown>; hangUp: (reason: unknown) => void } {
    const ac = new AbortController();
    const req: Req = { url, signal: ac.signal };
    const res: Res = { status: 0 };
    const fiber = this.#listeners[0](req, res);
    return { req, res, fiber, hangUp: (reason) => ac.abort(reason) };
  }

  /** Run `fn` as a platform callback: in a later job, after the step that asked for it has returned. */
  later(fn: () => void): void {
    queueMicrotask(fn);
  }
}

/** Everything the README's request example names, fresh per test (the class keys included). */
function world() {
  const t: Trace = trace();
  const pending = new Map<string, PromiseWithResolvers<string>>();
  const acquired: { pool: Pool; owner: Context; lease: Lease }[] = [];
  const failures: { error: unknown; current: Context }[] = [];
  let opened = 0;

  class Connection {
    constructor(readonly id: number) {}
    /** Answers when the test replies, or rejects with the signal's reason when it aborts. */
    query(url: string, s: AbortSignal): Promise<string> {
      const d = deferred<string>();
      pending.set(url, d);
      s.addEventListener('abort', () => d.reject(s.reason), { once: true });
      return d.promise;
    }
  }
  const Conn = createInjectionKey<Connection>('Conn');

  /** What acquire() returns: a handle whose release() goes through the owner (DESIGN.md §2.6, I23). */
  class Lease implements Disposable {
    readonly #owner: Context;
    readonly #give: (lease: Lease) => void;
    constructor(
      readonly conn: Connection,
      owner: Context,
      give: (lease: Lease) => void,
    ) {
      this.#owner = owner;
      this.#give = give;
    }
    release(): Promise<void> {
      return this.#owner.release(this);
    }
    [Symbol.dispose](): void {
      this.#give(this);
    }
  }

  class Connections {
    readonly all: Connection[] = [];
    closeAll(): void {
      this.all.length = 0;
    }
  }

  /** The Pool service: a DI value owning its connections, with an owned reaper; borrowers own leases. */
  class Pool {
    readonly #ctx: Context = current(); // the pending node, placed with the value
    #closed = false;
    #inUse = 0;
    #idle: (() => void) | undefined;
    readonly free: Connection[] = [];
    readonly #conns = own(new Connections(), (conns) => this.#close(conns)); // a generator release, driven in its release fiber
    constructor() {
      own(fork(() => this.#reap())); // owned reaper, starts after placement
    }

    *#close(conns: Connections): Generator<Instruction, void, unknown> {
      this.#closed = true; // stop intake
      yield* wait(this.#drained(signal())); // the release fiber's deadline
      t.push('pool');
      conns.closeAll();
    }

    /** The pool's own node (`#ctx`). */
    get node(): Context {
      return this.#ctx;
    }

    acquire(owner: Context = current()): Promise<Lease> {
      if (this.#closed) throw new PoolClosedError('pool is closed');
      const conn = this.free.pop() ?? this.#open();
      this.#inUse++;
      const lease = new Lease(conn, owner, (l) => this.#return(l.conn));
      owner.own(lease); // attached before the promise resolves: no moment without an owner
      acquired.push({ pool: this, owner, lease });
      return Promise.resolve(lease); // bare promise; no finally
    }

    #open(): Connection {
      const c = new Connection(++opened);
      this.#conns.all.push(c);
      return c;
    }

    #return(conn: Connection): void {
      t.push('lease');
      this.#inUse--;
      this.free.push(conn);
      if (this.#inUse === 0) this.#idle?.();
    }

    #drained(s: AbortSignal): Promise<void> {
      if (this.#inUse === 0) return Promise.resolve();
      return new Promise((resolve) => {
        this.#idle = resolve;
        s.addEventListener('abort', () => resolve(), { once: true });
      });
    }

    *#reap(): Generator<Instruction, never, unknown> {
      own(() => t.push('reaper'));
      for (;;) yield* sleep(60_000); // evicts idle connections (elided); the halt clears the timer
    }
  }

  let workImpl: (req: Req) => Generator<Instruction, string, unknown> = function* (req) {
    const conn = lookup(Conn); // a borrow for the call's node
    return yield* wait(conn.query(req.url, signal()));
  };
  /** A generator helper: the body of the call of line 3, so it runs in the call's node. */
  function* work(req: Req): Generator<Instruction, string, unknown> {
    return yield* workImpl(req);
  }

  // The README's request handler, verbatim.
  const handle = task(function* (req: Req, _res: Res) {
    const pool = lookup(Pool); // 1
    const lease = own(yield* wait(pool.acquire())); // 2
    return yield* call(task(() => work(req), { providers: [valueProvider(Conn, lease.conn)] })); // 3
  });

  function respond500(res: Res, e: unknown): void {
    res.status = 500;
    res.error = e;
    failures.push({ error: e, current: current() });
  }

  /** The application: a root with a NodeTopic receiver, and a server whose callback names it (line 4). */
  function app(): { ev: EventLog; server: FakeServer } {
    const ev = events({ name: 'app' });
    const server = new FakeServer();
    const appNode = ev.root;
    server.on('request', (req, res) =>
      appNode.fork(handle.with({ name: req.url, signal: req.signal, onFailure: (e) => respond500(res, e) }), req, res), // 4
    );
    return { ev, server };
  }

  /** Wait (bare) until the query for `url` is in flight. */
  async function inFlight(url: string): Promise<void> {
    for (let i = 0; i < 50 && !pending.has(url); i++) await tick();
    expect(pending.has(url), `query ${url} in flight`).toBe(true);
  }

  return {
    t,
    Pool,
    Lease,
    acquired,
    failures,
    pending,
    app,
    inFlight,
    setWork(fn: (req: Req) => Generator<Instruction, string, unknown>) {
      workImpl = fn;
    },
    reply(url: string, value: string) {
      pending.get(url)!.resolve(value);
    },
  };
}

describe('a request, end to end', () => {
  it('(1) Pool lands on the root’s provided stack (its only dependency is its own node), its reaper starts after placement, and a second handler gets the same instance', async () => {
    const w = world();
    const { ev, server } = w.app();
    let poolNode: NodeImpl | undefined;
    {
      await using app = ev.root;
      await app.call(function* () {
        const a = server.request('/a');
        const b = server.request('/b');
        yield* wait(w.inFlight('/a'));
        yield* wait(w.inFlight('/b'));
        w.reply('/a', 'A');
        w.reply('/b', 'B');
        expect(yield* result(a.fiber)).toEqual({ status: 'success', value: 'A' });
        expect(yield* result(b.fiber)).toEqual({ status: 'success', value: 'B' });
      });
      const root = impl(app);
      expect([...root.provided].map((e) => e.name)).toEqual(['Pool']);
      poolNode = [...root.provided][0].node!;
      expect(poolNode.kind).toBe('value');
      const cached = root.cache.get(w.Pool)!;
      expect(cached.autoHoisted).toBe(true);
      expect(cached.valueNode).toBe(poolNode);
      expect([...cached.deps!]).toEqual([]); // current() (= inject(ContextKey)) is excluded from tracking (DESIGN.md §3.3)
      expect((cached.value as InstanceType<typeof w.Pool>).node).toBe(poolNode);
      // lookup(Pool) from the second handler returned the same instance
      expect(w.acquired).toHaveLength(2);
      expect(w.acquired[0].pool).toBe(w.acquired[1].pool);
      expect(w.acquired[0].owner).not.toBe(w.acquired[1].owner);
      expect(w.acquired.map((x) => x.owner.name)).toEqual(['/a', '/b']);
    }
    const placed = ev.of('node:placed').find((e) => e.id === poolNode!.id)!;
    expect(placed.storageId).toBe(ev.root.id);
    const reaper = ev.of('node:created').find((e) => e.parentId === poolNode!.id && e.kind === 'fiber')!;
    const started = ev.of('node:started').find((e) => e.id === reaper.id)!;
    expect(started.seq).toBeGreaterThan(placed.seq); // the constructor's fork starts after placement (DESIGN.md §4.6)
    expect(ev.of('node:started').filter((e) => e.id === reaper.id)).toHaveLength(1);
  });

  it('(2) work runs in the call’s node, a child of the handler, which nothing lends: it may fork through the handler’s node; own(yield* wait(pool.acquire())) registers one entry', async () => {
    const w = world();
    const { ev, server } = w.app();
    let forked: Fiber<string> | undefined;
    let callChild: Context | undefined;
    let handler: NodeImpl | undefined;
    w.setWork(function* () {
      callChild = current();
      handler = impl(callChild).parent; // the handler's fiber
      forked = handler!.fork(function* () {
        return 'forked through the handler';
      });
      return 'ok';
    });
    {
      await using app = ev.root;
      await app.call(function* () {
        const r = server.request('/a');
        expect(yield* result(r.fiber)).toEqual({ status: 'success', value: 'ok' });
      });
    }
    expect(forked?.outcome).toEqual({ status: 'success', value: 'forked through the handler' });
    expect(impl(forked!).parent).toBe(handler);
    // D16: acquire() attached the lease to the handler; own(lease) with one argument is a no-op by identity.
    const lease = w.acquired[0].lease;
    expect(w.acquired[0].owner).toBe(handler);
    const registered = ev.of('entry:registered').filter((e) => e.id === handler!.id && e.entryName === 'Lease');
    expect(registered).toHaveLength(1);
    expect(ev.of('entry:released').filter((e) => e.id === handler!.id && e.entryName === 'Lease')).toHaveLength(1);
    expect(w.t.log.filter((x) => x === 'lease')).toHaveLength(1);
    expect(lease.conn).toBeDefined();
  });

  it('(3) aborting req.signal halts the handler once its call has stopped, releases the lease back to the pool after the handler unwound, calls no onFailure, and app.close() surfaces nothing', async () => {
    const w = world();
    const { ev, server } = w.app();
    let handlerId = -1;
    {
      await using app = ev.root;
      await app.call(function* () {
        const r = server.request('/a');
        handlerId = r.fiber.id;
        yield* wait(w.inFlight('/a'));
        const pool = w.acquired[0].pool;
        expect(pool.free).toHaveLength(0);
        r.hangUp(new Error('client went away'));
        const o = yield* result(r.fiber);
        expect(o.status).toBe('aborted');
        expect(pool.free).toHaveLength(1); // the lease went back
        expect(r.res.status).toBe(0);
      });
      await expect(app.close()).resolves.toBeUndefined();
    }
    expect(ev.of('node:settled').filter((e) => e.id === handlerId).map((e) => e.outcome)).toEqual(['aborted']);
    expect(w.failures).toEqual([]); // I12: aborted is not failure
    expect(w.t.log).toEqual(['lease', 'reaper', 'pool']);
  });

  it('(4) a work that throws calls onFailure once with the error, with app current, and app.close() surfaces nothing', async () => {
    const w = world();
    const { ev, server } = w.app();
    const boom = new Error('boom');
    w.setWork(function* () {
      throw boom;
    });
    let res: Res | undefined;
    {
      await using app = ev.root;
      await app.call(function* () {
        const r = server.request('/a');
        res = r.res;
        const o = yield* result(r.fiber);
        expect(o).toEqual({ status: 'defect', error: boom });
      });
      await expect(app.close()).resolves.toBeUndefined(); // the handler consumed it
      expect(w.failures).toHaveLength(1);
      expect(w.failures[0].error).toBe(boom);
      expect(w.failures[0].current).toBe(app); // the handler runs with the parent current (DESIGN.md §4.7)
    }
    expect(res?.status).toBe(500);
    expect(w.t.log).toEqual(['lease', 'reaper', 'pool']);
  });

  it('(5) app.close() releases the pool’s node last: every lease-holder completed before the pool (G1)', async () => {
    const w = world();
    const { ev, server } = w.app();
    const handlers: Fiber<unknown>[] = [];
    {
      await using app = ev.root;
      await app.call(function* () {
        handlers.push(server.request('/a').fiber, server.request('/b').fiber);
        yield* wait(w.inFlight('/a'));
        yield* wait(w.inFlight('/b'));
      }); // returns with both handlers still waiting on their queries
      const closing = app.close(); // a close waits for subscribers naturally (DESIGN.md §2.7)
      await tick();
      expect(w.t.log).toEqual([]);
      w.reply('/b', 'B');
      w.reply('/a', 'A');
      await within(closing);
    }
    expect(handlers.map((h) => h.outcome)).toEqual([
      { status: 'success', value: 'A' },
      { status: 'success', value: 'B' },
    ]);
    expect(w.t.log).toEqual(['lease', 'lease', 'reaper', 'pool']);
    const poolNode = ev.of('node:created').find((e) => e.kind === 'value' && e.name === 'Pool')!;
    const completeSeq = (id: number) => ev.of('node:complete').find((e) => e.id === id)!.seq;
    for (const h of handlers) expect(completeSeq(h.id)).toBeLessThan(completeSeq(poolNode.id));
    expect(completeSeq(poolNode.id)).toBeLessThan(completeSeq(ev.root.id));
    const releasing = ev.of('node:releasing').filter((e) => e.id === ev.root.id);
    expect(releasing.map((e) => e.stack)).toEqual(['explicit', 'provided']);
  });

  it('(6) app.abort() from a platform callback with a handler still running rejects the top-level call with FiberAbortedError; the await using block completes and the lease was released (DESIGN.md §4.2)', async () => {
    const w = world();
    const { ev, server } = w.app();
    let caught: unknown;
    let handler: Fiber<unknown> | undefined;
    let mainId = -1;
    let resumed = false;
    const run = async (): Promise<void> => {
      await using app = ev.root;
      const main = task(function* () {
        mainId = current().id;
        handler = server.request('/a').fiber;
        yield* wait(w.inFlight('/a'));
        server.later(() => app.abort('SIGTERM')); // no current node there
        yield* join(handler); // a fiber not subscribed below main: halted here at once, which ends main
        resumed = true; // never reached: no code after a halted yield* runs
      });
      try {
        await app.call(main);
      } catch (e) {
        caught = e;
      }
      w.t.push('after call');
    };
    await within(run());
    w.t.push('after using');
    expect(resumed).toBe(false); // main was halted at its yield* (DESIGN.md §4.2, I6)
    expect(ev.of('node:settled').filter((e) => e.id === mainId).map((e) => e.outcome)).toEqual(['aborted']);
    expect(caught).toBeInstanceOf(FiberAbortedError);
    expect((caught as FiberAbortedError).reason).toBe('SIGTERM');
    expect(handler?.outcome).toEqual({ status: 'aborted', reason: 'SIGTERM' });
    expect(ev.root.state).toBe('complete');
    expect(w.acquired[0].pool.free).toHaveLength(1); // the handler's lease went back
    const log = w.t.log;
    expect(log.filter((x) => x !== 'after call')).toEqual(['lease', 'reaper', 'pool', 'after using']); // G1: the lease before the pool
    expect(log).toContain('after call'); // the top-level call settled while the root was still releasing
    expect(log.at(-1)).toBe('after using');
    expect(w.failures).toEqual([]);
  });

  it('a platform callback runs with no current node, even when a body scheduled it: line 4 is the one place a node is named', async () => {
    const w = world();
    const { ev, server } = w.app();
    let seen: unknown;
    let main: Context | undefined;
    let after: Context | undefined;
    let handlerParent: NodeImpl | undefined;
    {
      await using app = ev.root;
      await app.call(function* () {
        main = current();
        const heard = deferred();
        server.later(() => {
          try {
            seen = current();
          } catch (e) {
            seen = e;
          }
          heard.resolve();
        });
        after = current();
        yield* wait(heard.promise); // the callback has run, from the event loop
        // the listener names the app itself (line 4), so its handler is the app's child wherever it was called
        const r = server.request('/a');
        handlerParent = impl(r.fiber).parent;
        yield* wait(w.inFlight('/a'));
        w.reply('/a', 'A');
        yield* join(r.fiber);
      });
      expect(handlerParent).toBe(impl(app));
    }
    expect(seen).toBeInstanceOf(NoCurrentNodeError); // not main: nothing carries the slot to a later callback
    expect(main).toBeDefined();
    expect(impl(main!).kind).toBe('fiber');
    expect(after).toBe(main);
  });
});
