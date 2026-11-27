// Postgres can't store every JavaScript string. `text` refuses `\u0000`, and `jsonb` also refuses
// a lone surrogate (half of an emoji, left by `.slice()` or sent by a client). Text parameters
// already turn a lone surrogate into U+FFFD on the way out, so a write that used to throw, and
// roll back the caller's transaction with it, stores U+FFFD in both cases instead.

/** True when Postgres stores `text` as it is. Paired surrogates are fine; lone ones and NUL aren't. */
export function isStorable(text: string): boolean {
  return text.isWellFormed() && !text.includes("\u0000");
}

/** `text` with each lone surrogate and each `\u0000` replaced by U+FFFD. */
export function storable(text: string): string {
  return isStorable(text) ? text : text.toWellFormed().replaceAll("\u0000", "�");
}
