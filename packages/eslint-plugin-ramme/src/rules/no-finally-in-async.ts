// A `try` with a `finally` lexically inside an async function, a warning in
// `recommended`. An interrupted ramme body unwinds, so its `finally` runs, but
// every managed await in it other than release work rejects again (sticky
// rejection, D39), and ramme cannot see the resource it guards: no event, no
// `node:stalled`, no early `release(x)` (DESIGN.md §2.6, §4.2).

import type { Rule } from 'eslint';
import { isInAsyncFunction } from '../ast.js';
import { docsUrl } from '../docs.js';

export const noFinallyInAsync: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Warn on `finally` in async functions: it runs on interruption but can await only release work, and ramme cannot see what it cleans up',
      recommended: true,
      url: docsUrl('no-finally-in-async'),
    },
    messages: {
      finally:
        'A `finally` runs on interruption but cannot await ramme work other than release; attach the invariant with own(), or shield() the cleanup ' +
        '(ramme DESIGN.md §2.6).',
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
