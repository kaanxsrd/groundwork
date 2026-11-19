import { GroundworkError } from "../internal/errors.ts";

/** What a redacted value is replaced with. */
export const REDACTED = "[redacted]";

/**
 * Redacted by default, wherever they appear in `changes` or `metadata`. A key matches when it
 * contains one of these words, ignoring case, `_` and `-`: `accessToken`, `refresh_token` and
 * `X-Api-Key` all match.
 */
export const DEFAULT_REDACT: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "apiKey",
  "authorization",
  "cookie",
  "privateKey",
];

export type RedactRule = string | RegExp;

const MAX_DEPTH = 32;

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Builds the key test once, so recording an entry doesn't re-parse the rules. */
export function createRedactor(rules: readonly RedactRule[]): (key: string) => boolean {
  const words: string[] = [];
  const patterns: RegExp[] = [];
  for (const rule of rules) {
    if (rule instanceof RegExp) {
      // Drop the g and y flags, whose lastIndex would make test() depend on earlier calls.
      patterns.push(new RegExp(rule.source, rule.flags.replace(/[gy]/g, "")));
    } else if (typeof rule === "string" && normalizeKey(rule) !== "") {
      words.push(normalizeKey(rule));
    } else {
      throw new GroundworkError(
        "invalid_config",
        `Invalid redact rule ${JSON.stringify(rule)}: use a key name such as "password", or a RegExp.`,
      );
    }
  }
  return (key) => {
    const normalized = normalizeKey(key);
    return (
      words.some((word) => normalized.includes(word)) ||
      patterns.some((pattern) => pattern.test(key))
    );
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function walk(
  value: unknown,
  redact: (key: string) => boolean,
  stack: Set<object>,
  depth: number,
): Json | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }

  const object = value as object;
  if (object instanceof Date) return Number.isNaN(object.getTime()) ? null : object.toISOString();
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (stack.has(object)) return "[circular]";
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      return object.map((item) => walk(item, redact, stack, depth + 1) ?? null);
    }
    if (object instanceof Set) {
      return [...object].map((item) => walk(item, redact, stack, depth + 1) ?? null);
    }
    const toJSON = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return walk(toJSON.call(object), redact, stack, depth + 1);
    }
    const entries: [string, unknown][] =
      object instanceof Map
        ? [...object].map(([key, item]) => [String(key), item])
        : Object.entries(object);
    const result: { [key: string]: Json } = {};
    for (const [key, item] of entries) {
      if (item === undefined) continue;
      if (redact(key)) {
        result[key] = REDACTED;
        continue;
      }
      const json = walk(item, redact, stack, depth + 1);
      if (json !== undefined) result[key] = json;
    }
    return result;
  } finally {
    // Only the current path counts: an object referenced twice is fine, a cycle is not.
    stack.delete(object);
  }
}

/**
 * Turns `changes` or `metadata` into a JSON object for a `jsonb` column, redacting matching keys
 * at any depth. Dates become ISO strings, bigints become strings, `undefined` is dropped, and
 * cycles are cut. The input is never modified.
 */
export function toJsonObject(
  value: unknown,
  redact: (key: string) => boolean,
  label: string,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    throw new GroundworkError("invalid_argument", `${label} must be a plain object.`);
  }
  return walk(value, redact, new Set(), 0) as Record<string, unknown>;
}
