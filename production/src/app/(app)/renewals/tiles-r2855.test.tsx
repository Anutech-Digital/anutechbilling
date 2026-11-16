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
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen, within } from "@testing-library/react";
import {
  monthOf, renewalTiles, reconcileWindows, tileText, TILE_KEYS, TILE_LABEL, TILE_CAPTION, TILES_BASIS_NOTE,
  type RenewalQuotePayment, type TileRow,
} from "./tiles";
import { RenewalTileRow } from "./tiles-card";
import { subscriptionDuesLine, toChaseSummary } from "@/lib/accounting/receivables-due";
import { NAV_BADGE_VIEWS } from "@/lib/hooks/nav-badge-views";

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

  it("paid + not paid yet = the '₹X due in Nov' the % divides by", () => {
    const tt = renewalTiles(rows, [paidQuote("Q1", "gone", 60_000)], NOV).renewedMonth;
    expect(tt.amount + tt.stillDue.amount).toBe(tt.dueAmount);
    expect(tt.dueAmount).toBe(400_000);
    expect(tt.pct).toBe(15);
  });

  it("the tile says the % and its base, and under it the unpaid part of that same base", () => {
    expect(text.value).toBe("₹0");
    expect(text.sub).toBe("0% of ₹3.4L due in Nov");
    expect(text.caption).toBe("₹3.4L of Nov not paid yet");
  });

  it("never claims the unpaid part equals the Overdue + Due tiles (4.5L + 5.4L is not 3.4L)", () => {
    expect(text.title).not.toContain("(Overdue + Due tiles)");
    /* it says which part of each tile it is, in full rupees */
    expect(text.title).toContain("₹2,00,000 of it is in Overdue");
    expect(text.title).toContain("₹1,40,000 is not due yet");
    expect(text.title).toContain("renewals dated in Nov");
  });

  it("the tooltip keeps '% of ₹X due in <month>' (the Forecast card test reads it)", () => {
    expect(text.title).toMatch(/% of ₹[^ ]+ due in \w{3}/);
  });

  it("nothing dated this month / everything paid: plain words, no ₹0 riddle", () => {
    const none = renewalTiles([r("dec", "d30", 100, "2026-12-10")], [], NOV);
    expect(tileText("renewedMonth", none, NOV, {})).toMatchObject({ sub: "Nothing due in Nov", caption: "No renewal dated in Nov" });
    const all = renewalTiles([], [paidQuote("Q1", "x", 50_000)], NOV);
    expect(tileText("renewedMonth", all, NOV, {})).toMatchObject({ sub: "100% of ₹50.0K due in Nov", caption: "All of Nov's renewals paid" });
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
  });

  it("R-2741 kept: the count line still names the closed rows the tab lists beyond the tile", () => {
    expect(tileText("due30", t, NOV, windows).sub).toBe("2 renewals (+1 won't renew)");
  });

  it("one line under the tiles says the basis once: renewal value before GST, not unpaid bills", () => {
    expect(TILES_BASIS_NOTE).toMatch(/before GST/);
    expect(TILES_BASIS_NOTE).toMatch(/not unpaid bills/);
  });

  it("the header line names its own, different number: bills unpaid", () => {
    expect(subscriptionDuesLine(toChaseSummary([]), 482_128, false, 83_375)).toBe("Bills ₹83,375 unpaid on these renewals");
    expect(subscriptionDuesLine(toChaseSummary([]), 482_128, false, 0)).toBe("No bill unpaid on these renewals");
  });

  it("the sidebar badge's hover uses the page's own words (Overdue, not 'lapsed')", () => {
    expect(NAV_BADGE_VIEWS.renewals.meaning(11)).toBe("11 renewals overdue or due within 7 days");
    expect(NAV_BADGE_VIEWS.renewals.meaning(1)).toBe("1 renewal overdue or due within 7 days");
  });
});

describe("R-2855 the tile row on screen", () => {
  const t = renewalTiles(rows, [], NOV);
  const windows = reconcileWindows(rows, NOV);

  it("while the data is still being read: six placeholders, no amount, no count, nothing pressable", () => {
    render(<RenewalTileRow tiles={t} month={NOV} active={null} onPick={() => { throw new Error("pressed while loading"); }} windows={windows} loading />);
    const group = screen.getByRole("group", { name: /Renewal totals/ });
    expect(group.getAttribute("aria-busy")).toBe("true");
    const buttons = within(group).getAllByRole("button");
    expect(buttons).toHaveLength(6);
    for (const b of buttons) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.getAttribute("title")).toBeNull();
    }
    expect(group.textContent).not.toMatch(/₹|\d+ renewals?|%/);
    for (const k of TILE_KEYS) expect(group.textContent).toContain(TILE_LABEL[k]);
    expect(within(group).getAllByTestId("renewal-tile-loading")).toHaveLength(6);
  });

  it("loaded: amount, count and a VISIBLE caption under each (not only a tooltip)", () => {
    render(<RenewalTileRow tiles={t} month={NOV} active={null} onPick={() => {}} windows={windows} />);
    const group = screen.getByRole("group", { name: /Renewal totals/ });
    expect(group.hasAttribute("aria-busy")).toBe(false);
    expect(within(group).queryByTestId("renewal-tile-loading")).toBeNull();
    for (const k of TILE_KEYS) {
      const cap = within(group).getByTestId(`renewal-tile-caption-${k}`);
      expect(cap.textContent).toBe(tileText(k, t, NOV, windows).caption);
      expect(cap.className).not.toContain("sr-only");
    }
    const overdue = within(group).getByRole("button", { name: /^Overdue/ });
    expect(overdue.textContent).toContain("₹4.5L");
    expect(overdue.textContent).toContain("2 renewals");
    expect(overdue.textContent).toContain("Renewal value overdue");
    expect(screen.getByTestId("renewal-tiles-basis-note").textContent).toContain(TILES_BASIS_NOTE);
  });

  it("with a search / filter on, the same line also says the tiles count all renewals (R-2741 kept)", () => {
    render(<RenewalTileRow tiles={t} month={NOV} active={null} onPick={() => {}} windows={windows} narrowed />);
    expect(screen.getByTestId("renewal-tiles-all-note").textContent).toContain("These totals are for all renewals");
  });
});
