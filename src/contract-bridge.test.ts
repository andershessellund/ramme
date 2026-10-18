import { describe, it, expect, afterEach } from 'vitest';
import './node.js';
import {
  createContract,
  lookup,
  installLookup,
  _resetLookupState,
  type Contract,
  type LookupFn,
} from 'lookup-api';
import { createRootContext, createContext } from './create-context.js';
import { contractProvider } from './contract-bridge.js';
import { _resetContractResolver } from './contract-bridge.js';
import { factoryProvider, valueProvider } from './provider-util.js';
import { createInjectionKey } from './context-key.js';
import type { Context } from './context.js';

afterEach(() => {
  _resetLookupState();
  _resetContractResolver();
});

function bind<T>(contract: Contract<T>, value: T): LookupFn {
  return (c, next) => (c === (contract as Contract<unknown>) ? (value as never) : next(c));
}

describe('the lookup-api bridge', () => {
  it('lookup falls back with no ramme context ambient', () => {
    const Greeting = createContract('greeting', () => 'default');
    createRootContext();
    expect(lookup(Greeting)).toBe('default');
  });

  it('a contract provided on a context answers ambient lookups under it', () => {
    const Greeting = createContract('greeting', () => 'default');
    const root = createRootContext({
      providers: [contractProvider(Greeting, 'from-ramme')],
    });
    expect(root.run(() => lookup(Greeting))).toBe('from-ramme');
    expect(lookup(Greeting)).toBe('default');
  });

  it('child contexts override parent contract bindings', () => {
    const Greeting = createContract('greeting', () => 'default');
    const root = createRootContext({
      providers: [contractProvider(Greeting, 'root-value')],
    });
    const child = root.run(() =>
      createContext({ providers: [contractProvider(Greeting, 'child-value')] }),
    );
    expect(root.run(() => lookup(Greeting))).toBe('root-value');
    expect(child.run(() => lookup(Greeting))).toBe('child-value');
  });

  it('contracts resolve during value creation, through the creation context', () => {
    const Greeting = createContract('greeting', () => 'default');
    const Service = createInjectionKey<{ greeting: string }>('Service');
    const root = createRootContext({
      providers: [
        contractProvider(Greeting, 'creation-scoped'),
        factoryProvider(Service, () => ({ greeting: lookup(Greeting) })),
      ],
    });
    expect(root.run(() => root.get(Service).greeting)).toBe('creation-scoped');
  });

  it('delegates to a previously installed root for contracts ramme does not hold', () => {
    const Mine = createContract('mine', () => 'mine-default');
    const Theirs = createContract('theirs', () => 'theirs-default');
    installLookup(bind(Theirs, 'other-framework'));
    const root = createRootContext({ providers: [contractProvider(Mine, 'ramme')] });
    const seen = root.run(() => [lookup(Mine), lookup(Theirs)]);
    expect(seen).toEqual(['ramme', 'other-framework']);
    expect(lookup(Theirs)).toBe('other-framework');
  });

  it('the resolver survives multiple root contexts (idempotent install)', () => {
    const Greeting = createContract('greeting', () => 'default');
    const a: Context = createRootContext({
      providers: [contractProvider(Greeting, 'a')],
    });
    const b: Context = createRootContext({
      providers: [contractProvider(Greeting, 'b')],
    });
    expect(a.run(() => lookup(Greeting))).toBe('a');
    expect(b.run(() => lookup(Greeting))).toBe('b');
  });

  it('contract values flow across await under the ALS storage', async () => {
    const Greeting = createContract('greeting', () => 'default');
    const root = createRootContext({
      providers: [contractProvider(Greeting, 'async-visible')],
    });
    const { Fiber } = await import('./fiber.js');
    const result = await Fiber.call(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return lookup(Greeting);
      },
      { context: root },
    );
    expect(result).toBe('async-visible');
  });

  it('an ordinary injection key and a contract key do not collide', () => {
    const Greeting = createContract('greeting', () => 'default');
    const GreetingKey = createInjectionKey<string>('greeting');
    const root = createRootContext({
      providers: [
        contractProvider(Greeting, 'via-contract'),
        valueProvider(GreetingKey, 'via-key'),
      ],
    });
    expect(root.run(() => [lookup(Greeting), root.get(GreetingKey)])).toEqual([
      'via-contract',
      'via-key',
    ]);
  });
});
