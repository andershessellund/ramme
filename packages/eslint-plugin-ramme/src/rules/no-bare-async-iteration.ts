// `for await` in ramme code (D43; D41, decision 24). A body is a
// generator function, where `for await` is a syntax error (TS1103); written in
// an async callback or helper instead, the loop's waits are invisible to
// ramme: a halt cannot stop it, the current node is gone after its first
// `await`, and the source is not closed as the body's release work. In a body,
// `each` from `ramme/platform` iterates an async iterable:
// `for (const x of yield* each(source)) { …; yield* each.next(); }`; a halt or
// a `break` returns the source, and the node waits for it.
//
// Flagged: every `for await` in a file that imports from `ramme` or a subpath,
// and one lexically inside a generator function anywhere (in an async function
// or arrow a body or a helper contains). An `async function*` elsewhere is no
// body, and not flagged.

import type { Rule } from 'eslint';
import { type EsNode, inGeneratorBody, rammeImports } from '../ast.js';
import { docsUrl } from '../docs.js';

export const noBareAsyncIteration: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow `for await` in a file that uses ramme or inside a generator body; use `each` from `ramme/platform`',
      recommended: true,
      url: docsUrl('no-bare-async-iteration'),
    },
    messages: {
      forAwait:
        '`for await` waits where ramme cannot see it: a halt cannot stop the loop, no node is current after its first ' +
        'wait, and its source is not closed as release work. In a body write ' +
        '`for (const x of yield* each(source)) { …; yield* each.next(); }`, with `each` from `ramme/platform`: a halt or ' +
        'a `break` returns the source, and the node waits for it (ramme DECISIONS.md D43).',
    },
    schema: [],
  },
  create(context) {
    const usesRamme = rammeImports(context.sourceCode).length > 0;
    return {
      ForOfStatement(node) {
        if (!node.await || !(usesRamme || inGeneratorBody(node as EsNode))) return;
        // At the loop's head, `for await (… of source)`, not over its whole body.
        context.report({ node, loc: { start: node.loc!.start, end: node.right.loc!.end }, messageId: 'forAwait' });
      },
    };
  },
};
