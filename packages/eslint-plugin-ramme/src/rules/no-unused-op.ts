// A work op nobody consumes. A work op is lazy (D41, decision 2): `call(t)`
// makes the child only when it is yielded, so `call(t);` alone runs nothing,
// where an `await` forgotten in an async body ran the call anyway. Flagged: a
// call of a work verb (`call`, `attempt`, `all`, `race`, `settle`, `shield`,
// `unshield`, `join`, `result`, `sleep`, `interrupted`, `never`, `wait`),
// free or as a method (`app.call(…)`, a task's `t.call(…)` and `t.attempt(…)`
// included), as an expression statement or under `void`: a free one inside a
// function (at module level no node is current, so it throws
// `NoCurrentNodeError` when made), a method one anywhere (an explicit receiver
// needs no current node, so `app.call(main);` at the top of a script runs
// nothing either). `fork` is eager and returns a fiber, and the lifecycle verbs
// (`release`, `releaseAll`, `close`) start their work when called, so
// `fork(t);` and `void release(x);` are fine. `no-unused-outcome` reports a
// consumed `attempt`, `settle` or `result` whose outcome is discarded.
//
// The platform's own methods of those names are not flagged: `Promise.all`,
// `Promise.race` and `Atomics.wait` on the globals, and `Function.prototype.call`
// where the syntax shows it (`X.prototype.m.call(…)`, a `this`-argument of
// `this`, `null`, `undefined`, `void …` or `globalThis`, a receiver this file
// declares as a function, or a receiver the file does not show to be ramme's,
// such as a parameter, called with an argument that is no task or body).

