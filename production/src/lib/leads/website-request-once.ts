/**
 * R-2968 (20 Nov 2026) — a website trial / quote request asked again joins the first request.
 *
 * "Start free trial" on the buy page made a NEW lead + three follow-up tasks + a customer email on
 * every click (one domain had four trial leads in four minutes). The public routes now save their
 * lead through `website_lead_once` (migration 20261120133500): in one transaction, under an advisory
 * lock per storefront + form (two clicks that arrive together run one after the other), it either
 * joins the same contact's open request of the same form from the last
 * WEBSITE_REQUEST_AGAIN_WINDOW_HOURS hours — appending "Asked again <IST time>" (+ what changed) to
 * its notes — or inserts the new lead. A joined request makes no tasks, alerts, quotes or emails.
 *
 * Same contact = same cleaned domain OR same mobile (last 10 digits) OR same email. The quote route
 * also needs the same plan + seats + value (`matchOffer`): a changed quote request is a new quote.
 */

/** How long a request stays "the same request" when asked again. Pinned by a test. */
export const WEBSITE_REQUEST_AGAIN_WINDOW_HOURS = 24;

export type LeadOnce =
  | { ok: true; joined: false; leadId: string }
  | { ok: true; joined: true; leadId: string; note: string }
  | { ok: false; error: string };

type LeadOnceRpc = {
  rpc: (
    fn: "website_lead_once",
    args: { p_tenant: string; p_row: Record<string, unknown>; p_window_hours: number; p_match_offer: boolean },
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

/** Save the website lead once: join the same contact's open request, or insert `row` (its `id` included). */
export async function saveWebsiteLeadOnce(
  admin: unknown,
  tenantId: string,
  row: Record<string, unknown>,
  opts: { matchOffer?: boolean } = {},
): Promise<LeadOnce> {
  const { data, error } = await (admin as LeadOnceRpc).rpc("website_lead_once", {
    p_tenant: tenantId,
    p_row: row,
    p_window_hours: WEBSITE_REQUEST_AGAIN_WINDOW_HOURS,
    p_match_offer: opts.matchOffer === true,
  });
  if (error) return { ok: false, error: error.message ?? "website_lead_once failed" };
  const r = (data ?? {}) as { action?: string; lead_id?: string; note?: string };
  if (typeof r.lead_id !== "string" || !r.lead_id) return { ok: false, error: "website_lead_once returned no lead" };
  if (r.action === "joined") return { ok: true, joined: true, leadId: r.lead_id, note: r.note ?? "" };
  if (r.action === "created") return { ok: true, joined: false, leadId: r.lead_id };
  return { ok: false, error: `website_lead_once: unexpected action ${String(r.action)}` };
}

/** What the buyer sees when the request joined an earlier one (`sla` e.g. "within 4 working hours"). */
export function alreadyRequestedText(kind: "trial" | "quote", sla: string): string {
  return kind === "trial"
    ? `Your trial is already requested — our team will contact you ${sla}.`
    : `We already have your request — our team will contact you ${sla}.`;
}
