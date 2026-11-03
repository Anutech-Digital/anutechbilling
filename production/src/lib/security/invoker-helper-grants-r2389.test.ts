/**
 * R-2389 (2 Nov 2026) — every helper a SECURITY INVOKER function calls must be EXECUTE-able by
 * authenticated on Cloud SQL.
 *
 * What happened: close_bank_account / reopen_bank_account (20261102134054_r2384) are invoker and
 * call public.ist_today(). ist_today came in 20260930172000 with no GRANT. Local Supabase gives
 * authenticated EXECUTE on every new function, Cloud SQL does not (R-401), so on staging Banking →
 * ₹0 FD → Close account was a 403 "permission denied for function ist_today". The R-401 scan
 * (invoker-function-grants.test.ts) checks the invoker function's OWN grant and what invoker
 * TRIGGERS call — not what an invoker RPC calls, and ist_today predates its 20261001 cut-off.
 *
 * The rule: for the latest definition of every `public.X(...)` from a migration dated 20261001+
 * that is NOT security definer, every other public function it calls (body or argument
 * defaults — a DEFAULT runs with the caller's rights) must either
 *   - be defined in supabase/migrations-archive (the original schema; the Cloud SQL setup,
 *     supabase/cloudsql/01b-grants-and-policies.sql, granted EXECUTE on all of it), or
 *   - hold a `grant execute … to authenticated` after all migrations, last grant/revoke wins,
 * unless the caller itself is never run by authenticated (EXEMPT_CALLERS, with a reason).
 * Pure: the mutation case removes the R-2389 grant and requires the exact staging finding.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const DIR = "supabase/migrations";
const ARCHIVE = "supabase/migrations-archive";
const FROM = "20261001";
const R2389 = "20261102184319_r2389_ist_today_grant.sql";

const EXEMPT_CALLERS: Record<string, string> = {
  customer_names_agree:
    "DEFINER_INTERNAL in invoker-function-grants.test.ts — only called inside match_existing_customer (definer).",
  subscription_dues_drift:
    "SERVICE_ROLE_ONLY in invoker-function-grants.test.ts — the manager's drift report, never the app.",
};

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

type Def = { file: string; args: string; body: string; definer: boolean };

function definitions(src: string): Array<{ name: string } & Omit<Def, "file">> {
  const out: Array<{ name: string } & Omit<Def, "file">> = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*(returns[\s\S]*?)\$([a-z_]*)\$([\s\S]*?)\$\4\$([^;]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out.push({
      name: m[1].toLowerCase(), args: m[2], body: m[5],
      definer: /security\s+definer/i.test(m[3] + " " + m[6]),
    });
  }
  return out;
}

function analyse(migrations: Array<[string, string]>, archive: string[]): string[] {
  const original = new Set<string>();
  for (const text of archive) for (const d of definitions(stripComments(text))) original.add(d.name);

  const latest = new Map<string, Def>();
  const granted = new Map<string, boolean>();
  for (const [file, raw] of migrations) {
    const src = stripComments(raw);
    for (const d of definitions(src)) latest.set(d.name, { file, args: d.args, body: d.body, definer: d.definer });
    const g = /\b(grant|revoke)\s+(?:execute|all(?:\s+privileges)?)\s+on\s+function\s+([\s\S]*?)\s+(to|from)\s+([^;]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = g.exec(src))) {
      if (!/\bauthenticated\b/i.test(m[4])) continue;
      for (const x of m[2].matchAll(/public\.([a-z0-9_]+)/gi)) granted.set(x[1].toLowerCase(), m[1].toLowerCase() === "grant");
    }
  }

  const names = [...latest.keys()];
  const findings: string[] = [];
  for (const [name, d] of latest) {
    if (d.definer || d.file.slice(0, FROM.length) < FROM || EXEMPT_CALLERS[name]) continue;
    const text = d.body + " " + d.args;
    for (const callee of names) {
      if (callee === name || original.has(callee) || granted.get(callee)) continue;
      if (new RegExp(`(^|[^a-z0-9_.])(public\\.)?${callee}\\s*\\(`, "i").test(text)) {
        findings.push(`${name} (${d.file}) calls ${callee}() — not granted to authenticated`);
      }
    }
  }
  return findings.sort();
}

const migrations: Array<[string, string]> = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql")).sort()
  .map((f) => [f, readFileSync(`${DIR}/${f}`, "utf8")]);
const archive = readdirSync(ARCHIVE).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(`${ARCHIVE}/${f}`, "utf8"));

describe("R-2389 invoker helpers are granted to authenticated (Cloud SQL)", () => {
  it("no invoker function calls a helper authenticated cannot EXECUTE", () => {
    expect(analyse(migrations, archive)).toEqual([]);
  });

  it("the R-2389 migration grants the three date helpers", () => {
    const text = readFileSync(`${DIR}/${R2389}`, "utf8");
    expect(text).toMatch(/grant execute on function public\.ist_today\(\) to authenticated/);
    expect(text).toMatch(/grant execute on function public\.indian_fiscal_year\(date\) to authenticated/);
    expect(text).toMatch(/grant execute on function public\.salary_expense_date\(text, date\) to authenticated/);
  });

  it("mutation: without the R-2389 grant the scan finds the staging 403", () => {
    const without = migrations.filter(([f]) => f !== R2389);
    const found = analyse(without, archive);
    expect(found).toContain(
      "close_bank_account (20261102134054_r2384_close_bank_account.sql) calls ist_today() — not granted to authenticated",
    );
  });
});
