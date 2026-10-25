// ---------------------------------------------------------------------------
// The floor's one guard (PROPOSAL.md §2.1, D41 decision 18): ramme keys every
// release off `Symbol.dispose` and `Symbol.asyncDispose` (`own(x)`, a node's
// own `[Symbol.asyncDispose]()`), and TypeScript's downlevelled `using` throws
// rather than falls back where they are missing, so they are defined at import
// of the core where a runtime lacks them, as the registered symbols the
// polyfills use. No other shim: the rest of the floor (ES2022 syntax,
// `Promise.withResolvers`, `AbortSignal.any` and `AbortSignal.timeout`) is a
// requirement, stated in the README ("Node 22+ or an evergreen browser").
//
// index.ts imports this module first, and node-impl.ts, which uses the symbols
// as method keys, imports it too, so it runs before either evaluates.
// ---------------------------------------------------------------------------

/** The two symbols on `target` (the global `Symbol`), each defined as `Symbol.for(…)` only where it is absent. */
export function defineDisposalSymbols(target: { dispose?: symbol; asyncDispose?: symbol }): void {
  target.dispose ??= Symbol.for('Symbol.dispose');
  target.asyncDispose ??= Symbol.for('Symbol.asyncDispose');
}

defineDisposalSymbols(Symbol as unknown as { dispose?: symbol; asyncDispose?: symbol });
