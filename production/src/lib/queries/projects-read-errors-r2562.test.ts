/**
 * R-2562 (7 Nov 2026, found in R-2559's code review): the project-receivables read behind
 * Companies "To collect", the Renewals dues line and the dashboard Collections card dropped each
 * read's `error` and added up whatever came back. A failed read gave `{}` — every page then showed
 * the project money as ₹0 (or a total short by it) with no warning.
 *
 * Owner's path: a project invoice is unpaid, the project_milestones read fails → the read must
 * FAIL (so the page shows "Project invoices couldn't be read — Try again"), never return {} / ₹0.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => { throw new Error("not in this test"); } }));

import { readProjectReceivablesByCustomer } from "./projects";
import { subscriptionDuesLine, toChaseSummary } from "@/lib/accounting/receivables-due";

type Rows = Record<string, unknown>[];
type Table = { rows?: Rows; error?: { message: string } };

/** A PostgREST stand-in: from(t).select().order().range(from, to) → that table's page or its error. */
function fakeClient(tables: Record<string, Table>) {
  return {
    from(name: string) {
      const t = tables[name] ?? { rows: [] };
      const q = {
        select: () => q,
        order: () => q,
        range: (from: number, to: number) =>
          Promise.resolve(t.error ? { data: null, error: t.error } : { data: (t.rows ?? []).slice(from, to + 1), error: null }),
      };
      return q;
    },
  } as unknown as Parameters<typeof readProjectReceivablesByCustomer>[0];
}

const OK = {
  project_sales: { rows: [{ id: "p1", customer_id: "c1" }] },
  project_milestones: { rows: [{ project_id: "p1", total_amount: 23109, invoice_id: "inv1" }] },
  project_payments: { rows: [] },
};

describe("R-2562 — project receivables read surfaces its error", () => {
  it("adds up an unpaid project invoice when every read works", async () => {
    await expect(readProjectReceivablesByCustomer(fakeClient(OK))).resolves.toEqual({ c1: 23109 });
  });

  for (const table of ["project_sales", "project_milestones", "project_payments"] as const) {
    it(`a failed ${table} read throws — never {} (₹0) or a short total`, async () => {
      const broken = { ...OK, [table]: { error: { message: "permission denied" } } };
      await expect(readProjectReceivablesByCustomer(fakeClient(broken))).rejects.toMatchObject({ message: "permission denied" });
    });
  }

  it("reads past PostgREST's 1000-row cap (a capped sum is the same wrong number)", async () => {
    const projects = Array.from({ length: 1001 }, (_, i) => ({ id: `p${i}`, customer_id: "c1" }));
    const ms = projects.map((p) => ({ project_id: p.id, total_amount: 1, invoice_id: `i-${p.id}` }));
    const out = await readProjectReceivablesByCustomer(fakeClient({
      project_sales: { rows: projects }, project_milestones: { rows: ms }, project_payments: { rows: [] },
    }));
    expect(out).toEqual({ c1: 1001 });
  });
});

/** Source with comments stripped — prose about a thing must not satisfy a scan for it. */
function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("R-2562 — pages say the project money could not be read, never ₹0 / a short total", () => {
  it("Renewals: the line names the failed read and NOT the Companies figure (it would be short by the project money)", () => {
    const all = toChaseSummary([{ customer_id: "a", outstanding_amount: 2_000 }, { customer_id: "b", outstanding_amount: 10_000 }]);
    const line = subscriptionDuesLine(all, 2_000, true)!;
    expect(line).toBe("₹2,000 unpaid on these renewals · Project invoices couldn't be read");
    expect(line).not.toMatch(/Has receivables/);
  });
  it("Renewals: says it even when nothing else is owed", () => {
    expect(subscriptionDuesLine(toChaseSummary([]), 0, true)).toBe("No renewal unpaid · Project invoices couldn't be read");
  });
  it("Renewals page offers Try again for the project read", () => {
    const src = code("src/app/(app)/renewals/page.tsx");
    expect(src).toMatch(/projRecvQ\.isError && \([\s\S]{0,300}projRecvQ\.refetch\(\)[\s\S]{0,80}Try again/);
  });
  it("Companies: the To collect tile and the rows show — on a failed read; the line names it with Try again", () => {
    const src = code("src/app/(app)/customers/page.tsx");
    expect(src).toContain('owedUnread ? "—" : rupee(totalReceivables');
    expect(src).toContain('owedUnread ? "—" : rupee(0)');
    expect(src).toContain('receivable <= 0 && owedUnread ? "—" : rupee(receivable)');
    expect(src).toMatch(/data-testid="to-collect-unread"[\s\S]{0,200}Try again/);
    expect(src).toContain("PROJECT_INVOICES_UNREAD");
  });
  it("Dashboard: the Collections card waits on the project read and shows its error (R-2239)", () => {
    const src = code("src/app/(app)/dashboard/page.tsx");
    expect(src).toContain("loadView(subscriptionsQ, projRecvQ)");
    expect(src).toMatch(/moneyQueries = \[[^\]]*projRecvQ/);
  });
});

describe("R-2562 — no money read in lib/queries/projects.ts drops its error", () => {
  it("every `{ data: x }` read also takes its error (useProjectSourceLead is a decoration, R-008)", () => {
    const src = code("src/lib/queries/projects.ts");
    // A destructure that names data but not error: `{ data: foo }` followed by `}` or `,` with no `error` in the same braces.
    const bare = [...src.matchAll(/\{\s*data:\s*\w+\s*\}/g)].map((m) => m[0]);
    expect(bare).toEqual([]);
  });
});
