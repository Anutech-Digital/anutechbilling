/** R-120 — the post-purchase emails and their wiring. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { customerSetupSteps, leadOwnerNextSteps } from "./workspace-onboarding";

const read = (rel: string) => readFileSync(join(__dirname, "../..", rel), "utf8");

describe("customer setup steps", () => {
  const t = customerSetupSteps({ domain: "acme.in", seats: 12, tierName: "Business Standard", contactName: "Rahul" });
  it("gives the exact DNS values the app's checker verifies", () => {
    expect(t).toContain("smtp.google.com   priority 1");
    expect(t).toContain("v=spf1 include:_spf.google.com ~all");
    expect(t).toContain("google-site-verification=");
    expect(t).toContain("_dmarc.acme.in");
    const dns = read("lib/dns/workspace-dns.ts");
    expect(dns).toContain("smtp.google.com");
    expect(dns).toMatch(/_spf\.google\.com/);
  });
  it("says who does each step, names the contact, and covers users + migration", () => {
    expect(t).toMatch(/you, 5 minutes/);
    expect(t).toMatch(/CREATE YOUR USERS — us/);
    expect(t).toMatch(/MOVE YOUR OLD MAIL — us, free/);
    expect(t).toContain("Rahul sends you one TXT record");
  });
});

describe("lead owner next steps", () => {
  it("has the order, the steps and app links", () => {
    const t = leadOwnerNextSteps({
      domain: "acme.in", seats: 12, tierName: "Business Standard", contactName: "Rahul",
      orderId: "Q-AD-2026-27-0001", company: "Acme", customerName: "Asha", customerEmail: "asha@acme.in",
      amount: "₹1,04,371", appBase: "https://reselleros.anutech.in", quoteId: "Q-AD-2026-27-0001", leadId: "L1",
    });
    expect(t).toContain("it is yours (you own this lead)");
    expect(t).toContain("https://reselleros.anutech.in/quotes/Q-AD-2026-27-0001");
    expect(t).toContain("/leads?lead=L1");
    expect(t).toMatch(/Reseller Console/);
  });
});

describe("wiring", () => {
  it("webhook mails the lead owner and the customer the setup steps; no dead app host", () => {
    const w = read("app/api/webhooks/razorpay/webhook.server.ts");
    expect(w).toMatch(/const leadOwner = await loadLeadOwner\(admin, quote\.tenant_id, quote\.lead_id\)/);
    expect(w).toMatch(/kind:\s+"razorpay_payment_lead_owner"/);
    expect(w).toMatch(/customerSetupSteps\(/);
    expect(w).not.toContain("resellersos.web.app\";");
  });
  it("the simulated checkout sends the same two", () => {
    const r = read("app/api/public/checkout/workspace/route.ts");
    expect(r).toMatch(/customerSetupSteps\(/);
    expect(r).toMatch(/kind:\s+"buy_page_checkout_sim_lead_owner"/);
  });
  it("thanks page finds an order whose invoice was issued; card goes to the Razorpay page", () => {
    expect(read("app/(public)/buy/workspace/thanks/fetch-order.ts")).toContain(`["received", "partial", "invoiced"]`);
    expect(read("site/components/home/HomeV2.tsx")).toMatch(/const onlinePay = buyWorkspaceHref\(e\.name, seats\)/);
    // R-157: the Razorpay link only on annual — online payment is yearly, monthly is quoted.
    expect(read("site/components/home/HomeV2.tsx")).toMatch(/const payHref = annual \? onlinePay : null/);
  });
});
