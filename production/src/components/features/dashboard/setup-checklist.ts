/**
 * R-1931 (G-ONBOARD OB-10) — the ONE onboarding list: "Get to your first quote".
 *
 * There used to be three overlapping lists: the /setup Done screen's status rows
 * (setup/done-checklist.ts), this file's six "before you bill" settings rows (address, GSTIN,
 * numbering, bank, email, team) and the Dashboard card's "first sale" rows (customer, catalogue,
 * quote, payment). None of them had the company's state, and none had the "Customer messages"
 * switch — the one thing that made a new company's first Send fail (audit OB-1). And the
 * "Add your first customer" row showed for a company with many customers.
 *
 * Now there is one list, in the order a new reseller gets to a quote link:
 *   1. State / GSTIN   2. Price list   3. First quote   4. Send link   5. Customer messages
 * then, after: Bank/UPI and Team. No customer step — the quote builder adds the customer.
 * The Dashboard card renders it and the /setup Done screen reuses the same rows.
 *
 * Every tick is judged from saved data or a real count — never the wizard's
 * `setup_completed_at` stamp, never a guess. Pure on purpose: one definition, pinned by tests.
 *
 * Probe convention:
 *   undefined → still loading  → the card waits rather than flash every row open
 *   null      → the read failed / this role cannot read it → row stays open, never a tick
 */
import { isValidGstin } from "@/lib/utils";
import { isValidVpa } from "@/lib/payments/upi";
import { SETUP_HREF } from "@/lib/onboarding/setup-links";
import { CUSTOMER_MESSAGES_SWITCH_HREF } from "@/lib/quotes/send-quote-email";
import type { AutomationState } from "@/lib/automation/jobs";
import type { GstRegistration } from "@/lib/compliance/gst-registration";
import { DEFAULT_SELL_MODE, type SellMode } from "@/lib/sell-mode";
import { firstProductStep } from "./sell-mode-dashboard";

export interface FirstQuoteFacts {
  address: string | null | undefined;
  stateCode: string | null | undefined;
  gstin: string | null | undefined;
  /** Settings → Company → GST registration (R-1529). null = never chosen / could not read. */
  gstRegistration: GstRegistration | null | undefined;
  /** Products in the catalogue (support rows left out — lib/items/catalog-state). */
  productCount: number | null | undefined;
  /** Quotes of any status. */
  quoteCount: number | null | undefined;
  /** Quotes that left draft (sent / viewed / accepted / rejected / expired). */
  sentQuoteCount: number | null | undefined;
  /** Newest draft quote — the "Send link" button opens it. */
  draftQuoteId: string | null | undefined;
  /** The "Customer messages" switch on /automation. */
  customerMessages: AutomationState | null | undefined;
  upiVpa: string | null | undefined;
  remitAccountNumber: string | null | undefined;
  remitIfsc: string | null | undefined;
  /** Active logins in this workspace, the owner included. */
  memberCount: number | null | undefined;
  /** Invites sent and not yet accepted (owner-only read). */
  pendingInvites: number | null | undefined;
}

export type FirstQuoteStepId = "company" | "catalog" | "quote" | "send" | "messages" | "payout" | "team";

export interface FirstQuoteStep {
  id: FirstQuoteStepId;
  /** "first" = the 5 steps to the first quote link; "after" = Bank/UPI and Team. */
  group: "first" | "after";
  label: string;
  hint: string;
  href: string;
  cta: string;
  done: boolean;
  /** Only the owner can do it (company save, the messages switch, invites are owner-only). */
  ownerOnly: boolean;
}

const has = (v: string | null | undefined) => typeof v === "string" && v.trim().length > 0;
const COULD_NOT_CHECK = "Could not check. Open it to see.";
const positive = (n: number | null | undefined) => typeof n === "number" && n > 0;

/** Address + state are what print on every document and decide IGST vs CGST+SGST. */
export function companyDone(f: Pick<FirstQuoteFacts, "address" | "stateCode">): boolean {
  return has(f.address) && has(f.stateCode);
}

/** Format AND checksum — the same rule Settings → Company uses. */
export function gstDone(gstin: string | null | undefined): boolean {
  return isValidGstin((gstin ?? "").trim());
}

