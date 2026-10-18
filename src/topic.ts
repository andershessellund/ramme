// ---------------------------------------------------------------------------
// Topic — a typed identifier for an event channel, resolved via DI
//
// A topic is just an InjectionKey<(event: T) => void> with no default factory.
// Emitters lookup the key with { optional: true } and call the receiver if
// present. When nobody provides a receiver, the lookup returns undefined
// and the optional-chain short-circuits — zero overhead.
//
// Listening is done by providing a receiver via valueProvider / factoryProvider
// on the context where you want to observe events.
// ---------------------------------------------------------------------------

import { createInjectionKey } from './context-key.js';
import type { InjectionKey } from './context-key.js';

// ---------------------------------------------------------------------------
// TopicReceiver<T> — the callback type that receives events
// ---------------------------------------------------------------------------

/**
 * A callback that receives events for a topic.
 *
 * This is the value type of a topic's injection key. Provide it via
 * `valueProvider(MyTopic, fn)` or `factoryProvider(MyTopic, () => fn)`
 * to start receiving events.
 */
export type TopicReceiver<T> = (event: T) => void;

// ---------------------------------------------------------------------------
// createTopic — define a typed event topic
// ---------------------------------------------------------------------------

/**
 * Create a typed event topic. Returns an `InjectionKey<TopicReceiver<T>>`
 * that can be provided and looked up via standard DI.
 *
 * Topics have no default factory — if nobody provides a receiver,
 * `lookup(topic, { optional: true })` returns `undefined`.
 *
 * @example
 * ```ts
 * // Define
 * const UserTopic = createTopic<UserEvent>('user');
 *
 * // Listen (provide a receiver)
 * createRootContext({
 *   providers: [valueProvider(UserTopic, (event) => console.log(event))],
 * });
 *
 * // Emit (at runtime)
 * lookup(UserTopic, { optional: true })?.({ type: 'created', userId: '123' });
 * ```
 */
export function createTopic<T>(name: string): InjectionKey<TopicReceiver<T>> {
  return createInjectionKey<TopicReceiver<T>>(name);
}
