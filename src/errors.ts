/**
 * A user-facing error with a plain-language message and, ideally, a concrete
 * next step. The CLI catches these and prints them without a stack trace —
 * cryptic output is the exact pain Pitstop exists to remove.
 */
export class PitstopError extends Error {
  /** A short, actionable hint shown under the message (e.g. how to fix it). */
  readonly hint?: string;
  /** Process exit code to use when this error reaches the top level. */
  readonly exitCode: number;

  constructor(message: string, options: { hint?: string; exitCode?: number } = {}) {
    super(message);
    this.name = "PitstopError";
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** Type guard for {@link PitstopError}. */
export function isPitstopError(value: unknown): value is PitstopError {
  return value instanceof PitstopError;
}
