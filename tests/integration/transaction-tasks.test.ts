// Tests for integration / transaction tasks.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attempt, current, fork, lookup, never, own, result, sleep } from '../../src/ambient.js';
import type { Context } from '../../src/context.js';
import { createRootContext } from '../../src/create-context.js';
import { task } from '../../src/fiber.js';
import { RequestScope } from '../../src/scope.js';
import { impl, within } from '../support/util.js';

const roots: Context[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const r of roots.splice(0)) await within(r.close(), 1000).catch(() => {});
});

function app(): Context {
  const root = createRootContext();
  roots.push(root);
  return root;
}

describe('README’s UnitOfWork: a release that returns a bound task’s call runs it as release work (DESIGN.md §2.6, §4.5)', () => {
  it('the commit, or the rollback for a failed or an interrupted request, runs in its own node under the release fiber, with the unit as this, to its end before the lease is returned', async () => {
    const log: string[] = [];
    class Lease implements Disposable {
      open = true;
      [Symbol.dispose](): void {
        this.open = false;
        log.push('lease returned');
      }
    }
    class UnitOfWork {
      static readonly scope = RequestScope;
      readonly #node = current();
      readonly #lease = own(new Lease()); // owned by this value's node, below the entry that commits (LIFO)
      constructor() {
        own(this, () => {
          const o = this.#node.parent!.outcome; // the request's outcome
          if (o === undefined) return this.#node.signal.aborted ? this.rollback() : this.commit();
          return o.status === 'success' ? this.commit() : this.rollback();
        });
      }
      readonly commit = task(this, function* commit() {
        yield* sleep(1);
        log.push(`commit ${this.#where()}`);
      });
      readonly rollback = task(this, function* rollback() {
        yield* sleep(1);
        log.push(`rollback ${this.#where()}`);
      });
      #where(): string {
        const n = current();
        return `in ${impl(n).kind} ${n.name} under ${n.parent!.name}, this ${this instanceof UnitOfWork}, lease open ${this.#lease.open}`;
      }
    }
    const ok = task(function* ok() {
      lookup(UnitOfWork);
      yield* sleep(1);
    }, { scopes: [RequestScope] });
    const boom = task(function* boom() {
      lookup(UnitOfWork);
      yield* sleep(1);
      throw new Error('boom');
    }, { scopes: [RequestScope] });
    const hung = task(function* hung() {
      lookup(UnitOfWork);
      yield* never();
    }, { scopes: [RequestScope] });
    const seen = await within(
      app().call(function* () {
        yield* ok();
        log.push('--');
        const failed = yield* attempt(boom());
        log.push('--');
        const h = fork(hung());
        yield* sleep(1);
        h.abort('hung up');
        return { failed: failed.status, hung: (yield* result(h)).status };
      }),
      2000,
    );
    const where = 'in fiber %s under release:UnitOfWork, this true, lease open true';
    expect({ seen, log }).toEqual({
      seen: { failed: 'defect', hung: 'aborted' },
      log: [
        `commit ${where.replace('%s', 'commit')}`,
        'lease returned',
        '--',
        `rollback ${where.replace('%s', 'rollback')}`,
        'lease returned',
        '--',
        `rollback ${where.replace('%s', 'rollback')}`,
        'lease returned',
      ],
    });
  });
});
