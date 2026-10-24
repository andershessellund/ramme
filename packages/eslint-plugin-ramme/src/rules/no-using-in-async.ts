// `using` and `await using` declarations inside an async function. A
// declaration's disposal runs when its block exits, which is a `finally`: a
// frozen body never resumes, so it never runs (DESIGN.md §2.6).

import type { Rule } from 'eslint';
import { isInAsyncFunction } from '../ast.js';
import { docsUrl } from '../docs.js';

export const noUsingInAsync: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow `using` and `await using` in async functions, whose disposal a frozen ramme body never runs',
      recommended: true,
      url: docsUrl('no-using-in-async'),
    },
    messages: {
      using:
        '`{{kind}}` in an async function is `finally` in disguise: a frozen body never resumes, so the disposal never runs. ' +
        'Attach the resource with `own(…)` instead (ramme DESIGN.md §2.6).',
    },
    schema: [],
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind !== 'using' && node.kind !== 'await using') return;
        if (!isInAsyncFunction(node)) return;
        context.report({ node, messageId: 'using', data: { kind: node.kind } });
      },
    };
  },
};
