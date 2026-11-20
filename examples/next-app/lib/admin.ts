import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * The example's stand-in for real sign-in: admin routes need `Authorization: Bearer $ADMIN_SECRET`.
 * Digests make the comparison take the same time whatever was sent.
 */
export function isAdmin(request: Request): boolean {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  return timingSafeEqual(digest(token), digest(env.ADMIN_SECRET));
}

export function notAdmin(): Response {
  return Response.json(
    { error: { code: "unauthorized", message: "Send the admin secret as a Bearer token." } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}
