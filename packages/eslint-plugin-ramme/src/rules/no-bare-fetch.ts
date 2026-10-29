// The platform's `fetch` in a ramme body (D43; D41, decisions 20
// and 26). A bare `fetch(url)` is a promise the driver cannot see: waited for
// with `yield* wait(fetch(url))`, a halt lets it finish, so the body's node is
// held for the whole request, and nothing aborts it. `fetch` from
// `ramme/platform` takes the global's own parameters and is an op: `yield*
// fetch(url)` hands the request the body's signal, so a halt aborts it.
//
// Flagged: a call of the global `fetch` (bare, or `globalThis.fetch(…)`,
// `window.fetch(…)`, `self.fetch(…)`) lexically inside a generator function (a
// body, a helper, a generator method; nested callbacks included, so
// `wait((signal) => fetch(url, { signal }))` is reported too), in a file that
// imports from `ramme` or a subpath. Elsewhere `fetch` is plain async code's,
// and the platform's op would throw there: it needs a current node.
//
// The fix adds `fetch` to the file's `ramme/platform` import (or a new import
// after its last ramme import), which shadows the global in the whole file. It
// is offered only where that keeps every use working: every reference to the
// global `fetch` in the file is a call made directly in a generator function,
// or in the function a `wait(…)` there is handed, whose result is used as an
// op can be (a discarded `fetch(…)` runs a request, the op would run nothing;
// the op is a plain thenable, so `.catch(…)` or `.finally(…)` on it, or on a
// `.then(…)` of it, would throw; and a plain `yield fetch(…)` hands the
// request to a generator's consumer, a generator that is no body, where the op
// would throw with no current node).

import type { Rule, Scope } from 'eslint';
import {
  type CallExpression,
  type EsNode,
  type Identifier,
  type NodeOf,
  calleeName,
  enclosingFunction,
  inGeneratorBody,
  isGlobalName,
  parentOf,
  propertyName,
  rammeImports,
  unwrap,
} from '../ast.js';
import { docsUrl } from '../docs.js';

/** The globals a `fetch` can be read from. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self']);

/** The wrappers an expression can sit in without changing what it is: TypeScript's, and an optional chain's. */
const WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ChainExpression']);

/** `node`'s nearest parent that is not one of `WRAPPERS` around it, and the outermost wrapper it is reached through. */
function outerParent(node: EsNode): { node: EsNode; parent: EsNode | null } {
  let n = node;
  let p = parentOf(n);
  while (p !== null && WRAPPERS.has(p.type as string) && (p as unknown as { expression: EsNode }).expression === n) {
    n = p;
    p = parentOf(n);
  }
  return { node: n, parent: p };
}

/** The call `id` is the callee of (`fetch(url)`, `(fetch as F)(url)`), or `undefined`. */
function callOf(id: EsNode): CallExpression | undefined {
  const { node, parent } = outerParent(id);
  return parent?.type === 'CallExpression' && parent.callee === node ? parent : undefined;
}

/** A generator function that can be a body (never an `async function*`). */
function isBodyGenerator(fn: EsNode | null): boolean {
  return fn !== null && (fn.type === 'FunctionDeclaration' || fn.type === 'FunctionExpression') && fn.generator === true && fn.async !== true;
}

/** A call whose result is dropped: an expression statement, or one under `void`. */
function isDiscarded(call: CallExpression): boolean {
  const { parent } = outerParent(call);
  return parent?.type === 'ExpressionStatement' || (parent?.type === 'UnaryExpression' && parent.operator === 'void');
}

/**
 * A call whose result is used as the global's promise is, which the op is not: a member other than `then` read off it
 * (`.catch`, `.finally`: the op is a plain thenable, whose `then` is a `PromiseLike`'s, so the same holds down a
 * `.then(…)` chain), or the operand of a plain `yield` (a generator that is no body hands it to its consumer).
 */
