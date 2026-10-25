// A work op nobody consumes. A work op is lazy (D41, decision 2): a task's
// call `t(x)` makes the child only when it is yielded, so `t(x);` alone runs
// nothing, where an `await` forgotten in an async body ran the call anyway.
//
// The name-based half, which needs no type information: a call of a work verb
// (`attempt`, `all`, `race`, `settle`, `shield`, `unshield`, `join`, `result`,
// `sleep`, `interrupted`, `never`, `wait`), free or as a method, and a node's
// `call` (`app.call(…)`; there is no free `call`: a task is called, D44), as an
// expression statement or under `void`: a free one inside a function (at
// module level no node is current, so it throws `NoCurrentNodeError` when
// made), a method one anywhere (an explicit receiver needs no current node, so
// `app.call(main);` at the top of a script runs nothing either). `fork` is
// eager and returns a fiber, and the lifecycle verbs (`release`, `releaseAll`,
// `close`) start their work when called, so `fork(t);` and `void release(x);`
// are fine. `no-unused-outcome` reports a consumed `attempt`, `settle` or
// `result` whose outcome is discarded.
//
// The type-aware half (D44, decision 9), when the parser has type information
// (`parserServices.program`, typescript-eslint's `project`): a call statement
// inside a function whose callee is a task, written any way (`t(x);`,
// `this.get(path);`, `this.#get(path);`, `api?.get(path);`,
// `t.with(opts)(x);`, `task(function* () { … })();`), and whose value is an
// op. A task is a function, so syntax alone cannot tell `t(x)` from any other
// call; without type information it is not flagged.
//
// A task is called through `Function.prototype` too: `t.call(self, x)` and
// `t.apply(self, [x])` are `t(x)` (D44), so they are flagged as its call, by
// type, and without type information when `t` is a name this file binds to
// `task(…)`, as a task's own `call` was before D44.
//
// `ramme/platform`'s ops are lazy too (D43): `fetch(…)`, `nextFrame()`,
// `each(…)` and `each.next()`, flagged when the file imports them from
// `ramme/platform` (the names alone are common: the global `fetch`, lodash's
// `each`), so a dropped `fetch(url);` that sends nothing is reported.
//
// The platform's own methods of those names are not flagged: `Promise.all`,
// `Promise.race` and `Atomics.wait` on the globals, and `Function.prototype.call`
// where the syntax shows it (`X.prototype.m.call(…)`, a `this`-argument of
// `this`, `null`, `undefined`, `void …` or `globalThis`, a receiver this file
// declares as a function, or a receiver the file does not show to be ramme's,
// such as a parameter, called with an argument that is no task or body).

import type { Rule, Scope } from 'eslint';
import type * as ts from 'typescript';
import {
  type CallExpression,
  type EsNode,
  type Identifier,
  type MemberExpression,
  calleeName,
  declaredVariable,
  enclosingFunction,
  importBinding,
  isGlobalName,
  propertyName,
  unwrap,
} from '../ast.js';
import { docsUrl } from '../docs.js';

/** What typescript-eslint's parser hands a rule when it has type information (its `project`). */
interface TypedServices {
  readonly program: ts.Program;
  readonly esTreeNodeToTSNodeMap: { get(node: EsNode): ts.Node };
}

/** The parser's type information, or `undefined` when there is none (another parser, no `project`). */
function typedServices(context: Rule.RuleContext): TypedServices | undefined {
  const s = context.sourceCode.parserServices as Partial<TypedServices> | undefined;
  return s?.program !== undefined && s.program !== null && s.esTreeNodeToTSNodeMap !== undefined ? (s as TypedServices) : undefined;
}

/** Whether a type has a property of this name, or, for a well-known symbol, one TypeScript names `__@<symbol>@…`. */
function hasProperty(type: ts.Type, name: string, symbol = false): boolean {
  return type.getProperties().some((p) => (symbol ? String(p.escapedName).startsWith(`__@${name}@`) : p.name === name));
}

