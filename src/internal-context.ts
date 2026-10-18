
// ---------------------------------------------------------------------------
// Resolution result types — used by ContextImpl and inject.ts
// ---------------------------------------------------------------------------

export type FoundPeekResult<T> = {
  found: true;
  value: T;
  context: ContextImplLike;
};

export type NotFoundPeekResult<T> = {
  found: false;
  providingContext?: ContextImplLike;
  provider?: import('./context.js').Provider<T>;
};

export type PeekResult<T> = NotFoundPeekResult<T> | FoundPeekResult<T>;

export type ResolvedResult<T> = {
  resolved: true;
  value: T;
  context: ContextImplLike;
};

export type NotResolvedResult = {
  resolved: false;
};

export type ResolveResult<T> = ResolvedResult<T> | NotResolvedResult;

/**
 * Minimal shape of ContextImpl needed by result types.
 * This avoids circular imports between internal-context.ts and context-impl.ts.
 */
export interface ContextImplLike {
  readonly depth: number;
  readonly root: ContextImplLike;
  readonly parent?: ContextImplLike;
}
