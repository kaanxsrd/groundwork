/** The request header, per draft-ietf-httpapi-idempotency-key-header-08. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** Set on a replayed response. The name Stripe and VaultDrop use. */
export const REPLAYED_HEADER = "Idempotent-Replayed";

/** Visible ASCII, 8 to 255 characters: long enough to be hard to guess, short enough to index. */
const KEY_PATTERN = /^[\x21-\x7e]{8,255}$/;

/**
 * Reads an `Idempotency-Key` value. The draft makes it a Structured Field string (`"…"`), and most
 * clients (Stripe's, VaultDrop's) send it bare, so both are accepted. Returns `null` when the
 * value isn't a valid key.
 */
export function parseIdempotencyKey(value: string): string | null {
  const text = value.trim();
  if (!text.startsWith('"')) return KEY_PATTERN.test(text) ? text : null;
  // sf-string: printable ASCII, with \" and \\ as the only escapes. Parameters are not allowed.
  let key = "";
  for (let i = 1; i < text.length; i++) {
    const char = text[i] as string;
    if (char === "\\") {
      const next = text[i + 1];
      if (next !== '"' && next !== "\\") return null;
      key += next;
      i++;
    } else if (char === '"') {
      return i === text.length - 1 && KEY_PATTERN.test(key) ? key : null;
    } else if (char < " " || char > "~") {
      return null;
    } else {
      key += char;
    }
  }
  return null;
}

export type IdempotencyErrorCode =
  | "idempotency_key_missing"
  | "idempotency_key_invalid"
  | "idempotency_key_reused"
  | "idempotency_key_in_use";

const ERRORS: Readonly<Record<IdempotencyErrorCode, { status: number; message: string }>> = {
  idempotency_key_missing: {
    status: 400,
    message: "This request needs an Idempotency-Key header.",
  },
  idempotency_key_invalid: {
    status: 400,
    message: "Idempotency-Key must be 8 to 255 visible ASCII characters.",
  },
  idempotency_key_reused: {
    status: 422,
    message: "This Idempotency-Key was already used for a different request.",
  },
  idempotency_key_in_use: {
    status: 409,
    message: "A request with this Idempotency-Key is still in progress. Retry shortly.",
  },
};

/** `{ "error": { "code", "message" } }`, the shape every groundwork error response has. */
export function errorResponse(code: IdempotencyErrorCode): Response {
  const { status, message } = ERRORS[code];
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (code === "idempotency_key_in_use") headers["Retry-After"] = "1";
  return Response.json({ error: { code, message } }, { status, headers });
}

/**
 * Headers that are never stored: cookies are credentials, rate-limit headers describe the request
 * they were sent with, and the rest are recomputed for every response.
 */
const UNSTORED_HEADERS = new Set([
  "set-cookie",
  "date",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "ratelimit",
  "ratelimit-policy",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  REPLAYED_HEADER.toLowerCase(),
]);

/** A response as stored in the `response` column (JSON text). */
export interface StoredResponse {
  readonly status: number;
  readonly statusText?: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
  /** How `body` is encoded: UTF-8 text, or base64 for anything that isn't valid UTF-8. */
  readonly encoding: "utf8" | "base64";
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function encodeResponse(response: Response, body: Uint8Array): StoredResponse {
  const headers: [string, string][] = [];
  for (const [name, value] of response.headers) {
    if (!UNSTORED_HEADERS.has(name.toLowerCase())) headers.push([name, value]);
  }
  let text: string | null = null;
  try {
    text = strictUtf8.decode(body);
  } catch {
    text = null;
  }
  return {
    status: response.status,
    ...(response.statusText ? { statusText: response.statusText } : {}),
    headers,
    ...(text === null
      ? { body: Buffer.from(body).toString("base64"), encoding: "base64" as const }
      : { body: text, encoding: "utf8" as const }),
  };
}

export function isStoredResponse(value: unknown): value is StoredResponse {
  if (typeof value !== "object" || value === null) return false;
  const stored = value as Partial<StoredResponse>;
  return (
    typeof stored.status === "number" &&
    Array.isArray(stored.headers) &&
    typeof stored.body === "string" &&
    (stored.encoding === "utf8" || stored.encoding === "base64")
  );
}

/** Rebuilds a stored response, marked with `Idempotent-Replayed: true`. */
export function decodeResponse(stored: StoredResponse): Response {
  const headers = new Headers();
  for (const [name, value] of stored.headers) headers.append(name, value);
  headers.set(REPLAYED_HEADER, "true");
  const body = stored.encoding === "base64" ? Buffer.from(stored.body, "base64") : stored.body;
  const nullBody = stored.status === 204 || stored.status === 205 || stored.status === 304;
  return new Response(nullBody ? null : body, {
    status: stored.status,
    ...(stored.statusText === undefined ? {} : { statusText: stored.statusText }),
    headers,
  });
}
