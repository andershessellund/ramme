// An `async` function where a body is expected. ramme steps a body's
// generator and halts it with `return()` at the `yield*` where it waits; it
// cannot see an `await`, so an async function is no body (D41, decision 5):
// the type checker refuses one through `Body`'s types, and the runtime with a
// `TypeError` naming `function*`. This rule is the message for untyped code
// and for a body the types cannot see (a cast, a `.js` file).
//
// Flagged: an `async` function, `async` arrow or `async function*` that is the
// first argument of `task`, `fork`, `call`, `attempt`, `shield`, `unshield`,
// `promised` or `bind`, free or as a method (`ctx.call`, `pool.fork`), inline
// or through an identifier whose declaration in this file is one.

import type { Rule, Scope } from 'eslint';
import { type EsNode, calleeName, declaredVariable, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

/** The verbs whose first argument is a body (`bind` included, for an observer's callback). */
const BODY_VERBS = new Set(['task', 'fork', 'call', 'attempt', 'shield', 'unshield', 'promised', 'bind']);

type FunctionNode = EsNode & { type: 'FunctionDeclaration' | 'FunctionExpression' | 'ArrowFunctionExpression'; async?: boolean };

function asFunction(node: EsNode | null | undefined): FunctionNode | undefined {
  if (node === null || node === undefined) return undefined;
  const n = unwrap(node);
  return n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression'
    ? (n as FunctionNode)
    : undefined;
}

/** The function an identifier's one definition in this file is: a function declaration, or a `const`'s initializer. */
function definedFunction(variable: Scope.Variable): FunctionNode | undefined {
  if (variable.defs.length !== 1) return undefined;
  const def = variable.defs[0];
  if (def.type === 'FunctionName') return asFunction(def.node as EsNode);
  if (def.type === 'Variable') {
    const decl = def.node as EsNode & { init?: EsNode | null };
    const list = def.parent as (EsNode & { kind?: string }) | null;
    if (list?.kind !== 'const') return undefined; // a `let` may be reassigned: what it holds at the call is not known
    return asFunction(decl.init);
  }
  return undefined;
}

export const noAsyncBody: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow an `async` function where ramme expects a body: write it as `function*`',
      recommended: true,
      url: docsUrl('no-async-body'),
    },
    messages: {
      asyncBody:
        'An async function is no body for `{{verb}}`: ramme cannot see its awaits, so it can neither halt it nor ' +
        'run its finally as release work, and it is refused at run time. Write it as `function*`, run every op with ' +
        '`yield*` and wait for a foreign promise with `yield* wait(p)` (ramme DECISIONS.md D41).',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const verb = calleeName(node);
        if (verb === undefined || !BODY_VERBS.has(verb)) return;
        const first = node.arguments[0] as EsNode | undefined;
        if (first === undefined || first.type === 'SpreadElement') return;
        const arg = unwrap(first);
        let fn = asFunction(arg);
        if (fn === undefined && arg.type === 'Identifier') {
          const v = declaredVariable(context, arg, arg.name);
          if (v !== undefined) fn = definedFunction(v);
        }
        if (fn !== undefined && fn.async === true) context.report({ node: first, messageId: 'asyncBody', data: { verb } });
      },
    };
  },
};
