// @vitest-environment jsdom
/* R-2839 (Renewals history audit H4): the row drawer opened only from the product name — users did not
   find it. Every row (table: in the Last bill cell, replacing "+N earlier"; cards: next to the last-docs
   lines) gets a small text button "History" that opens the SAME drawer with ?sub=<id>&view=history, and
   the drawer then scrolls to its History section and puts focus on the active History tab. The product
   name still opens the drawer as before (no view). */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { render, cleanup, screen, fireEvent, act, waitFor } from "@testing-library/react";

const drawerQuery = vi.fn(() => ({ data: { docs: undefined, paid: undefined, reminders: null }, isLoading: false, isError: false, isSuccess: true }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<typeof import("@/lib/dates/ist")>()), istToday: () => "2026-11-15" }));
vi.mock("./drawer-data", () => ({ useRenewalDrawerData: () => drawerQuery() }));
vi.mock("./drawer-cost-data", () => ({ useRenewalDrawerCatalog: () => ({ data: [], isError: false }) }));
vi.mock("./drawer-seat-cut-data", () => ({ useRenewalDrawerSeatCuts: () => ({ data: [], isError: false }) }));
vi.mock("@/components/features/renewals/renewal-actions", () => ({ RenewalActions: () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { DRAWER_VIEW_PARAM, drawerViewFromSearch, withDrawerSub } from "./drawer";
import { HistoryButton, LastInvoiceCell } from "./row-cells";
import { RenewalDrawer, useRenewalDrawerSub, type DrawerItem } from "./renewal-drawer";
import { renewalAmount } from "./queue";
import type { LastDocs, LastInvoice } from "./last-docs";

/* jsdom has no scrollIntoView — the drawer tests stub it; put back whatever was there after each test */
const realScroll = Element.prototype.scrollIntoView;
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/renewals"); Element.prototype.scrollIntoView = realScroll; });

const SUB_ID = "a1b2c3d4-0000-4000-8000-000000002839";

describe("R-2839 — ?view=history next to ?sub= (drawer.ts)", () => {
  it("sets view only with an id, clears it with the id, and drops a stale view when opened without one", () => {
    expect(DRAWER_VIEW_PARAM).toBe("view");
    expect(withDrawerSub("/renewals?tab=overdue", SUB_ID, "history")).toBe(`/renewals?tab=overdue&sub=${SUB_ID}&view=history`);
    expect(withDrawerSub(`/renewals?tab=overdue&sub=${SUB_ID}&view=history`, null)).toBe("/renewals?tab=overdue");
    expect(withDrawerSub(`/renewals?sub=x1234567&view=history`, SUB_ID)).toBe(`/renewals?sub=${SUB_ID}`);
    /* R-2740's own calls are unchanged */
    expect(withDrawerSub("/renewals?tab=overdue", SUB_ID)).toBe(`/renewals?tab=overdue&sub=${SUB_ID}`);
  });
  it("reads only a known view, and only together with a drawer id", () => {
    expect(drawerViewFromSearch(`?sub=${SUB_ID}&view=history`)).toBe("history");
    expect(drawerViewFromSearch(`?sub=${SUB_ID}&view=<script>`)).toBeNull();
    expect(drawerViewFromSearch("?view=history")).toBeNull();
    expect(drawerViewFromSearch(`?sub=${SUB_ID}`)).toBeNull();
  });
});

describe("R-2839 — the History button", () => {
  it("is a real button named History (visible text first), click and keyboard Enter open it", () => {
    const onOpen = vi.fn();
    render(<HistoryButton onOpen={onOpen} name="Greentin Behind 2095 · Google Workspace" />);
    const b = screen.getByRole("button", { name: /^History/ });
    expect(b.textContent).toBe("History");
    expect(b.getAttribute("type")).toBe("button");
    expect(b.getAttribute("aria-label")).toBe("History — Greentin Behind 2095 · Google Workspace");
    fireEvent.click(b);
    expect(onOpen).toHaveBeenCalledTimes(1);
    /* a native <button>: Enter / Space press it (the browser turns them into click — the card spec presses Enter for real) */
    expect(b.tagName).toBe("BUTTON");
    expect(b).not.toHaveProperty("disabled", true);
  });

  const inv = (over: Partial<LastInvoice> = {}): LastInvoice => ({
    id: "INV-2", date: "2026-10-01", status: "sent", amount: 40000, paidAmount: 0, currency: "INR",
    dueDate: "2026-10-15", netPayable: null, adjustedAdvances: null, writtenOffAt: null, fxRate: null,
    sourceQuoteId: "Q-1", part: null, period: "Oct 2026", notes: undefined, ...over,
  } as LastInvoice);
  it("table Last bill: '+N earlier' is gone from line 2 (History replaces it); the earlier invoice stays in the tooltip", () => {
    const docs: LastDocs = { quote: null, invoice: inv(), invoices: [inv(), inv({ id: "INV-1", date: "2026-04-01", period: "Apr 2026" })], sent: null };
    render(<LastInvoiceCell docs={docs} loading={false} failed={false} canInvoices canQuotes todayIst="2026-11-15" />);
    const cell = screen.getByTestId("renewal-last-invoice-cell");
    expect(cell.textContent).not.toMatch(/earlier/);
    expect(cell.getAttribute("title")).toContain("Earlier invoice INV-1");
  });
});

describe("R-2839 — useRenewalDrawerSub keeps the view in the URL", () => {
  function Probe() {
    const [id, open, close, view] = useRenewalDrawerSub();
    return (
      <div>
        <p data-testid="state">{`${id ?? "-"}|${view ?? "-"}`}</p>
        <button onClick={() => open(SUB_ID, "history")}>open-history</button>
        <button onClick={() => open(SUB_ID)}>open-plain</button>
        <button onClick={close}>close</button>
      </div>
    );
  }
  it("open(id, 'history') pushes ?sub=&view=history; the product-name open has no view; close drops both", () => {
    render(<Probe />);
    fireEvent.click(screen.getByText("open-history"));
    expect(screen.getByTestId("state").textContent).toBe(`${SUB_ID}|history`);
    expect(window.location.search).toBe(`?sub=${SUB_ID}&view=history`);
    fireEvent.click(screen.getByText("open-plain"));
    expect(screen.getByTestId("state").textContent).toBe(`${SUB_ID}|-`);
    expect(window.location.search).toBe(`?sub=${SUB_ID}`);
  });
  it("a shared ?sub=&view=history link opens on History", () => {
    window.history.replaceState(null, "", `/renewals?sub=${SUB_ID}&view=history`);
    render(<Probe />);
    expect(screen.getByTestId("state").textContent).toBe(`${SUB_ID}|history`);
    act(() => { fireEvent.click(screen.getByText("close")); });
    expect(window.location.search).toBe("");
  });
});

describe("R-2839 — the drawer opened with view=history focuses its History", () => {
  const SUB = {
    id: SUB_ID, tenant_id: "t-1", customer_id: "c-1", customer_name: "CT R2839 Traders", plan: "Google Workspace Business Standard",
    seats: 5, vendor: "google", item_id: null, term_months: 12, mrr: 1000, term_amount: null, renewal_date: "2026-12-01",
    start_date: "2025-12-01", status: "active", renewal_quote_id: null, quote_id: "Q-1", reminder_count: 0,
  };
  const item: DrawerItem = {
    sub: SUB as never, daysUntil: 17, stage: null, amount: renewalAmount(SUB as never, null), frequency: "Yearly", payHref: null, docs: undefined,
    followup: { ownerId: null, nextFollowUpOn: null, promisedOn: null, promisedAmount: null, promiseStatus: null, confirmed: false } as never,
  };
  it("focus lands on the active History tab and the section is scrolled into view", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<RenewalDrawer item={item} open view="history" onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("tab"));
    expect(document.activeElement?.textContent).toMatch(/^All/);
    expect(screen.getByTestId("renewal-drawer-history").contains(document.activeElement)).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(screen.getByTestId("renewal-drawer-history-target"));
  });
  it("opened from the product name (no view) it does not scroll to History (the sheet's own focus, as before)", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<RenewalDrawer item={item} open onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe("R-2839 wiring (page.tsx)", () => {
  const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
  it("both layouts show History on every row, opening the drawer with view=history; the product name still opens it plain", () => {
    expect(page.match(/<HistoryButton /g)).toHaveLength(2);
    expect(page.match(/onOpen\(sub\.id, "history"\)/g)).toHaveLength(1); /* table; the card opens Payments when it has a payment (R-2842) */
    expect(page).toMatch(/onOpen=\{\(\) => onOpen\(sub\.id\)\}/);
    expect(page).toMatch(/const \[drawerSub, openDrawer, closeDrawer, drawerView\] = useRenewalDrawerSub\(\);/);
    expect(page).toMatch(/view=\{drawerView\}/);
  });
});