function isUsedAsAPromise(call: CallExpression): boolean {
  const { node, parent } = outerParent(call);
  if (parent?.type === 'MemberExpression' && parent.object === node) {
    if (propertyName(parent) !== 'then') return true;
    const then = callOf(parent);
    return then === undefined || isUsedAsAPromise(then); // `.then` read and not called is no thenable's use either
  }
  return parent?.type === 'YieldExpression' && parent.delegate !== true;
}

/** Whether the import of `fetch` from `ramme/platform` keeps this call working (see the header). */
function isSafeCall(call: CallExpression): boolean {
  if (isDiscarded(call) || isUsedAsAPromise(call)) return false;
  const fn = enclosingFunction(call);
  if (isBodyGenerator(fn)) return true;
  // The function `wait(fn)` is handed runs when the op runs, in the node's frame: `wait((signal) => fetch(u, { signal }))`.
  const p = fn === null ? null : parentOf(fn);
  return p?.type === 'CallExpression' && (p.arguments[0] as EsNode | undefined) === fn && calleeName(p) === 'wait' && isBodyGenerator(enclosingFunction(p));
}

/** Every reference in the file to the global `fetch`: unresolved, or resolved to a variable no declaration in the file makes. */
function globalFetchReferences(sourceCode: Rule.RuleContext['sourceCode']): Identifier[] {
  const refs: Identifier[] = [];
  for (const scope of sourceCode.scopeManager.scopes)
    for (const r of scope.references as Scope.Reference[])
      if (r.identifier.name === 'fetch' && (r.resolved === null || r.resolved.defs.length === 0)) refs.push(r.identifier as Identifier);
  return [...new Set(refs)];
}

export const noBareFetch: Rule.RuleModule = {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: {
      description: 'Disallow the global `fetch` in a body of a file that uses ramme; use `fetch` from `ramme/platform`',
      recommended: true,
      url: docsUrl('no-bare-fetch'),
    },
    messages: {
      bare:
        '`{{form}}` is the platform’s fetch: a promise ramme cannot see, so a halt lets the whole request finish and ' +
        'aborts nothing. Use `yield* fetch(…)` from `ramme/platform`, the same parameters as an op that is handed the ' +
        'body’s signal, so a halt aborts the request (ramme DECISIONS.md D43).',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const imports = rammeImports(sourceCode);
    if (imports.length === 0) return {}; // a file that does not use ramme: its fetch is plain async code's
    return {
      'Program:exit'() {
        const calls = globalFetchReferences(sourceCode).map(callOf);
        const fixable = calls.every((call) => call !== undefined && isSafeCall(call));
        // Into the file's named `ramme/platform` import, or as one after its last ramme import.
        const addImport = (fixer: Rule.RuleFixer): Rule.Fix => {
          const platform = imports.find(
            (d) =>
              d.source.value === 'ramme/platform' &&
              (d as { importKind?: string }).importKind !== 'type' &&
              d.specifiers.length > 0 &&
              d.specifiers.every((s) => s.type === 'ImportSpecifier'),
          );
          if (platform !== undefined) return fixer.insertTextAfter(platform.specifiers.at(-1) as EsNode, ', fetch');
          return fixer.insertTextAfter(imports.at(-1) as NodeOf<'ImportDeclaration'>, "\nimport { fetch } from 'ramme/platform';");
        };
        // Every report carries the same insertion; ESLint applies one of them, the rest overlapping it.
        for (const call of calls) {
          if (call === undefined || !inGeneratorBody(call)) continue;
          context.report({ node: call, messageId: 'bare', data: { form: 'fetch(…)' }, ...(fixable ? { fix: addImport } : {}) });
        }
      },
      CallExpression(node) {
        const callee = unwrap(node.callee as EsNode);
        if (callee.type !== 'MemberExpression' || propertyName(callee) !== 'fetch' || !inGeneratorBody(node)) return;
        const object = unwrap(callee.object as EsNode);
        if (object.type === 'Identifier' && GLOBAL_OBJECTS.has(object.name) && isGlobalName(context, object))
          context.report({ node, messageId: 'bare', data: { form: `${object.name}.fetch(…)` } });
      },
    };
  },
};
