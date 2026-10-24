/** POST /api/marketing-budget/payments/[id]/paid — billing paid it; the expense is written too (R-1792). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { canPay } from "@/lib/marketing-budget/budget";
import { budgetContext, markPaid } from "@/server/marketing-budget/budget.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mode: z.string().trim().max(40).nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
});

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await budgetContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!canPay(ctx.role)) return NextResponse.json({ error: "Only billing (or the owner) can mark a payment paid." }, { status: 403 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "No such payment request." }, { status: 404 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Enter the date it was paid." }, { status: 400 });
  const r = await markPaid(ctx, id, {
    paidOn: new Date(`${parsed.data.paidOn}T00:00:00Z`), mode: parsed.data.mode || null, reference: parsed.data.reference || null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return NextResponse.json({ ok: true, expenseId: r.expenseId });
}
