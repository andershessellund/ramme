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
    expect(ruleFiles).toHaveLength(9);
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

  it('has a recommended flat config that registers the plugin as ramme and turns every rule on, each an error: the kept four, the two D41 adds and the three platform rules of D43, none of the async-only four D41 deletes (decision 14)', () => {
    const recommended = plugin.configs.recommended;
    expect(recommended.name).toBe('ramme/recommended');
    expect(recommended.plugins).toEqual({ ramme: plugin });
    expect(recommended.plugins?.ramme).toBe(plugin);
    expect(recommended.rules).toEqual({
      'ramme/no-async-body': 'error',
      'ramme/no-unused-op': 'error',
      'ramme/no-unused-outcome': 'error',
      'ramme/no-timers': 'error',
      'ramme/no-stored-borrow': 'error',
      'ramme/no-owned-provider': 'error',
      'ramme/no-bare-listener': 'error',
      'ramme/no-bare-fetch': 'error',
      'ramme/no-bare-async-iteration': 'error',
    });
    for (const gone of ['no-swallowed-interruption', 'no-finally-in-async', 'no-using-in-async', 'no-promise-combinators'])
      expect(Object.keys(plugin.rules), gone).not.toContain(gone);
    expect(Object.keys(recommended.rules ?? {}).sort()).toEqual(ruleFiles.map((n) => `ramme/${n}`));
  });
});

describe('configs.recommended in a flat config', () => {
  const code = [
    "import { setTimeout } from 'node:timers/promises';", //            1 no-timers
    'export const db = lookup(Db);', //                                  2 no-stored-borrow
    'const old = task(async () => {});', //                              3 no-async-body
    'const work = task(function* () {', //                               4
    '  try {', //                                                        5
    '    yield* call(step);', //                                         6
    '  } catch (e) {', //                                                7 (a catch is fine: it never sees the halt)
    '    log(e);', //                                                    8
    '  } finally {', //                                                  9 (a finally may wait: release work)
    '    yield* wait(done());', //                                      10
    '  }', //                                                           11
    '  current().addProvider(valueProvider(K, own(x)));', //            12 no-owned-provider
    '  yield* attempt(other);', //                                      13 no-unused-outcome
    '  call(sendEmail, user);', //                                      14 no-unused-op
    '});', //                                                           15
    "import { wait } from 'ramme';", //                                 16 (the file now uses ramme)
    "function* view(el, u) { el.addEventListener('click', h); yield* wait(fetch(u)); requestAnimationFrame(draw); }", // 17
    'async function read(s) { for await (const x of s) log(x); }', //   18 no-bare-async-iteration
  ].join('\n');

  it('reports each rule where it applies, at its severity (2, an error), and nothing for a catch or a finally in a generator body', () => {
    const linter = new Linter({ configType: 'flat' });
    const messages = linter.verify(
      code,
      [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser, sourceType: 'module' } }, plugin.configs.recommended],
      'example.ts',
    );
    expect(messages.map((m) => [m.line, m.ruleId, m.severity])).toEqual([
      [1, 'ramme/no-timers', 2],
      [2, 'ramme/no-stored-borrow', 2],
      [3, 'ramme/no-async-body', 2],
      [12, 'ramme/no-owned-provider', 2],
      [13, 'ramme/no-unused-outcome', 2],
      [14, 'ramme/no-unused-op', 2],
      [17, 'ramme/no-bare-listener', 2],
      [17, 'ramme/no-bare-fetch', 2],
      [17, 'ramme/no-timers', 2],
      [18, 'ramme/no-bare-async-iteration', 2],
    ]);
  });
});
