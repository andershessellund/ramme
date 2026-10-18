import { InjectionKey, getKeyDescription } from './context-key.js';
import { ContextImplLike, PeekResult, ResolveResult } from './internal-context.js';
import { resolveKey, createValueFromContext } from './inject.js';
import { LookupOptions, Provider, Created, ContextStatus } from './context.js';
import { ManagedResource, ResourceHandle, Drain, Flush, Dispose, Abort } from './resource.js';
import { Scope } from './scope.js';
import { getContextStorage } from './context-storage.js';
import { ContextTopic, type ContextEvent } from './lifecycle-events.js';
import { nextFiberId, resolveFiberReceiver, fiberExec } from './fiber-exec.js';
import { runParallel, runSequential } from './maybe-async.js';

const MISS_THRESHOLD = 10;

let nextCtxId = 0;

export class ContextImpl implements ContextImplLike {
  readonly id = ++nextCtxId;
  readonly name?: string;
  readonly depth: number;
  readonly root: ContextImpl;
  readonly parent?: ContextImpl;
  readonly captureAutoScoped: boolean;
  readonly autoScopeRoot: ContextImpl;

  private resolutions = new Map<InjectionKey<unknown>, ResolveResult<unknown>>();
  private providers: Map<InjectionKey<unknown>, Provider<unknown>> | undefined;

  // --- Resource tracking (lazy — most short-lived contexts have no resources) ---
  private resources: { resource: ManagedResource; removed: boolean; name: string }[] | undefined;
  private parentUnregister?: () => void;

  // --- Lifecycle state ---
  private _status: ContextStatus = 'active';
  private _aborted = false;
  private scopes: Set<Scope> | undefined;
  private missCounter = 0;

  /** Cached receiver for ContextTopic — resolved lazily on first emit. */
  private _ctxReceiver: ((event: ContextEvent) => void) | undefined | null = null;

  /**
   * Emit a ContextEvent via the ContextTopic receiver on the root context.
   * Resolved lazily and cached. No-op if no receiver is provided.
   */
  private emitCtx(event: ContextEvent): void {
    if (this._ctxReceiver === null) {
      // First call — resolve from root (which may be this)
      this._ctxReceiver = this.root.get(ContextTopic, { optional: true });
    }
    this._ctxReceiver?.(event);
  }

  get status(): ContextStatus {
    return this._status;
  }
  get aborted(): boolean {
    return this._aborted;
  }

  constructor(
    providers: Provider<unknown>[],
    parent?: ContextImpl,
    scopes?: Scope[],
    captureAutoScoped = false,
    name?: string,
  ) {
    this.captureAutoScoped = captureAutoScoped;
    this.name = name;
    this.scopes = scopes && scopes.length > 0 ? new Set(scopes) : undefined;
    if (parent) {
      this.parent = parent;
      this.depth = parent.depth + 1;
      this.root = parent.root;
      this.autoScopeRoot = captureAutoScoped ? this : parent.autoScopeRoot;
      // Register this child context as a ManagedResource on the parent
      const handle = parent.registerResource(this, name ?? `context-${this.id}`);
      this.parentUnregister = () => handle.unregister();
    } else {
      this.depth = 0;
      this.root = this;
      this.autoScopeRoot = this;
    }

    if (providers.length > 0) {
      const map = new Map<InjectionKey<unknown>, Provider<unknown>>();
      for (const provider of providers) {
        map.set(provider.key, provider);
      }
      this.providers = map;
    }

    // Emit context:created event
    this.emitCtx({
      type: 'context:created',
      id: this.id,
      parentId: this.parent?.id ?? null,
      depth: this.depth,
      scopes: this.scopes ? [...this.scopes].map((s) => s.name) : [],
      name: this.name,
    });
  }

  // --- Resource registration ---

