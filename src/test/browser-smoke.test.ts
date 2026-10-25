// browser-smoke.test.ts — the browser is a target (D41 decision 18; PROPOSAL.md §5.3, decision 19; D43), shown
// without a browser and without a dependency: the core and `ramme/platform` are run through their public entries on
// what a browser has, and the build output is checked to need nothing else.
//
// - A body runs the core's verbs together (`task`, `call`, `fork`, `join`, `sleep`, `wait`, `own`, DI with a declared
//   scope, a halt whose `finally` waits): nothing of it needs an adapter, a registration or a Node API.
// - PROPOSAL.md §5.4's search box (README.md, "The platform"), trimmed to a 20 ms debounce, runs on an `EventTarget`
//   and a stubbed `fetch`: `listen` re-enters the bodiless box, a keystroke halts the previous search at its `sleep`
//   or aborts its `fetch`.
// - Statically, on src/ as compiled for the run (src/test/build.ts, vitest's global setup, laid out as `pnpm build`'s
//   dist/ is, so a clean checkout needs no build and an edit is never checked stale): dist/index.js and
//   dist/platform.js, and every module they import, import
//   nothing from `node:` or a Node builtin (`async_hooks`), and read no global beyond ECMAScript 2022's but the host
//   APIs every evergreen browser has: `queueMicrotask`, `setTimeout`, `clearTimeout`, `AbortController`,
//   `AbortSignal`, `DOMException` and `console` (and, in dist/platform.js, `performance`). Development mode reads
//   `globalThis.process?.env`, never the name `process`. scripts/check-surface.mjs makes the same check.
//
// Deleting Node's globals around a run would prove little (the test runner itself needs them); the static check is
// what a browser would find missing.
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Linter } from 'eslint';
import type { Rule } from 'eslint';
import ts from 'typescript';
import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import type { Context, Fiber } from '../index.js';
import { RequestScope, createRootContext, fork, join, lookup, own, call, result, sleep, task, wait } from '../index.js';
import { fetch, listen } from '../platform.js';
import { trace, within } from './util.js';

const roots: Context[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
  vi.unstubAllGlobals();
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

describe('the browser is a target: the core and ramme/platform through their public entries', () => {
  it('a body runs task, call, fork, join, sleep, wait and own, with a request-scoped service, and a halt runs a finally that waits', async () => {
    const t = trace();
    let sessions = 0;
    class Session {
      static readonly scope = RequestScope; // stored on the request's node, released with it
      readonly id = ++sessions;
      constructor() {
        own(t.at(`session ${this.id} released`));
      }
    }
    const double = task(function* (n: number) {
      yield* sleep(1);
      return n * 2;
    });
    const handle = task(
      function* (n: number) {
        const session = lookup(Session);
        own(t.at(`request ${n} released`));
        const a = yield* call(double, n);
        const f = fork(double, n + 1);
        const b = yield* wait(Promise.resolve(10));
        const c = yield* join(f);
        return { session: session.id, sum: a + b + c, shared: lookup(Session) === session };
      },
      { scopes: [RequestScope] },
    );
    const slow = task(function* () {
      try {
        yield* sleep(10_000);
        t.push('after the sleep');
      } finally {
        t.push('finally');
        yield* wait(new Promise((resolve) => setTimeout(resolve, 2))); // release work: the halt lets it finish
        t.push('finally waited');
      }
    });
    const root = app();
    const seen = await within(
      root.call(function* () {
        const first = yield* call(handle, 1);
        const second = yield* call(handle, 2);
        const f = fork(slow);
        yield* sleep(1);
        f.abort();
        const halted = yield* result(f);
        return { first, second, halted: halted.status };
      }),
    );
    expect({ seen, log: t.log }).toEqual({
      seen: {
        first: { session: 1, sum: 2 + 10 + 4, shared: true },
        second: { session: 2, sum: 4 + 10 + 6, shared: true },
        halted: 'aborted',
      },
      log: ['request 1 released', 'session 1 released', 'request 2 released', 'session 2 released', 'finally', 'finally waited'],
    });
  });

  it("PROPOSAL.md §5.4's search box: listen re-enters the bodiless box, a keystroke halts the previous search at its debounce or aborts its fetch", async () => {
    const requests: { url: string; signal: AbortSignal; respond: (body: unknown) => void }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit): Promise<Response> => {
      const { promise, resolve, reject } = Promise.withResolvers<Response>();
      const signal = init!.signal!;
      requests.push({ url, signal, respond: (body) => resolve(new Response(JSON.stringify(body))) });
      signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
      return promise;
    });
    const shown: unknown[] = [];
    const errors: unknown[] = [];
    const search = task(function* (q: string) {
      yield* sleep(20); // debounce: a newer keystroke halts this run here
      const res = yield* fetch(`/search?q=${encodeURIComponent(q)}`); // a halt aborts the request
      shown.push(yield* wait(res.json()));
    });
    const input = Object.assign(new EventTarget(), { value: '' });
    const type = (value: string): void => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    const root = app();
    const box = root.child({ name: 'search-box' });
    let latest: Fiber<void> | undefined;
    box.run(() =>
      listen(input, 'input', () => {
        latest?.abort(); // the previous run stops at its sleep or its fetch
        latest = fork(search.with({ onFailure: (e) => void errors.push(e) }), input.value); // box is bodiless: a handler
      }),
    );
    type('a');
    type('ab'); // halts 'a' at its debounce: 'a' is never fetched
    while (requests.length < 1) await new Promise((r) => setTimeout(r, 1));
    type('abc'); // aborts the fetch of 'ab'
    while (requests.length < 2) await new Promise((r) => setTimeout(r, 1));
    requests[1]!.respond({ q: 'abc', hits: 3 });
    while (shown.length < 1) await new Promise((r) => setTimeout(r, 1));
    await within(box.close());
    expect({
      urls: requests.map((r) => r.url),
      aborted: requests.map((r) => r.signal.aborted),
      shown,
      errors,
      boxOutcome: box.outcome?.status,
    }).toEqual({
      urls: ['/search?q=ab', '/search?q=abc'],
      aborted: [true, false],
      shown: [{ q: 'abc', hits: 3 }],
      errors: [],
      boxOutcome: 'success',
    });
  });
});

