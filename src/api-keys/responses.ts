import type { VerifyFailureReason } from "./types.ts";

export const STATUS: Readonly<Record<VerifyFailureReason, 401 | 403 | 429>> = {
  missing: 401,
  malformed: 401,
  invalid: 401,
  revoked: 401,
  expired: 401,
  suspended: 403,
  forbidden_scope: 403,
  ip_denied: 403,
  origin_denied: 403,
  rate_limited: 429,
  quota_exceeded: 429,
};

export const MESSAGES: Readonly<Record<VerifyFailureReason, string>> = {
  missing: "Send your API key in the Authorization header as a Bearer token.",
  malformed: "This is not a valid API key.",
  invalid: "This API key is not valid.",
  revoked: "This API key has been revoked.",
  expired: "This API key has expired.",
  suspended: "This API key is temporarily suspended.",
  forbidden_scope: "This API key does not have the scopes this request needs.",
  ip_denied: "This API key cannot be used from this address.",
  origin_denied: "This API key cannot be used from this origin.",
  rate_limited: "Too many requests for this API key.",
  quota_exceeded: "This API key has used its daily quota.",
};

/** RFC 6750 `WWW-Authenticate` for bearer tokens. */
function wwwAuthenticate(
  reason: VerifyFailureReason,
  missingScopes: readonly string[],
): string | null {
  if (reason === "missing") return "Bearer";
  if (STATUS[reason] === 401) return 'Bearer error="invalid_token"';
  if (reason === "forbidden_scope")
    return `Bearer error="insufficient_scope", scope="${missingScopes.join(" ")}"`;
  return null;
}

export function failureHeaders(
  reason: VerifyFailureReason,
  missingScopes: readonly string[],
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const headers: Record<string, string> = { "Cache-Control": "no-store", ...extra };
  const challenge = wwwAuthenticate(reason, missingScopes);
  if (challenge) headers["WWW-Authenticate"] = challenge;
  return headers;
}

export function failureResponse(
  reason: VerifyFailureReason,
  headers: Readonly<Record<string, string>>,
  missingScopes: readonly string[],
): Response {
  const body = {
    error: {
      code: reason,
      message: MESSAGES[reason],
      ...(missingScopes.length > 0 ? { missingScopes } : {}),
    },
  };
  return Response.json(body, { status: STATUS[reason], headers });
}
