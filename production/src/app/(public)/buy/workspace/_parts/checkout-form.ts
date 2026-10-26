/**
 * R-1971 (26 Oct 2026, design v2): the inline checkout's rules, as pure functions — what each
 * step needs before it can close, the GST split the summary and the invoice preview show, and
 * the body sent to the server. The server re-checks all of it and prices the order itself.
 */
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { GST_STATE_BY_CODE } from "@/lib/utils";
import { gstinProblem } from "@/site/lib/checkout-details";
import type { Billing, BuyPlan } from "./plans";

export type DomainMode = "existing" | "new";
export const NEW_DOMAIN_TLDS = [".in", ".com", ".co.in"] as const;
export type NewDomainTld = (typeof NEW_DOMAIN_TLDS)[number];

/** R-1977: the new domain the buyer chose from the live search — its price is for SHOWING only;
 *  the server prices it again from the registry and never reads this number. */
export interface PickedDomain { domain: string; price: number; testPrice: boolean }
export interface DomainChoice { mode: DomainMode; domain: string; newName: string; tld: NewDomainTld; picked: PickedDomain | null }
export interface BuyerDetails {
  name: string; company: string; email: string; phone: string; gstin: string; stateCode: string;
  /** R-1977: the domain owner's postal address — asked only when a new domain is bought. */
  addressLine1: string; city: string; pinCode: string;
}
export type CheckoutMode = "pay" | "trial" | "quote";
export type PayMethod = "upi" | "card" | "netbanking";

export const EMPTY_DOMAIN: DomainChoice = { mode: "existing", domain: "", newName: "", tld: ".in", picked: null };
export const EMPTY_BUYER: BuyerDetails = { name: "", company: "", email: "", phone: "", gstin: "", stateCode: "", addressLine1: "", city: "", pinCode: "" };

export const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** States and UTs a buyer can live in, A → Z (97/99 are not places of supply for a buyer). */
export const STATE_OPTIONS: ReadonlyArray<{ code: string; name: string }> = Object.entries(GST_STATE_BY_CODE as Record<string, string>)
  .filter(([code]) => Number(code) < 97)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function cleanDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/** The domain the order is for: theirs, or the new name + ending they asked us to register. */
export function domainValue(d: DomainChoice): string {
  if (d.mode === "existing") return cleanDomain(d.domain);
  if (d.picked) return d.picked.domain;
  const name = newDomainName(d);
  return name ? `${name}${d.tld}` : "";
}

/** The label typed for a new domain, cut to what a domain label may hold. */
export function newDomainName(d: Pick<DomainChoice, "newName">): string {
  return d.newName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/**
 * R-1977: `needPick` — the order buys the new domain (pay mode, annual), so step 1 closes only
 * with a domain picked from the live search: a name nobody checked is never charged for.
 */
export function domainErrors(d: DomainChoice, needPick = false): Partial<Record<"domain" | "newName", string>> {
  if (d.mode === "existing") return DOMAIN_RE.test(cleanDomain(d.domain)) ? {} : { domain: "Enter a domain like yourcompany.in" };
  if (newDomainName(d).length < 2) return { newName: "Enter the name you want — at least 2 letters or numbers" };
  if (needPick && !d.picked) return { newName: "Press Check, then choose an available domain" };
  return {};
}

/** R-1977: the pre-GST price the order adds for the new domain (annual pay orders only), else 0. */
export function domainCharge(d: DomainChoice, billing: Billing, mode: CheckoutMode, canBuy = true): number {
  return canBuy && d.mode === "new" && d.picked && billing === "annual" && mode === "pay" ? d.picked.price : 0;
}

export type BuyerField = keyof BuyerDetails;

export function buyerErrors(f: BuyerDetails, needAddress = false): Partial<Record<BuyerField, string>> {
  const e: Partial<Record<BuyerField, string>> = {};
  /* R-1977: the domain registry records the owner's postal address (owner decision 22). */
  if (needAddress) {
    if (f.addressLine1.trim().length < 3) e.addressLine1 = "Enter your address — the domain is registered to it";
    if (f.city.trim().length < 2) e.city = "Enter your city";
    if (!/^\d{6}$/.test(f.pinCode.replace(/\s+/g, ""))) e.pinCode = "Enter your 6-digit PIN code";
  }
  if (f.name.trim().length < 2) e.name = "Enter your name";
  /* R-232: company is optional (a sole proprietor has none) — but not one letter. */
  if (f.company.trim().length === 1) e.company = "Company name — or leave it blank";
  if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) e.email = "Enter a valid email";
  if (f.phone.replace(/\D/g, "").length < 10) e.phone = "Enter a 10-digit mobile number";
  const g = gstinProblem(f.gstin);
  if (g) e.gstin = g;
  if (!f.stateCode && !stateCodeFromGstin(f.gstin)) e.stateCode = "Select your state — it decides the GST split";
  return e;
}

