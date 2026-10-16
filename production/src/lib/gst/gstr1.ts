/**
 * GSTR-1 section builder — pure functions, no React, no Supabase.
 *
 * The GST page hands in the period's issued documents (invoices + credit/debit notes)
 * and gets back the tables the return is made of: B2B, B2CL, B2CS, CDNR, CDNUR and the
 * HSN summary, plus a Portal-JSON payload and Offline-Tool CSV rows for each.
 *
 * ─── WHAT WAS WRONG BEFORE (27 Sep 2026) ─────────────────────────────────────
 *   · B2CL cut-off was ₹2,50,000. Notification 12/2024-CT dropped it to ₹1,00,000 for
 *     supplies from 1 Aug 2024, so an inter-state B2C invoice of ₹1.5L went into the B2CS
 *     total instead of its own B2CL line — a return that does not match the invoices.
 *   · Credit/debit notes were counted in the page totals but then "not included — enter
 *     under CDNR on the portal" by hand. They belong in CDNR (registered buyer) / CDNUR
 *     (unregistered, inter-state, over the B2CL cut-off) or netted into B2CS.
 *   · HSN table used one SAC for every rupee. Catalogue items carry their own `hsn`, so a
 *     hosting or hardware line was reported under the SaaS code.
 *   · The Portal JSON carried a made-up GSTIN (`07AAAAA0000A1Z5`) and zero tax in every
 *     line. It is now the company's own GSTIN (the caller refuses to export without one)
 *     and the tax is split into IGST / CGST / SGST.
 *
 * ─── WC-gst (30 Sep 2026) ────────────────────────────────────────────────────
 *   · CGST/SGST split came from Math.trunc here and Math.round on the invoice PDF, so an
 *     odd tax put the odd rupee in a different head on the return than on the invoice.
 *     Both now use lib/gst/tax-split.ts.
 *   · Exports (customer country outside India, no GSTIN) fell into B2CS under whatever
 *     state was on file — or were skipped. They are Table 6A (EXP, zero-rated), and
 *     their notes are CDNUR with UR Type EXPWP / EXPWOP.
 *   · Advances (receipt vouchers) had no table at all. Tax on an advance for a SERVICE
 *     is due when the advance is received (s.13 CGST Act): Table 11A reports advances
 *     received and not invoiced in the same period, 11B the ones adjusted this period
 *     against an invoice after being reported earlier. See buildAdvances below.
 */
import { SAAS_HSN, SAAS_HSN_LABEL, sacLabel } from "./hsn";
import { splitTaxHeads } from "./tax-split";
import { isExportSupply } from "./place-of-supply";
import { GST_STATE_BY_CODE } from "@/lib/utils";

/** Inter-state B2C invoice above this value gets its own B2CL line (₹1L since 1 Aug 2024). */
export const B2CL_THRESHOLD = 100_000;

export type Gstr1DocType = "invoice" | "credit_note" | "debit_note";

/** One issued document. Notes come in SIGNED (credit note negative) — the GST page
 *  already carries them that way so the period totals net correctly. */
export interface Gstr1Doc {
  id: string;
  date: string;                  // YYYY-MM-DD
  docType: Gstr1DocType;
  customerName: string;
  customerGstin: string | null;
  customerStateCode: string | null;
  customerState: string | null;
  amount: number;                // GST-inclusive document value (signed for notes)
  taxableValue: number;          // signed for notes
  gst: number;                   // total tax (signed for notes)
  taxRate: number;
  interState: boolean;
  /** Customer's country. Anything other than India (see isExportSupply) with no GSTIN is an
   *  export → EXP / CDNUR-EXP. Missing/empty = domestic (never silently zero-rate). */
  customerCountry?: string | null;
  /** Per-line HSN/SAC share of the taxable value. Missing → whole document under SAAS_HSN. */
  lines?: { hsn: string; description?: string; taxable: number }[];
}

export interface Seller { stateCode: string | null; state: string | null; gstin?: string | null }

export interface TaxHeads { igst: number; cgst: number; sgst: number }

/** The GST slabs a document's rate is snapped to when it has to be derived. */
export const GST_SLABS = [0, 5, 12, 18, 28] as const;

