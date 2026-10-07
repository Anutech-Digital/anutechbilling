/**
 * S31 — the "can this workspace bill yet?" facts behind the Dashboard setup card.
 *
 * A brand-new workspace could save its company name and then hit a wall on the first quote:
 * no invoice code, no bank/UPI on the invoice, no sending email, nobody else invited. Each of
 * those lived on a different screen and nothing said which were missing. This module turns
 * REAL saved data into done / not-done — never a manual tick, never the wizard's
 * `setup_completed_at` stamp (which is set even when GSTIN is skipped).
 *
 * Pure on purpose: the card renders it, the tests pin it, and there is one definition of
 * "set up" rather than one per screen.
 *
 * Probe convention (same as setup/done-checklist.ts):
 *   undefined → still loading  → the card waits rather than flash every row open
 *   null      → the read failed → row stays open with "Could not check", never a guess
 */
import { isValidGstin } from "@/lib/utils";
import { isValidVpa } from "@/lib/payments/upi";
import { SETUP_HREF } from "@/lib/onboarding/setup-links";

export interface InvoiceCodeProbe {
  /** tenants.doc_code as saved by the owner; null when never chosen. */
  saved: string | null;
  /** True once a GST number has been issued — the series is running, whatever the code. */
  locked: boolean;
}

export interface EmailProbe {
  provider?: string | null;
  fromAddress?: string | null;
  hasResendKey?: boolean;
  canSendNow?: boolean;
}

export interface SetupFacts {
  address: string | null | undefined;
  stateCode: string | null | undefined;
  gstin: string | null | undefined;
  upiVpa: string | null | undefined;
  remitAccountNumber: string | null | undefined;
  remitIfsc: string | null | undefined;
  invoiceCode: InvoiceCodeProbe | null | undefined;
  email: EmailProbe | null | undefined;
  /** Active logins in this workspace, the owner included. */
  memberCount: number | null | undefined;
  /** Invites sent and not yet accepted (owner-only read; null when the role cannot read it). */
  pendingInvites: number | null | undefined;
}

export interface SetupStep {
  id: "org" | "gst" | "series" | "payout" | "email" | "team";
  label: string;
  hint: string;
  href: string;
  cta: string;
  done: boolean;
}

const has = (v: string | null | undefined) => typeof v === "string" && v.trim().length > 0;
const COULD_NOT_CHECK = "Could not check. Open settings to see.";

/** Address + state are what print on every document and decide IGST vs CGST+SGST. */
export function companyDone(f: Pick<SetupFacts, "address" | "stateCode">): boolean {
  return has(f.address) && has(f.stateCode);
}

/** Format AND checksum — the same rule Settings → Company uses. */
export function gstDone(gstin: string | null | undefined): boolean {
  return isValidGstin((gstin ?? "").trim());
}

/**
 * The series is set when the owner chose a code, or numbers are already being issued.
 * Without a saved code the database prints 4 letters of the tenant id (INV-FBB9-…).
 */
export function seriesDone(p: InvoiceCodeProbe | null | undefined): boolean {
  if (!p) return false;
  return has(p.saved) || p.locked;
}

/** A customer can pay: a UPI ID that passes the invoice-QR check, or a bank account + IFSC. */
export function payoutDone(f: Pick<SetupFacts, "upiVpa" | "remitAccountNumber" | "remitIfsc">): boolean {
  const vpa = (f.upiVpa ?? "").trim();
  if (vpa && isValidVpa(vpa)) return true;
  return has(f.remitAccountNumber) && has(f.remitIfsc);
}

/**
 * Mail actually leaves, AND it leaves as this business. The deployment-wide Resend key makes
 * `canSendNow` true for every tenant, so on its own it would tick this row for a workspace that
 * never opened the email settings and whose quotes go out under a platform address.
 */
export function emailDone(p: EmailProbe | null | undefined): boolean {
  if (!p || !p.canSendNow) return false;
  return p.provider === "gmail" || Boolean(p.hasResendKey) || has(p.fromAddress);
}

/** Someone besides the owner has a login, or has been invited. */
export function teamDone(memberCount: number | null | undefined, pendingInvites: number | null | undefined): boolean {
  return (memberCount ?? 0) > 1 || (pendingInvites ?? 0) > 0;
}

/** True while any probe is still loading — the card renders nothing until then. */
export function setupLoading(f: SetupFacts): boolean {
  return f.invoiceCode === undefined || f.email === undefined || f.memberCount === undefined || f.pendingInvites === undefined;
}

/** The six "before you can bill" steps, in the order they are best done. */
export function buildSetupSteps(f: SetupFacts): SetupStep[] {
  return [
    {
      id: "org", label: "Add company address", cta: "Add address", href: SETUP_HREF.company,
      hint: "Address and state print on every invoice.",
      done: companyDone(f),
    },
    {
      id: "gst", label: "Add your GSTIN", cta: "Add GSTIN", href: SETUP_HREF.company,
      hint: "Without it an invoice cannot be a valid tax invoice.",
      done: gstDone(f.gstin),
    },
    {
      id: "series", label: "Set invoice numbering", cta: "Set code", href: SETUP_HREF.series,
      hint: f.invoiceCode === null ? COULD_NOT_CHECK : "Pick a 2–4 letter code for your invoice numbers.",
      done: seriesDone(f.invoiceCode),
    },
    {
      id: "payout", label: "Add bank or UPI", cta: "Add details", href: SETUP_HREF.payout,
      hint: "Printed on every invoice so customers can pay you.",
      done: payoutDone(f),
    },
    {
      id: "email", label: "Set up sending email", cta: "Set up email", href: SETUP_HREF.email,
      hint: f.email === null ? COULD_NOT_CHECK : "Quotes and invoices go out from your address.",
      done: emailDone(f.email),
    },
    {
      id: "team", label: "Invite your team", cta: "Invite", href: SETUP_HREF.team,
      hint: f.memberCount === null ? COULD_NOT_CHECK : "Add at least one teammate.",
      done: teamDone(f.memberCount, f.pendingInvites),
    },
  ];
}
