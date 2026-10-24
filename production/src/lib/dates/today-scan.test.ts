/**
 * R-1653 — "today" must be the IST day, written one way: `istToday()` from @/lib/dates/ist.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day. IST is UTC+5:30, so anything saved
 * between 00:00 and 05:30 IST got YESTERDAY'S date — a TDS certificate marked received, an
 * expense row, a vault "expires today" check. On the 1st of a month that is the wrong month,
 * and on 1 April the wrong financial year. The ESLint rule (.eslintrc.json, S21) only covers
 * some folders; this scan covers all of src/, so a new one cannot creep in anywhere.
 *
 * Ratchet: the files below still carry one for a reason written next to them. The count may
 * only go DOWN — fixing one means lowering (or deleting) its entry here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");

/** "now" turned into a UTC calendar day: .slice(0,10) / .substring(0,10) / .split("T")[0]. */
const UTC_TODAY = /new Date\(\)\.toISOString\(\)\s*\.\s*(?:slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\)|split\(\s*["'`]T["'`]\s*\)\s*\[\s*0\s*\])/g;

const KNOWN: Record<string, { count: number; why: string }> = {
  "src/app/(app)/subscriptions/page.tsx": { count: 2, why: "CSV file names only, no stored date." },
  "src/components/features/settings/two-factor-card.tsx": { count: 1, why: "Label on the authenticator entry, not a business date." },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "generated") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Code lines only — a comment that explains the bug quotes the pattern on purpose. */
function codeHits(text: string): number {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) continue;
    n += (line.match(UTC_TODAY) ?? []).length;
  }
  return n;
}

const hits = new Map<string, number>();
for (const f of walk(SRC)) {
  const n = codeHits(readFileSync(f, "utf8"));
  if (n > 0) hits.set(relative(process.cwd(), f).split(sep).join("/"), n);
}

describe("'today' is istToday(), never the UTC day (R-1653)", () => {
  it("no new `new Date().toISOString().slice(0, 10)` anywhere in src/", () => {
    const over = [...hits].filter(([f, n]) => n > (KNOWN[f]?.count ?? 0)).map(([f, n]) => `${f}: ${n}`);
    expect(over, "Use istToday() from @/lib/dates/ist for today's date (IST), not the UTC day").toEqual([]);
  });

  it("money/accounting code (src/lib/queries, src/app/api) has none at all", () => {
    const money = [...hits.keys()].filter((f) => f.startsWith("src/lib/queries/") || f.startsWith("src/app/api/"));
    expect(money).toEqual([]);
  });

  it("the ratchet only goes down — a fixed file must leave KNOWN", () => {
    const stale = Object.entries(KNOWN).filter(([f, k]) => (hits.get(f) ?? 0) < k.count).map(([f]) => f);
    expect(stale, "lower or delete these KNOWN entries").toEqual([]);
  });

  it("catches the shapes it should, and skips comments", () => {
    expect(codeHits("const d = new Date().toISOString().slice(0, 10);")).toBe(1);
    expect(codeHits("const d = new Date().toISOString().split('T')[0];")).toBe(1);
    expect(codeHits("const d = new Date().toISOString().substring(0,10);")).toBe(1);
    expect(codeHits(" * was `new Date().toISOString().slice(0, 10)` before")).toBe(0);
    expect(codeHits("const d = istToday();")).toBe(0);
  });
});

