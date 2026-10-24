// A discarded `attempt(…)` or `settle(…)`. Both deliver a failure as a value
// and consume it, so an outcome nobody reads is a failure dropped silently,
// where `call` or `all` would have thrown it (DESIGN.md §4.5, D31). Flagged:
// the call as an expression statement, alone or under `await` or `void`.

import type { Rule } from 'eslint';
import { type EsNode, calleeName, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

const OUTCOME_CALLS = new Set(['attempt', 'settle']);

export const noUnusedOutcome: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow discarding the outcome of `attempt` or `settle`, which drops a failure silently',
      recommended: true,
      url: docsUrl('no-unused-outcome'),
    },
    messages: {
      discarded:
        'The outcome of `{{name}}` is discarded: an outcome nobody inspects is a failure dropped. ' +
        'Use `call` (or `all`) to have a failure thrown, or read the outcome (ramme DECISIONS.md D31).',
    },
    schema: [],
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        let e = unwrap(node.expression as EsNode);
        for (;;) {
          if (e.type === 'AwaitExpression') e = unwrap(e.argument as EsNode);
          else if (e.type === 'UnaryExpression' && e.operator === 'void') e = unwrap(e.argument as EsNode);
          else break;
        }
        if (e.type !== 'CallExpression') return;
        const name = calleeName(e);
        if (name !== undefined && OUTCOME_CALLS.has(name)) context.report({ node: e, messageId: 'discarded', data: { name } });
      },
    };
  },
};
