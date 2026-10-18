import { Scope } from './scope.js';

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

export function setScope<T>(key: InjectionKey<T>, scope: Scope): void {
  scopeMap.set(key as object, scope);
}

export function getKeyScope<T>(key: InjectionKey<T>): Scope | undefined {
  return scopeMap.get(key as object);
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
