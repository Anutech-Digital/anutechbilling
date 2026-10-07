/**
 * R-343 — "GSTR-1 vs books": what changed in the books after GSTR-1 was filed.
 *
 * Why: from the July 2025 period GSTR-3B Table 3 is auto-filled from GSTR-1 / GSTR-1A and
 * locked. A mistake in a filed GSTR-1 is fixed in GSTR-1A of the SAME period, before 3B is
 * filed (GSTN FAQ on GSTR-1A). The owner needs to know which records to amend or add.
 *
 * What this does: reads the GSTR-1 JSON that was filed (the file this app exported for the
 * portal, or the portal's own GSTR-1 JSON — same field names), rebuilds the period from the
 * books with buildGstr1 (unchanged, so the tax math is the one the return already uses), and
 * lists every difference document by document, plus B2CS by place of supply + rate.
 *
 * EXPORT ONLY. Nothing here computes or changes tax: both sides' figures are read as they
 * are — the filed file's numbers and buildGstr1's numbers — and only compared.
 *
 * Why no GSTR-1A upload file: the GSTN FAQ says GSTR-1A "can be filed only through online
 * mode and through GSP" — there is no offline-tool / JSON upload for it, and no official
 * GSTR-1A (B2BA/CDNRA) file schema could be verified. So the output is a worklist (screen +
 * CSV) of what to type into GSTR-1A on the portal, not an upload file. Sources on card R-343:
 *   https://tutorial.gst.gov.in/downloads/news/creative_faqs_on_gstr1a_fo_cr25785.pdf
 *   https://tutorial.gst.gov.in/userguide/returns/FAQs_Creation_of_Outward_Supplies_Return_in_GSTR-1A.htm
 *
 * Same FAQ: the recipient's GSTIN cannot be amended in GSTR-1A — only in a later GSTR-1
 * (B2BA / CDNRA). Such rows say so instead of "amend in GSTR-1A".
 */
import { buildGstr1, type Gstr1Doc, type Gstr1Sections, type Seller, type TaxHeads } from "./gstr1";

export type ReturnTable = "B2B" | "B2CL" | "EXP" | "CDNR" | "CDNUR";

/** One invoice / note as it stands in a GSTR-1 (filed file or rebuilt from books). */
export interface ReturnDoc {
  table: ReturnTable;
  /** Document number as written (match key is normalised separately). */
  num: string;
  /** YYYY-MM-DD, or "" when the file had none. */
  date: string;
  ctin: string | null;
  noteType: "C" | "D" | null;
  /** 2-digit place-of-supply code, "" for exports. */
  pos: string;
  value: number;
  taxable: number;
  heads: TaxHeads;
  /** Rates on the document, sorted (one per item). */
  rates: number[];
}

export interface B2csLine { pos: string; rate: number; taxable: number; heads: TaxHeads }

export interface ParsedReturn {
  gstin: string | null;
  /** Return period MMYYYY, if the file says. */
  fp: string | null;
  docs: ReturnDoc[];
  b2cs: B2csLine[];
  errors: string[];
}

