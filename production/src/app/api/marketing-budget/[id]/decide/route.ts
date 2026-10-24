/** POST /api/marketing-budget/[id]/decide — the owner approves (maybe for less) or rejects (R-1792). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { canApproveBudget } from "@/lib/marketing-budget/budget";
import { budgetContext, decideBudget } from "@/server/marketing-budget/budget.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({
  decision: z.enum(["approve", "reject"]),
  amount: z.coerce.number().int().min(1).max(100_000_000).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await budgetContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!canApproveBudget(ctx.role)) {
    return NextResponse.json({ error: "Only the owner can approve or reject a budget." }, { status: 403 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "No such budget request." }, { status: 404 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Choose approve or reject." }, { status: 400 });
  const r = await decideBudget(ctx, id, { decision: parsed.data.decision, amount: parsed.data.amount ?? null, note: parsed.data.note || null });
  if (!r.ok) return NextResponse.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return NextResponse.json({ ok: true });
}
