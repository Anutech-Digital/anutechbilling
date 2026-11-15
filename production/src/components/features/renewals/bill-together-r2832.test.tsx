// @vitest-environment jsdom
/* R-2832 (rev-r2808 F2/F3/F5/F6) — Bill together:
   F2 one in-flight POST (double click, toast Retry); F3 paise in the dialog and paise-rounded totals;
   F5 the row hint under two ticked says "tick at least two" and does not open the dialog;
   F6 a transient 500 on the probe is retried (not cached as "off" for 10 min) and the box keeps its space
   while the probe is out. The API is mocked. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillTogetherPreview } from "@/lib/renewals/bill-together";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const toastSuccess = vi.fn();
const toastInfo = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), info: (...a: unknown[]) => toastInfo(...a), error: (...a: unknown[]) => toastError(...a) } }));

import { BillTogetherGroups, togetherHint, useBillTogether } from "./bill-together";
import { BillTogetherDialog, tickedTotal, useBillTogetherProbe } from "./bill-together-dialog";
import { billTogetherAvailable } from "@/lib/renewals/bill-together";

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); push.mockReset(); toastSuccess.mockReset(); toastInfo.mockReset(); toastError.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const sub = (id: string, plan: string, taxable: number, tax: number) => ({
  subscriptionId: id, plan, customerId: "c-it", customerName: "ITBUZZ Technologies",
  line: { seats: 1, seatRate: taxable, periodStart: "2026-10-01", periodEnd: "2026-10-31", taxable, taxRate: 18, tax, gross: Math.round((taxable + tax) * 100) / 100 },
  reasons: [], onTogetherBill: null,
});
/* amounts with paise — 0.1 + 0.2 style float sums must still come out to the paisa */
const PREVIEW: BillTogetherPreview = {
  subs: [sub("a", "Business Standard", 1585.1, 285.32), sub("b", "Business Starter", 450.2, 81.04)],
  total: { taxable: 0, tax: 0, gross: 0 },
  currency: "INR",
};

describe("F3 — the dialog shows paise and sums to the paisa", () => {
  it("tickedTotal is rounded to paise (no float tail)", () => {
    const t = tickedTotal([sub("x", "X", 0.1, 0.02), sub("y", "Y", 0.2, 0.04)], new Set(["x", "y"]));
    expect(t).toEqual({ taxable: 0.3, tax: 0.06, gross: 0.36 });
  });

  it("each line and the total show two decimals", async () => {
    fetchMock.mockImplementation(async () => json(200, PREVIEW));
    wrap(<BillTogetherDialog ids={["a", "b"]} customerName="ITBUZZ Technologies" open onOpenChange={() => {}} onConfirm={vi.fn()} busy={false} />);
    const lines = await screen.findAllByTestId("bill-together-line");
    expect(lines[0].textContent).toContain("× ₹1,585.10");
    expect(lines[0].textContent).toContain("₹1,585.10 + GST 18% ₹285.32");
    expect(lines[0].textContent).toContain("₹1,870.42");
    expect(screen.getByTestId("bill-together-total").textContent).toContain("₹2,035.30 + GST ₹366.36 = ₹2,401.66");
  });
});

function Harness({ ids = ["a", "b"] }: { ids?: string[] }) {
  const bt = useBillTogether({ canQuotes: true });
  return <><button type="button" onClick={() => bt.open(ids, "ITBUZZ Technologies")}>go</button>{bt.dialog}</>;
}
const posts = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST");

