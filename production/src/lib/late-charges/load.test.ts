import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadLateCharges, loadLateFeeLevel } from "./load";

type Row = Record<string, unknown>;

/** A tiny in-memory PostgREST stand-in: select / eq / in / not-null / order / range / maybeSingle. */
function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
      in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      gte: (c: string, v: string) => { rows = rows.filter((r) => typeof r[c] === "string" && (r[c] as string) >= v); return q; },
      not: (c: string) => { rows = rows.filter((r) => r[c] !== null && r[c] !== undefined); return q; },
      order: () => q,
      limit: () => q,
      range: (a: number, b: number) => Promise.resolve({ data: rows.slice(a, b + 1), error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (res: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const T = "t1";
const base = {
  tenants: [{ id: T, late_fee_enabled: false, late_fee_enabled_at: null, late_interest_pct: 18, late_fee_flat: 500, late_fee_grace_days: 0, late_interest_registered_only: true }],
  invoices: [
    { id: "INV-A", tenant_id: T, customer_id: "c1", customer_name: "A Co", quote_id: "Q-A", amount: 100000, net_payable: 100000, paid_amount: 0, status: "pending", due_date: "2026-09-01", tax_rate: 18, customer_gstin: "07AABCA1234A1Z5", adjusted_advances: [] },
    { id: "INV-B", tenant_id: T, customer_id: "c2", customer_name: "B Co", quote_id: "Q-B", amount: 50000, net_payable: 50000, paid_amount: 0, status: "pending", due_date: "2026-09-01", tax_rate: 18, customer_gstin: null, adjusted_advances: [] },
  ],
  subscriptions: [{ id: "s1", quote_id: "Q-A", customer_id: "c1" }],
  customers: [{ id: "c1", gstin: "07AABCA1234A1Z5" }, { id: "c2", gstin: null }],
  payments: [] as Row[],
  debit_notes: [] as Row[],
  late_charge_bills: [] as Row[],
  late_fee_overrides: [] as Row[],
};

describe("loadLateCharges (wiring)", () => {
  it("company off + one customer on → only that customer's invoice is charged", async () => {
    const db = fakeDb({ ...base, late_fee_overrides: [{ tenant_id: T, entity_type: "customer", entity_id: "c1", mode: "on", waived: false, waive_reason: null, updated_at: "2026-08-01T00:00:00Z" }] });
    const rows = await loadLateCharges(db, {}, "2026-10-01");
    const a = rows.find((r) => r.invoiceId === "INV-A")!;
    const b = rows.find((r) => r.invoiceId === "INV-B")!;
    expect(a.effective).toMatchObject({ on: true, source: "customer" });
    expect(a.view.toBill).toBe(500 + 1479);
    expect(b.effective).toMatchObject({ on: false, source: "company" });
    expect(b.view.toBill).toBe(0);
  });

  it("subscription off beats customer on; unregistered customer gets the fee only", async () => {
    const db = fakeDb({
      ...base,
      tenants: [{ ...base.tenants[0], late_fee_enabled: true }],
      late_fee_overrides: [
        { tenant_id: T, entity_type: "customer", entity_id: "c1", mode: "on", waived: false, waive_reason: null, updated_at: "2026-08-01T00:00:00Z" },
        { tenant_id: T, entity_type: "subscription", entity_id: "s1", mode: "off", waived: false, waive_reason: null, updated_at: "2026-08-01T00:00:00Z" },
      ],
    });
    const rows = await loadLateCharges(db, {}, "2026-10-01");
    expect(rows.find((r) => r.invoiceId === "INV-A")!.effective).toMatchObject({ on: false, source: "subscription" });
    const b = rows.find((r) => r.invoiceId === "INV-B")!;
    expect(b.view).toMatchObject({ interestApplies: false, feeToBill: 500, interestToBill: 0 });
  });

  it("bulk scope: unpaid + recently paid only", async () => {
    const db = fakeDb({
      ...base,
      tenants: [{ ...base.tenants[0], late_fee_enabled: true }],
      invoices: [
        ...base.invoices,
        { ...base.invoices[0], id: "INV-OLD", status: "paid", paid_amount: 100000, paid_date: "2025-01-01" },
        { ...base.invoices[0], id: "INV-NEW", status: "paid", paid_amount: 100000, paid_date: "2026-09-20" },
      ],
    });
    const ids = (await loadLateCharges(db, {}, "2026-10-01")).map((r) => r.invoiceId).sort();
    expect(ids).toEqual(["INV-A", "INV-B", "INV-NEW"]);
  });

  it("level switch: invoice page shows the winning source", async () => {
    const db = fakeDb({ ...base, late_fee_overrides: [{ tenant_id: T, entity_type: "customer", entity_id: "c1", mode: "on", waived: false, waive_reason: null, updated_at: "2026-08-01T00:00:00Z" }] });
    const s = await loadLateFeeLevel(db, T, "invoice", "INV-A");
    expect(s.mode).toBe("default");
    expect(s.effective).toMatchObject({ on: true, source: "customer" });
  });
});
