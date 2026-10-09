/**
 * Small rules behind three buttons on the quote page (R-482, 9 Oct 2026).
 *
 *  - R-409 `withInvoiceIssued`: after "Generate GST Invoice" the page kept the old button and
 *    an unticked "Invoiced" step until a reload. The RPC returns the invoice number, so the
 *    cached quote is updated with it at once; the refetch then confirms it.
 *  - R-443 `leadStageNow`: "Mark as sent" read the lead's stage from the page's lead query.
 *    Pressed before that query had loaded, the stage was undefined and the toast said "the
 *    lead had no stage recorded" — the lead stayed in Contacted. The stage is now read from
 *    the database at the moment of the click.
 *  - R-452 `rejectLeadOffer`: "Mark rejected" now asks why, and offers to mark the lead Lost
 *    when this was the lead's last open quote.
 */
import { LOSS_REASONS } from "@/lib/leads/loss-reasons";

// ── R-409 ────────────────────────────────────────────────────────────────────
export function withInvoiceIssued<Q extends { invoice_id: string | null; payment_status: string | null }>(
  quote: Q,
  invoiceId: string,
): Q {
  return { ...quote, invoice_id: invoiceId, payment_status: "invoiced" };
}

// ── R-443 ────────────────────────────────────────────────────────────────────
/** One read of the lead's stage — a supabase query, passed in so the test can fake it. */
export type LeadStageRead = () => PromiseLike<{ data: { stage: string | null } | null; error: unknown }>;

/**
 * The lead's stage right now, from the database. Falls back to the page's cached value only
 * when the read itself fails (never because the page had not loaded yet).
 */
export async function leadStageNow(
  read: LeadStageRead,
  cachedStage: string | null | undefined,
): Promise<string | null | undefined> {
  try {
    const { data, error } = await read();
    if (error || !data) return cachedStage;
    return data.stage;
  } catch {
    return cachedStage;
  }
}

// ── R-452 ────────────────────────────────────────────────────────────────────
export interface RejectLeadOffer {
  /** Show "Also mark the lead Lost" (ticked by default). */
  offer: boolean;
  /** Why it is not offered — shown as a small line, so its absence is explained. */
  note: string | null;
}

/**
 * Offer to mark the lead Lost when rejecting this quote?
 * Only when there is a lead, it is still in the pipeline, and no OTHER quote of it is open.
 */
export function rejectLeadOffer(input: {
  quoteId: string;
  lead: { stage: string | null } | null | undefined;
  leadQuotes: readonly { id: string; status: string; superseded_by?: string | null }[];
}): RejectLeadOffer {
  if (!input.lead) return { offer: false, note: null };
  const stage = (input.lead.stage ?? "").toLowerCase();
  if (stage === "lost") return { offer: false, note: "The lead is already Lost." };
  if (stage === "won") return { offer: false, note: "The lead is Won, so it stays as it is." };
  const otherOpen = input.leadQuotes.filter(
    (q) => q.id !== input.quoteId && !q.superseded_by
      && (q.status === "draft" || q.status === "sent" || q.status === "viewed"),
  );
  if (otherOpen.length > 0) {
    return {
      offer: false,
      note: `The lead has ${otherOpen.length === 1 ? "another open quote" : `${otherOpen.length} other open quotes`} (${otherOpen.map((q) => q.id).join(", ")}), so it stays open.`,
    };
  }
  return { offer: true, note: null };
}

export function lossLabel(code: string | null | undefined): string | null {
  return LOSS_REASONS.find((r) => r.code === code)?.label ?? null;
}

/** Timeline line for the lead when a rejection marks it Lost. */
export function lostActivityDetail(quoteId: string, code: string, note: string | null): string {
  const label = lossLabel(code) ?? code;
  return `Lost — ${label}. Quote ${quoteId} rejected${note ? ` · ${note}` : ""}`;
}
