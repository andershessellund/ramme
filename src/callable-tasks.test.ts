// callable-tasks.test.ts — the runtime facts of callable tasks (D44) that src/stage6-pin.test.ts does not pin: an op's
// own fiber is the host of the op it runs, so a race's `wait((signal) => p)` member is handed that fiber's signal and a
// group op made in a body runs its group under the member's fiber; the fibers that run ops are named after their
// verbs, `ramme/platform`'s too; a bound task's receiver reaches every place a task runs (a shield, a hole in it, a
// pool, `promised`, a group); a free body runs with `this` undefined; in a factory `fork(t, …)` forks and `fork(t(…))`
// is refused, since the call reads the slot; `createKeyFor` refuses what is no class or function.
//
// And the review's regressions: a bound copy of a task (`t.bind(…)`) is no task but an inline body, which every verb
// runs (its `with` a `TypeError`); a task's call names the task in the node's own guards, not `call()`; a
// `createKeyFor` token is made with `impl`'s declared dependencies and scoped as `impl` is at each read; a task is no
// key with a provider either (its registration, an alias to it, `setScope` and `setDependencies` on it refused).
//
// And README's unit of work: a release that returns a bound task's call (`return this.commit()`) runs it as release
// work, in a node of its own under the release fiber, to its end before the entries below it are released.
//
// Each test compares one observation object.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  all,
  attempt,
  current,
  fork,
  interrupted,
  join,
  lookup,
  never,
  own,
  pool,
  promised,
  race,
  release,
  result,
  settle,
  shield,
  sleep,
  unshield,
  wait,
} from './ambient.js';
import { createInjectionKey, createKeyFor, getKeyScope, setDependencies, setScope } from './context-key.js';
import type { Context, Fiber } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { isTask } from './internal-context.js';
import { fetch, nextFrame } from './platform.js';
import { aliasProvider, factoryProvider, valueProvider } from './provider-util.js';
import { RequestScope, createScope } from './scope.js';
import type { Scope } from './scope.js';
import { events, impl, within } from './test/util.js';
import type { EventLog } from './test/util.js';

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

function recorded(): EventLog {
  const ev = events();
  roots.push(ev.root);
  return ev;
}

/** A node in `subtree`'s picture: `'<kind> <name>'`, with its children; release fibers left out (release work). */
type Shape = string | { readonly [node: string]: Shape[] };

function subtree(ev: EventLog, id: number): Shape[] {
  return ev
    .of('node:created')
    .filter((e) => e.parentId === id && e.kind !== 'release')
    .map((e) => {
      const below = subtree(ev, e.id);
      const node = `${e.kind} ${e.name ?? '(unnamed)'}`;
      return below.length === 0 ? node : { [node]: below };
    });
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

describe('an op’s own fiber is the host of the op it runs (D44, decision 4)', () => {
  it('a race’s wait((signal) => p) member is handed its fiber’s signal, which the race fires when the sleep wins: the request is aborted and the race returns', async () => {
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const me = current();
        const handed: AbortSignal[] = [];
        const request = wait(
          (signal) =>
            new Promise<string>((_, reject) => {
              handed.push(signal);
              signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
            }),
        );
        const v = yield* race([request, sleep(5)]);
        return { v, signal: handed.map((s) => (s === me.signal ? 'the maker’s' : s.aborted ? 'its own, aborted' : 'its own')), me: me.id };
      }),
      2000,
    );
    expect({ v: seen.v, signal: seen.signal, tree: subtree(ev, seen.me) }).toEqual({
      v: undefined,
      signal: ['its own, aborted'],
      tree: [{ 'fiber race': ['fiber wait', 'fiber sleep'] }],
    });
  });

  it('a group op that is a member of a group runs its group under the member’s fiber, so the tree is the call tree', async () => {
    const a = task(function* a() {
      return 'a';
    });
    const b = task(function* b() {
      return 'b';
    });
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const v = yield* all([all([a(), b()]), a()]);
        return { v, me: current().id };
      }),
      2000,
    );
    expect({ v: seen.v, tree: subtree(ev, seen.me) }).toEqual({
      v: [['a', 'b'], 'a'],
      tree: [{ 'fiber all': [{ 'fiber all': [{ 'fiber all': ['fiber a', 'fiber b'] }] }, 'fiber a'] }],
    });
  });
});

