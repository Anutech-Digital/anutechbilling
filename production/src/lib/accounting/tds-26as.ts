/**
 * Form 26AS (TRACES text) aur AIS (JSON) padh kar TDS receivable se milana.
 *
 * ─── KYUN ───────────────────────────────────────────────────────────────────
 * Customer TDS kaat kar kam paisa deta hai; wo TDS hamara tabhi hai jab usne sarkar me
 * jama kiya ho aur wo hamare 26AS me dikhe. Ab tak har row haath se "Verified on 26AS"
 * tick hoti thi — koi file se milata hi nahi tha. Yahan: file padho → har 26AS entry ko
 * ek khuli receivable se jodo (deductor TAN + raqam + FY) → user dekh kar confirm kare.
 * Match browser me hi hota hai; file (jisme deductors ke TAN/naam hain) server par nahi
 * jaati. Server par sirf confirm hui ids jaati hain (tds_mark_26as_verified RPC).
 *
 * ─── FORMAT KITNA PAKKA HAI ────────────────────────────────────────────────
 * Reasoned, not observed: dono parser synthetic fixtures par test hain, asli TRACES/AIS
 * file par nahi. 26AS text '^' se alag hota hai, PART-I me pehle deductor ki summary row
 * (Sr, naam, TAN … teen totals) aur uske neeche '^' se shuru hoti transaction rows
 * (Sr, section, transaction date, booking status, booking date, remark, teen raqam).
 * AIS JSON ka schema sarkar publish nahi karti, isliye wo parser naam dekh kar dhoondhta
 * hai (TAN, tax deducted, date, section). Kuch na mile to CHUP-CHAAP khaali list nahi —
 * saaf error, taaki "26AS me kuch nahi" aur "file samjhi nahi" ek jaise na dikhein (§2).
 *
 * ─── PAISE ──────────────────────────────────────────────────────────────────
 * 26AS me raqam paise ke saath aati hai (1000.50). DB me poore rupees hain (AGENTS.md §1).
 * Isliye yahan andar paise (integer) me ginte hain aur milaan ₹1 ki chhoot se hota hai
 * (s.288B rounding) — ek hi jagah, ek hi unit.
 */
import { utcDateISO, fyStartYear, fyCodeOfYear } from "@/lib/dates/ist";

export type BookingStatus = "F" | "P" | "U" | "O" | "M" | "Z" | null;

export interface TdsCreditEntry {
  source: "26as" | "ais";
  deductorName: string | null;
  /** Deductor ka TAN, upper-case. */
  tan: string;
  section: string | null;
  /** YYYY-MM-DD — deductor ka payment / credit date. */
  date: string;
  /** Paise. */
  amountPaidPaise: number | null;
  /** Paise — TDS deposited (26AS) ya tax deducted (AIS). */
  tdsPaise: number;
  /** 26AS "Status of Booking". F = Final (jama match). AIS me nahi hota → null. */
  booking: BookingStatus;
}

export interface ParsedCredits {
  source: "26as" | "ais";
  /** Assessee PAN (hamara), agar file me mila. */
  pan: string | null;
  /** "2026-27" jaisa, agar file me mila. */
  financialYear: string | null;
  /** File creation / as-on date, YYYY-MM-DD, agar mila. */
  asOn: string | null;
  entries: TdsCreditEntry[];
}

export const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "20-May-2026", "20-05-2026", "20/05/2026", "2026-05-20" → "2026-05-20"; baaki null. */
export function parseIndianDate(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return valid(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})$/);
  if (m) {
    const mm = MONTHS[m[2].toLowerCase()];
    return mm ? valid(m[3], mm, m[1].padStart(2, "0")) : null;
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return valid(m[3], m[2].padStart(2, "0"), m[1].padStart(2, "0"));
  return null;
}

