// eslint-plugin-ramme: the hazards inside ramme bodies that look like plain
// JavaScript (`finally`, `using`, timers, `Promise` combinators) and the
// wiring errors syntax can see. What each rule flags, why, and its known
// approximations are in this package's README; the design is ramme's
// DESIGN.md §9 and DECISIONS.md D35.

import type { ESLint, Linter, Rule } from 'eslint';
import { noFinallyInAsync } from './rules/no-finally-in-async.js';
import { noOwnedProvider } from './rules/no-owned-provider.js';
import { noPromiseCombinators } from './rules/no-promise-combinators.js';
import { noStoredBorrow } from './rules/no-stored-borrow.js';
import { noTimers } from './rules/no-timers.js';
import { noUnusedOutcome } from './rules/no-unused-outcome.js';
import { noUsingInAsync } from './rules/no-using-in-async.js';

/** The rules, by name; each is `ramme/<name>` in a config. */
const rules = {
  'no-finally-in-async': noFinallyInAsync,
  'no-using-in-async': noUsingInAsync,
  'no-timers': noTimers,
  'no-promise-combinators': noPromiseCombinators,
  'no-stored-borrow': noStoredBorrow,
  'no-owned-provider': noOwnedProvider,
  'no-unused-outcome': noUnusedOutcome,
} satisfies Record<string, Rule.RuleModule>;

/** The default export's type. */
export interface RammePlugin extends ESLint.Plugin {
  meta: { name: string; version: string };
  rules: typeof rules;
  configs: {
    /** A flat config entry that registers the plugin as `ramme` and turns every rule on as an error. */
    recommended: Linter.Config;
  };
}

const plugin: RammePlugin = {
  meta: { name: 'eslint-plugin-ramme', version: '0.0.1' },
  rules,
  configs: { recommended: {} },
};

plugin.configs.recommended = {
  name: 'ramme/recommended',
  plugins: { ramme: plugin },
  rules: Object.fromEntries(Object.keys(rules).map((name): [string, Linter.RuleEntry] => [`ramme/${name}`, 'error'])),
};

export default plugin;