describe('the fiber an op runs in is named after its verb (D44, decision 4)', () => {
  it('sleep, wait, join, result, attempt, all, race, settle and shield name it; ramme/platform’s fetch and nextFrame name theirs; any other op is op', async () => {
    vi.stubGlobal('fetch', (): Promise<Response> => Promise.resolve(new Response('ok')));
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      queueMicrotask(() => cb(1));
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', (): void => {});
    const one = task(function* one() {
      return 1;
    });
    const names = await within(
      app().call(function* () {
        const f = fork(one);
        yield* join(f);
        const forked: Fiber<unknown, unknown>[] = [
          fork(sleep(1)),
          fork(wait(Promise.resolve(1))),
          fork(join(f)),
          fork(result(f)),
          fork(attempt(one)),
          fork(all([one])),
          fork(race([one])),
          fork(settle([one])),
          fork(shield(one)),
          fork(fetch('https://example.com/')),
          fork(nextFrame()),
        ];
        const stopped = [fork(never()), fork(interrupted())];
        for (const s of stopped) s.abort();
        for (const g of [...forked, ...stopped]) yield* result(g);
        return [...forked, ...stopped].map((g) => g.name);
      }),
      2000,
    );
    expect(names).toEqual(['sleep', 'wait', 'join', 'result', 'attempt', 'all', 'race', 'settle', 'shield', 'fetch', 'nextFrame', 'op', 'op']);
  });
});

describe('a bound task’s receiver reaches every place a task runs (D44, decision 2)', () => {
  it('a shield and a hole in it, a pool, promised, a group and a free body’s this, which is undefined', async () => {
    class Counter {
      readonly #n: number;
      readonly read = task(this, function* read() {
        return this.#n;
      });
      constructor(n: number) {
        this.#n = n;
      }
    }
    const free = task(function* free() {
      return this === undefined;
    });
    const seen = await within(
      app().call(function* () {
        const c = new Counter(7);
        const jobs = pool({ name: 'jobs', onFailure: () => {} });
        return {
          shield: yield* shield(c.read),
          hole: yield* shield(function* () {
            return (yield* unshield(c.read)).status;
          }),
          pool: yield* join(jobs.fork(c.read)),
          promised: yield* wait(promised(c.read)()),
          all: yield* all([c.read, c.read()]),
          with: yield* c.read.with({ name: 'again' })(),
          freeThis: yield* free(),
        };
      }),
      2000,
    );
    expect(seen).toEqual({ shield: 7, hole: 'success', pool: 7, promised: 7, all: [7, 7], with: 7, freeThis: true });
  });
});

describe('a task’s call reads the slot; fork(t, …) needs no body frame (DESIGN.md §3.5, D44)', () => {
  it('in a factory fork(t, …) forks the task and fork(t(…)) is refused with CreationViolationError naming the task; createKeyFor refuses what is no class or function', async () => {
    const job = task(function* job(n: number) {
      return n;
    });
    class Svc {
      readonly refused = thrownBy(() => fork(job(1)), 'job()');
      readonly forked = own(fork(job.with({ onFailure: 'link' }), 2));
    }
    const seen = await within(
      app().call(function* () {
        const svc = lookup(Svc);
        return { refused: svc.refused, forked: [svc.forked.name, yield* join(svc.forked)] };
      }),
      2000,
    );
    expect({ ...seen, notImpl: thrownBy(() => createKeyFor(42 as never), 'createKeyFor') }).toEqual({
      refused: { cls: 'CreationViolationError', names: true },
      forked: ['job', 2],
      notImpl: { cls: 'TypeError', names: true },
    });
  });

  it('the node’s own guards name the task too: in a release a factory started, getUser(…) is refused as getUser(), where ctx.call names call()', () => {
    const getUser = task(function* getUser(id: string) {
      return id;
    });
    const refused: Record<string, string> = {};
    const record = (as: string, f: () => unknown): void => {
      try {
        f();
        refused[as] = 'returned';
      } catch (e) {
        refused[as] = `${(e as Error).constructor.name}: ${(e as Error).message.split(' in ')[0]}`;
      }
    };
    const K = createInjectionKey<object>('K', {
      factory: () => {
        // A release the factory starts runs now, under the value's node, while the creation still runs (DESIGN.md §3.3).
        const x = own({}, () => {
          record('task', () => getUser('a'));
          record('ctx.call', () => current().call(getUser, 'b'));
        });
        void release(x);
        return {};
      },
    });
    expect({ made: app().get(K), refused }).toEqual({
      made: {},
      refused: { task: 'CreationViolationError: getUser()', 'ctx.call': 'CreationViolationError: call()' },
    });
  });
});

