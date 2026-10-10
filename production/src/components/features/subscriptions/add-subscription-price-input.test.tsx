// @vitest-environment jsdom
//
// The Unit Price / Seats boxes must let you DELETE what is in them.
//
// ─── WHY THIS TEST EXISTS ───────────────────────────────────────────────────
// Reported 9 Sep 2026 while onboarding a real subscription: the price box showed
// "0222" and the leading zero could not be removed. Both inputs stored a NUMBER and
// coerced on every keystroke:
//
//     onChange={(e) => setPricePerSeatYear(parseFloat(e.target.value) || 0)}
//
// Select-all-and-delete makes `e.target.value` an empty string. `parseFloat("")` is
// NaN, and `NaN || 0` is 0 — so the field instantly re-rendered as "0" with the caret
// in front of it, and the next keystrokes landed after the zero. The zero was
// literally undeletable: every attempt put it straight back.
//
// Seats had the identical bug with `|| 1`.
//
// The fix keeps the raw text in state and derives the numbers from it. The cases below
// are the ones a person actually performs on that box. (A half-typed decimal is NOT
// among them, and the note further down says why — that one is the DOM's doing, not
// this component's, and it is still true after the fix.)
//
// The second describe block covers the billing-period dropdown added the same day,
// which decides what a number in that box MEANS.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddSubscriptionDialog } from "./add-subscription-dialog";

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { id: "u1", tenant_id: "t1", role: "owner" } }),
}));
/* Swapped per-describe: [] for the price-box cases (nothing overwrites what is typed),
   and a real catalogue row for the billing-period cases. */
const catalogRows: unknown[] = [];
vi.mock("@/lib/queries/items", () => ({
  useItems: () => ({ data: catalogRows, isLoading: false }),
}));
/* The dialog fetches TWO lists on open:
     supabase.from("customers").select(...).order(...)          →  { data }
     supabase.from("contacts").select(...).order(...).limit(...) →  { data }
   `order` therefore has to be both awaitable and chainable. It used to be only
   awaitable, so the contacts fetch threw "limit is not a function" — sixteen unhandled
   rejections that passed the suite while hiding a real call. A mock that is missing a
   method has burned this dialog before (17 Sep 2026): the throw lands in a catch and
   the tests report the wrong reason. */
vi.mock("@/lib/supabase/client", () => {
  const empty = { data: [], error: null };
  const order = () => Object.assign(Promise.resolve(empty), { limit: async () => empty });
  return {
    createClient: () => ({
      from: () => ({ select: () => ({ order }) }),
    }),
  };
});

afterEach(cleanup);

/** The label text of the Unit Price field, which carries the live UNIT. */
function priceLabel(): string {
  const l = document.querySelector('label[for="pricePerSeat"]');
  return l?.textContent ?? "";
}

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddSubscriptionDialog open onOpenChange={() => {}} onSuccess={() => {}} />
    </QueryClientProvider>,
  );
  /* The dialog renders through a portal, so these live on document.body, not in the
     container render() hands back. */
  const price = document.querySelector<HTMLInputElement>("#pricePerSeat");
  const seats = document.querySelector<HTMLInputElement>("#seats");
  if (!price || !seats) throw new Error("price/seats inputs not rendered");
  return { price, seats };
}

describe("Add Subscription — the number boxes can be emptied", () => {
  it("clearing the price leaves it EMPTY, not '0'", () => {
    const { price } = renderDialog();
    fireEvent.change(price, { target: { value: "" } });
    // Before the fix this was "0" — the bug, in one assertion.
    expect(price.value).toBe("");
  });

  it("typing after clearing gives 222, not 0222", () => {
    const { price } = renderDialog();
    fireEvent.change(price, { target: { value: "" } });
    fireEvent.change(price, { target: { value: "222" } });
    expect(price.value).toBe("222");
    expect(price.value.startsWith("0")).toBe(false);
  });

  it("accepts a whole decimal price", () => {
    const { price } = renderDialog();
    fireEvent.change(price, { target: { value: "136.50" } });
    expect(price.value).toBe("136.50");
  });

  /* NOT asserted here, and deliberately: a half-typed "136." comes back as "" from a
     `type="number"` input, because the DOM sanitises its own value and "136." is not a
     valid number literal. That is browser behaviour, not this component's, and fixing
     it would mean `type="text"` + `inputMode="decimal"` — losing min= validation and
     the spinner. Prices here are whole rupees, so it is not worth that trade. Recorded
     so the next person doesn't chase it as a bug in the fix above. */

  it("clearing seats leaves it empty rather than snapping back to 1", () => {
    const { seats } = renderDialog();
    expect(seats.value).toBe("10");
    fireEvent.change(seats, { target: { value: "" } });
    expect(seats.value).toBe("");
    fireEvent.change(seats, { target: { value: "24" } });
    expect(seats.value).toBe("24");
  });
});

