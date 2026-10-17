/**
 * R-1519 — scan: no money read may lean on .limit() past the gateway's cap, or read a whole
 * list in one request.
 *
 * The data gateway answers at most 1000 rows a request (src/server/postgrest/build.ts
 * MAX_ROWS) and says nothing when it cut the answer short. `.limit(2000)` comes back as
 * 1000 rows; a select with no range at all comes back as 1000 rows. Every money list read
 * therefore pages with fetchAllRows / fetchAllRowsIn (@/lib/ops/fetch-all): `.range()` inside
 * the page callback and an order that ends on a unique column.
 *
 * A read that is bounded by what it asks for (one row, one invoice's credit notes, the
 * staff list) is allowed only through BOUNDED below, each with the reason it cannot reach
 * 1000 rows. A new list read in these files must page, or argue its case there.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GATEWAY_MAX_ROWS = 1000;

/** Comments stripped: prose about a removed pattern must not satisfy (or trip) the scan. */
const strip = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const QUERIES_DIR = "src/lib/queries";
const GOOGLE_BILL_CHECK = [
  "src/app/(app)/accounting/google-bill-check/page.tsx",
  "src/app/(app)/accounting/google-bill-check/books.ts",
];

/**
 * `.limit(n)` above the cap outside the money files — not money screens, outside R-1519's
 * files. Listed so the scan covers every NEW file in src/lib/queries; each needs its own
 * card to page. Do not add to this list: page the read instead.
 */
const OVER_CAP_NOT_MONEY: Record<string, string> = {
  "src/lib/queries/ads.ts": "ad_spend_daily .limit(50000) — marketing dashboard, not the books",
  "src/lib/queries/feedback.ts": "feedback .limit(5000) — support inbox",
  "src/lib/queries/gbp.ts": "gbp_metrics_daily .limit(20000) — Google Business Profile metrics",
};

/** The money files whose every list read must page (R-1509 bank.ts has its own scan). */
const MONEY_FILES = [
  "src/lib/queries/payments-made.ts",
  "src/lib/queries/payment-runs.ts",
  "src/lib/queries/expenses.ts",
  "src/lib/queries/tds-receivable.ts",
  "src/lib/queries/payroll.ts",
  "src/lib/queries/loans-given.ts",
  "src/lib/queries/credit-notes.ts",
  ...GOOGLE_BILL_CHECK,
];

/**
 * Unpaged selects that are bounded by what they ask for. `match` is a substring of the
 * statement (from `.from(` to its `;`).
 */
const BOUNDED: { file: string; match: string; why: string }[] = [
  { file: "src/lib/queries/payments-made.ts", match: '.from("bank_accounts")', why: "the tenant's own bank accounts — a handful" },
  { file: "src/lib/queries/tds-receivable.ts", match: '.eq("payment_id"', why: "TDS on ONE customer payment — one row, two at most" },
  { file: "src/lib/queries/credit-notes.ts", match: '.eq("invoice_id"', why: "credit notes of ONE invoice — capped by its total" },
  { file: "src/lib/queries/payroll.ts", match: '.from("employees")', why: "the staff list — headcount, not history" },
  { file: "src/lib/queries/payroll.ts", match: '.from("employee_documents")', why: "documents of ONE employee" },
  { file: "src/lib/queries/payroll.ts", match: '.from("holidays")', why: "~20 holidays a year" },
  { file: "src/lib/queries/payroll.ts", match: '.eq("employee_id", employeeId!)', why: "ONE employee's payslips — 12 a year" },
  { file: "src/lib/queries/payroll.ts", match: '.from("statutory_dues_payments").select("amount, kind").eq("kind"', why: "ESI / PF challans of one kind — one a month" },
];

/** `.from("x")…;` statements of a file, with the index where each starts. */
function statements(src: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  const re = /\.from\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const end = src.indexOf(";", m.index);
    out.push({ at: m.index, text: src.slice(m.index, end === -1 ? undefined : end) });
  }
  return out;
}

