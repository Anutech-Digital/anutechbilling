/**
 * R-177: the stored payment method ("bank_transfer", "upi", "tds") shown as a word a person
 * reads — "Bank transfer", "UPI", "TDS". Display only; the stored value never changes.
 * R-1715 / R-1680: the ONE map — every screen, PDF and history line reads its method word here
 * ("BANK_TRANSFER" and "Bank_transfer" were shown raw on the quote and invoice pages).
 */
const METHOD_LABEL: Record<string, string> = {
  upi: "UPI",
  razorpay: "Razorpay",
  bank_transfer: "Bank transfer",
  neft: "NEFT",
  rtgs: "RTGS",
  imps: "IMPS",
  cheque: "Cheque",
  cash: "Cash",
  card: "Card",
  tds: "TDS",
  other: "Other",
};

export function paymentMethodLabel(method: string | null | undefined): string {
  const m = (method ?? "").trim();
  if (!m) return "—";
  const known = METHOD_LABEL[m.toLowerCase()];
  if (known) return known;
  const words = m.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