import type { Rule, Scope } from 'eslint';
import { type EsNode, type Identifier, type MemberExpression, calleeName, declaredVariable, enclosingFunction, isGlobalName, propertyName, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

const WORK_VERBS = new Set([
  'call',
  'attempt',
  'all',
  'race',
  'settle',
  'shield',
  'unshield',
  'join',
  'result',
  'sleep',
  'interrupted',
  'never',
  'wait',
]);

/** The globals whose methods share a work verb's name: `Promise.all`, `Promise.race`, `Atomics.wait`. */
const PLATFORM_RECEIVERS = new Set(['Promise', 'Atomics']);

/** The calls that make a task, or a node that has ramme's `call`. */
const RAMME_MAKERS = new Set(['task', 'bind', 'createRootContext', 'current', 'child', 'pool']);

/** The type names a parameter annotated as ramme's is written with. */
const RAMME_TYPES = new Set(['Task', 'Context', 'Pool']);

function isFunctionNode(node: EsNode | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  const n = unwrap(node);
  return n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'ClassExpression';
}

function isRammeMaker(node: EsNode | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  const n = unwrap(node);
  if (n.type !== 'CallExpression') return false;
  const name = calleeName(n);
  return name !== undefined && RAMME_MAKERS.has(name);
}

/** The type a parameter is annotated with (typescript-eslint puts it on the identifier), or `undefined`. */
function annotation(id: EsNode): EsNode | undefined {
  return (id as EsNode & { typeAnnotation?: { typeAnnotation?: EsNode } }).typeAnnotation?.typeAnnotation;
}

/** The rightmost name of a type reference (`Task`, `ramme.Context`), or `undefined` for any other type. */
function typeName(type: EsNode): string | undefined {
  if ((type.type as string) !== 'TSTypeReference') return undefined;
  const n = (type as unknown as { typeName: { type: string; name?: string; right?: { name: string } } }).typeName;
  return n.type === 'Identifier' ? n.name : n.right?.name;
}

/**
 * What a receiver identifier is, by its definition in this file: `'function'` (a function or class declaration, a
 * `const` of a function, a parameter typed as a function), `'ramme'` (an import, a variable made by `task(…)`,
 * `createRootContext()` and the like, a parameter typed `Task`, `Context` or `Pool`), else `'unknown'` (a global, an
 * untyped parameter, a variable of any other value).
 */
function receiverKind(variable: Scope.Variable | undefined): 'function' | 'ramme' | 'unknown' {
  const def = variable?.defs[0];
  if (def === undefined) return 'unknown';
  switch (def.type) {
    case 'FunctionName':
    case 'ClassName':
      return 'function';
    case 'ImportBinding':
      return 'ramme';
    case 'Variable': {
      const init = (def.node as EsNode & { init?: EsNode | null }).init;
      if (isFunctionNode(init)) return 'function';
      return isRammeMaker(init) ? 'ramme' : 'unknown';
    }
    case 'Parameter': {
      const type = annotation(def.name as EsNode);
      if (type === undefined) return 'unknown';
      if ((type.type as string) === 'TSFunctionType') return 'function';
      const name = typeName(type);
      return name !== undefined && RAMME_TYPES.has(name) ? 'ramme' : 'unknown';
    }
    default:
      return 'unknown';
  }
}

/** A `this`-argument that only `Function.prototype.call` takes: `this`, `null`, `undefined`, `void …`, `globalThis`. */
function isThisArg(context: Rule.RuleContext, arg: EsNode): boolean {
  const a = unwrap(arg);
  if (a.type === 'ThisExpression') return true;
  if (a.type === 'Literal' && a.value === null) return true;
  if (a.type === 'UnaryExpression' && a.operator === 'void') return true;
  return a.type === 'Identifier' && (a.name === 'undefined' || a.name === 'globalThis') && isGlobalName(context, a);
}

/** An argument that is a task or a body: a function, `task(…)` or `bind(…)`, or a name this file binds to one, or an import. */
function isTaskLike(context: Rule.RuleContext, arg: EsNode): boolean {
  const a = unwrap(arg);
  if (isFunctionNode(a)) return true;
  if (a.type === 'CallExpression') {
    const name = calleeName(a);
    return name === 'task' || name === 'bind';
  }
  if (a.type !== 'Identifier') return false;
  const def = declaredVariable(context, a, a.name)?.defs[0];
  if (def === undefined) return false;
  if (def.type === 'FunctionName' || def.type === 'ImportBinding') return true;
  if (def.type !== 'Variable') return false;
  const init = (def.node as EsNode & { init?: EsNode | null }).init;
  if (isFunctionNode(init)) return true;
  if (init === null || init === undefined) return false;
  const i = unwrap(init);
  if (i.type !== 'CallExpression') return false;
  const name = calleeName(i);
  return name === 'task' || name === 'bind';
}

/** Whether a member's object chain goes through `.prototype` (`Array.prototype.forEach.call`). */
function throughPrototype(member: MemberExpression): boolean {
  for (let o: EsNode = unwrap(member.object as EsNode); o.type === 'MemberExpression'; o = unwrap(o.object as EsNode))
    if (propertyName(o) === 'prototype') return true;
  return false;
}

/** Whether `<receiver>.call(…)` is `Function.prototype.call`, as far as the syntax shows (see the header). */
function isFunctionCall(context: Rule.RuleContext, member: MemberExpression, args: readonly EsNode[]): boolean {
  if (throughPrototype(member)) return true;
  const first = args[0];
  if (first !== undefined && first.type !== 'SpreadElement' && isThisArg(context, first)) return true;
  const receiver = unwrap(member.object as EsNode);
  const kind = receiver.type === 'Identifier' ? receiverKind(declaredVariable(context, receiver, receiver.name)) : 'unknown';
  if (kind === 'function') return true;
  if (kind === 'ramme') return false;
  return !(first !== undefined && first.type !== 'SpreadElement' && isTaskLike(context, first));
}

/** Whether a method call is the platform's, not ramme's (see the header). */
function isPlatformMethod(context: Rule.RuleContext, member: MemberExpression, name: string, args: readonly EsNode[]): boolean {
  const receiver = unwrap(member.object as EsNode);
  if (receiver.type === 'Identifier' && PLATFORM_RECEIVERS.has(receiver.name) && isGlobalName(context, receiver as Identifier)) return true;
  return name === 'call' && isFunctionCall(context, member, args);
}

export const noUnusedOp: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a work op nobody yields, awaits, returns or stores: it runs nothing',
      recommended: true,
      url: docsUrl('no-unused-op'),
    },
    messages: {
      unused:
        '`{{name}}(…)` makes a work op and drops it: a work op is lazy and runs only when it is consumed, so this runs ' +
        'nothing. Write `yield* {{name}}(…)` in a body (or `await` it from plain async code), or keep the op to yield ' +
        'later (ramme DECISIONS.md D41).',
    },
    schema: [],
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        let e = unwrap(node.expression as EsNode);
        if (e.type === 'UnaryExpression' && e.operator === 'void') e = unwrap(e.argument as EsNode);
        if (e.type !== 'CallExpression') return;
        const name = calleeName(e);
        if (name === undefined || !WORK_VERBS.has(name)) return;
        const callee = unwrap(e.callee as EsNode);
        if (callee.type === 'MemberExpression') {
          // An explicit receiver needs no current node, so a dropped method op runs nothing at any level.
          if (isPlatformMethod(context, callee, name, e.arguments as EsNode[])) return;
        } else if (enclosingFunction(node) === null) return; // a free op made at module level throws NoCurrentNodeError
        context.report({ node: e, messageId: 'unused', data: { name } });
      },
    };
  },
};
