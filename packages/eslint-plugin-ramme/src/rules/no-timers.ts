// The platform's timers. A timer is a bare await: an interruption cannot
// reject a body waiting on one before it fires, so its node is held for the
// rest of the wait, and nothing clears a timer when its node ends
// (DESIGN.md §4.2, §4.4). ramme's `sleep` is a managed await whose timer is
// cleared at the interruption, which rejects it.

import type { Rule } from 'eslint';
import { type EsNode, isGlobalName, propertyName, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'global']);
const TIMER_MODULES = new Set(['timers', 'node:timers', 'timers/promises', 'node:timers/promises']);

const FIX =
  'Use `sleep(ms)` in a body, or `ctx.sleep(ms)` where no node is current (the free `sleep` throws `NoCurrentNodeError` there); ' +
  'to repeat, `fork` a task that loops on `sleep`.';

export const noTimers: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow `setTimeout`, `setInterval` and `setImmediate`, which are bare awaits; use ramme’s `sleep`',
      recommended: true,
      url: docsUrl('no-timers'),
    },
    messages: {
      call:
        '`{{name}}` is a bare timer, not a managed await: an interrupted body waiting on it keeps its node alive until it fires, ' +
        'and nothing clears it when its node ends (ramme DESIGN.md §4.2, §4.4). ' +
        FIX,
      import: '`{{name}}` from `{{module}}` is a bare timer, not a managed await (ramme DESIGN.md §4.2, §4.4). ' + FIX,
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee as EsNode);
        let name: string | undefined;
        if (callee.type === 'Identifier') {
          // A name imported from a timers module is reported at its import; any other declared one is not a timer.
          if (TIMERS.has(callee.name) && isGlobalName(context, callee)) name = callee.name;
        } else if (callee.type === 'MemberExpression') {
          const object = unwrap(callee.object as EsNode);
          const property = propertyName(callee);
          if (
            property !== undefined &&
            TIMERS.has(property) &&
            object.type === 'Identifier' &&
            GLOBAL_OBJECTS.has(object.name) &&
            isGlobalName(context, object)
          )
            name = property;
        }
        if (name !== undefined) context.report({ node: callee, messageId: 'call', data: { name } });
      },
      ImportDeclaration(node) {
        const module = node.source.value;
        if (typeof module !== 'string' || !TIMER_MODULES.has(module)) return;
        if ((node as { importKind?: string }).importKind === 'type') return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue;
          if ((specifier as { importKind?: string }).importKind === 'type') continue;
          const imported = specifier.imported;
          const name = imported.type === 'Identifier' ? imported.name : String(imported.value);
          if (TIMERS.has(name)) context.report({ node: specifier, messageId: 'import', data: { name, module } });
        }
      },
    };
  },
};
