/**
 * The customer's Customer Portal login, the moment they have paid (Pawan, 7 Oct 2026: "We
 * should see the login details of hosting/domain panel immediately. Hosting can be assigned in
 * background in meanwhile").
 *
 * DMS used to create the portal account — and email its one-time password — only inside
 * hosting.provision / domain.register, so the login arrived when the provisioning cron next ran
 * (every 15 minutes, 9–21 IST on the live site) or later. The payment webhook now asks DMS for
 * the account straight away (engine command `customer.ensure`); provisioning, later, finds the
 * same account by email and sends nothing twice.
 *
 * Best-effort: a failure here is logged and changes nothing about the payment, which is already
 * recorded — provisioning still creates the account when it runs. One commandId per order, so a
 * repeated webhook is answered from DMS's store instead of creating anything twice.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { commandsConfigured, sendEngineCommand } from "@/lib/dms-engine/commands";
import { normalisePhone, splitName } from "@/lib/provisioning/domain-registration";

type Admin = ReturnType<typeof createAdminClient>;

export interface PortalAccountInput {
  tenantId: string;
  quoteId: string;
  leadId: string | null;
  customerName: string | null;
  /** The address Razorpay reported, used when the lead has none. */
  paymentEmail: string;
  /** What this order delivers. Only hosting and domains live in the Customer Portal. */
  vendors: readonly string[];
}

export type PortalAccountOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "done"; created: boolean }
  | { kind: "not_done"; reason: string };

export function portalAccountCommandId(quoteId: string): string {
  return `rsos-acct-${quoteId}`;
}

export async function ensurePortalAccount(admin: Admin, input: PortalAccountInput): Promise<PortalAccountOutcome> {
  if (!input.vendors.some((v) => v === "hosting" || v === "domain")) return { kind: "skipped", reason: "no hosting or domain in this order" };
  if (!commandsConfigured()) return { kind: "skipped", reason: "the DMS engine is not connected on this server" };

  let lead: { contact_name?: string | null; contact_email?: string | null; contact_phone?: string | null; company?: string | null; gstin?: string | null; state?: string | null } | null = null;
  if (input.leadId) {
    const { data } = await admin
      .from("leads")
      .select("contact_name, contact_email, contact_phone, company, gstin, state")
      .eq("id", input.leadId)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    lead = data;
  }
  const email = (lead?.contact_email || input.paymentEmail || "").trim().toLowerCase();
  if (!email) return { kind: "skipped", reason: "no customer email on the order" };

  const name = splitName(lead?.contact_name || input.customerName || email.split("@")[0]);
  /* The billing details this order already has, so the portal never asks for them again
     (Pawan, 10 Oct 2026: "their details should be reused"): GSTIN and state from the lead, the
     postal address from a domain line's registrant. DMS fills only empty fields with them. */
  const billing = await billingDetailsOf(admin, input, lead);
  const outcome = await sendEngineCommand({
    commandId: portalAccountCommandId(input.quoteId),
    command: "customer.ensure",
    subject: email,
    mode: "live",
    payload: {
      customer: { ...name, email, ...normalisePhone(lead?.contact_phone ?? ""), companyName: lead?.company || input.customerName || undefined, ...billing },
      sourceRef: input.quoteId,
    },
  });
  if (outcome.kind === "done") return { kind: "done", created: outcome.result.created === true };
  return { kind: "not_done", reason: `${outcome.kind}: ${outcome.reason}` };
}

type Address = { line1: string; city: string; state: string; zipcode: string; country: string };

/** GSTIN, state and postal address known for this order — each only when it is really there. */
async function billingDetailsOf(
  admin: Admin,
  input: PortalAccountInput,
  lead: { gstin?: string | null; state?: string | null } | null,
): Promise<{ gstin?: string; state?: string; address?: Address }> {
  const out: { gstin?: string; state?: string; address?: Address } = {};
  const gstin = (lead?.gstin ?? "").trim().toUpperCase();
  if (/^[0-9A-Z]{15}$/.test(gstin)) out.gstin = gstin;
  const state = (lead?.state ?? "").trim();
  if (state) out.state = state;
  const { data: q } = await admin
    .from("quotes")
    .select("line_items")
    .eq("id", input.quoteId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  const lines: unknown[] = Array.isArray((q as { line_items?: unknown } | null)?.line_items) ? ((q as { line_items: unknown[] }).line_items) : [];
  for (const l of lines) {
    const a = (l as { registrant?: { address?: Partial<Address> } } | null)?.registrant?.address;
    if (a?.line1 && a.city && a.zipcode) {
      out.address = { line1: a.line1, city: a.city, state: a.state || state, zipcode: a.zipcode, country: a.country || "IN" };
      break;
    }
  }
  return out;
}
