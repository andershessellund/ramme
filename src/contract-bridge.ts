// ---------------------------------------------------------------------------
// The lookup-api bridge — ramme serves ambient contracts
//
// Libraries written against lookup-api define contracts and call lookup();
// this module is what makes a ramme context answer those calls. It installs
// one conditional resolver at lookup-api's durable root:
//
//   - answers only when a ramme creation or execution context is ambient
//     (attribution), and delegates everything else to the previous root
//   - maps each Contract to a per-process InjectionKey, memoized by contract
//     identity, so contracts are provided like any other key
//
// createRootContext() installs the resolver idempotently, so an application
// that uses ramme gets the bridge without import-order ceremony.
// ---------------------------------------------------------------------------

import { installLookup, type Contract, type LookupFn } from 'lookup-api';
import { createInjectionKey } from './context-key.js';
import type { InjectionKey } from './context-key.js';
import type { Provider } from './context.js';
import { valueProvider } from './provider-util.js';
import { _ambientLookup } from './inject.js';

const contractKeys = new WeakMap<Contract<any>, InjectionKey<unknown>>();

/**
 * The injection key a contract resolves through under ramme. Memoized per
 * contract object, created on first use.
 *
 * Provide it like any key — or use {@link contractProvider} for the common
 * value case.
 */
export function contractKey<T>(contract: Contract<T>): InjectionKey<T> {
  let key = contractKeys.get(contract);
  if (!key) {
    key = createInjectionKey<unknown>(`contract:${contract.name}`);
    contractKeys.set(contract, key);
  }
  return key as InjectionKey<T>;
}

/**
 * Provide `value` for `contract` on a context, so ambient `lookup(contract)`
 * calls made under that context resolve to it.
 *
 * ```ts
 * createRootContext({
 *   providers: [contractProvider(OwnerContract, appOwner)],
 * });
 * ```
 */
export function contractProvider<T>(contract: Contract<T>, value: T): Provider<T> {
  return valueProvider(contractKey(contract), value);
}

let installed = false;

/**
 * Install ramme's conditional resolver at lookup-api's durable root.
 * Idempotent; called automatically by `createRootContext()`.
 *
 * The resolver answers only when a ramme creation or execution context is
 * ambient and the contract's key resolves there; every other call falls
 * through to the previously installed root, so independently installed
 * resolvers keep working.
 */
export function installContractResolver(): void {
  if (installed) return;
  installed = true;
  const previous = installLookup(resolveViaRamme);
  chainedPrevious = previous;
}

let chainedPrevious: LookupFn | undefined;

const resolveViaRamme: LookupFn = <T>(
  contract: Contract<T>,
  next: <U>(c: Contract<U>) => U | undefined,
): T | undefined => {
  const value = _ambientLookup(contractKey(contract));
  if (value !== undefined) return value;
  return chainedPrevious ? chainedPrevious(contract, next) : next(contract);
};

/** @internal — test hook: forget that the resolver was installed. */
export function _resetContractResolver(): void {
  installed = false;
  chainedPrevious = undefined;
}
