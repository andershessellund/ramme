// A `catch` clause lexically inside an async function that can swallow the
// body's own interruption. An interrupted ramme body is unwound by a sticky
// rejection: every managed await it makes rejects with `InterruptedError`
// (D39), so a `catch` around one receives it. Swallowed, the body runs on, its
// later managed awaits reject again and its outcome is `aborted` whatever it
// returns (DESIGN.md §2.6, §4.2). A clause passes when (1) its block's last
// statement is a `throw`, (2) its block contains, outside nested functions,
// `throw <param>`, or (3) its block contains `<param> instanceof
// InterruptedError` (the right side an identifier or a member of that name).
// A clause with no parameter, or a destructuring one, passes only by (1). A
// heuristic; the package README lists its approximations.

import type { Rule, SourceCode } from 'eslint';
import { type EsNode, isInAsyncFunction, propertyName, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** Whether `visit` holds for `root` or a node below it; below a nested function only when `intoFunctions`. */
function some(root: EsNode, keys: SourceCode.VisitorKeys, intoFunctions: boolean, visit: (n: EsNode) => boolean): boolean {
  const stack: EsNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (visit(n)) return true;
    for (const key of keys[n.type] ?? []) {
      const child = (n as unknown as Record<string, unknown>)[key];
      for (const c of Array.isArray(child) ? child : [child]) {
        if (c === null || typeof c !== 'object' || typeof (c as { type?: unknown }).type !== 'string') continue;
        if (!intoFunctions && FUNCTIONS.has((c as EsNode).type)) continue;
        stack.push(c as EsNode);
      }
    }
  }
  return false;
}

/** `name`, or a member access whose property is `name` (`ramme.InterruptedError`). */
function namesInterruptedError(node: EsNode): boolean {
  const n = unwrap(node);
  if (n.type === 'Identifier') return n.name === 'InterruptedError';
  return n.type === 'MemberExpression' && propertyName(n) === 'InterruptedError';
}

function isParam(node: EsNode, param: string): boolean {
  const n = unwrap(node);
  return n.type === 'Identifier' && n.name === param;
}

export const noSwallowedInterruption: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a `catch` in an async function that can swallow the body’s own `InterruptedError`: rethrow it, or branch with `attempt`',
      recommended: true,
      url: docsUrl('no-swallowed-interruption'),
    },
    messages: {
      swallowed:
        'This `catch` can swallow the body’s own interruption: an interrupted body’s managed awaits reject with `InterruptedError`, ' +
        'and its outcome is `aborted` whatever it does next. Rethrow it (`if (e instanceof InterruptedError) throw e`), or branch ' +
        'with `attempt`/`settle` and keep `catch` for translation (ramme DESIGN.md §2.6).',
    },
    schema: [],
  },
  create(context) {
    const keys = context.sourceCode.visitorKeys;
    return {
      CatchClause(node) {
        if (!isInAsyncFunction(node)) return;
        const block = node.body;
        if (block.body.at(-1)?.type === 'ThrowStatement') return; // (1)
        const param = node.param;
        if (param?.type === 'Identifier') {
          const name = param.name;
          const rethrows = some(block as EsNode, keys, false, (n) => n.type === 'ThrowStatement' && isParam(n.argument as EsNode, name)); // (2)
          if (rethrows) return;
          const tests = some(
            block as EsNode,
            keys,
            true,
            (n) =>
              n.type === 'BinaryExpression' &&
              n.operator === 'instanceof' &&
              isParam(n.left as EsNode, name) &&
              namesInterruptedError(n.right as EsNode),
          ); // (3)
          if (tests) return;
        }
        const keyword = context.sourceCode.getFirstToken(node);
        context.report({ ...(keyword ? { loc: keyword.loc } : { node }), messageId: 'swallowed' });
      },
    };
  },
};
