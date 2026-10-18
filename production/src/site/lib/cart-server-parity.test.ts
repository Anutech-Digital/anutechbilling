/**
 * R-1601: the cart's total must be the total the server charges.
 *
 * The cart used to fix each line's price when it was added, so "domain first, then a yearly
 * plan" showed the domain at full price while the server made it free (and "remove the plan"
 * the other way round) — and Pay said "The total has changed". The cart now derives the
 * yearly-hosting bundle on every render from the SAME helpers the server uses
 * (lib/checkout/hosting-bundle.ts). This test runs both on the same carts: cartTotals() in
 * the browser module, and runCartCheckout() — the real server route — with the registry,
 * the database and Razorpay faked. Their totals must be equal, to the rupee.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { LiveDomain } from "@/lib/domains/live-lookup";

/* ── The registry: fixed prices per TLD (1-year, and a 2-year total) ─────────────── */
const REG: Record<string, { one: number; two: number }> = {
  in: { one: 799, two: 1598 },
  com: { one: 1099, two: 2198 },
  ai: { one: 7999, two: 15998 },
};
vi.mock("@/lib/domains/live-lookup", async (orig) => {
  const real = await orig<typeof import("@/lib/domains/live-lookup")>();
  return {
    ...real,
    lookupDomains: vi.fn(async (name: string, tlds: readonly string[]) => ({
      ok: true,
      domains: tlds.map((tld): LiveDomain => ({
        domain: `${name}.${tld}`, available: true, price: REG[tld].one, currency: "INR", years: 1, priceKnown: true,
        prices: { "1": REG[tld].one, "2": REG[tld].two },
      })),
    })),
  };
});

/* ── The database and Razorpay: just enough for the route to reach its total ────── */
vi.mock("@/lib/supabase/server", () => {
  const chain = (result: unknown): unknown =>
    new Proxy(() => undefined, {
      get: (_t, p) => (p === "then" ? (res: (v: unknown) => unknown) => res(result) : () => chain(result)),
      apply: () => chain(result),
    });
  return {
    createAdminClient: () => ({
      from: (table: string) =>
        table === "tenant_secrets"
          ? chain({ data: { razorpay_key_id: "rzp_test_parity", razorpay_key_secret: "parity", razorpay_mode: "test" }, error: null })
          : chain({ data: [], error: null }),
      rpc: () => chain({ data: "Q-PARITY-1", error: null }),
    }),
  };
});
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: (s: unknown) => s }));
vi.mock("razorpay", () => ({
  default: class {
    orders = { create: async () => ({ id: "order_parity" }) };
  },
}));
vi.mock("@/lib/checkout/online-invoice.server", () => ({ issueInvoiceForOnlinePayment: vi.fn() }));
vi.mock("@/lib/hosting/start-trial", () => ({ startHostingTrial: vi.fn() }));

import { runCartCheckout } from "@/lib/checkout/cart-checkout";
import { cartTotals, type CartLine } from "./money";
import { paidHostingLine } from "./hosting-cart-line";
import { HOSTING_TIERS } from "./data/hosting-landing-v2";
import { MAILBOX_YR } from "./data/domains-landing";

beforeEach(() => {
  process.env.BUY_PAGE_TENANT_ID = "fbb976f1-9090-4f10-9726-0901bd144e42";
});

let n = 0;
const key = () => `k${++n}`;
const starter = HOSTING_TIERS.find((t) => t.name === "Starter")!;

/** A domain line exactly as the site's domain search adds it (DomainSearchDock). */
function domainLine(domain: string, years = 1): CartLine {
  const tld = domain.slice(domain.indexOf(".") + 1);
  const r = REG[tld];
  const yearPrices = { "1": r.one, "2": r.two };
  return {
    key: key(), label: domain, detail: `Domain registration · ${years} year${years === 1 ? "" : "s"}`,
    unitPrice: yearPrices[String(years) as "1" | "2"], qty: 1, unit: "year", cycle: "yearly",
    sku: `domain:${tld}`, domain, years, yearPrices,
  };
}
const hostingLine = (yearly = true): CartLine => ({ key: key(), qty: 1, ...paidHostingLine(starter, yearly) });
const mailboxLine = (qty: number): CartLine => ({
  key: key(), label: "Mailbox", detail: "Anutech Mail · billed yearly", unitPrice: MAILBOX_YR, qty, unit: "year", cycle: "yearly", sku: "mailbox:anutech",
});

