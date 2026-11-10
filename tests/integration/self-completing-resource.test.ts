// README's 'Resources': a resource that can finish on its own is a node (DESIGN.md §2.6, D47). `Connection` is the
// README's class: it opens a node of its own with `owner.own(owner.child())`, an unsubscribed entry on the owner it is
// handed (D48), owns itself there as a native `Resource`, and closes that node when its socket reports that the peer
// hung up. A node that
// completes leaves its owner's stack (DESIGN.md §2.4), so a long-lived owner keeps no entry for a connection that is
// gone, with no protocol beyond the tree's: its cleanup ran in release fibers of its own node, a later `close()` is a
// no-op (DESIGN.md §2.7), and a cleanup failure nobody waited for surfaces from its owner (DESIGN.md §4.12).
import { describe, expect, it } from 'vitest';
import { child, current, own, sleep, wait } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { listen } from '../../src/platform.js';
import { Resource } from '../../src/resource.js';
import { deferred, impl, tick, trace, within } from '../support/util.js';
import type { Trace } from '../support/util.js';

/** A transport: `end()` closes it (a second `end()` of a closed one is harmless), and `close` says the peer did. */
class FakeSocket extends EventTarget {
  ends = 0;
  /** When set, `end()` waits for it. */
  gate: PromiseWithResolvers<void> | undefined;
  /** When set, `end()` rejects with it. */
  failure: unknown;
  constructor(readonly log: Trace) {
    super();
  }
  end(): Promise<void> {
    this.ends++;
    this.log.push('socket ended');
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return this.gate?.promise ?? Promise.resolve();
  }
  hangUp(): void {
    this.dispatchEvent(new Event('close'));
  }
}

/** README's `Connection`, verbatim but for its socket's type. */
class Connection implements Resource {
  readonly #node: Context;
  constructor(
    owner: Context,
    readonly socket: FakeSocket,
  ) {
    this.#node = owner.own(owner.child({ name: 'connection' })); // a lifetime of its own, below its owner
    this.#node.own(this); // released by [Resource.release] when the node ends
    this.#node.run(() => listen(socket, 'close', () => void this.#node.close())); // the peer hung up: the node ends now
  }
  *[Resource.release]() {
    yield* wait(this.socket.end());
  }
  close() {
    return this.#node.close(); // early: yield* connection.close()
  }
}

describe('a resource that can finish on its own is a node: owner.own(owner.child())', () => {
  it('it is released at its turn in its owner’s release order, after what was attached later and may still use it', async () => {
    const t = trace();
    const root = createRootContext();
    await within(
      root.call(function* () {
        own(t.at('attached before'));
        new Connection(current(), new FakeSocket(t));
        own(t.at('uses the connection'));
        yield* sleep(0);
      }),
    );
    expect(t.log).toEqual(['uses the connection', 'socket ended', 'attached before']);
    await within(root.close());
  });

  it('a subscribed child() is no resource: a body’s exit releases it first, before entries attached after it', async () => {
    const t = trace();
    const root = createRootContext();
    await within(
      root.call(function* () {
        child({ name: 'scope' }).own(t.at('scope'));
        own(t.at('attached after the scope'));
        yield* sleep(0);
      }),
    );
    expect(t.log).toEqual(['scope', 'attached after the scope']);
    await within(root.close());
  });

  it('when the peer hangs up it is released and leaves its owner’s stack; the owner’s exit releases nothing again', async () => {
    const t = trace();
    const root = createRootContext();
    const socket = new FakeSocket(t);
    const entries: number[] = [];
    await within(
      root.call(function* () {
        const owner = impl(current());
        const connection = new Connection(current(), socket);
        entries.push(owner.explicit.size);
        socket.hangUp(); // a platform callback: no body waits for the close it starts
        yield* sleep(0);
        entries.push(owner.explicit.size);
        yield* connection.close(); // the body's own close, after the fact: a no-op on a complete node
        socket.hangUp(); // the listener went with the node
        t.push('body goes on');
      }),
    );
    expect(entries).toEqual([1, 0]);
    expect(t.log).toEqual(['socket ended', 'body goes on']);
    expect(socket.ends).toBe(1);
    await within(root.close());
    expect(socket.ends).toBe(1);
  });

  it('closed early by its owner, a later close event from the peer does nothing', async () => {
    const t = trace();
    const root = createRootContext();
    const socket = new FakeSocket(t);
    await within(
      root.call(function* () {
        const connection = new Connection(current(), socket);
        yield* connection.close();
        t.push('closed');
        socket.hangUp();
        yield* sleep(0);
      }),
    );
    expect(t.log).toEqual(['socket ended', 'closed']);
    await within(root.close());
  });

  it('an interrupted owner waits for the connection’s release, which its interruption does not cut', async () => {
    const t = trace();
    const root = createRootContext();
    const socket = new FakeSocket(t);
    socket.gate = deferred();
    const session = root.child({ name: 'session' });
    new Connection(session, socket); // a function that creates a resource takes its owner: no node need be current
    session.abort();
    const closed = session.close().then(() => t.push('session complete'));
    await tick();
    expect(session.state).toBe('releasing');
    expect(t.log).toEqual(['socket ended']);
    socket.gate.resolve();
    await within(closed);
    expect(t.log).toEqual(['socket ended', 'session complete']);
    await within(root.close());
  });

  it('a release failure of a connection that closed by itself surfaces from its owner once; one that is waited for goes to its awaiter', async () => {
    const t = trace();
    const failure = new Error('the socket would not close');
    const root = createRootContext();
    const unawaited = await within(
      root.attempt(function* () {
        const socket = new FakeSocket(t);
        socket.failure = failure;
        new Connection(current(), socket);
        socket.hangUp();
        yield* sleep(0);
        return 'done';
      }),
    );
    expect(unawaited).toEqual({ status: 'defect', error: failure });
    const awaited = await within(
      root.attempt(function* () {
        const socket = new FakeSocket(t);
        socket.failure = failure;
        const connection = new Connection(current(), socket);
        try {
          yield* connection.close();
        } catch (e) {
          return e;
        }
        return 'no failure';
      }),
    );
    expect(awaited).toEqual({ status: 'success', value: failure });
    await within(root.close());
    expect(root.outcome?.status).toBe('success');
  });
});
