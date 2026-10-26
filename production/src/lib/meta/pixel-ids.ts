/**
 * R-1979: Meta ids shared by the browser pixel and the server — no node modules here, so the
 * browser bundle can import it (the hashing is in pixel.ts, server only).
 */
export type MetaEventName = "PageView" | "ViewContent" | "InitiateCheckout" | "AddPaymentInfo" | "Purchase";

/** A Meta Pixel id: digits only (Meta issues 15–16; accept 10–20 so a new length is not refused). */
export function cleanPixelId(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  return /^\d{10,20}$/.test(s) ? s : null;
}

/** The event_id the browser AND the server use for one purchase — Meta dedups on it. */
export function purchaseEventId(quoteId: string): string {
  return `purchase-${quoteId}`;
}

/** The plan id Meta sees as content_ids, from the quote's plan label ("google-workspace-standard"). */
export function contentIdForPlan(plan: string | null | undefined): string[] {
  const m = /^google-workspace-(starter|standard|plus|enterprise)$/.exec(String(plan ?? ""));
  return m ? [`google-workspace-${m[1]}`] : plan ? [String(plan)] : [];
}
