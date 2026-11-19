/** `{ field: [before, after] }` for each field that changed. A missing side is `null`. */
export type AuditDiff<T> = { [K in keyof T]?: [T[K] | null, T[K] | null] };

export interface DiffOptions<T> {
  /** Fields to leave out even if they changed, such as `"updatedAt"`. */
  readonly ignore?: readonly (keyof T & string)[] | undefined;
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => isEqual(item, b[i]))
    );
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.byteLength !== b.byteLength)
      return false;
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return left.every((byte, i) => byte === right[i]);
  }
  if (a instanceof Map || b instanceof Map || a instanceof Set || b instanceof Set) {
    if (a.constructor !== b.constructor) return false;
    return isEqual([...(a as Iterable<unknown>)], [...(b as Iterable<unknown>)]);
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every(
      (key) =>
        Object.hasOwn(b, key) &&
        isEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

/**
 * The fields that differ between two versions of a row, as `{ field: [before, after] }`.
 * Nested values are compared deeply, but reported whole. Pass `null` as `before` for a create,
 * or as `after` for a delete.
 *
 * ```ts
 * diff({ title: "Old", body: "x" }, { title: "New", body: "x" }); // { title: ["Old", "New"] }
 * ```
 */
export function diff<T extends object>(
  before: T | null | undefined,
  after: T | null | undefined,
  options: DiffOptions<T> = {},
): AuditDiff<T> {
  const ignore = new Set<string>(options.ignore ?? []);
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const result: Record<string, [unknown, unknown]> = {};
  for (const key of keys) {
    if (ignore.has(key)) continue;
    const a = before ? (before as Record<string, unknown>)[key] : undefined;
    const b = after ? (after as Record<string, unknown>)[key] : undefined;
    if (isEqual(a, b)) continue;
    result[key] = [a === undefined ? null : a, b === undefined ? null : b];
  }
  return result as AuditDiff<T>;
}
