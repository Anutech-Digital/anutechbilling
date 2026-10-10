/**
 * /api/sb/storage/v1/* — the browser's way to files once the VM's Storage API is off.
 * Same requests storage-js sent to https://api.anutech.in/storage/v1/*, answered by
 * src/server/postgrest/storage.ts (bytes in Cloud Storage, permission by the storage.objects
 * RLS policies). Signed and public URLs are served from here as well.
 */
import { NextResponse, type NextRequest } from "next/server";
import { handleStorage } from "@/server/postgrest/storage";
import { identityFromHeaders } from "@/server/postgrest/identity";
import { PgrstError } from "@/server/postgrest/parse";
import { storageGatewayEnabled } from "@/server/storage/backend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!storageGatewayEnabled()) return NextResponse.json({ message: "storage gateway is off" }, { status: 404 });
  const { path } = await ctx.params;
  try {
    return await handleStorage(req, path.map(encodeURIComponent).join("/"), identityFromHeaders(req.headers, { allowService: false }));
  } catch (e) {
    const err = e instanceof PgrstError ? e : new PgrstError(500, "PGRST000", (e as Error).message);
    return NextResponse.json({ statusCode: String(err.status), error: err.code, message: err.message }, { status: err.status });
  }
}

export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as DELETE };
