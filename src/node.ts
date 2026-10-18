/**
 * Node.js context storage registration for ramme.
 *
 * Import this module once in your bootstrap/setup code to enable
 * context tracking across async boundaries via AsyncLocalStorage.
 *
 * Usage:
 *   import 'ramme/node';             // register ALS storage
 *   import { createContext, inject } from 'ramme'; // everything else
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerContextStorage } from './context-storage.js';
import type { ContextStorage } from './context-storage.js';
import type { ContextImpl } from './context-impl.js';

const als = new AsyncLocalStorage<ContextImpl[]>();

/**
 * Sync fallback stack — used when not inside an ALS.run() scope.
 * This covers the initial setup phase before any fiber starts, and
 * contexts pushed via enterSync at the top level.
 */
const syncStack: ContextImpl[] = [];

function getStack(): ContextImpl[] {
  return als.getStore() ?? syncStack;
}

const nodeStorage: ContextStorage = {
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
    return als.run([ctx], fn);
  },
};

registerContextStorage(nodeStorage);
