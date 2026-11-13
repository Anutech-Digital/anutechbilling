/**
 * R-2710 — the ONE way to start a quote revision (R-448 "Revise"), shared by the quote page and the
 * Renewals row's "Change renewal quote".
 *
 *   insertRevision       the quote page's Revise: copy the SENT quote into the next family
 *                        version (Q-…-R2) as a DRAFT. Nothing changes for the customer until that
 *                        draft is sent; then the database marks the old one replaced
 *                        (trg_quote_revision_sent) and moves a renewal quote's subscription link
 *                        to it (R-2368).
 *   openRenewalRevision  Renewals: which draft to open for "Change renewal quote" — the renewal
 *                        quote itself while it is still a draft; an open (unsent) revision of it
 *                        when one exists (a second click never makes an R3 next to an unsent R2);
 *                        else a new revision when canReviseQuote allows it; else the reason.
 */
import type { createClient } from "@/lib/supabase/client";
import { canReviseQuote, nextRevision, revisionDraft, type RevisionSource } from "@/lib/quotes/revise";
import { istToday } from "@/lib/dates/ist";
import { totalReceived } from "@/lib/queries/payments";

/** The typed browser client (both callers are client components) — inserts stay checked against quotes. */
type Db = ReturnType<typeof createClient>;
import type { Payment } from "@/lib/supabase/database.types";

/** Insert the next revision of `quote` as a draft; returns its id (the quote page's Revise). */
export async function insertRevision(supabase: Db, quote: RevisionSource): Promise<string> {
  const root = quote.revision_of || quote.id;
  const { data: fam, error: famErr } = await supabase
    .from("quotes").select("revision_no").eq("revision_of", root)
    .order("revision_no", { ascending: false }).limit(1);
  if (famErr) throw famErr;
  const highest = Math.max(quote.revision_no ?? 1, (fam?.[0] as { revision_no?: number | null } | undefined)?.revision_no ?? 1);
  const next = nextRevision({ id: root, revision_of: root, revision_no: highest });
  const { data, error } = await supabase
    .from("quotes")
    .insert(revisionDraft(quote, next, istToday()))
    .select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export type RenewalChangeStep =
  | { kind: "open"; quoteId: string }
  | { kind: "revise" }
  | { kind: "refuse"; reason: string };

/** Pure: what "Change renewal quote" does for this linked quote (tested in start-revision.test.ts). */
export function renewalChangeStep(
  q: RevisionSource & { extension_months?: number | null },
  familyDraftId: string | null,
  received: number,
): RenewalChangeStep {
  /* R-2618: a plan-change / support-upgrade quote sits on the same link but renews nothing. */
  if (q.extension_months === 0) {
    return { kind: "refuse", reason: `${q.id} is a plan change quote, not a renewal quote — open it from the quote page to change it.` };
  }
  if (q.status === "draft" && !q.superseded_by) return { kind: "open", quoteId: q.id };
  /* Money / acceptance first: an unsent revision of a quote that has since been paid or accepted
     must not be opened for sending (sending it would replace the paid quote). */
  const check = canReviseQuote(q, received);
  if (!check.ok) return { kind: "refuse", reason: check.reason };
  if (familyDraftId && familyDraftId !== q.id) return { kind: "open", quoteId: familyDraftId };
  return { kind: "revise" };
}

export type RenewalRevisionResult =
  | { ok: true; quoteId: string; created: boolean }
  | { ok: false; reason: string };

/** "Change renewal quote": the draft to open in the editor (made when needed), or why not. */
export async function openRenewalRevision(supabase: Db, quoteId: string): Promise<RenewalRevisionResult> {
  const { data: q, error } = await supabase.from("quotes").select("*").eq("id", quoteId).maybeSingle();
  if (error) throw error;
  if (!q) return { ok: false, reason: `Quote ${quoteId} was not found — reload the Renewals page.` };
  const quote = q as RevisionSource & { extension_months?: number | null };
  const root = quote.revision_of || quote.id;
  const [{ data: drafts, error: dErr }, { data: pays, error: pErr }] = await Promise.all([
    supabase.from("quotes").select("id")
      .eq("revision_of", root).eq("status", "draft").is("superseded_by", null)
      .order("revision_no", { ascending: false }).limit(1),
    supabase.from("payments").select("amount, status").eq("quote_id", quote.id),
  ]);
  if (dErr) throw dErr;
  if (pErr) throw pErr;
  /* The quote page's own rule (lib/queries/payments.ts totalReceived). */
  const received = totalReceived((pays ?? []) as Payment[]);
  const step = renewalChangeStep(quote, (drafts?.[0] as { id?: string } | undefined)?.id ?? null, received);
  if (step.kind === "refuse") return { ok: false, reason: step.reason };
  if (step.kind === "open") return { ok: true, quoteId: step.quoteId, created: false };
  return { ok: true, quoteId: await insertRevision(supabase, quote), created: true };
}