const NOTE_TABLES: ReadonlySet<ReturnTable> = new Set(["CDNR", "CDNUR"]);
const ZERO: TaxHeads = { igst: 0, cgst: 0, sgst: 0 };

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Portal JSON date DD-MM-YYYY → YYYY-MM-DD ("" if unreadable). */
export function isoFromJsonDate(d: unknown): string {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(str(d).trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

/** Invoice numbers are matched case-insensitively, ignoring spaces. */
export function docKey(table: ReturnTable, n: string): string {
  return `${NOTE_TABLES.has(table) ? "note" : "inv"}|${n.replace(/\s+/g, "").toUpperCase()}`;
}

/** Sum of an `itms` array — each item is { itm_det: {...} } (B2B/CDNR…) or flat (EXP). */
function sumItems(items: unknown): { taxable: number; heads: TaxHeads; rates: number[] } {
  let taxable = 0;
  const heads = { ...ZERO };
  const rates: number[] = [];
  for (const raw of arr(items)) {
    const it = obj(raw);
    if (!it) continue;
    const det = obj(it.itm_det) ?? it;
    taxable += num(det.txval);
    heads.igst += num(det.iamt);
    heads.cgst += num(det.camt);
    heads.sgst += num(det.samt);
    rates.push(num(det.rt));
  }
  return { taxable, heads, rates: rates.sort((a, b) => a - b) };
}

/**
 * Reads a GSTR-1 JSON (this app's export, or the portal's GSTR-1 JSON — same keys:
 * b2b[].inv[], b2cl[].inv[], cdnr[].nt[], cdnur[], exp[].inv[], b2cs[]). Unknown sections
 * (hsn, at, txpd, doc_issue…) are ignored — they are summaries, not documents.
 */
export function parseGstr1Json(input: unknown): ParsedReturn {
  const root = obj(input);
  if (!root) return { gstin: null, fp: null, docs: [], b2cs: [], errors: ["not a JSON object"] };
  const known = ["b2b", "b2cl", "b2cs", "cdnr", "cdnur", "exp"];
  if (!known.some((k) => k in root)) {
    return { gstin: str(root.gstin) || null, fp: str(root.fp) || null, docs: [], b2cs: [], errors: ["no GSTR-1 tables (b2b, b2cl, b2cs, cdnr, cdnur, exp) in this file"] };
  }
  const docs: ReturnDoc[] = [];
  const doc = (table: ReturnTable, d: Record<string, unknown>, extra: { ctin: string | null; pos: string; noteType: "C" | "D" | null; numKey: string; dateKey: string }) => {
    const s = sumItems(d.itms);
    docs.push({
      table, num: str(d[extra.numKey]).trim(), date: isoFromJsonDate(d[extra.dateKey]),
      ctin: extra.ctin, noteType: extra.noteType, pos: extra.pos,
      value: num(d.val), taxable: s.taxable, heads: s.heads, rates: s.rates,
    });
  };
  const noteType = (v: unknown): "C" | "D" => (str(v).toUpperCase() === "D" ? "D" : "C");

  for (const g of arr(root.b2b).map(obj)) {
    if (!g) continue;
    for (const i of arr(g.inv).map(obj)) if (i) doc("B2B", i, { ctin: str(g.ctin) || null, pos: str(i.pos), noteType: null, numKey: "inum", dateKey: "idt" });
  }
  for (const g of arr(root.b2cl).map(obj)) {
    if (!g) continue;
    for (const i of arr(g.inv).map(obj)) if (i) doc("B2CL", i, { ctin: null, pos: str(g.pos), noteType: null, numKey: "inum", dateKey: "idt" });
  }
  for (const g of arr(root.exp).map(obj)) {
    if (!g) continue;
    for (const i of arr(g.inv).map(obj)) if (i) doc("EXP", i, { ctin: null, pos: "", noteType: null, numKey: "inum", dateKey: "idt" });
  }
  for (const g of arr(root.cdnr).map(obj)) {
    if (!g) continue;
    for (const n of arr(g.nt).map(obj)) if (n) doc("CDNR", n, { ctin: str(g.ctin) || null, pos: str(n.pos), noteType: noteType(n.ntty), numKey: "nt_num", dateKey: "nt_dt" });
  }
  for (const n of arr(root.cdnur).map(obj)) if (n) doc("CDNUR", n, { ctin: null, pos: str(n.pos), noteType: noteType(n.ntty), numKey: "nt_num", dateKey: "nt_dt" });

  const b2cs: B2csLine[] = [];
  for (const r of arr(root.b2cs).map(obj)) {
    if (!r) continue;
    b2cs.push({ pos: str(r.pos), rate: num(r.rt), taxable: num(r.txval), heads: { igst: num(r.iamt), cgst: num(r.camt), sgst: num(r.samt) } });
  }
  return { gstin: str(root.gstin) || null, fp: str(root.fp) || null, docs, b2cs, errors: [] };
}

/** The same shape, rebuilt from the books' sections (the numbers buildGstr1 produced). */
export function returnFromSections(s: Gstr1Sections): Pick<ParsedReturn, "docs" | "b2cs"> {
  const pos2 = (p: string) => p.slice(0, 2);
  const docs: ReturnDoc[] = [
    ...s.b2b.map((r): ReturnDoc => ({ table: "B2B", num: r.id, date: r.date, ctin: r.gstin, noteType: null, pos: pos2(r.pos), value: r.value, taxable: r.taxable, heads: r.heads, rates: [r.rate] })),
    ...s.b2cl.map((r): ReturnDoc => ({ table: "B2CL", num: r.id, date: r.date, ctin: null, noteType: null, pos: pos2(r.pos), value: r.value, taxable: r.taxable, heads: r.heads, rates: [r.rate] })),
    ...s.exp.map((r): ReturnDoc => ({ table: "EXP", num: r.id, date: r.date, ctin: null, noteType: null, pos: "", value: r.value, taxable: r.taxable, heads: { igst: r.igst, cgst: 0, sgst: 0 }, rates: [r.rate] })),
    ...s.cdnr.map((r): ReturnDoc => ({ table: "CDNR", num: r.id, date: r.date, ctin: r.gstin, noteType: r.noteType, pos: pos2(r.pos), value: r.value, taxable: r.taxable, heads: r.heads, rates: [r.rate] })),
    ...s.cdnur.map((r): ReturnDoc => ({ table: "CDNUR", num: r.id, date: r.date, ctin: null, noteType: r.noteType, pos: r.urType === "B2CL" ? pos2(r.pos) : "", value: r.value, taxable: r.taxable, heads: r.heads, rates: [r.rate] })),
  ];
  const b2cs = s.b2cs.map((r): B2csLine => ({ pos: pos2(r.pos), rate: r.rate, taxable: r.taxable, heads: r.heads }));
  return { docs, b2cs };
}

/** Convenience: books docs → return shape, through the existing builder. */
export function returnFromBooks(docs: Gstr1Doc[], seller: Seller): Pick<ParsedReturn, "docs" | "b2cs"> {
  return returnFromSections(buildGstr1(docs, seller));
}

// ─── Comparison ─────────────────────────────────────────────────────────────

export type DiffStatus = "changed" | "missing_in_return" | "not_in_books";

export interface DocDiff {
  status: DiffStatus;
  table: ReturnTable;
  num: string;
  date: string;
  ctin: string | null;
  /** Human list of what differs, e.g. ["Taxable value 1,000 → 1,200", "Rate 12 → 18"]. */
  changes: string[];
  filed: ReturnDoc | null;
  books: ReturnDoc | null;
  /** Books tax − filed tax (₹). Positive = more tax due than the return shows. */
  taxDiff: number;
  /** What to do on the portal. */
  action: string;
  /** Recipient GSTIN differs — cannot be fixed in GSTR-1A. */
  gstinChanged: boolean;
}

export interface B2csDiff { pos: string; rate: number; filed: B2csLine | null; books: B2csLine | null; taxDiff: number; taxableDiff: number }

export interface Gstr1VsBooks {
  docs: DocDiff[];
  b2cs: B2csDiff[];
  unchanged: number;
  /** Books tax − filed tax across everything, per head. */
  taxDiff: TaxHeads;
}

const tax = (h: TaxHeads) => h.igst + h.cgst + h.sgst;
/** Whole-rupee comparison: paise and float noise in a file are not a difference. */
const differs = (a: number, b: number) => Math.abs(a - b) >= 1;
const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");

const ACTION = {
  amend: "Amend this record in GSTR-1A (before filing GSTR-3B)",
  add: "Add this record in GSTR-1A (before filing GSTR-3B)",
  notInBooks: "In the filed return but not in the books for this period: check the books; if the return is wrong, amend it in GSTR-1A",
  gstin: "Recipient GSTIN cannot be changed in GSTR-1A: amend in a later GSTR-1 (B2BA / CDNRA)",
} as const;

export function compareGstr1(filed: Pick<ParsedReturn, "docs" | "b2cs">, books: Pick<ParsedReturn, "docs" | "b2cs">): Gstr1VsBooks {
  const filedByKey = new Map<string, ReturnDoc>();
  for (const d of filed.docs) filedByKey.set(docKey(d.table, d.num), d);
  const out: DocDiff[] = [];
  const seen = new Set<string>();
  let unchanged = 0;
  const total = { ...ZERO };
  const addTotal = (b: TaxHeads | null, f: TaxHeads | null) => {
    total.igst += (b?.igst ?? 0) - (f?.igst ?? 0);
    total.cgst += (b?.cgst ?? 0) - (f?.cgst ?? 0);
    total.sgst += (b?.sgst ?? 0) - (f?.sgst ?? 0);
  };

  for (const b of books.docs) {
    const key = docKey(b.table, b.num);
    const f = filedByKey.get(key) ?? null;
    if (f) seen.add(key);
    addTotal(b.heads, f?.heads ?? null);
    if (!f) {
      out.push({ status: "missing_in_return", table: b.table, num: b.num, date: b.date, ctin: b.ctin, changes: [], filed: null, books: b, taxDiff: tax(b.heads), action: ACTION.add, gstinChanged: false });
      continue;
    }
    const changes: string[] = [];
    if (f.table !== b.table) changes.push(`Table ${f.table} → ${b.table}`);
    const gstinChanged = (f.ctin ?? "").toUpperCase() !== (b.ctin ?? "").toUpperCase();
    if (gstinChanged) changes.push(`Recipient GSTIN ${f.ctin ?? "none"} → ${b.ctin ?? "none"}`);
    if (f.date && f.date !== b.date) changes.push(`Date ${f.date} → ${b.date}`);
    if (f.noteType !== b.noteType) changes.push(`Note type ${f.noteType ?? "-"} → ${b.noteType ?? "-"}`);
    if (f.pos !== b.pos) changes.push(`Place of supply ${f.pos || "-"} → ${b.pos || "-"}`);
    if (f.rates.join(",") !== b.rates.join(",")) changes.push(`Rate ${f.rates.join("/")} → ${b.rates.join("/")}`);
    if (differs(f.value, b.value)) changes.push(`Value ${fmt(f.value)} → ${fmt(b.value)}`);
    if (differs(f.taxable, b.taxable)) changes.push(`Taxable value ${fmt(f.taxable)} → ${fmt(b.taxable)}`);
    for (const h of ["igst", "cgst", "sgst"] as const) {
      if (differs(f.heads[h], b.heads[h])) changes.push(`${h.toUpperCase()} ${fmt(f.heads[h])} → ${fmt(b.heads[h])}`);
    }
    if (!changes.length) { unchanged++; continue; }
    out.push({
      status: "changed", table: b.table, num: b.num, date: b.date, ctin: b.ctin, changes, filed: f, books: b,
      taxDiff: tax(b.heads) - tax(f.heads), action: gstinChanged ? ACTION.gstin : ACTION.amend, gstinChanged,
    });
  }
  for (const f of filed.docs) {
    if (seen.has(docKey(f.table, f.num))) continue;
    addTotal(null, f.heads);
    out.push({ status: "not_in_books", table: f.table, num: f.num, date: f.date, ctin: f.ctin, changes: [], filed: f, books: null, taxDiff: -tax(f.heads), action: ACTION.notInBooks, gstinChanged: false });
  }

  // B2CS is a summary by place of supply + rate — compared line against line.
  const k = (l: B2csLine) => `${l.pos}|${l.rate}`;
  const merge = (lines: B2csLine[]) => {
    const m = new Map<string, B2csLine>();
    for (const l of lines) {
      const cur = m.get(k(l)) ?? { pos: l.pos, rate: l.rate, taxable: 0, heads: { ...ZERO } };
      cur.taxable += l.taxable;
      cur.heads = { igst: cur.heads.igst + l.heads.igst, cgst: cur.heads.cgst + l.heads.cgst, sgst: cur.heads.sgst + l.heads.sgst };
      m.set(k(l), cur);
    }
    return m;
  };
  const fm = merge(filed.b2cs);
  const bm = merge(books.b2cs);
  const b2cs: B2csDiff[] = [];
  for (const key of new Set([...fm.keys(), ...bm.keys()])) {
    const f = fm.get(key) ?? null;
    const b = bm.get(key) ?? null;
    addTotal(b?.heads ?? null, f?.heads ?? null);
    const taxDiff = tax(b?.heads ?? ZERO) - tax(f?.heads ?? ZERO);
    const taxableDiff = (b?.taxable ?? 0) - (f?.taxable ?? 0);
    const headsDiffer = (["igst", "cgst", "sgst"] as const).some((h) => differs(f?.heads[h] ?? 0, b?.heads[h] ?? 0));
    if (!differs(taxableDiff, 0) && !headsDiffer) continue;
    const [pos, rate] = key.split("|");
    b2cs.push({ pos, rate: Number(rate), filed: f, books: b, taxDiff, taxableDiff });
  }
  b2cs.sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate);

  const order: Record<DiffStatus, number> = { changed: 0, missing_in_return: 1, not_in_books: 2 };
  out.sort((a, b) => order[a.status] - order[b.status] || a.date.localeCompare(b.date) || a.num.localeCompare(b.num));
  return { docs: out, b2cs, unchanged, taxDiff: total };
}

// ─── CSV ────────────────────────────────────────────────────────────────────

export const GSTR1_VS_BOOKS_HEADERS = [
  "Status", "Table", "Document no.", "Date", "Recipient GSTIN", "What changed",
  "Filed value", "Books value", "Filed taxable", "Books taxable", "Filed tax", "Books tax", "Tax difference", "What to do",
] as const;

const STATUS_LABEL: Record<DiffStatus, string> = {
  changed: "Changed after filing",
  missing_in_return: "Missing in filed return",
  not_in_books: "Not in books",
};

export function gstr1VsBooksCsv(r: Gstr1VsBooks): (string | number)[][] {
  const rows: (string | number)[][] = r.docs.map((d) => [
    STATUS_LABEL[d.status], d.table, d.num, d.date, d.ctin ?? "", d.changes.join("; "),
    d.filed?.value ?? "", d.books?.value ?? "", d.filed?.taxable ?? "", d.books?.taxable ?? "",
    d.filed ? tax(d.filed.heads) : "", d.books ? tax(d.books.heads) : "", d.taxDiff, d.action,
  ]);
  for (const l of r.b2cs) {
    rows.push([
      "B2CS total differs", "B2CS", `POS ${l.pos} @ ${l.rate}%`, "", "", `Taxable ${fmt(l.filed?.taxable ?? 0)} → ${fmt(l.books?.taxable ?? 0)}`,
      "", "", l.filed?.taxable ?? 0, l.books?.taxable ?? 0, l.filed ? tax(l.filed.heads) : 0, l.books ? tax(l.books.heads) : 0, l.taxDiff,
      ACTION.amend,
    ]);
  }
  return rows;
}
