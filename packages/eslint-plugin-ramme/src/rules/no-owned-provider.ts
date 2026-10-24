// `<expr>.addProvider(valueProvider(K, x))` where `x` is something the node's
// explicit stack owns: an `own(…)` or `<ctx>.own(…)` call, or a variable
// initialized with one in the same function. Values built from the provider
// go on the provided stack, which is released after the explicit stack, so
// they outlive what they use: the wiring error of DESIGN.md §2.5 (D16).
// `providers:` options bind on a new node and are not flagged.

import type { Rule } from 'eslint';
import { type EsNode, declaredVariable, enclosingFunction, isFreeOrMethodCall, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

export const noOwnedProvider: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow `addProvider(valueProvider(K, x))` for an `x` the same node owns',
      recommended: true,
      url: docsUrl('no-owned-provider'),
    },
    messages: {
      owned:
        'This provides a value its node owns, which points the provided stack into the explicit stack: a value built from it ' +
        'is released after it (ramme DESIGN.md §2.5). Provide it on a new node instead, with `providers:` on `call`, `child` or `task.with`.',
    },
    schema: [],
  },
  create(context) {
    /** Whether `value`, an argument of a provider in the `addProvider` call `at`, is an owned value. */
    function isOwned(value: EsNode, at: EsNode): boolean {
      const v = unwrap(value);
      if (isFreeOrMethodCall(v, 'own')) return true;
      if (v.type !== 'Identifier') return false;
      const variable = declaredVariable(context, v, v.name);
      const here = enclosingFunction(at);
      return (variable?.defs ?? []).some((def) => {
        if (def.type !== 'Variable') return false;
        const declarator = def.node as EsNode;
        if (declarator.type !== 'VariableDeclarator' || !declarator.init) return false;
        return isFreeOrMethodCall(unwrap(declarator.init), 'own') && enclosingFunction(declarator) === here;
      });
    }

    return {
      CallExpression(node) {
        if (!isFreeOrMethodCall(node, 'addProvider') || unwrap(node.callee as EsNode).type !== 'MemberExpression') return;
        for (const arg of node.arguments) {
          const provider = unwrap(arg as EsNode);
          if (!isFreeOrMethodCall(provider, 'valueProvider')) continue;
          const value = provider.arguments[1];
          if (value !== undefined && value.type !== 'SpreadElement' && isOwned(value, node)) {
            context.report({ node: value, messageId: 'owned' });
          }
        }
      },
    };
  },
};
