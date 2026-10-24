/**
 * A won deal → the subscription form, already filled in (R-073, 2 Oct 2026).
 *
 * Billing used to re-type everything the deal already knew — company, the person, domain,
 * plan, seats. The lead carries all of it; this maps it onto the form's fields. Pure, so the
 * mapping is tested without a dialog.
 *
 * Price is NOT copied from the lead: `leads.value` is a deal total in whatever unit the
 * salesperson typed, and the form prices from the catalog the moment the plan is set. A plan
 * the catalog does not know stays a custom plan with the price left for the operator.
 */
import { planKey } from "@/lib/subscriptions/plan-match";
import type { BillingChoice } from "@/lib/subscriptions/catalog-options";

export interface LeadPrefill {
  leadId: string;
  customerId: string | null;
  customerName: string;
  domain: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  plan: string;
  seats: number | null;
  billingChoice: BillingChoice;
  /** R-1712: the lead's GSTIN and state — a new customer made from the deal starts with them. */
  gstin: string;
  stateCode: string;
}

export interface PrefillLead {
  id: string;
  company: string | null;
  customer_id?: string | null;
  domain?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  plan?: string | null;
  seats?: number | null;
  billing_cycle?: string | null;
  gstin?: string | null;
  state_code?: string | null;
}

/** leads.billing_cycle → the form's billing choice. Monthly is flexible; anything else annual. */
export function billingChoiceFromCycle(cycle: string | null | undefined): BillingChoice {
  return cycle === "monthly" ? "monthly_flex" : "annual_yearly";
}

export function prefillFromLead(l: PrefillLead): LeadPrefill {
  const t = (v: string | null | undefined) => (v ?? "").trim();
  return {
    leadId: l.id,
    customerId: l.customer_id ?? null,
    customerName: t(l.company),
    domain: t(l.domain).toLowerCase(),
    contactName: t(l.contact_name),
    contactEmail: t(l.contact_email).toLowerCase(),
    contactPhone: t(l.contact_phone),
    plan: t(l.plan),
    seats: l.seats && l.seats > 0 ? Math.round(l.seats) : null,
    billingChoice: billingChoiceFromCycle(l.billing_cycle),
    gstin: t(l.gstin).toUpperCase(),
    stateCode: t(l.state_code),
  };
}

/** The catalog product a lead's plan text names ("Business Standard" ≈ "Google Workspace Business Standard"). */
export function findPlanProduct<T extends { name: string }>(products: readonly T[], plan: string): T | undefined {
  const key = planKey(plan);
  if (!key) return undefined;
  return products.find((p) => planKey(p.name) === key)
    ?? products.find((p) => planKey(p.name).endsWith(key) || key.endsWith(planKey(p.name)));
}

/** Where a won deal's "Create subscription" goes. */
export function subscriptionFromLeadHref(leadId: string): string {
  return `/subscriptions?from_lead=${encodeURIComponent(leadId)}`;
}
