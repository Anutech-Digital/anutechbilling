// @vitest-environment jsdom
/* R-2808 — Bill together on Renewals (R-2805, Pratik: ITBUZZ Business Standard + Business Starter were on
   ONE bill last cycle). Pardeep 14 Nov: "un subscription ko group me selected by default dikhao" — the
   group and the dialog start with every subscription ticked; untick drops one. The API (R-2807) is mocked. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillTogetherPreview } from "@/lib/renewals/bill-together";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), info: vi.fn(), error: vi.fn() } }));

import { BillTogetherGroups, useBillTogether } from "./bill-together";
import { BillTogetherDialog, useBillTogetherAvailable, tickedTotal } from "./bill-together-dialog";
import { BillNextPartDialog } from "./bill-next-part-dialog";

const GROUP = { customerId: "c-it", customerName: "ITBUZZ Technologies", subIds: ["std", "sta"], why: "same-bill" as const };
const SUBS: Record<string, { id: string; plan: string; seats: number }> = {
  std: { id: "std", plan: "Business Standard", seats: 161 },
  sta: { id: "sta", plan: "Business Starter", seats: 49 },
  ext: { id: "ext", plan: "Business Plus", seats: 3 },
};

const line = (seats: number, rate: number) => {
  const taxable = seats * rate;
  const tax = Math.round(taxable * 0.18);
  return { seats, seatRate: rate, periodStart: "2026-10-01", periodEnd: "2026-10-31", taxable, taxRate: 18, tax, gross: taxable + tax };
};
const PREVIEW: BillTogetherPreview = {
  subs: [
    { subscriptionId: "std", plan: "Business Standard", customerId: "c-it", customerName: "ITBUZZ Technologies", line: line(161, 1585), reasons: [], onTogetherBill: null },
    { subscriptionId: "sta", plan: "Business Starter", customerId: "c-it", customerName: "ITBUZZ Technologies", line: line(49, 450), reasons: [], onTogetherBill: null },
    { subscriptionId: "ext", plan: "Business Plus", customerId: "c-it", customerName: "ITBUZZ Technologies", line: null,
      reasons: [{ code: "unpaid_earlier_part", text: "Its Sep part is still unpaid — record that payment first" }], onTogetherBill: null },
  ],
  total: { taxable: 161 * 1585 + 49 * 450, tax: 0, gross: 0 },
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
const box = (name: RegExp | string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

/** The page keeps the unticked set (the row hint uses it too) — the same state here. */
function Groups({ groups, onBill }: { groups: React.ComponentProps<typeof BillTogetherGroups>["groups"]; onBill: (ids: string[], name: string) => void }) {
  const [off, setOff] = React.useState<Set<string>>(() => new Set());
  return (
    <BillTogetherGroups groups={groups} subOf={(id) => SUBS[id]} onBill={onBill} off={off}
      onToggle={(id, on) => setOff((o) => { const n = new Set(o); if (on) n.delete(id); else n.add(id); return n; })} />
  );
}

