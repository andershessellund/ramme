import { isScope } from './scope.js';
import type { Scope } from './scope.js';

// --- Marker constants ---
const CLASS_MARKER = 'class' as const;
const FUNCTION_MARKER = 'function' as const;
const EXPLICIT_MARKER = 'explicit' as const;

type Marker = typeof CLASS_MARKER | typeof FUNCTION_MARKER | typeof EXPLICIT_MARKER;

// --- WeakMap-based metadata storage ---
// Using WeakMaps instead of symbol properties allows frozen objects
// (e.g. built-in classes like URL, Request) to be used as injection keys.

const markers = new WeakMap<object, Marker>();
const scopeMap = new WeakMap<object, Scope>();
const depsMap = new WeakMap<object, InjectionKey<unknown>[]>();

// --- Key types ---

export type ClassInjectionKey<T> = new (...args: any[]) => T;

export type FunctionInjectionKey<T> = (...args: any[]) => T;

export type ExplicitInjectionKey<T> = {
  __type?: T;
  name: string;
  __factory?: () => T;
};

export type InjectionKey<T> =
  | ClassInjectionKey<T>
  | ExplicitInjectionKey<T>
  | FunctionInjectionKey<T>;

// --- Marking (key type detection) ---

export function mark<T>(key: InjectionKey<T>): void {
  if (markers.has(key as object)) return;
  if (typeof key === 'function') {
    if (key.prototype && /^class[\s{]/.test(key.toString())) {
      markers.set(key, CLASS_MARKER);
    } else {
      markers.set(key, FUNCTION_MARKER);
    }
  } else {
    throw new Error('Invalid key');
  }
}

function getMarker<T>(key: InjectionKey<T>): Marker {
  const m = markers.get(key as object);
  if (m) return m;
  mark(key);
  return markers.get(key as object)!;
}

export function hasDefaultFactory<T>(key: InjectionKey<T>): boolean {
  const m = getMarker(key);
  return m !== EXPLICIT_MARKER || !!(key as ExplicitInjectionKey<T>).__factory;
}

export function invokeDefaultFactory<T>(key: InjectionKey<T>, args?: unknown[]): T {
  const m = getMarker(key);
  if (m === CLASS_MARKER) {
    return args ? new (key as any)(...args) : new (key as ClassInjectionKey<T>)();
  } else if (m === EXPLICIT_MARKER) {
    return (key as ExplicitInjectionKey<T>).__factory!();
  } else {
    return args ? (key as any)(...args) : (key as FunctionInjectionKey<T>)();
  }
}

// --- Explicit key creation ---

export interface CreateInjectionKeyOptions<T> {
  factory?: () => T;
  scope?: Scope;
}

export function createInjectionKey<T>(
  name: string,
  options?: CreateInjectionKeyOptions<T>,
): ExplicitInjectionKey<T> {
  const key: ExplicitInjectionKey<T> = {
    __type: undefined as any,
    name,
    __factory: options?.factory,
  };
  markers.set(key, EXPLICIT_MARKER);
  if (options?.scope) {
    scopeMap.set(key, options.scope);
  }
  return key;
}

// --- Scope ---
// A key's scope is registered (`setScope`, `createInjectionKey`'s option) or declared: a class or function key's
// `scope` property, read through the prototype chain like any static (D32).

/** `scope` as JavaScript reads it on a class or function key: own or inherited. `undefined` for a token. */
function scopeProperty(key: InjectionKey<unknown>): unknown {
  return typeof key === 'function' ? (key as { scope?: unknown }).scope : undefined;
}

/** For messages: a value that is not a Scope, named without calling any of its code. */
function describeValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'symbol') return v.toString();
  return typeof v === 'object' && v !== null ? 'an object' : String(v);
}

/**
 * The key's declared scope (D32): its `scope` property when that is a Scope made by `createScope`. `undefined`
 * (`static scope?: Scope` with no initializer emits one) and a function (a static method named `scope`) are not
 * declarations. Anything else is a TypeError, at every read: nothing is memoized.
 */
function declaredScope(key: InjectionKey<unknown>): Scope | undefined {
  const v = scopeProperty(key);
  if (v === undefined || typeof v === 'function') return undefined;
  if (isScope(v)) return v;
  const name = getKeyDescription(key);
  throw new TypeError(
    `${name}.scope is ${describeValue(v)}, not a Scope made by createScope(): declare a lifetime with ` +
      `\`static readonly scope = SomeScope\`; if ${name}'s scope property means something else, ` +
      `register its scope with setScope(${name}, scope) instead (D32)`,
  );
}

/**
 * Register `key`'s scope: the form for keys you do not own (a third-party class, a function), including one whose
 * unrelated static `scope` member would otherwise be refused. A registered scope wins over the key's `scope`
 * property. A key that already declares a scope (`static readonly scope = …`, own or inherited) is a TypeError:
 * two declarations (D32).
 */
export function setScope<T>(key: InjectionKey<T>, scope: Scope): void {
  const v = scopeProperty(key as InjectionKey<unknown>);
  if (isScope(v)) {
    const name = getKeyDescription(key);
    throw new TypeError(
      `setScope(${name}, '${scope.name}'): ${name} already declares its scope ('${v.name}') through its scope property; ` +
        'a key has one declaration: change that property instead (D32)',
    );
  }
  scopeMap.set(key as object, scope);
}

/**
 * The key's scope: the registered one (`setScope`, `createInjectionKey`'s option), else its declaration, else
 * `undefined`. Throws TypeError when nothing is registered and the key's `scope` property is neither a declaration
 * nor ignored (D32).
 */
export function getKeyScope<T>(key: InjectionKey<T>): Scope | undefined {
  return scopeMap.get(key as object) ?? declaredScope(key as InjectionKey<unknown>);
}

// --- Dependencies ---

type DependencyKeys<Args extends any[]> = { [K in keyof Args]: InjectionKey<Args[K]> };

export function setDependencies<T extends new (...args: any[]) => any>(
  target: T,
  ...keys: DependencyKeys<ConstructorParameters<T>>
): void;
export function setDependencies<T extends (...args: any[]) => any>(
  target: T,
  ...keys: DependencyKeys<Parameters<T>>
): void;
export function setDependencies(target: any, ...keys: InjectionKey<any>[]): void {
  depsMap.set(target, keys);
}

export function getDependencies(key: InjectionKey<unknown>): InjectionKey<unknown>[] | undefined {
  return depsMap.get(key as object);
}

// --- Description ---

export function getKeyDescription<T>(key: InjectionKey<T>): string {
  return key.name || 'Anonymous';
}
