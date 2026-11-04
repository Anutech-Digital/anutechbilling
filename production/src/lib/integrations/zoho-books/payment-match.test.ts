/**
 * R-2359 — "Find in Zoho": which Zoho payment is this bank credit, and what did it pay?
 * Owner's real example (2 Nov FY 2026-27 audit): the HDFC credit of 21 Jul ₹27,081 from SUPREME MEDIA
 * carries UTR IDFB6202M2890149; in Zoho that is the reference of the payment applied to
 * INV/26-27/0613 (domain gptalents.in). Zoho is never called — fetch is a fake India-DC Zoho.
 * Every id below is made up for this test.
 */
import { describe, it, expect } from "vitest";
import {
  findInZoho, normRef, referenceHasUtr, utrCandidates, type BankCreditLine,
} from "./payment-match";
import { ZohoApiError } from "./api";

const ORG = "60000000001";
const TOKEN = "test-only-access";

type Pay = { payment_id: string; payment_number: string; date: string; amount: number; reference_number: string; customer_id: string; customer_name: string };

const SUPREME_PAY: Pay = {
  payment_id: "pay-0613", payment_number: "7801", date: "2026-07-21", amount: 27081,
  reference_number: "IDFB6202M2890149", customer_id: "cust-supreme", customer_name: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED",
};
const OTHER_PAY: Pay = {
  payment_id: "pay-other", payment_number: "7802", date: "2026-07-22", amount: 27081,
  reference_number: "HDFC000999888777", customer_id: "cust-other", customer_name: "OTHER CO",
};

