// `Promise.race`, `Promise.any`, `Promise.allSettled` and `Promise.all`, a
// warning in `recommended`. A combinator calls `then` on every member and
// settles on its own terms. Over managed promises it does not structure its
// members: what it stops waiting for keeps running, where ramme's `race`
// aborts it; and `race`, `any` and an `all` that rejects consume a member's
// failure that arrives after they settled and lose it (DESIGN.md §4.2, D13,
// D39). `Promise.allSettled` and an `all` that fulfils are flagged too: syntax
// cannot tell them apart, nor managed members from bare ones.

import type { Rule } from 'eslint';
import { type EsNode, isGlobalName, propertyName, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

const COMBINATORS = new Set(['race', 'any', 'allSettled', 'all']);

export const noPromiseCombinators: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Warn on `Promise.race`, `Promise.any`, `Promise.allSettled` and `Promise.all`, which do not structure their members; use ramme’s `all`, `race` and `settle`',
      recommended: true,
      url: docsUrl('no-promise-combinators'),
    },
    messages: {
      combinator:
        '`Promise.{{name}}` does not structure its members: over managed promises, what it stops waiting for keeps running, and ' +
        '`race`, `any` and an `all` that rejects consume and lose a member failure that arrives after they settled. ' +
        'Use ramme’s `all`, `race` or `settle` over tasks (ramme DESIGN.md §4.2).',
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
