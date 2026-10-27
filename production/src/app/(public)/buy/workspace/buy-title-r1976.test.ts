/**
 * DECISIONS 1 (R-1970): the /buy/workspace tab title is "Buy Google Workspace · <tenant name>",
 * read from the website tenant's row. Coordinator saw only "Buy Google Workspace" on localhost
 * after R-1975 moved the brand read to _parts/fetch-brand.ts — this pins the title to the tenant row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const tenant = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, reads: 0 }));
vi.mock("@/lib/website-tenant", () => ({ websiteTenantId: () => "t-1" }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    for (const k of ["from", "select", "eq", "abortSignal"]) q[k] = () => q;
    q.maybeSingle = async () => { tenant.reads++; return { data: tenant.row, error: null }; };
    return q;
  },
}));

import { generateMetadata } from "./page";
import { generateMetadata as thanksMetadata } from "./thanks/page";

const ROW = { name: "Tenant Seller Pvt Ltd", logo_url: null, gstin: "07AAAAA0000A1Z5", address: "Rohini", pin_code: null, state: null, state_code: "07", phone: null, email: null };

beforeEach(() => { tenant.row = ROW; tenant.reads = 0; });

describe("buy page titles carry the tenant name", () => {
  it("/buy/workspace → 'Buy Google Workspace · <tenant>'", async () => {
    const m = await generateMetadata();
    expect(m.title).toEqual({ absolute: "Buy Google Workspace · Tenant Seller Pvt Ltd" });
  });

  it("/buy/workspace/thanks → 'Order confirmed · <tenant>'", async () => {
    const m = await thanksMetadata();
    expect(m.title).toEqual({ absolute: "Order confirmed · Tenant Seller Pvt Ltd" });
  });

  it("no tenant row → no invented name", async () => {
    tenant.row = null;
    const m = await generateMetadata();
    expect(m.title).toEqual({ absolute: "Buy Google Workspace" });
  });
});
