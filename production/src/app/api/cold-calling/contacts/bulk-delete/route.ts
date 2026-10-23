/** POST /api/cold-calling/contacts/bulk-delete — take several numbers off their lists (R-1663). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteContacts } from "@/server/coldcall/coldcall.server";
import { coldCallContext } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) });

export async function POST(req: Request) {
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick at least one number.", detail: "Tick the boxes next to the numbers to remove." }, { status: 400 });
  }
  return NextResponse.json(await deleteContacts(ctx.run, parsed.data.ids));
}
