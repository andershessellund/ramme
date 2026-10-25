// parent.test.ts — `parent` on value nodes, and the DI unit-of-work idiom it enables (D33, DESIGN.md §2.1,
// §2.6, §3.1, §3.3). The structural cases (roots, children, release fibers, pending nodes, completion) are in
// node-core.test.ts.
//
// The idiom: a UnitOfWork declared `static readonly scope = RequestScope` is stored on the request's fiber, so its
// release reads the request's outcome through `#node.parent` and commits or rolls back. Its lease is taken from a
// pool with a synchronous `acquire()` and owned by the value's node, below the commit entry (LIFO).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey } from './context-key.js';
import type { Context, Instruction, Op } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { inject } from './inject.js';
import { valueProvider } from './provider-util.js';
import { NotOwnedError, PendingNodeError } from './resource.js';
import { RequestScope } from './scope.js';
import { current, fork, lookup, never, own, release, signal, wait } from './ambient.js';
import { tick, trace } from './test/util.js';
import type { Trace } from './test/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The test's record of queries, commits, rollbacks and returned leases; provided at each root. */
const Log = createInjectionKey<Trace>('Log');

class Conn {
  readonly #log = inject(Log);
  query(sql: string, s: AbortSignal): void {
    this.#log.push(`query ${sql}${s.aborted ? ' (aborted)' : ''}`);
  }
}

/** A lease is an entry on its owner: disposing it returns the connection. */
class Lease {
  held = true;
  constructor(
    readonly conn: Conn,
    readonly log: Trace,
  ) {}
  [Symbol.dispose](): void {
    this.held = false;
    this.log.push('lease returned');
  }
}

