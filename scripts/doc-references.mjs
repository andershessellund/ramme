// ---------------------------------------------------------------------------
// Which document a `§n` cross-reference names: the resolver of
// scripts/check-docs.mjs (its rule 2), a module of its own so that
// src/test/scripts.test.ts can test it. Dev-only.
//
// A reference names a section of DESIGN.md unless a document name (DESIGN,
// DECISIONS, PROPOSAL, README, with or without `.md`) qualifies it in the same
// clause, or a decision whose record was a document immediately precedes it
// (`D41 §4.1`: D41's record was PROPOSAL.md, which is deleted, so such a
// reference fails the check instead of passing as a DESIGN.md one).
// ---------------------------------------------------------------------------

/** A `§n` or `§n.m` reference, or a range of them (`§4.1–§4.4`). */
export const REF = /§§?\s?(\d+(?:\.\d+)*)(?:\s?[–-]\s?§?(\d+(?:\.\d+)*))?/g;

/** The documents a reference can name, by the spelling that qualifies it. */
export const DOCUMENT_NAMES = { DESIGN: 'DESIGN.md', DECISIONS: 'DECISIONS.md', PROPOSAL: 'PROPOSAL.md', README: 'README.md' };
/** A decision whose record was a document: `D41 §4.1` is PROPOSAL.md's §4.1. */
export const DECISION_RECORDS = { D41: 'PROPOSAL.md' };

/** A document's name, which qualifies a reference after it in the same clause. */
const DOCUMENT = /\b(DESIGN|DECISIONS|PROPOSAL|README)(?:\.md)?\b/g;
/**
 * A decision id that immediately precedes the reference: at the very end of the text before its `§`, which is all
 * `target` searches, so no lookahead for the `§` can see it.
 */
const PRECEDING_DECISION = /\b(D\d+)′?\s?$/;

/**
 * What may stand between a document's name and a reference it qualifies: other references, decision and row numbers
 * (`PROPOSAL.md §5, decisions 19–26; §8`), separators, and the comment markers of a wrapped source comment. A word, a
 * closing parenthesis or a sentence's end ends the qualification.
 */
const QUALIFIED_GAP =
  /^(?:\s|§§?\s?\d+(?:\.\d+)*(?:\s?[–-]\s?§?\d+(?:\.\d+)*)?|\bdecisions?\s\d+(?:\s?[–-]\s?\d+)?|\brows?\s\d+|\bD\d+′?|\band\b|\bor\b|['’]s\b|[,;:–—&(“"‘'*/#-])*$/;

/**
 * The document a reference whose `§` is at index `i` names: the record of a decision that immediately precedes it,
 * else the nearest document name that qualifies it in the same clause, else DESIGN.md.
 */
export function target(text, i) {
  const window = text.slice(Math.max(0, i - 200), i);
  const decision = PRECEDING_DECISION.exec(window)?.[1];
  if (decision !== undefined && DECISION_RECORDS[decision] !== undefined) return DECISION_RECORDS[decision];
  let last = null;
  for (const q of window.matchAll(DOCUMENT)) last = q;
  if (last !== null && QUALIFIED_GAP.test(window.slice(last.index + last[0].length))) return DOCUMENT_NAMES[last[1]];
  return 'DESIGN.md';
}
