// `using` and `await using` declarations inside an async function, a warning
// in `recommended`. A declaration's disposal runs when its block exits, which
// is a `finally`: it runs on interruption (D39), but the resource is invisible
// to ramme (no entry in the inspector, no event, no early `release(x)`), and an
// async disposal can await only release work (DESIGN.md §2.6).

import type { Rule } from 'eslint';
import { isInAsyncFunction } from '../ast.js';
import { docsUrl } from '../docs.js';

export const noUsingInAsync: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Warn on `using` and `await using` in async functions: `finally` in disguise, whose resource ramme cannot see; attach it with `own`',
      recommended: true,
      url: docsUrl('no-using-in-async'),
    },
    messages: {
      using:
        '`{{kind}}` in an async function is `finally` in disguise: its disposal runs on interruption, but ramme cannot see the resource ' +
        '(no inspector entry, no events, no early release). Attach it with `own(…)` (ramme DESIGN.md §2.6).',
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
