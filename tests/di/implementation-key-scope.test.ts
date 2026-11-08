// Tests for di / implementation key scope.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookup } from '../../src/ambient.js';
import { createInjectionKey, createKeyFor, getKeyScope, setDependencies, setScope } from '../../src/context-key.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { aliasProvider, factoryProvider, valueProvider } from '../../src/provider-util.js';
import { createScope } from '../../src/scope.js';
import type { Scope } from '../../src/scope.js';
import { impl, within } from '../support/util.js';

const roots: Context[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** What `f()` threw: its class and whether its message names `word`; `'returned'` when it did not throw. */
function thrownBy(f: () => unknown, word: string): { readonly cls: string; readonly names: boolean } | 'returned' {
  try {
    f();
    return 'returned';
  } catch (e) {
    return e instanceof Error ? { cls: e.constructor.name, names: e.message.includes(word) } : { cls: typeof e, names: false };
  }
}

describe('a createKeyFor token is made and scoped as its impl is (D44, decision 6; D32)', () => {
  it('its value gets the arguments setDependencies declares for impl, and its scope is read from impl at each read: a setScope(impl, …) after the key reaches it, and a malformed one is refused at resolution', async () => {
    const LateScope = createScope('late');
    class Dep {
      readonly v = 'dep';
    }
    class WithDep {
      constructor(readonly d?: Dep) {}
    }
    function makeThing(d?: Dep) {
      return { d };
    }
    setDependencies(WithDep, Dep);
    setDependencies(makeThing, Dep);
    class Scoped {}
    class Malformed {
      static readonly scope = 'late' as unknown as Scope;
    }
    const WithDepKey = createKeyFor(WithDep);
    const ThingKey = createKeyFor(makeThing);
    const ScopedKey = createKeyFor(Scoped);
    setScope(Scoped, LateScope); // after the key is made
    const made = thrownBy(() => createKeyFor(Malformed), 'Malformed.scope');
    const MalformedKey = createKeyFor(Malformed);
    const root = app();
    const owner = root.child({ name: 'owner', scopes: [LateScope] });
    const seen = await within(
      owner.call(function* () {
        return {
          withDep: lookup(WithDepKey).d?.v,
          fn: lookup(ThingKey).d?.v,
          scope: getKeyScope(ScopedKey)?.name,
          scoped: lookup(ScopedKey) instanceof Scoped,
          malformed: thrownBy(() => lookup(MalformedKey), 'Malformed.scope'),
        };
      }),
      2000,
    );
    const stored = { root: impl(root).cache.has(ScopedKey as never), owner: impl(owner).cache.has(ScopedKey as never) };
    expect({ ...seen, stored, made }).toEqual({
      withDep: 'dep',
      fn: 'dep',
      scope: 'late',
      scoped: true,
      malformed: { cls: 'TypeError', names: true },
      stored: { root: false, owner: true }, // under the owner of its scope, not auto-hoisted to the root
      made: 'returned', // nothing is read when the key is made
    });
  });
});

describe('a task is no injection key, with a provider either (D44, decision 7)', () => {
  it('a provider registered for a task, at construction or by addProvider, an alias to a task, and setScope and setDependencies on one are TypeErrors', async () => {
    const ping = task(function* ping() {
      return 1;
    });
    const K = createInjectionKey<number>('K');
    const root = app();
    const says = 'a task is not an injection key';
    const seen = {
      child: thrownBy(() => root.child({ providers: [valueProvider(ping as never, 42 as never)] }), says),
      addProvider: thrownBy(() => root.addProvider(factoryProvider(ping as never, () => 7 as never)), says),
      alias: thrownBy(() => aliasProvider(K, ping as never), says),
      setScope: thrownBy(() => setScope(ping as never, createScope('s')), says),
      setDependencies: thrownBy(() => setDependencies(ping), says), // a task is a function to its type
      lookup: await within(root.call(function* () { return thrownBy(() => lookup(ping as never), says); }), 2000),
    };
    const refused = { cls: 'TypeError', names: true };
    expect(seen).toEqual({ child: refused, addProvider: refused, alias: refused, setScope: refused, setDependencies: refused, lookup: refused });
  });
});
