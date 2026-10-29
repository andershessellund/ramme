// scripts.test.ts — the repository's dev scripts (scripts/*.mjs), which no other suite runs.
//
// - Every script parses as ECMAScript 2024, a grammar Node 22 parses: package.json's `engines` allows Node 22, and
//   `pnpm bench` once stopped there before its first case, on an `await using` (explicit resource management), which
//   no Node before 24 parses.
// - check-docs's resolver (scripts/doc-references.mjs) sends a reference that `D41` immediately precedes to D41's
//   record, the deleted proposal, so the check fails it. It searches the text before the reference's `§`, where a
//   lookahead for that `§` never matched, and such references passed as DESIGN.md ones. check-docs skips this file:
//   its strings are such references.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

const scripts = new URL('../../scripts/', import.meta.url);

describe('the dev scripts', () => {
  it('every script parses as ECMAScript 2024, which Node 22, the oldest Node package.json allows, parses', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { engines: { node: string } };
    const linter = new Linter({ configType: 'flat' });
    const config: Linter.Config[] = [{ languageOptions: { ecmaVersion: 2024, sourceType: 'module' } }];
    const files = readdirSync(fileURLToPath(scripts))
      .filter((f) => f.endsWith('.mjs'))
      .sort();
    const problems = files.flatMap((f) =>
      linter.verify(readFileSync(new URL(f, scripts), 'utf8'), config).map((m) => `${f}:${m.line}: ${m.message}`),
    );
    expect({ engines: pkg.engines.node, bench: files.includes('bench.mjs'), problems }).toEqual({
      engines: '>=22',
      bench: true,
      problems: [],
    });
  });

  it('check-docs resolves a reference that D41 immediately precedes to D41’s record, and the rest as before', async () => {
    const { target } = (await import(new URL('doc-references.mjs', scripts).href)) as {
      target: (text: string, i: number) => string;
    };
    /** The document the `n`th `§` of `text` names. */
    const names = (text: string, n = 0): string => {
      let i = -1;
      for (let k = 0; k <= n; k++) i = text.indexOf('§', i + 1);
      return target(text, i);
    };
    expect({
      parenthesised: names('see (D41 §5.4) there'),
      bare: names('D41 §4.1'),
      unspaced: names('D41§4'),
      afterADesignReference: [names('(DESIGN.md §6; D41 §4)', 0), names('(DESIGN.md §6; D41 §4)', 1)],
      primed: names('(D41′ §2.3)'),
      decisionNumberThenDocument: names('(D41, decision 4; DESIGN.md §4.2)'),
      decisionWithoutRecord: names('(D13′ §4.2)'),
      documentAcrossADecision: names('README.md, D13 §2'),
      document: names('DECISIONS.md §2'),
      unqualified: names('a halt (§4.2) ends it'),
      endedByAWord: names('PROPOSAL.md says so; the halt §4.2'),
    }).toEqual({
      parenthesised: 'PROPOSAL.md',
      bare: 'PROPOSAL.md',
      unspaced: 'PROPOSAL.md',
      afterADesignReference: ['DESIGN.md', 'PROPOSAL.md'],
      primed: 'PROPOSAL.md',
      decisionNumberThenDocument: 'DESIGN.md',
      decisionWithoutRecord: 'DESIGN.md',
      documentAcrossADecision: 'README.md',
      document: 'DECISIONS.md',
      unqualified: 'DESIGN.md',
      endedByAWord: 'DESIGN.md',
    });
  });
});
