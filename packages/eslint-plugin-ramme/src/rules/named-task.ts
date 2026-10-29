// A task whose node has no name (D44, decision 10; the `style` preset). A node
// is named `opts.name`, else its body's own name, else `anonymous`, and a
// function expression passed as an argument has no name of its own: the
// variable it is assigned to does not name it, so `const poll = task(function* () { … })`
// makes nodes named `anonymous` in every event, stall warning and error
// message. Flagged: a `task(…)`, free or bound (`task(this, …)`), whose body is
// an anonymous generator or function expression or an arrow, and whose options
// are absent or an object literal with no `name` (and no spread, which may
// carry one), and which no `.with(opts)` chained on it names
// (`task(function* () { … }).with({ name: 'poll' })`: its nodes are `poll`).
// A body passed by name is named; an inline `fork(function* () { … })` body is
// no `task(…)`.

import type { Rule } from 'eslint';
import { type EsNode, isFreeOrMethodCall, parentOf, propertyName, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

/** `node` with the TypeScript wrappers around it (`x as T`, `x!`) taken in. */
function outer(node: EsNode): EsNode {
  let n = node;
  for (let p = parentOf(n); p !== null && unwrap(p) !== p && (p as unknown as { expression?: EsNode }).expression === n; p = parentOf(n)) n = p;
  return n;
}

/** Whether a `.with(opts)` chained on the `task(…)` call names it, as `with` takes `name` (`task(…).with({ name })`). */
function namedByWith(call: EsNode): boolean {
  for (let n = outer(call); ; ) {
    const member = parentOf(n);
    if (member?.type !== 'MemberExpression' || propertyName(member) !== 'with') return false; // `n` is its object: a call is never a property name
    const withCall = parentOf(member);
    if (withCall?.type !== 'CallExpression' || withCall.callee !== member) return false;
    if (mayName(withCall.arguments[0] as EsNode | undefined)) return true;
    n = outer(withCall);
  }
}

function isFunctionExpression(n: EsNode | undefined): boolean {
  return n !== undefined && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
}

/** Whether options may carry a `name`: anything but an object literal without a `name` property or a spread. */
function mayName(opts: EsNode | undefined): boolean {
  if (opts === undefined) return false;
  const o = unwrap(opts);
  if (o.type !== 'ObjectExpression') return true;
  return o.properties.some((p) => {
    if (p.type === 'SpreadElement') return true;
    const k = p.key as EsNode;
    return !p.computed && ((k.type === 'Identifier' && k.name === 'name') || (k.type === 'Literal' && k.value === 'name'));
  });
}

export const namedTask: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require a task to be named, by its generator or by `{ name }`: its node is named after it',
      recommended: false,
      url: docsUrl('named-task'),
    },
    messages: {
      unnamed:
        'name the generator (function* name) or pass { name }: the node is named after it, and an anonymous body ' +
        'makes nodes named `anonymous` (ramme DECISIONS.md D44).',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isFreeOrMethodCall(node, 'task')) return;
        const args = node.arguments.map((a) => unwrap(a as EsNode));
        const bound = args.length >= 2 && isFunctionExpression(args[1]);
        const body = bound ? args[1] : args[0];
        const opts = bound ? args[2] : args[1];
        if (!isFunctionExpression(body)) return;
        if (body.type === 'FunctionExpression' && body.id !== null && body.id !== undefined) return;
        if (mayName(opts) || namedByWith(node)) return;
        context.report({ node: body, messageId: 'unnamed' });
      },
    };
  },
};
