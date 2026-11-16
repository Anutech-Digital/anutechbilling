// @vitest-environment jsdom
/**
 * R-2855 — Renewals header + tiles: every money number says what it is, an "X of Y" names a Y that is on
 * screen, and no tile shows a number before the final data (staging 7c60b67, owner's human test 16 Nov 2026).
 *
 * Seen: header "₹83,375 still owed on these renewals"; Overdue ₹4.5L; Due in 30 days ₹5.4L; Renewed this
 * month "0% of ₹3.4L due in Nov" with the helper "₹3.4L still due (Overdue + Due tiles)" — but 4.5L + 5.4L
 * is not 3.4L. While loading, Due in 30 days showed "₹2.9L · 6 renewals (+5 renewed)", then ₹5.4L · 11.
 *
 * Extends R-2741 (tile = its rows), R-2751 (one basis, before GST) — nothing of theirs changes here.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, within } from "@testing-library/react";
import {
  monthOf, renewalTiles, reconcileWindows, tileText, TILE_KEYS, TILE_LABEL, TILE_CAPTION,
  type RenewalQuotePayment, type TileRow,
} from "./tiles";
import { RenewalTileRow } from "./tiles-card";
import { subscriptionDuesLine, toChaseSummary } from "@/lib/accounting/receivables-due";
import { NAV_BADGE_VIEWS } from "@/lib/hooks/nav-badge-views";
import { ForecastPanel } from "./forecast-panel";
import { renewalForecast } from "@/lib/renewals/forecast";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

afterEach(cleanup);

const NOV = monthOf("2026-11-16");
const r = (id: string, tab: TileRow["tab"], amount: number, renewalDate: string, over: Partial<TileRow> = {}): TileRow => ({
  id, tab, amount, renewalDate, statusKey: tab === "overdue" ? "overdue" : "due", ...over,
});
/* the staging picture in round numbers: Overdue ₹4.5L, Due in 30 days ₹5.4L, November's unpaid ₹3.4L */
const rows: TileRow[] = [
  r("oct-late", "overdue", 250_000, "2026-10-20"),
  r("nov-late", "overdue", 200_000, "2026-11-05"),
  r("nov-soon", "due7", 140_000, "2026-11-22"),
  r("dec", "d30", 400_000, "2026-12-10"),
  r("jan", "d60", 90_000, "2027-01-05"),
  r("wont", "d30", 30_000, "2026-12-01", { statusKey: "non-renewing" }),
];
const paidQuote = (id: string, sub: string, amount: number): RenewalQuotePayment => ({
  id, amount, payment_amount: amount, payment_status: "received", status: "accepted",
  renewal_subscription_id: sub, renewal_term_date: "2026-11-03", subtotal: amount, discount_pct: 0, tax_rate: 0,
});

describe("R-2855 Renewed this month: what the % divides by, and where the unpaid part sits", () => {
  const t = renewalTiles(rows, [], NOV);
  const text = tileText("renewedMonth", t, NOV, {});

  it("the staging picture: Overdue ₹4.5L, Due in 30 ₹5.4L, November's renewals ₹3.4L", () => {
    expect(t.overdue.amount).toBe(450_000);
    expect(t.due30.amount).toBe(540_000);
    expect(t.renewedMonth.dueAmount).toBe(340_000);
  });

  it("November's unpaid renewals split into the Overdue part and the not-yet-due part — the two add up", () => {
    expect(t.renewedMonth.stillDueOverdue).toEqual({ count: 1, amount: 200_000 });
    expect(t.renewedMonth.stillDueLater).toEqual({ count: 1, amount: 140_000 });
    expect(t.renewedMonth.stillDueOverdue.amount + t.renewedMonth.stillDueLater.amount).toBe(t.renewedMonth.stillDue.amount);
    expect(t.renewedMonth.stillDueOverdue.count + t.renewedMonth.stillDueLater.count).toBe(t.renewedMonth.stillDue.count);
  });

  it("paid + not paid yet = the month's ₹X the % divides by", () => {
    const tt = renewalTiles(rows, [paidQuote("Q1", "gone", 60_000)], NOV).renewedMonth;
    expect(tt.amount + tt.stillDue.amount).toBe(tt.dueAmount);
    expect(tt.dueAmount).toBe(400_000);
    expect(tt.pct).toBe(15);
  });

  it("on the tile: the paid ₹ with its count, and under it the % WITH the ₹ it divides by", () => {
    expect(text.value).toBe("₹0");
    expect(text.sub).toBe("0 renewals");
    expect(text.caption).toBe("0% of Nov's ₹3.4L");
  });

  it("never claims the unpaid part equals the Overdue + Due tiles (4.5L + 5.4L is not 3.4L)", () => {
    expect(text.title).not.toContain("(Overdue + Due tiles)");
    /* the tooltip says how ₹X is made, and which part of the unpaid rest is in which tile, in full rupees */
    expect(text.title).toContain("renewals dated in Nov, paid + not paid, before GST (₹3,40,000)");
    expect(text.title).toContain("Not paid yet: ₹3,40,000 (2 renewals)");
    expect(text.title).toContain("₹2,00,000 of it is in Overdue");
    expect(text.title).toContain("₹1,40,000 is not due yet (in Due in 30 days)");
  });

  it("the tooltip keeps '% of ₹X due in <month>' (the R-2751 Forecast card test reads it)", () => {
    expect(text.title).toMatch(/% of ₹[^ ]+ due in \w{3}/);
  });

  it("nothing dated this month / everything paid: plain words", () => {
    const none = renewalTiles([r("dec", "d30", 100, "2026-12-10")], [], NOV);
    expect(tileText("renewedMonth", none, NOV, {})).toMatchObject({ value: "₹0", sub: "0 renewals", caption: "Nothing due in Nov" });
    const all = renewalTiles([], [paidQuote("Q1", "x", 50_000)], NOV);
    const allText = tileText("renewedMonth", all, NOV, {});
    expect(allText).toMatchObject({ value: "₹50.0K", sub: "1 renewal", caption: "100% of Nov's ₹50.0K" });
    expect(allText.title).toContain("All of Nov's renewals are paid");
  });

  it("an unpaid renewal worth ₹0 (free plan) never reads '₹0 of it not paid' — the words follow the amounts", () => {
    const free = renewalTiles([r("free", "due7", 0, "2026-11-25")], [], NOV);
    const freeText = tileText("renewedMonth", free, NOV, {});
    expect(freeText.caption).toBe("Nothing due in Nov");
    expect(freeText.title).not.toContain("₹0 of it");
    expect(freeText.title).not.toContain("Not paid yet");
    const paidPlusFree = renewalTiles([r("free", "due7", 0, "2026-11-25")], [paidQuote("Q1", "x", 50_000)], NOV);
    expect(tileText("renewedMonth", paidPlusFree, NOV, {}).title).toContain("All of Nov's renewals are paid");
  });
});

