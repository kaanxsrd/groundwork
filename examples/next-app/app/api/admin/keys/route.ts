import { z } from "zod";
import { isAdmin, notAdmin } from "@/lib/admin";
import { gw } from "@/lib/groundwork";

const NewKey = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(["posts:read", "posts:write"])).min(1),
});

/** Creates an API key. The key is in this response only: groundwork stores just its hash. */
export async function POST(request: Request) {
  if (!isAdmin(request)) return notAdmin();
  const input = NewKey.safeParse(await request.json().catch(() => null));
  if (!input.success) {
    return Response.json(
      { error: { code: "invalid_body", message: z.prettifyError(input.error) } },
      { status: 400 },
    );
  }
  const { key, record } = await gw.apiKeys.create(
    { name: input.data.name, scopes: input.data.scopes, expiresIn: "90d" },
    { actor: { type: "user", id: "admin" } },
  );
  return Response.json(
    { key, id: record.id, prefix: record.prefix, expiresAt: record.expiresAt },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
