/**
 * R-1744 (Pardeep, 22 Oct 2026): "if someone gives a GST PDF bill, AI should fill everything".
 *
 * Pure helpers the Add expense dialog uses AFTER the operator confirms the AI's read
 * ("Yes, fill it in"). The confirm step stays — these only decide WHAT gets filled:
 *   - each line's category (the line's own AI category, else the bill's overall one),
 *   - the short "What for?" note: vendor — main item — month,
 *   - "Paid already" + method, ONLY when the bill itself clearly says it was paid,
 *   - whether to SUGGEST reverse charge (foreign vendor, no GST) — never ticked for the user.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/* Company-type endings make the note long without saying anything ("Pvt Ltd", "LLC"). */
const COMPANY_SUFFIX = /[\s,]+(?:private\s+limited|pvt\.?\s*ltd\.?|p\.?\s*ltd\.?|limited|ltd\.?|llp|llc|inc\.?|pbc|corp(?:oration)?\.?|co\.?)$/i;

/** "Google Cloud India Pvt Ltd" → "Google Cloud India". Never returns an empty string for a non-empty name. */
export function shortVendorName(name: string | null | undefined): string {
  let n = (name ?? "").trim();
  for (let i = 0; i < 3; i++) {
    const next = n.replace(COMPANY_SUFFIX, "").trim();
    if (!next || next === n) break;
    n = next;
  }
  return n.replace(/[,.\s]+$/, "");
}

/**
 * The main thing on the bill, in a few words. The AI's own short name wins ("Workspace");
 * else the biggest line's text without its bracketed period, cut to three words.
 */
export function mainItemName(
  itemShort: string | null | undefined,
  items: readonly { description: string; amount: string | number }[],
): string {
  const s = (itemShort ?? "").trim();
  if (s) return s;
  const real = items.filter((i) => i.description.trim());
  if (!real.length) return "";
  const biggest = real.reduce((a, b) => (Math.abs(Number(b.amount) || 0) > Math.abs(Number(a.amount) || 0) ? b : a));
  const text = biggest.description.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  return text.split(" ").slice(0, 3).join(" ");
}

/** "2026-10-05" → "Oct 2026"; anything else → "". */
export function billMonth(date: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec((date ?? "").trim());
  if (!m) return "";
  const mi = Number(m[2]) - 1;
  return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${m[1]}` : "";
}

/** The short "What for?" note: "Google Cloud India — Workspace — Oct 2026" (empty parts left out). */
export function buildExpenseNote(o: {
  vendorName?: string | null;
  itemShort?: string | null;
  items: readonly { description: string; amount: string | number }[];
  billDate?: string | null;
}): string {
  return [shortVendorName(o.vendorName), mainItemName(o.itemShort, o.items), billMonth(o.billDate)]
    .filter(Boolean)
    .join(" — ");
}

/** A line's category: its own AI category, else the bill's overall AI category, else blank (operator picks). */
export function lineCategoryFromBill(lineCategory: string | null | undefined, billCategory: string | null | undefined): string {
  return (lineCategory ?? "").trim() || (billCategory ?? "").trim() || "";
}

/**
 * "Paid already" from the bill — only when the bill clearly says PAID. Returns null otherwise,
 * and the form keeps whatever it had (an unpaid-looking bill does not flip anything either:
 * the operator knows better than a missing stamp). The method is one of the form's own
 * methods, or null (then the form's method stays).
 */
export function paidFromBill(
  paidStatus: string | null | undefined,
  paymentMode: string | null | undefined,
  methods: readonly string[],
): { method: string | null } | null {
  if ((paidStatus ?? "").trim().toLowerCase() !== "paid") return null;
  const m = (paymentMode ?? "").trim().toLowerCase();
  return { method: m && methods.includes(m) ? m : null };
}

/** Suggest reverse charge (a chip, never a tick) when the bill is foreign and carries no GST. */
export function rcmSuggested(currency: string | null | undefined, gst: number | null | undefined): boolean {
  const c = (currency ?? "INR").trim().toUpperCase() || "INR";
  return c !== "INR" && !(Number(gst) > 0);
}
