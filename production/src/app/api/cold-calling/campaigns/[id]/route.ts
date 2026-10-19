/** PATCH /api/cold-calling/campaigns/[id] — start / pause / finish, change the daily limit (R-1661). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { updateCampaign } from "@/server/coldcall/coldcall.server";
import { bolnaOrError, coldCallContext, UUID_RE } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({
  status: z.enum(["running", "paused", "done"]).optional(),
  dailyLimit: z.coerce.number().int().min(1).max(1000).optional(),
});

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "No such campaign." }, { status: 404 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success || (!parsed.data.status && !parsed.data.dailyLimit)) {
    return NextResponse.json(
      { error: "Nothing to change.", detail: "Send a status (running, paused, done) or a daily limit (1–1,000)." },
      { status: 400 },
    );
  }
  if (parsed.data.status === "running") {
    const config = bolnaOrError();
    if (config instanceof NextResponse) return config;
  }
  const ok = await updateCampaign(ctx.run, id, parsed.data);
  if (!ok) {
    return NextResponse.json({ error: "That campaign is not in your list any more — refresh the page." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
