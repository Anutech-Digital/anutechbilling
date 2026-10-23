/** GET / POST /api/marketing-budget — the budgets this person may see; ask for a budget (R-1792). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { canAskBudget, isBudgetChannel, monthStart, type BudgetChannel } from "@/lib/marketing-budget/budget";
import { askBudget, budgetContext, listBudgets } from "@/server/marketing-budget/budget.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const ctx = await budgetContext();
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json({ role: ctx.role, me: ctx.session.userId, budgets: await listBudgets(ctx.run) });
}

const body = z.object({
  channel: z.string().refine(isBudgetChannel),
  productItemId: z.string().trim().max(100).nullable().optional(),
  productName: z.string().trim().max(200).nullable().optional(),
  month: z.string().trim(),
  amount: z.coerce.number().int().min(1).max(100_000_000),
  note: z.string().trim().max(1000).nullable().optional(),
});

export async function POST(req: Request) {
  const ctx = await budgetContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!canAskBudget(ctx.role)) {
    return NextResponse.json({ error: "Only marketing (or the owner) can ask for a budget." }, { status: 403 });
  }
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  const month = parsed.success ? monthStart(parsed.data.month) : null;
  if (!parsed.success || !month) {
    return NextResponse.json({ error: "Pick what it is for, the month and the amount in rupees." }, { status: 400 });
  }
  const r = await askBudget(ctx, {
    channel: parsed.data.channel as BudgetChannel, productItemId: parsed.data.productItemId || null,
    productName: parsed.data.productName || null, month, amount: parsed.data.amount, note: parsed.data.note || null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return NextResponse.json({ id: r.id }, { status: 201 });
}
