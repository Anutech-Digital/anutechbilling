import { describe, it, expect } from "vitest";
import {
  billingCustomerId, mapCustomer, mapCustomerListItem, parsePagination, paginationMeta,
  mapSubscription, mapInvoice, mapQuote, mapPayment,
} from "./v1-mappers";
import type {
  Customer as CustomerRow,
  Subscription as SubscriptionRow,
  Invoice as InvoiceRow,
  Quote as QuoteRow,
  Payment as PaymentRow,
} from "@/lib/supabase/database.types";

describe("billingCustomerId", () => {
  it("prefers customer_number, falls back to uuid", () => {
    expect(billingCustomerId({ id: "uuid-1", customer_number: "C-00001" })).toBe("C-00001");
    expect(billingCustomerId({ id: "uuid-1", customer_number: null })).toBe("uuid-1");
    expect(billingCustomerId({ id: "uuid-1", customer_number: "" })).toBe("uuid-1");
  });
});

describe("mapCustomer", () => {
  const c = { id: "u1", customer_number: "C-00007", name: "Acme", contact_email: "a@acme.com", domain: "acme.com" } as CustomerRow;
  it("maps fields + derives active status from subscription flag", () => {
    expect(mapCustomer(c, true)).toEqual({
      billing_customer_id: "C-00007", name: "Acme", email: "a@acme.com", domain: "acme.com", status: "active",
    });
    expect(mapCustomer(c, false).status).toBe("inactive");
  });
});

describe("mapCustomerListItem", () => {
  const c = { id: "u1", customer_number: "C-00007", name: "Acme", contact_email: "a@acme.com", domain: "acme.com" } as CustomerRow;
  it("adds id (= billing_customer_id) alongside the customer fields", () => {
    expect(mapCustomerListItem(c, true)).toEqual({
      id: "C-00007", billing_customer_id: "C-00007",
      name: "Acme", email: "a@acme.com", domain: "acme.com", status: "active",
    });
  });
  it("falls back id to uuid when no customer_number", () => {
    expect(mapCustomerListItem({ ...c, customer_number: null }, false).id).toBe("u1");
  });
});

describe("parsePagination", () => {
  it("defaults to page 1, per_page 100", () => {
    expect(parsePagination(null, null)).toEqual({ page: 1, perPage: 100, offset: 0 });
  });
  it("computes offset and caps per_page at 200", () => {
    expect(parsePagination("3", "50")).toEqual({ page: 3, perPage: 50, offset: 100 });
    expect(parsePagination("1", "5000").perPage).toBe(200);
  });
  it("falls back garbage / zero / negatives to safe defaults", () => {
    // "0" is falsy → defaults (page 1, per_page 100)
    expect(parsePagination("0", "0")).toEqual({ page: 1, perPage: 100, offset: 0 });
    expect(parsePagination("-2", "abc")).toEqual({ page: 1, perPage: 100, offset: 0 });
    // a negative per_page value is clamped up to the minimum of 1
    expect(parsePagination("2", "-5")).toEqual({ page: 2, perPage: 1, offset: 1 });
  });
});

describe("paginationMeta", () => {
  it("computes pages via ceil", () => {
    expect(paginationMeta(250, 1, 100)).toEqual({ page: 1, per_page: 100, total: 250, pages: 3 });
    expect(paginationMeta(200, 2, 100).pages).toBe(2);
  });
  it("returns at least 1 page even for 0 results", () => {
    expect(paginationMeta(0, 1, 100).pages).toBe(1);
  });
});

