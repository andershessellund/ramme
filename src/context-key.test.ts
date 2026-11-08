// Tests for di / implementation keys.
import { afterEach, describe, expect, it } from 'vitest';
import { lookup } from './ambient.js';
import { createKeyFor, getKeyScope } from './context-key.js';
import type { InjectionKey } from './context-key.js';
import type { Context } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { inject } from './inject.js';
import { RequestScope, RootScope, createScope } from './scope.js';
import { impl, within } from '../tests/support/util.js';

const SessionScope = createScope('session');

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

afterEach(async () => {
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

/** What `f()` threw: its class name and its message; `'returned'` when it did not throw. */
function thrownBy(f: () => unknown): { readonly cls: string; readonly message: string } | 'returned' {
  try {
    f();
    return 'returned';
  } catch (e) {
    return e instanceof Error ? { cls: e.constructor.name, message: e.message } : { cls: typeof e, message: String(e) };
  }
}

/** Resolve `key` from a request fiber (it carries RequestScope) run under `session`. */
async function fromRequest<T>(session: Context, key: InjectionKey<T>): Promise<T> {
  return session.call(task(function* request() { return lookup(key); }, { scopes: [RequestScope] }));
}

/** The nodes a resolved key is cached on, among `nodes`. */
function storedOn(key: object, nodes: Record<string, Context>): string[] {
  return Object.entries(nodes)
    .filter(([, n]) => impl(n).cache.has(key as never))
    .map(([name]) => name);
}

describe('a task is not an injection key (decision 7)', () => {
  it('inject(t) is a type error, and inject(t) and lookup(t) throw a TypeError at run time', async () => {
    const getUser = task(function* getUser(id: string) {
      return id;
    });
    class Holder {
      // @ts-expect-error a task is not an injection key (decision 7)
      readonly user = inject(getUser);
    }
    const seen = await within(
      app().call(function* () {
        return { inject: thrownBy(() => lookup(Holder)), lookup: thrownBy(() => lookup(getUser as never)) };
      }),
      2000,
    );
    const read = (t: ReturnType<typeof thrownBy>) => (t === 'returned' ? t : { cls: t.cls, saysTask: /a task is not an injection key/.test(t.message) });
    expect({ inject: read(seen.inject), lookup: read(seen.lookup) }).toEqual({
      inject: { cls: 'TypeError', saysTask: true },
      lookup: { cls: 'TypeError', saysTask: true },
    });
  });
});

describe('createKeyFor(impl, opts?) (decision 6)', () => {
  it('is an explicit key named after impl: a class is constructed with new and a function called without; its value is cached as a default is, under a key of its own', async () => {
    interface Clock {
      now(): number;
    }
    class SystemClock implements Clock {
      now(): number {
        return 1;
      }
    }
    function makeConfig() {
      return { url: 'https://example.com', calledWithNew: new.target !== undefined };
    }
    const ClockKey = createKeyFor<Clock>(SystemClock);
    const ConfigKey = createKeyFor(makeConfig);
    const seen = await within(
      app().call(function* () {
        const clock = lookup(ClockKey);
        return {
          names: [ClockKey.name, ConfigKey.name],
          constructed: clock instanceof SystemClock,
          cached: lookup(ClockKey) === clock,
          ownKey: lookup(SystemClock) !== clock,
          config: lookup(ConfigKey),
        };
      }),
      2000,
    );
    expect(seen).toEqual({
      names: ['SystemClock', 'makeConfig'],
      constructed: true,
      cached: true,
      ownKey: true,
      config: { url: 'https://example.com', calledWithNew: false },
    });
  });

  it('is scoped by the impl’s declared scope, read as D32 reads it; opts.scope and opts.name win', async () => {
    class SessionThing {
      static readonly scope = SessionScope;
    }
    function plain() {
      return { plain: true };
    }
    const Declared = createKeyFor(SessionThing);
    const Overridden = createKeyFor(SessionThing, { name: 'RootThing', scope: RootScope });
    const Unscoped = createKeyFor(plain);
    const root = app();
    const s1 = root.child({ name: 's1', scopes: [SessionScope] });
    const s2 = root.child({ name: 's2', scopes: [SessionScope] });
    const d1 = await fromRequest(s1, Declared);
    const d2 = await fromRequest(s2, Declared);
    const o1 = await fromRequest(s1, Overridden);
    const o2 = await fromRequest(s2, Overridden);
    expect({
      scopes: [getKeyScope(Declared), getKeyScope(Overridden), getKeyScope(Unscoped)].map((s) => s?.name),
      names: [Declared.name, Overridden.name, Unscoped.name],
      declared: { stored: storedOn(Declared, { root, s1, s2 }), perSession: d1 !== d2 },
      overridden: { stored: storedOn(Overridden, { root, s1, s2 }), shared: o1 === o2 },
    }).toEqual({
      scopes: ['session', 'root', undefined],
      names: ['SessionThing', 'RootThing', 'plain'],
      declared: { stored: ['s1', 's2'], perSession: true },
      overridden: { stored: ['root'], shared: true },
    });
  });

  it('runs its factory in the creation phase: inject inside impl works, and a key whose impl injects a session-scoped value is placed under the session', async () => {
    class SessionCache {
      static readonly scope = SessionScope;
    }
    class Report {
      readonly cache = inject(SessionCache);
    }
    const ReportKey = createKeyFor(Report);
    const SummaryKey = createKeyFor(() => ({ cache: inject(SessionCache) }), { name: 'Summary' });
    const root = app();
    const s1 = root.child({ name: 's1', scopes: [SessionScope] });
    const s2 = root.child({ name: 's2', scopes: [SessionScope] });
    const r1 = await fromRequest(s1, ReportKey);
    const r1again = await fromRequest(s1, ReportKey);
    const r2 = await fromRequest(s2, ReportKey);
    const m1 = await fromRequest(s1, SummaryKey);
    const cache1 = await fromRequest(s1, SessionCache);
    expect({
      report: { stored: storedOn(ReportKey, { root, s1, s2 }), sharedInSession: r1 === r1again, perSession: r1 !== r2, cache: r1.cache === cache1 },
      summary: { stored: storedOn(SummaryKey, { root, s1, s2 }), cache: m1.cache === cache1 },
    }).toEqual({
      report: { stored: ['s1', 's2'], sharedInSession: true, perSession: true, cache: true },
      summary: { stored: ['s1'], cache: true },
    });
  });

  it('refuses a task as impl with a TypeError naming createKeyFor', () => {
    const getUser = task(function* getUser(id: string) {
      return id;
    });
    const thrown = thrownBy(() => createKeyFor(getUser as never));
    expect({
      exported: typeof createKeyFor,
      thrown: thrown === 'returned' ? thrown : { cls: thrown.cls, namesCreateKeyFor: thrown.message.includes('createKeyFor') },
    }).toEqual({ exported: 'function', thrown: { cls: 'TypeError', namesCreateKeyFor: true } });
  });
});
