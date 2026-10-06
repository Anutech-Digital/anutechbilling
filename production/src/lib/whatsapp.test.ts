import { describe, it, expect } from "vitest";
import {
  getInvoiceWhatsAppUrl, getLeadWhatsAppUrl, getRenewalWhatsAppUrl,
  formatWhatsAppPhone, signOff, payLine, invoiceWhatsAppTarget, type WhatsAppSender,
} from "./whatsapp";

const ANUTECH: WhatsAppSender = {
  businessName: "ANUTECH DIGITAL PVT LTD",
  upiVpa: "anutech@okhdfcbank",
  upiPayeeName: "ANUTECH DIGITAL",
};

/** The message body, decoded back out of the wa.me link. */
const body = (url: string) => decodeURIComponent(new URL(url).searchParams.get("text") ?? "");

const invoice = { id: "INV-ADPL-2026-27-0001", amount: 11_800, due_date: "2026-08-25" };

describe("no message is ever signed with a company that is not the sender's", () => {
  it("signs with the tenant that was passed in", () => {
    expect(body(getInvoiceWhatsAppUrl(invoice, "9876543210", ANUTECH)))
      .toContain("ANUTECH DIGITAL PVT LTD");
  });

  it("NEVER says Excel Technologies — the name these messages used to carry", () => {
    /* Excel Technologies is the tenant's historical name (CLAUDE.md §1). Hardcoded in
       all three messages, it named a company the customer has no relationship with,
       beside a real invoice number — which reads as a scam. In a multi-tenant app it
       was also wrong for every other reseller from day one. */
    const all = [
      body(getInvoiceWhatsAppUrl(invoice, "9876543210", ANUTECH)),
      body(getLeadWhatsAppUrl({ company: "Acme" }, "9876543210", ANUTECH)),
      body(getRenewalWhatsAppUrl("Acme", "Workspace", "1 Sep 2026", "9876543210", ANUTECH)),
      /* And with no sender at all — the fallback must not reintroduce it. */
      body(getInvoiceWhatsAppUrl(invoice, "9876543210")),
    ];
    for (const m of all) expect(m).not.toMatch(/excel technologies/i);
  });

  it("goes UNSIGNED rather than guessing when the sender is unknown", () => {
    /* No name is slightly worse than a name. The wrong name is far worse. */
    const m = body(getInvoiceWhatsAppUrl(invoice, "9876543210", null));
    expect(m).toContain("Thank you!");
    expect(signOff(null)).toBe("");
    expect(signOff({ businessName: "   " })).toBe("");
  });
});

describe("the reminder carries a way to pay, not just a nag", () => {
  it("embeds a upi:// intent with the amount and the invoice number", () => {
    const m = body(getInvoiceWhatsAppUrl(invoice, "9876543210", ANUTECH));
    expect(m).toContain("upi://pay");
    expect(m).toMatch(/am=11800\.00/);
    expect(m).toContain("INV-ADPL-2026-27-0001");
  });

  it("names the apps the customer actually has, not 'UPI'", () => {
    expect(body(getInvoiceWhatsAppUrl(invoice, "9876543210", ANUTECH)))
      .toMatch(/GPay|PhonePe|Paytm/);
  });

  it("omits the pay line entirely when no VPA is set", () => {
    /* Half a payment instruction is worse than none — the customer taps a dead link
       and concludes the invoice is broken. */
    const m = body(getInvoiceWhatsAppUrl(invoice, "9876543210", { businessName: "ANUTECH DIGITAL PVT LTD" }));
    expect(m).not.toContain("upi://");
    expect(m).toContain("ANUTECH DIGITAL PVT LTD");
  });

  it("omits it on a MALFORMED VPA rather than shipping a broken intent", () => {
    /* A typo'd VPA does not fail at scan time: the transfer goes somewhere else or
       dies after the customer has tried. buildUpiIntent refuses; we stay silent. */
    for (const bad of ["notavpa", "@okhdfcbank", "spaces in@bank", ""]) {
      const m = body(getInvoiceWhatsAppUrl(invoice, "9876543210", { ...ANUTECH, upiVpa: bad }));
      expect(m).not.toContain("upi://");
    }
  });

  it("falls back to the business name when no separate payee name is set", () => {
    const line = payLine({ businessName: "ANUTECH DIGITAL PVT LTD", upiVpa: "anutech@okhdfcbank" }, 500, "INV-1");
    expect(line).toContain("upi://pay");
    expect(line).toContain("ANUTECH");
  });

  it("prefers net_payable over amount — that is what is actually owed", () => {
    const m = body(getInvoiceWhatsAppUrl(
      { ...invoice, amount: 11_800, net_payable: 9_000 }, "9876543210", ANUTECH));
    expect(m).toMatch(/am=9000\.00/);
  });
});

describe("the phone number", () => {
  it("adds 91 to a bare ten-digit Indian number", () => {
    expect(formatWhatsAppPhone("9876543210")).toBe("919876543210");
  });

  it("leaves an already-prefixed number alone and strips punctuation", () => {
    expect(formatWhatsAppPhone("+91 98765 43210")).toBe("919876543210");
  });

  it("returns empty for nothing, so wa.me opens the contact picker", () => {
    expect(formatWhatsAppPhone(null)).toBe("");
    expect(formatWhatsAppPhone(undefined)).toBe("");
  });
});

describe("R-245: the invoice reminder goes to the customer, and never says '*due date*'", () => {
  it("leaves the due clause out when the invoice has no due date", () => {
    const m = body(getInvoiceWhatsAppUrl({ id: "INV-1", amount: 500 }, "9876543210", ANUTECH));
    expect(m).not.toMatch(/due date/i);
    expect(m).not.toMatch(/due on/i);
    expect(m).toContain("*INV-1* for *");
  });

  it("still names the date when there is one", () => {
    expect(body(getInvoiceWhatsAppUrl(invoice, "9876543210", ANUTECH))).toMatch(/due on \*.+2026\*/);
  });

  it("addresses wa.me to the customer's number (91 + 10 digits)", () => {
    const t = invoiceWhatsAppTarget(invoice, "+91 98765-43210", ANUTECH);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url.startsWith("https://wa.me/919876543210?text=")).toBe(true);
  });

  it("refuses (no_phone) instead of opening a recipient-less link", () => {
    for (const p of [null, undefined, "", "   ", "12345"]) {
      expect(invoiceWhatsAppTarget(invoice, p, ANUTECH)).toEqual({ ok: false, reason: "no_phone" });
    }
  });
});
