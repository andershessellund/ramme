import { describe, it, expect } from 'vitest';
import { createRootContext, valueProvider, createContext } from './index.js';
import { createTopic } from './topic.js';

describe('topic', () => {
  it('receiver is called when provided and event is emitted', () => {
    const MyTopic = createTopic<{ msg: string }>('my-topic');
    const received: { msg: string }[] = [];

    const root = createRootContext({
      providers: [valueProvider(MyTopic, (e) => received.push(e))],
    });

    const receiver = root.get(MyTopic);
    receiver!({ msg: 'hello' });

    expect(received).toEqual([{ msg: 'hello' }]);
  });

  it('returns undefined when no receiver is provided', () => {
    const MyTopic = createTopic<string>('test');
    const root = createRootContext();

    const receiver = root.get(MyTopic, { optional: true });
    expect(receiver).toBeUndefined();
  });

  it('optional lookup + emit is a no-op when no receiver', () => {
    const MyTopic = createTopic<string>('test');
    const root = createRootContext();

    // This should not throw
    root.get(MyTopic, { optional: true })?.('hello');
  });

  it('multiple topics work independently', () => {
    const TopicA = createTopic<string>('alpha');
    const TopicB = createTopic<number>('beta');

    const aEvents: string[] = [];
    const bEvents: number[] = [];

    const root = createRootContext({
      providers: [
        valueProvider(TopicA, (e) => aEvents.push(e)),
        valueProvider(TopicB, (e) => bEvents.push(e)),
      ],
    });

    root.get(TopicA)!('hello');
    root.get(TopicB)!(42);

    expect(aEvents).toEqual(['hello']);
    expect(bEvents).toEqual([42]);
  });

  it('child context inherits receiver from parent', () => {
    const MyTopic = createTopic<string>('test');
    const received: string[] = [];

    const root = createRootContext({
      providers: [valueProvider(MyTopic, (e) => received.push(e))],
    });

    const child = createContext({ parent: root });
    child.get(MyTopic)!('from-child');

    expect(received).toEqual(['from-child']);
  });

  it('child can override receiver (shadows parent)', () => {
    const MyTopic = createTopic<string>('test');
    const parentEvents: string[] = [];
    const childEvents: string[] = [];

    const root = createRootContext({
      providers: [valueProvider(MyTopic, (e) => parentEvents.push(e))],
    });

    const child = createContext({
      parent: root,
      providers: [valueProvider(MyTopic, (e) => childEvents.push(e))],
    });

    child.get(MyTopic)!('hello');

    expect(childEvents).toEqual(['hello']);
    expect(parentEvents).toEqual([]);
  });

  it('child can compose with parent receiver via skipSelf', () => {
    const MyTopic = createTopic<string>('test');
    const parentEvents: string[] = [];
    const childEvents: string[] = [];

    const root = createRootContext({
      providers: [valueProvider(MyTopic, (e) => parentEvents.push(e))],
    });

    // Child's receiver delegates to parent
    const child = createContext({
      parent: root,
      providers: [
        valueProvider(MyTopic, (e) => {
          childEvents.push(e);
          // Explicitly call parent's receiver
          root.get(MyTopic)!(e);
        }),
      ],
    });

    child.get(MyTopic)!('hello');

    expect(childEvents).toEqual(['hello']);
    expect(parentEvents).toEqual(['hello']);
  });

  it('throws when required and no receiver', () => {
    const MyTopic = createTopic<string>('test');
    const root = createRootContext();

    expect(() => root.get(MyTopic)).toThrow();
  });
});
