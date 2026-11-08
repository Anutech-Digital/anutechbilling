/**
 * R-2416 — the webhook stamps fee_bearer on a captured payment from the policy in force.
 */
import { describe, expect, it } from "vitest";
import { onlineFeeForQuote, recordFeeBearer } from "./online-fee.server";

type Rows = Record<string, Record<string, unknown> | null>;
interface Update { table: string; patch: Record<string, unknown>; filters: [string, string, unknown][] }

/** A tiny stand-in for the admin client: maybeSingle() answers from `rows[table]`, update() is recorded. */
function fakeAdmin(rows: Rows, missingColumns = false) {
  const updates: Update[] = [];
  const from = (table: string) => {
    const filters: [string, string, unknown][] = [];
    let patch: Record<string, unknown> | null = null;
    const b = {
      select: () => b,
      update: (p: Record<string, unknown>) => { patch = p; return b; },
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return b; },
      is: (c: string, v: unknown) => { filters.push(["is", c, v]); return b; },
      maybeSingle: async () => missingColumns
        ? { data: null, error: { code: "42703", message: "column tenants.online_fee_bearer does not exist" } }
        : { data: rows[table] ?? null, error: null },
      then: (resolve: (v: { error: null }) => void) => {
        if (patch) updates.push({ table, patch, filters });
        resolve({ error: null });
      },
    };
    return b;
  };
  return { admin: { from } as never, updates };
}

const tenant = { online_fee_bearer: "customer", online_fee_rate_pct: 2, online_fee_waive_above: null, online_fee_line_text: null };

describe("recordFeeBearer (R-2416)", () => {
  it("customer pays by default → fee_bearer customer, fee_charged 0 (R-2417 charges it), only a row not yet stamped", async () => {
    const { admin, updates } = fakeAdmin({
      tenants: tenant,
      quotes: { amount: 11800, customer_id: "c1", invoice_id: null, online_fee_waived: false, online_fee_waive_reason: null },
      customers: { online_fee_override: null, online_fee_override_reason: null },
    });
    await recordFeeBearer(admin, "t1", "Q-1", "pay_1");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ table: "payments", patch: { fee_bearer: "customer", fee_charged: 0 } });
    expect(updates[0].filters).toEqual(expect.arrayContaining([
      ["eq", "tenant_id", "t1"], ["eq", "quote_id", "Q-1"], ["eq", "reference", "pay_1"], ["is", "fee_bearer", null],
    ]));
  });

  it("customer 'We absorb' → business", async () => {
    const { admin, updates } = fakeAdmin({
      tenants: tenant,
      quotes: { amount: 11800, customer_id: "c1", invoice_id: null, online_fee_waived: false },
      customers: { online_fee_override: "absorb", online_fee_override_reason: "Key account" },
    });
    await recordFeeBearer(admin, "t1", "Q-1", "pay_1");
    expect(updates[0].patch.fee_bearer).toBe("business");
  });

  it("the invoice's waiver counts for the quote's payment", async () => {
    const { admin } = fakeAdmin({
      tenants: tenant,
      quotes: { amount: 11800, customer_id: null, invoice_id: "INV-1", online_fee_waived: false },
      invoices: { online_fee_waived: true, online_fee_waive_reason: "Promised on call" },
    });
    expect(await onlineFeeForQuote(admin, "t1", "Q-1")).toMatchObject({ bearer: "business", reason: "bill_waived", note: "Promised on call" });
  });

  it("R-2598: capture reads the quote's tax_rate — a 0% (export / SEZ) quote's fee has no GST, an 18% quote's is unchanged", async () => {
    const zero = fakeAdmin({
      tenants: tenant,
      quotes: { amount: 11800, customer_id: null, invoice_id: null, online_fee_waived: false, tax_rate: 0 },
    });
    expect(await onlineFeeForQuote(zero.admin, "t1", "Q-1")).toMatchObject({ fee: 241, gst: 0, total: 241, payable: 12041 });
    const full = fakeAdmin({
      tenants: tenant,
      quotes: { amount: 11800, customer_id: null, invoice_id: null, online_fee_waived: false, tax_rate: 18 },
    });
    expect(await onlineFeeForQuote(full.admin, "t1", "Q-1")).toMatchObject({ fee: 242, gst: 44, total: 286, payable: 12086 });
  });

  it("before the migration (columns missing) → no write, no throw", async () => {
    const { admin, updates } = fakeAdmin({}, true);
    await recordFeeBearer(admin, "t1", "Q-1", "pay_1");
    expect(updates).toHaveLength(0);
  });
});