function valid(y: string, mo: string, d: string): string | null {
  const iso = `${y}-${mo}-${d}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || utcDateISO(t) !== iso ? null : iso;
}

/** "1,500.00" → 150000 paise. Khaali / "-" → null. Ajeeb text → null (0 nahi). */
export function parsePaise(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  const s = String(raw ?? "").replace(/[,\s₹]/g, "").replace(/^Rs\.?/i, "");
  if (!s || s === "-") return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

/* ═══ 26AS text (TRACES) ════════════════════════════════════════════════════ */

export function parse26asText(text: string): ParsedCredits {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let pan: string | null = null, financialYear: string | null = null, asOn: string | null = null;
  const entries: TdsCreditEntry[] = [];

  let inPartI = false;
  let deductor: { name: string | null; tan: string } | null = null;
  let headerCols: string[] | null = null;   // file header ke column naam, jab tak maan wali line na aaye
  let headerDone = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split("^").map((x) => x.trim());

    /* Header row ke naam, agli line ke maan — PAN / FY / file date. */
    if (!headerDone && !headerCols && /Permanent Account Number/i.test(line) && /Financial Year/i.test(line)) {
      headerCols = f.map((x) => x.toLowerCase());
      continue;
    }
    if (headerCols) {
      const cols = headerCols;
      const at = (re: RegExp) => { const i = cols.findIndex((h) => re.test(h)); return i >= 0 ? f[i] ?? null : null; };
      const p = (at(/permanent account number/) ?? "").toUpperCase();
      pan = PAN_RE.test(p) ? p : null;
      const fy = at(/financial year/);
      financialYear = fy && /^\d{4}-\d{2}$/.test(fy) ? fy : null;
      asOn = parseIndianDate(at(/file creation date/));
      headerCols = null;
      headerDone = true;
      continue;
    }

    /* Sirf PART-I (TDS u/s 192–196). PART-II (15G/15H), III (194B proviso), IV (TCS), … nahi. */
    const part = line.match(/^PART[\s-]*([IVX]+)\b/i);
    if (part) {
      inPartI = part[1].toUpperCase() === "I";
      deductor = null;
      continue;
    }
    if (!inPartI) continue;

    // Deductor summary: Sr^Name^TAN^…^Total paid^Total deducted^Total deposited
    if (/^\d+$/.test(f[0] ?? "") && TAN_RE.test((f[2] ?? "").toUpperCase())) {
      deductor = { name: f[1] || null, tan: f[2].toUpperCase() };
      continue;
    }
    // Transaction: ^Sr^Section^Txn date^Status^Booking date^Remark^Paid^Deducted^Deposited
    if (deductor && f[0] === "" && /^\d+$/.test(f[1] ?? "")) {
      const date = parseIndianDate(f[3]);
      const nums = f.slice(4).map(parsePaise).filter((x): x is number => x !== null);
      if (!date || nums.length < 2) continue;
      const deposited = nums[nums.length - 1];
      const paid = nums.length >= 3 ? nums[nums.length - 3] : null;
      const st = (f[4] ?? "").toUpperCase();
      entries.push({
        source: "26as",
        deductorName: deductor.name,
        tan: deductor.tan,
        section: f[2] || null,
        date,
        amountPaidPaise: paid,
        tdsPaise: deposited,
        booking: (["F", "P", "U", "O", "M", "Z"].includes(st) ? st : null) as BookingStatus,
      });
    }
  }

  if (entries.length === 0) {
    throw new Error(
      "No Form 26AS PART-I TDS entry was found in this file. Download 26AS from TRACES in 'Text' format " +
      "(unzip it to get the .txt) and upload it again — PDF or HTML does not work here.",
    );
  }
  return { source: "26as", pan, financialYear, asOn, entries };
}

/* ═══ AIS JSON ══════════════════════════════════════════════════════════════ */

type Obj = Record<string, unknown>;
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

function pick(o: Obj, test: (k: string) => boolean): unknown {
  for (const [k, v] of Object.entries(o)) if (test(norm(k))) return v;
  return undefined;
}

export function parseAisJson(input: string | unknown): ParsedCredits {
  let root: unknown;
  if (typeof input === "string") {
    try {
      root = JSON.parse(input.replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("This does not look like an AIS JSON file — the JSON could not be read. Download the AIS 'JSON' from the Compliance portal and upload it again.");
    }
  } else {
    root = input;
  }

  const entries: TdsCreditEntry[] = [];
  let pan: string | null = null, financialYear: string | null = null;

  const walk = (node: unknown, ctx: { tan: string | null; name: string | null }) => {
    if (Array.isArray(node)) { for (const x of node) walk(x, ctx); return; }
    if (!node || typeof node !== "object") return;
    const o = node as Obj;

    const tanRaw = pick(o, (k) => k === "tan" || k.startsWith("tanof") || k.endsWith("tan") && k.includes("deductor"));
    const tan = typeof tanRaw === "string" && TAN_RE.test(tanRaw.trim().toUpperCase()) ? tanRaw.trim().toUpperCase() : ctx.tan;
    const nameRaw = pick(o, (k) => k.includes("nameofdeductor") || k === "deductorname" || k === "name" && !!tanRaw);
    const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : ctx.name;

    if (!pan) {
      const p = pick(o, (k) => k === "pan" || k === "assesseepan");
      if (typeof p === "string" && PAN_RE.test(p.trim().toUpperCase())) pan = p.trim().toUpperCase();
    }
    if (!financialYear) {
      const fy = pick(o, (k) => k === "financialyear" || k === "fy");
      if (typeof fy === "string" && /^\d{4}-\d{2}$/.test(fy.trim())) financialYear = fy.trim();
    }

    const tax = parsePaise(pick(o, (k) => k === "tds" || k.includes("taxdeducted") || k.includes("tdsdeducted") || k.includes("tdsdeposited")));
    const date = parseIndianDate(String(pick(o, (k) => k.includes("date") && !k.includes("booking")) ?? ""));
    if (tan && tax !== null && date) {
      const sectionRaw = pick(o, (k) => k === "section" || k.includes("informationcode") || k === "infocode");
      const sec = typeof sectionRaw === "string" ? (sectionRaw.match(/\d{3}[A-Z]{0,3}/i)?.[0].toUpperCase() ?? null) : null;
      entries.push({
        source: "ais",
        deductorName: name,
        tan,
        section: sec,
        date,
        amountPaidPaise: parsePaise(pick(o, (k) => k.includes("amountpaid") || k.includes("amountcredited") || k.includes("paidcredited"))),
        tdsPaise: tax,
        booking: null,
      });
      return;
    }
    for (const v of Object.values(o)) walk(v, { tan, name });
  };
  walk(root, { tan: null, name: null });

  if (entries.length === 0) {
    throw new Error(
      "No TDS entry (with TAN + tax deducted + date) was found in this AIS JSON. The file may be encrypted " +
      "or a TIS — upload the JSON decrypted with the AIS utility, or the 26AS text file from TRACES.",
    );
  }
  return { source: "ais", pan, financialYear, asOn: null, entries };
}

/** File ka naam / pehla akshar dekh kar sahi parser. */
export function parseTdsCreditFile(fileName: string, text: string): ParsedCredits {
  const t = text.replace(/^\uFEFF/, "").trimStart();
  if (/\.json$/i.test(fileName) || t.startsWith("{") || t.startsWith("[")) return parseAisJson(t);
  return parse26asText(text);
}

/* ═══ Match ═════════════════════════════════════════════════════════════════ */

export interface ReceivableLike {
  id: string;
  customer_name: string;
  customer_tan: string | null;
  tds_amount: number;           // rupees
  payment_received_date: string;
  fiscal_year: string;          // "FY2627"
  status: string;
}

export interface CreditMatch {
  entry: TdsCreditEntry;
  receivable: ReceivableLike;
  /** Din ka farq — 26AS txn date vs hamara payment date. */
  dayGap: number;
}

export interface MatchResult {
  /** Khuli receivable (pending_cert / cert_received) jo 26AS se milti hai — confirm karne layak. */
  matched: CreditMatch[];
  /** Milti hai par pehle se verified / claimed — kuch karna nahi. */
  alreadyDone: CreditMatch[];
  /** Entry hai par booking F nahi (P/U/O…) — deductor ki filing adhoori; abhi verify nahi. */
  notFinal: TdsCreditEntry[];
  /** Same TAN + FY, raqam alag — customer se baat karni hai. */
  amountMismatch: { entry: TdsCreditEntry; receivable: ReceivableLike }[];
  /** 26AS me hai, hamare records me us TAN ki koi row nahi. */
  unknown: TdsCreditEntry[];
  /** File ke FY ki khuli receivable jo 26AS me nahi mili — customer ne jama nahi kiya (ya TAN galat). */
  missing: ReceivableLike[];
  /** Khuli receivable jiska TAN hi nahi — file se milaan ho hi nahi sakta. */
  noTan: ReceivableLike[];
}

const OPEN = new Set(["pending_cert", "cert_received"]);
const DONE = new Set(["verified_26as", "claimed"]);
const TOLERANCE_PAISE = 100; // ₹1 — s.288B rounding

/** "2026-05-20" → "FY2627" (tds_receivable.fiscal_year ka format). */
export function fyCodeOf(iso: string): string {
  return fyCodeOfYear(fyStartYear(iso));
}

function days(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export function matchCredits(entries: readonly TdsCreditEntry[], receivables: readonly ReceivableLike[]): MatchResult {
  const res: MatchResult = { matched: [], alreadyDone: [], notFinal: [], amountMismatch: [], unknown: [], missing: [], noTan: [] };
  const used = new Set<string>();
  const seenNotFinal = new Set<string>();
  const tanOf = (r: ReceivableLike) => (r.customer_tan ?? "").trim().toUpperCase();
  const knownTans = new Set(receivables.map(tanOf).filter(Boolean));
  const fysInFile = new Set(entries.map((e) => fyCodeOf(e.date)));

  /* Pehle wo entries jinka jodaa pakka hai (F / AIS), phir baaki — aur har entry apni sabse
     nazdeeki-tareekh wali receivable leti hai, ek receivable ek hi baar. */
  const ordered = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.tdsPaise - b.tdsPaise);
  for (const e of ordered) {
    if (!knownTans.has(e.tan)) { res.unknown.push(e); continue; }
    const fy = fyCodeOf(e.date);
    const sameTanFy = receivables.filter((r) => tanOf(r) === e.tan && r.fiscal_year === fy && !used.has(r.id));
    const amountOk = sameTanFy
      .filter((r) => Math.abs(r.tds_amount * 100 - e.tdsPaise) <= TOLERANCE_PAISE)
      .sort((a, b) => days(a.payment_received_date, e.date) - days(b.payment_received_date, e.date) || a.id.localeCompare(b.id));
    const best = amountOk[0];
    if (!best) {
      const near = [...sameTanFy].sort((a, b) => days(a.payment_received_date, e.date) - days(b.payment_received_date, e.date))[0];
      if (near) res.amountMismatch.push({ entry: e, receivable: near });
      else res.unknown.push(e);
      continue;
    }
    /* 26AS me hai par Final nahi — verify nahi, aur "missing" me bhi nahi (file me dikh rahi hai). */
    if (e.booking !== null && e.booking !== "F") { res.notFinal.push(e); seenNotFinal.add(best.id); continue; }
    used.add(best.id);
    const m = { entry: e, receivable: best, dayGap: days(best.payment_received_date, e.date) };
    if (OPEN.has(best.status)) res.matched.push(m);
    else if (DONE.has(best.status)) res.alreadyDone.push(m);
    else res.alreadyDone.push(m); // disputed / written_off: file se badalna nahi — user tay kare
  }

  for (const r of receivables) {
    if (!OPEN.has(r.status) || used.has(r.id) || seenNotFinal.has(r.id)) continue;
    if (!tanOf(r)) { res.noTan.push(r); continue; }
    if (fysInFile.has(r.fiscal_year) && !res.amountMismatch.some((x) => x.receivable.id === r.id)) res.missing.push(r);
  }
  return res;
}
