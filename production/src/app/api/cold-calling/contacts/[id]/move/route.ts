/** POST /api/cold-calling/contacts/[id]/move — "Move to Sales & Pipeline" (R-1663, a person's press). */
import { NextResponse } from "next/server";
import { moveToPipeline } from "@/server/coldcall/coldcall.server";
import { coldCallContext, UUID_RE } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "No such number on your list." }, { status: 404 });
  const r = await moveToPipeline(ctx.run, ctx.session.tenantId, ctx.session.userId, id);
  if (!r.ok) return NextResponse.json({ error: r.error, leadId: r.leadId ?? null }, { status: r.status });
  return NextResponse.json({ leadId: r.leadId });
}
