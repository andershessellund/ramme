// Tests for tasks / task receivers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, attempt, current, fork, join, lookup, own, pool, promised, release, shield, unshield, wait } from '../../src/ambient.js';
import { createInjectionKey, createKeyFor } from '../../src/context-key.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { isTask } from '../../src/internal-context.js';
import { events, within } from '../support/util.js';
import type { EventLog } from '../support/util.js';

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