/**
 * R-1131: a document's GST rate. The stored rate wins. With none, the rate is the
 * document's own tax ÷ taxable (signs ignored, so credit notes work), snapped to the
 * nearest slab. With no tax figure to go on it is `rateMissing` (rate 0, flagged for
 * the user) — never an assumed 18%, which put exempt / 0% notes in the 18% row.
 */
export function docGstRate(
  stored: number | null | undefined,
  taxable: number | null | undefined,
  tax: number | null | undefined,
): { rate: number; rateMissing: boolean } {
  if (stored != null) return { rate: stored, rateMissing: false };
  if (tax === 0) return { rate: 0, rateMissing: false };
  if (tax == null || !taxable) return { rate: 0, rateMissing: true };
  const pct = (Math.abs(tax) / Math.abs(taxable)) * 100;
  const rate = GST_SLABS.reduce((best, s) => (Math.abs(s - pct) < Math.abs(best - pct) ? s : best), GST_SLABS[0] as number);
  return { rate, rateMissing: false };
}

/** Inter-state → all IGST; intra-state → CGST + SGST via the shared rule in tax-split.ts
 *  (CGST = round(tax/2), SGST = tax − CGST — the same split the invoice PDF prints). */
export function gstSplit(r: { gst: number; interState: boolean }): TaxHeads {
  return splitTaxHeads(r.gst, r.interState);
}

/** A document to a customer outside India with no Indian GSTIN = export of services. */
export function isExportDoc(d: Pick<Gstr1Doc, "customerGstin" | "customerCountry">): boolean {
  return !d.customerGstin && isExportSupply(d.customerCountry);
}

/** Tax heads of a document as REPORTED: an export with payment is always IGST (IGST Act
 *  s.16), whatever the row's inter_state flag says. */
export function docHeads(d: Pick<Gstr1Doc, "gst" | "interState" | "customerGstin" | "customerCountry">): TaxHeads {
  return gstSplit({ gst: d.gst, interState: d.interState || isExportDoc(d) });
}

/** Offline Tool date: DD-MMM-YYYY. */
export function gstDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  const mon = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m)];
  return `${d}-${mon}-${y}`;
}
/** Portal JSON date: DD-MM-YYYY. */
export function jsonDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
}

/** Place of supply → { code, name } or null when genuinely unknown.
 *  B2B is authoritative from the GSTIN's first 2 digits; else the customer's state;
 *  else (intra-state B2C) the seller's own state. */
export function posFor(
  d: Pick<Gstr1Doc, "customerGstin" | "customerStateCode" | "customerState" | "interState">, seller: Seller,
): { code: string; name: string } | null {
  if (d.customerGstin && d.customerGstin.length >= 2) {
    const code = d.customerGstin.slice(0, 2);
    return { code, name: GST_STATE_BY_CODE[code] ?? d.customerState ?? "" };
  }
  if (d.customerStateCode) {
    const code = d.customerStateCode.padStart(2, "0");
    return { code, name: d.customerState ?? GST_STATE_BY_CODE[code] ?? "" };
  }
  if (!d.interState && seller.stateCode) {
    const code = seller.stateCode.padStart(2, "0");
    return { code, name: seller.state ?? GST_STATE_BY_CODE[code] ?? "" };
  }
  return null;
}

// ─── Section row shapes ─────────────────────────────────────────────────────

export interface B2bRow { gstin: string; name: string; id: string; date: string; value: number; pos: string; rate: number; taxable: number; heads: TaxHeads }
export interface B2clRow { id: string; date: string; value: number; pos: string; rate: number; taxable: number; heads: TaxHeads }
export interface B2csRow { pos: string; interState: boolean; rate: number; taxable: number; heads: TaxHeads }
export interface CdnrRow { gstin: string; name: string; id: string; date: string; noteType: "C" | "D"; value: number; pos: string; rate: number; taxable: number; heads: TaxHeads }
/** UR Type: B2CL (large inter-state unregistered) or EXPWP / EXPWOP (export note, with / without IGST). */
export type CdnurType = "B2CL" | "EXPWP" | "EXPWOP";
export interface CdnurRow { urType: CdnurType; id: string; date: string; noteType: "C" | "D"; value: number; pos: string; rate: number; taxable: number; heads: TaxHeads }
/** Table 6A. WPAY = IGST charged (refund route), WOPAY = under LUT, no tax. */
export interface ExpRow { exportType: "WPAY" | "WOPAY"; id: string; date: string; value: number; rate: number; taxable: number; igst: number }
export interface HsnRow { hsn: string; description: string; rate: number; value: number; taxable: number; heads: TaxHeads }

