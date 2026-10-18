/**
 * The order-placed page promises only what really happens (30 Sep 2026 redesign).
 * It used to send customers to /dashboard (the staff app), promise NEFT/RTGS activation
 * (checkout takes Razorpay only) and a WhatsApp call from a "migration desk" nothing sends.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/app/(marketing)/done/page.tsx", "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("/done tells the customer only what is true", () => {
  it("sends customers to the hosting & domains customer panel, never the staff app", () => {
    // R-233: /login is the ResellerOS sign-in; the customer panel is CLIENT_AREA_URL.
    expect(code).toMatch(/href=\{CLIENT_AREA_URL as never\}[^>]*>Customer login \(hosting &amp; domains\)</);
    expect(code).not.toMatch(/href="\/login"/);
    expect(code).not.toMatch(/href="\/dashboard"/);
  });
  it("makes none of the old promises", () => {
    expect(code).not.toMatch(/NEFT|RTGS|migration desk/i);
  });
  it("never invents an order number", () => {
    expect(code).not.toMatch(/ORD-[A-Z]{3,}-\d{4}/);
    expect(code).toMatch(/Your order number is in the confirmation email/);
  });
  it("keeps the honest 'email did not go out' trial state", () => {
    expect(code).toMatch(/trialEmail && !trialSent/);
    expect(code).toMatch(/the email did not go out/);
  });
});

describe("R-1596 — /done shows the payment's true state, confirmed by our server", () => {
  const checkout = readFileSync("src/app/(marketing)/checkout/page.tsx", "utf8");
  it("the checkout confirms the payment on our server before opening /done", () => {
    const handler = checkout.slice(checkout.indexOf("handler: async"), checkout.indexOf("modal: { ondismiss"));
    expect(handler).toMatch(/fromRazorpayHandler\(resp\)/);
    expect(handler).toMatch(/await confirmPayment\(returned\)/);
    expect(handler.indexOf("confirmPayment(")).toBeLessThan(handler.indexOf('router.push("/done"'));
    expect(checkout).toMatch(/<BusyPanel\s+active=\{confirmingPayment\}/);
  });
  it("/done asks the server again unless it already said paid, and says 'Payment received' only then", () => {
    expect(code).toMatch(/const p = readPayment\(\)/);
    expect(code).toMatch(/await confirmPayment\(payment\)/);
    expect(code).toMatch(/if \(payment && verdict\?\.state !== "paid"\)/);
    expect(code.indexOf('if (payment && verdict?.state !== "paid")')).toBeLessThan(code.indexOf('badge="Payment received · order placed"'));
  });
  it("still confirming shows progress and a way to ask again; a failure never says nothing was charged", () => {
    const branch = code.slice(code.indexOf('if (payment && verdict?.state !== "paid")'), code.indexOf('badge="Payment received · order placed"'));
    expect(branch).toMatch(/<BusyPanel active=\{checking\}/);
    expect(branch).toMatch(/Check again/);
    expect(branch).not.toMatch(/nothing was charged/i);
    expect(branch).toMatch(/don't pay again/i);
  });
});
