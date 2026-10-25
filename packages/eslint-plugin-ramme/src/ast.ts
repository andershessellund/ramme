// Syntax helpers shared by the rules. The rules see ESTree as ESLint's own
// types name it, plus the few TypeScript expression wrappers that
// typescript-eslint's parser adds (`x as T`, `x!`, `x satisfies T`, `<T>x`),
// which they look through by type name. ESLint sets `parent` on every node
// before any rule runs, so walking up from a node reached through a child
// property is safe.

import type { Rule, Scope, SourceCode } from 'eslint';

/** An ESTree node, as `eslint`'s types name the union (this package has no direct `@types/estree`). */
export type EsNode = Parameters<SourceCode['getScope']>[0];
/** The ESTree node of one `type`. */
export type NodeOf<T extends EsNode['type']> = Extract<EsNode, { type: T }>;

export type CallExpression = NodeOf<'CallExpression'>;
export type MemberExpression = NodeOf<'MemberExpression'>;
export type Identifier = NodeOf<'Identifier'>;

/** `node.parent`, which ESLint sets on every node; `null` above `Program`. */
export function parentOf(node: EsNode): EsNode | null {
  return (node as EsNode & { parent?: EsNode | null }).parent ?? null;
}

const TS_WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion']);

/** `node` with TypeScript's expression wrappers and an optional chain's `ChainExpression` taken off. */
export function unwrap(node: EsNode): EsNode {
  let n = node;
  while (TS_WRAPPERS.has(n.type as string) || n.type === 'ChainExpression') {
    n = (n as unknown as { expression: EsNode }).expression;
  }
  return n;
}

/** The name of a member access's property when it is written as a name (`a.b`) or a string (`a['b']`). */
export function propertyName(member: MemberExpression): string | undefined {
  const p = member.property;
  if (!member.computed && p.type === 'Identifier') return p.name;
  if (member.computed && p.type === 'Literal' && typeof p.value === 'string') return p.value;
  return undefined;
}

/**
 * The name a call is made through: `f` for `f(…)`, `m` for `<x>.m(…)` (and `<x>?.m(…)`, `<x>['m'](…)`).
 * A private name (`<x>.#m(…)`) has none.
 */
export function calleeName(call: CallExpression): string | undefined {
  const callee = unwrap(call.callee as EsNode);
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') return propertyName(callee);
  return undefined;
}

/** Whether `node` is a call `name(…)` with `name` a plain identifier. */
export function isFreeCall(node: EsNode, name: string): node is CallExpression {
  if (node.type !== 'CallExpression') return false;
  const callee = unwrap(node.callee as EsNode);
  return callee.type === 'Identifier' && callee.name === name;
}

/** Whether `node` is a call `name(…)` or `<x>.name(…)`. */
export function isFreeOrMethodCall(node: EsNode, name: string): node is CallExpression {
  return node.type === 'CallExpression' && calleeName(node) === name;
}

function isFunction(node: EsNode): node is NodeOf<'FunctionDeclaration' | 'FunctionExpression' | 'ArrowFunctionExpression'> {
  return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

/**
 * The nearest function, method or arrow lexically enclosing `node`, or `null` when `node` runs
 * outside any: at module level, or in a class static block, which is evaluated synchronously as a
 * function of its own.
 */
export function enclosingFunction(node: EsNode): EsNode | null {
  for (let n = parentOf(node); n !== null; n = parentOf(n)) {
    if (isFunction(n)) return n;
    if (n.type === 'StaticBlock') return null;
  }
  return null;
}

/**
 * The variable `name` resolves to from `node`'s scope, or `undefined` when it resolves to nothing
 * declared in this file (a global, or an undeclared name).
 */
export function declaredVariable(context: Rule.RuleContext, node: EsNode, name: string): Scope.Variable | undefined {
  for (let s: Scope.Scope | null = context.sourceCode.getScope(node); s !== null; s = s.upper) {
    const v = s.set.get(name);
    if (v !== undefined) return v.defs.length > 0 ? v : undefined;
  }
  return undefined;
}

/** Whether the identifier `id` names the global of that name: nothing in this file declares it. */
export function isGlobalName(context: Rule.RuleContext, id: Identifier): boolean {
  return declaredVariable(context, id, id.name) === undefined;
}
