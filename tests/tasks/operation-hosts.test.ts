// Tests for tasks / operation hosts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, attempt, current, fork, interrupted, join, never, race, result, settle, shield, sleep, wait } from '../../src/ambient.js';
import type { Context, Fiber } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { fetch, nextFrame } from '../../src/platform.js';
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