describe('the browser is a target: the build output', () => {
  it('dist/index.js and dist/platform.js, and every module they import, import no Node module and read no global beyond ES2022 but the host APIs a browser has', () => {
    const dist = pathToFileURL(`${inject('builtDist')}/`); // src/ compiled for this run (src/test/build.ts)
    const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
    const core = ['queueMicrotask', 'setTimeout', 'clearTimeout', 'AbortController', 'AbortSignal', 'DOMException', 'console'];
    const name = (u: URL): string => `dist/${u.href.slice(dist.href.length)}`;
    // ESLint's scope analysis with ES2022's globals declared: what goes `through` the global scope is read from the host.
    const hostReads: Rule.RuleModule = {
      create: (context) => ({
        'Program:exit'() {
          for (const ref of context.sourceCode.scopeManager.globalScope!.through)
            context.report({ node: ref.identifier, message: ref.identifier.name });
        },
      }),
    };
    const linter = new Linter({ configType: 'flat' });
    const config: Linter.Config[] = [
      {
        plugins: { browser: { rules: { 'host-reads': hostReads } } },
        rules: { 'browser/host-reads': 'error' },
        languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
      },
    ];
    const reached: string[] = [];
    const problems: string[] = [];
    const reads = new Set<string>();
    const seenFiles = new Set<string>();
    const visit = (file: URL, importer: string): void => {
      if (seenFiles.has(file.href)) return;
      seenFiles.add(file.href);
      if (!existsSync(file)) {
        problems.push(`${name(file)} is missing (imported by ${importer}): the compile for the run did not emit it`);
        return;
      }
      reached.push(name(file));
      const code = readFileSync(file, 'utf8');
      const allowed = new Set(name(file) === 'dist/platform.js' ? [...core, 'performance'] : core);
      for (const m of linter.verify(code, config)) {
        if (m.ruleId !== 'browser/host-reads') problems.push(`${name(file)} does not parse as ES2022: ${m.message}`);
        else if (!allowed.has(m.message)) problems.push(`${name(file)} reads the global ${m.message}`);
        else reads.add(m.message);
      }
      for (const { fileName } of ts.preProcessFile(code, true, true).importedFiles) {
        if (fileName.startsWith('.')) visit(new URL(fileName, file), name(file));
        else if (fileName.startsWith('node:') || builtins.has(fileName)) problems.push(`${name(file)} imports ${fileName}`);
      }
    };
    for (const entry of ['index.js', 'platform.js']) visit(new URL(entry, dist), 'the browser entries');
    expect({
      problems,
      reachesBoth: ['dist/index.js', 'dist/platform.js'].every((f) => reached.includes(f)),
      // The check sees what it allows: the core does schedule with timers and microtasks and abort with signals.
      readsTheHostAPIs: ['queueMicrotask', 'setTimeout', 'AbortController', 'performance'].every((g) => reads.has(g)),
    }).toEqual({ problems: [], reachesBoth: true, readsTheHostAPIs: true });
  });
});
