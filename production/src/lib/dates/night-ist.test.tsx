// @vitest-environment jsdom
/**
 * R-1826 — the night check, run on every push at any hour.
 *
 * R-1653, R-1716 and R-1816 only showed for records made between 00:00 and 05:30 IST: the
 * UTC day is still yesterday then, and a daytime test can never see it. This suite moves the
 * clock to 00:30 IST on 21 Oct 2026 (= 19:00 UTC on 20 Oct) and puts the process in UTC, as
 * Cloud Run is, then runs the real helpers and the real form defaults. Every one must give
 * 21 Oct — the IST day — not 20 Oct.
 *
 * What it covers (the database side — column defaults, money RPCs — is the SQL twin:
 * supabase/tests/night_ist_pin.test.sql):
 *   helpers       istToday / istMonth / istParts / toIstDate / FY on 1 April 00:30 IST
 *   quote         revision draft created_date + expires_date (quotes/[id] "Revise")
 *   invoice date  the "Issue invoice" confirm text ("Dated 21 Oct 2026 (today)")
 *   payment       "Record payment — multiple invoices" opens on today's IST date
 *   TDS stamps    Form 16A received / 26AS verified dates the hooks write
 *   expense       "Add expense" opens on today's IST date
 *   emails        quote email date + the trial-ends line (R-1660)
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/* 00:30 IST on 21 Oct 2026. The UTC calendar day of this instant is 20 Oct. */
const NIGHT = new Date("2026-10-20T19:00:00.000Z");
const IST_DAY = "2026-10-21";
const UTC_DAY = "2026-10-20";

/* ── mocks: the TDS hooks write through createClient — record what they send ── */
const writes: { table: string; payload: Record<string, unknown> }[] = [];
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain = {
        update: (payload: Record<string, unknown>) => { writes.push({ table, payload }); return chain; },
        eq: () => chain,
        select: () => chain,
        single: async () => ({ data: { id: "t1" }, error: null }),
      };
      return chain;
    },
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [], isLoading: false }),
  useRecentDepositTags: () => ({ data: [] }),
}));
vi.mock("@/components/features/customers/customer-combobox", () => ({ CustomerCombobox: () => null }));
vi.mock("@/lib/queries/payments", () => {
  const none = { isLoading: false, error: null, data: [] };
  return { useCustomerOpenInvoices: () => none, useRecordMultiInvoicePayment: () => ({ mutate: vi.fn(), isPending: false }) };
});
vi.mock("@/lib/queries/expenses", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/expenses")>();
  return {
    ...real,
    useCreateExpense: () => ({ mutateAsync: vi.fn() }),
    useUpdateExpense: () => ({ mutateAsync: vi.fn() }),
    useExpenseDupList: () => ({ data: [] }),
    useCommissionToPayeeThisFy: () => ({ data: undefined }),
    useVendorTdsThisFy: () => ({ data: undefined }),
  };
});
vi.mock("@/lib/queries/marketing-campaigns", () => ({ useCampaignOptions: () => ({ data: [] }) }));
vi.mock("@/lib/queries/payroll", () => ({ useEmployees: () => ({ data: [] }) }));
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: [] }), ensureVendor: vi.fn(async () => null) }));
vi.mock("@/lib/queries/reimbursements", () => ({ useAddReimbursement: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/queries/vendor-bills", () => ({ uploadBillAttachment: vi.fn() }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/queries/advances", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/advances")>();
  return { ...real, useEmployeeAdvances: () => ({ data: [] }) };
});

import { istToday, istMonth, istParts, toIstDate, fyStartYear, formatIstDate, IST_TZ } from "./ist";
import { fiscalYearFromDate, useMarkCertReceived, useMarkVerified26AS } from "@/lib/queries/tds-receivable";
import { revisionDraft, nextRevision, type RevisionSource } from "@/lib/quotes/revise";
import { issueConsequences } from "@/lib/invoices/issue-consequences";
import { indianDate } from "@/lib/email/quote-body";
import { MultiInvoicePaymentDialog } from "@/components/features/payments/multi-invoice-payment-dialog";
import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";

const prevTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC"; // Cloud Run's zone — a local-time shortcut must not pass by luck on an IST laptop
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NIGHT);
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterAll(() => {
  vi.useRealTimers();
  if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
});
afterEach(cleanup);

