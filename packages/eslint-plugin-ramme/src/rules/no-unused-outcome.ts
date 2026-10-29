// A discarded outcome of `attempt(…)`, `settle(…)` or `result(f)`. Each
// delivers the four-way outcome as a value and consumes what it carries (an
// expected `failure` from a `yield* fail(e)`, or a `defect` from a throw), so an
// outcome nobody reads is a failure or a defect dropped silently, where a call
// (`yield* t(…)`), `all` or `join` would have propagated it: re-yielded the expected failure
// into the caller, or thrown the defect (DESIGN.md §4.5, D31, D42). Flagged:
// the call run and its outcome discarded, `yield* attempt(t);` or
// `await attempt(t);` as an expression statement, under `void` too. The op
// alone (`attempt(t);`) runs nothing, which is `no-unused-op`'s to report.

import type { Rule } from 'eslint';
import { type EsNode, calleeName, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

const OUTCOME_CALLS = new Set(['attempt', 'settle', 'result']);

export const noUnusedOutcome: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow discarding the outcome of `attempt`, `settle` or `result`, which drops a failure or a defect silently',
      recommended: true,
      url: docsUrl('no-unused-outcome'),
    },
    messages: {
      discarded:
        'The outcome of `{{name}}` is discarded: an outcome nobody inspects is a failure or a defect dropped. ' +
        'Call the task (`yield* t(…)`, or `all`, `join`) to have it propagate (an expected failure re-yielded, a defect thrown), ' +
        'or read the outcome (ramme DECISIONS.md D31, D42).',
    },
    schema: [],
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        let e = unwrap(node.expression as EsNode);
        let consumed = false;
        for (;;) {
          if (e.type === 'AwaitExpression' || (e.type === 'YieldExpression' && e.delegate && e.argument !== null)) {
            e = unwrap(e.argument as EsNode);
            consumed = true;
          } else if (e.type === 'UnaryExpression' && e.operator === 'void') e = unwrap(e.argument as EsNode);
          else break;
        }
        if (e.type !== 'CallExpression' || !consumed) return;
        const name = calleeName(e);
        if (name !== undefined && OUTCOME_CALLS.has(name)) context.report({ node: e, messageId: 'discarded', data: { name } });
      },
    };
  },
};
