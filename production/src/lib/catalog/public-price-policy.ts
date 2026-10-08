/**
 * R-328 (7 Oct 2026, Pardeep): Google Workspace Business Plus has NO price on the public
 * website — Google's own pricing page does not show one either. The visitor sees
 * "Contact us for pricing" with Get a quote / WhatsApp, and the public checkout refuses Plus.
 *
 * Scope: ONLY what a visitor can reach — the company website (src/site, (marketing),
 * (public), (lp)), the anonymous catalogue endpoint the website reads, the public sales
 * chat and the public checkout. Inside the app (quote builder, catalogue, invoices) the
 * Plus price stays exactly as it is; a quotation emailed to a customer who asked for one
 * is the "Get a quote" answer and keeps its price too.
 *
 * One function decides it, so every public surface asks the same question and a new page
 * cannot quietly print the figure again (src/site/plus-price-hidden.test.ts scans for it).
 */
import { workspaceTierOf } from "./workspace-floor";

/** The words every public surface shows instead of a Plus price. */
export const CONTACT_FOR_PRICING = "Contact us for pricing";

/** Public checkout's answer when someone posts tierId "plus" (UI never offers it). */
export const PLUS_NOT_SOLD_ONLINE =
  "Google Workspace Business Plus is priced on request, not bought online. Nothing was charged. " +
  "Please use \"Get a quote\" or WhatsApp us and we will send the price for your team.";

/** Website edition name for Plus — what /quote?ed= and the trial page use. */
export const PLUS_EDITION = "GW Business Plus";

/**
 * True when this product's price must not reach a website visitor. Accepts the app's
 * catalogue name ("Google Workspace Business Plus") and the website's ("GW Business Plus").
 * Add-ons and other "plus" names (hosting Plus, "Standard + Voice") are not Workspace Plus.
 */
export function isPublicPriceHidden(name: string | null | undefined): boolean {
  return workspaceTierOf(name) === "plus";
}

/** Same rule keyed by checkout tier id. */
export function isPublicPriceHiddenTier(tierId: string | null | undefined): boolean {
  return tierId === "plus";
}
