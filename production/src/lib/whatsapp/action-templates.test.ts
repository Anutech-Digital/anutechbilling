/**
 * R-1924 (G-ONBOARD OB-3): the WhatsApp action templates speak for the LOGGED-IN company.
 * They used to hardcode Anutech's name, ICICI account, UPI and support email, so every new
 * tenant's customer was asked to pay Anutech.
 */
import { describe, it, expect } from "vitest";
import { buildWhatsAppTemplates, senderFromUser, type WhatsAppSender } from "./action-templates";

const withBank: WhatsAppSender = {
  name: "Sharma Traders",
  email: "accounts@sharmatraders.in",
  phone: "+91 98100 11111",
  upiVpa: "sharma@okhdfc",
  bankName: "HDFC Bank",
  accountName: "Sharma Traders",
  accountNumber: "50100123456789",
  ifsc: "HDFC0001234",
  branch: "Karol Bagh",
};
const bare: WhatsAppSender = {
  name: "New Co", email: null, phone: null, upiVpa: null,
  bankName: null, accountName: null, accountNumber: null, ifsc: null, branch: null,
};

function allText(t: Record<string, string>): string {
  return Object.values(t).join("\n");
}

describe("R-1924 — WhatsApp action templates use the tenant's own details", () => {
  it("a tenant with bank + UPI sees its own details in the invoice reminder", () => {
    const t = buildWhatsAppTemplates({ recipientName: "Ramesh", companyName: "Acme", vars: {}, sender: withBank });
    expect(t.invoice).toContain("Bank: HDFC Bank");
    expect(t.invoice).toContain("A/c Name: Sharma Traders");
    expect(t.invoice).toContain("A/c No: 50100123456789");
    expect(t.invoice).toContain("IFSC: HDFC0001234");
    expect(t.invoice).toContain("UPI ID: sharma@okhdfc");
    expect(t.quote).toContain("Greetings from Sharma Traders!");
    expect(t.welcome).toContain("Welcome to Sharma Traders!");
    expect(t.welcome).toContain("accounts@sharmatraders.in");
    expect(t.renewal).toContain("+91 98100 11111");
  });

  it("a tenant with no bank and no UPI sees no bank block at all", () => {
    const t = buildWhatsAppTemplates({ recipientName: "Ramesh", companyName: "Acme", vars: {}, sender: bare });
    expect(t.invoice).not.toMatch(/Bank Details|Bank:|A\/c|IFSC|UPI ID/);
    expect(t.quote).toContain("Greetings from New Co!");
    // No made-up phone or support mail either.
    expect(t.renewal).not.toMatch(/98765 43210|call us at/);
    expect(t.welcome).not.toMatch(/@/);
  });

  it("UPI only → the UPI line without an empty bank block", () => {
    const t = buildWhatsAppTemplates({ recipientName: "R", companyName: "A", vars: {}, sender: { ...bare, upiVpa: "newco@ybl" } });
    expect(t.invoice).toContain("UPI ID: newco@ybl");
    expect(t.invoice).not.toMatch(/Bank:|A\/c No|IFSC/);
  });

  it("Anutech's details never appear, for any tenant or template", () => {
    for (const sender of [withBank, bare]) {
      const text = allText(buildWhatsAppTemplates({ recipientName: null, companyName: null, vars: {}, sender }));
      expect(text).not.toMatch(/anutech|icici|002105001928|ICIC0000021/i);
    }
  });

  it("no link → no made-up anutechbilling.com link line", () => {
    const t = buildWhatsAppTemplates({ recipientName: "R", companyName: "A", vars: {}, sender: bare });
    expect(t.quote).not.toMatch(/https?:\/\//);
    expect(t.renewal).not.toMatch(/https?:\/\//);
    const linked = buildWhatsAppTemplates({ recipientName: "R", companyName: "A", vars: { link: "https://x.test/q/1" }, sender: bare });
    expect(linked.quote).toContain("https://x.test/q/1");
  });

  it("senderFromUser maps the current-user tenant fields (null user → neutral sender)", () => {
    expect(senderFromUser(null).name).toBe("our team");
    const s = senderFromUser({
      tenantName: "Sharma Traders", tenantEmail: "a@b.in", tenantPhone: "1", tenantUpiVpa: "u@x",
      tenantRemitBankName: "HDFC Bank", tenantRemitAccountName: "Sharma Traders",
      tenantRemitAccountNumber: "5", tenantRemitIfsc: "HDFC0001234", tenantRemitBranch: null,
    });
    expect(s).toMatchObject({ name: "Sharma Traders", upiVpa: "u@x", bankName: "HDFC Bank", ifsc: "HDFC0001234" });
  });
});