export interface Gstr1Sections {
  b2b: B2bRow[];
  b2cl: B2clRow[];
  b2cs: B2csRow[];
  cdnr: CdnrRow[];
  cdnur: CdnurRow[];
  exp: ExpRow[];
  hsn: HsnRow[];
  /** B2C documents with no resolvable place of supply — not in any table. */
  skipped: string[];
  /** Unregistered small notes folded into B2CS (they have no table of their own). */
  notesNettedIntoB2cs: number;
}

const addHeads = (a: TaxHeads, b: TaxHeads): TaxHeads => ({ igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst });
const posStr = (p: { code: string; name: string }) => `${p.code}-${p.name}`;

/**
 * Per-line HSN shares of a document, in rupees. Lines are given as weights (qty × rate);
 * the document's own taxable value is prorated across them so the HSN table always adds
 * up to the invoice total, whatever discount or proration the invoice carried.
 */
export function hsnLines(
  taxableValue: number,
  items: { hsn: string | null | undefined; description?: string; weight: number }[] | null | undefined,
): { hsn: string; description?: string; taxable: number }[] {
  const usable = (items ?? []).filter((i) => i.weight > 0);
  const totalW = usable.reduce((s, i) => s + i.weight, 0);
  if (!usable.length || totalW <= 0) return [{ hsn: SAAS_HSN, description: SAAS_HSN_LABEL, taxable: taxableValue }];
  const out: { hsn: string; description?: string; taxable: number }[] = [];
  let assigned = 0;
  usable.forEach((i, idx) => {
    const last = idx === usable.length - 1;
    const share = last ? taxableValue - assigned : Math.round((taxableValue * i.weight) / totalW);
    assigned += share;
    out.push({ hsn: (i.hsn ?? "").trim() || SAAS_HSN, description: i.description, taxable: share });
  });
  return out;
}

/** A stored invoice line, as far as the HSN table cares. `hsn` is the line's OWN code
 *  (a project milestone line carries `project_sales.sac_code`, R-010); `item_id` points
 *  at the catalogue, whose `items.hsn` is the fallback. */
export interface HsnSourceLine { item_id?: string | null; hsn?: string | null; name?: string; qty?: number; rate?: number }

/**
 * R-067 — the HSN/SAC a stored line is filed under: the line's own code first, the
 * catalogue item's second, and only then (inside hsnLines) the SaaS default.
 *
 * Before this, the GST page read ONLY the catalogue (`l.item_id ? hsnByItem.get(...) : null`),
 * so a project milestone line — no item_id, own SAC 998314 printed on the invoice — was
 * filed in GSTR-1 Table 12 under 998313. The return disagreed with the invoice.
 */
export function lineHsn(line: HsnSourceLine, hsnByItem: ReadonlyMap<string, string | null>): string | null {
  const own = (line.hsn ?? "").trim();
  if (own) return own;
  const cat = line.item_id ? (hsnByItem.get(line.item_id) ?? "").trim() : "";
  return cat || null;
}

/** hsnLines over stored invoice lines. Used for invoices AND their credit/debit notes:
 *  a note has no lines of its own, so it is split in the same proportions as the invoice
 *  it amends (a credit note on a 998314 invoice reverses 998314, not 998313). */
export function docHsnLines(
  taxableValue: number,
  lines: HsnSourceLine[] | null | undefined,
  hsnByItem: ReadonlyMap<string, string | null>,
): { hsn: string; description?: string; taxable: number }[] {
  return hsnLines(taxableValue, (lines ?? []).map((l) => ({
    hsn: lineHsn(l, hsnByItem), description: l.name, weight: (l.qty ?? 0) * (l.rate ?? 0),
  })));
}