/**
 * What the server charges for these lines, as the checkout page sends them: the first
 * plan's domain is the top-level `domain` field (pre-filled from the cart's domain),
 * every plan also carries its own `hostingDomain`.
 */
async function serverTotal(lines: CartLine[], planTyped: string[]): Promise<number> {
  const hosting = lines.filter((l) => (l.sku ?? "").startsWith("hosting:"));
  const body = {
    fullName: "Parity Test", email: "parity@example.com", phone: "9876543210", stateCode: "07",
    domain: planTyped[0] || undefined,
    lines: lines.map((l) => {
      const i = hosting.indexOf(l);
      return { sku: l.sku, label: l.label, qty: l.qty, cycle: l.cycle, domain: l.domain, ...(l.years && l.years > 1 ? { years: l.years } : {}), ...(i >= 0 ? { hostingDomain: planTyped[i] || undefined } : {}) };
    }),
    address: { line1: "1 Test Road", city: "Delhi", state: "Delhi", zipcode: "110001", country: "IN" },
  };
  const res = await runCartCheckout(new NextRequest("http://localhost/api/public/checkout/cart", { method: "POST" }), body, { kind: "site" });
  const json = (await res.json()) as { totalRupees?: number; error?: string };
  if (typeof json.totalRupees !== "number") throw new Error(`server refused: ${json.error}`);
  return json.totalRupees;
}

const cartTotal = (lines: CartLine[], planTyped?: string[]) => Math.round(cartTotals(lines, 0, planTyped).payable);

describe("cart total === server total (R-1601)", () => {
  it("domain first, then a yearly plan: the .in is free in the cart too", async () => {
    const lines = [domainLine("acme.in"), hostingLine()];
    expect(cartTotal(lines)).toBe(await serverTotal(lines, ["acme.in"]));
    expect(cartTotal(lines)).toBe(Math.round(Math.round(starter.yearlyTotal) * 1.18));
  });

  it("yearly plan first, then the domain: the same", async () => {
    const lines = [hostingLine(), domainLine("acme.in")];
    expect(cartTotal(lines)).toBe(await serverTotal(lines, ["acme.in"]));
  });

  it("the plan removed: the domain is charged again", async () => {
    const lines = [domainLine("acme.in")];
    expect(cartTotal(lines)).toBe(await serverTotal(lines, []));
    expect(cartTotal(lines)).toBe(Math.round(799 * 1.18));
  });

  it("a monthly plan frees nothing", async () => {
    const lines = [domainLine("acme.in"), hostingLine(false), mailboxLine(1)];
    expect(cartTotal(lines)).toBe(await serverTotal(lines, ["acme.in"]));
  });

  it(".ai with a yearly plan: charged in full", async () => {
    const lines = [domainLine("acme.ai"), hostingLine()];
    expect(cartTotal(lines)).toBe(await serverTotal(lines, ["acme.ai"]));
    expect(cartTotal(lines)).toBe(Math.round((7999 + Math.round(starter.yearlyTotal)) * 1.18));
  });

  it("plan on a domain the buyer already owns + a new domain in the cart: the new one is charged", async () => {
    const lines = [hostingLine(), domainLine("newname.in")];
    expect(cartTotal(lines, ["mine.com"])).toBe(await serverTotal(lines, ["mine.com"]));
    expect(cartTotal(lines, ["mine.com"])).toBe(Math.round((799 + Math.round(starter.yearlyTotal)) * 1.18));
  });

  it("10 mailboxes with one yearly plan: one free, nine charged", async () => {
    const lines = [hostingLine(), domainLine("acme.in"), mailboxLine(10)];
    expect(cartTotal(lines)).toBe(await serverTotal(lines, ["acme.in"]));
    expect(cartTotal(lines)).toBe(Math.round((Math.round(starter.yearlyTotal) + 9 * MAILBOX_YR) * 1.18));
  });

  it("a 2-year domain with a yearly plan: only the first year is free", async () => {
    const lines = [domainLine("acme.com", 2), hostingLine()];
    expect(cartTotal(lines)).toBe(await serverTotal(lines, ["acme.com"]));
  });

  it("two yearly plans, each on its own cart domain, one .ai", async () => {
    const lines = [hostingLine(), hostingLine(), domainLine("one.in"), domainLine("two.ai"), mailboxLine(3)];
    expect(cartTotal(lines, ["one.in", "two.ai"])).toBe(await serverTotal(lines, ["one.in", "two.ai"]));
  });
});
