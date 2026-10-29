// ---------------------------------------------------------------------------
// The documents check, half one: words and cross-references. Run by
// `pnpm check:docs` (with scripts/check-doc-blocks.mjs, half two). Dev-only.
//
// 1. Retired terms. DESIGN.md, README.md and the lint plugin's README describe
//    one runtime, so none of `TERMS` may appear in them: the mechanisms D41
//    removed (freeze, sticky rejection, lending, `managed(`, InterruptedError,
//    UnawaitedCallError, AsyncLocalStorage, async context, async bodies) and
//    the words of a change in progress (stage, provisional, transitional,
//    "today", PR numbers, PROPOSAL). DECISIONS.md is the record, so there the
//    words of the change are allowed anywhere but "provisional" as an entry's
//    status (a heading, "(provisional)", "Provisional:"), and the mechanisms
//    only inside the entries that record them (`RECORD_ENTRIES`). Always
//    allowed: the interrupt mode `'freeze'` written as code, `Object.freeze`,
//    and "ramme has no async context" (and no other "async context").
//    PROPOSAL is allowed nowhere, in any tracked file: PROPOSAL.md is deleted,
//    so every reference to it dangles. A hit judged to stay is listed in
//    `JUDGED` with the reason, and is printed as such.
// 2. Cross-references. Every `§n` or `§n.m` in a tracked document or source
//    file (PROPOSAL.md itself, this check's scripts and its test aside) names
//    a section of DESIGN.md unless a document name (DESIGN, DECISIONS,
//    PROPOSAL, README, with or without `.md`) qualifies it in the same clause,
//    or `D41` immediately precedes it (D41's record was PROPOSAL.md;
//    scripts/doc-references.mjs resolves it). It must resolve to
//    a numbered heading of that document; both ends of a range must. A
//    reference to a DESIGN.md section, on a line the change left as it was,
//    is stale when the section it named at `CHECK_DOCS_BASE` (default HEAD) now
//    has another number: a heading moved under a reference nobody renumbered.
//    Markdown links to a file of the repository must name an existing file,
//    and their `#fragment` an existing heading's GitHub anchor.
//
// Exits 1 with the list when anything fails. `--verbose` also prints every
// allowed hit.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REF, target } from './doc-references.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const verbose = process.argv.includes('--verbose');
const base = process.env.CHECK_DOCS_BASE ?? 'HEAD';

/** The documents the term rules read. */
const DOCUMENTS = ['DESIGN.md', 'DECISIONS.md', 'README.md', 'packages/eslint-plugin-ramme/README.md'];
/** Files never scanned: the proposal itself, and this check's scripts and its test (they name the terms and references). */
const SKIP = new Set([
  'PROPOSAL.md',
  'scripts/check-docs.mjs',
  'scripts/check-doc-blocks.mjs',
  'scripts/doc-references.mjs',
  'src/test/scripts.test.ts',
]);
/** The extensions of the files the cross-reference rules read. */
const SCANNED = /\.(md|ts|mts|cts|js|mjs|cjs|json)$/;

/**
 * The DECISIONS.md entries that record a retired mechanism: the superseded ones (async context, lending, freeze,
 * sticky rejection, the Effection comparison) and D41, whose rejected list names them. Matched on the entry's id.
 */
const RECORD_ENTRIES = new Set(['D9′', 'D11', 'D13', 'D13′', 'D39', 'D40', 'D41']);

/**
 * The retired terms. `kind`: 'mechanism' (allowed in DECISIONS.md only inside `RECORD_ENTRIES`), 'change' (allowed
 * anywhere in DECISIONS.md, the record, except where `status(text, index, match, inHeading)` says the hit marks an
 * entry's status), 'dangling' (allowed nowhere). `allow(text, index, match)` is an always-allowed use.
 */
