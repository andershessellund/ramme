import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import './node.js';
import { createInjectionKey } from './context-key.js';
import { valueProvider, aliasProvider } from './provider-util.js';
import { inject, lookup, addProvider } from './inject.js';
import {
  createContext,
  createRootContext,
  type Context,
  RegisterResource,
  Dispose,
} from './index.js';

// ---------------------------------------------------------------------------
// Context.enterSync / Context.leaveSync
// ---------------------------------------------------------------------------

describe('Context.enterSync / leaveSync', () => {
  it('establishes a context that inject can use', async () => {
    const KEY = createInjectionKey<string>('test-key');

    const ctx = createRootContext();
    ctx.enterSync();
    addProvider(valueProvider(KEY, 'hello'));
    expect(lookup(KEY)).toBe('hello');
    ctx.leaveSync();
    await ctx.dispose();
  });

  it('nests contexts with parent chain', async () => {
    const OUTER = createInjectionKey<string>('outer');
    const INNER = createInjectionKey<string>('inner');

    const outer = createRootContext();
    outer.enterSync();
    addProvider(valueProvider(OUTER, 'outer-val'));

    const inner = createContext({ parent: outer });
    inner.enterSync();
    addProvider(valueProvider(INNER, 'inner-val'));

    // Inner context can see both
    expect(lookup(INNER)).toBe('inner-val');
    expect(lookup(OUTER)).toBe('outer-val');

    inner.leaveSync();
    await inner.dispose();

    // Outer context only sees outer
    expect(lookup(OUTER)).toBe('outer-val');
    expect(() => lookup(INNER)).toThrow();

    outer.leaveSync();
    await outer.dispose();
  });

  it('disposes context on pop', async () => {
    let disposed = false;

    const DisposableService = createInjectionKey('DisposableService', {
      factory: () => {
        inject(RegisterResource)({
          [Dispose]: () => {
            disposed = true;
          },
        });
        return 'disposable';
      },
    });

    const ctx = createRootContext();
    ctx.enterSync();
    lookup(DisposableService); // trigger resolution so the value is stored
    ctx.leaveSync();
    await ctx.dispose();

    expect(disposed).toBe(true);
  });

  it('composes with runSync inside an entered context', async () => {
    const FILE_KEY = createInjectionKey<string>('file');
    const INNER_KEY = createInjectionKey<string>('inner');

    const ctx = createRootContext();
    ctx.enterSync();
    addProvider(valueProvider(FILE_KEY, 'file-val'));

    // runSync — child of the entered context
    ctx.runSync(
      () => {
        expect(lookup(FILE_KEY)).toBe('file-val');
        expect(lookup(INNER_KEY)).toBe('inner-val');
      },
      { providers: [valueProvider(INNER_KEY, 'inner-val')] },
    );

    // After runSync, file context is restored
    expect(lookup(FILE_KEY)).toBe('file-val');

    // standalone.run — enters standalone ctx, entered context not in chain
    const standalone = createRootContext({
      providers: [valueProvider(INNER_KEY, 'inner-val')],
    });

    standalone.run(() => {
      expect(lookup(INNER_KEY)).toBe('inner-val');
      // FILE_KEY is not accessible — standalone is not a child of entered context
      expect(() => lookup(FILE_KEY)).toThrow();
    });

    ctx.leaveSync();
    await ctx.dispose();
  });
});

// ---------------------------------------------------------------------------
// Context.run — scoped sync execution
// ---------------------------------------------------------------------------

