// eslint-plugin-ramme: what syntax can see of ramme's rules for generator
// bodies (D41): an `async` function where a body is expected, a work op made
// and never consumed, an outcome discarded, a bare timer, and the wiring
// errors of DI. What each rule flags, why, and its known approximations are in
// this package's README; the design is ramme's DESIGN.md §9 and DECISIONS.md
// D35, D41.

import type { ESLint, Linter, Rule } from 'eslint';
import { noAsyncBody } from './rules/no-async-body.js';
import { noOwnedProvider } from './rules/no-owned-provider.js';
import { noStoredBorrow } from './rules/no-stored-borrow.js';
import { noTimers } from './rules/no-timers.js';
import { noUnusedOp } from './rules/no-unused-op.js';
import { noUnusedOutcome } from './rules/no-unused-outcome.js';

/** The rules, by name; each is `ramme/<name>` in a config. */
const rules = {
  'no-async-body': noAsyncBody,
  'no-unused-op': noUnusedOp,
  'no-unused-outcome': noUnusedOutcome,
  'no-timers': noTimers,
  'no-stored-borrow': noStoredBorrow,
  'no-owned-provider': noOwnedProvider,
} satisfies Record<string, Rule.RuleModule>;

/**
 * Each rule's severity in `recommended` (D35, D41): every rule is an error. The rules that warned (`finally`, `using`
 * and `Promise` combinators in async bodies) went with async bodies (D41, decision 14).
 */
const severities: Record<keyof typeof rules, Linter.RuleSeverity> = {
  'no-async-body': 'error',
  'no-unused-op': 'error',
  'no-unused-outcome': 'error',
  'no-timers': 'error',
  'no-stored-borrow': 'error',
  'no-owned-provider': 'error',
};

/** The default export's type. */
export interface RammePlugin extends ESLint.Plugin {
  meta: { name: string; version: string };
  rules: typeof rules;
  configs: {
    /** A flat config entry that registers the plugin as `ramme` and turns every rule on, at its severity in the README. */
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
  rules: Object.fromEntries(
    (Object.keys(rules) as (keyof typeof rules)[]).map((name): [string, Linter.RuleEntry] => [`ramme/${name}`, severities[name]]),
  ),
};

export default plugin;
