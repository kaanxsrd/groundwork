/**
 * Adds headers the handler didn't set itself. Some responses (`Response.redirect()`, a proxied
 * `fetch()`) have immutable headers; those are copied first.
 */
export function withHeaders(
  response: Response,
  headers: Readonly<Record<string, string>>,
): Response {
  const missing = Object.entries(headers).filter(([name]) => !response.headers.has(name));
  if (missing.length === 0) return response;
  try {
    for (const [name, value] of missing) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    for (const [name, value] of missing) copy.headers.set(name, value);
    return copy;
  }
}