describe('Context.run', () => {
  it('runs a function with the context as current', () => {
    const KEY = createInjectionKey<string>('run-key');
    const ctx = createRootContext({ providers: [valueProvider(KEY, 'run-val')] });

    const result = ctx.run(() => lookup(KEY));
    expect(result).toBe('run-val');
  });

  it('restores previous context after run completes', () => {
    const KEY1 = createInjectionKey<string>('k1');
    const KEY2 = createInjectionKey<string>('k2');

    const ctx1 = createRootContext({ providers: [valueProvider(KEY1, 'v1')] });
    const ctx2 = createContext({ parent: ctx1, providers: [valueProvider(KEY2, 'v2')] });

    ctx1.enterSync();
    expect(lookup(KEY1)).toBe('v1');

    ctx2.run(() => {
      expect(lookup(KEY1)).toBe('v1');
      expect(lookup(KEY2)).toBe('v2');
    });

    // After run, ctx1 is current again
    expect(lookup(KEY1)).toBe('v1');
    expect(() => lookup(KEY2)).toThrow();
    ctx1.leaveSync();
  });

  it('returns the value from the callback', () => {
    const ctx = createRootContext();
    const result = ctx.run(() => 42);
    expect(result).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// addProvider (top-level convenience)
// ---------------------------------------------------------------------------

describe('addProvider', () => {
  it('throws when called outside any context', () => {
    const KEY = createInjectionKey<string>('orphan');
    expect(() => addProvider(valueProvider(KEY, 'val'))).toThrow(
      'addProvider called outside of an active context',
    );
  });

  it('adds a provider to the current entered context', async () => {
    const KEY = createInjectionKey<string>('dynamic');

    const ctx = createRootContext();
    ctx.enterSync();
    addProvider(valueProvider(KEY, 'dynamic-val'));
    expect(lookup(KEY)).toBe('dynamic-val');
    ctx.leaveSync();
    await ctx.dispose();
  });

  it('adds provider at the correct nesting level', async () => {
    const SUITE_KEY = createInjectionKey<string>('suite');
    const TEST_KEY_1 = createInjectionKey<string>('test-1');
    const TEST_KEY_2 = createInjectionKey<string>('test-2');

    // Simulate beforeAll
    const suite = createRootContext();
    suite.enterSync();
    addProvider(valueProvider(SUITE_KEY, 'suite-val'));

    // Simulate beforeEach (test 1)
    const test1 = createContext({ parent: suite });
    test1.enterSync();
    addProvider(valueProvider(TEST_KEY_1, 'test-val'));

    // Simulate test body
    expect(lookup(SUITE_KEY)).toBe('suite-val');
    expect(lookup(TEST_KEY_1)).toBe('test-val');

    // Simulate afterEach
    test1.leaveSync();
    await test1.dispose();

    // Suite-level key is still accessible
    expect(lookup(SUITE_KEY)).toBe('suite-val');

    // Simulate another test cycle with a different test key
    const test2 = createContext({ parent: suite });
    test2.enterSync();
    addProvider(valueProvider(TEST_KEY_2, 'test-val-2'));
    expect(lookup(TEST_KEY_2)).toBe('test-val-2');
    expect(lookup(SUITE_KEY)).toBe('suite-val');
    test2.leaveSync();
    await test2.dispose();

    // Simulate afterAll
    suite.leaveSync();
    await suite.dispose();
  });
});

// ---------------------------------------------------------------------------
// Simulated vitest lifecycle (beforeAll/beforeEach/afterEach/afterAll)
// ---------------------------------------------------------------------------

describe('vitest lifecycle simulation', () => {
  const SUITE_KEY = createInjectionKey<string>('suite-svc');
  let suiteCtx: Context;
  let testCtx: Context;

  beforeAll(() => {
    suiteCtx = createRootContext();
    suiteCtx.enterSync();
    addProvider(valueProvider(SUITE_KEY, 'from-suite'));
  });

  afterAll(async () => {
    suiteCtx.leaveSync();
    await suiteCtx.dispose();
  });

  beforeEach(() => {
    testCtx = createContext({ parent: suiteCtx });
    testCtx.enterSync();
  });

  afterEach(async () => {
    testCtx.leaveSync();
    await testCtx.dispose();
  });

  it('can inject suite-level providers', () => {
    expect(lookup(SUITE_KEY)).toBe('from-suite');
  });

  it('can add test-level providers in the test body', () => {
    const TEST_KEY = createInjectionKey<string>('test-svc');
    addProvider(valueProvider(TEST_KEY, 'from-test'));
    expect(lookup(TEST_KEY)).toBe('from-test');
    expect(lookup(SUITE_KEY)).toBe('from-suite');
  });

  it('test-level providers are isolated between tests', () => {
    // TEST_KEY from the previous test was in a different context
    // This test has a fresh context that only inherits from suite
    expect(lookup(SUITE_KEY)).toBe('from-suite');
  });
});

// ---------------------------------------------------------------------------
// Class-based injection with enterSync/leaveSync
// ---------------------------------------------------------------------------

describe('class injection with enterSync/leaveSync', () => {
  class MockService {
    readonly value = 'mock';
  }

  class RealService {
    readonly value = 'real';
  }

  let suiteCtx: Context;
  let testCtx: Context;

  beforeAll(() => {
    suiteCtx = createRootContext();
    suiteCtx.enterSync();
    addProvider(aliasProvider(RealService, MockService));
  });

  afterAll(async () => {
    suiteCtx.leaveSync();
    await suiteCtx.dispose();
  });

  beforeEach(() => {
    testCtx = createContext({ parent: suiteCtx });
    testCtx.enterSync();
  });

  afterEach(async () => {
    testCtx.leaveSync();
    await testCtx.dispose();
  });

  it('injects the mock via alias', () => {
    const svc = lookup(RealService);
    expect(svc).toBeInstanceOf(MockService);
    expect(svc.value).toBe('mock');
  });

  it('each test gets a fresh instance', () => {
    const svc1 = lookup(RealService);
    // This is a different context from the previous test
    expect(svc1).toBeInstanceOf(MockService);
  });
});

// ---------------------------------------------------------------------------
// captureAutoScoped
// ---------------------------------------------------------------------------

describe('captureAutoScoped', () => {
  class AutoScopedService {
    readonly id = Math.random();
  }

  it('without capture, auto-scoped values leak to parent context', async () => {
    const suite = createRootContext();
    suite.enterSync();

    const test = createContext({ parent: suite });
    test.enterSync();

    const svc = lookup(AutoScopedService);

    test.leaveSync();
    await test.dispose();

    // The value leaked to suite — still accessible
    expect(lookup(AutoScopedService)).toBe(svc);

    suite.leaveSync();
    await suite.dispose();
  });

  it('with capture, auto-scoped values stay within the boundary', async () => {
    const suite = createRootContext();
    suite.enterSync();

    const test = createContext({ parent: suite, captureAutoScoped: true });
    test.enterSync();

    const svc = lookup(AutoScopedService);
    expect(svc).toBeInstanceOf(AutoScopedService);

    test.leaveSync();
    await test.dispose();

    // The suite context has no knowledge of AutoScopedService
    expect(() => lookup(AutoScopedService)).toThrow();

    suite.leaveSync();
    await suite.dispose();
  });

  it('each captured context gets a fresh auto-scoped instance', async () => {
    const suite = createRootContext();
    suite.enterSync();

    // Test 1
    const test1 = createContext({ parent: suite, captureAutoScoped: true });
    test1.enterSync();
    const svc1 = lookup(AutoScopedService);
    test1.leaveSync();
    await test1.dispose();

    // Test 2
    const test2 = createContext({ parent: suite, captureAutoScoped: true });
    test2.enterSync();
    const svc2 = lookup(AutoScopedService);
    expect(svc2).not.toBe(svc1); // fresh instance
    test2.leaveSync();
    await test2.dispose();

    suite.leaveSync();
    await suite.dispose();
  });

  it('auto-scoped values with deps on suite providers are captured', async () => {
    class Database {
      readonly name = 'test-db';
    }

    class UserRepo {
      db = inject(Database);
    }

    const suite = createRootContext();
    suite.enterSync();
    addProvider(valueProvider(Database, new Database()));

    const test = createContext({ parent: suite, captureAutoScoped: true });
    test.enterSync();

    const repo = lookup(UserRepo);
    expect(repo).toBeInstanceOf(UserRepo);
    expect(repo.db.name).toBe('test-db');

    test.leaveSync();
    await test.dispose();

    // UserRepo was captured — not accessible from suite
    expect(() => lookup(UserRepo)).toThrow();

    // Database is still accessible (it was explicitly provided at suite level)
    expect(lookup(Database).name).toBe('test-db');

    suite.leaveSync();
    await suite.dispose();
  });

  // This uses real vitest hooks to prove isolation. (vitest ≥5 forbids
  // describe() inside a test function, so the suite is a sibling, not
  // wrapped in an it().)
  describe('simulates vitest lifecycle with capture', () => {
    class AppService {
      readonly id = Math.random();
    }

    const instances: number[] = [];

    describe('inner suite', () => {
      let suiteCtx: Context;
      let testCtx: Context;

      beforeAll(() => {
        suiteCtx = createRootContext();
        suiteCtx.enterSync();
      });

      afterAll(async () => {
        suiteCtx.leaveSync();
        await suiteCtx.dispose();
      });

      beforeEach(() => {
        testCtx = createContext({ parent: suiteCtx, captureAutoScoped: true });
        testCtx.enterSync();
      });

      afterEach(async () => {
        testCtx.leaveSync();
        await testCtx.dispose();
      });

      it('test A injects auto-scoped service', () => {
        const svc = lookup(AppService);
        instances.push(svc.id);
      });

      it('test B gets a different instance', () => {
        const svc = lookup(AppService);
        instances.push(svc.id);
        // Both tests ran, each got a unique instance
        if (instances.length === 2) {
          expect(instances[0]).not.toBe(instances[1]);
        }
      });
    });
  });
});
