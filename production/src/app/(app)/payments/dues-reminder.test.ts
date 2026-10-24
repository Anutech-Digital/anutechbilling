/**
 * R-1638 — Payments → Outstanding → Remind opened the mail app with an EMPTY "To" and signed
 * every reminder "— Anutech Digital" whatever the business. The mail now goes to the
 * customer's billing contact (lib/contacts/primary — primary contact, legacy column as a floor)
 * and is signed with the tenant's own name. "Last reminder" is still written only after the
 * person says it went out (R-1698's confirm) — see the page source check below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { duesReminderMailto } from "./dues-reminder";

const row = {
  customer_name: "Acme Pvt Ltd",
  plan: "Google Workspace Business Starter",
  outstanding_amount: 5900,
  paid_amount: 1000,
  total_quote_amount: 6900,
  started_at: "2026-09-01",
};

const parse = (href: string) => {
  const [head, query] = href.split("?");
  const q = new URLSearchParams(query);
  return { to: decodeURIComponent(head.replace(/^mailto:/, "")), subject: q.get("subject") ?? "", body: q.get("body") ?? "" };
};

describe("duesReminderMailto", () => {
  it("fills To with the customer's billing email", () => {
    const m = parse(duesReminderMailto(row, { to: "accounts@acme.in", sellerName: "Sharma Cloud" }));
    expect(m.to).toBe("accounts@acme.in");
    expect(m.subject).toBe("Payment reminder · ₹5,900 pending");
    expect(m.body).toContain("Hi Acme Pvt Ltd,");
    expect(m.body).toContain("₹5,900 is still pending");
    expect(m.body).toContain("You've paid ₹1,000 of ₹6,900.");
  });

  it("signs with the business's own name, not a hard-coded one", () => {
    const m = parse(duesReminderMailto(row, { to: "a@b.in", sellerName: "Sharma Cloud" }));
    expect(m.body.trim().endsWith("— Sharma Cloud")).toBe(true);
    expect(m.body).not.toContain("Anutech Digital");
  });

  it("no email on file: To stays empty (the dialog says so), no signature line when no name", () => {
    const m = parse(duesReminderMailto(row, { to: null, sellerName: "" }));
    expect(m.to).toBe("");
    expect(m.body).not.toMatch(/—\s*$/);
  });
});

describe("the Remind action on /payments", () => {
  const src = readFileSync(resolve(__dirname, "page.tsx"), "utf8");
  it("uses the helper with the customer's email, and writes Last reminder only after the confirm", () => {
    expect(src).toMatch(/duesReminderMailto\(/);
    expect(src).toMatch(/duesReminderTo\(/);
    expect(src).not.toMatch(/mailto:\?subject=/);
    const confirmAt = src.indexOf("go out?");
    const markAt = src.indexOf("markReminderSent.mutateAsync");
    expect(confirmAt).toBeGreaterThan(0);
    expect(markAt).toBeGreaterThan(confirmAt);
  });
});
