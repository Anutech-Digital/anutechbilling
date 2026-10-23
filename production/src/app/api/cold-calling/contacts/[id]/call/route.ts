/** POST /api/cold-calling/contacts/[id]/call — the AI agent calls this one number now (R-1662). */
import { NextResponse } from "next/server";
import { callContactNow } from "@/server/coldcall/coldcall.server";
import { bolnaOrError, coldCallContext, UUID_RE } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "No such number on your list." }, { status: 404 });
  const config = bolnaOrError();
  if (config instanceof NextResponse) return config;
  const r = await callContactNow(ctx.run, ctx.session.tenantId, id, config, new Date());
  if (!r.ok) return NextResponse.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return NextResponse.json({ ok: true });
}
