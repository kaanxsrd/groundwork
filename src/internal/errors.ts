/**
 * Machine-readable reason for a {@link GroundworkError}. More codes may be added in a minor
 * release, so keep a default branch when you switch on it.
 *
 * - `invalid_config`: the setup is wrong: options passed when creating a module, a module used
 *   without its table or options, a secret function that returns a bad secret, or a table that
 *   needs a migration. Mostly thrown at startup; the ones only a request can find, on that request.
 * - `invalid_argument`: a value passed to a method is wrong (for example a malformed duration).
 * - `conflict`: the call kept losing a race with concurrent calls, after retrying. Try it again.
 */
export type GroundworkErrorCode = "invalid_config" | "invalid_argument" | "conflict";

const BRAND: unique symbol = Symbol.for("groundwork.error");

/**
 * The only error class groundwork throws on purpose. Branch on `code`, not on the message.
 *
 * Messages never contain secrets, API keys or rate-limit subjects.
 */
export class GroundworkError extends Error {
  override readonly name = "GroundworkError";
  readonly code: GroundworkErrorCode;
  readonly [BRAND] = true;

  constructor(code: GroundworkErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/**
 * Whether `error` is a {@link GroundworkError}. Unlike `instanceof`, this also works when two
 * copies of groundwork end up in one dependency tree.
 */
export function isGroundworkError(error: unknown): error is GroundworkError {
  return (
    typeof error === "object" && error !== null && (error as { [BRAND]?: unknown })[BRAND] === true
  );
}

/** An error's name and message, for log context. Never the stack, which can hold arguments. */
export function errorText(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}
