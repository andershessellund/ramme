export * from './context.js';
export { inject, lookup, create, RegisterResource, ContextRefKey, registerResource } from './inject.js';
export type { ContextRef } from './inject.js';
export { registerContextStorage } from './context-storage.js';
export type { ContextStorage } from './context-storage.js';
export { createContext, createRootContext } from './create-context.js';
export type { CreateContextOptions, CreateRootContextOptions } from './create-context.js';
export { runSync } from './run-sync.js';
export { createInjectionKey, setScope } from './context-key.js';
export type { InjectionKey, CreateInjectionKeyOptions } from './context-key.js';
export {
  classProvider,
  factoryProvider,
  valueProvider,
  aliasProvider,
  resourceProvider,
} from './provider-util.js';
export type { ProviderOptions } from './provider-util.js';
export type { ManagedResource, ResourceHandle, RegisterResourceFunction } from './resource.js';
export { Drain, Flush, Dispose, Abort } from './resource.js';
export { createScope, SelfScope, RootScope, RequestScope } from './scope.js';
export type { Scope } from './scope.js';

export { addProvider } from './inject.js';
export { createRefCountedKey, refCountedProvider } from './ref-count.js';
export type { RefCountedKeyOptions } from './ref-count.js';
export { createTopic } from './topic.js';
export type { TopicReceiver } from './topic.js';
export { ContextTopic, FiberTopic } from './lifecycle-events.js';
export type { ContextEvent, FiberEvent } from './lifecycle-events.js';
export { Fiber, withAbortSignal, linkAbortSignal } from './fiber.js';
export type { Fiber as FiberType, FiberOptions, ForkOptions, FiberResult } from './fiber.js';
export { createFiberSet } from './fiber-set.js';
export type { FiberSet, FiberSetOptions, FiberSetSpawnOptions } from './fiber-set.js';

// --- The lookup-api bridge ---
// Ambient contracts (lookup-api) resolve through ramme contexts once a root
// context exists; these are the wiring points.
export { contractKey, contractProvider, installContractResolver } from './contract-bridge.js';
