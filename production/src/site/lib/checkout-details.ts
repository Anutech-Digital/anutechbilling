/**
 * What the checkout form still needs before it can go on — as words a buyer can act on.
 *
 * Until 29 Sep 2026 the buttons were simply disabled while anything was missing, and a
 * disabled .btn-primary looks exactly like an enabled one. The owner pressed "Start my
 * 15-day free trial" with the (then required) company name blank and nothing happened, with
 * nothing on screen to say why. Now the button always responds: if something is missing it
 * says exactly what (AGENTS.md §7: what happened, why, what to do next).
 *
 * The company name is optional (owner, same day); the server uses the buyer's own name.
 * A hosting domain is required for paid hosting AND for the free trial (owner, 30 Sep
 * 2026), and it must be a real domain name — the same rule as the server
 * (lib/checkout/hosting-domain.ts).
 * These rules must stay in step with `cartSchema` in lib/checkout/cart-checkout.ts.
 */
import { planDomains, type PlanDomainInput } from "@/lib/checkout/hosting-domain";
import { isValidGstin } from "@/lib/utils";

/**
 * R-227 (6 Oct 2026): the server drops a GSTIN that fails isValidGstin (cart-checkout.ts)
 * without a word, so the invoice goes out B2C and the buyer loses the input tax credit.
 * The form now says so before the order exists: fix it, or leave it blank.
 */
export const GSTIN_INVALID_MSG = "This GSTIN doesn't look valid — fix it or leave it blank";

/** What the buyer typed, as a GSTIN is written: capitals, no spaces, 15 characters at most. */
export function normalizeGstinInput(v: string): string {
  return v.replace(/\s+/g, "").toUpperCase().slice(0, 15);
}

/** Null when the GSTIN is blank (it is optional) or passes the full checksum; else the message. */
export function gstinProblem(gstin: string | null | undefined): string | null {
  const g = (gstin ?? "").replace(/\s+/g, "").toUpperCase();
  if (!g) return null;
  return isValidGstin(g) ? null : GSTIN_INVALID_MSG;
}

export interface CheckoutDetails {
  name: string;
  email: string;
  phone: string;
  domain: string;
  /** Paid hosting or a hosting trial is in the cart, so a domain is needed. */
  hasHosting: boolean;
  /**
   * With more than one hosting plan: each plan and the domain typed for it, in cart order
   * (30 Sep 2026, one domain per plan). Left out, the single `domain` above is the one plan's.
   */
  plans?: PlanDomainInput[];
  /**
   * A paid order needs the buyer's state (R-091, 1 Oct 2026): GST decides CGST+SGST or IGST
   * from it, and generate_invoice refuses an invoice without it. A free trial alone does not.
   */
  needsState?: boolean;
  /** The GST state code chosen ("07"), or "" when none. */
  stateCode?: string;
  /** Optional GSTIN (R-227): blank is fine, a typed one must pass the checksum. */
  gstin?: string;
  hasDomain: boolean;
  address: { line1: string; city: string; state: string; pin: string };
}

export function missingCheckoutDetails(d: CheckoutDetails): string[] {
  const missing: string[] = [];
  if (d.name.trim().length < 2) missing.push("your name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) missing.push("a valid email address");
  if (d.phone.replace(/\D/g, "").length < 10) missing.push("your mobile number (10 digits)");
  if (d.hasHosting) {
    // The same rule the server applies (planDomains): a real domain for every plan, none shared.
    const r = planDomains(d.plans && d.plans.length ? d.plans : [{ label: "hosting", typed: d.domain }]);
    if (!r.ok) missing.push(...r.problems);
  }
  if (d.needsState && !/^\d{2}$/.test((d.stateCode ?? "").trim())) {
    missing.push("your state (it decides the GST on your invoice)");
  }
  if (gstinProblem(d.gstin)) missing.push("a valid GSTIN (or leave it blank)");
  if (d.hasDomain) {
    // The state is its own field now (R-091) and is checked above.
    const a = d.address;
    if (a.line1.trim().length < 3 || a.city.trim().length < 2 || !/^\d{6}$/.test(a.pin.trim())) {
      missing.push("the domain owner's postal address (address, city and a 6-digit PIN code)");
    }
  }
  return missing;
}

/** "Please add your name and your mobile number (10 digits) to continue." */
export function missingDetailsMessage(missing: string[]): string | null {
  if (missing.length === 0) return null;
  const list = missing.length === 1
    ? missing[0]
    : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `Please add ${list} to continue.`;
}
