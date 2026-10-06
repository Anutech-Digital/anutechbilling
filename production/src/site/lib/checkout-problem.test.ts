/**
 * The checkout pop-up (1 Oct 2026): every refusal names what happened and offers a way
 * forward — never a dead end, and never "nothing was charged" on a payment that may have
 * left the buyer's account.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actionLabel, checkoutProblem } from "./checkout-problem";

describe("checkoutProblem", () => {
  it("a second trial: the date, buy the paid plan first, ask for more time, check my details", () => {
    const p = checkoutProblem("trial", "You've already had a free hosting trial…", { alreadyTrialled: true, trialStartedOn: "30 Sept 2026" });
    expect(p.title).toBe("You've already used your free trial");
    expect(p.body).toContain("on 30 Sept 2026");
    expect(p.footnote).toBe("Nothing was saved and nothing was charged.");
    expect(p.actions).toEqual(["buy-paid-plan", "ask-more-time", "edit-details"]);
    expect(p.field).toBe("email");
    expect(actionLabel("buy-paid-plan", p, "₹1,188/year + GST")).toBe("Buy Starter — ₹1,188/year + GST");
    expect(actionLabel("edit-details", p)).toBe("Not me — check my details");
  });

  it("no date known: the sentence still reads", () => {
    expect(checkoutProblem("trial", "x", { alreadyTrialled: true }).body).toMatch(/^We found an earlier free trial for the same/);
  });

  it("a missing domain points at the domain box and at registering one", () => {
    const p = checkoutProblem("trial", "Please enter the domain…", { needDomain: true });
    expect(p.actions).toEqual(["edit-details", "register-domain"]);
    expect(p.field).toBe("domain");
    expect(actionLabel("edit-details", p)).toBe("Enter my domain");
  });

  it("a missing state points at the state box", () => {
    const p = checkoutProblem("order", "Please choose your state…", { needState: true });
    expect(p.field).toBe("state");
    expect(actionLabel("edit-details", p)).toBe("Choose my state");
  });

  it("a failed payment never says nothing was charged — it says how a debit comes back", () => {
    const p = checkoutProblem("payment", "Payment failed: Your bank declined it");
    expect(p.title).toBe("The payment didn't go through");
    expect(p.body).toBe("Your bank declined it");
    expect(p.footnote).toMatch(/refunded by your bank/);
    expect(`${p.body} ${p.footnote}`).not.toMatch(/nothing was charged/i);
    expect(p.actions).toEqual(["retry", "email-support"]);
    expect(checkoutProblem("payment", "").body).toBe("Your bank or UPI app declined it.");
  });

  it("any other failure keeps the server's words and offers retry and support (and the cart, for an order)", () => {
    const t = checkoutProblem("trial", "We couldn't check whether you've had a trial before.");
    expect(t.title).toBe("We couldn't start your Starter trial");
    expect(t.body).toBe("We couldn't check whether you've had a trial before.");
    expect(t.actions).toEqual(["retry", "email-support"]);
    expect(checkoutProblem("order", "x").actions).toEqual(["retry", "email-support", "back-to-cart"]);
  });
});

describe("the checkout page", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(marketing)/checkout/page.tsx"), "utf8");
  it("shows refusals in the pop-up, not as a red line above the button", () => {
    expect(src).toContain("<CheckoutNotice");
    expect(src).not.toMatch(/#FEF2F2/);
    expect(src).not.toContain("setError(");
  });
  it("the wait shows as a pop-up too, so the form under it never moves (1 Oct 2026)", () => {
    const panels = src.match(/<BusyPanel[\s\S]*?\/>/g) ?? [];
    expect(panels.length).toBe(2);
    for (const p of panels) expect(p).toContain('variant="modal"');
  });
  it("the Razorpay window wears the storefront blue, the same value as site.css --primary (3 Oct 2026)", () => {
    const primary = /--primary:\s*(#[0-9A-Fa-f]{6})/.exec(readFileSync(join(process.cwd(), "src/site/site.css"), "utf8"))?.[1];
    expect(primary).toBe("#1668E3");
    expect(src).toMatch(new RegExp(`theme:\\s*\\{\\s*color:\\s*"${primary}"`));
    expect(src).not.toContain("#C2410C");
  });

  it("every field the pop-up can point at has its id", () => {
    for (const f of ["email", "domain", "state"]) expect(src).toContain(`id="checkout-${f}"`);
  });
});