describe("R-2855 every tile's money has a label saying what it is", () => {
  const t = renewalTiles(rows, [], NOV);
  const windows = reconcileWindows(rows, NOV);

  it("each tile has a caption in plain words; the work tiles are renewal VALUE, not unpaid bills", () => {
    expect(TILE_CAPTION.overdue).toBe("Renewal value overdue");
    expect(TILE_CAPTION.due30).toBe("Renewal value due");
    expect(TILE_CAPTION.wontRenew).toBe("Renewal value leaving");
    for (const k of TILE_KEYS) expect(tileText(k, t, NOV, windows).caption.length).toBeGreaterThan(0);
    expect(tileText("overdue", t, NOV, windows).title).toContain("before GST (each renewal's next-term bill; not unpaid bills)");
  });

  it("R-2741 kept: the count line still names the closed rows the tab lists beyond the tile", () => {
    expect(tileText("due30", t, NOV, windows).sub).toBe("2 renewals (+1 won't renew)");
  });

  it("the header line names its own, different number: bills and instalments due, unpaid", () => {
    expect(subscriptionDuesLine(toChaseSummary([]), 482_128, false, 83_375)).toBe("Bills and instalments due: ₹83,375 unpaid on these renewals");
    expect(subscriptionDuesLine(toChaseSummary([]), 482_128, false, 0)).toBe("No bill or instalment unpaid on these renewals");
  });

  it("the sidebar badge's hover uses the page's own words (Overdue, not 'lapsed')", () => {
    expect(NAV_BADGE_VIEWS.renewals.meaning(11)).toBe("11 renewals overdue or due within 7 days");
    expect(NAV_BADGE_VIEWS.renewals.meaning(1)).toBe("1 renewal overdue or due within 7 days");
  });
});

