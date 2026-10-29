// A generator function that is no task body (D44, decision 5). ramme has no
// helpers: a body yields ops and only ops, and the only generator functions are
// task bodies, so the tree of nodes is the call tree. A helper (`function*
// parse() { … }`, run with `yield* parse()`) shares its caller's node: its
// temporaries are the caller's, it is not separately interruptible or visible,
// and a `yield*` in its `finally` loses the caller's halt (D41, decision 29).
// Written as a task it is a node of its own: `yield* parse()` reads the same.
//
// Allowed: a generator function expression passed to `task` (free or bound,
// `task(this, function* …)`, a `.with(…)` chain after it included), to `fork`,
// `attempt`, `shield`, `unshield` or a node's `call` (an inline body), to
// `promised` (a library's async callback), to `own` (a release entry:
// `own(tx, function* (tx) { … })`), and as an `onFailure` handler (a value or an
// object literal's generator method, `{ *onFailure(e) { … } }`). Reported: a
// generator declaration, a generator method of a class or an object literal,
// and a generator expression anywhere else (assigned to a variable or a
// property, passed to anything else), in a file that imports from ramme.
// An `async function*` is no ramme generator and is not reported (no-async-body
// reports one passed as a body); neither is a `[Symbol.iterator]` or
// `[Symbol.asyncIterator]` method, the iterator protocol's.

import type { Rule } from 'eslint';
import { type EsNode, type NodeOf, calleeName, parentOf, rammeImports, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

/** The calls whose arguments may be a generator function: a body, a callback body, a release. */
const BODY_TAKERS = new Set(['task', 'fork', 'attempt', 'shield', 'unshield', 'promised', 'own']);

type FunctionNode = NodeOf<'FunctionDeclaration' | 'FunctionExpression'>;

/** `node`'s parent, past TypeScript's expression wrappers (`f as T`, `f!`, `f satisfies T`). */
function outerParent(node: EsNode): { node: EsNode; parent: EsNode | null } {
  let n = node;
  let p = parentOf(n);
  while (p !== null && unwrap(p) !== p && (p as unknown as { expression?: EsNode }).expression === n) {
    n = p;
    p = parentOf(n);
  }
  return { node: n, parent: p };
}

/** Whether a method's key is `Symbol.iterator` or `Symbol.asyncIterator`: the iterator protocol, not a helper. */
function isIteratorKey(method: NodeOf<'MethodDefinition' | 'Property'>): boolean {
  const k = method.key as EsNode;
  if (!method.computed || k.type !== 'MemberExpression' || k.computed) return false;
  const o = k.object as EsNode;
  const p = k.property as EsNode;
  return o.type === 'Identifier' && o.name === 'Symbol' && p.type === 'Identifier' && (p.name === 'iterator' || p.name === 'asyncIterator');
}

/** Where a generator function expression sits: a body position (`'allowed'`), a method, or anywhere else. */
function position(fn: NodeOf<'FunctionExpression'>): 'allowed' | 'method' | 'iterator' | 'other' {
  const { node, parent } = outerParent(fn as EsNode);
  if (parent === null) return 'other';
  // A failure handler, `{ onFailure: function* (e) { … } }` or as a method, `{ *onFailure(e) { … } }`: driven with the
  // parent current (DESIGN.md §4.7) whichever way it is written.
  if (parent.type === 'Property' && parent.value === node && !parent.computed) {
    const key = parent.key as EsNode;
    const keyName = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : undefined;
    if (keyName === 'onFailure') return 'allowed';
  }
  if (parent.type === 'MethodDefinition' || (parent.type === 'Property' && (parent.method || parent.kind !== 'init'))) {
    return isIteratorKey(parent) ? 'iterator' : 'method';
  }
  if (parent.type === 'CallExpression' && parent.callee !== node) {
    const name = calleeName(parent);
    if (name !== undefined && BODY_TAKERS.has(name)) return 'allowed';
    // A node's `call` (`app.call(function* main() { … })`): an inline body through an explicit receiver.
    const callee = unwrap(parent.callee as EsNode);
    if (name === 'call' && callee.type === 'MemberExpression') return 'allowed';
    return 'other';
  }
  return 'other';
}

export const noGeneratorHelper: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a generator function that is no task body: ramme has no helpers, so the tree is the call tree',
      recommended: true,
      url: docsUrl('no-generator-helper'),
    },
    messages: {
      helper:
        'a generator function is a task body; wrap it in task(…) (ramme has no helpers: the tree is the call tree). ' +
        'A task is called as a helper is, `yield* parse(x)`, and runs in a node of its own (ramme DECISIONS.md D44).',
    },
    schema: [],
  },
  create(context) {
    if (rammeImports(context.sourceCode).length === 0) return {};
    const check = (fn: FunctionNode, report: EsNode): void => {
      if (!fn.generator || fn.async) return;
      context.report({ node: report, messageId: 'helper' });
    };
    return {
      FunctionDeclaration(node) {
        check(node, node);
      },
      FunctionExpression(node) {
        if (!node.generator || node.async) return;
        const where = position(node);
        if (where === 'allowed' || where === 'iterator') return;
        check(node, where === 'method' ? (parentOf(node) as EsNode) : node);
      },
    };
  },
};