  /**
   * Register a ManagedResource on this context.
   * The resource participates in drain/flush/dispose/abort.
   *
   * @param resource - The resource to register.
   * @param name - Optional human-readable name for observability (debug timeline).
   */
  registerResource(resource: ManagedResource, name?: string): ResourceHandle {
    const resourceName = name ?? resource.constructor?.name ?? 'resource';
    const entry = { resource, removed: false, name: resourceName };
    const resources = (this.resources ??= []);
    const resourceIndex = resources.length;
    resources.push(entry);
    this.emitCtx({ type: 'resource:registered', contextId: this.id, resourceIndex, resourceName });
    return {
      unregister: () => {
        entry.removed = true;
        this.emitCtx({
          type: 'resource:unregistered',
          contextId: this.id,
          resourceIndex,
          resourceName,
        });
      },
    };
  }

  // --- Resolution ---

  peek<T>(key: InjectionKey<T>): PeekResult<T> {
    const cached = this.resolutions.get(key);
    if (cached !== undefined) {
      if (cached.resolved) {
        return {
          found: true,
          value: cached.value as T,
          context: cached.context,
        };
      }
      return { found: false };
    }
    if (this.providers?.has(key)) {
      return {
        found: false,
        providingContext: this,
        provider: this.providers.get(key)! as Provider<T>,
      };
    }
    if (this.parent) {
      return this.parent.peek(key);
    }
    return { found: false };
  }

  resolve<T>(key: InjectionKey<T>): ResolveResult<T> {
    const cached = this.resolutions.get(key);
    if (cached !== undefined) {
      return cached as ResolveResult<T>;
    }

    const peekResult = this.peek(key);
    if (peekResult.found) {
      const result: ResolveResult<T> = {
        resolved: true,
        value: peekResult.value,
        context: peekResult.context,
      };
      this.maybeMemoize(key, result);
      return result;
    }

    const result = resolveKey(key, this, peekResult);
    if (!result.resolved) {
      this.resolutions.set(key, result as ResolveResult<unknown>);
    }
    return result;
  }

  private maybeMemoize<T>(key: InjectionKey<T>, result: ResolveResult<T>): void {
    if (result.resolved && result.context === this) return;
    this.missCounter++;
    if (this.missCounter >= MISS_THRESHOLD) {
      this.resolutions.set(key, result as ResolveResult<unknown>);
      this.missCounter = 0;
    }
  }

  memoizeResolution<T>(key: InjectionKey<T>, result: ResolveResult<T>): void {
    if (!this.resolutions.has(key)) {
      this.resolutions.set(key, result as ResolveResult<unknown>);
    }
  }

  hasResolution<T>(key: InjectionKey<T>): boolean {
    return this.resolutions.has(key);
  }

  store<T>(key: InjectionKey<T>, value: T, resource?: ManagedResource): void {
    this.resolutions.set(key, {
      resolved: true,
      value,
      context: this,
    });

    if (resource) {
      this.registerResource(resource, getKeyDescription(key));
    }
  }

  get<T>(key: InjectionKey<T>): T;
  get<T>(key: InjectionKey<T>, options?: LookupOptions & { optional?: false | undefined }): T;
  get<T>(key: InjectionKey<T>, options: LookupOptions): T | undefined;
  get<T>(key: InjectionKey<T>, options?: LookupOptions): T | undefined {
    if (options?.skipSelf) {
      if (!this.parent) {
        if (options.optional) return undefined;
        throw new Error(
          `Cannot skipSelf for key '${getKeyDescription(key)}': no parent context exists.`,
        );
      }
      return this.parent.get(key, { optional: options.optional });
    }
    const result = this.resolve(key);
    if (result.resolved) {
      return result.value;
    }
    if (options?.optional) {
      return undefined;
    }
    throw new Error(`No provider found for key: ${getKeyDescription(key)}`);
  }

