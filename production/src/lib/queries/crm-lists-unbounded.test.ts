/**
 * R-294 — the CRM lists must not stop at 1000 rows either.
 *
 * R-046 / R-264 paged the money lists (billing-lists-unbounded.test.ts). The contact book,
 * the deprecated all-leads read, trials, imported contacts and the marketing hub still ended
 * in a bare `select` — PostgREST answers at most max_rows (1000) and says nothing, so the
 * 1001st contact simply is not in the book and a tracking link's lead count stops growing.
 *
 * Source scan, because the defect is an ABSENCE (a missing `.range()`, a missing tie-break)
 * that no hook test can see (L85). Every select statement inside the listed hooks must page
 * AND end its order on the unique `id`, or offset pages repeat/skip rows across a boundary.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** Comments stripped: prose about a removed pattern must not satisfy the scan (L46). */
const strip = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const HOOKS = [
  ["src/lib/queries/contacts.ts",          "useAllContacts",            7],  // R-535: + customer_contacts
  ["src/lib/queries/contacts.ts",          "useCelebrations",           1],
  ["src/lib/queries/leads.ts",             "useLeads",                  1],
  ["src/lib/queries/trials.ts",            "useTrials",                 1],
  ["src/lib/queries/trials.ts",            "useActiveTrials",           1],
  ["src/lib/queries/trials.ts",            "useTrialsExpiringSoon",     1],
  ["src/lib/queries/imported-contacts.ts", "useImportedContacts",       1],
  ["src/lib/queries/marketing-hub.ts",     "useSpendThisMonth",         1],
  ["src/lib/queries/marketing-hub.ts",     "useTrackingLinks",          2],
  ["src/lib/queries/marketing-hub.ts",     "useEmailSuppressions",      1],
  ["src/lib/queries/marketing-hub.ts",     "useReviewCustomers",        2],
] as const;

/** email_suppressions has no id: (tenant_id, email) is its key and RLS pins the tenant. */
const UNIQUE: Record<string, string> = { useEmailSuppressions: "email" };

function hookBody(file: string, fn: string): string {
  const src = strip(file);
  const start = src.indexOf(`export function ${fn}(`);
  expect(start, `${fn} not found in ${file}`).toBeGreaterThan(-1);
  const next = src.indexOf("export function", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

/** Each `.select(` up to the end of its statement (the next `;`). */
function selectStatements(body: string): string[] {
  return body.split(".select(").slice(1).map((tail) => tail.slice(0, tail.indexOf(";")));
}

describe("CRM lists page past the 1000-row cap (R-294)", () => {
  it.each(HOOKS)("%s %s pages every select", (file, fn, n) => {
    const body = hookBody(file, fn);
    const stmts = selectStatements(body);
    expect(stmts.length, `${fn}: expected ${n} list selects`).toBe(n);
    for (const s of stmts) {
      expect(s, `${fn}: a select with no .range()`).toContain(".range(");
      expect(s, `${fn}: a paged select whose order does not end on a unique column`)
        .toContain(`.order("${UNIQUE[fn] ?? "id"}"`);
    }
    expect(body).toMatch(/fetchAllRows(In)?\(/);
  });

  it.each([...new Set(HOOKS.map(([f]) => f))])("%s imports the shared pager", (file) => {
    expect(strip(file)).toContain("@/lib/ops/fetch-all");
  });
});
