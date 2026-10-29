// The platform's timers. A timer is a foreign wait: a body waiting on one
// through `wait(p)` is let finish by a halt, so its node is held for the rest
// of the timer, and nothing clears a timer when its node ends (DESIGN.md
// §4.2, §4.4). ramme's `sleep` is a wait the halt cuts: the body is returned
// at once and its timer cleared (D34). `requestAnimationFrame` is the
// browser's frame timer, a callback too: `nextFrame` from `ramme/platform` is
// its wait, whose frame a halt cancels (D43).

import type { Rule } from 'eslint';
import { type EsNode, isGlobalName, propertyName, unwrap } from '../ast.js';
import { docsUrl } from '../docs.js';

/** The timer names, by the message that names their replacement. */
const TIMERS = new Map([
  ['setTimeout', 'call'],
  ['setInterval', 'call'],
  ['setImmediate', 'call'],
  ['requestAnimationFrame', 'frame'],
]);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'global']);
const TIMER_MODULES = new Set(['timers', 'node:timers', 'timers/promises', 'node:timers/promises']);

const FIX =
  'Use `yield* sleep(ms)` in a body, or `await ctx.sleep(ms)` where no node is current (the free `sleep` throws ' +
  '`NoCurrentNodeError` there); to repeat, `fork` a task that loops on `yield* sleep(ms)`.';

export const noTimers: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow `setTimeout`, `setInterval`, `setImmediate` and `requestAnimationFrame`, which no halt clears; use ' +
        'ramme’s `sleep`, and `nextFrame` from `ramme/platform`',
      recommended: true,
      url: docsUrl('no-timers'),
    },
    messages: {
      call:
        '`{{name}}` is a platform timer, which no halt clears: an interrupted body waiting on it keeps its node alive until ' +
        'it fires, and nothing clears it when its node ends (ramme DESIGN.md §4.2, §4.4). ' +
        FIX,
      frame:
        '`requestAnimationFrame` is the platform’s frame timer: its callback runs outside every node, and no halt ' +
        'cancels it. Use `yield* nextFrame()` from `ramme/platform`, the frame’s timestamp as a wait whose frame a halt ' +
        'cancels (ramme DECISIONS.md D43).',
      import: '`{{name}}` from `{{module}}` is a platform timer, which no halt clears (ramme DESIGN.md §4.2, §4.4). ' + FIX,
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
        if (name !== undefined) context.report({ node: callee, messageId: TIMERS.get(name)!, data: { name } });
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
