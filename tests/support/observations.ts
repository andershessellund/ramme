// Stable text for outcomes and errors in behavioral assertions.
export type Known = Readonly<Record<string, unknown>>;

/** Describe known values by identity and composite errors by their parts. */
export function label(x: unknown, known: Known = {}): string {
  for (const [name, v] of Object.entries(known)) if (v === x) return name;
  if (typeof x === 'object' && x !== null && 'suppressed' in x && 'error' in x) {
    const s = x as { error: unknown; suppressed: unknown };
    return `SuppressedError(error: ${label(s.error, known)}, suppressed: ${label(s.suppressed, known)})`;
  }
  if (x instanceof AggregateError) return `AggregateError(${x.errors.map((e: unknown) => label(e, known)).join(', ')})`;
  if (x instanceof Error) return `${x.name}: ${x.message}`;
  return typeof x === 'string' ? JSON.stringify(x) : String(x);
}

/** Describe errors by class and message, without expanding composite errors. */
export function labelError(x: unknown, known: Known = {}): string {
  for (const [name, v] of Object.entries(known)) if (v === x) return name;
  if (x instanceof Error) return `${x.name}: ${x.message}`;
  return typeof x === 'string' ? JSON.stringify(x) : String(x);
}

/** Describe an outcome using expanded composite errors. */
export function show(o: unknown, known: Known = {}): string {
  return formatOutcome(o, known, label);
}

/** Describe an outcome using error classes and messages. */
export function showError(o: unknown, known: Known = {}): string {
  return formatOutcome(o, known, labelError);
}

function formatOutcome(o: unknown, known: Known, label: (x: unknown, known: Known) => string): string {
  const x = o as { status?: unknown; value?: unknown; error?: unknown; reason?: unknown } | undefined;
  switch (x?.status) {
    case 'success':
      return `success(${label(x.value, known)})`;
    case 'failure':
      return `failure(${label(x.error, known)})`;
    case 'defect':
      return `defect(${label(x.error, known)})`;
    case 'aborted':
      return `aborted(${label(x.reason, known)})`;
    default:
      return `not an outcome: ${label(o, known)}`;
  }
}