const TERMS = [
  {
    term: 'freeze',
    re: /\bfreeze\b/gi,
    kind: 'mechanism',
    // The interrupt mode, written as code (`freeze`, 'freeze', "freeze"), and Object.freeze.
    allow: (text, i, m) => {
      const before = text[i - 1];
      const after = text[i + m.length];
      return (before === after && (before === '`' || before === "'" || before === '"')) || text.slice(i - 7, i) === 'Object.';
    },
  },
  { term: 'frozen', re: /\bfrozen\b/gi, kind: 'mechanism' },
  { term: 'sticky', re: /\bsticky\b/gi, kind: 'mechanism' },
  { term: 'InterruptedError', re: /\bInterruptedError\b/g, kind: 'mechanism' },
  { term: 'UnawaitedCallError', re: /\bUnawaitedCallError\b/g, kind: 'mechanism' },
  { term: 'lending', re: /\blending\b/gi, kind: 'mechanism' },
  { term: 'lent', re: /\blent\b/gi, kind: 'mechanism' },
  { term: 'managed(', re: /\bmanaged\(/g, kind: 'mechanism' },
  { term: 'AsyncLocalStorage', re: /\bAsyncLocalStorage\b/g, kind: 'mechanism' },
  { term: 'async context', re: /\basync\s+context\b/gi, kind: 'mechanism', phrase: /\bramme\s+has\s+no\s+async\s+context\b/gi },
  { term: 'async body', re: /\basync\s+bod(?:y|ies)\b/gi, kind: 'mechanism' },
  { term: 'stage', re: /\bstages?\b/gi, kind: 'change' },
  {
    term: 'provisional',
    re: /\bprovisional\b/gi,
    kind: 'change',
    // A status, which no entry of the record still has: in a heading, "(provisional)", or "Provisional:".
    status: (text, i, m, inHeading) => inHeading || (text[i - 1] === '(' && text[i + m.length] === ')') || text[i + m.length] === ':',
  },
  { term: 'transitional', re: /\btransitional\b/gi, kind: 'change' },
  { term: 'today', re: /\btoday\b/gi, kind: 'change' },
  { term: 'PR #', re: /\bPR\s?#\s?\d*|\bPR\s\d+\b/g, kind: 'change' },
  { term: 'PROPOSAL', re: /PROPOSAL/g, kind: 'dangling' },
];

/**
 * Hits judged to stay, with the reason: { file, term, line: a substring of the hit's line, why }. Empty until a hit
 * is judged; a judged entry that no longer matches anything is reported, so the list cannot rot.
 */
const JUDGED = [];

// --- files ------------------------------------------------------------------

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f !== '' && SCANNED.test(f) && !SKIP.has(f) && existsSync(join(root, f)));
const read = (file) => readFileSync(join(root, file), 'utf8');

/** Index → 1-based line, for one text. */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return {
    line(i) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= i) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
    text(n) {
      return text.slice(starts[n - 1], n < starts.length ? starts[n] - 1 : text.length);
    },
  };
}

/** The headings of a Markdown text, outside fenced code: { index, line, depth, text, number, slug }. */
function headings(text) {
  const out = [];
  const slugs = new Map();
  let fence = null;
  let index = 0;
  for (const [n, raw] of text.split('\n').entries()) {
    const f = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (f !== null && (fence === null || f[1].startsWith(fence))) fence = fence === null ? f[1] : null;
    else if (fence === null) {
      const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
      if (h !== null) {
        const title = h[2];
        const number = /^(\d+(?:\.\d+)*)\.?\s/.exec(title)?.[1] ?? null;
        let slug = githubSlug(title);
        const seen = slugs.get(slug) ?? 0;
        slugs.set(slug, seen + 1);
        if (seen > 0) slug = `${slug}-${seen}`;
        out.push({ index, line: n + 1, depth: h[1].length, text: title, number, slug });
      }
    }
    index += raw.length + 1;
  }
  return out;
}

/** GitHub's heading anchor: the rendered text, lower-cased, without punctuation and symbols, spaces as hyphens. */
function githubSlug(title) {
  const rendered = title
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*{1,3}|_{1,3})(\S(?:.*?\S)?)\1/g, '$2');
  return rendered
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

const problems = { terms: [], judged: [], allowed: [], refs: [], stale: [], links: [], unusedJudged: [] };

// --- 1. retired terms -------------------------------------------------------

/** The id (`D41`, `D9′`) of the DECISIONS.md entry, a level-3 heading, that encloses index `i`, or null. */
function enclosingEntry(hs, i) {
  for (let k = hs.length - 1; k >= 0; k--) {
    const h = hs[k];
    if (h.index > i) continue;
    if (h.depth === 3) return /^(D\d+′?)\./.exec(h.text)?.[1] ?? null;
    if (h.depth < 3) return null;
  }
  return null;
}

