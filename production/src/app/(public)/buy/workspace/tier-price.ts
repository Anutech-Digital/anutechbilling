/**
 * R-276 (6 Oct 2026): the Buy-now dialog read the catalogue row as-is, so a stale row
 * (Starter ₹136, Standard ₹736) showed ₹19,258 for 10 Starter users while the server
 * (R-206, api/public/checkout/workspace/pricing.ts) charged the list price, ₹38,232. Shown must
 * equal charged: the dialog now goes through the SAME R-205 floor, keyed on the tier (as the
 * server is), and adds GST the same way. No price lives here — the list prices stay in
 * lib/pricing/workspace.ts. The flexible (monthly) rate is not touched.
 */
import { floorWorkspacePrice } from "@/lib/catalog/workspace-floor";

const TIER_NAME: Record<string, string> = {
  starter:  "Google Workspace Business Starter",
  standard: "Google Workspace Business Standard",
  plus:     "Google Workspace Business Plus",
};

/** ₹/seat/month on the annual plan for this tier: the catalogue price, never below list. */
export function tierAnnualPrice(slug: string, catalogPrice: number): number {
  const name = TIER_NAME[slug];
  return name ? floorWorkspacePrice(name, catalogPrice) : catalogPrice;
}

/** Pre-GST subtotal, GST and total for `seats` on the annual plan — the server's sum. */
export function annualTotals(seats: number, monthlyRate: number): { annual: number; gst: number; total: number } {
  const annual = seats * monthlyRate * 12;
  const gst = Math.round(annual * 0.18);
  return { annual, gst, total: annual + gst };
}
