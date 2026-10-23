/** POST /api/marketing-budget/[id]/cancel — withdraw a budget request still waiting for the owner (R-1792). */
import { NextResponse } from "next/server";
import { budgetContext, cancelBudget } from "@/server/marketing-budget/budget.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await budgetContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "No such budget request." }, { status: 404 });
  const r = await cancelBudget(ctx, id);
  if (!r.ok) return NextResponse.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return NextResponse.json({ ok: true });
}