const isWrite = (s: string) => /\.(insert|update|upsert|delete)\(/.test(s);
const isBounded = (s: string) =>
  /\.single\(|\.maybeSingle\(|head: true|\.eq\("id"/.test(s) ||
  // A cap BELOW the gateway's is a deliberate "top N"; `.limit(1000)` on a list is the bug
  // itself (payment runs offered only the first 1000 unpaid bills).
  [...s.matchAll(/\.limit\((\d+)\)/g)].some((m) => Number(m[1]) < GATEWAY_MAX_ROWS);

/**
 * Paged = the select sits in a fetchAllRows / fetchAllRowsIn page callback (`(from, to) =>`,
 * `(run, from, to) =>`, no `;` between the arrow and `.from(`) and that callback ends in
 * `.range(`.
 */
function isPaged(src: string, at: number, stmt: string): boolean {
  if (stmt.includes(".range(")) return true;
  const before = src.slice(Math.max(0, at - 300), at);
  const arrows = [...before.matchAll(/\((?:\w+, )?\w+, \w+\) =>/g)];
  if (!arrows.length) return false;
  const last = arrows[arrows.length - 1];
  if (before.slice((last.index ?? 0) + last[0].length).includes(";")) return false;
  return src.slice(at, at + 900).includes(".range(");
}

describe("no money read asks for more than the gateway's 1000 rows (R-1519)", () => {
  const files = [
    ...readdirSync(QUERIES_DIR).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.")).map((f) => path.posix.join(QUERIES_DIR, f)),
    ...GOOGLE_BILL_CHECK,
  ];

  it.each(files)("%s: no .limit() above 1000", (file) => {
    if (OVER_CAP_NOT_MONEY[file]) return;
    for (const m of strip(file).matchAll(/\.limit\((\d[\d_]*)\)/g)) {
      const n = Number(m[1].replace(/_/g, ""));
      expect(n, `${file}: .limit(${m[1]}) — the gateway returns 1000 and says nothing; page with fetchAllRows`).toBeLessThanOrEqual(GATEWAY_MAX_ROWS);
    }
  });

  it("the not-money exceptions still exist (remove an entry once its read is paged)", () => {
    for (const file of Object.keys(OVER_CAP_NOT_MONEY)) {
      const over = [...strip(file).matchAll(/\.limit\((\d[\d_]*)\)/g)].some((m) => Number(m[1].replace(/_/g, "")) > GATEWAY_MAX_ROWS);
      expect(over, `${file} no longer reads past the cap — drop it from OVER_CAP_NOT_MONEY`).toBe(true);
    }
  });
});

describe("every money list read pages with .range() (R-1519)", () => {
  it.each(MONEY_FILES)("%s", (file) => {
    const src = strip(file);
    for (const { at, text } of statements(src)) {
      if (!text.includes(".select(") || isWrite(text) || isBounded(text)) continue;
      if (BOUNDED.some((b) => b.file === file && text.includes(b.match))) continue;
      const line = src.slice(0, at).split("\n").length;
      expect(isPaged(src, at, text), `${file} (stripped) line ${line}: list read with no .range() — page it with fetchAllRows:\n${text.slice(0, 160)}`).toBe(true);
      // Offset pages over an order with ties can repeat or skip a row: end on a unique column.
      const region = src.slice(at, at + 900);
      expect(/\.order\("(id|doc_id)"/.test(region), `${file} line ${line}: paged read needs a unique tie-break (.order("id"))`).toBe(true);
    }
  });

  it("every BOUNDED entry still matches a read (no stale exceptions)", () => {
    for (const b of BOUNDED) {
      expect(statements(strip(b.file)).some((s) => s.text.includes(b.match)), `${b.file}: "${b.match}" — no such read any more`).toBe(true);
    }
  });
});