/**
 * The billing-period dropdown, rendered for real.
 *
 * This dialog cannot be browser-verified from here: it sits behind a login, and the
 * seeded local database has no catalogue prices. So this is the substitute, and it is
 * a real one — the same component, actually mounted, with a catalogue row shaped like
 * the tenant's own. The ARITHMETIC of each choice is pinned separately and more
 * thoroughly in lib/subscriptions/billing-choice.test.ts; what is checked here is what
 * the operator's eye actually lands on: the unit printed next to the number they type.
 */
describe("Add Subscription — the billing period drives the price field's unit", () => {
  beforeEach(() => {
    /* ₹864/seat/month committed (₹10,368/yr), ₹1,000/seat/month flex. */
    catalogRows.length = 0;
    catalogRows.push({
      id: "GW-STD", name: "Google Workspace Standard", vendor: "google",
      msrp: 864, wholesale: 620,
      prices: { annual: { msrp: 864, wholesale: 620 }, monthly: { msrp: 1_000, wholesale: 700 } },
      item_type: "subscription", is_active: true,
    });
  });
  afterEach(() => { catalogRows.length = 0; });

  it("defaults to yearly, so it behaves as it did before the dropdown existed", () => {
    const { price } = renderDialog();
    expect(priceLabel()).toContain("₹/yr");
    /* Seeded from the catalogue in the YEARLY unit: 864 × 12. */
    expect(price.value).toBe("10368");
  });

  it("offers the billing period as a labelled control", () => {
    renderDialog();
    const trigger = document.querySelector("#billingChoice");
    expect(trigger).not.toBeNull();
    /* The default choice is the one named on the trigger. */
    expect(trigger?.textContent ?? "").toContain("Yearly");
  });

  it("never labels the field ₹/yr and ₹/mo at the same time", () => {
    renderDialog();
    const label = priceLabel();
    expect(label.includes("₹/yr") && label.includes("₹/mo")).toBe(false);
  });
});

/**
 * Dates follow the term, and the term follows the billing period.
 *
 * ─── TWO SEPARATE REPORTS, 9 SEP 2026 ──────────────────────────────────────
 * 1. "Date still pointing to yearly as I selected monthly." Half a bug: FLEX has no
 *    commitment and must expire in a month, and it said a year. An annual commitment
 *    billed monthly genuinely does expire in twelve months — that date marks the
 *    commitment ending, not the next invoice — so it must NOT move. Both are pinned
 *    below, because "fixing" the second would be the real defect.
 * 2. Back-dating the start left expiry a year from TODAY. The fields were independent,
 *    so onboarding an April subscription in September quietly sold ~14 months of term
 *    and nothing on screen contradicted itself.
 */
/* ── EVERY DATE BELOW MOVED ONE DAY EARLIER ON 11 SEP 2026 ───────────────────
   Abhishek: the column is an EXPIRY date, so a term starting 1 Apr 2026 ends
   31 Mar 2027, not 1 Apr 2027 — which is also what the Google Admin console shows.
   The TERM LENGTHS asserted here are unchanged; only which day is named as the last
   one. See termEndInclusive in lib/billing/schedule.ts. */
describe("Add Subscription — start and expiry dates", () => {
  const dates = () => {
    const start = document.querySelector<HTMLInputElement>("#startDate");
    const renew = document.querySelector<HTMLInputElement>("#renewalDate");
    if (!start || !renew) throw new Error("date inputs not rendered");
    return { start, renew };
  };

  it("back-dating the start drags expiry with it, keeping a 12-month term", () => {
    renderDialog();
    const { start, renew } = dates();
    fireEvent.change(start, { target: { value: "2026-04-01" } });
    expect(start.value).toBe("2026-04-01");
    /* Not "a year from today" — a year from the date actually entered, and the LAST
       day of it. 1 Apr 2026 → 31 Mar 2027 is twelve months of service. */
    expect(renew.value).toBe("2027-03-31");
  });

  it("clamps to the end of a short month instead of rolling into the next", () => {
    renderDialog();
    const { start, renew } = dates();
    /* 31 Jan + 12 is unambiguous; the clamping matters on the flex path below, and
       termEndInclusive is the shared helper both use. */
    fireEvent.change(start, { target: { value: "2026-01-31" } });
    expect(renew.value).toBe("2027-01-30");
  });

  it("expiry is still editable after being derived", () => {
    renderDialog();
    const { start, renew } = dates();
    fireEvent.change(start, { target: { value: "2026-04-01" } });
    fireEvent.change(renew, { target: { value: "2027-06-30" } });
    expect(renew.value).toBe("2027-06-30");
  });

  it("says which date it is, so a year on a monthly choice is not read as a bug", () => {
    renderDialog();
    /* Default is yearly; the hint names the term rather than leaving it unexplained. */
    expect(document.body.textContent).toContain("12-month term");
  });
});

