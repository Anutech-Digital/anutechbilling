/** GET /api/cold-calling/campaigns/[id]/contacts?status= — the list with call results (R-1661). */
import { NextResponse } from "next/server";
import { isColdCallStatus, listContacts } from "@/server/coldcall/coldcall.server";
import { coldCallContext, UUID_RE } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "No such campaign." }, { status: 404 });
  const s = new URL(req.url).searchParams.get("status");
  const status = s && isColdCallStatus(s) ? s : null;
  return NextResponse.json({ contacts: await listContacts(ctx.run, id, status) });
}
