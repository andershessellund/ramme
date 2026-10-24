import { readFileSync, readdirSync } from 'node:fs';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import plugin from './index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
const ruleFiles = readdirSync(new URL('./rules/', import.meta.url))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => f.slice(0, -'.ts'.length))
  .sort();

describe('the plugin object', () => {
  it('names itself as package.json does', () => {
    expect(plugin.meta).toEqual({ name: pkg.name, version: pkg.version });
  });

  it('exports every rule module in src/rules, under its file name', () => {
    expect(Object.keys(plugin.rules).sort()).toEqual(ruleFiles);
    expect(ruleFiles).toHaveLength(8);
  });

  it('gives every rule the flat-config metadata', () => {
    for (const [name, rule] of Object.entries(plugin.rules)) {
      expect(rule.meta?.type, name).toBe('problem');
      expect(rule.meta?.schema, name).toEqual([]);
      expect(rule.meta?.docs?.description, name).toBeTruthy();
      expect(rule.meta?.docs?.url, name).toMatch(new RegExp(`/packages/eslint-plugin-ramme/README\\.md#${name}$`));
      expect(Object.keys(rule.meta?.messages ?? {}).length, name).toBeGreaterThan(0);
    }
  });

  it('has a recommended flat config that registers the plugin as ramme and turns every rule on, three of them as warnings (D39)', () => {
    const recommended = plugin.configs.recommended;
    expect(recommended.name).toBe('ramme/recommended');
    expect(recommended.plugins).toEqual({ ramme: plugin });
    expect(recommended.plugins?.ramme).toBe(plugin);
    expect(recommended.rules).toEqual({
      'ramme/no-swallowed-interruption': 'error',
      'ramme/no-finally-in-async': 'warn',
      'ramme/no-using-in-async': 'warn',
      'ramme/no-timers': 'error',
      'ramme/no-promise-combinators': 'warn',
      'ramme/no-stored-borrow': 'error',
      'ramme/no-owned-provider': 'error',
      'ramme/no-unused-outcome': 'error',
    });
    expect(Object.keys(recommended.rules ?? {}).sort()).toEqual(ruleFiles.map((n) => `ramme/${n}`));
  });
});

describe('configs.recommended in a flat config', () => {
  const code = [
    "import { setTimeout } from 'node:timers/promises';", //            1 no-timers
    'export const db = lookup(Db);', //                                  2 no-stored-borrow
    'const work = task(async () => {', //                                3
    '  await using lock = acquire();', //                                4 no-using-in-async
    '  try {', //                                                        5
    '    await Promise.race([a, b]);', //                                6 no-promise-combinators
    '  } catch (e) {', //                                                7 no-swallowed-interruption
    '    log(e);', //                                                    8
    '  } finally {', //                                                  9 no-finally-in-async
    '    done();', //                                                   10
    '  }', //                                                           11
    '  current().addProvider(valueProvider(K, own(x)));', //            12 no-owned-provider
    '  await attempt(other);', //                                       13 no-unused-outcome
    '});', //                                                           14
  ].join('\n');

  it('reports each rule where it applies, at its severity: 2 for an error, 1 for a warning', () => {
    const linter = new Linter({ configType: 'flat' });
    const messages = linter.verify(
      code,
      [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser, sourceType: 'module' } }, plugin.configs.recommended],
      'example.ts',
    );
    expect(messages.map((m) => [m.line, m.ruleId, m.severity])).toEqual([
      [1, 'ramme/no-timers', 2],
      [2, 'ramme/no-stored-borrow', 2],
      [4, 'ramme/no-using-in-async', 1],
      [6, 'ramme/no-promise-combinators', 1],
      [7, 'ramme/no-swallowed-interruption', 2],
      [9, 'ramme/no-finally-in-async', 1],
      [12, 'ramme/no-owned-provider', 2],
      [13, 'ramme/no-unused-outcome', 2],
    ]);
  });
});