  addProvider<T>(provider: Provider<T>): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let current: ContextImpl | undefined = this;
    while (current) {
      if (current.resolutions?.has(provider.key)) {
        throw new Error(
          `Cannot add provider for key '${getKeyDescription(provider.key)}': ` +
            `the key has already been resolved in the context hierarchy. ` +
            `Providers must be registered before any resolution of the key.`,
        );
      }
      current = current.parent;
    }
    (this.providers ??= new Map()).set(provider.key, provider);
  }

  create<T>(key: InjectionKey<T>): Created<T> {
    const result = createValueFromContext(this, key);
    // Register the created value as a resource so it gets disposed with the context
    this.registerResource(
      {
        [Dispose]: () => result.dispose(),
      },
      getKeyDescription(key),
    );
    return result;
  }

  findScopedContext(scope: Scope): ContextImpl | undefined {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let current: ContextImpl | undefined = this;
    while (current) {
      if (current.scopes && current.scopes.has(scope)) {
        return current;
      }
      current = current.parent;
    }
    return undefined;
  }

  // --- ManagedResource protocol (symbol methods) ---

  /**
   * Propagate abort signal to all resources.
   * Synchronous, does not initiate disposal.
   */
  [Abort](): void {
    if (this._aborted) return;
    this._aborted = true;
    this.emitCtx({ type: 'context:aborted', id: this.id });

    if (this.resources) {
      for (const entry of this.resources) {
        if (entry.removed) continue;
        try {
          entry.resource[Abort]?.();
        } catch {
          // abort is best-effort
        }
      }
    }
  }

  // --- Phase helpers ---

  private activeEntries(reverse: boolean) {
    if (!this.resources) return [];
    const entries = reverse ? [...this.resources].reverse() : this.resources;
    return entries.filter((e) => !e.removed);
  }

  /**
   * Build callable fns for a lifecycle phase. When a FiberTopic receiver is
   * present each call is wrapped in a lifecycle fiber for observability.
   */
  private phaseFns(
    symbol: typeof Drain | typeof Flush | typeof Dispose,
    reverse: boolean,
    phase: 'drain' | 'flush' | 'dispose',
  ): (() => Promise<void> | void)[] {
    const receiver = resolveFiberReceiver(this.root);
    return this.activeEntries(reverse)
      .filter((entry) => entry.resource[symbol])
      .map((entry) =>
        receiver
          ? () =>
              fiberExec(
                () => entry.resource[symbol]!() as Promise<void> | void,
                this,
                nextFiberId(),
                entry.name,
                'lifecycle',
                receiver,
                { phase, resourceName: entry.name },
              )
          : () => entry.resource[symbol]!() as Promise<void> | void,
      );
  }

  /** Drain phase — parallel. */
  [Drain](): Promise<void> | void {
    this._status = 'draining';
    this.emitCtx({ type: 'context:status', id: this.id, status: 'draining' });
    const r = runParallel(this.phaseFns(Drain, false, 'drain'), 'drain');
    if (r && typeof (r as any).then === 'function') {
      return (r as Promise<void>).then(() => {
        this._status = 'drained';
        this.emitCtx({ type: 'context:status', id: this.id, status: 'drained' });
      });
    }
    this._status = 'drained';
    this.emitCtx({ type: 'context:status', id: this.id, status: 'drained' });
  }

  /** Flush phase — reverse sequential. */
  [Flush](): Promise<void> | void {
    this._status = 'flushing';
    this.emitCtx({ type: 'context:status', id: this.id, status: 'flushing' });
    const r = runSequential(this.phaseFns(Flush, true, 'flush'), 'flush');
    if (r && typeof (r as any).then === 'function') {
      return (r as Promise<void>).then(() => {
        this._status = 'flushed';
        this.emitCtx({ type: 'context:status', id: this.id, status: 'flushed' });
      });
    }
    this._status = 'flushed';
    this.emitCtx({ type: 'context:status', id: this.id, status: 'flushed' });
  }

  /** Dispose phase — reverse sequential. */
  [Dispose](): Promise<void> | void {
    this._status = 'disposing';
    this.emitCtx({ type: 'context:status', id: this.id, status: 'disposing' });
    const r = runSequential(this.phaseFns(Dispose, true, 'dispose'), 'dispose');
    if (r && typeof (r as any).then === 'function') {
      return (r as Promise<void>).then(() => {
        this._status = 'disposed';
        this.emitCtx({ type: 'context:status', id: this.id, status: 'disposed' });
      });
    }
    this._status = 'disposed';
    this.emitCtx({ type: 'context:status', id: this.id, status: 'disposed' });
  }

  // --- Public lifecycle ---

  private lifecyclePromise: Promise<void> | undefined;

  /**
   * Abort this context — propagate abort signal then dispose gracefully.
   */
  abort(): void | Promise<void> {
    this[Abort]();
    return this.dispose();
  }

  /**
   * Dispose this context gracefully: drain → flush → dispose.
   *
   * Returns synchronously when all resources are sync; returns a Promise
   * when any resource has an async lifecycle method.
   */
  dispose(): void | Promise<void> {
    if (this._status === 'disposed') return;
    if (this.lifecyclePromise) return this.lifecyclePromise;

    const errors: unknown[] = [];

    const runPhase = (
      phase: 'drain' | 'flush' | 'dispose',
      before: ContextStatus,
      after: ContextStatus,
      runner: () => void | Promise<void>,
    ): void | Promise<void> => {
      this._status = before;
      this.emitCtx({ type: 'context:status', id: this.id, status: before });
      try {
        const r = runner();
        if (r && typeof (r as any).then === 'function') {
          return (r as Promise<void>)
            .catch((e) => {
              errors.push(e);
            })
            .then(() => {
              this._status = after;
              this.emitCtx({ type: 'context:status', id: this.id, status: after });
            });
        }
      } catch (e) {
        errors.push(e);
      }
      this._status = after;
      this.emitCtx({ type: 'context:status', id: this.id, status: after });
    };

    const finalize = (): void => {
      this._status = 'disposed';
      this.emitCtx({ type: 'context:status', id: this.id, status: 'disposed' });
      if (this.parentUnregister) this.parentUnregister();
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Multiple errors during disposal');
    };

    const r1 = runPhase('drain', 'draining', 'drained', () =>
      runParallel(this.phaseFns(Drain, false, 'drain'), 'drain'),
    );

    if (r1 && typeof (r1 as any).then === 'function') {
      // First phase went async — continue async for remaining phases
      this.lifecyclePromise = (r1 as Promise<void>)
        .then(() =>
          runPhase('flush', 'flushing', 'flushed', () =>
            runSequential(this.phaseFns(Flush, true, 'flush'), 'flush'),
          ),
        )
        .then(() =>
          runPhase('dispose', 'disposing', 'disposed', () =>
            runSequential(this.phaseFns(Dispose, true, 'dispose'), 'dispose'),
          ),
        )
        .then(finalize);
      return this.lifecyclePromise;
    }

    const r2 = runPhase('flush', 'flushing', 'flushed', () =>
      runSequential(this.phaseFns(Flush, true, 'flush'), 'flush'),
    );

    if (r2 && typeof (r2 as any).then === 'function') {
      this.lifecyclePromise = (r2 as Promise<void>)
        .then(() =>
          runPhase('dispose', 'disposing', 'disposed', () =>
            runSequential(this.phaseFns(Dispose, true, 'dispose'), 'dispose'),
          ),
        )
        .then(finalize);
      return this.lifecyclePromise;
    }

    const r3 = runPhase('dispose', 'disposing', 'disposed', () =>
      runSequential(this.phaseFns(Dispose, true, 'dispose'), 'dispose'),
    );

    if (r3 && typeof (r3 as any).then === 'function') {
      this.lifecyclePromise = (r3 as Promise<void>).then(finalize);
      return this.lifecyclePromise;
    }

    finalize();
  }

  enterSync(): void {
    getContextStorage().enterSync(this);
  }

  leaveSync(): void {
    getContextStorage().leaveSync();
  }

  run<R>(fn: () => R): R {
    return getContextStorage().runAsync(this, fn);
  }

  runSync<R>(
    fn: (ctx: ContextImpl) => R,
    options?: { providers?: any[]; scopes?: any[]; captureAutoScoped?: boolean; name?: string },
  ): R {
    const child = new ContextImpl(
      options?.providers ?? [],
      this,
      options?.scopes,
      options?.captureAutoScoped,
      options?.name,
    );
    const storage = getContextStorage();
    storage.enterSync(child);
    try {
      return fn(child);
    } finally {
      storage.leaveSync();
      child.dispose();
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  [Symbol.asyncDispose](): void | Promise<void> {
    return this.dispose();
  }
}
