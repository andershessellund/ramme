// Tests for observability / diagnostics.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wait } from '../../src/ambient.js';
import type { Body, Context, Fiber } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { valueProvider } from '../../src/provider-util.js';
import { NodeTopic } from '../../src/lifecycle-events.js';
import type { NodeEvent } from '../../src/lifecycle-events.js';
import { deferred, events, micro, tick } from '../support/util.js';

/** A fiber forked onto a bodiless node needs a destination other than 'join' (D14); 'link' surfaces failures. */
const linked = { onFailure: 'link' } as const;

/** Fork a body onto a bodiless node with the 'link' destination. */
function spawn<T>(on: Context, body: Body<T>, opts: Parameters<typeof task>[1] = {}): Fiber<T> {
  return on.fork(task(body, { ...linked, ...opts }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('stall diagnostics (DESIGN.md §4.4)', () => {
  it('node:stalled after stallWarningMs for a delivered freeze body whose wait(p) the halt lets finish and p never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const ev = events({ stallWarningMs: 100 });
    const gate = deferred();
    const f = spawn(ev.root, function* () { return yield* wait(gate.promise); });
    await micro();
    await micro();
    f.abort();
    vi.advanceTimersByTime(99);
    expect(ev.of('node:stalled')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(ev.of('node:stalled').map((e) => e.id)).toEqual([f.id]);
    expect(ev.of('node:stalled')[0].sinceMs).toBe(100);
    gate.resolve();
    vi.useRealTimers();
    await ev.root.close();
  });

  it('node:stalled for a slow release (a release fiber is a node)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const ev = events({ stallWarningMs: 50 });
    const gate = deferred();
    const N = ev.root.child();
    N.own(function slowRelease() {
      return gate.promise;
    });
    const closing = N.close();
    vi.advanceTimersByTime(50);
    const stalled = ev.of('node:stalled');
    expect(stalled).toHaveLength(1);
    expect(ev.of('node:created').find((e) => e.id === stalled[0].id)?.kind).toBe('release');
    gate.resolve();
    vi.useRealTimers();
    await closing;
    await ev.root.close();
  });

  it('stallWarningMs 0 disables the diagnostic', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const ev = events({ stallWarningMs: 0 });
    const gate = deferred();
    const f = spawn(ev.root, function* () { return yield* wait(gate.promise); });
    await micro();
    f.abort();
    vi.advanceTimersByTime(1e6);
    expect(ev.of('node:stalled')).toHaveLength(0);
    gate.resolve();
    vi.useRealTimers();
    await ev.root.close();
  });
});

// ---------------------------------------------------------------------------
describe('NodeTopic receivers are sinks (DESIGN.md §4.7, §5)', () => {
  it('a receiver that throws or returns a rejecting promise is reported with console.error; the tree completes and nothing rejects unhandled', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = new Error('receiver threw');
    const rejected = new Error('receiver rejected');
    const seen: string[] = [];
    let n = 0;
    const app = createRootContext({
      providers: [
        valueProvider(NodeTopic, (async (e: NodeEvent) => {
          seen.push(e.type);
          if (++n === 1) throw rejected; // an async receiver: a rejected promise, not a throw
        }) as (e: NodeEvent) => void),
      ],
    });
    const app2 = createRootContext({
      providers: [
        valueProvider(NodeTopic, () => {
          throw thrown;
        }),
      ],
    });
    await app.call(function* () { return 1; });
    await app2.call(function* () { return 2; });
    await app.close();
    await app2.close();
    await tick(); // the setup hook fails this test on an unhandled rejection (I10)
    expect(seen).toContain('node:complete');
    expect(app.state).toBe('complete');
    expect(app2.state).toBe('complete');
    const reported = errors.mock.calls.map((c) => c[1]);
    expect(reported).toContain(rejected);
    expect(reported).toContain(thrown);
  });
});
