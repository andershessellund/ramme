// A `try` with a `finally` lexically inside an async function. ramme
// interrupts a body by freezing it at its next managed await: it never
// resumes, so a `finally` around that await never runs (DESIGN.md §2.6, §4.2).

import type { Rule } from 'eslint';
import { isInAsyncFunction } from '../ast.js';
import { docsUrl } from '../docs.js';

export const noFinallyInAsync: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow `finally` in async functions, which a frozen ramme body never runs',
      recommended: true,
      url: docsUrl('no-finally-in-async'),
    },
    messages: {
      finally:
        'A frozen body never runs `finally`: an interrupted async body stops at its next managed await and never resumes. ' +
        'Attach the invariant with `own(() => …)` instead (ramme DESIGN.md §2.6).',
    },
    schema: [],
  },
  create(context) {
    return {
      TryStatement(node) {
        if (node.finalizer === null || node.finalizer === undefined || !isInAsyncFunction(node)) return;
        const keyword = context.sourceCode.getTokenBefore(node.finalizer);
        context.report({ ...(keyword ? { loc: keyword.loc } : { node }), messageId: 'finally' });
      },
    };
  },
};
