/**
 * R-2095 (30 Oct 2026, September reconcile): which Income-tax section a customer's TDS deduction is
 * booked under. Before, the reconcile drawer stored 194J for every shortfall. The usual cases for
 * licences / services we sell:
 *   1%  → 194C, a contractor payment by an individual / HUF;
 *   2%  → 194C, a contractor payment by a company / firm (194J technical services is also 2% — the
 *         user can switch);
 *   10% → 194J, professional / technical fees.
 * The payer's type is the 4th letter of its PAN (characters 3–12 of a GSTIN). A guess, shown with its
 * reason; the Form 16A the customer issues decides.
 */
export type PanType = "company" | "individual" | "huf" | "firm" | "other";

export const TDS_SECTION_CHOICES = [
  { value: "194C", label: "194C — contract work" },
  { value: "194J", label: "194J — professional / technical fees" },
  { value: "194Q", label: "194Q — purchase of goods" },
  { value: "194H", label: "194H — commission" },
] as const;

export type TdsSection = (typeof TDS_SECTION_CHOICES)[number]["value"];

/** The payer's PAN type from its GSTIN (PAN = characters 3–12; the 4th PAN letter is the holder type). */
export function payerPanType(gstin: string | null | undefined): PanType | null {
  const g = (gstin ?? "").trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(g)) return null;
  switch (g[5]) {
    case "C": return "company";
    case "P": return "individual";
    case "H": return "huf";
    case "F": return "firm";
    default:  return "other";
  }
}

export function tdsSectionGuess(ratePct: number | null, payerGstin: string | null | undefined): { section: TdsSection; reason: string } {
  const pan = payerPanType(payerGstin);
  if (ratePct === 10) return { section: "194J", reason: "10% is the rate for professional / technical fees (194J)." };
  if (ratePct === 1) {
    return { section: "194C", reason: `1% is a contractor payment by an individual or HUF (194C)${pan === "company" ? " — but this customer's PAN is a company's; check its Form 16A" : ""}.` };
  }
  if (ratePct === 2) {
    return { section: "194C", reason: `2% is a contractor payment by a company or firm (194C)${pan === "individual" || pan === "huf" ? " — this customer's PAN is an individual's; check its Form 16A" : ""}. Technical services under 194J are also 2% — switch if the Form 16A says so.` };
  }
  return { section: "194J", reason: "The rate does not say which section — check the customer's Form 16A." };
}
