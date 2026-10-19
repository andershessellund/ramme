// topic.test.ts — IMPLEMENTATION.md §6.1: topics are DI keys (PROPOSAL.md §8,
// §16). Ported from the previous suite: `createContext({ parent })` →
// `root.child()`.
import { describe, expect, it } from 'vitest';
import './node.js';
import { createRootContext, valueProvider } from './index.js';
import { createTopic } from './topic.js';

describe('topic', () => {
  it('receiver is called when provided and event is emitted', async () => {
    const MyTopic = createTopic<{ msg: string }>('my-topic');
    const received: { msg: string }[] = [];

    const root = createRootContext({
      providers: [valueProvider(MyTopic, (e) => void received.push(e))],
    });

    const receiver = root.get(MyTopic);
    receiver({ msg: 'hello' });

    expect(received).toEqual([{ msg: 'hello' }]);
    await root.close();
  });

  it('returns undefined when no receiver is provided', async () => {
    const MyTopic = createTopic<string>('test');
    const root = createRootContext();

    const receiver = root.get(MyTopic, { optional: true });
    expect(receiver).toBeUndefined();
    await root.close();
  });

  it('optional lookup + emit is a no-op when no receiver', async () => {
    const MyTopic = createTopic<string>('test');
    const root = createRootContext();

    expect(() => root.get(MyTopic, { optional: true })?.('hello')).not.toThrow();
    await root.close();
  });

  it('multiple topics work independently', async () => {
    const TopicA = createTopic<string>('alpha');
    const TopicB = createTopic<number>('beta');

    const aEvents: string[] = [];
    const bEvents: number[] = [];

    const root = createRootContext({
      providers: [valueProvider(TopicA, (e) => void aEvents.push(e)), valueProvider(TopicB, (e) => void bEvents.push(e))],
    });

    root.get(TopicA)('hello');
    root.get(TopicB)(42);

    expect(aEvents).toEqual(['hello']);
    expect(bEvents).toEqual([42]);
    await root.close();
  });

  it('child context inherits receiver from parent', async () => {
    const MyTopic = createTopic<string>('test');
    const received: string[] = [];

    const root = createRootContext({
      providers: [valueProvider(MyTopic, (e) => void received.push(e))],
    });

    const child = root.child();
    child.get(MyTopic)('from-child');

    expect(received).toEqual(['from-child']);
    await root.close();
  });

  it('child can override receiver (shadows parent)', async () => {
    const MyTopic = createTopic<string>('test');
    const parentEvents: string[] = [];
    const childEvents: string[] = [];

    const root = createRootContext({
      providers: [valueProvider(MyTopic, (e) => void parentEvents.push(e))],
    });

    const child = root.child({
      providers: [valueProvider(MyTopic, (e) => void childEvents.push(e))],
    });

    child.get(MyTopic)('hello');

    expect(childEvents).toEqual(['hello']);
    expect(parentEvents).toEqual([]);
    await root.close();
  });

  it('child can compose with parent receiver via skipSelf', async () => {
    const MyTopic = createTopic<string>('test');
    const parentEvents: string[] = [];
    const childEvents: string[] = [];

    const root = createRootContext({
      providers: [valueProvider(MyTopic, (e) => void parentEvents.push(e))],
    });

    // The child's receiver delegates to the parent's.
    const child = root.child({
      providers: [
        valueProvider(MyTopic, (e) => {
          childEvents.push(e);
          child.get(MyTopic, { skipSelf: true })(e);
        }),
      ],
    });

    child.get(MyTopic)('hello');

    expect(childEvents).toEqual(['hello']);
    expect(parentEvents).toEqual(['hello']);
    await root.close();
  });

  it('throws when required and no receiver', async () => {
    const MyTopic = createTopic<string>('test');
    const root = createRootContext();

    expect(() => root.get(MyTopic)).toThrow(/No provider found/);
    await root.close();
  });
});
