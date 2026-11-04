/**
 * R-2425 — a foreign inward remittance on a bank line ("INW … USD1024.0@93.6") shown as what the
 * bank converted: "$1,024 @ ₹93.60". Nothing for an ordinary rupee line.
 */
import { formatRemittance, parseInwardRemittance } from "@/lib/banking/inward-remittance";

export function RemittanceText({ description }: { description: string | null }) {
  const r = parseInwardRemittance(description);
  if (!r) return null;
  return <span className="block text-xs font-normal text-ink-2 tabular-nums mt-0.5">{formatRemittance(r)}</span>;
}