/** The pool hands out a lease synchronously and attaches it to `owner` before returning (DESIGN.md §2.6). */
class DbPool {
  readonly #log = inject(Log);
  readonly #conn = inject(Conn);
  acquire(owner: Context = current()): Lease {
    const lease = new Lease(this.#conn, this.#log);
    owner.own(lease);
    return lease;
  }
}

/** DESIGN.md §2.6's idiom, as written there. */
class UnitOfWork {
  static readonly scope = RequestScope;
  readonly #log = inject(Log);
  readonly #node = current(); // this value's node; declared placement, so #node.parent is already the request node
  readonly #lease = inject(DbPool).acquire(); // owned by this value's node; released after the release below (LIFO)
  constructor() {
    own(this, () => {
      const o = this.#node.parent!.outcome; // the request's outcome: fixed before its provided stack is released
      if (o === undefined) return this.#node.signal.aborted ? this.rollback() : this.commit(); // done(), or this node aborted early (G1)
      return o.status === 'success' ? this.commit() : this.rollback();
    });
  }
  /** Commit now, while the request still runs: `yield* uow.done()`. */
  done(): Op<void> {
    return this.#node.release(this);
  }
  query(sql: string): void {
    return this.#lease.conn.query(sql, signal());
  }
  get leaseHeld(): boolean {
    return this.#lease.held;
  }
  async commit(): Promise<void> {
    await tick(); // a real asynchronous commit: the lease must still be held when it ends (LIFO)
    this.#log.push(`commit${this.#lease.held ? '' : ' (lease already returned)'}`);
  }
  async rollback(): Promise<void> {
    await tick();
    this.#log.push(`rollback${this.#lease.held ? '' : ' (lease already returned)'}`);
  }
}

/** A root whose Log is `t`. */
function app(t: Trace): Context {
  return createRootContext({ providers: [valueProvider(Log, t)] });
}

/** The request fiber carries RequestScope, so its outcome is the request's result (the idiom's precondition). */
function request<T>(body: () => Generator<Instruction, T, unknown>) {
  return task(body, { name: 'request', scopes: [RequestScope] });
}

describe('a value node’s parent is its storage node (DESIGN.md §3.3, D33)', () => {
  it('auto-hoisted: the node of its deepest dependency', async () => {
    const A = createInjectionKey<number>('A');
    class B {
      readonly a = inject(A);
      readonly node = current();
    }
    const root = createRootContext();
    const mid = root.child({ name: 'mid', providers: [valueProvider(A, 1)] });
    const leaf = mid.child({ name: 'leaf' });
    const b = leaf.get(B);
    expect(b.node.parent).toBe(mid);
    await root.close();
  });

  it('declared scope: the scope node, which its factory already reads as current().parent (D27)', async () => {
    let inFactory: { parent: Context | undefined; state: string } | undefined;
    class PerRequest {
      static readonly scope = RequestScope;
      readonly node = current();
      constructor() {
        inFactory = { parent: this.node.parent, state: this.node.state }; // live on S from its first use: never pending
      }
    }
    const root = createRootContext();
    let req: Context | undefined;
    const v = await root.call(
      request(function* () {
        req = current();
        return lookup(PerRequest);
      }),
    );
    expect(inFactory).toEqual({ parent: req, state: 'running' });
    expect(v.node.parent).toBe(req);
    await root.close();
  });

  it('after a failed factory, the node it was placed at to be released: the requester', async () => {
    let n: Context | undefined;
    const K = createInjectionKey<object>('K', {
      factory: () => {
        n = current();
        own(() => {}); // something to release
        throw new Error('factory failed');
      },
    });
    const root = createRootContext();
    const requester = root.child({ name: 'requester' });
    expect(() => requester.get(K)).toThrow('factory failed');
    expect(n!.state).toBe('complete');
    expect(n!.parent).toBe(requester);
    await root.close();
  });

  it('undefined for a value node released unowned after its factory completed the whole tree', async () => {
    let n: Context | undefined;
    const root = createRootContext();
    const K = createInjectionKey<object>('K', {
      factory: () => {
        n = current(); // pending
        root.abort(); // completes the whole tree: no open node is left to own the value's node
        return {};
      },
    });
    expect(() => root.get(K)).toThrow();
    expect(root.state).toBe('complete');
    expect(n!.state).toBe('complete');
    expect(n!.parent).toBeUndefined();
  });

  it('an auto-hoisted factory cannot read its placement: parent is PendingNodeError in it', async () => {
    let refused: unknown;
    class Hoisted {
      constructor() {
        try {
          void current().parent;
        } catch (e) {
          refused = e;
        }
      }
    }
    const root = createRootContext();
    root.get(Hoisted);
    expect(refused).toBeInstanceOf(PendingNodeError);
    await root.close();
  });
});

describe('the unit-of-work idiom under a request fiber (DESIGN.md §2.6, D33)', () => {
  it('commits on success; the lease is returned after the commit (LIFO)', async () => {
    const t = trace();
    const root = app(t);
    await root.call(
      request(function* () {
        lookup(UnitOfWork).query('insert');
      }),
    );
    expect(t.log).toEqual(['query insert', 'commit', 'lease returned']);
    await root.close();
  });

  it('rolls back on failure', async () => {
    const t = trace();
    const root = app(t);
    await expect(
      root.call(
        request(function* () {
          lookup(UnitOfWork).query('insert');
          throw new Error('handler failed');
        }),
      ),
    ).rejects.toThrow('handler failed');
    expect(t.log).toEqual(['query insert', 'rollback', 'lease returned']);
    await root.close();
  });

  it('rolls back on abort of the request', async () => {
    const t = trace();
    const root = app(t);
    const f = root.fork(
      request(function* () {
        lookup(UnitOfWork).query('insert');
        yield* never();
      }).with({ onFailure: () => {} }),
    );
    await tick();
    f.abort();
    expect((await root.result(f)).status).toBe('aborted');
    expect(t.log).toEqual(['query insert', 'rollback', 'lease returned']);
    await root.close();
  });

  it('await uow.done() commits while the request runs and keeps the lease until it ends; a free release(uow) is NotOwnedError', async () => {
    const t = trace();
    const root = app(t);
    await root.call(
      request(function* () {
        const uow = lookup(UnitOfWork);
        uow.query('insert');
        // The entry is on the value's node, not on the request's (C7).
        expect(() => release(uow)).toThrow(NotOwnedError);
        yield* uow.done();
        t.push(`after done, lease ${uow.leaseHeld ? 'held' : 'returned'}`);
        uow.query('select');
      }),
    );
    expect(t.log).toEqual(['query insert', 'commit', 'after done, lease held', 'query select', 'lease returned']);
    await root.close();
  });

  it('an owned fiber of the unit of work that fails while the request runs aborts its node, and it rolls back (G1)', async () => {
    const t = trace();
    const root = app(t);
    const heartbeat = new Error('heartbeat failed');
    class WatchedUnitOfWork extends UnitOfWork {
      // Inherits RequestScope (D32). An owned fiber's failure aborts its owner, the value's node (C5).
      readonly #watch = own(
        fork(function* () {
          throw heartbeat;
        }),
      );
    }
    await expect(
      root.call(
        request(function* () {
          lookup(WatchedUnitOfWork).query('insert');
          yield* wait(tick(3));
          t.push('request still running');
        }),
      ),
    ).rejects.toBe(heartbeat); // the value node's failure surfaces from the request's completion (DESIGN.md §4.12)
    expect(t.log).toEqual(['query insert', 'rollback', 'lease returned', 'request still running']);
    await root.close();
  });
});

describe('the caveat: a bodiless child({ scopes: [RequestScope] }) reports how it was ended (DESIGN.md §3.1, §4.12)', () => {
  it('disposed with await using after a successful req.call(...), it rolls back', async () => {
    const t = trace();
    const root = app(t);
    {
      await using req = root.child({ name: 'req', scopes: [RequestScope] });
      await req.call(function* () {
        lookup(UnitOfWork).query('insert');
      });
    } // [Symbol.asyncDispose]() aborts first (DESIGN.md §2.7): the node's outcome is aborted
    expect(t.log).toEqual(['query insert', 'rollback', 'lease returned']);
    await root.close();
  });

  it('closed after a failed and caught req.call(...), it commits', async () => {
    const t = trace();
    const root = app(t);
    const req = root.child({ name: 'req', scopes: [RequestScope] });
    await expect(
      req.call(function* () {
        lookup(UnitOfWork).query('insert');
        throw new Error('caught by the caller');
      }),
    ).rejects.toThrow('caught by the caller');
    await req.close(); // a bodiless node closed is success, whatever its calls did
    expect(t.log).toEqual(['query insert', 'commit', 'lease returned']);
    await root.close();
  });
});