export function buildGstr1(docs: Gstr1Doc[], seller: Seller): Gstr1Sections {
  const b2b: B2bRow[] = [];
  const b2cl: B2clRow[] = [];
  const cdnr: CdnrRow[] = [];
  const cdnur: CdnurRow[] = [];
  const exp: ExpRow[] = [];
  const b2csMap = new Map<string, B2csRow>();
  const hsnMap = new Map<string, HsnRow>();
  const skipped: string[] = [];
  let notesNettedIntoB2cs = 0;

  for (const d of docs) {
    const pos = posFor(d, seller);
    const isExport = isExportDoc(d);
    const heads = docHeads(d);
    const isNote = d.docType !== "invoice";
    const noteType: "C" | "D" = d.docType === "credit_note" ? "C" : "D";

    // HSN summary (Table 12) — signed, so it nets the same way 3B does.
    const lines = d.lines?.length ? d.lines : [{ hsn: SAAS_HSN, description: SAAS_HSN_LABEL, taxable: d.taxableValue }];
    const lineTax = (share: number) => (d.taxableValue ? Math.round((d.gst * share) / d.taxableValue) : 0);
    for (const ln of lines) {
      const key = `${ln.hsn}|${d.taxRate}`;
      const cur = hsnMap.get(key) ?? { hsn: ln.hsn, description: sacLabel(ln.hsn) ?? (ln.description ?? ""), rate: d.taxRate, value: 0, taxable: 0, heads: { igst: 0, cgst: 0, sgst: 0 } };
      const tax = lines.length === 1 ? d.gst : lineTax(ln.taxable);
      cur.taxable += ln.taxable;
      cur.value += ln.taxable + tax;
      cur.heads = addHeads(cur.heads, gstSplit({ gst: tax, interState: d.interState || isExport }));
      if (!cur.description && ln.description) cur.description = ln.description;
      hsnMap.set(key, cur);
    }

    if (d.customerGstin) {
      const p = pos ? posStr(pos) : "";
      if (isNote) cdnr.push({ gstin: d.customerGstin, name: d.customerName, id: d.id, date: d.date, noteType, value: Math.abs(d.amount), pos: p, rate: d.taxRate, taxable: Math.abs(d.taxableValue), heads: abs(heads) });
      else b2b.push({ gstin: d.customerGstin, name: d.customerName, id: d.id, date: d.date, value: d.amount, pos: p, rate: d.taxRate, taxable: d.taxableValue, heads });
      continue;
    }
    if (isExport) {
      /* Zero-rated export. WPAY when IGST was charged, WOPAY under LUT. The rate on a
         WOPAY line is 0 — nothing was levied (CA to confirm against the current tool). */
      const withPay = d.gst !== 0;
      const rate = withPay ? d.taxRate : 0;
      if (isNote) cdnur.push({ urType: withPay ? "EXPWP" : "EXPWOP", id: d.id, date: d.date, noteType, value: Math.abs(d.amount), pos: "", rate, taxable: Math.abs(d.taxableValue), heads: abs(heads) });
      else exp.push({ exportType: withPay ? "WPAY" : "WOPAY", id: d.id, date: d.date, value: d.amount, rate, taxable: d.taxableValue, igst: heads.igst });
      continue;
    }
    if (!pos) { skipped.push(d.id); continue; }
    const p = posStr(pos);
    const large = d.interState && Math.abs(d.amount) > B2CL_THRESHOLD;
    if (large) {
      if (isNote) cdnur.push({ urType: "B2CL", id: d.id, date: d.date, noteType, value: Math.abs(d.amount), pos: p, rate: d.taxRate, taxable: Math.abs(d.taxableValue), heads: abs(heads) });
      else b2cl.push({ id: d.id, date: d.date, value: d.amount, pos: p, rate: d.taxRate, taxable: d.taxableValue, heads });
      continue;
    }
    // B2CS — consolidated per place of supply + rate; small unregistered notes net here (signed).
    if (isNote) notesNettedIntoB2cs++;
    const key = `${p}|${d.taxRate}`;
    const cur = b2csMap.get(key) ?? { pos: p, interState: d.interState, rate: d.taxRate, taxable: 0, heads: { igst: 0, cgst: 0, sgst: 0 } };
    cur.taxable += d.taxableValue;
    cur.heads = addHeads(cur.heads, heads);
    b2csMap.set(key, cur);
  }

  return { b2b, b2cl, b2cs: [...b2csMap.values()], cdnr, cdnur, exp, hsn: [...hsnMap.values()], skipped, notesNettedIntoB2cs };
}

