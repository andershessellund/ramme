// `Promise.race`, `Promise.any`, `Promise.allSettled` and `Promise.all`.
// A combinator calls `then` on every member and resumes on its own terms: it
// can resume a body while one of its managed promises is still pending, or
// consume a member's failure that a frozen body then never sees (DESIGN.md
// §4.2, D13). Deliberately stricter than §4.2, which supports a `Promise.all`
// that fulfils over managed members: syntax cannot tell that one from one
// that rejects, nor managed members from bare ones.

import type { Rule } from 'eslint';
import { type EsNode, isGlobalName, propertyName, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

const COMBINATORS = new Set(['race', 'any', 'allSettled', 'all']);

export const noPromiseCombinators: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow `Promise.race`, `Promise.any`, `Promise.allSettled` and `Promise.all`; use ramme’s `all`, `race` and `settle`',
      recommended: true,
      url: docsUrl('no-promise-combinators'),
    },
    messages: {
      combinator:
        '`Promise.{{name}}` can resume a body while one of its managed promises is pending, or drop a member’s failure ' +
        '(ramme DESIGN.md §4.2). Use ramme’s `all`, `race` or `settle` over tasks.',
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        const name = propertyName(node);
        if (name === undefined || !COMBINATORS.has(name)) return;
        const object = unwrap(node.object as EsNode);
        if (object.type !== 'Identifier' || object.name !== 'Promise' || !isGlobalName(context, object)) return;
        context.report({ node, messageId: 'combinator', data: { name } });
      },
    };
  },
};