/**
 * Whether a type is ramme's `Op`: by name, or by shape, an `Operation` (`[Symbol.iterator]`) that is a plain thenable
 * (`then`, no `catch`); a lifecycle op, which is a `Promise` too and starts its work when made, is not one here.
 */
function isOpType(type: ts.Type): boolean {
  const types = type.isUnion() ? type.types : [type];
  return (
    types.length > 0 &&
    types.every((t) => t.getSymbol()?.name === 'Op' || (hasProperty(t, 'then') && hasProperty(t, 'iterator', true) && !hasProperty(t, 'catch')))
  );
}

/** Whether a type is ramme's `Task`: callable, with `with`, and named `Task` or carrying the task's brand (declared under a unique symbol, `TASK`). */
function isTaskType(type: ts.Type): boolean {
  return type.getCallSignatures().length > 0 && hasProperty(type, 'with') && (type.getSymbol()?.name === 'Task' || hasProperty(type, 'TASK', true));
}

/** `Function.prototype`'s methods that call their receiver: on a task, `t.call(self, x)` and `t.apply(self, [x])` are `t(x)` (D44). */
const CALLING_METHODS = new Set(['call', 'apply']);

/**
 * The task a call is made through: the callee, or for `<x>.call(…)` and `<x>.apply(…)` the receiver `<x>`; the
 * receiver is only a candidate, which the caller checks to be a task.
 */
function calledTask(call: CallExpression): { readonly node: EsNode; readonly viaFunction: boolean } {
  const callee = unwrap(call.callee as EsNode);
  if (callee.type === 'MemberExpression' && CALLING_METHODS.has(propertyName(callee) ?? ''))
    return { node: unwrap(callee.object as EsNode), viaFunction: true };
  return { node: callee, viaFunction: false };
}

/**
 * The name a report gives a task: its name (`load`, `get` of `this.get`), a private one (`#get`), the call that makes
 * it (`with(…)` for `t.with(o)(x)`, `task(…)` for `task(…)()`), else `task`.
 */
function taskLabel(node: EsNode): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') {
    const p = node.property as EsNode;
    return propertyName(node) ?? (p.type === 'PrivateIdentifier' ? `#${p.name}` : 'task');
  }
  if (node.type === 'CallExpression') {
    const maker = calleeName(node);
    return maker === undefined ? 'task' : `${maker}(…)`;
  }
  return 'task';
}

/**
 * The type-aware half (see the header): a call whose task (`calledTask`) has a `Task` type and whose value is an `Op`,
 * `undefined` and `null` taken off both (an optional call), named by `taskLabel`; `undefined` for any other call.
 */
function droppedTaskCall(context: Rule.RuleContext, call: CallExpression): string | undefined {
  const services = typedServices(context);
  if (services === undefined) return undefined;
  const checker = services.program.getTypeChecker();
  const typeOf = (n: EsNode): ts.Type => checker.getNonNullableType(checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(n)));
  const task = calledTask(call).node;
  if (!isTaskType(typeOf(task))) return undefined;
  return isOpType(typeOf(call as EsNode)) ? taskLabel(task) : undefined;
}

/** Whether `id` names a variable this file initialises with `task(…)`. */
function boundToTask(context: Rule.RuleContext, id: Identifier): boolean {
  const def = declaredVariable(context, id, id.name)?.defs[0];
  if (def?.type !== 'Variable') return false;
  const init = (def.node as EsNode & { init?: EsNode | null }).init;
  if (init === null || init === undefined) return false;
  const i = unwrap(init);
  return i.type === 'CallExpression' && calleeName(i) === 'task';
}

/**
 * A task's call made and dropped, by name: `t.call(self, x)` or `t.apply(self, [x])` on a `t` this file binds to
 * `task(…)` without type information, and with it any call `droppedTaskCall` reads; `undefined` for any other call.
 */
function droppedTask(context: Rule.RuleContext, call: CallExpression): string | undefined {
  const { node, viaFunction } = calledTask(call);
  if (viaFunction && node.type === 'Identifier' && boundToTask(context, node)) return node.name;
  return droppedTaskCall(context, call);
}

