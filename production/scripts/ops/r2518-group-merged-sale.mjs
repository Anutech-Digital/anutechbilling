#!/usr/bin/env node
/**
 * R-2518 — which lines of a MERGED bank-receipt sale belong to which Zoho invoice.
 *
 * Input: the JSON rows of section 4 of scripts/ops/r2518-merged-bank-sales-report.sql (the server's
 * stored Zoho scan — no Zoho call, nothing written): one object per merged app invoice
 *   { invoice_id, quote_lines: [{id, name, qty, rate, …}], zoho_invoices: [{number, lines: [{name, qty, rate}]}] }
 * as a JSON array, or one object per line of the file.
 *
 * Output: for each invoice whose lines ALL map to exactly one Zoho invoice line (same seats / quantity and
 * rate; the name breaks a tie), the DRY-RUN call of the owner-only repair:
 *   select public.repair_split_merged_bank_sale('<invoice>', '<groups>'::jsonb, true);
 * Anything that does not map cleanly is printed as a "-- SKIP" line with the reason — fix it by hand.
 * Running the printed dry run changes nothing; the real run (p_dry_run false) is Pardeep's decision.
 *
 *   node scripts/ops/r2518-group-merged-sale.mjs r2518-input.json
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const num = (v) => (typeof v === "number" ? v : Number(v));
const sameMoney = (a, b) => Math.abs(num(a) - num(b)) <= 0.01;

/** One merged invoice → { invoiceId, groups } or { invoiceId, problem }. Pure. */
export function groupMergedSale(input) {
  const invoiceId = String(input?.invoice_id ?? "");
  const quoteLines = Array.isArray(input?.quote_lines) ? input.quote_lines : [];
  const zoho = Array.isArray(input?.zoho_invoices) ? input.zoho_invoices : [];
  if (!invoiceId) return { invoiceId, problem: "no invoice_id" };
  if (zoho.length < 2) return { invoiceId, problem: `only ${zoho.length} Zoho invoice(s) in the scan — read them in Zoho and group by hand` };
  if (quoteLines.some((l) => !l?.id)) return { invoiceId, problem: "a quote line has no id" };

  const pool = zoho.flatMap((z, zi) => (Array.isArray(z.lines) ? z.lines : []).map((l, li) => ({ zi, li, l, used: false })));
  const pick = new Map();
  for (const pass of ["name", "money"]) {
    for (const ql of quoteLines) {
      if (pick.has(ql.id)) continue;
      const hit = pool.find((p) => !p.used && num(p.l.qty) === num(ql.qty) && sameMoney(p.l.rate, ql.rate)
        && (pass === "money" || norm(p.l.name) === norm(ql.name)));
      if (hit) { hit.used = true; pick.set(ql.id, hit.zi); }
    }
  }
  const missing = quoteLines.filter((l) => !pick.has(l.id));
  if (missing.length) {
    return { invoiceId, problem: `no Zoho line with the same quantity and rate for: ${missing.map((l) => `${l.qty} × ${l.rate} ${l.name ?? ""}`.trim()).join("; ")}` };
  }
  const left = pool.filter((p) => !p.used);
  if (left.length) {
    return { invoiceId, problem: `Zoho lines not on the app sale: ${left.map((p) => `${zoho[p.zi].number} ${p.l.qty} × ${p.l.rate}`).join("; ")}` };
  }
  const groups = zoho.map((z, zi) => ({
    external_number: String(z.number).trim(),
    line_ids: quoteLines.filter((l) => pick.get(l.id) === zi).map((l) => String(l.id)),
  }));
  if (groups.some((g) => g.line_ids.length === 0)) {
    return { invoiceId, problem: `a Zoho invoice got no line (${groups.filter((g) => !g.line_ids.length).map((g) => g.external_number).join(", ")})` };
  }
  return { invoiceId, groups };
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The dry-run SQL line (or a SKIP comment) for one result. */
export function dryRunSql(r) {
  if (r.problem) return `-- SKIP ${r.invoiceId || "?"}: ${r.problem}`;
  return `select public.repair_split_merged_bank_sale(${lit(r.invoiceId)}, ${lit(JSON.stringify(r.groups))}::jsonb, true);`;
}

/** The file's rows: a JSON array, or one JSON object per line (psql output of section 4). */
export function readInput(text) {
  const t = text.trim();
  if (t.startsWith("[")) return JSON.parse(t);
  return t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node scripts/ops/r2518-group-merged-sale.mjs <section-4 rows .json>"); process.exit(2); }
  const rows = readInput(readFileSync(file, "utf8"));
  console.log("-- R-2518 DRY RUNS — each changes nothing. Read each answer; the real run (true → false) is Pardeep's decision.");
  for (const row of rows) console.log(dryRunSql(groupMergedSale(row)));
}
