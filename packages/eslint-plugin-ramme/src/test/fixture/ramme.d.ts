// The fixture program's `ramme`: the declarations the type-aware rules read, in the shapes ramme's own have
// (src/context.ts): an `Op` is an `Operation` and a plain thenable; a `Task` is callable, its call an op, with `with`
// and a brand declared under a unique symbol. Only what the typed rule tests use is declared.
declare module 'ramme' {
  const TASK: unique symbol;
  export interface Instruction {
    readonly instruction: true;
  }
  export interface Operation<T, E = never> {
    [Symbol.iterator](): Iterator<Instruction | E, T, unknown>;
  }
  export interface Op<T, E = never> extends Operation<T, E>, PromiseLike<T> {}
  export interface TaskOptions {
    name?: string;
  }
  export interface Task<A extends unknown[], T, E = never> {
    (...args: A): Op<T, E>;
    readonly name: string;
    with(opts: TaskOptions): Task<A, T, E>;
    readonly [TASK]: true;
  }
  export function task<S, A extends unknown[], T>(
    self: S,
    body: (this: S, ...args: A) => Generator<Instruction, T, unknown>,
    opts?: TaskOptions,
  ): Task<A, T>;
  export function task<A extends unknown[], T>(body: (this: void, ...args: A) => Generator<Instruction, T, unknown>, opts?: TaskOptions): Task<A, T>;
  export function fork<T>(op: Op<T>): object;
  export function sleep(ms: number): Op<void>;
  export function release(value: object): Op<void> & Promise<void>;
}