function termHits(file, text) {
  const lines = lineIndex(text);
  const hs = file.endsWith('.md') ? headings(text) : [];
  const isDecisions = file === 'DECISIONS.md';
  const isDocument = DOCUMENTS.includes(file);
  for (const t of TERMS) {
    if (!isDocument && t.kind !== 'dangling') continue;
    const phrases = [];
    if (t.phrase !== undefined) for (const p of text.matchAll(t.phrase)) phrases.push([p.index, p.index + p[0].length]);
    for (const m of text.matchAll(t.re)) {
      const i = m.index;
      const n = lines.line(i);
      const lineText = lines.text(n);
      const inHeading = hs.some((h) => h.line === n);
      const entry = isDecisions ? enclosingEntry(hs, i) : null;
      const hit = { file, line: n, term: t.term, text: lineText.trim() };
      let allowed = null;
      if (t.allow?.(text, i, m[0])) allowed = 'written as the interrupt mode, or Object.freeze';
      else if (phrases.some(([a, b]) => a <= i && i < b)) allowed = '"ramme has no async context"';
      else if (isDecisions && t.kind === 'change' && !t.status?.(text, i, m[0], inHeading)) allowed = 'DECISIONS.md is the record';
      else if (isDecisions && t.kind === 'mechanism' && entry !== null && RECORD_ENTRIES.has(entry))
        allowed = `${entry} records the mechanism`;
      if (allowed !== null) {
        problems.allowed.push({ ...hit, why: allowed });
        continue;
      }
      const judged = JUDGED.find((j) => j.file === file && j.term === t.term && lineText.includes(j.line));
      if (judged !== undefined) {
        judged.used = true;
        problems.judged.push({ ...hit, why: judged.why });
        continue;
      }
      problems.terms.push({ ...hit, entry, kind: t.kind });
    }
  }
}

for (const file of tracked) termHits(file, read(file));
for (const j of JUDGED) if (!j.used) problems.unusedJudged.push(j);

// --- 2. cross-references (which document a reference names: doc-references.mjs) ---

