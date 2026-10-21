/** PATCH / DELETE /api/cold-calling/contacts/[id] — edit one number, or take it off its list (R-1663). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { normaliseIndianPhone } from "@/lib/ai/telecall";
import { deleteContact, updateContact } from "@/server/coldcall/coldcall.server";
import { coldCallContext, UUID_RE } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "No such number on your list." }, { status: 404 });
  const r = await deleteContact(ctx.run, id);
  if (!r.ok) return NextResponse.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return NextResponse.json({ ok: true });
}

const text = z.string().trim().max(120).transform((v) => v || null).nullable().optional();
const body = z.object({
  phone: z.string().trim().max(30).optional(),
  name: text,
  company: text,
  city: text,
  dnd: z.boolean().optional(),
});

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "No such number on your list." }, { status: 404 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Check the details and try again." }, { status: 400 });
  let phone: string | undefined;
  if (parsed.data.phone !== undefined) {
    const p = normaliseIndianPhone(parsed.data.phone);
    if (!p) {
      return NextResponse.json({ error: "That phone number could not be read.", detail: "Use a 10-digit mobile or a +91 number." }, { status: 400 });
    }
    phone = p;
  }
  const r = await updateContact(ctx.run, id, { ...parsed.data, phone });
  if (!r.ok) return NextResponse.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return NextResponse.json({ ok: true });
}