describe("mapSubscription", () => {
  const base = { id: "SUB-1", plan: "Google Workspace Business Standard", seats: 25, mrr: 25000,
    start_date: "2026-01-01", renewal_date: "2027-01-01", status: "active" } as SubscriptionRow;

  it("annualises mrr and keeps annual term", () => {
    const m = mapSubscription(base);
    expect(m.amount).toBe(300000);       // 25000 * 12
    expect(m.plan).toBe("annual");
    expect(m.status).toBe("active");
    expect(m.currency).toBe("INR");
  });
  it("maps paused → suspended", () => {
    expect(mapSubscription({ ...base, status: "paused" }).status).toBe("suspended");
  });
  it("detects a monthly term from a short date span", () => {
    expect(mapSubscription({ ...base, renewal_date: "2026-02-01" }).plan).toBe("monthly");
  });
  it("R-1770: names the domain and vendor (DMS shows which domain the plan is for)", () => {
    const m = mapSubscription({ ...base, domain: "acme.in", vendor: "google" } as SubscriptionRow);
    expect(m.domain).toBe("acme.in");
    expect(m.vendor).toBe("google");
    expect(mapSubscription({ ...base, domain: null, vendor: "microsoft" } as SubscriptionRow).domain).toBeNull();
  });
  it("R-1770: old fields stay as they were (DMS still reads the old shape)", () => {
    const m = mapSubscription({ ...base, domain: "acme.in", vendor: "google" } as SubscriptionRow);
    expect(m).toMatchObject({ id: "SUB-1", product: base.plan, plan: "annual", seats: 25, status: "active",
      start_date: "2026-01-01", renewal_date: "2027-01-01", amount: 300000, currency: "INR" });
  });
});

describe("mapInvoice", () => {
  const base = { id: "INV-2026-27-0001", amount: 300000, status: "paid",
    invoice_date: "2026-01-01", due_date: "2026-01-15", pdf_url: "https://x/inv.pdf" } as InvoiceRow;
  it("uses id as number and maps status", () => {
    const m = mapInvoice(base);
    expect(m.number).toBe("INV-2026-27-0001");
    expect(m.status).toBe("paid");
    expect(m.issue_date).toBe("2026-01-01");
  });
  it("maps void → cancelled, pending/draft → unpaid", () => {
    expect(mapInvoice({ ...base, status: "void" }).status).toBe("cancelled");
    expect(mapInvoice({ ...base, status: "pending" }).status).toBe("unpaid");
    expect(mapInvoice({ ...base, status: "draft" }).status).toBe("unpaid");
  });
});

describe("mapQuote", () => {
  const base = { id: "Q-2026-0042", amount: 300000, status: "sent", pdf_url: null,
    public_token: "tok-abc-123" } as QuoteRow;
  it("builds payment_url (with token) and maps status buckets", () => {
    const m = mapQuote(base, "https://app.example.com/");
    expect(m.payment_url).toBe("https://app.example.com/quote/Q-2026-0042/accept?t=tok-abc-123");
    expect(m.status).toBe("pending"); // sent → pending
    expect(mapQuote({ ...base, status: "accepted" }, "x").status).toBe("accepted");
    expect(mapQuote({ ...base, status: "rejected" }, "x").status).toBe("expired");
    expect(mapQuote({ ...base, status: "expired" }, "x").status).toBe("expired");
  });
  it("carries `renews` only when looked up — [] means renews nothing, absent means not looked up", () => {
    expect(mapQuote(base, "x")).not.toHaveProperty("renews");
    expect(mapQuote(base, "x", null, []).renews).toEqual([]);
    expect(mapQuote(base, "x", null, [{ vendor: "hosting", domain: "acme.in" }]).renews).toEqual([{ vendor: "hosting", domain: "acme.in" }]);
  });
  it("R-1770: carries valid_until (the quote's expiry date) and title (the plan the quote is named by)", () => {
    const m = mapQuote({ ...base, expires_date: "2026-11-05", plan: "Google Workspace Business Starter" } as QuoteRow, "x");
    expect(m.valid_until).toBe("2026-11-05");
    expect(m.title).toBe("Google Workspace Business Starter");
  });
  it("R-1770: no expiry / blank plan → null, never a made-up date or name", () => {
    const m = mapQuote({ ...base, expires_date: null, plan: "  " } as QuoteRow, "x");
    expect(m.valid_until).toBeNull();
    expect(m.title).toBeNull();
  });
});

describe("mapPayment", () => {
  const base = { id: "PAY-1", amount: 300000, reference: "razorpay_pay_abc", method: "upi",
    received_at: "2026-01-02T10:15:00Z" } as PaymentRow;
  it("maps received_at → paid_at and injects derived invoice_id", () => {
    const m = mapPayment(base, "INV-9001");
    expect(m.paid_at).toBe("2026-01-02T10:15:00Z");
    expect(m.invoice_id).toBe("INV-9001");
    expect(m.method).toBe("upi");
    expect(mapPayment(base, null).invoice_id).toBeNull();
  });
});
