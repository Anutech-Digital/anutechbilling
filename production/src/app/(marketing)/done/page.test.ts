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
  it("a paid order has one portal button, and says to use the one-time password (7 Oct 2026)", () => {
    expect(code.match(/href=\{CLIENT_AREA_URL as never\}/g)?.length).toBe(1);
    // The line sits right under the button (comments are stripped from `code`).
    const button = code.indexOf("Customer login (hosting &amp; domains)</Link>");
    const line = code.indexOf("First time? Sign in with the one-time password");
    const home = code.lastIndexOf(">Back to home</Link>"); // the paid view is the last one
    expect(button).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(button);
    expect(line).toBeLessThan(home);
    expect(code).not.toMatch(/Go to client login|Log in to the Customer Portal/);
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
