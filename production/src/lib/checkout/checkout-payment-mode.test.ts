/**
 * R-1502 (Pawan's staging report 1b088924): "we can't test the flow buying the domain or
 * hosting at all". Walked on localhost 22 Oct 2026: Standard hosting → cart → checkout →
 * details → tick terms → Pay ₹1,770 → "We couldn't place your order — Online payment isn't
 * set up yet. Please use 'Get a quote'." With no Razorpay secret the server only accepts a
 * SIMULATED payment, and the website checkout never asked for one — so no hosting or domain
 * order could reach /done on a laptop. The Workspace buy page already had the three modes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { checkoutPaymentMode, payButtonLabel, razorpayTestOffered } from "./checkout-payment-mode";

const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const PAGE = "src/app/(marketing)/checkout/page.tsx";
const LAYOUT = "src/app/(marketing)/checkout/layout.tsx";

describe("checkoutPaymentMode — the same three modes as the Workspace buy page", () => {
  it("Razorpay keys on a deployment → live (real Razorpay window)", () => {
    expect(checkoutPaymentMode({ razorpayConfigured: true, simulationAllowed: false })).toBe("live");
  });
  /* R-1769 (Pawan, 24 Oct 05:25 UTC): on localhost the checkout showed only "Pay ₹708" and
     Razorpay answered "Authentication failed". .env.local carries an rzp_test_ key pair; any
     laptop server that reads it (plain `npm run dev`, or test keys saved in local Settings)
     went "live" and hid Simulate payment — so the order could never reach /done. */
  it("R-1769: TEST keys on a laptop → still simulation, so the order reaches /done", () => {
    expect(checkoutPaymentMode({ razorpayConfigured: true, simulationAllowed: true })).toBe("simulation");
  });
  it("no keys on a laptop → simulation, so the order can be walked to /done", () => {
    expect(checkoutPaymentMode({ razorpayConfigured: false, simulationAllowed: true })).toBe("simulation");
  });
  it("no keys on a deployment → disabled (R-079: a deployed site never simulates)", () => {
    expect(checkoutPaymentMode({ razorpayConfigured: false, simulationAllowed: false })).toBe("disabled");
  });
});

describe("R-1769: the Razorpay TEST window stays one click away on a laptop with test keys", () => {
  it("offered only when keys are set AND simulation is allowed (a laptop, never a deployment)", () => {
    expect(razorpayTestOffered({ razorpayConfigured: true, simulationAllowed: true })).toBe(true);
    expect(razorpayTestOffered({ razorpayConfigured: true, simulationAllowed: false })).toBe(false);
    expect(razorpayTestOffered({ razorpayConfigured: false, simulationAllowed: true })).toBe(false);
  });
  it("the page sends simulate only when the person did not pick the Razorpay test window", () => {
    const page = code(PAGE);
    expect(page).toMatch(/simulate: paymentMode === "simulation" && !useRazorpayTest/);
    expect(page).toMatch(/razorpayTest &&/);
  });
});

describe("payButtonLabel", () => {
  it("says Pay for real money and Simulate for a test, with the amount", () => {
    expect(payButtonLabel("live", "₹1,770")).toBe("Pay ₹1,770");
    expect(payButtonLabel("simulation", "₹1,770")).toBe("Simulate payment · ₹1,770");
  });
});

describe("the checkout page uses the mode (owner's path: Pay on a laptop reaches /done)", () => {
  const page = code(PAGE);
  it("asks the server for a simulated payment in simulation mode", () => {
    expect(page).toMatch(/simulate: paymentMode === "simulation"/);
  });
  it("labels the button by mode and says no money is taken in a test", () => {
    expect(page).toMatch(/payButtonLabel\(paymentMode, rupee\(t\.payable\)\)/);
    expect(page).toMatch(/No money is taken/);
  });
  it("offers a quote instead of a Pay button that can only fail when payment is off", () => {
    expect(page).toMatch(/paymentMode === "disabled"/);
    expect(page).toMatch(/href="\/quote"/);
  });
  it("the layout reads the mode on the server, per request", () => {
    const layout = code(LAYOUT);
    expect(layout).toMatch(/loadCheckoutPaymentSetup\(\)/);
    expect(layout).toMatch(/razorpayTest=\{razorpayTest\}/);
    expect(layout).toMatch(/<PaymentModeProvider mode=\{/);
    expect(layout).toMatch(/export const dynamic = "force-dynamic"/);
  });
});

/* R-1502, second wall on the same walk: with the simulated payment sent, the order stopped at
   "Could not start checkout. Please retry." — `npm run dev:local` blanks BUY_PAGE_TENANT_ID,
   so the website filed the lead under the LIVE tenant's id (DEV_BUY_PAGE_TENANT_ID), which a
   local database seeded from supabase/seed.sql does not have (leads_tenant_id_fkey). */
describe("dev:local sells under the tenant the local database has", () => {
  const devLocal = code("scripts/dev-local.mjs");
  const seed = readFileSync("supabase/seed.sql", "utf8");
  const seedTenant = /insert into public\.tenants[^;]*?\('([0-9a-f-]{36})'/i.exec(seed)?.[1];
  it("seed.sql creates a tenant", () => {
    expect(seedTenant).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("dev-local sets BUY_PAGE_TENANT_ID to that seed tenant", () => {
    expect(devLocal).toMatch(new RegExp(`BUY_PAGE_TENANT_ID: [^,\n]*"${seedTenant}"`));
  });
});
