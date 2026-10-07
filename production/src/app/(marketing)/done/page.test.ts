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
  it("sends customers to client login, never the staff dashboard", () => {
    // The Customer Portal's own login (CLIENT_AREA_URL), not the shop's /login page (7 Oct 2026).
    expect(code).toMatch(/href=\{CLIENT_AREA_URL\}/);
    expect(code).not.toMatch(/href="\/dashboard"/);
  });
  it("a paid order goes straight to the Customer Portal (7 Oct 2026)", () => {
    expect(code).toContain("CLIENT_AREA_URL");
    expect(code.match(/href=\{CLIENT_AREA_URL\}[^>]*>Log in to the Customer Portal</g)?.length).toBe(1);
    expect(code).not.toMatch(/Go to client login/);
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
