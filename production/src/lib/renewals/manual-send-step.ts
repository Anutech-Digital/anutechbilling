/**
 * R-2710 — the renewal reminder step a MANUAL send counts as. One rule for the two manual sends:
 *
 *   Send now / "Send as is" / "Resend"   (api/renewals/send-now — it also picks the email tone)
 *   "Save & send to customer" in the quote editor (api/quotes/[id]/send on a renewal quote)
 *
 * Before R-2710 only Send now moved the subscription's renewal_state; a renewal quote emailed from
 * the editor left it at 'pending', so the nightly cron's next step mailed the same quote again.
 * Grace = the nightly run's (company, trusted customer, "+N days" — R-1621); the step = the
 * cadence target (a send before the first trigger counts as the notice).
 */
import {
  decideCadence, effectiveGraceDays, renewalIsSettled, triggersForTerm,
  type CadenceDecision, type CadenceTone,
} from "@/lib/renewals/cadence";
import { readGraceOverrides } from "@/lib/renewals/grace-overrides";
import { isSplitBilled } from "@/lib/billing/instalments";
import type { BillingCycle } from "@/lib/supabase/database.types";

export interface ManualStepSub {
  id: string;
  customer_id: string | null;
  renewal_date: string;
  renewal_state: string | null;
  term_months: number | null;
}

export interface ManualStep {
  graceDays: number;
  decision: CadenceDecision;
  /** The email tone for this send (Send now's template). */
  tone: CadenceTone;
  /** The renewal_state this send moves the subscription to. */
  step: string;
}

export async function manualRenewalStep(supabase: unknown, sub: ManualStepSub, tenantGraceDays: number | null | undefined): Promise<ManualStep> {
  const overrides = await readGraceOverrides(supabase, [sub.id], [sub.customer_id]);
  const graceDays = effectiveGraceDays({
    tenantGraceDays:  tenantGraceDays,
    trustedGraceDays: sub.customer_id ? overrides.trustedByCustomer.get(sub.customer_id) ?? null : null,
    renewalDate:      sub.renewal_date,
    graceUntil:       overrides.bySubscription.get(sub.id)?.graceUntil ?? null,
  });
  const decision = decideCadence({
    renewalDate:  sub.renewal_date,
    graceDays,
    currentState: (sub.renewal_state ?? "pending") as never,
    termMonths:   sub.term_months,
  });
  // On a trigger / past renewal: the decision's tone; else the most imminent upcoming trigger's.
  let tone: CadenceTone | null = decision.tone;
  if (!tone) {
    const daysUntil = decision.daysUntilRenewal;
    if (daysUntil < 0) {
      tone = "grace";
    } else {
      const candidates = [...triggersForTerm(sub.term_months)].sort((a, b) => b.daysOut - a.daysOut);
      const match = candidates.find((t) => t.daysOut <= daysUntil) ?? candidates[candidates.length - 1];
      tone = match?.tone ?? "soft";
    }
  }
  const step = decision.targetState === "pending" ? "notice_sent" : decision.targetState;
  return { graceDays, decision, tone, step };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };

/**
 * After a renewal quote was EMAILED from the quote editor: the subscription it renews (the one whose
 * renewal_quote_id it is — a revision holds the link once it is sent, R-2368) moves to the step a
 * manual send counts as, like Send now. Not for a settled / Won't renew / suspended / split-billed
 * subscription. Never throws (the email already went); a failure is logged.
 */
export async function advanceRenewalAfterQuoteEmail(supabase: Db, tenantId: string, quoteId: string): Promise<void> {
  try {
    const { data: sub, error } = await supabase
      .from("subscriptions")
      .select("id, customer_id, renewal_date, renewal_state, term_months, reminder_count, status, auto_renew, billing_cycle")
      .eq("tenant_id", tenantId)
      .eq("renewal_quote_id", quoteId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!sub || !sub.renewal_date || sub.status !== "active" || sub.auto_renew === false) return;
    if (sub.renewal_state === "suspended" || isSplitBilled((sub.billing_cycle ?? null) as BillingCycle | null)) return;
    if (renewalIsSettled(sub.renewal_state, sub.renewal_date, sub.term_months)) return;
    const { data: tenant } = await supabase.from("tenants").select("grace_period_days").eq("id", tenantId).maybeSingle();
    const { step } = await manualRenewalStep(supabase, sub as ManualStepSub, (tenant as { grace_period_days?: number | null } | null)?.grace_period_days);
    const { error: upErr } = await supabase
      .from("subscriptions")
      .update({ renewal_state: step, reminder_count: (sub.reminder_count ?? 0) + 1, last_reminder_sent_at_v2: new Date().toISOString() })
      .eq("id", sub.id)
      .eq("tenant_id", tenantId)
      .eq("renewal_quote_id", quoteId);
    if (upErr) throw new Error(upErr.message);
  } catch (e) {
    console.error(`[renewals] quote ${quoteId} was emailed, but its subscription's reminder step was not moved: ${e instanceof Error ? e.message : String(e)}`);
  }
}
