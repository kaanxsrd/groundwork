import { GroundworkError } from "../internal/errors.ts";

/** `"posts:*"` for a declared `"posts:read"`: every scope of that resource. */
export type ScopeWildcard<TScope extends string> = TScope extends `${infer Resource}:${string}`
  ? `${Resource}:*`
  : never;

/** What a key can be granted: a declared scope, or a wildcard over one resource. */
export type GrantedScope<TScope extends string> = TScope | ScopeWildcard<TScope>;

const SCOPE_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

const resourceOf = (scope: string): string | null => {
  const colon = scope.indexOf(":");
  return colon > 0 ? scope.slice(0, colon) : null;
};

export interface ScopeRules {
  readonly declared: ReadonlySet<string>;
  /** Validates scopes being granted to a key; returns them deduplicated. */
  grantable(scopes: unknown, label: string): string[];
  /** The required scopes that `granted` doesn't cover. */
  missing(granted: readonly string[], required: readonly string[]): string[];
}

export function createScopeRules(scopes: unknown): ScopeRules {
  if (typeof scopes !== "object" || scopes === null || Array.isArray(scopes)) {
    throw new GroundworkError(
      "invalid_config",
      'scopes must be an object of scope names and descriptions: { "posts:read": "Read posts" }.',
    );
  }
  const declared = new Set<string>();
  for (const [scope, description] of Object.entries(scopes)) {
    if (!SCOPE_PATTERN.test(scope)) {
      throw new GroundworkError(
        "invalid_config",
        `Invalid scope ${JSON.stringify(scope)}: use letters, digits and _ . : - (a * is only allowed when granting).`,
      );
    }
    if (typeof description !== "string") {
      throw new GroundworkError(
        "invalid_config",
        `The description of scope "${scope}" must be a string.`,
      );
    }
    declared.add(scope);
  }
  const resources = new Set([...declared].map(resourceOf).filter((r): r is string => r !== null));

  return {
    declared,
    grantable(value, label) {
      if (!Array.isArray(value)) {
        throw new GroundworkError("invalid_argument", `${label} must be an array of scopes.`);
      }
      for (const scope of value) {
        const wildcardOf =
          typeof scope === "string" && scope.endsWith(":*") ? scope.slice(0, -2) : null;
        const ok =
          typeof scope === "string" &&
          (declared.has(scope) || (wildcardOf !== null && resources.has(wildcardOf)));
        if (!ok) {
          throw new GroundworkError(
            "invalid_argument",
            `Unknown scope ${JSON.stringify(scope)}: declare it in scopes, or grant "<resource>:*".`,
          );
        }
      }
      return [...new Set(value as string[])];
    },
    missing(granted, required) {
      const grantedSet = new Set(granted);
      return required.filter((scope) => {
        if (grantedSet.has(scope)) return false;
        const resource = resourceOf(scope);
        return resource === null || !grantedSet.has(`${resource}:*`);
      });
    },
  };
}
