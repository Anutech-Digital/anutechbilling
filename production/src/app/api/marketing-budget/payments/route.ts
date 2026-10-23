/** POST /api/marketing-budget/payments — ask billing to pay against an approved budget (R-1792). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { canAskBudget } from "@/lib/marketing-budget/budget";
import { askPayment, budgetContext } from "@/server/marketing-budget/budget.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({
  budgetId: z.string().uuid(),
  amount: z.coerce.number().int().min(1).max(100_000_000),
  payTo: z.string().trim().min(1).max(200),
  purpose: z.string().trim().max(1000).nullable().optional(),
  billLink: z.string().trim().max(500).nullable().optional(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export async function POST(req: Request) {
  const ctx = await budgetContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!canAskBudget(ctx.role)) {
    return NextResponse.json({ error: "Only marketing (or the owner) can ask billing to pay from a budget." }, { status: 403 });
  }
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the amount in rupees and who is to be paid." }, { status: 400 });
  }
  const r = await askPayment(ctx, {
    budgetId: parsed.data.budgetId, amount: parsed.data.amount, payTo: parsed.data.payTo,
    purpose: parsed.data.purpose || null, billLink: parsed.data.billLink || null,
    dueOn: parsed.data.dueOn ? new Date(`${parsed.data.dueOn}T00:00:00Z`) : null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return NextResponse.json({ id: r.id }, { status: 201 });
}