/** A valid GSTIN carries the state (its first two digits) — R-173. */
export function stateFromGstin(gstin: string): string | null {
  return gstinProblem(gstin) ? null : stateCodeFromGstin(gstin) ?? null;
}

export function buyerStateCode(f: BuyerDetails): string | null {
  return f.stateCode || stateFromGstin(f.gstin) || null;
}

/** The name the order and GST invoice carry: the company, or the buyer when it is blank (R-232). */
export function orderCompany(f: BuyerDetails): string {
  return f.company.trim() || f.name.trim();
}

export interface GstLine { label: string; amount: number }

/**
 * GST 18% as the invoice will split it: CGST 9% + SGST 9% when the buyer is in the seller's
 * state, IGST 18% otherwise; a neutral "GST 18%" until the buyer's state is known.
 */
export function gstLines(gst: number, buyerState: string | null, sellerState: string | null): GstLine[] {
  if (!buyerState || !sellerState) return [{ label: "GST 18%", amount: gst }];
  if (buyerState !== sellerState) return [{ label: "IGST 18%", amount: gst }];
  const cgst = Math.round(gst / 2);
  return [{ label: "CGST 9%", amount: cgst }, { label: "SGST 9%", amount: gst - cgst }];
}

/**
 * Discounts stack as the server does: site promo, then coupon, both before GST; GST on the rest.
 * R-1977: `domain` (the new domain's price) is added AFTER both — never discounted — and GST is
 * on the whole taxable value, as the route computes it.
 */
export function orderTotals(subtotal: number, promoOff: number, couponOff: number, domain = 0) {
  const afterPromo = Math.max(0, subtotal - Math.min(promoOff, subtotal));
  const coupon = Math.min(couponOff, afterPromo);
  const taxable = afterPromo - coupon + domain;
  const gst = Math.round(taxable * 0.18);
  return { afterPromo, coupon, domain, taxable, gst, total: taxable + gst };
}

/** What the checkout route gets. Only choices — the server reads every rate from the catalogue. */
export function checkoutBody(o: {
  plan: BuyPlan; seats: number; billing: Billing; domain: DomainChoice; buyer: BuyerDetails;
  couponCode: string | null; simulate: boolean;
}) {
  return {
    fullName: o.buyer.name.trim(),
    companyName: orderCompany(o.buyer),
    email: o.buyer.email.trim(),
    phone: o.buyer.phone.trim(),
    seats: o.seats,
    domain: domainValue(o.domain),
    domainNew: o.domain.mode === "new" || undefined,
    tierId: o.plan.id,
    gstin: o.buyer.gstin.trim() || undefined,
    stateCode: buyerStateCode(o.buyer) ?? undefined,
    couponCode: o.couponCode ?? undefined,
    simulate: o.simulate,
    commitment: o.billing,
    agreeTerms: true,
    /* R-1977: the owner's address for the registry — never a price (the server prices it). */
    ...(o.domain.mode === "new" && o.billing === "annual"
      ? { addressLine1: o.buyer.addressLine1.trim(), city: o.buyer.city.trim(), pinCode: o.buyer.pinCode.replace(/\s+/g, "") }
      : {}),
  };
}