function fakeZoho(payments: Pay[], opts: { status?: number; calls?: string[] } = {}) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    opts.calls?.push(url.pathname + url.search);
    if (opts.status) return new Response(JSON.stringify({ code: 57, message: "not authorized" }), { status: opts.status });
    const path = url.pathname.replace("/books/v3", "");
    const json = (b: unknown) => new Response(JSON.stringify({ code: 0, ...(b as object) }), { status: 200 });
    if (path === "/customerpayments") {
      const ref = url.searchParams.get("reference_number_contains");
      const from = url.searchParams.get("date_start");
      const to = url.searchParams.get("date_end");
      const rows = payments.filter((p) =>
        ref ? p.reference_number.toUpperCase().includes(ref) : from && to ? p.date >= from && p.date <= to : true);
      return json({ customerpayments: rows, page_context: { has_more_page: false } });
    }
    const pm = /^\/customerpayments\/(.+)$/.exec(path);
    if (pm) {
      const p = payments.find((x) => x.payment_id === pm[1]);
      return json({ payment: { ...p, invoices: [{ invoice_id: "inv-0613", invoice_number: "INV/26-27/0613", amount_applied: 27081 }] } });
    }
    if (path === "/invoices/inv-0613") {
      return json({ invoice: {
        invoice_id: "inv-0613", invoice_number: "INV/26-27/0613", date: "2026-07-21", total: 27081, gst_no: "07AAACS0000A1Z5",
        custom_fields: [{ label: "Subs Period", value: "Yearly" }],
        line_items: [{
          name: "Google Workspace Business Starter", sku: "GWS-BS", quantity: 9, rate: 2550, item_total: 22950,
          description: "Domain Name: gptalents.in Subscription Period: 1 Year/s (21/07/2026 - 20/07/2027)",
        }],
      } });
    }
    if (path.startsWith("/contacts/")) return json({ contact: { gst_no: "07AAACO0000A1Z9" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const SUPREME_LINE: BankCreditLine = {
  txnDate: "2026-07-21", credit: 27081, reference: null,
  description: "NEFT CR-IDFB0080202-SUPREME MEDIA AND STUDIOS P-ANUTECH DIGITAL-IDFB6202M2890149",
};

describe("R-2359 UTR from a bank line", () => {
  it("finds the NEFT UTR in the narration and skips the IFSC", () => {
    expect(utrCandidates(SUPREME_LINE)).toEqual(["IDFB6202M2890149"]);
  });
  it("uses the Reference column first, leading zeros ignored", () => {
    expect(utrCandidates({ reference: "0000162440272175", description: "UPI-SANICON-9876543210@ybl" })).toEqual(["162440272175"]);
    expect(normRef("0000162440272175")).toBe("162440272175");
    expect(referenceHasUtr("0000162440272175", "162440272175")).toBe(true);
    expect(referenceHasUtr("IDFB6202M2890149", "IDFB6202M2890148")).toBe(false);
  });
});

describe("R-2359 findInZoho", () => {
  it("UTR match → the Supreme Media payment, its invoice, lines and period", async () => {
    const calls: string[] = [];
    const r = await findInZoho(SUPREME_LINE, { orgId: ORG, token: TOKEN, fetch: fakeZoho([SUPREME_PAY, OTHER_PAY], { calls }) });
    expect(r.kind).toBe("match");
    if (r.kind !== "match") return;
    expect(r.match.by).toBe("utr");
    expect(r.match.payment.reference).toBe("IDFB6202M2890149");
    expect(r.match.customer).toEqual({
      zohoId: "cust-supreme", name: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED", gstin: "07AAACS0000A1Z5",
      /* R-2363: where the customer is, from the same invoice. This made-up GSTIN fails the checksum,
         so no state is read from it (never a guess). */
      country: "India", gstTreatment: null, state: null,
    });
    expect(r.match.invoices.map((i) => i.number)).toEqual(["INV/26-27/0613"]);
    expect(r.match.invoices[0].lines[0]).toMatchObject({
      name: "Google Workspace Business Starter", sku: "GWS-BS", qty: 9, rate: 2550,
      start: "2026-07-21", end: "2026-07-20".replace("2026", "2027"), months: 12, domain: "gptalents.in",
    });
    expect(calls[0]).toContain("reference_number_contains=IDFB6202M2890149");
    expect(calls[0]).toContain(`organization_id=${ORG}`);
    expect(calls.every((c) => !c.includes("date_start"))).toBe(true);   // no fallback needed
  });

  it("no UTR in Zoho → fallback by amount ±₹2 and date ±3 days", async () => {
    const pay = { ...SUPREME_PAY, reference_number: "cheque 1234", amount: 27080, date: "2026-07-23" };
    const far = { ...OTHER_PAY, amount: 27081, date: "2026-07-30" };
    const near = { ...OTHER_PAY, payment_id: "pay-big", amount: 27090, date: "2026-07-21" };
    const calls: string[] = [];
    const r = await findInZoho(SUPREME_LINE, { orgId: ORG, token: TOKEN, fetch: fakeZoho([pay, far, near], { calls }) });
    expect(r.kind).toBe("match");
    if (r.kind !== "match") return;
    expect(r.match.by).toBe("amount_date");
    expect(r.match.payment.zohoId).toBe("pay-0613");
    expect(calls.some((c) => c.includes("date_start=2026-07-18") && c.includes("date_end=2026-07-24"))).toBe(true);
  });

  it("two payments of the same amount near the date → several, owner picks; the pick reads that one", async () => {
    const a = { ...SUPREME_PAY, reference_number: "x" };
    const b = { ...OTHER_PAY, reference_number: "y" };
    const r = await findInZoho(SUPREME_LINE, { orgId: ORG, token: TOKEN, fetch: fakeZoho([a, b]) });
    expect(r.kind).toBe("several");
    if (r.kind !== "several") return;
    expect(r.candidates.map((c) => c.zohoId).sort()).toEqual(["pay-0613", "pay-other"]);
    const picked = await findInZoho(SUPREME_LINE, { orgId: ORG, token: TOKEN, fetch: fakeZoho([a, b]) }, "pay-0613");
    expect(picked.kind === "match" && picked.match.by).toBe("picked");
  });

  it("nothing in Zoho → none, with what was tried", async () => {
    const r = await findInZoho(SUPREME_LINE, { orgId: ORG, token: TOKEN, fetch: fakeZoho([]) });
    expect(r).toEqual({ kind: "none", utrs: ["IDFB6202M2890149"], from: "2026-07-18", to: "2026-07-24" });
  });

  it("Zoho refuses (old connection without the payments permission) → ZohoApiError 401", async () => {
    await expect(findInZoho(SUPREME_LINE, { orgId: ORG, token: TOKEN, fetch: fakeZoho([], { status: 401 }) }))
      .rejects.toBeInstanceOf(ZohoApiError);
  });
});
