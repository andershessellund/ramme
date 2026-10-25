// ---------------------------------------------------------------------------
// The benchmark: what a wait, a node and a release cost, in nanoseconds per
// operation, against the build output. Run by `pnpm bench`, which builds
// first. Dev-only, with no dependency: Node's `performance.now()` times each
// case, and the best of five runs is reported, after one run to warm up. The
// numbers are indicative (one machine, one Node, nothing isolated); DESIGN.md
// §7.1 records a run.
//
// (a) `yield*` of a settled op: `join(f)` of a fiber that has completed, so
//     the wait's source has settled and the body resumes in its reaction.
// (b) `yield* call(syncTask)`: a node made, its synchronous body run, and the
//     node completed.
// (c) `yield* sleep(0)`: a timer armed and fired (the platform clamps it to
//     about a millisecond, so this one measures the platform).
// (d) `yield* wait(Promise.resolve())`: a foreign promise.
// (e) A `promised` round trip: top-level code calls a `promised` callback and
//     awaits its promise, a node per call.
// (f) `own` and `yield* release` of a passive entry: the entry and its
//     release fiber.
//
// Each case runs in development mode and in production mode (D30), which
// skips the development checks (the lost-halt detector among them).
// `--quick` runs a tenth of the iterations.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const entry = new URL('../dist/index.js', import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  console.error('bench: dist/index.js is missing; run `pnpm build` first');
  process.exit(1);
}
const { createRootContext, fork, join, call, own, release, sleep, task, wait } = await import(entry.href);

const RUNS = 5;
const scale = process.argv.includes('--quick') ? 0.1 : 1;
const noop = () => {};
const syncTask = task(() => 1, { name: 'syncTask' });

/**
 * The cases. A `body` runs inside one `app.call`, timing its own loop of `n` operations and returning the elapsed
 * milliseconds; `top` does the same from top-level code, given the root.
 */
const cases = [
  {
    id: 'a',
    name: 'yield* of a settled op (join of a completed fiber)',
    n: 200_000,
    body: function* (n) {
      const f = fork(function* () {
        return 1;
      });
      yield* join(f);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) yield* join(f);
      return performance.now() - t0;
    },
  },
  {
    id: 'b',
    name: 'yield* call(syncTask): a node made and completed',
    n: 100_000,
    body: function* (n) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) yield* call(syncTask);
      return performance.now() - t0;
    },
  },
  {
    id: 'c',
    name: 'yield* sleep(0)',
    n: 200,
    body: function* (n) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) yield* sleep(0);
      return performance.now() - t0;
    },
  },
  {
    id: 'd',
    name: 'yield* wait(Promise.resolve())',
    n: 200_000,
    body: function* (n) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) yield* wait(Promise.resolve(i));
      return performance.now() - t0;
    },
  },
  {
    id: 'e',
    name: 'a promised round trip, from top-level code',
    n: 100_000,
    top: async (app, n) => {
      const callback = app.promised(function* () {
        return 1;
      });
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await callback();
      return performance.now() - t0;
    },
  },
  {
    id: 'f',
    name: 'own and yield* release of a passive entry',
    n: 100_000,
    body: function* (n) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) yield* release(own({}, noop));
      return performance.now() - t0;
    },
  },
];

/**
 * One run of a case on a fresh root: nanoseconds per operation. The root is disposed as `await using` would (D41,
 * decision 32), spelled out because Node 22, which package.json's `engines` allows, does not parse `await using`.
 */
async function runOnce(c, n) {
  const app = createRootContext({ name: `bench-${c.id}` });
  try {
    const ms = c.top !== undefined ? await c.top(app, n) : await app.call(c.body, n);
    return (ms * 1e6) / n;
  } finally {
    await app[Symbol.asyncDispose]();
  }
}

/** The best of `RUNS` runs, after one to warm up, in the given development mode. */
async function best(c, mode) {
  const saved = process.env.NODE_ENV;
  if (mode === 'production') process.env.NODE_ENV = 'production';
  else delete process.env.NODE_ENV;
  try {
    const n = Math.max(1, Math.round(c.n * scale));
    await runOnce(c, n);
    let min = Infinity;
    for (let r = 0; r < RUNS; r++) min = Math.min(min, await runOnce(c, n));
    return min;
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

const format = (ns) => (ns >= 10_000 ? Math.round(ns).toLocaleString('en-US') : ns.toFixed(0));
const rows = [];
for (const c of cases) rows.push([`(${c.id}) ${c.name}`, format(await best(c, 'development')), format(await best(c, 'production'))]);

const width = Math.max(...rows.map((r) => r[0].length));
console.log(`ramme bench: Node ${process.version}, ${platform()} ${arch()}; ns per operation, best of ${RUNS}${scale < 1 ? ' (--quick)' : ''}`);
console.log(`${''.padEnd(width)}  ${'development'.padStart(11)}  ${'production'.padStart(10)}`);
for (const [name, dev, prod] of rows) console.log(`${name.padEnd(width)}  ${dev.padStart(11)}  ${prod.padStart(10)}`);
