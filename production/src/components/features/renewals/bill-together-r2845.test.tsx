// @vitest-environment jsdom
/* R-2845 (rev-r2831 M1/L5) — the Bill together screen on R-2831's API:
   (1) Create sends `periods: [{subscriptionId, periodStart}]` — each ticked line's part exactly as the dialog shows it,
       so the route's period guard decides a retry (no 15-min fallback);
   (2) an `action: "invoice"` answer (the money already received paid the group) says so and opens the invoice
       (href from the API), never "Proforma created";
   (3) every reason the preview returns is shown (two reasons with one code both show). The API is mocked. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillTogetherPreview, BillTogetherSub } from "@/lib/renewals/bill-together";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const toastSuccess = vi.fn();
const toastInfo = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), info: (...a: unknown[]) => toastInfo(...a), error: (...a: unknown[]) => toastError(...a) } }));

import { useBillTogether } from "./bill-together";
import { createTogetherProforma } from "@/lib/renewals/bill-together";
import { focusManager } from "@tanstack/react-query";

/* CI red 15 Nov: the dialog render alone used the whole default 5 s on a loaded shard (no timers in the code, pure CPU load),
   so the 5 s waits below and vitest 5 s test limit expired together. 30 s limit for this file; waits stay under it. */
vi.setConfig({ testTimeout: 30_000 });

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); push.mockReset(); toastSuccess.mockReset(); toastInfo.mockReset(); toastError.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const sub = (id: string, plan: string, periodStart: string, o: Partial<BillTogetherSub> = {}): BillTogetherSub => ({
  subscriptionId: id, plan, customerId: "c-it", customerName: "ITBUZZ Technologies",
  line: { seats: 2, seatRate: 500, periodStart, periodEnd: "2026-11-11", taxable: 1000, taxRate: 18, tax: 180, gross: 1180 },
  reasons: [], onTogetherBill: null, ...o,
});
const PREVIEW: BillTogetherPreview = {
  subs: [
    sub("a", "Business Standard", "2026-10-12"),
    sub("b", "Business Starter", "2026-10-15"),
    sub("c", "Business Plus", "2026-10-12"),
  ],
  total: { taxable: 3000, tax: 540, gross: 3540 },
  currency: "INR",
};

function Harness({ ids = ["a", "b", "c"], canQuotes = true, canInvoices = true }: { ids?: string[]; canQuotes?: boolean; canInvoices?: boolean }) {
  const bt = useBillTogether({ canQuotes, canInvoices });
  return <><button type="button" onClick={() => bt.open(ids, "ITBUZZ Technologies")}>go</button>{bt.dialog}</>;
}
const posts = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST");
const bodyOf = (i: number) => JSON.parse(String((posts()[i][1] as RequestInit).body)) as { ids: string[]; periods?: unknown };

async function openAndCreate(answer: unknown, opts: { untick?: string; canQuotes?: boolean; canInvoices?: boolean } = {}) {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? json(200, answer) : json(200, PREVIEW)));
  wrap(<Harness canQuotes={opts.canQuotes} canInvoices={opts.canInvoices} />);
  fireEvent.click(screen.getByRole("button", { name: "go" }));
  /* generous waits: on a loaded laptop the first render can pass 1 s (a flaky red, not a bug) */
  await screen.findAllByTestId("bill-together-line", {}, { timeout: 20_000 });
  if (opts.untick) fireEvent.click(screen.getByLabelText(opts.untick));
  fireEvent.click(screen.getByRole("button", { name: "Create proforma" }));
  await waitFor(() => expect(posts()).toHaveLength(1), { timeout: 20_000 });
}

describe("R-2845 (1) — Create sends the periods the dialog showed", () => {
  it("each ticked line's own periodStart goes with its id, in the shown order", async () => {
    await openAndCreate({ quoteId: "PI-1", href: "/quotes/PI-1", alreadyExisted: false, subscriptionIds: ["a", "b", "c"], action: "request", invoiceId: null });
    expect(bodyOf(0)).toEqual({
      ids: ["a", "b", "c"],
      periods: [
        { subscriptionId: "a", periodStart: "2026-10-12" },
        { subscriptionId: "b", periodStart: "2026-10-15" },
        { subscriptionId: "c", periodStart: "2026-10-12" },
      ],
    });
  });

  it("an unticked line is in neither ids nor periods", async () => {
    await openAndCreate({ quoteId: "PI-1", href: "/quotes/PI-1", alreadyExisted: false, subscriptionIds: ["a", "c"], action: "request", invoiceId: null },
      { untick: "Business Starter" });
    expect(bodyOf(0)).toEqual({
      ids: ["a", "c"],
      periods: [{ subscriptionId: "a", periodStart: "2026-10-12" }, { subscriptionId: "c", periodStart: "2026-10-12" }],
    });
  });

  it("createTogetherProforma without periods (an older caller) sends ids only", async () => {
    fetchMock.mockResolvedValue(json(200, { quoteId: "PI-1", href: "/quotes/PI-1", alreadyExisted: false, subscriptionIds: ["a", "b"], action: "request", invoiceId: null }));
    await createTogetherProforma(["a", "b"]);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ ids: ["a", "b"] });
  });
});

