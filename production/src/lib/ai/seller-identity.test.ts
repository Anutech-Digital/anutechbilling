/**
 * R-1929 — the AI agents sign with the reseller's own name and support desk, not the platform's.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickSellerIdentity, sellerIdentityLookup, loadSellerIdentity, UNKNOWN_SELLER_NAME } from "./seller-identity";
import { PLATFORM_OPERATOR } from "@/lib/platform";

const PLATFORM = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
/* The platform deployment sets the env names; a second reseller must still sign as itself. */
const ENV = {
  NODE_ENV: "production",
  BUY_PAGE_TENANT_ID: PLATFORM,
  SELLER_LEGAL_NAME: "PLATFORM CO PVT LTD",
  SUPPORT_EMAIL: "help@platform.example",
};

describe("pickSellerIdentity", () => {
  it("a second reseller signs with its own tenant name and email — never the env values", () => {
    const id = pickSellerIdentity(OTHER, { name: "Sharma Traders", email: "desk@sharma.example" }, ENV);
    expect(id).toEqual({ sellerName: "Sharma Traders", supportEmail: "desk@sharma.example" });
  });

  it("a reseller whose row could not be read signs neutrally, not as the platform", () => {
    const id = pickSellerIdentity(OTHER, null, ENV);
    expect(id).toEqual({ sellerName: UNKNOWN_SELLER_NAME, supportEmail: "" });
    expect(id.sellerName).not.toBe(ENV.SELLER_LEGAL_NAME);
  });

  it("the platform tenant keeps the env name and support desk (unchanged behaviour)", () => {
    const id = pickSellerIdentity(PLATFORM, { name: "Platform row", email: "owner@platform.example" }, ENV);
    expect(id).toEqual({ sellerName: "PLATFORM CO PVT LTD", supportEmail: "help@platform.example" });
  });

  it("the platform tenant without env falls back to its row name, then the platform constant", () => {
    const env = { NODE_ENV: "production", BUY_PAGE_TENANT_ID: PLATFORM };
    expect(pickSellerIdentity(PLATFORM, { name: "Platform row" }, env).sellerName).toBe("Platform row");
    expect(pickSellerIdentity(PLATFORM, null, env).sellerName).toBe(PLATFORM_OPERATOR.legalName);
  });
});

function fakeAdmin(rows: Record<string, { name: string; email: string }>) {
  let reads = 0;
  const admin = {
    from(table: string) {
      expect(table).toBe("tenants");
      let id = "";
      const q = {
        select: () => q,
        eq: (_col: string, v: string) => { id = v; return q; },
        maybeSingle: async () => { reads++; return { data: rows[id] ?? null, error: null }; },
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { admin, reads: () => reads };
}

describe("sellerIdentityLookup", () => {
  it("reads the tenant row (name, email) and remembers it per tenant", async () => {
    const { admin, reads } = fakeAdmin({ [OTHER]: { name: "Sharma Traders", email: "desk@sharma.example" } });
    const look = sellerIdentityLookup(admin, ENV);
    expect(await look(OTHER)).toEqual({ sellerName: "Sharma Traders", supportEmail: "desk@sharma.example" });
    await look(OTHER);
    expect(reads()).toBe(1);
  });

  it("loadSellerIdentity for the platform tenant still uses the env", async () => {
    const { admin } = fakeAdmin({ [PLATFORM]: { name: "Platform row", email: "owner@platform.example" } });
    expect((await loadSellerIdentity(admin, PLATFORM, ENV)).sellerName).toBe("PLATFORM CO PVT LTD");
  });
});

/* Wiring: every agent entry point asks the helper per tenant instead of a module-level env name. */
const ROUTES = [
  "src/app/api/cron/ai-reply-retry/route.ts",
  "src/app/api/cron/ai-sales-loop/route.ts",
  "src/app/api/v1/integrations/support-email-inbound/route.ts",
  "src/app/api/v1/integrations/support-whatsapp-inbound/route.ts",
  "src/app/api/webhooks/whatsapp/route.ts",
  "src/lib/inbound/ingest.ts",
];

describe("wiring — agents sign per tenant", () => {
  for (const rel of ROUTES) {
    it(`${rel} takes the seller name from the tenant via seller-identity`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src).toMatch(/from "@\/lib\/ai\/seller-identity"/);
      expect(src).not.toMatch(/process\.env\.SELLER_LEGAL_NAME/);
      expect(src).not.toMatch(/process\.env\.SUPPORT_EMAIL/);
      expect(src).not.toMatch(/sellerName:\s*"/);
    });
  }
});
