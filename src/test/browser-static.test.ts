// browser-static.test.ts — the browser is a target (D41, decisions 18 and 19; D43), checked statically: the half of
// the browser check that reads files, so it runs under Node only. browser-smoke.test.ts is the half that runs, under
// Node in `pnpm test` and in headless Chromium in `pnpm test:browser`.
//
// On src/ as compiled for the run (src/test/build.ts, vitest's global setup, laid out as `pnpm build`'s dist/ is, so a
// clean checkout needs no build and an edit is never checked stale): dist/index.js and dist/platform.js, and every
// module they import, import nothing from `node:` or a Node builtin (`async_hooks`), and read no global beyond
// ECMAScript 2022's but the host APIs every evergreen browser has: `queueMicrotask`, `setTimeout`, `clearTimeout`,
// `AbortController`, `AbortSignal`, `DOMException` and `console` (and, in dist/platform.js, `performance`).
// Development mode reads `globalThis.process?.env`, never the name `process`. scripts/check-surface.mjs makes the same
// check on dist/ itself.
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Linter } from 'eslint';
import type { Rule } from 'eslint';
import ts from 'typescript';
import { describe, expect, inject, it } from 'vitest';

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