describe("R-2845 (2) — an 'invoice' answer opens the invoice", () => {
  const INVOICED = { quoteId: "PI-F588-27-0101", href: "/invoices/ANU%2F26-27%2F0042", alreadyExisted: false,
    subscriptionIds: ["a", "b", "c"], action: "invoice", invoiceId: "ANU/26-27/0042" };

  it("toast says 'Invoice <no> — already paid from money received' and the API's href opens", async () => {
    await openAndCreate(INVOICED);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/invoices/ANU%2F26-27%2F0042"));
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess.mock.calls[0][0]).toBe("Invoice ANU/26-27/0042 — already paid from money received");
    expect(String(toastSuccess.mock.calls[0][0])).not.toMatch(/Proforma/);
  });

  it("a retry answered with the same invoice (alreadyExisted) says the same and opens it", async () => {
    await openAndCreate({ ...INVOICED, alreadyExisted: true });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/invoices/ANU%2F26-27%2F0042"));
    expect(toastSuccess.mock.calls[0][0]).toBe("Invoice ANU/26-27/0042 — already paid from money received");
  });

  it("a 'request' answer still says Proforma … created and opens the proforma", async () => {
    await openAndCreate({ quoteId: "PI-1", href: "/quotes/PI-1", alreadyExisted: false, subscriptionIds: ["a", "b", "c"], action: "request", invoiceId: null });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/quotes/PI-1"));
    expect(toastSuccess.mock.calls[0][0]).toBe("Proforma PI-1 created for 3 subscriptions of ITBUZZ Technologies — not sent yet");
  });

  it("an older server with no action field: the proforma words (href decides nothing)", async () => {
    await openAndCreate({ quoteId: "PI-1", href: "/quotes/PI-1", alreadyExisted: true, subscriptionIds: ["a", "b", "c"] });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/quotes/PI-1"));
    expect(toastSuccess.mock.calls[0][0]).toBe("Opening the existing proforma PI-1 for ITBUZZ Technologies");
  });
});

describe("R-2845 (3) — every reason the preview gives is shown", () => {
  it("two not_billable reasons and a sale_sibling reason all show, and the line cannot be ticked", async () => {
    const refused = sub("b", "Business Starter", "2026-10-15", {
      line: null,
      reasons: [
        { code: "not_billable", text: "It is suspended — only an active subscription can be billed." },
        { code: "not_billable", text: "It is marked Won't renew — press Undo Won't renew on the subscription first." },
        { code: "sale_sibling", text: "It is sold with Business Standard on sale quote PI-9, whose parts are not laid yet." },
        { code: "first_part_of_sale", text: "Its first part is billed by its sale quote PI-9." },
      ],
    });
    fetchMock.mockImplementation(async () => json(200, { ...PREVIEW, subs: [PREVIEW.subs[0], refused, PREVIEW.subs[2]] }));
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findAllByTestId("bill-together-line");
    const shown = screen.getAllByTestId("bill-together-reason").map((p) => p.textContent);
    expect(shown).toHaveLength(4);
    expect(shown[1]).toMatch(/Won't renew/);
    expect((screen.getByLabelText("Business Starter") as HTMLInputElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create proforma" })); });
    expect(bodyOf(0).ids).toEqual(["a", "c"]);
  });
});

describe("R-2845 review fixes", () => {
  it("an empty periods list is not sent (an older caller) — the route would refuse [] as 'bad'", async () => {
    fetchMock.mockResolvedValue(json(200, { quoteId: "PI-1", href: "/quotes/PI-1", alreadyExisted: false, subscriptionIds: ["a", "b"] }));
    await createTogetherProforma(["a", "b"], []);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ ids: ["a", "b"] });
  });

  it("an invoice answer for a login that cannot open invoices: the toast, but no navigation", async () => {
    await openAndCreate({ quoteId: "PI-2", href: "/invoices/INV-7", alreadyExisted: false, subscriptionIds: ["a", "b", "c"], action: "invoice", invoiceId: "INV-7" },
      { canInvoices: false });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Invoice INV-7 — already paid from money received", expect.anything()));
    expect(push).not.toHaveBeenCalled();
  });

  it("a lost answer, then the window regains focus: the lines are NOT reloaded and Create sends the SAME parts (the route answers that bill, never the next month)", async () => {
    let previews = 0;
    let first = true;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") {
        previews++;
        /* after the first load the server would show next month's parts (the first ones were billed) */
        return json(200, previews === 1 ? PREVIEW : { ...PREVIEW, subs: PREVIEW.subs.map((s) => ({ ...s, line: { ...s.line!, periodStart: "2026-11-12" } })) });
      }
      if (first) { first = false; throw new TypeError("Failed to fetch"); }
      return json(200, { quoteId: "PI-9", href: "/invoices/INV-9", alreadyExisted: true, subscriptionIds: ["a", "b", "c"], action: "invoice", invoiceId: "INV-9" });
    });
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findAllByTestId("bill-together-line", {}, { timeout: 20_000 });
    fireEvent.click(screen.getByRole("button", { name: "Create proforma" }));
    await waitFor(() => expect(toastError).toHaveBeenCalled(), { timeout: 20_000 });
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(previews).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Create proforma" }));
    await waitFor(() => expect(posts()).toHaveLength(2), { timeout: 20_000 });
    expect(bodyOf(1)).toEqual(bodyOf(0));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/invoices/INV-9"));
    focusManager.setFocused(undefined);
  });

  it("a 409 (a part moved): no Retry on the toast (it would resend the same parts) and the lines reload", async () => {
    let previews = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") { previews++; return json(200, PREVIEW); }
      return json(409, { error: "What will be billed changed since you opened it — refresh Renewals and check again." });
    });
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findAllByTestId("bill-together-line", {}, { timeout: 20_000 });
    fireEvent.click(screen.getByRole("button", { name: "Create proforma" }));
    await waitFor(() => expect(toastError).toHaveBeenCalled(), { timeout: 20_000 });
    const opts = toastError.mock.calls[0][1] as { action?: unknown } | undefined;
    expect(opts?.action).toBeUndefined();
    await waitFor(() => expect(previews).toBe(2), { timeout: 20_000 });
  });
});
