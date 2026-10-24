// request-example.test.ts — the request of README.md 'A request', end to
// end. The handler is the README's request handler verbatim (its unused `res`
// parameter is spelled `_res` for the lint rule); `Pool` is a class key whose
// default factory has an owned reaper; `work(req)` is a plain function that `lookup`s
// `Conn`; a fake server delivers its callbacks with no current node, and the
// one place a node is named is `app.fork(...)` there (line 4). Each root is
// created under `await using` and each test body runs as a top-level
// `await app.call(main)`.
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import './node.js';
import { call, current, fork, lookup, managed, own, result, signal } from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context, Fiber } from './context.js';
import { task } from './fiber.js';
import type { NodeImpl } from './node-impl.js';
import { valueProvider } from './provider-util.js';
import { FiberAbortedError, NoCurrentNodeError, PoolClosedError, UnawaitedCallError } from './resource.js';
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

/** Resolves after `ms`, or as soon as `s` aborts; the timer never holds the process. */
function sleep(ms: number, s: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
    s.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * A platform event source. Its callbacks run in the async context the server
 * was created in, as an `EventEmitterAsyncResource` would run them: the test's
 * top level, where no node is current.
 */
class FakeServer {
  readonly #platform = AsyncLocalStorage.snapshot();
  readonly #listeners: ((req: Req, res: Res) => Fiber<unknown>)[] = [];

  on(_event: 'request', cb: (req: Req, res: Res) => Fiber<unknown>): void {
    this.#listeners.push(cb);
  }

  /** A request arrives; returns what the listener returned (the handler's fiber) and a way to hang up. */
  request(url: string): { req: Req; res: Res; fiber: Fiber<unknown>; hangUp: (reason: unknown) => void } {
    const ac = new AbortController();
    const req: Req = { url, signal: ac.signal };
    const res: Res = { status: 0 };
    const fiber = this.#platform(() => this.#listeners[0](req, res));
    return { req, res, fiber, hangUp: (reason) => this.#platform(() => ac.abort(reason)) };
  }

  /** Run `fn` as a platform callback (a signal handler, a socket event). */
  later(fn: () => void): void {
    this.#platform(fn);
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
    readonly #conns = own(new Connections(), async (conns) => {
      this.#closed = true; // stop intake
      await this.#drained(signal()); // the release fiber's deadline
      t.push('pool');
      conns.closeAll();
    });
    constructor() {
      own(fork(() => this.#reap())); // owned reaper, starts after placement
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

    async #reap(): Promise<void> {
      own(() => t.push('reaper'));
      for (;;) await managed(sleep(60_000, signal())); // evicts idle connections (elided)
    }
  }

  let workImpl: (req: Req) => Promise<string> = async (req) => {
    const conn = lookup(Conn); // a borrow for the call's node
    return conn.query(req.url, signal());
  };
  /** A plain function: it runs in the caller's node, the call child of line 3. */
  function work(req: Req): Promise<string> {
    return workImpl(req);
  }

  // The README's request handler, verbatim.
  const handle = task(async (req: Req, _res: Res) => {
    const pool = lookup(Pool); // 1
    const lease = own(await pool.acquire()); // 2
    return call(task(() => work(req), { providers: [valueProvider(Conn, lease.conn)] })); // 3
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
    setWork(fn: (req: Req) => Promise<string>) {
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
      await app.call(async () => {
        const a = server.request('/a');
        const b = server.request('/b');
        await w.inFlight('/a');
        await w.inFlight('/b');
        w.reply('/a', 'A');
        w.reply('/b', 'B');
        expect(await result(a.fiber)).toEqual({ status: 'success', value: 'A' });
        expect(await result(b.fiber)).toEqual({ status: 'success', value: 'B' });
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

  it('(2) the handler is lent during call: fork through its node from inside work throws UnawaitedCallError naming the call child; own(await pool.acquire()) registers one entry', async () => {
    const w = world();
    const { ev, server } = w.app();
    let lentError: unknown;
    let callChild: Context | undefined;
    let handler: NodeImpl | undefined;
    w.setWork(async () => {
      callChild = current();
      handler = impl(callChild).parent; // the handler's fiber: it lent itself to this call (DESIGN.md §4.9)
      expect(handler?.lentTo).toBe(impl(callChild));
      try {
        handler!.fork(async () => {});
      } catch (e) {
        lentError = e;
      }
      return 'ok';
    });
    {
      await using app = ev.root;
      await app.call(async () => {
        const r = server.request('/a');
        expect(await result(r.fiber)).toEqual({ status: 'success', value: 'ok' });
      });
    }
    expect(lentError).toBeInstanceOf(UnawaitedCallError);
    expect((lentError as UnawaitedCallError).child).toBe(callChild);
    expect(String((lentError as Error).message)).toMatch(/lent to/);
    // D16: acquire() attached the lease to the handler; own(lease) with one argument is a no-op by identity.
    const lease = w.acquired[0].lease;
    expect(w.acquired[0].owner).toBe(handler);
    const registered = ev.of('entry:registered').filter((e) => e.id === handler!.id && e.entryName === 'Lease');
    expect(registered).toHaveLength(1);
    expect(ev.of('entry:released').filter((e) => e.id === handler!.id && e.entryName === 'Lease')).toHaveLength(1);
    expect(w.t.log.filter((x) => x === 'lease')).toHaveLength(1);
    expect(lease.conn).toBeDefined();
  });

  it('(3) aborting req.signal rejects the handler at its managed await, releases the lease back to the pool after the handler unwound, calls no onFailure, and app.close() surfaces nothing', async () => {
    const w = world();
    const { ev, server } = w.app();
    let handlerId = -1;
    {
      await using app = ev.root;
      await app.call(async () => {
        const r = server.request('/a');
        handlerId = r.fiber.id;
        await w.inFlight('/a');
        const pool = w.acquired[0].pool;
        expect(pool.free).toHaveLength(0);
        r.hangUp(new Error('client went away'));
        const o = await result(r.fiber);
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
    w.setWork(async () => {
      throw boom;
    });
    let res: Res | undefined;
    {
      await using app = ev.root;
      await app.call(async () => {
        const r = server.request('/a');
        res = r.res;
        const o = await result(r.fiber);
        expect(o).toEqual({ status: 'failure', error: boom });
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
      await app.call(async () => {
        handlers.push(server.request('/a').fiber, server.request('/b').fiber);
        await w.inFlight('/a');
        await w.inFlight('/b');
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
      const main = task(async () => {
        mainId = current().id;
        handler = server.request('/a').fiber;
        await w.inFlight('/a');
        server.later(() => app.abort('SIGTERM')); // no current node there
        await result(handler); // managed: rejected here with InterruptedError, which ends main
        resumed = true; // recorded, not thrown: a delivered freeze body is aborted whatever it does (I13)
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
    expect(resumed).toBe(false); // main's managed await rejected (DESIGN.md §4.2), and the rejection unwound it (I6)
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

  it('the server callback runs with no current node, even when it is triggered from inside a body: line 4 is the one place a node is named', async () => {
    const w = world();
    const { ev, server } = w.app();
    let seen: unknown;
    let main: Context | undefined;
    let after: Context | undefined;
    let handlerParent: NodeImpl | undefined;
    {
      await using app = ev.root;
      await app.call(async () => {
        main = current();
        server.later(() => {
          try {
            seen = current();
          } catch (e) {
            seen = e;
          }
        });
        after = current();
        // the listener runs in the platform's context too, and names the app itself (line 4)
        const r = server.request('/a');
        handlerParent = impl(r.fiber).parent;
        await w.inFlight('/a');
        w.reply('/a', 'A');
        await result(r.fiber);
      });
      expect(handlerParent).toBe(impl(app));
    }
    expect(seen).toBeInstanceOf(NoCurrentNodeError); // not main: the callback does not inherit the caller's frame
    expect(main).toBeDefined();
    expect(impl(main!).kind).toBe('fiber');
    expect(after).toBe(main);
  });
});
