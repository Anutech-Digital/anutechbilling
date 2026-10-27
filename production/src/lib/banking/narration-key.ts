/**
 * R-1919 — the "narration key" of a bank line: the part of the narration that names WHO was
 * paid, the same on every line to the same payee. When an owner matches a line to a vendor, the
 * database remembers key → vendor (vendor_narration_aliases, per company) and the next line with
 * the same key is guessed ("learned from your last payment").
 *
 * The SQL twin is public.bank_narration_key (migration 20261026012857). Both read the same slots,
 * in the same order — r1919 vitest and r1919 SQL test check the same narrations:
 *   1. IMPS / NEFT / RTGS (DR|CR): the name slot      IMPS-<ref>-<NAME>-…   NEFT DR-<IFSC>-<NAME>-…
 *   2. UPI/<rrn>/<NAME>/…
 *   3. UPI-<x>-<NAME>-…, or UPI-<NAME>-<vpa>-… (HDFC)
 *   4. <account>-TPT-<remark>-<NAME>
 *   5. a gateway tail after the last "/" that is letters only   …/PAYUFACEBOOK
 *   6. else the narration's letter-only words (no reference codes, no rail words), in order.
 * The key is lower case, letters and single spaces only. null = nothing stable to remember.
 */
import { narrationNames } from "@/lib/accounting/credit-match";

const isName = (s: string | undefined): boolean =>
  !!s && /^[A-Za-z][A-Za-z .&']*[A-Za-z.]$/.test(s.trim()) && s.trim().length >= 3;

const clean = (s: string): string | null => {
  const k = s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  return k.length >= 3 ? k : null;
};

export function narrationKey(description: string | null | undefined): string | null {
  const text = (description ?? "").trim();
  if (!text) return null;

  const dash = text.split("-").map((s) => s.trim());
  if (/^(IMPS|NEFT|RTGS)(\s+(DR|CR))?$/i.test(dash[0] ?? "") && isName(dash[2])) return clean(dash[2]);

  const slash = text.split("/").map((s) => s.trim());
  if (/^UPI$/i.test(slash[0] ?? "") && isName(slash[2])) return clean(slash[2]);

  if (/^UPI$/i.test(dash[0] ?? "")) {
    if (isName(dash[2])) return clean(dash[2]);
    if ((dash[2] ?? "").includes("@") && isName(dash[1])) return clean(dash[1]);
  }

  if (/^TPT$/i.test(dash[1] ?? "") && isName(dash[dash.length - 1])) return clean(dash[dash.length - 1]);

  if (slash.length > 1) {
    const tail = slash[slash.length - 1];
    if (/^[A-Za-z]{4,}$/.test(tail)) return clean(tail);
  }

  const words = text.split(/[^A-Za-z0-9]+/).filter((t) => /^[A-Za-z]+$/.test(t));
  return clean(narrationNames(words.join(" ")).join(" "));
}