describe("R-2808 suggested group — ticked by default", () => {
  it("every subscription of the group starts ticked; Bill together sends them all in one click", () => {
    const onBill = vi.fn();
    wrap(<Groups groups={[GROUP]} onBill={onBill} />);
    expect(screen.getByTestId("bill-together-why").textContent).toBe("Billed together last time");
    expect(box(/Business Standard · 161 seats/).checked).toBe(true);
    expect(box(/Business Starter · 49 seats/).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Bill together — ITBUZZ Technologies \(2\)/ }));
    expect(onBill).toHaveBeenCalledWith(["std", "sta"], "ITBUZZ Technologies");
  });

  it("untick one → under two, the button is off; tick it back → on again", () => {
    const onBill = vi.fn();
    wrap(<Groups groups={[{ ...GROUP, subIds: ["std", "sta", "ext"] }]} onBill={onBill} />);
    fireEvent.click(box(/Business Plus/));
    expect(box(/Business Plus/).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Bill together — ITBUZZ Technologies \(2\)/ }));
    expect(onBill).toHaveBeenLastCalledWith(["std", "sta"], "ITBUZZ Technologies");
    fireEvent.click(box(/Business Starter/));
    expect((screen.getByRole("button", { name: /\(1\)/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box(/Business Starter/));
    expect((screen.getByRole("button", { name: /\(2\)/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a same-domain match never claims it was billed together", () => {
    wrap(<Groups groups={[{ ...GROUP, why: "same-domain" }]} onBill={vi.fn()} />);
    expect(screen.getByTestId("bill-together-why").textContent).toBe("Same domain and period");
  });

  it("no group → nothing rendered", () => {
    const { container } = wrap(<Groups groups={[]} onBill={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});

describe("R-2808 Bill together dialog", () => {
  function show(onConfirm = vi.fn()) {
    fetchMock.mockImplementation(async () => json(200, PREVIEW));
    wrap(<BillTogetherDialog ids={["std", "sta", "ext"]} customerName="ITBUZZ Technologies" open onOpenChange={() => {}} onConfirm={onConfirm} busy={false} />);
    return onConfirm;
  }

  it("lists each sub's line (seats × rate, period, GST), joinable ones ticked; a refused one unticked with its reason", async () => {
    show();
    const lines = await screen.findAllByTestId("bill-together-line");
    expect(fetchMock).toHaveBeenCalledWith("/api/renewals/bill-together?ids=std,sta,ext", { method: "GET" });
    expect(lines[0].textContent).toContain("161 seats × ₹1,585.00 · 1 Oct–31 Oct 2026");
    expect(lines[0].textContent).toContain("GST 18%");
    expect(box("Business Standard").checked).toBe(true);
    expect(box("Business Starter").checked).toBe(true);
    expect(box("Business Plus").checked).toBe(false);
    expect(box("Business Plus").disabled).toBe(true);
    expect(screen.getByTestId("bill-together-reason").textContent).toBe("Its Sep part is still unpaid — record that payment first");
    expect(screen.getByTestId("bill-together-total").textContent).toContain("Total (2 lines)");
  });

  it("untick drops the line from the total and from Create; under two lines Create is off", async () => {
    const onConfirm = show();
    await screen.findAllByTestId("bill-together-line");
    const both = tickedTotal(PREVIEW.subs, new Set(["std", "sta"]));
    expect(screen.getByTestId("bill-together-total").textContent).toContain(`= ₹${both.gross.toLocaleString("en-IN")}`);
    fireEvent.click(screen.getByRole("button", { name: "Create proforma" }));
    expect(onConfirm).toHaveBeenCalledWith(["std", "sta"], [{ subscriptionId: "std", periodStart: "2026-10-01" }, { subscriptionId: "sta", periodStart: "2026-10-01" }]); // R-2845: + the shown parts
    fireEvent.click(box("Business Starter"));
    const one = tickedTotal(PREVIEW.subs, new Set(["std"]));
    expect(screen.getByTestId("bill-together-total").textContent).toContain(`= ₹${one.gross.toLocaleString("en-IN")}`);
    expect((screen.getByRole("button", { name: "Create proforma" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a background refetch never re-ticks a line the user dropped", async () => {
    fetchMock.mockImplementation(async () => json(200, { ...PREVIEW, currency: "INR", subs: PREVIEW.subs.map((s) => ({ ...s })) }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><BillTogetherDialog ids={["std", "sta", "ext"]} customerName="ITBUZZ Technologies" open onOpenChange={() => {}} onConfirm={vi.fn()} busy={false} /></QueryClientProvider>);
    await screen.findAllByTestId("bill-together-line");
    fireEvent.click(box("Business Starter"));
    fetchMock.mockImplementation(async () => json(200, { ...PREVIEW, currency: "INR", subs: PREVIEW.subs.map((s) => ({ ...s, plan: s.plan })) , total: { taxable: 1, tax: 1, gross: 2 } }));
    await qc.invalidateQueries({ queryKey: ["renewals", "bill-together"] });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(box("Business Starter").checked).toBe(false);
    expect(box("Business Standard").checked).toBe(true);
  });

  it("Create → POST {ids} → one proforma: toast and open it", async () => {
    function Harness() {
      const bt = useBillTogether({ canQuotes: true });
      return <><button type="button" onClick={() => bt.open(["std", "sta"], "ITBUZZ Technologies")}>go</button>{bt.dialog}</>;
    }
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? json(200, { quoteId: "PI-ET-2026-27-0101", href: "/quotes/PI-ET-2026-27-0101", alreadyExisted: false, subscriptionIds: ["std", "sta"] })
      : json(200, { ...PREVIEW, subs: PREVIEW.subs.slice(0, 2) }));
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findAllByTestId("bill-together-line");
    fireEvent.click(screen.getByRole("button", { name: "Create proforma" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/quotes/PI-ET-2026-27-0101"));
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ ids: ["std", "sta"], periods: [{ subscriptionId: "std", periodStart: "2026-10-01" }, { subscriptionId: "sta", periodStart: "2026-10-01" }] }); // R-2845
    expect(toastSuccess.mock.calls[0][0]).toBe("Proforma PI-ET-2026-27-0101 created for 2 subscriptions of ITBUZZ Technologies — not sent yet");
  });
});

describe("R-2808 hidden until R-2807 lands", () => {
  function Probe() { return <p data-testid="probe">{String(useBillTogetherAvailable())}</p>; }
  it("GET 404 → not available (no button anywhere)", async () => {
    fetchMock.mockImplementation(async () => new Response("Not found", { status: 404 }));
    wrap(<Probe />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/renewals/bill-together", { method: "GET" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("probe").textContent).toBe("false");
  });
  it("GET 400 (no ids) → available", async () => {
    fetchMock.mockImplementation(async () => json(400, { error: "ids needed" }));
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("true"));
  });
});

describe("R-2808 single-row Bill next part on a sub already on a together proforma", () => {
  const PART = { preview: { cycle: "monthly", seats: 49, seatRate: 450, partTaxable: 22050, taxRate: 18, amounts: { taxable: 22050, tax: 3969, gross: 26019 },
    periods: [{ start: "2026-10-01", end: "2026-10-31", existing: null }], firstStart: "2026-10-01", unpaidEarlier: [] } };

  it("Create waits while the together check is out (no fail-open), then a sub on no together bill bills as before", async () => {
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/renewals/bill-together") return Promise.resolve(json(400, { error: "ids needed" }));
      if (url.startsWith("/api/renewals/bill-together?ids=")) return new Promise<Response>((r) => { answer = r; });
      return Promise.resolve(json(200, PART));
    });
    wrap(<BillNextPartDialog sub={{ id: "sta", customer_name: "ITBUZZ Technologies", plan: "Business Starter" }} open onOpenChange={() => {}} onConfirm={vi.fn()} busy={false} />);
    const create = await screen.findByRole("button", { name: "Create proforma" });
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/renewals/bill-together?ids=sta"))).toBe(true));
    expect((create as HTMLButtonElement).disabled).toBe(true);
    answer(json(200, { ...PREVIEW, subs: [{ ...PREVIEW.subs[1] }] }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create proforma" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("bill-next-on-together")).toBeNull();
  });

  it("says so, links the proforma and makes no second bill", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/renewals/bill-together") return json(400, { error: "ids needed" });
      if (url.startsWith("/api/renewals/bill-together?ids=")) {
        return json(200, { ...PREVIEW, subs: [{ ...PREVIEW.subs[1], line: null, reasons: [{ code: "already_together", text: "Already on PI-ET-0101" }],
          onTogetherBill: { quoteId: "PI-ET-2026-27-0101", status: "sent", withPlans: ["Business Standard"] } }] });
      }
      return json(200, { preview: { cycle: "monthly", seats: 49, seatRate: 450, partTaxable: 22050, taxRate: 18, amounts: { taxable: 22050, tax: 3969, gross: 26019 },
        periods: [{ start: "2026-10-01", end: "2026-10-31", existing: null }], firstStart: "2026-10-01", unpaidEarlier: [] } });
    });
    wrap(<BillNextPartDialog sub={{ id: "sta", customer_name: "ITBUZZ Technologies", plan: "Business Starter" }} open onOpenChange={() => {}} onConfirm={vi.fn()} busy={false} />);
    const note = await screen.findByTestId("bill-next-on-together");
    expect(note.textContent).toContain("Already billed together on PI-ET-2026-27-0101 with Business Standard (sent)");
    expect(screen.getByRole("link", { name: "Open it" }).getAttribute("href")).toBe("/quotes/PI-ET-2026-27-0101");
    expect((screen.getByRole("button", { name: "Create proforma" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
