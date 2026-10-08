/**
 * POST /api/public/checkout/cart — the site cart's checkout (24 Sep 2026 rework).
 *
 * Pinned, each for a defect that was live before this date:
 *  - a domain line is priced from the LIVE lookup the search shows (decision 19),
 *    for the EXACT name, and refused — never charged a guess — when that lookup
 *    is unreachable, the name is taken, or no name was sent;
 *  - the coupon the cart page shows is the coupon that is charged;
 *  - a domain-only cart is labelled so the webhook files it as a domain order;
 *  - a hosting account defaults to the domain bought in the same cart;
 *  - an item with no server-side price (Workspace, SSL…) is refused, not charged.
 *
 * Runs through the route's simulation path (no Razorpay keys, NODE_ENV=test), so
 * the quote it would charge is observable without calling Razorpay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const inserts = vi.hoisted(() => ({ rows: [] as { table: string; row: Record<string, unknown> }[] }));
const rpc = vi.hoisted(() => vi.fn());
const catalog = vi.hoisted(() => ({ rows: [] as { id: string; name: string }[] }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      // tenant_secrets: select().eq().maybeSingle(). items: select().eq().eq() awaited.
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          eq: async () => ({ data: table === "items" ? catalog.rows : [], error: null }),
        }),
      }),
      insert: async (row: Record<string, unknown>) => {
        inserts.rows.push({ table, row });
        return { error: null };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc,
  }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: () => null }));
vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));

const lookupDomains = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domains/live-lookup", async (orig) => ({
  ...(await orig<typeof import("@/lib/domains/live-lookup")>()),
  lookupDomains,
}));

const startHostingTrial = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hosting/start-trial", () => ({ startHostingTrial }));
/* These tests are about the trial path itself, so DMS counts as connected; the paused case
   (DMS not set — 503, nothing started) is its own test below. */
const trialsOpen = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/dms-engine/trials", async (orig) => ({
  ...(await orig<typeof import("@/lib/dms-engine/trials")>()),
  trialsConfigured: () => trialsOpen.value,
}));

import { POST } from "./route";

const buyer = {
  fullName: "Test Buyer",
  companyName: "Test Co",
  email: "buyer@example.invalid",
  phone: "9999999999",
  simulate: true,
};

function req(body: Record<string, unknown>) {
  return new NextRequest("https://example.invalid/api/public/checkout/cart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    /* A paid order must say the buyer's state (R-091). Tests that are not about the state
       get Delhi; a test that gives a GSTIN or an address decides it that way instead. */
    body: JSON.stringify({ ...buyer, ...(body.stateCode || body.gstin || body.address ? {} : { stateCode: "07" }), ...body }),
  });
}

const quote = () => inserts.rows.find((r) => r.table === "quotes")?.row;
const address = { line1: "12 MG Road", city: "New Delhi", state: "Delhi", zipcode: "110001" };
const lead = () => inserts.rows.find((r) => r.table === "leads")?.row;

beforeEach(() => {
  inserts.rows = [];
  catalog.rows = [];
  startHostingTrial.mockReset().mockResolvedValue({ ok: true, leadId: "L-TRIAL", trialEnds: "2026-10-09T00:00:00.000Z" });
  rpc.mockReset().mockImplementation(async (name: string) =>
    name === "next_document_number" ? { data: "Q-TEST-0001", error: null } : { data: null, error: null },
  );
  lookupDomains.mockReset().mockResolvedValue({
    ok: true,
    base: "acme",
    source: "engine",
    domains: [
      { domain: "acme.in", available: true, price: 749, currency: "INR", years: 1, priceKnown: true },
      { domain: "acme.com", available: false, price: 0, currency: "INR", years: 1, priceKnown: false },
    ],
  });
});

