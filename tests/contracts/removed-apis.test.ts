// Tests for contracts / removed apis.
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as ambientModule from '../../src/ambient.js';
import * as storageModule from '../../src/context-storage.js';
import * as core from '../../src/index.js';
import { attempt, createRootContext, fork, promised, shield, task, unshield } from '../../src/index.js';
import type { Context } from '../../src/index.js';
import * as resourceModule from '../../src/resource.js';
import { within } from '../support/util.js';

/** Every `console.warn` of the current test, first argument only; the spy keeps them off the console. */
const warnings: string[] = [];

/** The roots of the current test, closed after it whatever happened to it. */
const roots: Context[] = [];

beforeEach(() => {
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(String(args[0])));
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A failed test can leave its root open. Closing it must neither hang the next test nor hide the failure.
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

describe('removed APIs', () => {
  it('managed, InterruptedError and UnawaitedCallError are not exported, nor registerContextStorage; a node has no managed method', () => {
    const has = (ns: object, names: string[]): string[] => names.filter((n) => n in ns);
    const root = app();
    expect({
      index: has(core, ['managed', 'InterruptedError', 'UnawaitedCallError', 'registerContextStorage']),
      ambient: has(ambientModule, ['managed']),
      resource: has(resourceModule, ['InterruptedError', 'UnawaitedCallError']),
      contextStorage: has(storageModule, ['registerContextStorage', 'NO_STORAGE_MESSAGE']),
      node: has(root, ['managed']),
    }).toEqual({ index: [], ambient: [], resource: [], contextStorage: [], node: [] });
  });

  it('types: the removed names do not compile; an async function is no body; a work op is a PromiseLike, not a Promise', () => {
    // Never called: `pnpm typecheck` checks it. While a name or an arm below still exists, its directive is unused (TS2578).
    const typeOnly = (): void => {
      // @ts-expect-error -- managed() is gone: wait(p, { abandon: true }) is the same wait (decision 10)
      type _Managed = typeof core.managed;
      // @ts-expect-error -- InterruptedError is gone: a halt is return(), never a rejection (decision 16)
      type _Interrupted = typeof core.InterruptedError;
      // @ts-expect-error -- UnawaitedCallError is gone with lending: an unconsumed work op runs nothing (decision 2)
      type _Unawaited = typeof core.UnawaitedCallError;
      // @ts-expect-error -- registerContextStorage is gone: there is no async context (decision 18)
      type _Register = typeof core.registerContextStorage;
      // @ts-expect-error -- ctx.managed is gone (decision 10)
      type _CtxManaged = Context['managed'];
      const root = createRootContext();
      // @ts-expect-error -- an async function is no body (D41, decision 5)
      task(async () => 1);
      // @ts-expect-error -- an async function is no body
      fork(async () => 1);
      // @ts-expect-error -- an async function is no body
      task(async () => 1)();
      // @ts-expect-error -- an async function is no body
      attempt(async () => 1);
      // @ts-expect-error -- an async function is no body
      shield(async () => 1);
      // @ts-expect-error -- an async function is no body
      unshield(async () => 1);
      // @ts-expect-error -- an async function is no body
      promised(async () => 1);
      // @ts-expect-error -- an async function is no body
      root.call(async () => 1);
      const op = root.call(function* () {
        return 1;
      });
      const _thenable: PromiseLike<number> = op;
      expectTypeOf<Awaited<typeof op>>().toEqualTypeOf<number>();
      // @ts-expect-error -- a work op is a plain thenable: no catch (decision 4)
      const _catch = op.catch;
      // @ts-expect-error -- a work op is a plain thenable: no finally (decision 4)
      const _finally = op.finally;
      // @ts-expect-error -- a work op is no Promise (decision 4)
      const _promise: Promise<number> = op;
    };
    expect(typeof typeOnly).toBe('function');
  });
});
