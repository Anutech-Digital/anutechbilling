/** POST /api/marketing-budget/payments/[id]/close — billing sends it back, or the asker cancels (R-1792). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { budgetContext, closePayment } from "@/server/marketing-budget/budget.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({
  status: z.enum(["rejected", "cancelled"]),
  note: z.string().trim().max(1000).nullable().optional(),
});

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await budgetContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "No such payment request." }, { status: 404 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Choose send back or cancel." }, { status: 400 });
  const r = await closePayment(ctx, id, { status: parsed.data.status, note: parsed.data.note || null });
  if (!r.ok) return NextResponse.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return NextResponse.json({ ok: true });
}
