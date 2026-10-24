/**
 * R-1726 (+R-1724) — one primary button per quote state. The first three cases are the
 * owner's own examples from the 21 Oct journey audit (Q-F588-27-0038 / Q-F588-27-0031).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quotePrimaryAction, isClosedForSending, type QuotePrimaryInput } from "./primary-action";

const base: QuotePrimaryInput = {
  status: "sent",
  supersededBy: null,
  invoiceId: null,
  paymentStatus: "awaiting",
  money: { stage: "open", canRecordPayment: true, canGenerateInvoice: false },
  invoiceBalance: 0,
  hasReceivedPayment: false,
  mayRecordMoney: true,
  gstBlocked: false,
  orphan: false,
  customerCopyBlocked: false,
};
const q = (over: Partial<QuotePrimaryInput>): QuotePrimaryInput => ({ ...base, ...over });

describe("owner examples (R-1726 / R-1724)", () => {
  it("sent quote, no money → the one primary is Record payment (not WhatsApp / Mark accepted)", () => {
    expect(quotePrimaryAction(q({}))).toBe("record_payment");
  });

  it("invoice fully paid → Send receipt", () => {
    expect(quotePrimaryAction(q({
      status: "accepted", invoiceId: "INV-27-0007", paymentStatus: "invoiced",
      money: { stage: "invoiced", canRecordPayment: false, canGenerateInvoice: false },
      invoiceBalance: 0, hasReceivedPayment: true,
    }))).toBe("send_receipt");
  });

  it("rejected quote → Duplicate, never a send", () => {
    const rejected = q({ status: "rejected", money: { stage: "closed", canRecordPayment: false, canGenerateInvoice: false } });
    expect(quotePrimaryAction(rejected)).toBe("duplicate");
    expect(isClosedForSending(rejected)).toBe(true);
  });
});

describe("every other state has exactly one next step", () => {
  it("draft → Send on WhatsApp; locked for approval → no primary", () => {
    const draft = q({ status: "draft", paymentStatus: "none", money: { stage: "draft", canRecordPayment: false, canGenerateInvoice: false } });
    expect(quotePrimaryAction(draft)).toBe("send_whatsapp");
    expect(quotePrimaryAction({ ...draft, customerCopyBlocked: true })).toBeNull();
  });

  it("accepted, nothing paid → Record payment (Invoice now stays secondary)", () => {
    expect(quotePrimaryAction(q({ status: "accepted", money: { stage: "unpaid", canRecordPayment: true, canGenerateInvoice: true } })))
      .toBe("record_payment");
  });

  it("paid in full, no invoice → Generate GST Invoice; GST state missing → fix it first", () => {
    const paid = q({ status: "accepted", paymentStatus: "received", hasReceivedPayment: true, money: { stage: "paid", canRecordPayment: false, canGenerateInvoice: true } });
    expect(quotePrimaryAction(paid)).toBe("generate_invoice");
    expect(quotePrimaryAction({ ...paid, gstBlocked: true })).toBe("fix_gst");
  });

  it("invoiced with a balance → Record payment; sales role → View invoice", () => {
    const inv = q({ status: "accepted", invoiceId: "INV-1", paymentStatus: "invoiced", invoiceBalance: 5000, money: { stage: "invoiced", canRecordPayment: false, canGenerateInvoice: false } });
    expect(quotePrimaryAction(inv)).toBe("record_payment");
    expect(quotePrimaryAction({ ...inv, mayRecordMoney: false })).toBe("view_invoice");
  });

  it("sent quote seen by a role that cannot record money → Mark accepted", () => {
    expect(quotePrimaryAction(q({ mayRecordMoney: false }))).toBe("mark_accepted");
  });

  it("expired → Duplicate; replaced by a revision → no primary", () => {
    const closed = { stage: "closed", canRecordPayment: false, canGenerateInvoice: false };
    expect(quotePrimaryAction(q({ status: "expired", money: closed }))).toBe("duplicate");
    expect(quotePrimaryAction(q({ status: "expired", supersededBy: "Q-1-R2", money: closed }))).toBeNull();
  });

  it("paid deal with no subscription → the repair is the primary", () => {
    expect(quotePrimaryAction(q({ status: "accepted", orphan: true, hasReceivedPayment: true, money: { stage: "paid", canRecordPayment: false, canGenerateInvoice: true } })))
      .toBe("rebuild_subscription");
  });
});

/* The page must take every orange button from quotePrimaryAction — a hard-coded
   variant="primary" in the header or the action card is how a sent quote got three. */
describe("quote page wiring", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/quotes/[id]/page.tsx"), "utf8");
  const header = page.indexOf("{/* Header */}");
  const lineItems = page.indexOf('<Card title="Line items"');

  it("no hard-coded primary between the header and the line items", () => {
    expect(header).toBeGreaterThan(-1);
    expect(lineItems).toBeGreaterThan(header);
    const region = page.slice(header, lineItems);
    expect(region).not.toMatch(/variant="primary"/);
    expect(region).toMatch(/quotePrimaryAction|variantFor\(primary/);
  });

  it("a closed quote has no Send on WhatsApp / Send via email (R-1724)", () => {
    const region = page.slice(header, lineItems);
    const wa = region.indexOf("Send on WhatsApp");
    expect(region.slice(Math.max(0, wa - 900), wa)).toMatch(/!closedQuote/);
    const mail = region.indexOf("Send via email");
    expect(region.slice(Math.max(0, mail - 600), mail)).toMatch(/!closedQuote/);
  });

  it("invoiced and paid offers Send receipt through the existing receipt voucher dialog", () => {
    expect(page).toMatch(/Send receipt/);
    expect(page).toMatch(/setReceiptPayment\(receiptTarget\)/);
  });
});
