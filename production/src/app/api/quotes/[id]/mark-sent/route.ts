/**
 * POST /api/quotes/[id]/mark-sent — "I sent it myself (WhatsApp, link, by hand) — record it".
 *
 * R-1956: the ONE path that flips a quote draft → sent without emailing it. Used by:
 *   - the quote page's "Mark as sent" button;
 *   - "Copy customer link" on a DRAFT (quote page) and "Copy link instead" on a refused-send
 *     toast (builder + Send sheet). Coordinator's localhost check of R-1922, 26 Oct 2026: a
 *     refused send leaves the quote a draft, and the public accept page returns notFound()
 *     for drafts — so the copied link opened "This link doesn't lead anywhere". Handing the
 *     customer a link IS sending the quote, so the copy marks it sent first, through here.
 *
 * Same approval gate as the email route and the PDF link (customerCopyBlock, R-1669): a quote
 * waiting for (or refused) discount / margin approval is not marked sent — 409 with the
 * gate's own reason, which the caller shows instead of copying.
 *
 * Moves the lead forward with the same rule as every other sender (stageAfterQuoteSent —
 * never drags a Won or Lost lead back) and says so on the lead's timeline.
 *
 * Returns { quoteStatus, changed, leadMoved, leadReason }.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mayOpenPage, ROLE_GATE_ERROR } from "@/lib/api/with-route";
import { customerCopyBlock } from "@/lib/quotes/customer-copy-gate";
import { stageAfterQuoteSent } from "@/lib/leads/stage-after-quote-sent";
import { logDbError } from "@/lib/errors/db-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export interface MarkSentResult {
  quoteStatus: string;
  /** false = the quote was already past draft; nothing was written. */
  changed: boolean;
  leadMoved: boolean;
  /** Why the lead did (or did not) move — shown when it did not. */
  leadReason: string | null;
}

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", authData.user.id).maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "Your account is not linked to a workspace yet." }, { status: 403 });
  }
  /* Same roles as emailing a quote (R-1470): the ones that open Quotes. */
  if (!mayOpenPage((me as { role?: string | null }).role, ["/quotes"])) {
    return NextResponse.json({ error: ROLE_GATE_ERROR }, { status: 403 });
  }

  const { data: quote } = await supabase
    .from("quotes")
    .select("id, tenant_id, status, lead_id, line_items, approval_status, approval_tier, approval_requested_by, approved_by, approved_discount_bps, approved_margin_bps, approval_rejection_reason")
    .eq("id", params.id)
    .eq("tenant_id", me.tenant_id)
    .maybeSingle();
  if (!quote) {
    return NextResponse.json({ error: "Quote not found — reopen the quote and try again." }, { status: 404 });
  }

  if (quote.status !== "draft") {
    /* Already sent / viewed / accepted — the customer link already works. Nothing to write. */
    const done: MarkSentResult = { quoteStatus: quote.status, changed: false, leadMoved: false, leadReason: null };
    return NextResponse.json(done);
  }

  const block = customerCopyBlock(quote as Parameters<typeof customerCopyBlock>[0]);
  if (block) {
    return NextResponse.json(
      { error: `Needs approval first — ${block.reason} ${block.nextStep}`, reason: block.reason, nextStep: block.nextStep },
      { status: 409 },
    );
  }

  /* `.select("id")`: supabase-js counts "matched no rows" as success, so an RLS refusal or a
     race would otherwise report "marked as sent" over a quote that never changed. */
  const { data: flipped, error: flipErr } = await supabase
    .from("quotes")
    .update({ status: "sent" })
    .eq("id", quote.id)
    .eq("tenant_id", me.tenant_id)
    .eq("status", "draft")
    .select("id");
  if (flipErr) {
    logDbError("quotes/mark-sent", flipErr);
    return NextResponse.json({ error: "Could not mark the quote as sent. Reopen the quote and try again." }, { status: 500 });
  }
  if (!flipped || flipped.length === 0) {
    return NextResponse.json({ error: "The quote was not updated — reopen this page and try again." }, { status: 409 });
  }

  /* Forward only, the same single rule as the other senders. Read the stage NOW (R-443). A
     failed stage move is logged and never fails the answer: the quote IS sent. */
  let leadMoved = false;
  let leadReason: string | null = null;
  if (quote.lead_id) {
    const { data: leadRow } = await supabase
      .from("leads").select("stage").eq("id", quote.lead_id).eq("tenant_id", me.tenant_id).maybeSingle();
    const move = stageAfterQuoteSent((leadRow as { stage?: string | null } | null)?.stage);
    leadReason = move.reason;
    if (move.nextStage) {
      const { error: stageErr } = await supabase
        .from("leads")
        .update({ stage: move.nextStage, lost_reason: null, lost_note: null, lost_at: null })
        .eq("id", quote.lead_id)
        .eq("tenant_id", me.tenant_id);
      if (stageErr) {
        logDbError("quotes/mark-sent lead stage", stageErr);
      } else {
        leadMoved = true;
        /* Through the RPC so tenant_id comes from the server, as the page always did. */
        const { error: actErr } = await supabase.rpc("log_lead_activity", {
          p_lead_id: quote.lead_id,
          p_kind:    "stage",
          p_detail:  `Quote ${quote.id} marked as sent — ${move.reason}`,
        });
        if (actErr) logDbError("quotes/mark-sent activity", actErr);
      }
    }
  }

  const out: MarkSentResult = { quoteStatus: "sent", changed: true, leadMoved, leadReason };
  return NextResponse.json(out);
}