describe("R-1826 night check — 00:30 IST (19:00 UTC the day before)", () => {
  it("the trap is armed: the UTC day of now is still yesterday", () => {
    expect(new Date().toISOString().slice(0, 10)).toBe(UTC_DAY);
    expect(new Date().getDate()).toBe(20); // process zone is UTC, like the server
  });

  it("date helpers give the IST day", () => {
    expect(istToday()).toBe(IST_DAY);
    expect(toIstDate(new Date())).toBe(IST_DAY);
    expect(istMonth()).toBe("2026-10");
    expect(istParts()).toMatchObject({ date: IST_DAY, day: 21, hour: 0, minute: 30 });
    expect(formatIstDate(new Date())).toBe("21 Oct 2026");
  });

  it("1 April 00:30 IST is already the new financial year", () => {
    vi.setSystemTime(new Date("2027-03-31T19:00:00.000Z"));
    try {
      expect(istToday()).toBe("2027-04-01");
      expect(fyStartYear()).toBe(2027);
      expect(fiscalYearFromDate(istToday())).toBe(fiscalYearFromDate("2027-04-01"));
      expect(fiscalYearFromDate(istToday())).not.toBe(fiscalYearFromDate("2027-03-31"));
    } finally {
      vi.setSystemTime(NIGHT);
    }
  });

  it("quote: a revision draft is created today (IST) and expires counted from today", () => {
    const q = { id: "Q-T-1", revision_of: null, revision_no: 1, created_date: "2026-10-01", expires_date: "2026-10-31" } as unknown as RevisionSource;
    const draft = revisionDraft(q, nextRevision(q), istToday());
    expect(draft.created_date).toBe(IST_DAY);
    expect(draft.expires_date).toBe("2026-11-20"); // same 30-day validity, from 21 Oct
  });

  it("invoice: the Issue invoice confirm says it is dated today (IST)", () => {
    const out = issueConsequences({
      quote: { id: "Q-T-1", customerName: "Night Co", amount: 1000, paymentTermsDays: 30, invoiceDate: istToday() },
      series: null,
    });
    const text = out.consequences.map((c) => c.text).join("\n");
    expect(text).toMatch(/Dated 21 Oct 2026 \(today\)/);
  });

  it("payment received: Record payment — multiple invoices opens on today's IST date", () => {
    render(<MultiInvoicePaymentDialog open onOpenChange={() => {}} customerId="c1" customerName="Night Co" />);
    expect((document.getElementById("mip_receivedDate") as HTMLInputElement).value).toBe(IST_DAY);
  });

  it("expense: Add expense opens on today's IST date", () => {
    render(<AddExpenseDialog onClose={() => {}} />);
    expect((document.getElementById("expense_date") as HTMLInputElement).value).toBe(IST_DAY);
  });

  it("TDS: Form 16A received and 26AS verified are stamped with the IST day", async () => {
    writes.length = 0;
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const cert = renderHook(() => useMarkCertReceived(), { wrapper });
    const v26 = renderHook(() => useMarkVerified26AS(), { wrapper });
    await cert.result.current.mutateAsync({ id: "t1" });
    await v26.result.current.mutateAsync("t1");
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]).toMatchObject({ table: "tds_receivable", payload: { form_16a_received_date: IST_DAY } });
    expect(writes[1]).toMatchObject({ table: "tds_receivable", payload: { appears_in_26as_date: IST_DAY } });
  });

  it("customer emails (R-1660): the quote date and the trial-ends line read the IST day", () => {
    expect(indianDate(istToday())).toMatch(/^21 Oct/);
    // start-trial.ts builds "trial ends" exactly like this; 15 days from 00:30 IST 21 Oct = 5 Nov.
    const ends = new Date(Date.now() + 15 * 86_400_000);
    expect(ends.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: IST_TZ })).toMatch(/^05 Nov 2026$/);
    // …and without the zone it would have said 4 Nov — the bug the R-1660 scan blocks.
    expect(ends.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })).toMatch(/^04 Nov 2026$/);
  });
});
