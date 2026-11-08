// Tests for tasks / calls.
import { describe, expect, it } from 'vitest';
import { current, lookup, own, wait } from '../../src/ambient.js';
import { createInjectionKey } from '../../src/context-key.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { factoryProvider, valueProvider } from '../../src/provider-util.js';
import { NoCurrentNodeError } from '../../src/resource.js';
import { createScope } from '../../src/scope.js';
import { impl, tick } from '../support/util.js';

/** The rejection of `p`; throws if `p` fulfils. Awaits `p` directly, so a managed `p` is awaited by its own body, a direct await (DESIGN.md §4.2). */
async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

// ---------------------------------------------------------------------------
describe('call', () => {
  it('runs an async function in a child node', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test', { factory: () => 'hello' });
    expect(await ctx.call(function* () { return lookup(KEY); })).toBe('hello');
    await ctx.close();
  });

  it('provides values via the providers option', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test');
    expect(await ctx.call(task(function* () { return lookup(KEY); }, { providers: [valueProvider(KEY, 'provided')] }))).toBe('provided');
    await ctx.close();
  });

  it('attaches scopes to the child node', async () => {
    const ctx = createRootContext();
    const TestScope = createScope('test');
    const KEY = createInjectionKey<string>('scoped', { factory: () => 'scoped-value', scope: TestScope });
    expect(await ctx.call(task(function* () { return lookup(KEY); }, { scopes: [TestScope] }))).toBe('scoped-value');
    await ctx.close();
  });

  it('releases the child node after completion', async () => {
    const ctx = createRootContext();
    let disposed = false;
    const KEY = createInjectionKey<string>('test');
    await ctx.call(
      task(
        function* () {
          lookup(KEY);
        },
        {
          providers: [
            factoryProvider(KEY, () => {
              own(() => {
                disposed = true;
              });
              return 'value';
            }),
          ],
        },
      ),
    );
    expect(disposed).toBe(true);
    await ctx.close();
  });

  it('releases the child node on error', async () => {
    const ctx = createRootContext();
    let disposed = false;
    const KEY = createInjectionKey<string>('test');
    const err = await rejection(
      ctx.call(
        task(
          function* () {
            lookup(KEY);
            throw new Error('boom');
          },
          {
            providers: [
              factoryProvider(KEY, () => {
                own(() => {
                  disposed = true;
                });
                return 'value';
              }),
            ],
          },
        ),
      ),
    );
    expect((err as Error).message).toBe('boom');
    expect(disposed).toBe(true);
    await ctx.close();
  });

  it('propagates errors from the body', async () => {
    const ctx = createRootContext();
    const err = await rejection(
      ctx.call(function* () {
        throw new Error('test error');
      }),
    );
    expect((err as Error).message).toBe('test error');
    await ctx.close();
  });

  it('supports nested calls', async () => {
    const ctx = createRootContext();
    const KEY_A = createInjectionKey<string>('A');
    const KEY_B = createInjectionKey<string>('B');
    const r = await ctx.call(
      task(
        function* () {
          const a = lookup(KEY_A);
          const b = yield* task(function* () { return lookup(KEY_B); }, { providers: [valueProvider(KEY_B, 'inner')] })();
          return `${a}-${b}`;
        },
        { providers: [valueProvider(KEY_A, 'outer')] },
      ),
    );
    expect(r).toBe('outer-inner');
    await ctx.close();
  });

  it('a nested call not yet yielded runs nothing: the next call runs first, and the stored one runs at its own yield* (D41, decision 2)', async () => {
    const ctx = createRootContext();
    const order: string[] = [];
    await ctx.call(function* () {
      const p1 = task(function* () {
        order.push('first ran');
        yield* wait(tick(3));
        return 'first';
      })();
      yield* wait(tick());
      order.push(yield* task(function* () {
        order.push('second ran');
        return 'second';
      })());
      order.push(yield* p1);
    });
    expect(order).toEqual(['second ran', 'second', 'first ran', 'first']);
    await ctx.close();
  });

  it('throws NoCurrentNodeError when no node is current', () => {
    expect(() => task(function* () { return 'hello'; })()).toThrow(NoCurrentNodeError);
    expect(() => task(function* () { return 'hello'; })()).toThrow(/no current node/);
  });

  it('a nested call uses the current node', async () => {
    const ctx = createRootContext();
    const KEY = createInjectionKey<string>('test');
    const r = await ctx.call(function* () {
      const outer = current();
      return yield* task(
        function* () {
          expect(impl(current()).parent).toBe(outer);
          return lookup(KEY);
        },
        { providers: [valueProvider(KEY, 'nested')] },
      )();
    });
    expect(r).toBe('nested');
    await ctx.close();
  });

  it('returns the value from the body', async () => {
    const ctx = createRootContext();
    expect(await ctx.call(function* () { return 42; })).toBe(42);
    await ctx.close();
  });
});
