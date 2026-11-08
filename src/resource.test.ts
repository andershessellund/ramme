import { afterEach, describe, expect, it, vi } from 'vitest';
import { current, fail, own, signal, wait } from './ambient.js';
import type { Resource } from './context.js';
import { createInjectionKey } from './context-key.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { NodeTopic } from './lifecycle-events.js';
import { valueProvider } from './provider-util.js';
import { NotOwnedError } from './resource.js';
import { deferred, impl, start, tick } from '../tests/support/util.js';

afterEach(() => vi.restoreAllMocks());

describe('native resource cleanup', () => {
  it('runs the bound task in a protected release fiber, with DI and nested cleanup', async () => {
    const key = createInjectionKey<string>('release dependency');
    const log: unknown[] = [];
    const root = createRootContext();
    class Connection implements Resource {
      readonly #value = 'connection';
      readonly release = task(this, function* () {
        expect(impl(current()).kind).toBe('release');
        expect(current().parent).toBe(root);
        expect(signal().aborted).toBe(false);
        own(() => { log.push('nested'); });
        yield* wait(Promise.resolve());
        log.push(this.#value, current().get(key));
      }, { providers: [valueProvider(key, 'dependency')], interrupt: 'restore', signal: AbortSignal.abort(), timeoutMs: 0 });
    }
    const resource = new Connection();
    expect(root.own(resource)).toBe(resource);
    root.abort();
    await root.close();
    expect(log).toEqual(['connection', 'dependency', 'nested']);
  });

  it('runs deferred and explicit release tasks directly, including during creation', async () => {
    const log: unknown[] = [];
    const root = createRootContext();
    const resource = { id: 42 };
    const key = createInjectionKey('service', { factory: () => {
      own(task(() => { log.push(impl(current()).kind); }));
      own(resource, task((value: typeof resource) => { log.push(value.id, impl(current()).kind); }));
      return resource;
    } });
    root.get(key);
    await root.close();
    expect(log).toEqual([42, 'release', 'release']);
  });

  it('waits for cleanup after owner cancellation and propagates its defect without logging', async () => {
    const gate = deferred();
    const defect = new Error('broken cleanup');
    const log: string[] = [];
    const spies = ['log', 'warn', 'error'].map((method) => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
    const root = createRootContext();
    root.own(() => { log.push('remaining'); });
    root.own({ release: task(function* () {
      log.push('start');
      yield* wait(gate.promise);
      expect(signal().aborted).toBe(false);
      throw defect;
    }) });
    root.abort();
    const completion = root.close();
    const rejected = expect(completion).rejects.toBe(defect);
    await tick();
    expect(root.state).toBe('releasing');
    expect(log).toEqual(['start']);
    gate.resolve();
    await rejected;
    expect(log).toEqual(['start', 'remaining']);
    expect(root.outcome).toEqual({ status: 'defect', error: defect });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('preserves the body failure and every cleanup defect, then lets the caller recover', async () => {
    const root = createRootContext();
    const original = new Error('body');
    const first = new Error('cleanup 1');
    const second = new Error('cleanup 2');
    const outcome = await root.attempt(function* () {
      own({ release: task(() => { throw first; }) });
      own({ release: task(() => { throw second; }) });
      yield* fail(original);
    });
    expect(outcome).toMatchObject({ status: 'defect', error: {
      name: 'SuppressedError', suppressed: original, error: { errors: [second, first] },
    } });
    expect(await root.call(() => 42)).toBe(42);
    await root.close();
  });

  it('treats an expected failure from untyped cleanup as a defect', async () => {
    const root = createRootContext();
    const error = new Error('invalid expected failure');
    // @ts-expect-error -- simulate JavaScript or an unsafe cast violating Resource
    root.own({ release: task(function* () { yield* fail(error); }) });
    await expect(root.close()).rejects.toBe(error);
    expect(root.outcome).toEqual({ status: 'defect', error });
  });

  it('delivers an early release defect once and allows the owner to continue', async () => {
    const root = createRootContext();
    const error = new Error('cleanup');
    const handler = vi.fn();
    const resource = root.own({ release: task(() => { throw error; }, { onFailure: handler }) });
    await expect(root.release(resource)).rejects.toBe(error);
    await root.close();
    expect(root.outcome?.status).toBe('success');
    expect(handler).not.toHaveBeenCalled();
  });

  it('prefers the native task over standard disposal adapters', async () => {
    const native = vi.fn();
    const foreign = vi.fn();
    const root = createRootContext();
    root.own({ release: task(native), [Symbol.asyncDispose]: async () => { foreign(); }, [Symbol.dispose]: foreign });
    await root.close();
    expect(native).toHaveBeenCalledOnce();
    expect(foreign).not.toHaveBeenCalled();
  });

  it('continues cleanup when a release task cannot be constructed', async () => {
    const root = createRootContext();
    const remaining = vi.fn();
    const invalid = vi.fn();
    root.own(() => { remaining(); });
    root.own({ release: task(invalid, { releaseTimeoutMs: -1 }) });
    await expect(root.close()).rejects.toBeInstanceOf(TypeError);
    expect(root.state).toBe('complete');
    expect(remaining).toHaveBeenCalledOnce();
    expect(invalid).not.toHaveBeenCalled();
  });

  it('preserves both cleanup and completion-listener defects without stopping remaining cleanup', async () => {
    const root = createRootContext();
    const completed = new AbortController();
    const cleanup = new Error('cleanup');
    const detach = new Error('detach');
    const remaining = vi.fn();
    root.own(() => { remaining(); });
    root.own({ released: completed.signal, release: task(() => { throw cleanup; }) });
    vi.spyOn(completed.signal, 'removeEventListener').mockImplementation(() => { throw detach; });
    await expect(root.close()).rejects.toMatchObject({ name: 'SuppressedError', error: detach, suppressed: cleanup });
    expect(remaining).toHaveBeenCalledOnce();
    expect(root.state).toBe('complete');
  });
});

describe('resource retirement', () => {
  function resource() {
    const terminal = new AbortController();
    const cleanup = vi.fn();
    return { terminal, cleanup, value: { release: task(() => { cleanup(); }), released: terminal.signal } };
  }

  it('unlinks natural completion immediately, detaches its listener and preserves LIFO order', async () => {
    const root = createRootContext();
    const r = resource();
    const remove = vi.spyOn(r.terminal.signal, 'removeEventListener');
    const order: number[] = [];
    root.own(() => { order.push(1); });
    root.own(r.value);
    root.own(() => { order.push(2); });
    const entry = impl(root).explicit.find(r.value)!;
    r.terminal.abort();
    expect(impl(root).explicit.size).toBe(2);
    expect(entry.prev).toBeUndefined();
    expect(entry.next).toBeUndefined();
    expect(entry.detach).toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();
    expect(() => root.release(r.value)).toThrow(NotOwnedError);
    await root.close();
    expect(r.cleanup).not.toHaveBeenCalled();
    expect(order).toEqual([2, 1]);
  });

  it('does not attach an already-completed resource, including re-ownership', async () => {
    const root = createRootContext();
    const r = resource();
    root.own(r.value);
    r.terminal.abort();
    const add = vi.spyOn(r.terminal.signal, 'addEventListener');
    expect(root.own(r.value)).toBe(r.value);
    expect(impl(root).explicit.size).toBe(0);
    expect(add).not.toHaveBeenCalled();
    await root.close();
    expect(r.cleanup).not.toHaveBeenCalled();
  });

  it('deduplicates ownership and detaches after owner-driven cleanup', async () => {
    const root = createRootContext();
    const r = resource();
    const add = vi.spyOn(r.terminal.signal, 'addEventListener');
    const remove = vi.spyOn(r.terminal.signal, 'removeEventListener');
    root.own(r.value);
    root.own(r.value);
    await root.close();
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    r.terminal.abort();
    expect(r.cleanup).toHaveBeenCalledOnce();
  });

  it('does not retire an in-flight cleanup or hide a later defect', async () => {
    const root = createRootContext();
    const terminal = new AbortController();
    const gate = deferred();
    const error = new Error('defect after terminal signal');
    const value = root.own({ released: terminal.signal, release: task(function* () {
      terminal.abort(); // even a resource that signals too early cannot hide this release's result
      yield* wait(gate.promise);
      throw error;
    }) });
    const early = root.release(value);
    const rejected = expect(early).rejects.toBe(error);
    const completion = start(root.close());
    await tick();
    expect(impl(root).explicit.find(value)?.state).toBe('releasing');
    gate.resolve();
    await rejected;
    await completion;
    expect(root.state).toBe('complete');
  });

  it('handles completion from an entry registration observer without missing it', async () => {
    const r = resource();
    const root = createRootContext({ providers: [valueProvider(NodeTopic, (event) => {
      if (event.type === 'entry:registered') {
        r.terminal.abort();
        root.abort();
      }
    })] });
    root.own(r.value);
    expect(impl(root).explicit.size).toBe(0);
    await root.close();
    expect(r.cleanup).not.toHaveBeenCalled();
  });

  it('does not leave a listener when a registration observer releases the owner', async () => {
    const r = resource();
    const add = vi.spyOn(r.terminal.signal, 'addEventListener');
    const remove = vi.spyOn(r.terminal.signal, 'removeEventListener');
    const root = createRootContext({ providers: [valueProvider(NodeTopic, (event) => {
      if (event.type === 'entry:registered') root.abort();
    })] });
    root.own(r.value);
    await root.close();
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(r.cleanup).toHaveBeenCalledOnce();
  });

  it('retires independently from multiple owners', async () => {
    const a = createRootContext();
    const b = createRootContext();
    const r = resource();
    a.own(r.value);
    b.own(r.value);
    r.terminal.abort();
    expect(impl(a).explicit.size + impl(b).explicit.size).toBe(0);
    await a.close();
    await b.close();
    expect(r.cleanup).not.toHaveBeenCalled();
  });

  it('keeps explicit cleanup overrides independent of the native terminal signal', async () => {
    const root = createRootContext();
    const r = resource();
    const override = vi.fn();
    r.terminal.abort();
    root.own(r.value, override);
    await root.close();
    expect(override).toHaveBeenCalledOnce();
    expect(r.cleanup).not.toHaveBeenCalled();
  });

  it('does not invalidate a DI cache when its resource completes naturally', async () => {
    const root = createRootContext();
    const r = resource();
    const key = createInjectionKey('resource service', { factory: () => own(r.value) });
    expect(root.get(key)).toBe(r.value);
    r.terminal.abort();
    expect(root.get(key)).toBe(r.value);
    await root.close();
    expect(r.cleanup).not.toHaveBeenCalled();
  });

  it('propagates a retirement-listener defect through the owner', async () => {
    const root = createRootContext();
    const r = resource();
    const error = new Error('detach');
    root.own(r.value);
    vi.spyOn(r.terminal.signal, 'removeEventListener').mockImplementation(() => {
      root.abort(); // owner completion must wait for the detachment's result
      throw error;
    });
    r.terminal.abort();
    await expect(root.close()).rejects.toBe(error);
    expect(r.cleanup).not.toHaveBeenCalled();
  });
});
