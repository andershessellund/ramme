// Tests for di / parent resolution.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey } from '../../src/context-key.js';
import { createRootContext } from '../../src/create-context.js';
import { inject } from '../../src/inject.js';
import { factoryProvider, valueProvider } from '../../src/provider-util.js';
import { lookup } from '../../src/ambient.js';
import { here } from '../support/util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('skipSelf', () => {
    it('context.get with skipSelf resolves from parent', () => {
      const KEY = createInjectionKey<string>('Val');
      const root = createRootContext({
        providers: [valueProvider(KEY, 'root')],
      });
      const child = root.child({
        providers: [valueProvider(KEY, 'child')],
      });

      expect(child.get(KEY)).toBe('child');
      expect(child.get(KEY, { skipSelf: true })).toBe('root');
    });

    it('context.get with skipSelf + optional returns undefined when no parent', () => {
      const KEY = createInjectionKey<string>('Val');
      const root = createRootContext({
        providers: [valueProvider(KEY, 'root')],
      });

      expect(root.get(KEY, { skipSelf: true, optional: true })).toBeUndefined();
    });

    it('context.get with skipSelf throws when no parent and not optional', () => {
      const KEY = createInjectionKey<string>('Val');
      const root = createRootContext({
        providers: [valueProvider(KEY, 'root')],
      });

      expect(() => root.get(KEY, { skipSelf: true })).toThrow(/no parent context/i);
    });

    it('inject with skipSelf during creation resolves from parent provider', () => {
      const HttpClient = createInjectionKey<{ name: string }>('HttpClient');

      const root = createRootContext({
        providers: [factoryProvider(HttpClient, () => ({ name: 'base' }))],
      });

      const child = root.child({
        providers: [
          factoryProvider(HttpClient, () => {
            const parent = inject(HttpClient, { skipSelf: true });
            return { name: `logging(${parent.name})` };
          }),
        ],
      });

      expect(child.get(HttpClient)).toEqual({ name: 'logging(base)' });
      expect(root.get(HttpClient)).toEqual({ name: 'base' });
    });

    it('inject with skipSelf during creation returns undefined when optional and no parent value', () => {
      const KEY = createInjectionKey<string>('Optional');

      const root = createRootContext({
        providers: [
          factoryProvider(KEY, () => {
            const parent = inject(KEY, { skipSelf: true, optional: true });
            return parent ? `wrapped(${parent})` : 'root-default';
          }),
        ],
      });

      expect(root.get(KEY)).toBe('root-default');
    });

    it('lookup with skipSelf in a runSync skips the current node', () => {
      const KEY = createInjectionKey<string>('Val');
      const root = createRootContext({
        providers: [valueProvider(KEY, 'root')],
      });
      const child = root.child({
        providers: [valueProvider(KEY, 'child')],
      });

      // runSync's node is a child of `child`: skipping it resolves from `child`, past the node's own provider.
      const result = child.runSync(() => {
        here().addProvider(valueProvider(KEY, 'self'));
        return { self: lookup(KEY), skipped: lookup(KEY, { skipSelf: true }) };
      });

      expect(result).toEqual({ self: 'self', skipped: 'child' });
    });

    it('decorator pattern: multiple levels of wrapping', () => {
      const Service = createInjectionKey<{ trace(): string }>('Service');

      const root = createRootContext({
        providers: [factoryProvider(Service, () => ({ trace: () => 'base' }))],
      });

      const mid = root.child({
        providers: [
          factoryProvider(Service, () => {
            const parent = inject(Service, { skipSelf: true });
            return { trace: () => `mid(${parent.trace()})` };
          }),
        ],
      });

      const leaf = mid.child({
        providers: [
          factoryProvider(Service, () => {
            const parent = inject(Service, { skipSelf: true });
            return { trace: () => `leaf(${parent.trace()})` };
          }),
        ],
      });

      expect(leaf.get(Service).trace()).toBe('leaf(mid(base))');
      expect(mid.get(Service).trace()).toBe('mid(base)');
      expect(root.get(Service).trace()).toBe('base');
    });
  });
