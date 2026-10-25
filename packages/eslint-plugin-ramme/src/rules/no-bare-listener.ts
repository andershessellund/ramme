// A bare platform listener in ramme code (D43; PROPOSAL.md §5.3, decisions 21,
// 22 and 26). A callback the platform makes runs outside every node: there is
// no current node in it (`current()`, `lookup`, `own` and `fork` throw
// `NoCurrentNodeError`), and nothing removes the listener when the node that
// registered it ends. A `{ signal: signal() }` option removes it at the
// delivery, but the callback still runs outside the node, and a node's signal
// never fires at a natural exit or under `close()`. `listen(target, type,
// handler)` from `ramme/platform` runs the handler inside the registering
// node and removes it when the node ends.
//
// Flagged: `<x>.addEventListener(type, …)` (and a bare `addEventListener(…)`,
// the window's), `<x>.on(type, …)`, `<x>.once(type, …)` and
// `<x>.addListener(type, …)` on an emitter, and an `on<event> = handler`
// property assignment (`el.onclick = …`, `??=` too; assigning `null` or
// `undefined` removes one, and is fine; a value that is never a function, such
// as `this.online = true`, and a common word that names no handler, such as
// `this.once = v`, are data), in ramme code only (decision 26): lexically inside
// a generator function (a body, a helper, a generator method; nested callbacks
// included) or anywhere in a class that uses ramme (one with a generator
// method, or a free call of `inject`, `lookup`, `own`, `current`, `signal`,
// `fork`, `child`, `pool` or `listen` anywhere in it). Top-level code is not
// flagged: the README's `server.on('request', (req) => app.fork(…))` names its
// node.

import type { Rule } from 'eslint';
import { type EsNode, type NodeOf, calleeName, inGeneratorBody, isGlobalName, parentOf, propertyName, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

/** The emitter methods that register a listener. */
const EMITTER_METHODS = new Set(['on', 'once', 'addListener']);

/** The free calls that mark a class as built under a node: the synchronous verbs a service uses. */
const RAMME_CALLS = new Set(['inject', 'lookup', 'own', 'current', 'signal', 'fork', 'child', 'pool', 'listen']);

/** An `on<event>` handler property: `on` and a lower-case event name, as the platform's are (`onclick`, `onmessage`). */
const HANDLER_PROPERTY = /^on[a-z]+$/;

/**
 * Words that match `HANDLER_PROPERTY` and name no handler (`on` and an event type): data properties (`this.online`,
 * `opts.once`). The platform's handler for the `online` event is `ononline`.
 */
const NOT_HANDLERS = new Set(['one', 'ones', 'once', 'only', 'online', 'ongoing', 'onset', 'onto', 'onward', 'onwards', 'onboard', 'onboarding']);

/** The assignments that can store a handler: `=` and the logical ones (`el.onerror ??= report`), never `+=` and its kin. */
const STORING = new Set(['=', '??=', '||=', '&&=']);

/**
 * A value that is never a function: a literal, a template, an object or array literal, an operator's result (`!x`,
 * `-n`, `a + b`, `i++`), or a choice among such values. An `on…` property assigned one holds data, not a handler.
 */
function isNeverAFunction(node: EsNode): boolean {
  const n = unwrap(node);
  switch (n.type) {
    case 'Literal':
    case 'TemplateLiteral':
    case 'ObjectExpression':
    case 'ArrayExpression':
    case 'UnaryExpression':
    case 'BinaryExpression':
    case 'UpdateExpression':
      return true;
    case 'ConditionalExpression':
      return isNeverAFunction(n.consequent) && isNeverAFunction(n.alternate);
    case 'LogicalExpression':
      return isNeverAFunction(n.left) && isNeverAFunction(n.right);
    case 'SequenceExpression':
      return isNeverAFunction(n.expressions.at(-1)!);
    default:
      return false;
  }
}

type ClassNode = NodeOf<'ClassDeclaration' | 'ClassExpression'>;

/** The classes lexically enclosing `node`, innermost first. */
function enclosingClasses(node: EsNode): ClassNode[] {
  const classes: ClassNode[] = [];
  for (let n = parentOf(node); n !== null; n = parentOf(n))
    if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') classes.push(n);
  return classes;
}

/** `null`, `undefined` or `void …`: an assignment of one removes a handler. */
function isNothing(node: EsNode): boolean {
  const n = unwrap(node);
  if (n.type === 'Literal' && n.value === null) return true;
  if (n.type === 'Identifier' && n.name === 'undefined') return true;
  return n.type === 'UnaryExpression' && n.operator === 'void';
}

export const noBareListener: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a bare platform listener in a body or a class that uses ramme; use `listen` from `ramme/platform`',
      recommended: true,
      url: docsUrl('no-bare-listener'),
    },
    messages: {
      bare:
        '`{{form}}` registers a bare listener: its callback runs outside every node, where `current()`, `lookup`, `own` and ' +
        '`fork` have none, and nothing removes it when the node ends (a `signal` option changes neither). Use ' +
        '`listen(target, type, handler)` from `ramme/platform`: the handler runs inside the registering node, and is ' +
        'removed when the node ends (ramme DECISIONS.md D43).',
    },
    schema: [],
  },
  create(context) {
    const candidates: { node: EsNode; form: string; classes: ClassNode[] }[] = [];
    const rammeClasses = new Set<ClassNode>();
    const markClasses = (node: EsNode): void => {
      for (const c of enclosingClasses(node)) rammeClasses.add(c);
    };
    const candidate = (node: EsNode, form: string): void => {
      if (inGeneratorBody(node)) context.report({ node, messageId: 'bare', data: { form } });
      else {
        const classes = enclosingClasses(node);
        if (classes.length > 0) candidates.push({ node, form, classes });
      }
    };
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee as EsNode);
        if (callee.type === 'Identifier' && RAMME_CALLS.has(callee.name)) markClasses(node);
        if (node.arguments.length < 2) return;
        const name = calleeName(node);
        if (name === 'addEventListener') {
          if (callee.type === 'MemberExpression' || (callee.type === 'Identifier' && isGlobalName(context, callee)))
            candidate(node, 'addEventListener');
        } else if (name !== undefined && EMITTER_METHODS.has(name) && callee.type === 'MemberExpression') candidate(node, `.${name}(…)`);
      },
      MethodDefinition(node) {
        if (node.value.generator) markClasses(node);
      },
      AssignmentExpression(node) {
        // A logical form too: `el.onerror ??= report` registers a handler as `=` does.
        const left = unwrap(node.left as EsNode);
        if (left.type !== 'MemberExpression' || !STORING.has(node.operator)) return;
        const name = propertyName(left);
        if (name === undefined || !HANDLER_PROPERTY.test(name) || NOT_HANDLERS.has(name)) return;
        const right = node.right as EsNode;
        if (isNothing(right) || isNeverAFunction(right)) return;
        candidate(node, `${name} ${node.operator}`);
      },
      'Program:exit'() {
        for (const { node, form, classes } of candidates)
          if (classes.some((c) => rammeClasses.has(c))) context.report({ node, messageId: 'bare', data: { form } });
      },
    };
  },
};
