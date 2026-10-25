// build.ts — vitest's global setup: the build the browser checks read (src/test/browser-smoke.test.ts,
// src/stage4-pin.test.ts). It compiles src/ as `pnpm build` does (tsconfig.json), JavaScript only, into a temporary
// directory laid out as dist/ is, and provides its path as `builtDist`. So `pnpm test` checks the sources it tests, on
// a clean checkout and after an edit alike, never a missing or stale dist/; `pnpm check:surface` makes the same check
// on dist/ itself, after `pnpm build`. The directory is removed when the run ends.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The directory src/ was compiled into for this run, laid out as dist/ is. */
    builtDist: string;
  }
}

function message(d: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(d.messageText, '\n');
}

export default function setup(project: TestProject): () => void {
  const out = mkdtempSync(join(tmpdir(), 'ramme-test-build-'));
  const config = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    { outDir: out, noEmit: false, declaration: false, declarationMap: false, sourceMap: false },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(`src/test/build.ts: ${message(d)}`);
      },
    },
  );
  if (parsed === undefined || parsed.errors.length > 0)
    throw new Error(`src/test/build.ts: tsconfig.json does not parse: ${(parsed?.errors ?? []).map(message).join('; ')}`);
  const emitted = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options }).emit();
  if (emitted.emitSkipped) throw new Error(`src/test/build.ts: the compile emitted nothing: ${emitted.diagnostics.map(message).join('; ')}`);
  project.provide('builtDist', out);
  return () => rmSync(out, { recursive: true, force: true });
}
