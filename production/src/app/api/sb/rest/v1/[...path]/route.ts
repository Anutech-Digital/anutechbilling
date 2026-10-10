/**
 * /api/sb/rest/v1/* — the browser's way to the database once the VM's PostgREST is off.
 * Same requests supabase-js sent to https://api.anutech.in/rest/v1/*, answered by the
 * Prisma-backed gateway (src/server/postgrest). The caller is whoever their session token
 * says; the service-role key is refused here (it only works in-process on the server).
 */
import { NextResponse, type NextRequest } from "next/server";
import { handlePostgrest } from "@/server/postgrest/handler";
import { identityFromHeaders } from "@/server/postgrest/identity";
import { gatewayEnabled } from "@/server/postgrest/fetch";
import { PgrstError } from "@/server/postgrest/parse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!gatewayEnabled()) return NextResponse.json({ message: "data gateway is off" }, { status: 404 });
  const { path } = await ctx.params;
  try {
    const identity = identityFromHeaders(req.headers, { allowService: false });
    const res = await handlePostgrest({
      method: req.method,
      path: path.join("/"),
      search: req.nextUrl.searchParams,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? null : await req.text(),
    }, identity);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    const err = e instanceof PgrstError ? e : new PgrstError(500, "PGRST000", (e as Error).message);
    return NextResponse.json({ code: err.code, details: err.details, hint: err.hint, message: err.message },
      { status: err.status, headers: { "Cache-Control": "no-store" } });
  }
}

export { handle as GET, handle as HEAD, handle as POST, handle as PATCH, handle as DELETE };
