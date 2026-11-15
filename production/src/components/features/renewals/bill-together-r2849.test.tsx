// @vitest-environment jsdom
/* R-2849 — Bill together for YEARLY subscriptions on Renewals: the same box / dialog as R-2808. The preview says
   kind "renewal" → the dialog is "one renewal quote": a line per subscription's next year (own seats, rate, period),
   the total with GST on it, "Create renewal quote"; Create posts the ids + each line's term start and opens the quote.
   A yearly group in the box says it becomes one renewal quote. The API is mocked. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillTogetherPreview } from "@/lib/renewals/bill-together";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), info: vi.fn(), error: vi.fn() } }));

import { BillTogetherGroups, useBillTogether, togetherDone, groupWhyText, togetherHint } from "./bill-together";

const line = (seats: number, rate: number, start: string, end: string) => {
  const taxable = seats * rate;
  const tax = Math.round(taxable * 0.18);
  return { seats, seatRate: rate, periodStart: start, periodEnd: end, taxable, taxRate: 18, tax, gross: taxable + tax };
};
const PREVIEW: BillTogetherPreview = {
  kind: "renewal",
  subs: [
    { subscriptionId: "std", plan: "Business Standard", customerId: "c-it", customerName: "ITBUZZ Technologies", line: line(20, 1080, "2026-10-31", "2027-10-30"), reasons: [], onTogetherBill: null },
    { subscriptionId: "sta", plan: "Business Starter", customerId: "c-it", customerName: "ITBUZZ Technologies", line: line(10, 1632.5, "2026-11-15", "2027-11-14"), reasons: [], onTogetherBill: null },
  ],
  total: { taxable: 37925, tax: 6827, gross: 44752 },
  currency: "INR",
};

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); push.mockReset(); toastSuccess.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function Harness() {
  const bt = useBillTogether({ canQuotes: true });
  return <><button type="button" onClick={() => bt.open(["std", "sta"], "ITBUZZ Technologies")}>go</button>{bt.dialog}</>;
}

describe("R-2849 yearly Bill together dialog", () => {
  it("one renewal quote: each line its own seats × rate and next-year period, total with GST on the total (paise), Create renewal quote", async () => {
    fetchMock.mockImplementation(async () => json(200, PREVIEW));
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    const lines = await screen.findAllByTestId("bill-together-line");
    expect(screen.getByRole("heading", { name: "Bill together — one renewal quote" })).toBeTruthy();
    expect(lines[0].textContent).toContain("20 seats × ₹1,080.00");
    expect(lines[0].textContent).toMatch(/31 Oct 2026.*30 Oct 2027/);
    expect(lines[1].textContent).toContain("10 seats × ₹1,632.50");
    expect(lines[1].textContent).toMatch(/15 Nov 2026.*14 Nov 2027/);
    expect(screen.getByTestId("bill-together-total").textContent).toContain("₹37,925.00 + GST ₹6,827.00 = ₹44,752.00");
    expect(screen.getByText(/each subscription renews for its own next year; a part payment renews none/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create proforma" })).toBeNull();
  });

  it("Create → POST ids + each line's term start → toast 'Renewal quote … created' and the quote opens", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? json(200, { quoteId: "Q-F588-27-0200", href: "/quotes/Q-F588-27-0200", alreadyExisted: false, subscriptionIds: ["std", "sta"], action: "renewal_quote", invoiceId: null })
      : json(200, PREVIEW));
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findAllByTestId("bill-together-line");
    fireEvent.click(screen.getByRole("button", { name: "Create renewal quote" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/quotes/Q-F588-27-0200"));
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
      ids: ["std", "sta"], periods: [{ subscriptionId: "std", periodStart: "2026-10-31" }, { subscriptionId: "sta", periodStart: "2026-11-15" }],
    });
    expect(toastSuccess.mock.calls[0][0]).toBe("Renewal quote Q-F588-27-0200 created for 2 subscriptions of ITBUZZ Technologies — not emailed yet");
  });

  it("a refused yearly line (e.g. mixed with parts) stays unticked with its reason; under two Create is off", async () => {
    fetchMock.mockImplementation(async () => json(200, { ...PREVIEW, subs: [PREVIEW.subs[0], { ...PREVIEW.subs[1], line: null,
      reasons: [{ code: "mixed_billing", text: "It is billed monthly in parts, the others are renewed once a year — parts and yearly renewals cannot be on one bill. Bill its part with Bill next part." }] }] }));
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findAllByTestId("bill-together-line");
    expect(screen.getByTestId("bill-together-reason").textContent).toMatch(/parts and yearly renewals cannot be on one bill/);
    expect((screen.getByRole("button", { name: "Create renewal quote" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Tick at least two subscriptions — one alone is renewed with Review renewal quote.");
  });
});

describe("R-2849 words", () => {
  it("togetherDone: renewal_quote → 'Renewal quote … created' / 'Opening the existing renewal quote …'; never an invoice", () => {
    expect(togetherDone({ quoteId: "Q-1", href: "/quotes/Q-1", alreadyExisted: false, subscriptionIds: ["a", "b"], action: "renewal_quote" }, 2, "ITBUZZ"))
      .toEqual({ text: "Renewal quote Q-1 created for 2 subscriptions of ITBUZZ — not emailed yet", invoiced: false });
    expect(togetherDone({ quoteId: "Q-1", href: "/quotes/Q-1", alreadyExisted: true, subscriptionIds: ["a", "b"], action: "renewal_quote" }, 2, "ITBUZZ"))
      .toEqual({ text: "Opening the existing renewal quote Q-1 for ITBUZZ", invoiced: false });
  });

  it("a yearly group says it becomes one renewal quote; a parts group as before", () => {
    expect(groupWhyText({ why: "same-bill", kind: "renewal" })).toBe("Billed together last time · one renewal quote");
    expect(groupWhyText({ why: "same-domain", kind: "renewal" })).toBe("Same domain and renewal month · one renewal quote");
    expect(groupWhyText({ why: "same-domain", kind: "parts" })).toBe("Same domain and period");
    expect(groupWhyText({ why: "same-bill" })).toBe("Billed together last time");
  });

  it("the box shows a yearly group ticked by default with its label; the row hint's tooltip says renewal quote", () => {
    const G = { customerId: "c-it", customerName: "ITBUZZ Technologies", subIds: ["std", "sta"], why: "same-bill" as const, kind: "renewal" as const };
    const onBill = vi.fn();
    render(<BillTogetherGroups groups={[G]} subOf={(id) => ({ id, plan: id === "std" ? "Business Standard" : "Business Starter", seats: 20 })}
      onBill={onBill} off={new Set()} onToggle={() => {}} />);
    expect(screen.getByTestId("bill-together-why").textContent).toBe("Billed together last time · one renewal quote");
    fireEvent.click(screen.getByRole("button", { name: /Bill together — ITBUZZ Technologies \(2\)/ }));
    expect(onBill).toHaveBeenCalledWith(["std", "sta"], "ITBUZZ Technologies");
    expect(togetherHint({ group: G, text: "Bills with Business Starter" }, new Set(), vi.fn()).title).toBe("Bills with Business Starter — renew them on one renewal quote");
  });
});
