// Tests for platform / browser imports.
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import type { Context } from '../../src/context.js';
import { within } from '../support/util.js';

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

afterEach(async () => {
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
  vi.unstubAllGlobals();
});

// --- the browser is a target ---------------------------------------------------------------------------------------

describe('the browser is a target', () => {
  it('dist/index.js and dist/platform.js, and every module they import, import nothing from node: or a Node builtin such as async_hooks', () => {
    // src/ compiled for this run (tests/support/build.ts), laid out as dist/ is: never a missing or stale `pnpm build`.
    const dist = pathToFileURL(`${inject('builtDist')}/`);
    const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
    const name = (u: URL): string => `dist/${u.href.slice(dist.href.length)}`;
    const reached: string[] = [];
    const problems: string[] = [];
    const seenFiles = new Set<string>();
    const visit = (file: URL, importer: string): void => {
      if (seenFiles.has(file.href)) return;
      seenFiles.add(file.href);
      if (!existsSync(file)) {
        problems.push(`${name(file)} is missing (imported by ${importer}): the compile for the run did not emit it`);
        return;
      }
      reached.push(name(file));
      // TypeScript's own scanner: static imports and re-exports, `import()` and `require()`, never a comment or string.
      for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
        if (fileName.startsWith('.')) visit(new URL(fileName, file), name(file));
        else if (fileName.startsWith('node:') || builtins.has(fileName)) problems.push(`${name(file)} imports ${fileName}`);
      }
    };
    for (const entry of ['index.js', 'platform.js']) visit(new URL(entry, dist), 'the browser entries');
    expect({ problems, reachesBoth: ['dist/index.js', 'dist/platform.js'].every((f) => reached.includes(f)) }).toEqual({
      problems: [],
      reachesBoth: true,
    });
  });
});