function abs(h: TaxHeads): TaxHeads { return { igst: Math.abs(h.igst), cgst: Math.abs(h.cgst), sgst: Math.abs(h.sgst) }; }

// ─── GST Offline Tool CSVs (one file per section, standard templates) ───────

export const GSTR1_HEADERS = {
  b2b:   ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"],
  b2cl:  ["Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
  b2cs:  ["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
  cdnr:  ["GSTIN/UIN of Recipient", "Receiver Name", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Reverse Charge", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
  cdnur: ["UR Type", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
  exp:   ["Export Type", "Invoice Number", "Invoice date", "Invoice Value", "Port Code", "Shipping Bill Number", "Shipping Bill Date", "Rate", "Taxable Value", "Cess Amount"],
  at:    ["Place Of Supply", "Applicable % of Tax Rate", "Rate", "Gross Advance Received", "Cess Amount"],
  atadj: ["Place Of Supply", "Applicable % of Tax Rate", "Rate", "Gross Advance Adjusted", "Cess Amount"],
  hsn:   ["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"],
} as const;

export type CsvRow = (string | number)[];

export function gstr1Csv(s: Gstr1Sections, adv?: AdvanceTables): Record<keyof typeof GSTR1_HEADERS, CsvRow[]> {
  return {
    b2b:   s.b2b.map((r) => [r.gstin, r.name, r.id, gstDate(r.date), r.value, r.pos, "N", "", "Regular B2B", "", r.rate, r.taxable, 0]),
    b2cl:  s.b2cl.map((r) => [r.id, gstDate(r.date), r.value, r.pos, "", r.rate, r.taxable, 0, ""]),
    b2cs:  s.b2cs.map((r) => ["OE", r.pos, "", r.rate, r.taxable, 0, ""]),
    cdnr:  s.cdnr.map((r) => [r.gstin, r.name, r.id, gstDate(r.date), r.noteType, r.pos, "N", "Regular B2B", r.value, "", r.rate, r.taxable, 0]),
    cdnur: s.cdnur.map((r) => [r.urType, r.id, gstDate(r.date), r.noteType, r.pos, r.urType, r.value, "", r.rate, r.taxable, 0]),
    /* Services: no port code / shipping bill — the columns stay, empty. */
    exp:   s.exp.map((r) => [r.exportType, r.id, gstDate(r.date), r.value, "", "", "", r.rate, r.taxable, 0]),
    at:    (adv?.at ?? []).map((r) => [r.pos, "", r.rate, r.advance, 0]),
    atadj: (adv?.atadj ?? []).map((r) => [r.pos, "", r.rate, r.advance, 0]),
    hsn:   s.hsn.map((r) => [r.hsn, r.description, "OTH-OTHERS", 0, r.value, r.rate, r.taxable, r.heads.igst, r.heads.cgst, r.heads.sgst, 0]),
  };
}

// ─── Portal JSON (GSTR1 upload schema) ──────────────────────────────────────

const itm = (num: number, r: { rate: number; taxable: number; heads: TaxHeads }) => ({
  num, itm_det: { rt: r.rate, txval: r.taxable, iamt: r.heads.igst, camt: r.heads.cgst, samt: r.heads.sgst, csamt: 0 },
});
const posCode = (pos: string) => pos.slice(0, 2);

/** Portal JSON. `gstin` must be the company's real GSTIN — the caller refuses without one.
 *  `fp` is the return period MMYYYY. */
export function gstr1Json(s: Gstr1Sections, gstin: string, fp: string, adv?: AdvanceTables) {
  const byCtin = <T extends { gstin: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.gstin, [...(m.get(r.gstin) ?? []), r]);
    return [...m.entries()];
  };
  const byPos = <T extends { pos: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(posCode(r.pos), [...(m.get(posCode(r.pos)) ?? []), r]);
    return [...m.entries()];
  };
  return {
    gstin, fp, version: "GSTR1_v3.0.4",
    b2b: byCtin(s.b2b).map(([ctin, rows]) => ({
      ctin,
      inv: rows.map((r) => ({ inum: r.id, idt: jsonDate(r.date), val: r.value, pos: posCode(r.pos), rchrg: "N", inv_typ: "R", itms: [itm(1, r)] })),
    })),
    b2cl: byPos(s.b2cl).map(([pos, rows]) => ({
      pos, inv: rows.map((r) => ({ inum: r.id, idt: jsonDate(r.date), val: r.value, itms: [itm(1, r)] })),
    })),
    b2cs: s.b2cs.map((r) => ({
      sply_ty: r.interState ? "INTER" : "INTRA", rt: r.rate, typ: "OE", pos: posCode(r.pos),
      txval: r.taxable, iamt: r.heads.igst, camt: r.heads.cgst, samt: r.heads.sgst, csamt: 0,
    })),
    cdnr: byCtin(s.cdnr).map(([ctin, rows]) => ({
      ctin,
      nt: rows.map((r) => ({ ntty: r.noteType, nt_num: r.id, nt_dt: jsonDate(r.date), pos: posCode(r.pos), rchrg: "N", inv_typ: "R", val: r.value, itms: [itm(1, r)] })),
    })),
    cdnur: s.cdnur.map((r) => ({
      typ: r.urType, ntty: r.noteType, nt_num: r.id, nt_dt: jsonDate(r.date),
      ...(r.urType === "B2CL" ? { pos: posCode(r.pos) } : {}), val: r.value, itms: [itm(1, r)],
    })),
    exp: (["WPAY", "WOPAY"] as const)
      .map((t) => ({ exp_typ: t, inv: s.exp.filter((r) => r.exportType === t).map((r) => ({
        inum: r.id, idt: jsonDate(r.date), val: r.value,
        itms: [{ txval: r.taxable, rt: r.rate, iamt: r.igst, csamt: 0 }],
      })) }))
      .filter((g) => g.inv.length > 0),
    at: advJson(adv?.at ?? []),
    txpd: advJson(adv?.atadj ?? []),
    hsn: {
      data: s.hsn.map((r, i) => ({
        num: i + 1, hsn_sc: r.hsn, desc: r.description, uqc: "OTH", qty: 0,
        val: r.value, txval: r.taxable, iamt: r.heads.igst, camt: r.heads.cgst, samt: r.heads.sgst, csamt: 0,
      })),
    },
  };
}

// ─── Advances: Table 11A (received) / 11B (adjusted) ────────────────────────
/*
 * Tax on an advance for a service is due on receipt (s.13(2) CGST Act; the goods-side
 * relief, Notification 66/2017-CT, does not cover services). The app issues an RV
 * (receipt voucher) for every quote payment; that payment is an advance until the quote's
 * invoice is issued.
 *
 *   11A  advance RECEIVED in the period and not invoiced by the period's end.
 *        (Received and invoiced in the same period: neither table; the invoice carries it.)
 *   11B  advance received in an EARLIER period, adjusted against an invoice dated in this
 *        one. It reduces the tax, because the invoice now carries the full tax again.
 *
 * Values are the advance EXCLUDING tax ("Gross Advance Received" in the Offline Tool is
 * the taxable part; the tool computes tax on it). The receipt is GST-inclusive, so it is
 * reverse-derived at the rate: taxable = round(gross x 100 / (100 + rate)), the same
 * formula the receipt voucher itself prints.
 *
 * Exports: an advance for a zero-rated export under LUT carries no tax. Not reported,
 * counted in `exportsSkipped` so the page can say so.
 */
export interface Advance {
  paymentId: string;
  voucherNo: string | null;
  /** IST calendar date the money came in (YYYY-MM-DD). Convert received_at with toIstDate. */
  receivedDate: string;
  /** Date of the invoice that adjusted it, or null while it is still an open advance. */
  adjustedOn: string | null;
  /** GST-inclusive amount (₹). For 11B: the amount adjusted on the invoice. */
  gross: number;
  rate: number;
  /** R-1131: the quote/invoice had no GST rate to use — `rate` is 0 and the page warns. */
  rateMissing?: boolean;
  interState: boolean;
  customerGstin: string | null;
  customerStateCode: string | null;
  customerState: string | null;
  customerCountry?: string | null;
}
export interface AdvanceRow { pos: string; interState: boolean; rate: number; advance: number; heads: TaxHeads }
export interface AdvanceTables {
  at: AdvanceRow[];
  atadj: AdvanceRow[];
  /** Advances with no resolvable place of supply (payment ids): not in either table. */
  skipped: string[];
  /** Export advances (zero-rated under LUT): no tax, not reported. */
  exportsSkipped: number;
}

/** Taxable value + tax of a GST-inclusive receipt. */
export function advanceTax(gross: number, rate: number): { taxable: number; tax: number } {
  const taxable = Math.round((gross * 100) / (100 + rate));
  return { taxable, tax: gross - taxable };
}

export function buildAdvances(advances: Advance[], period: { from: string; to: string }, seller: Seller): AdvanceTables {
  const atMap = new Map<string, AdvanceRow>();
  const adjMap = new Map<string, AdvanceRow>();
  const skipped: string[] = [];
  let exportsSkipped = 0;
  const inPeriod = (d: string) => d >= period.from && d <= period.to;

  for (const a of advances) {
    if (!(a.gross > 0)) continue;
    const received = a.receivedDate.slice(0, 10);
    const adjusted = a.adjustedOn ? a.adjustedOn.slice(0, 10) : null;
    const is11A = inPeriod(received) && (adjusted == null || adjusted > period.to);
    const is11B = adjusted != null && inPeriod(adjusted) && received < period.from;
    if (!is11A && !is11B) continue;
    if (isExportDoc({ customerGstin: a.customerGstin, customerCountry: a.customerCountry })) { exportsSkipped++; continue; }
    const pos = posFor(a, seller);
    if (!pos) { skipped.push(a.paymentId); continue; }
    const { taxable, tax } = advanceTax(a.gross, a.rate);
    const p = posStr(pos);
    const target = is11A ? atMap : adjMap;
    const key = `${p}|${a.rate}|${a.interState ? "I" : "L"}`;
    const cur = target.get(key) ?? { pos: p, interState: a.interState, rate: a.rate, advance: 0, heads: { igst: 0, cgst: 0, sgst: 0 } };
    cur.advance += taxable;
    cur.heads = addHeads(cur.heads, gstSplit({ gst: tax, interState: a.interState }));
    target.set(key, cur);
  }
  return { at: [...atMap.values()], atadj: [...adjMap.values()], skipped, exportsSkipped };
}

function advJson(rows: AdvanceRow[]) {
  const m = new Map<string, AdvanceRow[]>();
  for (const r of rows) {
    const k = `${posCode(r.pos)}|${r.interState ? "INTER" : "INTRA"}`;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.entries()].map(([k, rs]) => {
    const [pos, sply_ty] = k.split("|");
    return {
      pos, sply_ty,
      itms: rs.map((r) => ({ rt: r.rate, ad_amt: r.advance, iamt: r.heads.igst, camt: r.heads.cgst, samt: r.heads.sgst, csamt: 0 })),
    };
  });
}

// ─── GSTR-3B classification of one document ────────────────────────────────

/** How a document lands in 3B: zero-rated (3.1(b)) or not, and, for an inter-state supply
 *  to an unregistered person, its place of supply for Table 3.2. */
export function gstr3bClass(d: Gstr1Doc, seller: Seller): { zeroRated: boolean; unregInterPos: string | null } {
  if (isExportDoc(d)) return { zeroRated: true, unregInterPos: null };
  if (d.customerGstin || !d.interState) return { zeroRated: false, unregInterPos: null };
  const pos = posFor(d, seller);
  return { zeroRated: false, unregInterPos: pos ? posStr(pos) : null };
}
