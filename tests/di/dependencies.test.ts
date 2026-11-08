// Tests for di / dependencies.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInjectionKey, setDependencies } from '../../src/context-key.js';
import { createRootContext } from '../../src/create-context.js';
import { inject } from '../../src/inject.js';
import { classProvider } from '../../src/provider-util.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dependencies (constructor injection)', () => {
    it('should inject class constructor dependencies via setDependencies', () => {
      class Logger {
        log(msg: string) {
          return msg;
        }
      }

      class Service {
        constructor(public logger: Logger) {}
      }
      setDependencies(Service, Logger);

      const ctx = createRootContext();
      const service = ctx.get(Service);
      expect(service).toBeInstanceOf(Service);
      expect(service.logger).toBeInstanceOf(Logger);
    });

    it('should inject multiple constructor dependencies', () => {
      const DB_URL = createInjectionKey<string>('DB_URL', {
        factory: () => 'postgres://localhost',
      });

      class Logger {
        log(msg: string) {
          return msg;
        }
      }

      class Database {
        constructor(
          public url: string,
          public logger: Logger,
        ) {}
      }
      setDependencies(Database, DB_URL, Logger);

      const ctx = createRootContext();
      const db = ctx.get(Database);
      expect(db.url).toBe('postgres://localhost');
      expect(db.logger).toBeInstanceOf(Logger);
    });

    it('should inject function key dependencies via setDependencies', () => {
      class Logger {
        log(msg: string) {
          return msg;
        }
      }

      function createGreeter(logger: Logger) {
        return { greet: (name: string) => logger.log(`Hello, ${name}!`) };
      }
      setDependencies(createGreeter, Logger);

      const ctx = createRootContext();
      const greeter = ctx.get(createGreeter);
      expect(greeter.greet('World')).toBe('Hello, World!');
    });

    it('should support setDependencies on a class', () => {
      class Dep {
        value = 42;
      }

      class Consumer {
        constructor(public dep: Dep) {}
      }
      setDependencies(Consumer, Dep);

      const ctx = createRootContext();
      expect(ctx.get(Consumer).dep.value).toBe(42);
    });

    it('should work with 3rd party classes via setDependencies', () => {
      class ThirdPartyClient {
        constructor(public baseUrl: string) {}
        fetch() {
          return this.baseUrl;
        }
      }

      const BASE_URL = createInjectionKey<string>('BASE_URL', {
        factory: () => 'https://api.example.com',
      });
      setDependencies(ThirdPartyClient, BASE_URL);

      const ctx = createRootContext();
      const client = ctx.get(ThirdPartyClient);
      expect(client.fetch()).toBe('https://api.example.com');
    });

    it('should auto-scope class with dependencies to correct depth', () => {
      class Logger {
        name = 'logger';
      }

      class Service {
        constructor(public logger: Logger) {}
      }
      setDependencies(Service, Logger);

      const root = createRootContext();
      const child = root.child();

      const service = child.get(Service);
      expect(service.logger).toBeInstanceOf(Logger);

      // Same instance from root (auto-scoped)
      expect(root.get(Service)).toBe(service);
      expect(root.get(Logger)).toBe(service.logger);
    });

    it('should allow mixing constructor deps and field-initializer inject()', () => {
      const CONFIG = createInjectionKey<string>('CONFIG', { factory: () => 'config-value' });

      class Logger {
        name = 'logger';
      }

      class Service {
        config = inject(CONFIG);
        constructor(public logger: Logger) {}
      }
      setDependencies(Service, Logger);

      const ctx = createRootContext();
      const service = ctx.get(Service);
      expect(service.logger).toBeInstanceOf(Logger);
      expect(service.config).toBe('config-value');
    });

    it('should work with explicit providers that override default factory', () => {
      class Logger {
        name = 'default';
      }
      class CustomLogger extends Logger {
        override name = 'custom';
      }

      class Service {
        constructor(public logger: Logger) {}
      }
      setDependencies(Service, Logger);

      const ctx = createRootContext({
        providers: [classProvider(Logger, CustomLogger)],
      });
      const service = ctx.get(Service);
      expect(service.logger.name).toBe('custom');
    });

    it('should detect circular dependencies through constructor injection', () => {
      class A {
        constructor(public b: any) {}
      }
      class B {
        constructor(public a: any) {}
      }
      setDependencies(A, B as any);
      setDependencies(B, A as any);

      const ctx = createRootContext();
      expect(() => ctx.get(A)).toThrow('Circular dependency detected: A → B → A');
    });
  });
