/**
 * R-260 — the "All set" screen's status list, built ONLY from real data.
 *
 * Before this the list was hard-coded: Razorpay always "todo", Google CSP always
 * "pending · approval in 5–7 days" (for owners who never applied), WhatsApp always
 * "todo" — even when Settings → Integrations showed them connected. Every row here
 * now comes from a saved tenant field or the same integration GET Settings reads.
 *
 * Input convention for the integration probes:
 *   undefined → still loading  → "checking"
 *   null      → the GET failed (e.g. role cannot read it) → "unknown", never a guess
 */

export type ChecklistStatus = "done" | "pending" | "todo" | "checking" | "unknown";

export interface ChecklistItem {
  id: string;
  label: string;
  status: ChecklistStatus;
  note?: string;
  /** Where to finish it. Absent when the row is done. */
  href?: string;
}

export interface RazorpayProbe {
  configured?: boolean;
  readiness?: { state?: "not_configured" | "collect_only" | "ready" } | null;
}
export interface WhatsAppProbe { configured?: boolean }
export interface GoogleResellerProbe { connected?: boolean; code?: string }

export interface DoneInputs {
  gstin: string | null | undefined;
  gstinVerifiedAt: string | null | undefined;
  stateCode: string | null | undefined;
  upiVpa: string | null | undefined;
  remitAccountNumber: string | null | undefined;
  /** undefined = loading */
  customerCount: number | undefined;
  /** undefined = loading */
  catalogCount: number | undefined;
  razorpay: RazorpayProbe | null | undefined;
  whatsapp: WhatsAppProbe | null | undefined;
  googleReseller: GoogleResellerProbe | null | undefined;
}

const COMPANY = "/settings?tab=company";
const INTEGRATIONS = "/settings?tab=integrations";
const has = (v: string | null | undefined) => typeof v === "string" && v.trim().length > 0;

export function buildDoneChecklist(i: DoneInputs): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  // Company GSTIN — verified / saved but not verified / missing.
  if (i.gstinVerifiedAt) {
    items.push({ id: "gstin", label: "GSTIN verified", status: "done" });
  } else if (has(i.gstin)) {
    items.push({ id: "gstin", label: "GSTIN saved", status: "pending", note: "Press Verify in Settings → Company", href: COMPANY });
  } else {
    items.push({ id: "gstin", label: "Add your GSTIN", status: "todo", note: "Needed on B2B tax invoices", href: COMPANY });
  }

  // GST invoices need the company's state (IGST vs CGST+SGST).
  items.push(has(i.stateCode)
    ? { id: "invoice", label: "GST invoices ready", status: "done" }
    : { id: "invoice", label: "Choose your state", status: "todo", note: "Decides IGST vs CGST + SGST", href: COMPANY });

  // Getting paid — UPI QR or bank details on the invoice.
  items.push(has(i.upiVpa) || has(i.remitAccountNumber)
    ? { id: "payout", label: "Payment details on invoices", status: "done" }
    : { id: "payout", label: "Add UPI or bank details", status: "todo", note: "Printed on every invoice", href: COMPANY });

  // Customers
  if (i.customerCount === undefined) items.push({ id: "customers", label: "Customers", status: "checking" });
  else if (i.customerCount > 0) items.push({ id: "customers", label: `${i.customerCount} customer${i.customerCount === 1 ? "" : "s"} added`, status: "done" });
  else items.push({ id: "customers", label: "Add your customers", status: "todo", note: "Import a CSV or add one", href: "/customers" });

  // Price list
  if (i.catalogCount === undefined) items.push({ id: "catalog", label: "Price list", status: "checking" });
  else if (i.catalogCount > 0) items.push({ id: "catalog", label: "Price list loaded", status: "done" });
  else items.push({ id: "catalog", label: "Load your price list", status: "todo", note: "Quotes need products", href: "/items" });

  // Razorpay — readiness from the server, not a boolean guess.
  if (i.razorpay === undefined) items.push({ id: "razorpay", label: "Razorpay payments", status: "checking" });
  else if (i.razorpay === null) items.push({ id: "razorpay", label: "Razorpay payments", status: "unknown", note: "Check in Settings → Integrations", href: INTEGRATIONS });
  else {
    const state = i.razorpay.readiness?.state ?? (i.razorpay.configured ? "ready" : "not_configured");
    if (state === "ready") items.push({ id: "razorpay", label: "Razorpay connected", status: "done" });
    else if (state === "collect_only") items.push({ id: "razorpay", label: "Razorpay half set up", status: "pending", note: "Add the webhook secret", href: INTEGRATIONS });
    else items.push({ id: "razorpay", label: "Connect Razorpay", status: "todo", note: "Optional · online payments", href: INTEGRATIONS });
  }

  // Google Reseller API — the same probe the Settings card runs.
  if (i.googleReseller === undefined) items.push({ id: "google", label: "Google Reseller API", status: "checking" });
  else if (i.googleReseller?.connected) items.push({ id: "google", label: "Google Reseller API connected", status: "done" });
  else {
    const code = i.googleReseller?.code;
    items.push({
      id: "google",
      label: "Google Reseller API",
      status: "todo",
      note: code === "api_disabled" ? "Enable the Reseller API in Google Cloud"
        : code === "needs_reauth" ? "Log in with your reseller-admin Google account"
        : "Optional · syncs subscriptions",
      href: INTEGRATIONS,
    });
  }

  // WhatsApp Business
  if (i.whatsapp === undefined) items.push({ id: "whatsapp", label: "WhatsApp Business", status: "checking" });
  else if (i.whatsapp === null) items.push({ id: "whatsapp", label: "WhatsApp Business", status: "unknown", note: "Check in Settings → Integrations", href: INTEGRATIONS });
  else if (i.whatsapp.configured) items.push({ id: "whatsapp", label: "WhatsApp Business connected", status: "done" });
  else items.push({ id: "whatsapp", label: "Connect WhatsApp Business", status: "todo", note: "Optional · send from the app", href: INTEGRATIONS });

  return items;
}

/** Next steps on the Done screen — each one opens the page that does it. */
export const NEXT_STEPS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Send your first quote",         href: "/quotes/new" },
  { label: "Check your renewals calendar",  href: "/renewals" },
  { label: "Set up reminder automations",   href: "/automation" },
  { label: "Invite your team",              href: "/team" },
  { label: "Connect WhatsApp and Razorpay", href: INTEGRATIONS },
];