/** `ramme/platform`'s work ops, recognized by their import. */
const PLATFORM_OPS = new Set(['fetch', 'nextFrame', 'each']);

/** The op a call of `ramme/platform`'s makes (`fetch`, `nextFrame`, `each`, `each.next`), by the file's import of it. */
function platformOp(context: Rule.RuleContext, call: CallExpression): string | undefined {
  const callee = unwrap(call.callee as EsNode);
  const binding = (id: EsNode): string | undefined => {
    if (id.type !== 'Identifier') return undefined;
    const b = importBinding(context, id);
    return b?.module === 'ramme/platform' && PLATFORM_OPS.has(b.imported) ? b.imported : undefined;
  };
  if (callee.type === 'Identifier') return binding(callee);
  if (callee.type === 'MemberExpression' && propertyName(callee) === 'next' && binding(unwrap(callee.object as EsNode)) === 'each')
    return 'each.next';
  return undefined;
}

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

/**
 * The calls that make a node, which has ramme's `call`. A task's own `call` is `Function.prototype.call` (D44): a
 * variable made by `task(…)` is no node, and `t.call(self, x)` on one is the task's call, which `droppedTask` reports.
 */
const RAMME_MAKERS = new Set(['createRootContext', 'current', 'child', 'pool']);

/** The type names a parameter annotated as ramme's node is written with. */
const RAMME_TYPES = new Set(['Context', 'Pool']);

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
 * `const` of a function, a parameter typed as a function), `'ramme'` (an import, a variable made by
 * `createRootContext()` and the like, a parameter typed `Context` or `Pool`), else `'unknown'` (a global, an untyped
 * parameter, a variable of any other value, a task).
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

/** An argument that is a task or a body: a function or `task(…)`, or a name this file binds to one, or an import. */
function isTaskLike(context: Rule.RuleContext, arg: EsNode): boolean {
  const a = unwrap(arg);
  if (isFunctionNode(a)) return true;
  if (a.type === 'CallExpression') return calleeName(a) === 'task';
  if (a.type !== 'Identifier') return false;
  const def = declaredVariable(context, a, a.name)?.defs[0];
  if (def === undefined) return false;
  if (def.type === 'FunctionName' || def.type === 'ImportBinding') return true;
  if (def.type !== 'Variable') return false;
  const init = (def.node as EsNode & { init?: EsNode | null }).init;
  if (isFunctionNode(init)) return true;
  if (init === null || init === undefined) return false;
  const i = unwrap(init);
  return i.type === 'CallExpression' && calleeName(i) === 'task';
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
        const platform = platformOp(context, e);
        if (platform !== undefined) {
          if (enclosingFunction(node) !== null) context.report({ node: e, messageId: 'unused', data: { name: platform } });
          return;
        }
        // A task's call, also through `Function.prototype`'s `call` and `apply`: by type, or by this file's `task(…)`.
        // Made at module level, it throws `NoCurrentNodeError`, as a free op does.
        const task = droppedTask(context, e);
        if (task !== undefined) {
          if (enclosingFunction(node) !== null) context.report({ node: e, messageId: 'unused', data: { name: task } });
          return;
        }
        const name = calleeName(e);
        const callee = unwrap(e.callee as EsNode);
        // There is no free `call`: a task is called (D44). A node's `call` is a work verb.
        const verb = name !== undefined && WORK_VERBS.has(name) && !(name === 'call' && callee.type !== 'MemberExpression');
        if (!verb) return;
        if (callee.type === 'MemberExpression') {
          // An explicit receiver needs no current node, so a dropped method op runs nothing at any level.
          if (isPlatformMethod(context, callee, name, e.arguments as EsNode[])) return;
        } else if (enclosingFunction(node) === null) return; // a free op made at module level throws NoCurrentNodeError
        context.report({ node: e, messageId: 'unused', data: { name } });
      },
    };
  },
};