const baseText = new Map();
/** A file's text at `base`, or null where git has none. */
function readBase(path) {
  if (!baseText.has(path)) {
    try {
      baseText.set(path, execFileSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      baseText.set(path, null);
    }
  }
  return baseText.get(path);
}
const readNow = (path) => (existsSync(join(root, path)) ? read(path) : null);

const docCache = new Map();
/** A document's headings, by number and by anchor, in the tree ('now') or at `base` ('base'); null when it has none. */
function documentAt(path, when) {
  const key = `${when}:${path}`;
  if (!docCache.has(key)) {
    const text = when === 'now' ? readNow(path) : readBase(path);
    if (text === null) docCache.set(key, null);
    else {
      const hs = headings(text);
      docCache.set(key, { hs, numbers: new Map(hs.filter((h) => h.number !== null).map((h) => [h.number, h])), slugs: new Set(hs.map((h) => h.slug)) });
    }
  }
  return docCache.get(key);
}
const now = (path) => documentAt(path, 'now');
const then = (path) => documentAt(path, 'base');

/** A heading title without its number, its decision list and its markup, to recognise a section that moved. */
const sectionName = (title) =>
  title
    .replace(/^\d+(?:\.\d+)*\.?\s+/, '')
    .replace(/\s*\((?:[^()]*\bD\d+[^()]*)\)\s*$/, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function movedTo(number) {
  const was = then('DESIGN.md')?.numbers.get(number);
  if (was === undefined) return null;
  const name = sectionName(was.text);
  const design = now('DESIGN.md');
  if (design === null) return null;
  const current = design.numbers.get(number);
  if (current !== undefined && sectionName(current.text) === name) return null;
  const moved = design.hs.find((h) => h.number !== null && sectionName(h.text) === name);
  return moved === undefined ? null : { was: was.text, now: moved.number };
}

let refCount = 0;
const refsByDocument = new Map();
for (const file of tracked) {
  const text = read(file);
  const lines = lineIndex(text);
  const baseLines = readBase(file);
  const unchanged = baseLines === null ? new Set() : new Set(baseLines.split('\n'));
  for (const m of text.matchAll(REF)) {
    const doc = target(text, m.index);
    const n = lines.line(m.index);
    const lineText = lines.text(n);
    for (const number of [m[1], m[2]].filter((x) => x !== undefined)) {
      refCount++;
      refsByDocument.set(doc, (refsByDocument.get(doc) ?? 0) + 1);
      const d = now(doc);
      const ref = { file, line: n, ref: `§${number}`, doc, text: lineText.trim() };
      const moved = doc === 'DESIGN.md' ? movedTo(number) : null;
      if (d === null) problems.refs.push({ ...ref, why: `${doc} does not exist` });
      else if (!d.numbers.has(number))
        problems.refs.push({ ...ref, why: `${doc} has no section ${number}${moved === null ? '' : ` ("${moved.was}" is §${moved.now} now)`}` });
      else if (moved !== null && unchanged.has(lineText))
        problems.stale.push({ ...ref, why: `§${number} was "${moved.was}" at ${base}, which is §${moved.now} now, and this line is unchanged` });
    }
  }
  if (!file.endsWith('.md')) continue;
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g)) {
    // A link into this repository on GitHub names a path from the root; any other URL is not checked.
    const gh = /^https:\/\/github\.com\/andershessellund\/ramme\/blob\/[^/]+\/(.*)$/.exec(m[1]);
    if (gh === null && /^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;
    const [path, fragment] = (gh === null ? m[1] : gh[1]).split('#');
    const resolved = gh !== null ? normalize(decodeURIComponent(path)) : path === '' ? file : normalize(join(dirname(file), decodeURIComponent(path)));
    const n = lines.line(m.index);
    const link = { file, line: n, link: m[1], text: lines.text(n).trim() };
    if (!existsSync(join(root, resolved))) problems.links.push({ ...link, why: `${resolved} does not exist` });
    else if (fragment !== undefined && fragment !== '' && resolved.endsWith('.md') && !now(resolved).slugs.has(fragment))
      problems.links.push({ ...link, why: `${resolved} has no heading with the anchor #${fragment}` });
  }
}

// --- report -----------------------------------------------------------------

const clip = (s) => (s.length > 150 ? `${s.slice(0, 147)}…` : s);
const count = (list, key) => {
  const by = new Map();
  for (const x of list) by.set(key(x), (by.get(key(x)) ?? 0) + 1);
  return [...by].map(([k, v]) => `${k} ${v}`).join(', ');
};

if (verbose)
  for (const a of problems.allowed) console.log(`allowed  ${a.file}:${a.line}: ${a.term} (${a.why}): ${clip(a.text)}`);
for (const j of problems.judged) console.log(`judged   ${j.file}:${j.line}: ${j.term} (${j.why}): ${clip(j.text)}`);

const failures = [];
const inDocuments = problems.terms.filter((h) => DOCUMENTS.includes(h.file));
const elsewhere = problems.terms.filter((h) => !DOCUMENTS.includes(h.file));
const hitLine = (h) => `  ${h.file}:${h.line}: ${h.term}${h.entry === null ? '' : ` [${h.entry}]`}: ${clip(h.text)}`;
if (inDocuments.length > 0)
  failures.push(
    `${inDocuments.length} retired term(s) in the documents (${count(inDocuments, (h) => h.term)}; ${count(inDocuments, (h) => h.file)}):\n` +
      inDocuments.map(hitLine).join('\n'),
  );
if (elsewhere.length > 0)
  failures.push(
    `${elsewhere.length} PROPOSAL reference(s) in other files (${count(elsewhere, (h) => h.file.split('/').slice(0, h.file.startsWith('packages/') ? 2 : 1).join('/'))}):\n` +
      elsewhere.map(hitLine).join('\n'),
  );
if (problems.unusedJudged.length > 0)
  failures.push(
    `${problems.unusedJudged.length} JUDGED entr(ies) match nothing:\n` +
      problems.unusedJudged.map((j) => `  ${j.file}: ${j.term}: "${j.line}"`).join('\n'),
  );
if (problems.refs.length > 0)
  failures.push(
    `${problems.refs.length} cross-reference(s) that resolve to no heading (${count(problems.refs, (r) => `${r.doc} ${r.ref.startsWith('§4.') ? '§4.n' : 'other'}`)}):\n` +
      problems.refs.map((r) => `  ${r.file}:${r.line}: ${r.ref} → ${r.why}: ${clip(r.text)}`).join('\n'),
  );
if (problems.stale.length > 0)
  failures.push(
    `${problems.stale.length} stale cross-reference(s):\n` + problems.stale.map((r) => `  ${r.file}:${r.line}: ${r.ref} → ${r.why}: ${clip(r.text)}`).join('\n'),
  );
if (problems.links.length > 0)
  failures.push(`${problems.links.length} broken link(s):\n` + problems.links.map((l) => `  ${l.file}:${l.line}: ${l.link} → ${l.why}`).join('\n'));

const summary =
  `${tracked.length} files, ${refCount} section references (${[...refsByDocument].map(([d, c]) => `${d} ${c}`).join(', ')}), ` +
  `${problems.allowed.length} allowed and ` +
  `${problems.judged.length} judged term hits`;
if (failures.length > 0) {
  console.error(`check-docs: ${summary}; failing:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(`check-docs: ${summary}; no retired term, every reference resolves`);
