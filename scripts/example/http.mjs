// A small fetch wrapper for the example checks: JSON in and out, the bearer token as an option.

export function client(base) {
  return async function call(path, { method = "GET", token, headers = {}, body } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token === undefined || token === null ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: the checks look at text instead.
    }
    return { status: response.status, headers: response.headers, json, text };
  };
}