/**
 * The billing period actually driving the term — the reported bug, end to end.
 *
 * ─── HOW THIS DRIVES A RADIX SELECT IN JSDOM ────────────────────────────────
 * Not through the visible trigger: Radix opens its listbox on pointer events jsdom
 * cannot fully deliver (`hasPointerCapture` is missing, and the options never mount).
 * Radix also renders a HIDDEN NATIVE <select> for form compatibility, and that one is
 * a plain DOM control — firing `change` on it goes through the same onValueChange the
 * user's click would. Measured 9 Sep 2026: it works, and the visible label and dates
 * update exactly as they do in a browser.
 */
describe("Add Subscription — the billing period drives the term", () => {
  /** Pick a billing choice via Radix's hidden native select. */
  const pick = (value: string) => {
    const sel = Array.from(document.querySelectorAll("select"))
      .find((s) => Array.from(s.options).some((o) => o.value === value));
    if (!sel) throw new Error(`no select offering ${value}`);
    fireEvent.change(sel, { target: { value } });
  };
  const renewal = () => document.querySelector<HTMLInputElement>("#renewalDate")!.value;
  const start   = () => document.querySelector<HTMLInputElement>("#startDate")!;

  it("FLEX expires in ONE MONTH — the 'date still pointing to yearly' report", () => {
    renderDialog();
    fireEvent.change(start(), { target: { value: "2026-09-09" } });
    expect(renewal()).toBe("2027-09-08");   // yearly default — the last covered day
    pick("monthly_flex");
    expect(renewal()).toBe("2026-10-08");   // one month, not one year
    expect(priceLabel()).toContain("₹/mo");
  });

  it("an annual commitment billed monthly still expires in TWELVE months", () => {
    renderDialog();
    fireEvent.change(start(), { target: { value: "2026-09-09" } });
    pick("annual_monthly");
    /* Still a YEAR out. This date marks the commitment ending, not the next invoice —
       shortening it to a month would be the actual defect. */
    expect(renewal()).toBe("2027-09-08");
    expect(priceLabel()).toContain("₹/mo");
  });

  it("R-826: quarterly (annual commitment) is offered, priced ₹/mo, and still expires in TWELVE months", () => {
    renderDialog();
    fireEvent.change(start(), { target: { value: "2026-09-09" } });
    pick("annual_quarterly");
    expect(renewal()).toBe("2027-09-08");
    expect(priceLabel()).toContain("₹/mo");
    expect(document.body.textContent).toContain("Invoices go out every 3 months.");
  });

  it("switching back to yearly restores the year and the ₹/yr unit", () => {
    renderDialog();
    fireEvent.change(start(), { target: { value: "2026-09-09" } });
    pick("monthly_flex");
    expect(renewal()).toBe("2026-10-08");
    pick("annual_yearly");
    expect(renewal()).toBe("2027-09-08");
    expect(priceLabel()).toContain("₹/yr");
  });

  it("back-dating under FLEX gives one month from THAT date, not from today", () => {
    renderDialog();
    pick("monthly_flex");
    fireEvent.change(start(), { target: { value: "2026-04-01" } });
    expect(renewal()).toBe("2026-04-30");
  });

  it("flex from 31 Jan ends 27 Feb — clamped, not rolled into March", () => {
    renderDialog();
    pick("monthly_flex");
    fireEvent.change(start(), { target: { value: "2026-01-31" } });
    /* 2026 is not a leap year. Naive Date math would give 3 March and walk the
       anniversary later every month. Clamped it is 28 Feb, and the last covered day is
       the 27th — a 28-day month starting on its last day. */
    expect(renewal()).toBe("2026-02-27");
  });
});
