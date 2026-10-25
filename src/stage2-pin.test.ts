// stage2-pin.test.ts — the pinning tests of D41's stage 2, the removal stage (PR 2 of the generator runtime's
// proposal, which is read at commit 5da90d8: DECISIONS.md's history note), written first.
//
// Each test asserts a fact of the generator runtime once async bodies, the async context, the bridge machinery and
// lending are gone, which stage 1 (generator bodies beside async ones, every op an eager promise) does not have yet:
// work ops are lazy, run by their consumer, `yield*` afresh each time and `then` once (decisions 2, 3); constructing a
// free-function op reads the synchronous slot (decision 17); the thenable is a plain `PromiseLike` that settles by the
// child's outcome (decisions 4, 16); an async function is no body (decision 5); `managed`, `InterruptedError` and
// `UnawaitedCallError` are gone (decisions 10, 16, 2); the halt rows 1–4 and the born-delivered step hold with lazy ops
// (decisions 8, 9); and the slot alone runs a body, with no storage registered (decision 18).
//
// The slot pin at the end runs in a fresh module graph, where nothing registered any storage (there is no registry).
//
// Each test first compares one observation object, so that a failure shows the whole of the behaviour in its diff.
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as ambientModule from './ambient.js';
import * as storageModule from './context-storage.js';
import * as core from './index.js';
import {
  FiberAbortedError,
  NoCurrentNodeError,
  all,
  attempt,
  call,
  createInjectionKey,
  createRootContext,
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
  result,
  settle,
  shield,
  signal,
  sleep,
  task,
  unshield,
  valueProvider,
  wait,
} from './index.js';
import type { Context, Fiber, Instruction, Op, Outcome } from './index.js';
import * as resourceModule from './resource.js';
import { events, tick, trace, within } from './test/util.js';
import type { EventLog, Trace } from './test/util.js';


/** Every `console.warn` of the current test, first argument only; the spy keeps them off the console. */
const warnings: string[] = [];
/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

beforeEach(() => {
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
});

