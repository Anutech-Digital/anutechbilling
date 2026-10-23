/** GET /api/cold-calling/campaigns/[id]/contacts?status=a,b — the list with call results (R-1661). */
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
  /* One status or a few, comma-separated (the page groups "waiting" = pending + calling). */
  const wanted = (new URL(req.url).searchParams.get("status") ?? "").split(",").filter(isColdCallStatus);
  const status = wanted.length ? wanted : null;
  return NextResponse.json({ contacts: await listContacts(ctx.run, id, status) });
}