describe("domain lines — live price, exact name", () => {
  it("charges the live price for the named domain and records the name on the line", async () => {
    const res = await POST(req({ address, lines: [{ sku: "domain:in", label: "acme.in", domain: "acme.in", qty: 1 }] }));
    expect(res.status).toBe(200);
    expect(lookupDomains).toHaveBeenCalledWith("acme", ["in"]);
    const q = quote()!;
    const items = q.line_items as { name: string; rate: number; domain?: string }[];
    expect(items).toEqual([expect.objectContaining({ name: "Domain acme.in — registration, 1 year", rate: 749, domain: "acme.in" })]);
    expect(q.amount).toBe(Math.round(749 * 1.18));
    expect(q.plan).toBe("domain-registration"); // not "cart-order", which the webhook filed as 'other'
    expect(String(lead()!.notes)).toContain("Domains to register: acme.in");
  });

  it("refuses when the registry can't be reached — no quote, no guessed price", async () => {
    lookupDomains.mockResolvedValueOnce({ ok: false });
    const res = await POST(req({ lines: [{ sku: "domain:in", label: "acme.in", domain: "acme.in", qty: 1 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/couldn't reach the domain registry/);
    expect(quote()).toBeUndefined();
  });

  it("refuses a taken name", async () => {
    const res = await POST(req({ lines: [{ sku: "domain:com", label: "acme.com", domain: "acme.com", qty: 1 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/acme\.com \(it is no longer available/);
  });

  it("refuses a domain line with no name (the old placeholder shape)", async () => {
    const res = await POST(req({ lines: [{ sku: "domain:in", label: "yourname.in", qty: 1 }] }));
    expect(res.status).toBe(400);
    expect(lookupDomains).not.toHaveBeenCalled();
  });

  it("refuses a name whose extension differs from its sku, and a quantity above one", async () => {
    let res = await POST(req({ lines: [{ sku: "domain:com", domain: "acme.in", qty: 1 }] }));
    expect(res.status).toBe(400);
    res = await POST(req({ lines: [{ sku: "domain:in", domain: "acme.in", qty: 2 }] }));
    expect(res.status).toBe(400);
  });
});

describe("a paid hosting order renews (25 Sep 2026: it created no subscription)", () => {
  type Line = { name: string; commitment?: string; domain?: string; hostingPlan?: string };

  it("a yearly hosting line carries commitment annual_yearly, so record_payment makes a subscription", async () => {
    const res = await POST(req({ domain: "acme.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1 }] }));
    expect(res.status).toBe(200);
    const [line] = quote()!.line_items as Line[];
    expect(line.commitment).toBe("annual_yearly");
  });

  it("a monthly hosting line carries commitment monthly", async () => {
    await POST(req({ domain: "acme.in", lines: [{ sku: "hosting:standard", cycle: "monthly", qty: 1 }] }));
    const [line] = quote()!.line_items as Line[];
    expect(line.commitment).toBe("monthly");
  });

  it("the hosting line names its account's domain, yet provisioning never tries to REGISTER it (R-032)", async () => {
    await POST(req({ domain: "acme.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1 }] }));
    const [line] = quote()!.line_items as Line[];
    expect(line.domain).toBe("acme.in"); // record_payment gives the subscription this line's own domain
    expect(quote()!.domain).toBe("acme.in");
    const { domainsInLines } = await import("@/lib/provisioning/products");
    expect(domainsInLines(quote()!.line_items)).toEqual([]); // nothing to register
  });

  it("links the tenant's own hosting catalogue item, so the subscription is filed under vendor hosting", async () => {
    catalog.rows = [{ id: "HOST-STARTER-x", name: "Starter Hosting" }, { id: "HOST-PLUS-x", name: "Plus Hosting" }];
    await POST(req({ domain: "acme.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1 }] }));
    const [line] = quote()!.line_items as { item_id?: string }[];
    expect(line.item_id).toBe("HOST-STARTER-x");
  });

  it("no matching catalogue item → the line is left unlinked and the sale still goes through", async () => {
    const res = await POST(req({ domain: "acme.in", lines: [{ sku: "hosting:standard", cycle: "yearly", qty: 1 }] }));
    expect(res.status).toBe(200);
    expect((quote()!.line_items as { item_id?: string }[])[0].item_id).toBeUndefined();
  });

  it("a domain line gets no commitment: a domain renews at its own price, not as a subscription here", async () => {
    await POST(req({
      address,
      lines: [{ sku: "domain:in", domain: "acme.in", qty: 1 }, { sku: "hosting:starter", cycle: "yearly", qty: 1 }],
    }));
    const lines = quote()!.line_items as Line[];
    expect(lines.find((l) => l.domain)?.commitment).toBeUndefined();
    expect(lines.find((l) => l.hostingPlan)?.commitment).toBe("annual_yearly");
  });
});

describe("hosting + domain in one cart", () => {
  it("the domain is ₹0 with yearly hosting, and the hosting goes on it when none was typed", async () => {
    const res = await POST(req({
      address,
      lines: [
        { sku: "domain:in", domain: "acme.in", qty: 1 },
        { sku: "hosting:starter", cycle: "yearly", qty: 1 },
      ],
    }));
    expect(res.status).toBe(200);
    const items = quote()!.line_items as { rate: number; domain?: string }[];
    expect(items.find((i) => i.domain)?.rate).toBe(0);
    expect(quote()!.amount).toBe(708); // ₹600 Starter year + 18%
    expect(lead()!.domain).toBe("acme.in");
  });
});

describe("coupon — charged exactly as the cart page shows it", () => {
  it("ANUTECH10 takes 10% off before GST", async () => {
    const res = await POST(req({ coupon: "anutech10", domain: "x.in", lines: [{ sku: "hosting:standard", cycle: "yearly", qty: 1 }] }));
    expect(res.status).toBe(200);
    const q = quote()!;
    expect(q.subtotal).toBe(1500);
    expect(q.discount_pct).toBe(10);
    expect(q.amount).toBe(Math.round(1350 * 1.18)); // 1593
  });

  /* R-329 (7 Oct 2026): domain + hosting + code. The coupon is for the FIRST payment only:
     the hosting line is charged 10% less, but carries renewal_rate = list, which
     record_payment files as the subscription's mrr (migration 20261007050000) — so the
     renewal is at list. The domain is charged in full. The invoice sums the charged rates. */
  it("domain + hosting + ANUTECH10: first payment off hosting only, renewal at list", async () => {
    const res = await POST(req({ coupon: "ANUTECH10", address, domain: "acme.in", lines: [
      { sku: "hosting:standard", cycle: "monthly", qty: 1 },
      { sku: "domain:in", label: "acme.in", domain: "acme.in", qty: 1 },
    ] }));
    expect(res.status).toBe(200);
    const q = quote()!;
    const items = q.line_items as { rate: number; list_rate?: number; renewal_rate?: number; commitment?: string; domain?: string; hostingPlan?: string }[];
    const hosting = items.find((i) => i.hostingPlan)!;
    const dom = items.find((i) => i.domain && !i.hostingPlan)!;
    expect(hosting.commitment).toBe("monthly");
    expect(hosting.list_rate).toBeGreaterThan(0);
    expect(hosting.renewal_rate).toBe(hosting.list_rate);
    expect(hosting.rate).toBe(Math.round(hosting.list_rate! * 0.9));
    expect(dom.rate).toBe(749);
    expect(dom.renewal_rate).toBeUndefined();
    expect(q.discount_pct).toBe(0);
    expect(q.subtotal).toBe(hosting.rate + 749);
    expect(q.amount).toBe(Math.round((hosting.rate + 749) * 1.18));
  });

  it("an unknown code counts for nothing, as on the cart page", async () => {
    await POST(req({ coupon: "FREE100", domain: "x.in", lines: [{ sku: "hosting:standard", cycle: "yearly", qty: 1 }] }));
    expect(quote()!.discount_pct).toBe(0);
    expect(quote()!.amount).toBe(1770);
  });
});

describe("items with no server-side price are refused, not charged", () => {
  it.each([
    [{ label: "Google Workspace Business Starter", qty: 5, cycle: "yearly" }],
    [{ label: "Positive SSL", qty: 1, cycle: "yearly" }],
    [{ sku: "ssl:positive", label: "Positive SSL", qty: 1 }],
  ])("%j", async (l) => {
    const res = await POST(req({ lines: [l] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/request a quote/);
    expect(quote()).toBeUndefined();
  });
});

describe("a domain is registered in the customer's own name (owner decision 22)", () => {
  it("refuses a domain cart with no address, and charges nothing", async () => {
    const res = await POST(req({ lines: [{ sku: "domain:in", domain: "acme.in", qty: 1 }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.needAddress).toBe(true);
    expect(body.error).toMatch(/in your name we need your address, city, state, PIN code/);
    expect(quote()).toBeUndefined();
  });

  it("refuses a PIN that is not six digits", async () => {
    const res = await POST(req({ address: { ...address, zipcode: "1100" }, lines: [{ sku: "domain:in", domain: "acme.in", qty: 1 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/PIN code/);
  });

  it("records the full registrant on the domain line, for the registration worker", async () => {
    const res = await POST(req({
      address,
      fullName: "Asha K Verma",
      phone: "+91 98765 43210",
      lines: [{ sku: "domain:in", domain: "acme.in", qty: 1 }],
    }));
    expect(res.status).toBe(200);
    const line = (quote()!.line_items as { registrant?: Record<string, unknown> }[])[0];
    expect(line.registrant).toEqual({
      firstName: "Asha",
      lastName: "K Verma",
      email: "buyer@example.invalid",
      phone: "9876543210",
      phoneCc: "91",
      companyName: "Test Co",
      address: { ...address, country: "IN" },
    });
  });

  it("a hosting-only cart needs no address", async () => {
    const res = await POST(req({ domain: "x.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1 }] }));
    expect(res.status).toBe(200);
    const line = (quote()!.line_items as { registrant?: unknown }[])[0];
    expect(line.registrant).toBeUndefined();
  });
});

describe("a free Starter trial in the cart (24 Sep 2026: no form in between)", () => {
  const trial = { sku: "hosting-trial:starter", label: "Starter hosting — 15-day free trial", qty: 1, cycle: "monthly" };

  it("starts the trial with the cycle shown — no quote, no document number, nothing charged", async () => {
    const res = await POST(req({ lines: [trial], domain: "acme.in" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, trial: true, leadId: "L-TRIAL" });
    expect(startHostingTrial).toHaveBeenCalledTimes(1);
    expect(startHostingTrial.mock.calls[0][1]).toMatchObject({ email: buyer.email, domain: "acme.in", cycle: "monthly" });
    expect(quote()).toBeUndefined();
    expect(rpc).not.toHaveBeenCalledWith("next_document_number", expect.anything());
  });

  it("a second trial is a 409 the checkout can name — the date and alreadyTrialled, not a bare 500 (1 Oct 2026)", async () => {
    startHostingTrial.mockResolvedValueOnce({ ok: false, alreadyTrialled: true, trialStartedOn: "30 Sept 2026", error: "You've already had a free hosting trial with us." });
    const res = await POST(req({ lines: [trial], domain: "acme.in" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "You've already had a free hosting trial with us.", alreadyTrialled: true, trialStartedOn: "30 Sept 2026" });
  });

  it("with DMS not connected a trial is PAUSED — 503 with the message, nothing started (go-live 2 Oct 2026)", async () => {
    trialsOpen.value = false;
    try {
      const res = await POST(req({ lines: [trial], domain: "acme.in" }));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ trialsPaused: true });
      expect(startHostingTrial).not.toHaveBeenCalled();
    } finally {
      trialsOpen.value = true;
    }
  });

  it("a trial that fails on our side stays a 500 with no alreadyTrialled flag", async () => {
    startHostingTrial.mockResolvedValueOnce({ ok: false, error: "Could not start your trial." });
    const res = await POST(req({ lines: [trial], domain: "acme.in" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not start your trial." });
  });

  it("a trial with other items is refused whole — no trial started, nothing charged", async () => {
    const res = await POST(req({ lines: [trial, { sku: "hosting:starter", qty: 1, cycle: "yearly" }], domain: "acme.in" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("checks out on its own");
    expect(startHostingTrial).not.toHaveBeenCalled();
    expect(quote()).toBeUndefined();
  });

  it("a trial on any plan but Starter is refused", async () => {
    const res = await POST(req({ lines: [{ ...trial, sku: "hosting-trial:plus" }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("only on the Starter plan");
    expect(startHostingTrial).not.toHaveBeenCalled();
  });

  it("a trial with a quantity other than 1 is refused, not rounded", async () => {
    const res = await POST(req({ lines: [{ ...trial, qty: 5 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("one hosting account");
    expect(startHostingTrial).not.toHaveBeenCalled();
  });

  /* Changed on purpose (owner, 30 Sep 2026): a trial is a hosting account and needs its
     domain. Until then this test asserted "a trial needs no domain". */
  it("a trial without a domain is refused, pointing at where to register one", async () => {
    const res = await POST(req({ lines: [trial] }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j).toMatchObject({ needDomain: true, next: "/domains" });
    expect(j.error).toMatch(/Register one first/);
    expect(startHostingTrial).not.toHaveBeenCalled();
  });

  it("a trial with a word that is not a domain is refused too", async () => {
    const res = await POST(req({ lines: [trial], domain: "mywebsite" }));
    expect(res.status).toBe(400);
    expect(startHostingTrial).not.toHaveBeenCalled();
  });

  it("a pasted site address is cleaned to the bare domain", async () => {
    await POST(req({ lines: [trial], domain: "https://www.Acme.in/" }));
    expect(startHostingTrial.mock.calls[0][1].domain).toBe("acme.in");
  });
});

describe("the company name is optional (29 Sep 2026)", () => {
  const hosting = { sku: "hosting:starter", label: "Starter hosting", qty: 1, cycle: "yearly" };

  it("a blank company → the buyer's own name is used on the quote and the lead", async () => {
    const res = await POST(req({ companyName: "", lines: [hosting], domain: "acme.in" }));
    expect(res.status).toBe(200);
    expect(quote()!.customer_name).toBe("Test Buyer");
    expect(lead()!.company).toBe("Test Buyer");
  });

  it("an omitted company is the same as a blank one", async () => {
    const { companyName: _omit, ...noCompany } = buyer;
    void _omit;
    const res = await POST(new NextRequest("https://example.invalid/api/public/checkout/cart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...noCompany, stateCode: "07", lines: [hosting], domain: "acme.in" }),
    }));
    expect(res.status).toBe(200);
    expect(quote()!.customer_name).toBe("Test Buyer");
  });

  it("a company that IS given is kept", async () => {
    await POST(req({ lines: [hosting], domain: "acme.in" }));
    expect(quote()!.customer_name).toBe("Test Co");
  });

  it("the trial gets the buyer's name when the company is blank", async () => {
    const res = await POST(req({ companyName: "  ", domain: "acme.in", lines: [{ sku: "hosting-trial:starter", label: "Starter trial", qty: 1, cycle: "yearly" }] }));
    expect(res.status).toBe(200);
    expect(startHostingTrial.mock.calls[0][1]).toMatchObject({ companyName: "Test Buyer" });
  });
});

describe("paid hosting needs a real domain (30 Sep 2026)", () => {
  const hosting = { sku: "hosting:starter", label: "Starter hosting", qty: 1, cycle: "yearly" };
  it("\"mywebsite\" is not a domain — refused, nothing charged, with where to get one", async () => {
    const res = await POST(req({ lines: [hosting], domain: "mywebsite" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ needDomain: true, next: "/domains" });
    expect(quote()).toBeUndefined();
  });
  it("no domain typed and none in the cart → refused", async () => {
    const res = await POST(req({ lines: [hosting] }));
    expect(res.status).toBe(400);
  });
});

describe("R-079 — place of supply on the lead, and the live-site guards", () => {
  const domainLine = { sku: "domain:in", label: "acme.in", domain: "acme.in", qty: 1 };
  const ENV = { ...process.env };
  afterEach(() => { process.env = { ...ENV }; });

  it("the address's state becomes the lead's GST state, which record_payment copies to the customer", async () => {
    const res = await POST(req({ address, lines: [domainLine] }));
    expect(res.status).toBe(200);
    expect(lead()).toEqual(expect.objectContaining({ state_code: "07", state: "Delhi", gstin: null }));
  });

  it("a checksum-valid GSTIN is stored and decides the state when no state was typed", async () => {
    const res = await POST(req({ gstin: "29aagcb1286q1z0", domain: "acme.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1 }] }));
    expect(res.status).toBe(200);
    expect(lead()).toEqual(expect.objectContaining({ gstin: "29AAGCB1286Q1Z0", state_code: "29", state: "Karnataka" }));
  });

  it("an invalid GSTIN is not stored and decides nothing — with no state chosen the order is refused, never guessed (R-091)", async () => {
    const res = await POST(req({ gstin: "07XXXXX0000X1ZZ", domain: "acme.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1 }] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ needState: true, error: expect.stringMatching(/choose your state.*Nothing was charged/) });
    expect(lead()).toBeUndefined();
    expect(quote()).toBeUndefined();
  });

  it("an invalid GSTIN with a chosen state: the GSTIN is not stored, the chosen state is", async () => {
    const res = await POST(req({ gstin: "07XXXXX0000X1ZZ", stateCode: "27", domain: "acme.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1 }] }));
    expect(res.status).toBe(200);
    expect(lead()).toEqual(expect.objectContaining({ gstin: null, state_code: "27", state: "Maharashtra" }));
  });

  it("R-091: a hosting-only order with no state is refused before anything is saved", async () => {
    const res = await POST(req({ stateCode: "", domain: "acme.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).needState).toBe(true);
    expect(quote()).toBeUndefined();
    expect(rpc).not.toHaveBeenCalledWith("next_document_number", expect.anything());
  });

  it("R-091: the chosen state goes on the lead, which record_payment copies to the customer the invoice reads", async () => {
    await POST(req({ stateCode: "07", domain: "acme.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1 }] }));
    expect(lead()).toEqual(expect.objectContaining({ state_code: "07", state: "Delhi" }));
  });

  it("a simulated payment is refused in production even with ALLOW_SIMULATED_CHECKOUT=1 — nothing saved", async () => {
    Object.assign(process.env, { NODE_ENV: "production", ALLOW_SIMULATED_CHECKOUT: "1", BUY_PAGE_TENANT_ID: "tenant-live" });
    const res = await POST(req({ address, lines: [domainLine] }));
    expect(res.status).toBe(503);
    expect(lead()).toBeUndefined();
    expect(quote()).toBeUndefined();
    expect(rpc).not.toHaveBeenCalledWith("record_payment", expect.anything());
  });

  it("production without BUY_PAGE_TENANT_ID refuses in words instead of using the hard-coded tenant", async () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.BUY_PAGE_TENANT_ID;
    const res = await POST(req({ address, lines: [domainLine] }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured on this site yet\. Nothing was charged/);
    expect(inserts.rows).toEqual([]);
  });

  it("outside production the dev tenant is still used", async () => {
    delete process.env.BUY_PAGE_TENANT_ID;
    const res = await POST(req({ address, lines: [domainLine] }));
    expect(res.status).toBe(200);
    expect(lead()!.tenant_id).toBe("fbb976f1-9090-4f10-9726-0901bd144e42");
  });
});

describe("a quote is dated by the IST day (R-026)", () => {
  it("an order at 01:00 IST on 2 Oct is dated 2 Oct, and valid 7 days from it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T19:30:00Z")); // = 2 Oct 2026, 01:00 IST
    try {
      await POST(req({ domain: "acme.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1 }] }));
      expect(quote()!.created_date).toBe("2026-10-02"); // the UTC day would be 1 Oct
      expect(quote()!.expires_date).toBe("2026-10-09");
    } finally {
      vi.useRealTimers();
    }
  });
});

/* R-156 (5 Oct 2026): a domain bought for several years. The term's price is the registry's
   own N-year total, re-read at checkout; a term it does not price is refused, never 1-year × N;
   yearly hosting still makes only the first year free. */
describe("domain terms — 1/2/3/5 years", () => {
  const multi = () => lookupDomains.mockResolvedValue({
    ok: true, base: "acme", source: "engine",
    domains: [{ domain: "acme.in", available: true, price: 749, currency: "INR", years: 1, priceKnown: true, prices: { "1": 749, "3": 2100 } }],
  });

  it("a 3-year line is charged the registry's 3-year total and carries years = 3", async () => {
    multi();
    const res = await POST(req({ address, lines: [{ sku: "domain:in", domain: "acme.in", qty: 1, years: 3 }] }));
    expect(res.status).toBe(200);
    const [line] = quote()!.line_items as { name: string; rate: number; years?: number }[];
    expect(line).toEqual(expect.objectContaining({ name: "Domain acme.in — registration, 3 years", rate: 2100, years: 3 }));
    expect(quote()!.amount).toBe(Math.round(2100 * 1.18));
  });

  it("a term the registry did not price is refused — nothing charged, no 749 × 5", async () => {
    multi();
    const res = await POST(req({ address, lines: [{ sku: "domain:in", domain: "acme.in", qty: 1, years: 5 }] }));
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain("5-year price couldn't be confirmed");
    expect(quote()).toBeUndefined();
  });

  it("with yearly hosting only the first year is free: 3 years pays 2100 − 749", async () => {
    multi();
    const res = await POST(req({
      address,
      lines: [{ sku: "domain:in", domain: "acme.in", qty: 1, years: 3 }, { sku: "hosting:starter", cycle: "yearly", qty: 1 }],
    }));
    expect(res.status).toBe(200);
    const items = quote()!.line_items as { rate: number; domain?: string; years?: number }[];
    const d = items.find((i) => i.domain);
    expect(d?.rate).toBe(2100 - 749);
    expect(d?.years).toBe(3);
  });

  it("no years sent → one year, as before", async () => {
    multi();
    await POST(req({ address, lines: [{ sku: "domain:in", domain: "acme.in", qty: 1 }] }));
    const [line] = quote()!.line_items as { rate: number; years?: number }[];
    expect(line).toEqual(expect.objectContaining({ rate: 749, years: 1 }));
  });
});
