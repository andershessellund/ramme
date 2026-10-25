// eslint-plugin-ramme: what syntax can see of ramme's rules for generator
// bodies (D41): an `async` function where a body is expected, a work op made
// and never consumed (a dropped task's call, with type information), an
// outcome discarded, a bare timer, a generator helper (D44: ramme has none),
// the wiring errors of DI, and the platform's bare waits and callbacks, which
// `ramme/platform` spells (D43): a listener, `fetch`, `for await`. Two style
// rules, off unless the `style` preset is chosen, name a task's node and key a
// service by its class (D44). What each rule flags, why, and its known
// approximations are in this package's README; the design is ramme's
// DESIGN.md §9 and DECISIONS.md D35, D41, D43, D44.

import type { ESLint, Linter, Rule } from 'eslint';
import { namedTask } from './rules/named-task.js';
import { noAsyncBody } from './rules/no-async-body.js';
import { noBareAsyncIteration } from './rules/no-bare-async-iteration.js';
import { noBareFetch } from './rules/no-bare-fetch.js';
import { noBareListener } from './rules/no-bare-listener.js';
import { noFunctionKey } from './rules/no-function-key.js';
import { noGeneratorHelper } from './rules/no-generator-helper.js';
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
  'no-bare-listener': noBareListener,
  'no-bare-fetch': noBareFetch,
  'no-bare-async-iteration': noBareAsyncIteration,
  'no-generator-helper': noGeneratorHelper,
  'named-task': namedTask,
  'no-function-key': noFunctionKey,
} satisfies Record<string, Rule.RuleModule>;

/** The rules of `recommended` (D35, D41, D43, D44). */
type RecommendedRule = Exclude<keyof typeof rules, StyleRule>;
/** The rules of `style` (D44, decision 10): the canonical style, which ramme accepts code without. */
type StyleRule = 'named-task' | 'no-function-key';

/**
 * Each rule's severity in `recommended` (D35, D41, D43, D44): every rule is an error. The rules that warned
 * (`finally`, `using` and `Promise` combinators in async bodies) went with async bodies (D41, decision 14).
 */
const severities: Record<RecommendedRule, Linter.RuleSeverity> = {
  'no-async-body': 'error',
  'no-unused-op': 'error',
  'no-unused-outcome': 'error',
  'no-timers': 'error',
  'no-stored-borrow': 'error',
  'no-owned-provider': 'error',
  'no-bare-listener': 'error',
  'no-bare-fetch': 'error',
  'no-bare-async-iteration': 'error',
  'no-generator-helper': 'error',
};

/** Each style rule's severity in `style`: a warning, since the code it flags is accepted (D44, decision 10). */
const styleSeverities: Record<StyleRule, Linter.RuleSeverity> = {
  'named-task': 'warn',
  'no-function-key': 'warn',
};

/** The default export's type. */
export interface RammePlugin extends ESLint.Plugin {
  meta: { name: string; version: string };
  rules: typeof rules;
  configs: {
    /** A flat config entry that registers the plugin as `ramme` and turns every rule but the style rules on, at its severity in the README. */
    recommended: Linter.Config;
    /** A flat config entry that registers the plugin as `ramme` and turns the style rules on, as warnings; beside `recommended`. */
    style: Linter.Config;
  };
}

const plugin: RammePlugin = {
  meta: { name: 'eslint-plugin-ramme', version: '0.0.1' },
  rules,
  configs: { recommended: {}, style: {} },
};

/** `ramme/<name>` at its severity, for each rule of a preset. */
function entries<R extends string>(severity: Record<R, Linter.RuleSeverity>): Linter.RulesRecord {
  return Object.fromEntries((Object.keys(severity) as R[]).map((name): [string, Linter.RuleEntry] => [`ramme/${name}`, severity[name]]));
}

plugin.configs.recommended = { name: 'ramme/recommended', plugins: { ramme: plugin }, rules: entries(severities) };
plugin.configs.style = { name: 'ramme/style', plugins: { ramme: plugin }, rules: entries(styleSeverities) };

export default plugin;