describe("R-2855 the tile row on screen", () => {
  const t = renewalTiles(rows, [], NOV);
  const windows = reconcileWindows(rows, NOV);
  const group = () => screen.getByRole("group", { name: /Renewal totals/ });

  it("while the data is still being read: six placeholders, no amount, no count, nothing pressable", () => {
    render(<RenewalTileRow tiles={t} month={NOV} active={null} onPick={() => { throw new Error("pressed while loading"); }} windows={windows} loading />);
    expect(group().getAttribute("aria-busy")).toBe("true");
    const buttons = within(group()).getAllByRole("button");
    expect(buttons).toHaveLength(6);
    for (const b of buttons) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.getAttribute("title")).toBeNull();
    }
    expect(group().textContent).not.toMatch(/₹|\d+ renewals?|%/);
    for (const k of TILE_KEYS) expect(group().textContent).toContain(TILE_LABEL[k]);
    expect(within(group()).getAllByTestId("renewal-tile-loading")).toHaveLength(6);
  });

  it("loaded: amount, count and a VISIBLE caption under each (not only a tooltip)", () => {
    render(<RenewalTileRow tiles={t} month={NOV} active={null} onPick={() => {}} windows={windows} />);
    expect(group().hasAttribute("aria-busy")).toBe(false);
    expect(within(group()).queryByTestId("renewal-tile-loading")).toBeNull();
    for (const k of TILE_KEYS) {
      const cap = within(group()).getByTestId(`renewal-tile-caption-${k}`);
      expect(cap.textContent).toBe(tileText(k, t, NOV, windows).caption);
      expect(cap.className).not.toContain("sr-only");
      expect(cap.className).not.toContain("truncate");   // the caption is never cut with "…"
    }
    const overdue = within(group()).getByRole("button", { name: /^Overdue/ });
    expect(overdue.textContent).toContain("₹4.5L");
    expect(overdue.textContent).toContain("2 renewals");
    expect(overdue.textContent).toContain("Renewal value overdue");
    expect(within(group()).getByRole("button", { name: /^Renewed this month/ }).textContent).toContain("0% of Nov's ₹3.4L");
  });

  it("a LATER re-read (a quote was sent, the page reads again): the last numbers stay and stay pressable — never back to blanks", () => {
    const picked: string[] = [];
    const { rerender } = render(<RenewalTileRow tiles={t} month={NOV} active="overdue" onPick={(k) => picked.push(k)} windows={windows} />);
    /* the half-read picture: a part-billed row reads Renewed until its documents are in */
    const halfRead = renewalTiles(rows.map((x) => (x.id === "dec" ? { ...x, statusKey: "renewed" as const } : x)), [], NOV);
    rerender(<RenewalTileRow tiles={halfRead} month={NOV} active="overdue" onPick={(k) => picked.push(k)} windows={windows} loading />);
    const due30 = within(group()).getByRole("button", { name: /^Due in 30 days/ });
    expect(due30.textContent).toContain("₹5.4L");            // not the half-read ₹1.4L
    expect(group().getAttribute("aria-busy")).toBe("true");
    const overdue = within(group()).getByRole("button", { name: /^Overdue/ }) as HTMLButtonElement;
    expect(overdue.disabled).toBe(false);
    expect(overdue.getAttribute("aria-pressed")).toBe("true");
    overdue.click();
    expect(picked).toEqual(["overdue"]);
    /* the re-read is in: the new final numbers show */
    const after = renewalTiles([...rows, r("new", "d30", 60_000, "2026-12-12")], [], NOV);
    rerender(<RenewalTileRow tiles={after} month={NOV} active="overdue" onPick={() => {}} windows={windows} />);
    expect(within(group()).getByRole("button", { name: /^Due in 30 days/ }).textContent).toContain("₹6.0L");
  });

  it("a read that FAILED: the tiles say so — never a half-read number shown as final", () => {
    render(<RenewalTileRow tiles={t} month={NOV} active={null} onPick={() => { throw new Error("pressed"); }} windows={windows} failed />);
    expect(within(group()).getAllByTestId("renewal-tile-unread")).toHaveLength(6);
    expect(group().textContent).not.toMatch(/₹/);
    expect(group().textContent).toContain("Couldn't load");
    expect(group().hasAttribute("aria-busy")).toBe(false);
    expect(screen.getByTestId("renewal-tiles-unread-note").textContent).toMatch(/couldn.t be read — reload the page/);
  });

  it("with a search / filter on, the line under the tiles says they count all renewals (R-2741 kept)", () => {
    render(<RenewalTileRow tiles={t} month={NOV} active={null} onPick={() => {}} windows={windows} narrowed />);
    expect(screen.getByTestId("renewal-tiles-all-note").textContent).toContain("These totals are for all renewals");
  });
});

describe("R-2855 the Forecast panel waits for the same reads (its total and this month's bar come from the Renewed tile)", () => {
  const forecast = renewalForecast([
    { status: "active", mrr: 750, term_months: 12, term_amount: 9_000, renewal_date: "2026-11-20" },
    { status: "active", mrr: 1000, term_months: 12, term_amount: 12_000, renewal_date: "2027-01-10" },
  ] as never, "2026-11-16");
  const props = { forecast, atRiskCount: 0, atRiskArr: 0, topName: null, topCustomerId: null, topReasons: [] };

  it("while loading: no total, no figure for this month; later months (from the dates alone) show", () => {
    const { container } = render(<ForecastPanel {...props} loading />);
    expect(container.textContent).toContain("Renewals …");
    expect(container.textContent).not.toContain("₹21.0K");
    expect(screen.getByTestId("forecast-month-loading").textContent).toBe("Nov…");
    expect(container.textContent).toContain("₹12.0K");
  });

  it("loaded: the total and this month's figure show", () => {
    const { container } = render(<ForecastPanel {...props} />);
    expect(container.textContent).toContain("Renewals ₹21.0K + GST (2 renewals)");
    expect(screen.queryByTestId("forecast-month-loading")).toBeNull();
    expect(container.textContent).toContain("₹9.0K");
  });
});
