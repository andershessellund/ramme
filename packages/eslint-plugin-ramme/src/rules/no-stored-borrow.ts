// A `lookup(…)` result stored where it outlives the current node. `lookup`
// returns a borrow, which must live at least as long as the current node and
// no longer; what an object keeps is a dependency, which is `inject`
// (DESIGN.md §3.2, D4′). Flagged: a `lookup(…)` call, or a member chain on
// one (`lookup(X).y`), as a class field initializer (an auto-accessor's
// included), assigned to `this.<prop>` (a TypeScript parameter property's
// default included), or initializing a module-scope variable.

import type { Rule } from 'eslint';
import { type EsNode, isFreeCall, parentOf, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

/** `accessor x = …`: ESTree's `AccessorProperty`, which `eslint`'s types do not name. */
interface AccessorProperty {
  readonly value: EsNode | null;
}

/** typescript-eslint's `constructor(private x = …)`: a parameter that is also a property of `this`. */
interface TSParameterProperty {
  readonly parameter: EsNode;
}

/** Whether `node` is `lookup(…)`, or a property read on one (`lookup(X).y`, `lookup(X)?.y.z`). */
function isBorrow(node: EsNode): boolean {
  let n = unwrap(node);
  while (n.type === 'MemberExpression') n = unwrap(n.object as EsNode);
  return isFreeCall(n, 'lookup');
}

/** Whether a variable declaration is at module scope: a statement of the program, exported or not. */
function isModuleScope(declaration: EsNode): boolean {
  const parent = parentOf(declaration);
  if (parent?.type === 'Program') return true;
  return parent?.type === 'ExportNamedDeclaration' && parentOf(parent)?.type === 'Program';
}

export const noStoredBorrow: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow storing a `lookup` result in a field, on `this` or in a module variable; a stored value is a dependency (`inject`)',
      recommended: true,
      url: docsUrl('no-stored-borrow'),
    },
    messages: {
      stored:
        'A `lookup` result is a borrow and lives only as long as the current node; stored in {{where}}, it outlives that node. ' +
        'A value an object keeps is a dependency: declare it with `inject` (ramme DESIGN.md §3.2).',
    },
    schema: [],
  },
  create(context) {
    return {
      PropertyDefinition(node) {
        if (node.value && isBorrow(node.value)) context.report({ node: node.value, messageId: 'stored', data: { where: 'a class field' } });
      },
      // Node types `eslint`'s listener types do not name: the node is read through the shape declared above.
      AccessorProperty(node: unknown) {
        const { value } = node as AccessorProperty;
        if (value && isBorrow(value)) context.report({ node: value, messageId: 'stored', data: { where: 'a class field' } });
      },
      TSParameterProperty(node: unknown) {
        const p = (node as TSParameterProperty).parameter;
        if (p.type === 'AssignmentPattern' && isBorrow(p.right))
          context.report({ node: p.right, messageId: 'stored', data: { where: 'a property of `this`' } });
      },
      AssignmentExpression(node) {
        const target = unwrap(node.left as EsNode);
        if (target.type !== 'MemberExpression' || unwrap(target.object as EsNode).type !== 'ThisExpression') return;
        if (isBorrow(node.right)) context.report({ node: node.right, messageId: 'stored', data: { where: 'a property of `this`' } });
      },
      VariableDeclarator(node) {
        const declaration = parentOf(node);
        if (!node.init || declaration === null || !isModuleScope(declaration)) return;
        if (isBorrow(node.init)) context.report({ node: node.init, messageId: 'stored', data: { where: 'a module variable' } });
      },
    };
  },
};
