// ---------------------------------------------------------------------------
// Vitest setup: the unhandled-rejection guard (I10).
//
// Every unhandled rejection fails the test during which it was reported (or
// the file, when it arrives after the last test). Vitest reports unhandled
// errors for the whole run too; this hook attributes them to a test.
//
// Deliberately imports no ramme module: `storage.test.ts` must be able to
// run without a context storage adapter (D-57).
// ---------------------------------------------------------------------------

import { afterAll, afterEach } from 'vitest';
import { GUARD_KEY } from './util.js';
import type { UnhandledRejectionGuard } from './util.js';

const holder = globalThis as Record<symbol, UnhandledRejectionGuard | undefined>;
const key = Symbol.for(GUARD_KEY);

/** One listener per process, whatever the pool reuses; each file's hooks read the shared record. */
function install(): UnhandledRejectionGuard {
  const seen: unknown[] = [];
  const guard: UnhandledRejectionGuard = { seen, listener: (reason) => void seen.push(reason) };
  process.on('unhandledRejection', guard.listener);
  return guard;
}

const guard = (holder[key] ??= install());

// Captured at load, so a test that leaves fake timers installed cannot stall the check.
const realSetImmediate = globalThis.setImmediate.bind(globalThis);

/** Node reports unhandled rejections after the microtask queue drains; one macrotask is enough to hear them. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => realSetImmediate(resolve));
}

async function check(when: string): Promise<void> {
  await macrotask();
  if (guard.seen.length === 0) return;
  const reasons = guard.seen.splice(0);
  const first = reasons[0];
  const text = first instanceof Error ? `${first.name}: ${first.message}` : String(first);
  throw new Error(`${reasons.length} unhandled rejection(s) ${when}; first: ${text}`, { cause: first });
}

afterEach(() => check('during this test'));
afterAll(() => check('after the last test of this file'));
