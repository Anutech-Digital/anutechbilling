/**
 * R-1461: what the public quote page still needs before "Generate quotation" can send.
 *
 * The old message always listed everything ("Add at least one line, and a company, name…"),
 * so a visitor who had picked items but not filled contact details was told to add a line
 * (Pawan, staging AI Help, 16 Oct 2026). This returns only the parts that are actually
 * missing or invalid, in the order they appear on the page, so the message and the focus
 * both land on the right thing.
 */

export type QuoteForm = { lineCount: number; company: string; name: string; phone: string; email: string; gstin: string };
export type QuoteMissingKey = "lines" | "company" | "name" | "phone" | "email" | "gstin";
export type QuoteMissingPart = { key: QuoteMissingKey; label: string };

/** A 10-digit Indian mobile (6–9 first), with or without +91 / 0 in front (R-231). */
export function isIndianMobile(v: string): boolean {
  const d = v.replace(/\D/g, "").replace(/^(?:91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(d);
}

/** Missing or invalid parts, in on-screen order: step 1 (lines), then the contact fields. */
export function quoteMissing(f: QuoteForm): QuoteMissingPart[] {
  const out: QuoteMissingPart[] = [];
  if (f.lineCount <= 0) out.push({ key: "lines", label: "at least one line" });
  if (f.company.trim().length < 2) out.push({ key: "company", label: "company" });
  if (f.name.trim().length < 2) out.push({ key: "name", label: "your name" });
  if (!isIndianMobile(f.phone)) out.push({ key: "phone", label: "10-digit mobile" });
  if (!f.email.includes("@")) out.push({ key: "email", label: "email" });
  if (f.gstin !== "" && f.gstin.length !== 15) out.push({ key: "gstin", label: "15-character GSTIN (or leave it empty)" });
  return out;
}

/** "Still needed: company, your name and email." — empty string when nothing is missing. */
export function quoteMissingMessage(parts: QuoteMissingPart[]): string {
  if (parts.length === 0) return "";
  const labels = parts.map((p) => p.label);
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `Still needed: ${list}.`;
}
