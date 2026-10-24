// ---------------------------------------------------------------------------
// Test helpers.
//
// No adapter import: `storage.test.ts` runs without one, and these helpers
// must not register one. The ramme modules imported here register nothing.
// ---------------------------------------------------------------------------

import { expect } from 'vitest';
import type { Context, Fiber, NodeOptions } from '../context.js';
import { currentNode } from '../context-storage.js';
import { createRootContext } from '../create-context.js';
import { NodeTopic } from '../lifecycle-events.js';
import type { NodeEvent } from '../lifecycle-events.js';
import type { NodeImpl } from '../node-impl.js';
import { valueProvider } from '../provider-util.js';

// Captured at load, so `vi.useFakeTimers()` in a test does not stall `tick()`.
const realSetImmediate: (cb: () => void) => unknown =
  typeof globalThis.setImmediate === 'function'
    ? globalThis.setImmediate.bind(globalThis)
    : (cb) => globalThis.setTimeout(cb, 0);

/** Await `n` macrotasks. */
export async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => realSetImmediate(resolve));
}

/** Await one microtask. */
export function micro(): Promise<void> {
  return Promise.resolve();
}

/** `Promise.withResolvers()`. */
export function deferred<T = void>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

export type SettledState = 'pending' | 'fulfilled' | 'rejected';

/**
 * Probe: the state of `p` after one macrotask. Attaches a handler, so a
 * rejection is never unhandled; on a managed promise this counts as awaiting it.
 */
export async function settled(p: PromiseLike<unknown>): Promise<SettledState> {
  let state: SettledState = 'pending';
  p.then(
    () => {
      state = 'fulfilled';
    },
    () => {
      state = 'rejected';
    },
  );
  await tick();
  return state;
}

/** Asserts that `p` is still pending after two macrotasks. */
export async function neverSettles(p: PromiseLike<unknown>): Promise<void> {
  let state: SettledState = 'pending';
  p.then(
    () => {
      state = 'fulfilled';
    },
    () => {
      state = 'rejected';
    },
  );
  await tick(2);
  expect(state).toBe('pending');
}

/**
 * `p`'s settlement, or a rejection when `p` is still pending after `ms` real milliseconds: a deadlock fails
 * the test at once rather than at the test timeout. Never leaves a timer behind.
 */
export async function within<T>(p: PromiseLike<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Trace {
  /** The names pushed so far, in order. */
  readonly log: readonly string[];
  /** Record `name`. Bound: pass it around freely. */
  readonly push: (name: string) => void;
  /** A thunk that records `name`: `own(t.at('db'))`. */
  readonly at: (name: string) => () => void;
}

/** An ordered recorder. */
export function trace(): Trace {
  const log: string[] = [];
  const push = (name: string): void => {
    log.push(name);
  };
  return { log, push, at: (name) => () => push(name) };
}

/** The implementation behind a `Context`, for tests that read internals. */
export function impl(ctx: Context): NodeImpl {
  return ctx as unknown as NodeImpl;
}

/** A fiber node (reads `kind`; never touches the `then` trap). */
export function isFiber(x: unknown): x is Fiber<unknown> {
  return typeof x === 'object' && x !== null && (x as { readonly kind?: unknown }).kind === 'fiber';
}

/** `globalThis.gc`, present when the worker runs with `--expose-gc` (vitest.config.ts). */
export const gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc;

/** Whether GC-dependent tests can run; use with `it.skipIf(!hasGc)`. */
export const hasGc = gc !== undefined;

/**
 * Repeat a full GC plus a macrotask until `pred()` holds; throws after
 * `rounds`. Resolves at once when `gc` is absent: such tests are skipped with
 * `it.skipIf(!hasGc)`.
 *
 * Each GC runs in a fresh job: `WeakRef#deref()` (in `pred`, or wherever the
 * WeakRef was created) keeps its target alive until the current job ends.
 */
export async function gcUntil(pred: () => boolean, rounds = 50): Promise<void> {
  if (gc === undefined) return;
  for (let i = 0; i < rounds; i++) {
    await tick();
    gc();
    await tick(); // FinalizationRegistry callbacks run in a later task
    if (pred()) return;
  }
  throw new Error(`gcUntil: the predicate still fails after ${rounds} GC rounds`);
}

/** The unhandled-rejection guard `setup.ts` installs, shared per process under `Symbol.for(GUARD_KEY)`. */
export interface UnhandledRejectionGuard {
  /** Reasons heard and not yet reported; the setup hooks fail the test when it is non-empty. */
  readonly seen: unknown[];
  /** The `process.on('unhandledRejection')` listener. */
  readonly listener: (reason: unknown) => void;
}

export const GUARD_KEY = 'ramme.test.unhandledRejectionGuard';

/** The installed guard (undefined only outside the vitest setup). */
export function unhandledRejectionGuard(): UnhandledRejectionGuard | undefined {
  return (globalThis as Record<symbol, UnhandledRejectionGuard | undefined>)[Symbol.for(GUARD_KEY)];
}

/** The current node as a `NodeImpl` (a fiber, release node, `run` node or materialised value node), for tests that read internals; throws outside any node. The public form is `current()`. */
export function here(): NodeImpl {
  const n = currentNode();
  if (n === undefined) throw new Error('here(): no current node');
  return n;
}

export interface EventLog {
  /** A root whose construction-time providers include the NodeTopic receiver (DESIGN.md §5). */
  readonly root: Context;
  /** Every event the root's tree emitted, in order. */
  readonly log: NodeEvent[];
  /** The events of one type. */
  of<K extends NodeEvent['type']>(type: K): Extract<NodeEvent, { type: K }>[];
  /** `type` strings of the events emitted by node `id` (entry events are the owner's). */
  typesOf(id: number): string[];
}

/**
 * A root that records its tree's NodeEvents. A receiver must be provided at
 * the root's construction (DESIGN.md §5), so this creates the root rather
 * than taking one.
 */
export function events(opts: NodeOptions = {}): EventLog {
  const log: NodeEvent[] = [];
  const root = createRootContext({
    ...opts,
    providers: [valueProvider(NodeTopic, (e: NodeEvent) => void log.push(e)), ...(opts.providers ?? [])],
  });
  return {
    root,
    log,
    of: <K extends NodeEvent['type']>(type: K) => log.filter((e) => e.type === type) as Extract<NodeEvent, { type: K }>[],
    typesOf: (id) => log.filter((e) => e.id === id).map((e) => e.type),
  };
}

/** `createRootContext(opts)`, run `fn` inside `root.call`, then close the root (rejecting with its unconsumed failures). */
export async function withRoot<T>(opts: NodeOptions, fn: (root: Context) => T | Promise<T>): Promise<T>;
export async function withRoot<T>(fn: (root: Context) => T | Promise<T>): Promise<T>;
export async function withRoot<T>(
  a: NodeOptions | ((root: Context) => T | Promise<T>),
  b?: (root: Context) => T | Promise<T>,
): Promise<T> {
  const opts = typeof a === 'function' ? {} : a;
  const fn = typeof a === 'function' ? a : b!;
  const root = createRootContext(opts);
  let value: T;
  try {
    value = await root.call(() => fn(root));
  } catch (e) {
    await root.close().catch(() => {});
    throw e;
  }
  await root.close();
  return value;
}
