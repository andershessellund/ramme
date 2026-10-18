/**
 * TC39 AsyncContext context storage registration for ramme.
 *
 * Import this module once in your bootstrap/setup code to enable
 * context tracking across async boundaries in environments that
 * support AsyncContext (including browsers with a polyfill).
 *
 * Usage:
 *   import 'ramme/async-context';     // register AsyncContext storage
 *   import { createContext, inject } from 'ramme'; // everything else
 *
 * @see https://github.com/tc39/proposal-async-context
 */
import { registerContextStorage } from './context-storage.js';
import type { ContextStorage } from './context-storage.js';
import type { ContextImpl } from './context-impl.js';

interface AsyncContextVariable<T> {
  get(): T | undefined;
  run<R>(value: T, fn: () => R): R;
}

interface AsyncContextNamespace {
  Variable: new <T>() => AsyncContextVariable<T>;
}

const AsyncContext = (globalThis as any).AsyncContext as AsyncContextNamespace | undefined;

if (!AsyncContext?.Variable) {
  throw new Error(
    'AsyncContext.Variable is not available on globalThis. ' +
      'Provide a polyfill or use ramme/node for Node.js environments.',
  );
}

const variable = new AsyncContext.Variable<ContextImpl[]>();

/**
 * Sync fallback stack — used when not inside a variable.run() scope.
 */
const syncStack: ContextImpl[] = [];

function getStack(): ContextImpl[] {
  return variable.get() ?? syncStack;
}

const asyncContextStorage: ContextStorage = {
  current() {
    const stack = getStack();
    return stack[stack.length - 1];
  },
  enterSync(ctx) {
    getStack().push(ctx);
  },
  leaveSync() {
    getStack().pop();
  },
  runAsync(ctx, fn) {
    return variable.run([ctx], fn);
  },
};

registerContextStorage(asyncContextStorage);
