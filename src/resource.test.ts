// Tests for the native release protocol (DESIGN.md §2.6, D47): `own(value)` of a value whose class defines
// `[Resource.release]()` is `own(value, (v) => v[Resource.release]())`. The method is the entry's release: it runs once,
// with the value as `this`, in a release fiber of the owner, and it is found under a symbol, so a member a class
// merely names `release` is nothing to `own`. A release has no expected failures; what it throws is the owner's defect.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { current, fail, never, own, release, signal, sleep, wait } from './ambient.js';
import { createInjectionKey } from './context-key.js';
import type { Context } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { FiberAbortedError, NotOwnedError, Resource } from './resource.js';
import { deferred, impl, tick, within } from '../tests/support/util.js';

afterEach(() => vi.restoreAllMocks());

describe('the native release protocol: own(resource) runs its [Resource.release]() (D47)', () => {
  it('the key is the registered symbol ramme.release, and Resource.release cannot be reassigned', () => {
    expect(Resource.release).toBe(Symbol.for('ramme.release'));
    expect(Object.isFrozen(Resource)).toBe(true);
  });

  it('a generator method runs once, with the value as this, in a release fiber of the owner that the owner’s interruption does not cut', async () => {
    const log: unknown[] = [];
    const root = createRootContext();
    class Connection implements Resource {
      readonly #name = 'connection';
      *[Resource.release]() {
        expect(impl(current()).kind).toBe('release');
        expect(current().parent).toBe(root);
        expect(signal().aborted).toBe(false); // the release deadline, not the owner's signal, which has fired
        own(() => void log.push('nested')); // attached to the release fiber: released when the release ends
        yield* wait(Promise.resolve());
        log.push(this.#name, impl(current()).kind); // the frame holds across the wait
      }
    }
    const resource = new Connection();
    expect(root.own(resource)).toBe(resource);
    expect(root.own(resource)).toBe(resource); // one argument on an object the node owns: a no-op (D16)
    expect(impl(root).explicit.size).toBe(1);
    root.abort();
    await within(root.close());
    expect(root.signal.aborted).toBe(true);
    expect(log).toEqual(['connection', 'release', 'nested']);
  });

  it('the method may be synchronous, return an op, or return a promise; an object literal is a resource too', async () => {
    const log: string[] = [];
    const flush = task(function* flush(what: string) {
      yield* sleep(0);
      log.push(`${what} in ${impl(current()).kind} under ${impl(current().parent!).kind}`);
    });
    const root = createRootContext();
    root.own({ [Resource.release]: () => void log.push('synchronous') });
    root.own({ [Resource.release]: () => flush('an op') }); // a task's call: a child of the release fiber, as any call
    root.own({ [Resource.release]: () => Promise.resolve().then(() => void log.push('a promise')) });
    root.own({
      *[Resource.release]() {
        yield* sleep(0);
        log.push('a generator');
      },
    });
    await within(root.close());
    expect(log).toEqual(['a generator', 'a promise', 'an op in fiber under release', 'synchronous']);
  });

  it('is taken before [Symbol.asyncDispose] and [Symbol.dispose], which a class may keep for using outside ramme', async () => {
    const native = vi.fn();
    const foreign = vi.fn();
    const root = createRootContext();
    root.own({
      [Resource.release]: () => void native(),
      [Symbol.asyncDispose]: async () => void foreign(),
      [Symbol.dispose]: () => void foreign(),
    });
    await within(root.close());
    expect(native).toHaveBeenCalledOnce();
    expect(foreign).not.toHaveBeenCalled();
  });

  it('own(value, release) replaces the native method for that entry', async () => {
    const native = vi.fn();
    const explicit = vi.fn();
    const root = createRootContext();
    const value = { [Resource.release]: () => void native() };
    root.own(value, explicit);
    await within(root.close());
    expect(explicit).toHaveBeenCalledExactlyOnceWith(value);
    expect(native).not.toHaveBeenCalled();
  });

  it('a member merely named release is nothing to own: the platform’s method still releases the value', async () => {
    const log: string[] = [];
    const root = createRootContext();
    /** A domain operation named `release`, of another meaning and another arity. */
    class Semaphore implements Disposable {
      readonly release = task(this, function* release(permit: { readonly id: number }) {
        log.push(`permit ${permit.id} returned`);
      });
      [Symbol.dispose](): void {
        log.push('semaphore disposed');
      }
    }
    /** DESIGN.md §2.6's handle: its `release()` goes through its owner, here written as a task. */
    class Lease implements Disposable {
      readonly release = task(this, function* release() {
        yield* root.release(this);
      });
      [Symbol.dispose](): void {
        log.push('lease returned');
      }
    }
    root.own(new Semaphore());
    root.own(new Lease());
    await within(root.close());
    expect(log).toEqual(['lease returned', 'semaphore disposed']);
    // With nothing else to release it by, such a value is no resource at all.
    const other = createRootContext();
    expect(() => other.own({ release: task(function* () {}) } as unknown as Disposable)).toThrow(
      'own(): value is not a Resource, Disposable or AsyncDisposable; pass a release function',
    );
    await within(other.close());
  });

  it('release(resource) runs it now, exactly once: the owner’s exit does not run it again, and a second release is NotOwnedError (C7)', async () => {
    const root = createRootContext();
    let releases = 0;
    const order: string[] = [];
    const outcome = await within(
      root.attempt(function* () {
        const resource = own({
          *[Resource.release]() {
            releases++;
            yield* sleep(0);
            order.push('released');
          },
        });
        yield* release(resource);
        order.push('body goes on');
        expect(() => release(resource)).toThrow(NotOwnedError);
        return 'done';
      }),
    );
    expect(outcome).toEqual({ status: 'success', value: 'done' });
    expect(order).toEqual(['released', 'body goes on']);
    expect(releases).toBe(1);
    await within(root.close());
  });

  it('a value a constructor owns is released with its service, after the entries the service attached later', async () => {
    const log: string[] = [];
    const root = createRootContext();
    class Service implements Resource {
      constructor() {
        own(this); // on the value's own node (DESIGN.md §3.3)
        own(() => void log.push('attached after it'));
      }
      [Resource.release](): void {
        log.push('service released');
      }
    }
    expect(root.get(Service)).toBeInstanceOf(Service);
    await within(root.close());
    expect(log).toEqual(['attached after it', 'service released']);
  });
});

describe('a release is protected, bounded by the release deadline, and an ordinary call for a task', () => {
  it('the owner waits for a release it started after its own cancellation, and the remaining entries are released after a defect', async () => {
    const gate = deferred();
    const defect = new Error('broken cleanup');
    const log: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const root = createRootContext();
    root.own(() => void log.push('remaining'));
    root.own({
      *[Resource.release]() {
        log.push('start');
        yield* wait(gate.promise);
        expect(signal().aborted).toBe(false);
        throw defect;
      },
    });
    root.abort();
    const rejected = expect(root.close()).rejects.toBe(defect);
    await tick();
    expect(root.state).toBe('releasing');
    expect(log).toEqual(['start']);
    gate.resolve();
    await rejected;
    expect(log).toEqual(['start', 'remaining']);
    expect(root.outcome).toEqual({ status: 'defect', error: defect });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled(); // ramme reports a release failure to its owner, never to the console
  });

  it('a body’s failure and every release defect are reported together, and the tree goes on working', async () => {
    const root = createRootContext();
    const original = new Error('body');
    const first = new Error('cleanup 1');
    const second = new Error('cleanup 2');
    const outcome = await within(
      root.attempt(function* () {
        own({
          [Resource.release]() {
            throw first;
          },
        });
        own({
          [Resource.release]() {
            throw second;
          },
        });
        yield* fail(original);
      }),
    );
    expect(outcome).toMatchObject({
      status: 'defect',
      error: { name: 'SuppressedError', suppressed: original, error: { errors: [second, first] } },
    });
    expect(await within(root.call(() => 42))).toBe(42);
    await within(root.close());
  });

  it('an expected failure that untyped cleanup yields is the owner’s defect', async () => {
    const root = createRootContext();
    const error = new Error('no expected failure in a release');
    // @ts-expect-error -- a release has no expected failures: this is JavaScript, or a cast, breaking the type
    root.own({
      *[Resource.release]() {
        yield* fail(error);
      },
    });
    await expect(root.close()).rejects.toBe(error);
    expect(root.outcome).toEqual({ status: 'defect', error });
  });

  it('an early release’s defect is delivered to its awaiter once, and the owner then completes successfully', async () => {
    const root = createRootContext();
    const error = new Error('cleanup');
    const resource = root.own({
      [Resource.release]() {
        throw error;
      },
    });
    await expect(root.release(resource)).rejects.toBe(error);
    await within(root.close());
    expect(root.outcome?.status).toBe('success');
  });

  it('releaseTimeoutMs fires the release’s signal(), which the method hands a driver; nothing is abandoned', async () => {
    const heard: unknown[] = [];
    const root = createRootContext({ releaseTimeoutMs: 20 });
    root.own({
      *[Resource.release]() {
        const s = signal();
        yield* wait(new Promise<void>((resolve) => s.addEventListener('abort', () => resolve(), { once: true })));
        heard.push((s.reason as DOMException).name);
      },
    });
    await within(root.close());
    expect(heard).toEqual(['TimeoutError']);
    expect(root.outcome?.status).toBe('success');
  });

  it('a task as the release is called as any task: a child of the release fiber, its own options honoured', async () => {
    const seen: { kind: string; parent: string; name: string | undefined }[] = [];
    const flush = task(function* flush(value: { readonly id: number }) {
      const node: Context = current();
      seen.push({ kind: impl(node).kind, parent: impl(node.parent!).kind, name: node.name });
      expect(value.id).toBe(1);
    });
    const stuck = task(function* stuck() {
      yield* never();
    });
    const root = createRootContext();
    root.own({ id: 1 }, flush);
    root.own({ id: 2 }, stuck.with({ timeoutMs: 10 })); // the task's own deadline: its cleanup is cut there, by its author's choice
    await expect(within(root.close())).rejects.toBeInstanceOf(FiberAbortedError);
    expect(seen).toEqual([{ kind: 'fiber', parent: 'release', name: 'flush' }]);
    expect(root.state).toBe('complete');
  });
});

describe('the value an injection key resolves to may be a resource', () => {
  it('a factory owns what it makes with one argument', async () => {
    const released = vi.fn();
    const root = createRootContext();
    const key = createInjectionKey('connection', { factory: () => own({ [Resource.release]: () => void released() }) });
    const value = root.get(key);
    expect(root.get(key)).toBe(value);
    expect(released).not.toHaveBeenCalled();
    await within(root.close());
    expect(released).toHaveBeenCalledOnce();
  });
});