/* R-1652: the subscription importers write start / renewal dates from a CSV's calendar dates. */
describe("subscription import never turns a calendar date into a UTC day (R-1652)", () => {
  it("components/features/subscriptions has no toISOString().slice(0, 10)", () => {
    const dir = join(SRC, "components", "features", "subscriptions");
    const bad = walk(dir).filter((f) => readFileSync(f, "utf8").split(/\r?\n/).some((l) => {
      const t = l.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) && /toISOString\(\)\.slice\(0,\s*10\)/.test(l);
    }));
    expect(bad.map((f) => relative(process.cwd(), f).split(sep).join("/"))).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   R-1716 — quote / invoice / note dates and their Age.

   The DATABASE side of "today": quotes.created_date, invoices.invoice_date,
   credit_notes.credit_date, debit_notes.debit_date and customers.since defaulted to
   CURRENT_DATE — the UTC day on Cloud SQL — so a quote saved at 00:30 IST was dated yesterday
   and its Age read "-1d". Migration 20261024013223_r1716_ist_document_dates sets them to the IST
   day; SQL test supabase/tests/r1716_ist_document_dates.test.sql proves it on a database.
   ───────────────────────────────────────────────────────────────────────────────────────── */
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const migrationFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const migrationText = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");

/** Drop `/* … *\/` and `--` comments so a comment that quotes CURRENT_DATE is not a hit. */
const stripSqlComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");

const DOCUMENT_DATES: [table: string, column: string][] = [
  ["quotes", "created_date"], ["invoices", "invoice_date"], ["credit_notes", "credit_date"],
  ["debit_notes", "debit_date"], ["customers", "since"],
];

/** The default the LAST migration gives table.column via ALTER … SET DEFAULT (null = none). */
function lastSetDefault(table: string, column: string): { file: string; expr: string } | null {
  const re = new RegExp(`alter\\s+table\\s+(?:only\\s+)?(?:public\\.)?${table}\\s+alter\\s+column\\s+${column}\\s+set\\s+default\\s+([^;]+);`, "gi");
  let last: { file: string; expr: string } | null = null;
  for (const f of migrationFiles) {
    for (const m of stripSqlComments(migrationText(f)).matchAll(re)) last = { file: f, expr: m[1].trim() };
  }
  return last;
}

describe("document dates default to the IST day, not CURRENT_DATE (R-1716)", () => {
  it.each(DOCUMENT_DATES)("%s.%s", (table, column) => {
    const d = lastSetDefault(table, column);
    expect(d, `${table}.${column}: no IST default migration`).not.toBeNull();
    expect(d!.expr).toMatch(/Asia\/Kolkata/);
    expect(d!.expr).not.toMatch(/current_date/i);
  });

  /* SQL functions that write a document / customer row with an explicit CURRENT_DATE do not use
     the column default. Ratchet over the LATEST definition of each function: the list may only
     go DOWN. R-1716 recorded nine money RPCs here; R-1816 (migration
     20261024022950_r1816_money_rpcs_ist_today) moved all nine to public.ist_today(), so the
     list is EMPTY — any hit now is a new regression. */
  const KNOWN_SQL_CURRENT_DATE = new Set<string>([]);
  const WRITES = /(invoices|credit_notes|debit_notes|quotes|customers)\b/i;

  function latestFunctionsUsingCurrentDate(): string[] {
    const latest = new Map<string, string>();
    for (const f of migrationFiles) {
      const sql = migrationText(f);
      const starts = [...sql.matchAll(/create\s+or\s+replace\s+function\s+(?:public\.)?"?(\w+)"?\s*\(/gi)];
      starts.forEach((m, i) => latest.set(m[1].toLowerCase(), sql.slice(m.index!, starts[i + 1]?.index ?? sql.length)));
    }
    return [...latest].filter(([, body]) => {
      const code = stripSqlComments(body);
      return /current_date/i.test(code) && WRITES.test(code);
    }).map(([name]) => name).sort();
  }

  it("no NEW SQL function stamps a document or customer with CURRENT_DATE", () => {
    const extra = latestFunctionsUsingCurrentDate().filter((n) => !KNOWN_SQL_CURRENT_DATE.has(n));
    expect(extra, "use public.ist_today() — CURRENT_DATE is the UTC day on Cloud SQL").toEqual([]);
  });

  it("the ratchet only goes down — a fixed function must leave the list", () => {
    const now = new Set(latestFunctionsUsingCurrentDate());
    expect([...KNOWN_SQL_CURRENT_DATE].filter((n) => !now.has(n))).toEqual([]);
  });
});

describe("Age is IST days and never negative (R-1716)", () => {
  it("/invoices 'invoice to raise' age reads toInvoiceAgeDays, not raw milliseconds", () => {
    const page = readFileSync(join(SRC, "app", "(app)", "invoices", "page.tsx"), "utf8");
    expect(page).not.toMatch(/Math\.floor\(\(now - new Date\(/);
    expect(page).toMatch(/toInvoiceAgeDays\(/);
  });

  it("Payments → dues age counts from the subscription's IST start day, not the UTC day of created_at", () => {
    const src = readFileSync(join(SRC, "lib", "queries", "payments.ts"), "utf8");
    expect(src).toMatch(/toIstDate\(s\.created_at\)/);
    expect(src).not.toMatch(/ymd\(startedAt\)/);
  });
});