describe("F2 — one in-flight request", () => {
  it("a double click on Create sends ONE POST", async () => {
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method === "POST"
      ? new Promise<Response>((r) => { answer = r; })
      : Promise.resolve(json(200, PREVIEW)));
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findAllByTestId("bill-together-line");
    const create = screen.getByRole("button", { name: "Create proforma" });
    fireEvent.click(create);
    fireEvent.click(create);
    expect(posts()).toHaveLength(1);
    await act(async () => { answer(json(200, { quoteId: "PI-1", href: "/quotes/PI-1", alreadyExisted: false, subscriptionIds: ["a", "b"] })); });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/quotes/PI-1"));
    expect(posts()).toHaveLength(1);
  });

  it("the error toast's Retry pressed twice while the retry is out sends ONE more POST, and works after the dialog is closed", async () => {
    let answer: (r: Response) => void = () => {};
    let first = true;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Promise.resolve(json(200, PREVIEW));
      if (first) { first = false; return Promise.resolve(json(500, { error: "Server busy" })); }
      return new Promise<Response>((r) => { answer = r; });
    });
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findAllByTestId("bill-together-line");
    fireEvent.click(screen.getByRole("button", { name: "Create proforma" }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const opts = toastError.mock.calls[0][1] as { action?: { label: string; onClick: () => void } };
    expect(opts.action?.label).toBe("Retry");
    /* the owner closes the dialog, then presses Retry on the toast — twice */
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => { opts.action!.onClick(); opts.action!.onClick(); });
    expect(posts()).toHaveLength(2);
    await act(async () => { answer(json(200, { quoteId: "PI-2", href: "/quotes/PI-2", alreadyExisted: false, subscriptionIds: ["a", "b"] })); });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/quotes/PI-2"));
    expect(toastSuccess.mock.calls.at(-1)?.[0]).toContain("for 2 subscriptions of ITBUZZ Technologies");
    expect(posts()).toHaveLength(2);
  });
});

describe("F5 — the row hint under two ticked", () => {
  const G = { customerId: "c-it", customerName: "ITBUZZ Technologies", subIds: ["a", "b"], why: "same-bill" as const };
  it("two ticked → 'Bills with …' opens the dialog with them", () => {
    const open = vi.fn();
    const h = togetherHint({ group: G, text: "Bills with Business Starter" }, new Set(), open);
    expect(h.text).toBe("Bills with Business Starter");
    h.onClick();
    expect(open).toHaveBeenCalledWith(["a", "b"], "ITBUZZ Technologies");
  });
  it("one unticked → says tick at least two and does not open a near-empty dialog", () => {
    const open = vi.fn();
    const h = togetherHint({ group: G, text: "Bills with Business Starter" }, new Set(["b"]), open);
    expect(h.text).toBe("Bills with Business Starter — tick at least two");
    expect(h.title).toMatch(/Tick at least two/);
    h.onClick();
    expect(open).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith(expect.stringMatching(/Tick at least two subscriptions of ITBUZZ Technologies in the Bill together box/));
  });
});

describe("F6 — probe: retry on error, keep the box's space", () => {
  it("billTogetherAvailable: 5xx throws (retryable), 404/403 is a real no, 400 a yes", async () => {
    const f = (status: number) => (async () => new Response("x", { status })) as unknown as typeof fetch;
    await expect(billTogetherAvailable(f(500))).rejects.toThrow(/500/);
    await expect(billTogetherAvailable(f(503))).rejects.toThrow();
    await expect(billTogetherAvailable(f(404))).resolves.toBe(false);
    await expect(billTogetherAvailable(f(403))).resolves.toBe(false);
    await expect(billTogetherAvailable(f(400))).resolves.toBe(true);
  });

  function Probe() { return <p data-testid="probe">{useBillTogetherProbe()}</p>; }
  it("one 500 then 400 → 'on' (retried, not hidden for 10 min)", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => (n++ === 0 ? new Response("boom", { status: 500 }) : json(400, { error: "ids needed" })));
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("on"), { timeout: 4000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("while the probe is out the groups box holds its place (same rows, no layout jump), with nothing pressable", () => {
    const G = { customerId: "c-it", customerName: "ITBUZZ Technologies", subIds: ["a", "b"], why: "same-bill" as const };
    const onBill = vi.fn();
    wrap(<BillTogetherGroups groups={[G]} pending subOf={() => undefined} onBill={onBill} off={new Set()} onToggle={vi.fn()} />);
    const box = screen.getByTestId("bill-together-groups");
    expect(box.getAttribute("aria-busy")).toBe("true");
    expect(box.textContent).toContain("ITBUZZ Technologies");
    expect(screen.getAllByTestId("bill-together-group")).toHaveLength(1);
    const btn = screen.getByRole("button", { name: /Bill together — ITBUZZ/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    for (const c of screen.getAllByRole("checkbox")) expect((c as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(onBill).not.toHaveBeenCalled();
  });
});
