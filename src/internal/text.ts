// Postgres can't store every JavaScript string. `text` refuses `\u0000`, and `jsonb` also refuses
// a lone surrogate (half of an emoji, left by `.slice()` or sent by a client). Text parameters
// already turn a lone surrogate into U+FFFD on the way out.
//
// Free text (labels, summaries, names, reasons, JSON) is cleaned with `storable()`, so a write
// that used to throw, and roll back the caller's transaction with it, stores U+FFFD instead.
// Identifiers (ids, types, scopes, keys) go through `storableId()` and are refused: cleaning
// could make two of them the same, and a filter with the original value wouldn't find the row.

import { GroundworkError } from "./errors.ts";

/** True when Postgres stores `text` as it is. Paired surrogates are fine; lone ones and NUL aren't. */
export function isStorable(text: string): boolean {
  return text.isWellFormed() && !text.includes("\u0000");
}

/** `text` with each lone surrogate and each `\u0000` replaced by U+FFFD. */
export function storable(text: string): string {
  return isStorable(text) ? text : text.toWellFormed().replaceAll("\u0000", "�");
}

/** `id` as it is, or `invalid_argument` if Postgres can't store it unchanged. */
export function storableId(id: string, label: string): string {
  if (!isStorable(id)) {
    throw new GroundworkError(
      "invalid_argument",
      `${label} can't contain \\u0000 or a lone surrogate.`,
    );
  }
  return id;
}