describe('a bound copy of a task is a plain function, an inline body (D44, decisions 3, 8)', () => {
  it('t.bind(…) is no task: fork, attempt, a group, shield and ctx.call run it as an inline body, whose op runs; its inherited with is a TypeError', async () => {
    const double = task(function* double(n: number) {
      return n * 2;
    });
    const ping = task(function* ping() {
      return 1;
    });
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const me = current().id;
        const bound = double.bind(null, 3);
        const forked = fork(bound);
        const attempted = yield* attempt(double.bind(null), 5);
        return {
          isTask: [isTask(bound), isTask(double.bind(null)), isTask(double)],
          forked: [forked.name, yield* join(forked)],
          forkedWithArgs: yield* join(fork(double.bind(null), 4)),
          attempt: attempted.status === 'success' ? attempted.value : attempted.status,
          all: yield* all([ping.bind(null)]),
          shield: yield* shield(bound),
          call: yield* current().call(bound),
          tree: subtree(ev, me)[0],
        };
      }),
      2000,
    );
    expect({ ...seen, with: thrownBy(() => double.bind(null).with({ name: 'w' }), 'no task') }).toEqual({
      isTask: [false, false, true],
      forked: ['bound double', 6],
      forkedWithArgs: 8,
      attempt: 10,
      all: [1],
      shield: 6,
      call: 6,
      tree: { 'fiber bound double': ['fiber double'] }, // the inline body, and under it the task its op runs
      with: { cls: 'TypeError', names: true },
    });
  });
});

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

describe('README’s UnitOfWork: a release that returns a bound task’s call runs it as release work (DESIGN.md §2.6, §4.5)', () => {
  it('the commit, or the rollback for a failed or an interrupted request, runs in its own node under the release fiber, with the unit as this, to its end before the lease is returned', async () => {
    const log: string[] = [];
    class Lease implements Disposable {
      open = true;
      [Symbol.dispose](): void {
        this.open = false;
        log.push('lease returned');
      }
    }
    class UnitOfWork {
      static readonly scope = RequestScope;
      readonly #node = current();
      readonly #lease = own(new Lease()); // owned by this value's node, below the entry that commits (LIFO)
      constructor() {
        own(this, () => {
          const o = this.#node.parent!.outcome; // the request's outcome
          if (o === undefined) return this.#node.signal.aborted ? this.rollback() : this.commit();
          return o.status === 'success' ? this.commit() : this.rollback();
        });
      }
      readonly commit = task(this, function* commit() {
        yield* sleep(1);
        log.push(`commit ${this.#where()}`);
      });
      readonly rollback = task(this, function* rollback() {
        yield* sleep(1);
        log.push(`rollback ${this.#where()}`);
      });
      #where(): string {
        const n = current();
        return `in ${impl(n).kind} ${n.name} under ${n.parent!.name}, this ${this instanceof UnitOfWork}, lease open ${this.#lease.open}`;
      }
    }
    const ok = task(function* ok() {
      lookup(UnitOfWork);
      yield* sleep(1);
    }, { scopes: [RequestScope] });
    const boom = task(function* boom() {
      lookup(UnitOfWork);
      yield* sleep(1);
      throw new Error('boom');
    }, { scopes: [RequestScope] });
    const hung = task(function* hung() {
      lookup(UnitOfWork);
      yield* never();
    }, { scopes: [RequestScope] });
    const seen = await within(
      app().call(function* () {
        yield* ok();
        log.push('--');
        const failed = yield* attempt(boom());
        log.push('--');
        const h = fork(hung());
        yield* sleep(1);
        h.abort('hung up');
        return { failed: failed.status, hung: (yield* result(h)).status };
      }),
      2000,
    );
    const where = 'in fiber %s under release:UnitOfWork, this true, lease open true';
    expect({ seen, log }).toEqual({
      seen: { failed: 'defect', hung: 'aborted' },
      log: [
        `commit ${where.replace('%s', 'commit')}`,
        'lease returned',
        '--',
        `rollback ${where.replace('%s', 'rollback')}`,
        'lease returned',
        '--',
        `rollback ${where.replace('%s', 'rollback')}`,
        'lease returned',
      ],
    });
  });
});
