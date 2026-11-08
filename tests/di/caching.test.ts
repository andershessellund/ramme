// Tests for di / caching.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRootContext } from '../../src/create-context.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolution caching', () => {
  it('should return same value on repeated gets from same context', () => {
    class Service {}
    const root = createRootContext();
    const s1 = root.get(Service);
    const s2 = root.get(Service);
    expect(s1).toBe(s2);
  });

  it('should return same value from child after parent resolves', () => {
    class Service {}
    const root = createRootContext();
    const child = root.child();
    const fromChild = child.get(Service);
    const fromRoot = root.get(Service);
    expect(fromChild).toBe(fromRoot);
  });
});
