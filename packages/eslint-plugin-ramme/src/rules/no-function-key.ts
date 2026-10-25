// A function used as an injection key (D44, decision 10; the `style` preset). A
// function key is accepted (DESIGN.md §3.1: its call is its default factory),
// but it is not the ramme style, which keys a service by its class, a value by
// a token (`createInjectionKey`), and an interface by `createKeyFor` over its
// class. A function key has no place to declare a scope (`static readonly
// scope`), reads as a call at every use, and is one rename away from a
// different key. Flagged: the key argument of `lookup`, `inject`,
// `createKeyFor`, `valueProvider`, `factoryProvider`, `classProvider`,
// `aliasProvider` (its key and its target) or `setScope`, when it is an
// identifier this file binds to a function declaration or to a `const`
// initialised with an arrow or a function expression. Not flagged: a class,
// a class expression, a token, an import or a parameter (this file does not
// show what they are), and a function passed as a provider's value.

import type { Rule } from 'eslint';
import { type EsNode, calleeName, declaredVariable, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

/** The verbs that take a key, and which of their arguments are keys. */
const KEY_ARGS: ReadonlyMap<string, readonly number[]> = new Map([
  ['lookup', [0]],
  ['inject', [0]],
  ['createKeyFor', [0]],
  ['valueProvider', [0]],
  ['factoryProvider', [0]],
  ['classProvider', [0]],
  ['aliasProvider', [0, 1]],
  ['setScope', [0]],
]);

/** Whether `id` names, in this file, a function declaration or a `const` whose initializer is a function. */
function isFunctionBinding(context: Rule.RuleContext, id: EsNode & { type: 'Identifier' }): boolean {
  const v = declaredVariable(context, id, id.name);
  if (v === undefined || v.defs.length !== 1) return false;
  const def = v.defs[0];
  if (def.type === 'FunctionName') return true;
  if (def.type !== 'Variable') return false;
  const list = def.parent as (EsNode & { kind?: string }) | null;
  if (list?.kind !== 'const') return false;
  const init = (def.node as EsNode & { init?: EsNode | null }).init;
  if (init === null || init === undefined) return false;
  const i = unwrap(init);
  return i.type === 'ArrowFunctionExpression' || i.type === 'FunctionExpression';
}

export const noFunctionKey: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Prefer a class or a token to a function as an injection key',
      recommended: false,
      url: docsUrl('no-function-key'),
    },
    messages: {
      functionKey:
        'a function key is accepted but not the ramme style; use a class or createInjectionKey, or createKeyFor ' +
        'over the class an interface is implemented by (ramme DECISIONS.md D44).',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node);
        const positions = name === undefined ? undefined : KEY_ARGS.get(name);
        if (positions === undefined) return;
        for (const i of positions) {
          const a = node.arguments[i] as EsNode | undefined;
          if (a === undefined || a.type === 'SpreadElement') continue;
          const arg = unwrap(a);
          if (arg.type === 'Identifier' && isFunctionBinding(context, arg)) context.report({ node: arg, messageId: 'functionKey' });
        }
      },
    };
  },
};