afterEach(async () => {
  vi.restoreAllMocks();
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

/** A handler for forks onto the bodiless root (D14). */
const quiet = { onFailure: () => {} } as const;

/** A platform timer: a foreign promise, which no delivery touches. */
function bare(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `f`'s outcome, read from top level; pushes `complete` to `t` when it arrives. */
function completion<T>(root: Context, f: Fiber<T>, t: Trace): PromiseLike<Outcome<T>> {
  return root.result(f).then((o) => {
    t.push('complete');
    return o;
  });
}

/** The class name of what `make` throws, or `no error`. */
function thrownBy(make: () => unknown): string {
  try {
    make();
    return 'no error';
  } catch (e) {
    return e instanceof Error ? e.name : String(e);
  }
}

/** A refusal of an async body, as the observation reads it: `TypeError naming function*`, or what came instead. */
function refusal(e: unknown): string {
  if (e instanceof TypeError && e.message.includes('function*')) return 'TypeError naming function*';
  return e instanceof Error ? `${e.name}: ${e.message}` : `not an error: ${String(e)}`;
}

/** The `node:created` events of nodes running the task named `name`. */
function created(ev: EventLog, name: string): number {
  return ev.of('node:created').filter((e) => e.task === name).length;
}

/** A task that records its run in `ran` and returns its name. */
function work(ran: string[], name: string) {
  return task(
    function* () {
      ran.push(name);
      return name;
    },
    { name },
  );
}

describe('stage 2: work ops are lazy (decisions 2, 3)', () => {
  it('a work op made and dropped runs nothing: no child, no group, no member, no join, no timer, no call of the work function (call, attempt, all, race, settle, shield, unshield, join, result, sleep, wait)', async () => {
    const ran: string[] = [];
    const ev = recorded();
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    /** What making the op did in the step that made it: the events emitted and the timers armed meanwhile. */
    const seen: Record<string, { events: string[]; timers: number }> = {};
    function drop(name: string, make: () => unknown): void {
      const e0 = ev.log.length;
      const t0 = timeouts.mock.calls.length;
      make(); // made, never yielded nor awaited
      seen[name] = { events: ev.log.slice(e0).map((e) => e.type), timers: timeouts.mock.calls.length - t0 };
    }
    const target = task(function* () {}, { name: 'target' }); // a fiber to join; it records nothing
    const thenable = {
      then() {
        ran.push('thenable.then'); // what Promise.resolve(thenable) calls, a job after it is made
      },
    } as unknown as Promise<number>;
    const cases: Record<string, () => Generator<Instruction, void, unknown>> = {
      call: function* () {
        drop('call', () => call(work(ran, 'call')));
      },
      attempt: function* () {
        drop('attempt', () => attempt(work(ran, 'attempt')));
      },
      all: function* () {
        drop('all', () => all([work(ran, 'all member')]));
      },
      race: function* () {
        drop('race', () => race([work(ran, 'race member')]));
      },
      settle: function* () {
        drop('settle', () => settle([work(ran, 'settle member')]));
      },
      shield: function* () {
        drop('shield', () => shield(work(ran, 'shield')));
      },
      unshield: function* () {
        yield* shield(function* () {
          drop('unshield', () => unshield(work(ran, 'unshield'))); // inside a shield: its guard passes
        });
      },
      join: function* () {
        const f = fork(target);
        drop('join', () => join(f));
      },
      result: function* () {
        const f = fork(target);
        drop('result', () => result(f));
      },
      sleep: function* () {
        drop('sleep', () => sleep(50));
      },
      'wait(fn)': function* () {
        drop('wait(fn)', () =>
          wait(() => {
            ran.push('wait fn');
            return new Promise<number>(() => {});
          }),
        );
      },
      'wait(thenable)': function* () {
        drop('wait(thenable)', () => wait(thenable));
      },
    };
    const fibers = Object.entries(cases).map(([name, body]) => ev.root.fork(task(body, { name: `drops ${name}`, ...quiet })));
    const outcomes = await within(Promise.all(fibers.map((f) => ev.root.result(f))));
    await tick(3); // a member, a fork or a thenable's then would run by now
    const nothing = { events: [], timers: 0 };
    expect({ seen, ran: [...ran].sort(), outcomes: outcomes.map((o) => o.status) }).toEqual({
      seen: Object.fromEntries(Object.keys(cases).map((name) => [name, nothing])),
      ran: [],
      outcomes: Object.keys(cases).map(() => 'success'),
    });
  });

  it('decision 3: yield* of one op object runs it afresh each time, as a description; then runs it once per object, as a promise must, and nothing runs before then is called', async () => {
    let runs = 0;
    const count = task(
      function* () {
        return ++runs;
      },
      { name: 'count' },
    );
    let calls = 0;
    const root = app();
    const yielded = await within(
      root.call(function* () {
        const op = call(count);
        const first = yield* op;
        const second = yield* op;
        const w = wait(() => Promise.resolve(++calls));
        const third = yield* w;
        const fourth = yield* w;
        return { call: [first, second], runs, wait: [third, fourth], calls };
      }),
    );
    runs = 0;
    const op = root.call(count); // an explicit receiver: thenable
    const beforeThen = runs;
    const a = await op;
    const b = await op;
    expect({ yielded, then: { beforeThen, values: [a, b], runs } }).toEqual({
      yielded: { call: [1, 2], runs: 2, wait: [1, 2], calls: 2 },
      then: { beforeThen: 0, values: [1, 1], runs: 1 },
    });
  });
});

describe('stage 2: construction reads the slot; there is no async context (decisions 17, 18)', () => {
  it('decision 17: a free-function work op made outside any frame throws NoCurrentNodeError at construction, its message naming the cause and the three entry points; in a creation frame CreationViolationError; ctx.verb(…) made at top level runs under its receiver', async () => {
    const v = task(
      function* () {
        return 'v';
      },
      { name: 'v' },
    );
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    roots.push(root);
    const f = root.fork(v.with(quiet));
    await within(root.result(f));
    const makers: Record<string, () => unknown> = {
      call: () => call(v),
      attempt: () => attempt(v),
      all: () => all([v]),
      race: () => race([v]),
      settle: () => settle([v]),
      shield: () => shield(v),
      unshield: () => unshield(v),
      join: () => join(f),
      result: () => result(f),
      sleep: () => sleep(1),
      interrupted: () => interrupted(),
      never: () => never(),
      wait: () => wait(Promise.resolve(1)),
    };
    /** The class thrown, and, for NoCurrentNodeError, what its message fails to say (decision 18; spec B.2). */
    const outsideOf = (make: () => unknown): string => {
      try {
        make();
        return 'no error';
      } catch (e) {
        if (!(e instanceof NoCurrentNodeError)) return e instanceof Error ? e.name : String(e);
        const missing = Object.entries({
          'no async context': /no async context/i,
          await: /\bawait\b/,
          'an explicit receiver': /receiver/i,
          promised: /\bpromised\b/,
          'node.run': /\.run\b/,
        })
          .filter(([, re]) => !re.test(e.message))
          .map(([what]) => what);
        return missing.length === 0 ? 'NoCurrentNodeError' : `NoCurrentNodeError, its message missing: ${missing.join(', ')}`;
      }
    };
    const outside = Object.fromEntries(Object.entries(makers).map(([name, make]) => [name, outsideOf(make)]));
    const creation: Record<string, string> = {};
    const V = createInjectionKey<object>('V', {
      factory: () => {
        for (const [name, make] of Object.entries(makers)) creation[name] = thrownBy(make);
        return {};
      },
    });
    root.child().get(V);
    const receiver = {
      call: await root.call(v),
      attempt: await root.attempt(v),
      all: await root.all([v]),
      race: await root.race([v]),
      settle: await root.settle([v]),
      shield: await root.shield(v),
      join: await root.join(f),
      result: await root.result(f),
      sleep: await root.sleep(1),
      wait: await root.wait(Promise.resolve(2)),
    };
    const success = { status: 'success', value: 'v' };
    expect({ outside, creation, receiver }).toEqual({
      outside: Object.fromEntries(Object.keys(makers).map((name) => [name, 'NoCurrentNodeError'])),
      creation: Object.fromEntries(Object.keys(makers).map((name) => [name, 'CreationViolationError'])),
      receiver: {
        call: 'v',
        attempt: success,
        all: ['v'],
        race: 'v',
        settle: [success],
        shield: 'v',
        join: 'v',
        result: success,
        sleep: undefined,
        wait: 2,
      },
    });
  });

  it('decision 18: async code a step starts sees the step’s node until its first await and none after it: current() and every free function throw NoCurrentNodeError there', async () => {
    const v = task(
      function* () {
        return 'v';
      },
      { name: 'v' },
    );
    const K = createInjectionKey<string>('K');
    const root = createRootContext({ providers: [valueProvider(K, 'k')] });
    roots.push(root);
    const seen: { before?: string; after?: Record<string, string> } = {};
    const out = await within(
      root.call(function* () {
        const node = current();
        const plain = (async () => {
          seen.before = current() === node ? 'the step’s node' : 'another node'; // still inside the step: the slot is set
          await Promise.resolve();
          const after: Record<string, () => unknown> = {
            current: () => current(),
            signal: () => signal(),
            lookup: () => lookup(K),
            own: () => own({}, () => {}),
            fork: () => fork(v),
            sleep: () => sleep(1),
            wait: () => wait(Promise.resolve(1)),
            call: () => call(v),
          };
          seen.after = Object.fromEntries(Object.entries(after).map(([name, make]) => [name, thrownBy(make)]));
        })();
        yield* wait(plain);
        return 'done';
      }),
    );
    expect({ out, seen }).toEqual({
      out: 'done',
      seen: {
        before: 'the step’s node',
        after: {
          current: 'NoCurrentNodeError',
          signal: 'NoCurrentNodeError',
          lookup: 'NoCurrentNodeError',
          own: 'NoCurrentNodeError',
          fork: 'NoCurrentNodeError',
          sleep: 'NoCurrentNodeError',
          wait: 'NoCurrentNodeError',
          call: 'NoCurrentNodeError',
        },
      },
    });
  });
});

describe('stage 2: the thenable (decisions 4, 16)', () => {
  it('await op with an explicit receiver: the value; the failure, consumed; FiberAbortedError when the child ended aborted', async () => {
    const boom = new Error('boom');
    const ok = task(
      function* () {
        yield* sleep(1);
        return 'v';
      },
      { name: 'ok' },
    );
    const fails = task(
      function* () {
        yield* sleep(1);
        throw boom;
      },
      { name: 'fails' },
    );
    const slow = task(
      function* () {
        yield* never();
      },
      { name: 'slow' },
    );
    const root = app();
    const value = await within(root.call(ok));
    const failure = await within(root.call(fails).then(() => 'resolved', (e: unknown) => e));
    const aborted = await within(root.call(slow.with({ timeoutMs: 5 })).then(() => 'resolved', (e: unknown) => e));
    const closed = await within(root.close().then(() => 'closed clean', (e: unknown) => e)); // nothing left unconsumed
    expect({ value, failure, aborted: aborted instanceof FiberAbortedError ? 'FiberAbortedError' : aborted, closed }).toEqual({
      value: 'v',
      failure: boom,
      aborted: 'FiberAbortedError',
      closed: 'closed clean',
    });
  });

  it('an op made in a step and handed out is run by then as a child of its node, only when then is called: its value; and when that node is aborted, FiberAbortedError with its reason, never an interruption of the awaiter', async () => {
    const t = trace();
    const reason = new Error('hang up');
    let parentOfWork: Context | undefined;
    const handedWork = task(
      function* () {
        parentOfWork = current().parent;
        t.push('work ran');
        return 'w';
      },
      { name: 'work' },
    );
    let slowNode: Context | undefined;
    const slow = task(
      function* () {
        slowNode = current();
        t.push('slow running');
        yield* never();
      },
      { name: 'slow' },
    );
    const handed: { work?: Op<string>; slow?: Op<void> } = {};
    let workHost: Context | undefined;
    let slowHost: Context | undefined;
    const root = app();
    const f = root.fork(
      task(
        function* () {
          workHost = current();
          handed.work = call(handedWork); // made in the step, never yielded: runs nothing yet
          yield* never();
        },
        { name: 'hands out work', ...quiet },
      ),
    );
    const g = root.fork(
      task(
        function* () {
          slowHost = current();
          handed.slow = call(slow);
          yield* never();
        },
        { name: 'hands out slow', ...quiet },
      ),
    );
    await tick();
    const ranBeforeThen = [...t.log];
    const value = await within(handed.work!);
    const slowRun = handed.slow!.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await tick();
    const slowRunning = t.log.includes('slow running');
    g.abort(reason);
    const rejection = await within(slowRun);
    f.abort(reason);
    const outcomes = await within(Promise.all([root.result(f), root.result(g)]));
    /** An error or reason as a short string: the diff must not print a node an `OwnerInterrupt` carries. */
    const named = (x: unknown): unknown => (x === reason ? 'the abort reason' : x instanceof Error ? `${x.name}: ${x.message}` : x);
    expect({
      ranBeforeThen,
      value,
      workIsChildOfHost: parentOfWork !== undefined && parentOfWork === workHost,
      slowRunning,
      slowIsChildOfHost: slowNode?.parent !== undefined && slowNode.parent === slowHost,
      rejection: rejection instanceof Error ? rejection.name : rejection,
      rejectionReason: named((rejection as { reason?: unknown }).reason),
      outcomes: outcomes.map((o) => (o.status === 'defect' ? `defect: ${String(named(o.error))}` : o.status)),
    }).toEqual({
      ranBeforeThen: [],
      value: 'w',
      workIsChildOfHost: true,
      slowRunning: true,
      slowIsChildOfHost: true,
      rejection: 'FiberAbortedError',
      rejectionReason: 'the abort reason',
      outcomes: ['aborted', 'aborted'],
    });
  });

  it('a work op is a plain thenable: then only, no catch or finally, not a Promise', async () => {
    const root = app();
    const op = root.call(function* () {
      return 1;
    });
    const shape = {
      then: typeof op.then,
      iterable: typeof op[Symbol.iterator],
      catch: 'catch' in op,
      finally: 'finally' in op,
      promise: op instanceof Promise,
    };
    const value = await within(op);
    expect({ shape, value }).toEqual({
      shape: { then: 'function', iterable: 'function', catch: false, finally: false, promise: false },
      value: 1,
    });
  });
});

describe('stage 2: async bodies are refused (decision 5)', () => {
  it('an async function as a body is refused with a TypeError naming function*, wherever a body is run; an async release and an async failure handler are still waited for', async () => {
    /** An async body, cast to the body type so the test compiles where async bodies are a type error. */
    const asyncBody = (async () => 'ran') as unknown as () => Generator<Instruction, string, unknown>;
    const log: string[] = [];
    const root = app();
    const inBodies = await within(
      root.call(function* () {
        const seen: Record<string, string> = {};
        try {
          seen.call = `value ${yield* call(asyncBody)}`;
        } catch (e) {
          seen.call = refusal(e);
        }
        try {
          const o = yield* attempt(asyncBody);
          seen.attempt = o.status === 'defect' ? refusal(o.error) : o.status;
        } catch (e) {
          seen.attempt = refusal(e);
        }
        try {
          const o = yield* result(fork(asyncBody));
          seen.fork = o.status === 'defect' ? refusal(o.error) : o.status;
        } catch (e) {
          seen.fork = refusal(e);
        }
        try {
          seen.shield = `value ${yield* shield(asyncBody)}`;
        } catch (e) {
          seen.shield = refusal(e);
        }
        seen.unshield = yield* shield(function* () {
          try {
            const o = yield* unshield(asyncBody);
            return o.status === 'defect' ? refusal(o.error) : o.status;
          } catch (e) {
            return refusal(e);
          }
        });
        try {
          const [o] = yield* settle([task(asyncBody)]);
          seen['settle member'] = o.status === 'defect' ? refusal(o.error) : o.status;
        } catch (e) {
          seen['settle member'] = refusal(e);
        }
        try {
          const failures: unknown[] = [];
          const p = pool({ name: 'p', onFailure: (e) => void failures.push(e) });
          p.fork(asyncBody);
          yield* p.close();
          seen['pool.fork'] = failures.length === 0 ? 'no failure' : failures.map(refusal).join('; ');
        } catch (e) {
          seen['pool.fork'] = refusal(e);
        }
        try {
          const callback = promised(asyncBody);
          seen.promised = yield* wait(callback().then((v) => `value ${v}`, refusal));
        } catch (e) {
          seen.promised = refusal(e);
        }
        // Still waited for: a release or a failure handler may return a promise, a bare wait (spec A.1).
        yield* call(function* () {
          own({}, async () => {
            await Promise.resolve();
            log.push('async release ran to its end');
          });
        });
        return seen;
      }),
    );
    const topLevel = await within(root.call(asyncBody).then((v) => `value ${v}`, refusal));
    root.fork(
      task(
        function* () {
          throw new Error('fails');
        },
        {
          name: 'fails',
          onFailure: async () => {
            await Promise.resolve();
            log.push('async handler ran to its end');
          },
        },
      ),
    );
    await within(root.close());
    const refused = 'TypeError naming function*';
    expect({ inBodies, topLevel, log }).toEqual({
      inBodies: {
        call: refused,
        attempt: refused,
        fork: refused,
        shield: refused,
        unshield: refused,
        'settle member': refused,
        'pool.fork': refused,
        promised: refused,
      },
      topLevel: refused,
      log: ['async release ran to its end', 'async handler ran to its end'],
    });
  });
});

describe('stage 2: what goes (decisions 10, 16, 2, 18)', () => {
  it('managed, InterruptedError and UnawaitedCallError are not exported, nor registerContextStorage; a node has no managed method', () => {
    const has = (ns: object, names: string[]): string[] => names.filter((n) => n in ns);
    const root = app();
    expect({
      index: has(core, ['managed', 'InterruptedError', 'UnawaitedCallError', 'registerContextStorage']),
      ambient: has(ambientModule, ['managed']),
      resource: has(resourceModule, ['InterruptedError', 'UnawaitedCallError']),
      contextStorage: has(storageModule, ['registerContextStorage', 'NO_STORAGE_MESSAGE']),
      node: has(root, ['managed']),
    }).toEqual({ index: [], ambient: [], resource: [], contextStorage: [], node: [] });
  });

  it('types: the removed names do not compile; an async function is no body; a work op is a PromiseLike, not a Promise', () => {
    // Never called: `pnpm typecheck` checks it. While a name or an arm below still exists, its directive is unused (TS2578).
    const typeOnly = (): void => {
      // @ts-expect-error -- managed() is gone: wait(p, { abandon: true }) is the same wait (decision 10)
      type _Managed = typeof core.managed;
      // @ts-expect-error -- InterruptedError is gone: a halt is return(), never a rejection (decision 16)
      type _Interrupted = typeof core.InterruptedError;
      // @ts-expect-error -- UnawaitedCallError is gone with lending: an unconsumed work op runs nothing (decision 2)
      type _Unawaited = typeof core.UnawaitedCallError;
      // @ts-expect-error -- registerContextStorage is gone: there is no async context (decision 18)
      type _Register = typeof core.registerContextStorage;
      // @ts-expect-error -- ctx.managed is gone (decision 10)
      type _CtxManaged = Context['managed'];
      const root = createRootContext();
      // @ts-expect-error -- an async function is no body (decision 5, spec A.1)
      task(async () => 1);
      // @ts-expect-error -- an async function is no body
      fork(async () => 1);
      // @ts-expect-error -- an async function is no body
      call(async () => 1);
      // @ts-expect-error -- an async function is no body
      attempt(async () => 1);
      // @ts-expect-error -- an async function is no body
      shield(async () => 1);
      // @ts-expect-error -- an async function is no body
      unshield(async () => 1);
      // @ts-expect-error -- an async function is no body
      promised(async () => 1);
      // @ts-expect-error -- an async function is no body
      root.call(async () => 1);
      const op = root.call(function* () {
        return 1;
      });
      const _thenable: PromiseLike<number> = op;
      expectTypeOf<Awaited<typeof op>>().toEqualTypeOf<number>();
      // @ts-expect-error -- a work op is a plain thenable: no catch (decision 4)
      const _catch = op.catch;
      // @ts-expect-error -- a work op is a plain thenable: no finally (decision 4)
      const _finally = op.finally;
      // @ts-expect-error -- a work op is no Promise (decision 4)
      const _promise: Promise<number> = op;
    };
    expect(typeof typeOnly).toBe('function');
  });
});

describe('stage 2: the halt with lazy ops (decisions 8, 9; DESIGN.md §4.2)', () => {
  it('row 1: a sleep arms its timer at its yield*, not when made, and the halt returns the body at once and clears it; wait(fn, { abandon: true }) calls fn at its yield*', async () => {
    const sleeperLog = trace();
    const abandonsLog = trace();
    const reason = new Error('hang up');
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const clears = vi.spyOn(globalThis, 'clearTimeout');
    /** The timers armed for 10 s, by the id setTimeout returned. */
    const armed = (): unknown[] =>
      timeouts.mock.calls.flatMap((c, i) => (c[1] === 10_000 ? [timeouts.mock.results[i]?.value as unknown] : []));
    const timers: Record<string, number> = {};
    const root = app();
    const sleeper = root.fork(
      task(
        function* () {
          const pause = sleep(10_000);
          timers.made = armed().length;
          try {
            yield* pause; // armed here; returned here at once
            sleeperLog.push('unreachable');
          } finally {
            timers.atHalt = armed().length;
            sleeperLog.push('finally');
          }
        },
        { name: 'sleeper', ...quiet },
      ),
    );
    const abandons = root.fork(
      task(
        function* () {
          const w = wait(
            (s) => {
              abandonsLog.push('fn called');
              return new Promise<string>((_, reject) => s.addEventListener('abort', () => reject(s.reason), { once: true }));
            },
            { abandon: true },
          );
          abandonsLog.push('made');
          try {
            yield* w; // fn is called here; returned here at once
            abandonsLog.push('unreachable');
          } finally {
            abandonsLog.push('finally');
          }
        },
        { name: 'abandons', ...quiet },
      ),
    );
    await tick();
    for (const log of [sleeperLog, abandonsLog]) log.push('aborting');
    sleeper.abort(reason);
    abandons.abort(reason);
    const outcomes = await within(Promise.all([root.result(sleeper), root.result(abandons)]), 500); // not after 10 s
    const ids = armed();
    expect({
      sleeper: sleeperLog.log,
      abandons: abandonsLog.log,
      timers,
      cleared: ids.length > 0 && ids.every((id) => clears.mock.calls.some(([c]) => c === id)),
      outcomes,
    }).toEqual({
      sleeper: ['aborting', 'finally'],
      abandons: ['made', 'fn called', 'aborting', 'finally'],
      timers: { made: 0, atHalt: 1 },
      cleared: true,
      outcomes: [
        { status: 'aborted', reason },
        { status: 'aborted', reason },
      ],
    });
  });

  it('row 2: a call starts at its yield*, synchronously, not when made; halted, the body is returned once the callee has completed: no catch runs, its finally after the callee’s', async () => {
    const t = trace();
    const reason = new Error('hang up');
    let slowNode: Context | undefined;
    const slow = task(
      function* () {
        slowNode = current();
        t.push('slow running');
        try {
          yield* never();
        } finally {
          t.push('slow finally');
        }
      },
      { name: 'slow' },
    );
    const root = app();
    const f = root.fork(
      task(
        function* () {
          const c = call(slow);
          t.push('made');
          try {
            yield* c; // slow starts here
            t.push('unreachable');
          } catch {
            t.push('caught');
          } finally {
            t.push(`finally; slow ${String(slowNode?.state)}`);
          }
        },
        { name: 'caller', ...quiet },
      ),
    );
    await tick();
    const done = completion(root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({ log: t.log, outcome: o }).toEqual({
      log: ['made', 'slow running', 'slow finally', 'finally; slow complete', 'complete'],
      outcome: { status: 'aborted', reason },
    });
  });

  it('row 3: a halted wait(p) lets p finish, the body runs on to its next yield*, and is returned there without running that op (A.2’s late call, not started)', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const ran: string[] = [];
    const ev = recorded();
    const f = ev.root.fork(
      task(
        function* () {
          t.push('waiting');
          const v = yield* wait(bare(20).then(() => 'driver value'));
          t.push(`bare work with ${v}`); // runs: the halt let p finish (decision 10)
          yield* call(work(ran, 'late call')); // returned here: not run
          t.push('unreachable');
        },
        { name: 'bare-after-halt', ...quiet },
      ),
    );
    await tick();
    const done = completion(ev.root, f, t);
    f.abort(reason);
    await tick(2);
    const meanwhile = [...t.log]; // not returned at the halt: still waiting for p
    const o = await within(done);
    expect({ meanwhile, log: t.log, outcome: o, ran, created: created(ev, 'late call') }).toEqual({
      meanwhile: ['waiting'],
      log: ['waiting', 'bare work with driver value', 'complete'],
      outcome: { status: 'aborted', reason },
      ran: [],
      created: 0,
    });
  });

  it('row 4: a body that delivers its own node inside its step is returned at its next yield*, without running that op', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const ran: string[] = [];
    const ev = recorded();
    const f = ev.root.fork(
      task(
        function* () {
          try {
            current().abort(reason); // delivered inside its own step
            t.push('after the abort');
            yield* call(work(ran, 'after own abort')); // returned here: not run
            t.push('unreachable');
          } finally {
            t.push('finally');
          }
        },
        { name: 'self-abort', ...quiet },
      ),
    );
    const o = await within(completion(ev.root, f, t));
    expect({ log: t.log, outcome: o, ran, created: created(ev, 'after own abort') }).toEqual({
      log: ['after the abort', 'finally', 'complete'],
      outcome: { status: 'aborted', reason },
      ran: [],
      created: 0,
    });
  });

  it('decision 9: a body born delivered is stepped to its first yield* of an op not yet started and returned there without running it; a wait(p) on the way finishes first (row 5)', async () => {
    const t = trace();
    const reason = new Error('hang up');
    const ran: string[] = [];
    const ev = recorded();
    let bornNode: Context | undefined;
    let bornDelivered: boolean | undefined;
    const born = task(
      function* () {
        bornNode = current();
        bornDelivered = signal().aborted;
        t.push('born: first step');
        const v = yield* wait(bare(5).then(() => 'v')); // a wait(p) on the way: subscribed, and it finishes
        t.push(`born: resumed with ${v}`);
        try {
          yield* call(work(ran, 'born’s call')); // returned here: not run
          t.push('born: unreachable');
        } finally {
          t.push('born: finally');
        }
      },
      { name: 'born' },
    );
    const f = ev.root.fork(
      task(
        function* () {
          yield* wait(bare(20)); // halted meanwhile: p finishes and the body is resumed, its node delivered
          t.push('parent resumed');
          fork(born); // a freeze child of a delivered node: born delivered (D12); fork is eager
          yield* sleep(1); // returned here
          t.push('unreachable');
        },
        { name: 'parent', ...quiet },
      ),
    );
    await tick();
    const done = completion(ev.root, f, t);
    f.abort(reason);
    const o = await within(done);
    expect({
      log: t.log,
      outcome: o,
      bornDelivered,
      born: bornNode?.outcome,
      ran,
      created: created(ev, 'born’s call'),
    }).toEqual({
      log: ['parent resumed', 'born: first step', 'born: resumed with v', 'born: finally', 'complete'],
      outcome: { status: 'aborted', reason },
      bornDelivered: true,
      born: { status: 'aborted', reason },
      ran: [],
      created: 0,
    });
  });
});

describe('stage 2: the slot alone (decision 18)', () => {
  it('in a module graph where nothing registered any storage and nothing imported ./node.js, a generator body runs: current() names its node across its yield*s, a fork’s body sees its parent, and node.run re-enters it', async () => {
    vi.resetModules(); // a fresh module graph: the registration at the top of this file is not in it
    const m = await import('./index.js');
    const root = m.createRootContext();
    const seen = await within(
      root
        .call(function* () {
          const node = m.current();
          yield* m.sleep(1);
          const same = m.current() === node;
          const f = m.fork(
            m.task(function* () {
              yield* m.wait(Promise.resolve());
              return m.current().parent === node;
            }),
          );
          const forkSawParent = yield* m.join(f);
          const reentered = node.run(() => m.current() === node);
          return { same, forkSawParent, reentered };
        })
        .then(
          (v) => v,
          (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
        ),
    );
    await within(root.close().then(undefined, () => {}));
    expect(seen).toEqual({ same: true, forkSawParent: true, reentered: true });
  });
});
