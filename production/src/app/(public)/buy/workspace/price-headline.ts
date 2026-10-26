/**
 * R-1965 (Pardeep, 26 Oct 2026): how the /buy/workspace calculator words its price. The big
 * number is the pre-GST yearly total; the rate × users × 12 sum says how it is billed; GST and
 * the total sit on their own small line. Display only — the sums come in from annualTotals /
 * the page's promo maths and are only formatted here, so checkout's amount cannot drift.
 */
import { rupee } from "@/lib/utils";

export type HeadlineBilling = "annual" | "monthly";

export interface HeadlineInput {
  rate: number;            // ₹/user/month before GST
  seats: number;
  billing: HeadlineBilling;
  subtotal: number;        // pre-GST yearly total actually charged (after any promo)
  gst: number;
  total: number;           // subtotal + gst — what checkout charges
  wasSubtotal?: number;    // pre-GST yearly total before a site promo (shown struck)
}

const inr = (n: number) => rupee(n);

export function priceHeadline(i: HeadlineInput) {
  const users = `${i.seats} ${i.seats === 1 ? "user" : "users"}`;
  const annual = i.billing === "annual";
  const billed = annual ? "Billed annually (1-year commitment)" : "Billed monthly";
  /* R-1970: a monthly bill is ONE month — no "× 12", "/month + GST". Annual wording unchanged. */
  return {
    big: inr(i.subtotal),
    bigSuffix: annual ? "/year + GST" : "/month + GST",
    was: i.wasSubtotal != null && i.wasSubtotal > i.subtotal ? inr(i.wasSubtotal) : null,
    breakdown: `${inr(i.rate)}/user/month × ${users}${annual ? " × 12" : ""} · ${billed}`,
    /** R-1986: the sum written out, for the plan cards — "₹270/user/month × 10 users × 12 = ₹32,400/year + GST". */
    working: `${inr(i.rate)}/user/month × ${users}${annual ? " × 12" : ""} = ${inr(i.subtotal)}${annual ? "/year + GST" : "/month + GST"}`,
    gstLine: `+ ${inr(i.gst)} GST (18%) · Total ${inr(i.total)}`,
  };
}
