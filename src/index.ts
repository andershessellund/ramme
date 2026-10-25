// The public surface (DESIGN.md §7; the exact name list is the surface check's
// list, scripts/check-surface.mjs). The types of context.ts are listed by name
// rather than re-exported with `export type *`, so the published index.d.ts
// names every public type; the list is exactly context.ts's exports.
//
// The first import defines the disposal symbols where a runtime lacks them,
// the floor's one guard (PROPOSAL.md §2.1); it exports nothing.
import './disposal-symbols.js';
export type {
  NodeState,
  InterruptMode,
  NodeOptions,
  Instruction,
  Fail,
  Operation,
  Op,
  Body,
  Release,
  Provider,
  Public,
  LookupOptions,
  Success,
  Failure,
  Result,
  Outcome,
  FailureDestination,
  TaskOptions,
  Fiber,
  Task,
  AllResult,
  SettleResult,
  PoolOptions,
  Pool,
  Context,
} from './context.js';
export { createRootContext } from './create-context.js';
export type { CreateRootContextOptions } from './create-context.js';
export { task } from './fiber.js';
export {
  current,
  signal,
  lookup,
  own,
  release,
  releaseAll,
  fork,
  call,
  attempt,
  all,
  race,
  settle,
  shield,
  unshield,
  pool,
  child,
  join,
  result,
  interrupted,
  never,
  sleep,
  wait,
  promised,
  fail,
  runSync,
} from './ambient.js';
export { inject, ContextKey } from './inject.js';
export {
  NoCurrentNodeError,
  NodeCompletedError,
  PendingNodeError,
  NotOwnedError,
  AlreadyOwnedError,
  FiberNotAwaitableError,
  FiberAbortedError,
  PoolClosedError,
  PoolFullError,
  CreationViolationError,
  FactoryReturnedUndefinedError,
  AsyncRunError,
  PlacementError,
  OwnerInterrupt,
} from './resource.js';
export { createInjectionKey, setScope, setDependencies } from './context-key.js';
export type { InjectionKey, CreateInjectionKeyOptions } from './context-key.js';
export { classProvider, factoryProvider, valueProvider, aliasProvider } from './provider-util.js';
export { createScope, SelfScope, RootScope, RequestScope } from './scope.js';
export type { Scope } from './scope.js';
export { createTopic } from './topic.js';
export type { TopicReceiver } from './topic.js';
export { NodeTopic } from './lifecycle-events.js';
export type { NodeEvent } from './lifecycle-events.js';
