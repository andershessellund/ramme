import { isTask } from './internal-context.js';
import type { TASK } from './internal-context.js';
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
/**
 * A `createKeyFor` token's implementation (D44, decision 6): the token's default factory, its dependencies and, unless
 * `opts.scope` registered one, its scope are `impl`'s, read at each use as `impl`'s own are (D32).
 */
const implOf = new WeakMap<object, InjectionKey<unknown>>();

// --- Key types ---

/**
 * What no task has (D44, decision 7): a `Task` declares the brand `[TASK]: true`, so a key type intersected with this
 * excludes it. A task is a function with a `name`, which a function key and a token would otherwise both accept.
 */
type NotATask = { readonly [TASK]?: never };

export type ClassInjectionKey<T> = new (...args: any[]) => T;

/** A function key: its call is its default factory. Never a task: `inject(t)` is a type error, and a `TypeError`. */
export type FunctionInjectionKey<T> = ((...args: any[]) => T) & NotATask;

export type ExplicitInjectionKey<T> = {
  __type?: T;
  name: string;
  __factory?: () => T;
} & NotATask;

export type InjectionKey<T> =
  | ClassInjectionKey<T>
  | ExplicitInjectionKey<T>
  | FunctionInjectionKey<T>;

// --- Marking (key type detection) ---

/** A class, as the markers tell one from a function: it has a prototype, and its source text starts with `class`. */
function isClass(f: object): boolean {
  return !!(f as { prototype?: unknown }).prototype && /^class[\s{]/.test(f.toString());
}

/**
 * A task is no key (D44, decision 7): a `TypeError` wherever one enters as a key, at a provider's registration (inject.ts
 * `assertProviderPlacement`), as an alias's target, in `setScope` and `setDependencies`, and at its marking, which a
 * resolution that finds no provider reaches (`inject(t)`, `lookup(t)`). With no provider or scope ever given it, a
 * task cannot be found by the walk, so every resolution of one ends in `mark`.
 */
export function refuseTask(key: unknown): void {
  if (isTask(key))
    throw new TypeError(
      `${(key as { name: string }).name}: a task is not an injection key; inject the service it belongs to, ` +
        'or call the task in a body: yield* t(…) (D44, decision 7)',
    );
}

export function mark<T>(key: InjectionKey<T>): void {
  if (markers.has(key as object)) return;
  refuseTask(key);
  if (typeof key === 'function') {
    markers.set(key, isClass(key) ? CLASS_MARKER : FUNCTION_MARKER);
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
    const impl = implOf.get(key as object);
    // A `createKeyFor` token makes its value as `impl` would, with the arguments `impl`'s dependencies resolved to.
    return impl !== undefined ? invokeDefaultFactory(impl as InjectionKey<T>, args) : (key as ExplicitInjectionKey<T>).__factory!();
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

/**
 * An explicit key for an implementation (D44, decision 6): `createKeyFor<Clock>(SystemClock)` is a token of its own,
 * typed `I`, whose default factory is `impl`'s: `new impl(…)` for a class and `impl(…)` for a function (told apart as a
 * class key and a function key are), with the arguments `setDependencies(impl, …)` declares, resolved as `impl`'s own
 * default resolves them. It is named `opts.name ?? impl.name`, and scoped `opts.scope`, else as `impl` is scoped, the
 * registered scope or the declared `static readonly scope`, read at every read of the token's scope as D32 reads
 * `impl`'s, so a `setScope(impl, …)` made after the key reaches it. The factory runs in the creation phase like any
 * factory, so `inject` inside `impl` works, and the value is placed by `impl`'s dependencies (DESIGN.md §3.3). It
 * separates an interface from its implementation: `inject(ClockKey)` is a `Clock`, never the `SystemClock` key's own
 * value, and a test binds `ClockKey` to a fake. A task is refused: a `TypeError`.
 */
export function createKeyFor<I>(impl: ((new () => I) | (() => I)) & NotATask, opts?: { name?: string; scope?: Scope }): InjectionKey<I> {
  if (isTask(impl))
    throw new TypeError(
      `createKeyFor(${(impl as { name: string }).name}): a task is not an implementation; pass a class or a function that makes the value`,
    );
  if (typeof impl !== 'function') throw new TypeError('createKeyFor(impl): impl must be a class or a function');
  const target = impl as InjectionKey<I>;
  // `invokeDefaultFactory` makes the token's value through `implOf`; the factory is what tells it has a default.
  const key = createInjectionKey<I>(opts?.name ?? impl.name, { factory: () => invokeDefaultFactory(target), scope: opts?.scope });
  implOf.set(key, target as InjectionKey<unknown>);
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
  refuseTask(key);
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
 * The key's scope: the registered one (`setScope`, `createInjectionKey`'s option), else its declaration, else, for a
 * `createKeyFor` token, its `impl`'s scope, read now, else `undefined`. Throws TypeError when nothing is registered
 * and the key's (or the `impl`'s) `scope` property is neither a declaration nor ignored (D32).
 */
export function getKeyScope<T>(key: InjectionKey<T>): Scope | undefined {
  const registered = scopeMap.get(key as object);
  if (registered !== undefined) return registered;
  const impl = implOf.get(key as object);
  return impl !== undefined ? getKeyScope(impl) : declaredScope(key as InjectionKey<unknown>);
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
  refuseTask(target);
  depsMap.set(target, keys);
}

/** The arguments a key's default factory is called with: its own, else, for a `createKeyFor` token, its `impl`'s. */
export function getDependencies(key: InjectionKey<unknown>): InjectionKey<unknown>[] | undefined {
  const own = depsMap.get(key as object);
  if (own !== undefined) return own;
  const impl = implOf.get(key as object);
  return impl === undefined ? undefined : depsMap.get(impl);
}

// --- Description ---

export function getKeyDescription<T>(key: InjectionKey<T>): string {
  return key.name || 'Anonymous';
}