/** A customer can pay: a UPI ID that passes the invoice-QR check, or a bank account + IFSC. */
export function payoutDone(f: Pick<FirstQuoteFacts, "upiVpa" | "remitAccountNumber" | "remitIfsc">): boolean {
  const vpa = (f.upiVpa ?? "").trim();
  if (vpa && isValidVpa(vpa)) return true;
  return has(f.remitAccountNumber) && has(f.remitIfsc);
}

/** Someone besides the owner has a login, or has been invited. */
export function teamDone(memberCount: number | null | undefined, pendingInvites: number | null | undefined): boolean {
  return (memberCount ?? 0) > 1 || (pendingInvites ?? 0) > 0;
}

/** True while any fact is still loading — the card renders nothing until then. */
export function firstQuoteLoading(f: FirstQuoteFacts): boolean {
  return [
    f.gstRegistration, f.productCount, f.quoteCount, f.sentQuoteCount,
    f.customerMessages, f.memberCount, f.pendingInvites,
  ].some((v) => v === undefined);
}

/**
 * State + address + (a valid GSTIN, or "Not registered" saved — a Bill of Supply needs none).
 * The hint names what is still missing, so the button's page is not a guess.
 */
function companyStep(f: FirstQuoteFacts): FirstQuoteStep {
  const gstOk = gstDone(f.gstin) || f.gstRegistration === "unregistered";
  const missing = [
    !has(f.stateCode) && "state",
    !gstOk && "GSTIN",
    !has(f.address) && "address",
  ].filter((m): m is string => typeof m === "string");
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}` : missing[0];
  return {
    id: "company", group: "first", ownerOnly: true,
    label: "Set your state and GSTIN",
    cta: has(f.stateCode) ? "Add details" : "Set state",
    href: has(f.stateCode) ? SETUP_HREF.company : SETUP_HREF.companyState,
    hint: missing.length === 0
      ? "State, GSTIN and address print on every quote and invoice."
      : `Add your ${list}. The state decides IGST or CGST + SGST.`,
    done: missing.length === 0,
  };
}

/** The one list, in the order it is best done. */
export function buildFirstQuoteSteps(f: FirstQuoteFacts, sellMode: SellMode = DEFAULT_SELL_MODE): FirstQuoteStep[] {
  const product = firstProductStep(sellMode);
  const messagesHint =
    f.customerMessages === null ? COULD_NOT_CHECK
    : f.customerMessages === "dry_run" ? "Practice run is on, so nothing reaches a customer yet."
    : "While it is off, no email or WhatsApp reaches a customer.";
  return [
    companyStep(f),
    {
      id: "catalog", group: "first", ownerOnly: false,
      label: product.label, cta: product.cta, href: product.href,
      hint: f.productCount === null ? COULD_NOT_CHECK : product.hint,
      done: positive(f.productCount),
    },
    {
      id: "quote", group: "first", ownerOnly: false,
      label: "Create your first quote", cta: "New quote", href: "/quotes/new",
      hint: f.quoteCount === null ? COULD_NOT_CHECK : "Pick products from your price list and add the customer.",
      done: positive(f.quoteCount),
    },
    {
      id: "send", group: "first", ownerOnly: false,
      label: "Send the quote link", cta: "Send link",
      href: f.draftQuoteId ? `/quotes/${f.draftQuoteId}` : "/quotes",
      hint: f.sentQuoteCount === null ? COULD_NOT_CHECK : "Copy the link, or send it on WhatsApp or email.",
      done: positive(f.sentQuoteCount),
    },
    {
      id: "messages", group: "first", ownerOnly: true,
      label: "Turn on customer messages", cta: "Turn on", href: CUSTOMER_MESSAGES_SWITCH_HREF,
      hint: messagesHint,
      done: f.customerMessages === "on",
    },
    {
      id: "payout", group: "after", ownerOnly: true,
      label: "Add bank or UPI", cta: "Add details", href: SETUP_HREF.payout,
      hint: "Printed on every invoice so customers can pay you.",
      done: payoutDone(f),
    },
    {
      id: "team", group: "after", ownerOnly: true,
      label: "Invite your team", cta: "Invite", href: SETUP_HREF.team,
      hint: f.memberCount === null ? COULD_NOT_CHECK : "Add at least one teammate.",
      done: teamDone(f.memberCount, f.pendingInvites),
    },
  ];
}
