/**
 * R-2567 (7 Nov 2026, R-2562's review): project-receipts.ts dropped two reads' errors.
 *  - After a bank receipt is booked, the instalment's invoice_id read: its error was dropped and
 *    the server's "already raised" refusal showed as "the invoice could not be raised". A failed
 *    read must neither cost the owner the invoice nor end in a silent no-invoice.
 *  - The tenant/customer state read for a new project: a failed read said "the state is not
 *    recorded" and sent the owner to fill in a state that was already there.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => { throw new Error("not in this test"); } }));

import { raiseInvoiceAfterPayment, readSupplyStates, INVOICE_NOT_CHECKED, INVOICE_NOT_RAISED } from "./project-receipts";

type Res = { data: unknown; error: { message: string; code?: string } | null };
type Db = Parameters<typeof raiseInvoiceAfterPayment>[0];

/** from(t).select().eq().single()/maybeSingle() → tables[t]; rpc(fn) → rpcs[fn] (and records the call). */
function fakeClient(tables: Record<string, Res>, rpcs: Record<string, Res> = {}) {
  const calls: string[] = [];
  const client = {
    from(name: string) {
      const res = tables[name] ?? { data: null, error: null };
      const q = { select: () => q, eq: () => q, single: () => Promise.resolve(res), maybeSingle: () => Promise.resolve(res) };
      return q;
    },
    rpc(fn: string) {
      calls.push(fn);
      return Promise.resolve(rpcs[fn] ?? { data: null, error: null });
    },
  };
  return { db: client as unknown as Db, calls };
}

describe("R-2567 raiseInvoiceAfterPayment — the milestone read's error is not dropped", () => {
  it("a failed milestone read is not read as 'no invoice': the raise still runs (server guards a second invoice) and returns its number", async () => {
    const { db, calls } = fakeClient(
      { project_milestones: { data: null, error: { message: "network down" } } },
      { raise_project_milestone_invoice: { data: "INV-1", error: null } },
    );
    await expect(raiseInvoiceAfterPayment(db, "m1")).resolves.toEqual({ invoiceId: "INV-1", warning: null });
    expect(calls).toEqual(["raise_project_milestone_invoice"]);
  });

  it("read failed and the server says the invoice is already raised (23505) → no warning, nothing new", async () => {
    const { db } = fakeClient(
      { project_milestones: { data: null, error: { message: "network down" } } },
      { raise_project_milestone_invoice: { data: null, error: { message: "Invoice INV-3 already raised for this milestone", code: "23505" } } },
    );
    await expect(raiseInvoiceAfterPayment(db, "m1")).resolves.toEqual({ invoiceId: null, warning: null });
  });

  it("read failed AND the raise failed → 'Payment booked, but this instalment's invoice couldn't be checked' (never a silent no-invoice)", async () => {
    const { db } = fakeClient(
      { project_milestones: { data: null, error: { message: "network down" } } },
      { raise_project_milestone_invoice: { data: null, error: { message: "network down" } } },
    );
    const r = await raiseInvoiceAfterPayment(db, "m1");
    expect(r.invoiceId).toBeNull();
    expect(r.warning?.text).toBe(INVOICE_NOT_CHECKED);
    expect(r.warning?.text).toMatch(/^Payment booked/);
  });

  it("no invoice yet → raises it and returns the number", async () => {
    const { db, calls } = fakeClient(
      { project_milestones: { data: { invoice_id: null }, error: null } },
      { raise_project_milestone_invoice: { data: "INV-7", error: null } },
    );
    await expect(raiseInvoiceAfterPayment(db, "m1")).resolves.toEqual({ invoiceId: "INV-7", warning: null });
    expect(calls).toEqual(["raise_project_milestone_invoice"]);
  });

  it("invoice already raised → raises nothing, no warning", async () => {
    const { db, calls } = fakeClient({ project_milestones: { data: { invoice_id: "INV-3" }, error: null } });
    await expect(raiseInvoiceAfterPayment(db, "m1")).resolves.toEqual({ invoiceId: null, warning: null });
    expect(calls).toEqual([]);
  });

  it("the raise itself fails → 'Payment booked, but the invoice could not be raised', never throws", async () => {
    const { db } = fakeClient(
      { project_milestones: { data: { invoice_id: null }, error: null } },
      { raise_project_milestone_invoice: { data: null, error: { message: "Company GSTIN missing" } } },
    );
    const r = await raiseInvoiceAfterPayment(db, "m1");
    expect(r.invoiceId).toBeNull();
    expect(r.warning?.text).toBe(INVOICE_NOT_RAISED);
  });
});

describe("R-2567 readSupplyStates — a failed state read throws, never 'state not recorded'", () => {
  it("both reads work → the two state codes", async () => {
    const { db } = fakeClient({
      tenants: { data: { state_code: "07" }, error: null },
      customers: { data: { state_code: "09" }, error: null },
    });
    await expect(readSupplyStates(db, "t1", "c1")).resolves.toEqual({ seller: "07", customer: "09" });
  });

  it("no customer picked → customer null, no customer read", async () => {
    const { db } = fakeClient({ tenants: { data: { state_code: "07" }, error: null } });
    await expect(readSupplyStates(db, "t1", null)).resolves.toEqual({ seller: "07", customer: null });
  });

  for (const table of ["tenants", "customers"] as const) {
    it(`a failed ${table} read throws its error`, async () => {
      const { db } = fakeClient({
        tenants: { data: { state_code: "07" }, error: null },
        customers: { data: { state_code: "07" }, error: null },
        [table]: { data: null, error: { message: "permission denied" } },
      });
      await expect(readSupplyStates(db, "t1", "c1")).rejects.toMatchObject({ message: "permission denied" });
    });
  }
});
