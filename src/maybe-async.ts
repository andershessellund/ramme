// ---------------------------------------------------------------------------
// maybe-async — run sequences of sync-or-async functions with error aggregation
//
// These runners preserve sync returns when all functions are sync, and
// transparently promote to async when any function returns a promise.
// This avoids unnecessary microtask ticks for the common all-sync path.
// ---------------------------------------------------------------------------

type MaybePromise<T> = T | Promise<T>;

function isPromise(v: unknown): v is Promise<void> {
  return v != null && typeof (v as any).then === 'function';
}

function throwAggregated(errors: unknown[], label: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `Multiple errors during ${label}`);
}

/**
 * Run all fns in parallel. Stays sync if every fn is sync.
 * Errors are collected and thrown as an AggregateError at the end.
 */
export function runParallel(
  fns: Iterable<() => MaybePromise<void>>,
  label: string,
): MaybePromise<void> {
  const errors: unknown[] = [];
  const promises: Promise<void>[] = [];

  for (const fn of fns) {
    try {
      const r = fn();
      if (isPromise(r)) promises.push(r);
    } catch (e) {
      errors.push(e);
    }
  }

  if (promises.length > 0) {
    return Promise.allSettled(promises).then((settled) => {
      for (const r of settled) {
        if (r.status === 'rejected') errors.push(r.reason);
      }
      throwAggregated(errors, label);
    });
  }

  throwAggregated(errors, label);
}

/**
 * Run fns sequentially. Stays sync until the first promise, then goes async.
 * Uses an iterator so the async continuation picks up exactly where sync left off.
 * Errors are collected and thrown as an AggregateError at the end.
 */
export function runSequential(
  fns: Iterable<() => MaybePromise<void>>,
  label: string,
): MaybePromise<void> {
  const errors: unknown[] = [];
  const iter = fns[Symbol.iterator]();

  for (let next = iter.next(); !next.done; next = iter.next()) {
    try {
      const r = next.value();
      if (isPromise(r)) {
        // Promote to async — continue from current position
        return (async () => {
          try {
            await r;
          } catch (e) {
            errors.push(e);
          }
          for (let n = iter.next(); !n.done; n = iter.next()) {
            try {
              await n.value();
            } catch (e) {
              errors.push(e);
            }
          }
          throwAggregated(errors, label);
        })();
      }
    } catch (e) {
      errors.push(e);
    }
  }

  throwAggregated(errors, label);
}
