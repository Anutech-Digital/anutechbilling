/** POST /api/cold-calling/campaigns/[id]/import — add a CSV calling list to a campaign (R-1661). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseCallingList } from "@/lib/coldcall/coldcall";
import { importContacts } from "@/server/coldcall/coldcall.server";
import { coldCallContext, UUID_RE } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* 2 MB of text — the same cap as the leads CSV import. */
const body = z.object({ csv: z.string().min(1).max(2_000_000) });

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "No such campaign." }, { status: 404 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose a CSV file (up to 2 MB).", detail: "In Excel: File → Save As → CSV." },
      { status: 400 },
    );
  }
  const list = parseCallingList(parsed.data.csv);
  if (list.error) return NextResponse.json({ error: list.error }, { status: 400 });

  const r = await importContacts(ctx.run, ctx.session.tenantId, id, list.rows);
  if (!r) {
    return NextResponse.json({ error: "That campaign is not in your list any more — refresh the page." }, { status: 404 });
  }
  return NextResponse.json({
    added: r.added,
    alreadyOnList: list.rows.length - r.added,
    dnd: r.dnd,
    invalidLines: list.invalidLines.slice(0, 50),
    invalidCount: list.invalidLines.length,
    duplicatesInFile: list.duplicates,
  });
}
