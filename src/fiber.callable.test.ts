// Tests for tasks / callable tasks.
import { afterEach, describe, expect, it } from 'vitest';
import { current, fork, join, lookup, sleep } from './ambient.js';
import type { Context } from './context.js';
import { createRootContext } from './create-context.js';
import { task } from './fiber.js';
import { isTask } from './internal-context.js';
import { events, trace, within } from '../tests/support/util.js';
import type { EventLog } from '../tests/support/util.js';

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

/** A root that records its tree's events (test/util.ts `events`), closed after the test. */
function recorded(): EventLog {
  const ev = events();
  roots.push(ev.root);
  return ev;
}

/** What `f()` did: `'returned'`, or the class name of what it threw. */
function outcomeOf(f: () => unknown): string {
  try {
    f();
    return 'returned';
  } catch (e) {
    return e instanceof Error ? e.constructor.name : String(e);
  }
}

/** A property of `x` as plain JavaScript reads it, whatever `x`'s type says it has. */
function prop(x: unknown, key: string): unknown {
  return (x as Record<string, unknown>)[key];
}

/** A node in `subtree`'s picture: `'<kind> <name>'`, with its children when it has any. */
type Shape = string | { readonly [node: string]: Shape[] };

/**
 * The nodes created under node `id`, in creation order, each as `'<kind> <name>'`, its own children nested. Release
 * fibers are left out (a halted or failed body's `unwind:` fiber, an entry's `release:` fiber): they are release
 * work, made by the halt and by the owner's completion whatever made the node, not the tree of calls the picture is of.
 */
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

describe('a task is callable, and its call is a lazy op (decisions 1, 3, 8)', () => {
  it('a task call is lazy: making it runs nothing, each yield* runs it afresh in a new child named after the task, and then from plain async code runs it under the node it was made through', async () => {
    const t = trace();
    const double = task(function* double(n: number) {
      t.push(`double(${n}) ran`);
      yield* sleep(0);
      return n * 2;
    });
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* main() {
        const op = double(21);
        const dropped = double(99); // made and never yielded: it runs nothing
        t.push('made');
        yield* sleep(1);
        t.push('slept');
        const a = yield* op;
        const b = yield* op; // the same op again: a second run, a second node
        return { a, b, dropped: typeof dropped, me: current().id };
      }),
      2000,
    );
    const viaThen = ev.root.run(() => double(4)); // made through the root, run by its `then`
    t.push('made through the root');
    const c = await within(viaThen, 2000);
    expect({
      log: t.log,
      values: { a: seen.a, b: seen.b, c },
      dropped: seen.dropped,
      underMain: subtree(ev, seen.me),
      fibersUnderRoot: ev.of('node:created').filter((e) => e.parentId === ev.root.id && e.kind === 'fiber').map((e) => e.name),
    }).toEqual({
      log: ['made', 'slept', 'double(21) ran', 'double(21) ran', 'made through the root', 'double(4) ran'],
      values: { a: 42, b: 42, c: 8 },
      dropped: 'object',
      underMain: ['fiber double', 'fiber double'],
      fibersUnderRoot: ['main', 'double'],
    });
  });

  it('t(…) reads the slot when it is made: outside any node it throws NoCurrentNodeError, in a factory CreationViolationError', async () => {
    const double = task(function* double(n: number) {
      return n * 2;
    });
    class Eager {
      readonly made = outcomeOf(() => double(1));
    }
    const outside = outcomeOf(() => double(1));
    const inFactory = await within(app().call(function* () { return lookup(Eager).made; }), 2000);
    expect({ outside, inFactory }).toEqual({ outside: 'NoCurrentNodeError', inFactory: 'CreationViolationError' });
  });

  it('a task is a function object: isTask accepts it, its name is the task’s, call and bind are Function.prototype’s, fork and attempt are gone, with stays; fork(t, …) still forks it as a task', async () => {
    const double = task(function* double(n: number) {
      return n * 2;
    });
    const anonymous = task(function* () {
      return 1;
    });
    const byOption = task(
      function* body() {
        return 1;
      },
      { name: 'byOption' },
    );
    const renamed = double.with({ name: 'renamed' });
    const shape = (x: unknown) => ({
      typeof: typeof x,
      isTask: isTask(x),
      name: prop(x, 'name'),
      call: prop(x, 'call') === Function.prototype.call,
      bind: prop(x, 'bind') === Function.prototype.bind,
      fork: prop(x, 'fork'),
      attempt: prop(x, 'attempt'),
      with: typeof prop(x, 'with'),
    });
    const callable = (name: string) => ({
      typeof: 'function',
      isTask: true,
      name,
      call: true,
      bind: true,
      fork: undefined,
      attempt: undefined,
      with: 'function',
    });
    const ev = recorded();
    const forked = await within(
      ev.root.call(function* () {
        const f = fork(double, 21);
        // An inline body would carry the callable's name and return its op's 42 too: only the tree tells them apart.
        return { name: f.name, value: yield* join(f), tree: subtree(ev, current().id) };
      }),
      2000,
    );
    expect({
      double: shape(double),
      anonymous: shape(anonymous),
      byOption: shape(byOption),
      renamed: shape(renamed),
      notTasks: [isTask(function* () {}), isTask(() => 1), isTask({}), isTask(sleep)],
      forked,
    }).toEqual({
      double: callable('double'),
      anonymous: callable('anonymous'),
      byOption: callable('byOption'),
      renamed: callable('renamed'),
      notTasks: [false, false, false, false],
      forked: { name: 'double', value: 42, tree: ['fiber double'] },
    });
  });
});

describe('task(self, body) binds a receiver (decision 2)', () => {
  it('the body runs with this = self: it reads a #private field of the instance, with keeps the receiver, a class is a receiver too, and the node is named after the body or opts.name', async () => {
    class Api {
      static readonly label = 'Api';
      // In a static field `this` is the class, a function: the second argument being a function makes it the receiver.
      static readonly describe = task(this, function* describe() {
        return `class ${this.label}`;
      });
      readonly #base: string;
      readonly get = task(this, function* get(path: string) {
        yield* sleep(0);
        return `${this.#base}${path}`;
      });
      readonly getAgain = this.get.with({ name: 'getAgain' });
      readonly base = task(
        this,
        function* () {
          return this.#base;
        },
        { name: 'base' },
      );
      constructor(base: string) {
        this.#base = base;
      }
    }
    const ev = recorded();
    const seen = await within(
      ev.root.call(function* () {
        const a = new Api('https://a');
        const b = new Api('https://b');
        return {
          values: {
            a: yield* a.get('/users'),
            b: yield* b.get('/orders'),
            again: yield* a.getAgain('/again'),
            base: yield* b.base(),
            describe: yield* Api.describe(),
          },
          names: [a.get.name, a.getAgain.name, a.base.name, Api.describe.name],
          me: current().id,
        };
      }),
      2000,
    );
    expect({ values: seen.values, names: seen.names, fibers: subtree(ev, seen.me) }).toEqual({
      values: { a: 'https://a/users', b: 'https://b/orders', again: 'https://a/again', base: 'https://b', describe: 'class Api' },
      names: ['get', 'getAgain', 'base', 'describe'],
      fibers: ['fiber get', 'fiber get', 'fiber getAgain', 'fiber base', 'fiber describe'],
    });
  });
});
