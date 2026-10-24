/**
 * S31 — where each new-workspace setup step is finished. One table, used by the Dashboard
 * setup card AND by the errors that used to dead-end ("Could not allocate a quote number"),
 * so both send the user to the same screen and the same spot on it.
 *
 * The `#…` part scrolls Settings to the card; the ids are set in app/(app)/settings/page.tsx.
 */
export const SETUP_HREF = {
  company: "/settings?tab=company",
  /** R-1428: the Registered state select itself (id in settings/page.tsx CompanyTab). */
  companyState: "/settings?tab=company#settings-registered-state",
  series:  "/settings?tab=company#invoice-numbering",
  payout:  "/settings?tab=company#payment-details",
  email:   "/settings?tab=integrations#email-sending",
  /** R-1451: the Integrations tab (Razorpay, WhatsApp, Google reseller cards) — Dashboard Health card. */
  integrations: "/settings?tab=integrations",
  team:    "/team",
  /** The checklist itself lives on the Dashboard. */
  checklist: "/dashboard#setup-checklist",
} as const;

/**
 * The "go fix it" button for a failed document-number allocation. A failed
 * next_document_number() is almost always a workspace whose numbering was never set up;
 * the toast must open that screen in one click rather than say "under Settings".
 */
export const NUMBERING_FIX = {
  label: "Set up numbering",
  href: SETUP_HREF.series,
  description: "Nothing was saved and no number was used. Check your invoice numbering, then try again.",
} as const;

/**
 * R-431 (board R-406): the "go fix it" button when the company's own state is empty.
 * Without it GST cannot choose CGST+SGST vs IGST, so quotes may not be sent and
 * generate_invoice refuses ("your own company has no state on record").
 */
export const COMPANY_STATE_FIX = {
  label: "Set company state",
  href: SETUP_HREF.company,
  message: "Your company's state is not set",
  description: "GST needs it to choose CGST + SGST or IGST. Set it once in Settings → Company — nothing on this quote is lost.",
} as const;

export type CompanyStateFix = {
  title: string;
  description: string;
  action: { label: string; href: string };
};

/**
 * R-1428 (Pawan, staging): sending a quote (WhatsApp / email) stopped at "Company state not
 * set" — the refusal is right (GST place of supply needs it), the dead end was not. Only the
 * owner can save Settings → Company; anyone else sees it view-only, so they get "ask the
 * owner" and a link to look, never a "Set" button that cannot set anything.
 */
export function companyStateFixFor(role: string | null | undefined): CompanyStateFix {
  const why = "The quote was not sent — nothing on it is lost. GST place of supply needs your company's state to choose CGST + SGST or IGST.";
  if (role === "owner") {
    return {
      title: COMPANY_STATE_FIX.message,
      description: `${why} Set it once in Settings → Company, then send again.`,
      action: { label: COMPANY_STATE_FIX.label, href: SETUP_HREF.companyState },
    };
  }
  return {
    title: COMPANY_STATE_FIX.message,
    description: `${why} Only the owner can set it — ask the owner to set the company state in Settings → Company, then send again.`,
    action: { label: "View company settings", href: SETUP_HREF.company },
  };
}

/** True when a thrown error is generate_invoice refusing for a missing company state. */
export function isCompanyStateMissingError(err: unknown): boolean {
  const m = err && typeof err === "object" ? (err as { message?: unknown }).message : err;
  return typeof m === "string" && /own company has no state on record/i.test(m);
}

/**
 * R-1643: the "go fix it" button when generate_invoice / create_direct_invoice refuse because
 * the company's own GSTIN or address is not on record (a Tax Invoice must show both — CGST
 * Rule 46; a Bill of Supply its address — Rule 49). Migration
 * 20261023192418_r1643_tax_invoice_needs_supplier_gstin, supplier_invoice_problem().
 */
export const COMPANY_GSTIN_FIX = {
  label: "Add GSTIN and address",
  href: SETUP_HREF.company,
} as const;

/** True when a thrown error is that refusal (the SQL message's own fix sentence). */
export function isCompanyGstinMissingError(err: unknown): boolean {
  const m = err && typeof err === "object" ? (err as { message?: unknown }).message : err;
  return typeof m === "string" && /Add your company's (GSTIN and address|address) in Settings → Company first/i.test(m);
}

/** The one-click fix for an invoice the database refused for a company-settings gap, or null. */
export function invoiceIssueFix(err: unknown): { label: string; href: string } | null {
  if (isCompanyGstinMissingError(err)) return { label: COMPANY_GSTIN_FIX.label, href: COMPANY_GSTIN_FIX.href };
  if (isCompanyStateMissingError(err)) return { label: COMPANY_STATE_FIX.label, href: COMPANY_STATE_FIX.href };
  return null;
}
