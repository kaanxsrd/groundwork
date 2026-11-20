import { isAdmin, notAdmin } from "@/lib/admin";
import { gw } from "@/lib/groundwork";

/** The audit log, newest first. Pass `?cursor=` from the previous page for the next one. */
export async function GET(request: Request) {
  if (!isAdmin(request)) return notAdmin();
  const cursor = new URL(request.url).searchParams.get("cursor");
  const page = await gw.audit.query({ limit: 50, ...(cursor ? { cursor } : {}) });
  return Response.json(page, { headers: { "Cache-Control": "no-store" } });
}
