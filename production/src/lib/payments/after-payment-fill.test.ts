/* R-447 + R-407 — blanks the Record payment sheet fills after the payment is saved. */
import { describe, it, expect, vi } from "vitest";
import { fillCustomerStateFromQuote, saveDomainAfterPayment } from "./after-payment-fill";

type Rows = Record<string, Record<string, unknown> | null>;

/** A tiny stand-in for the Supabase query builder: reads come from `rows`, writes are logged. */
function fake(rows: Rows) {
  const updates: Array<{ table: string; patch: unknown; filters: string[] }> = [];
  const from = vi.fn((table: string) => {
    const filters: string[] = [];
    let patch: unknown = null;
    const q: Record<string, unknown> = {};
    q.select = () => (patch ? Promise.resolve({ data: [{ id: "x" }], error: null }) : q);
    q.eq = (c: string, v: unknown) => { filters.push(`${c}=${String(v)}`); return q; };
    q.is = (c: string, v: unknown) => { filters.push(`${c} is ${String(v)}`); return q; };
    q.or = (f: string) => { filters.push(f); return q; };
    q.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
    q.update = (p: unknown) => { patch = p; updates.push({ table, patch: p, filters }); return q; };
    return q;
  });
  return { client: { from } as never, from, updates };
}

describe("fillCustomerStateFromQuote (R-447)", () => {
  it("customer made from a lead with no state takes the quote's Place of supply", async () => {
    const f = fake({
      quotes: { customer_id: "c1", prospect_state_code: "07", prospect_state: "Delhi" },
      customers: { state_code: null, state: null, gstin: null },
    });
    expect(await fillCustomerStateFromQuote(f.client, "Q1")).toBe("filled");
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]).toMatchObject({ table: "customers", patch: { state_code: "07", state: "Delhi" } });
    expect(f.updates[0].filters).toContain("state_code.is.null,state_code.eq."); // the write only touches a blank
  });
  it("a customer that has a state is never overwritten", async () => {
    const f = fake({
      quotes: { customer_id: "c1", prospect_state_code: "07" },
      customers: { state_code: "06", state: "Haryana", gstin: null },
    });
    expect(await fillCustomerStateFromQuote(f.client, "Q1")).toBe("nothing_to_fill");
    expect(f.updates).toEqual([]);
  });
  it("no state on the quote → nothing guessed", async () => {
    const f = fake({ quotes: { customer_id: "c1", prospect_state_code: null }, customers: { state_code: null } });
    expect(await fillCustomerStateFromQuote(f.client, "Q1")).toBe("nothing_to_fill");
    expect(f.updates).toEqual([]);
  });
});

describe("saveDomainAfterPayment (R-407)", () => {
  it("a typed domain lands on the customer and the provisioning task — blanks only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fake({ quotes: { customer_id: "c1" } });
    expect(await saveDomainAfterPayment(f.client, { quoteId: "Q1", domain: "  FlowTest-Demo.in " }))
      .toEqual({ customer: true, task: true });
    expect(f.updates.map((u) => [u.table, u.patch])).toEqual([
      ["customers", { domain: "flowtest-demo.in" }],
      ["provisioning_tasks", { domain: "flowtest-demo.in" }],
    ]);
    expect(f.updates[0].filters).toContain("domain.is.null,domain.eq.");
    expect(f.updates[1].filters).toEqual(["quote_id=Q1", "domain is null"]);
  });
  it("blank domain → no write at all", async () => {
    const f = fake({ quotes: { customer_id: "c1" } });
    expect(await saveDomainAfterPayment(f.client, { quoteId: "Q1", domain: "  " })).toEqual({ customer: false, task: false });
    expect(f.from).not.toHaveBeenCalled();
  });
  it("no customer on the quote → only the task", async () => {
    const f = fake({ quotes: { customer_id: null } });
    await saveDomainAfterPayment(f.client, { quoteId: "Q1", domain: "acme.com" });
    expect(f.updates.map((u) => u.table)).toEqual(["provisioning_tasks"]);
  });
});
