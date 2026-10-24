// @vitest-environment jsdom
//
// Correcting a start date must move the renewal date with it, KEEPING THE TERM.
//
// ─── WHY THIS TEST EXISTS ───────────────────────────────────────────────────
// Reported 9 Sep 2026. The two date fields were independent, so fixing a mis-typed
// start date left the renewal where it was — and the subscription silently gained or
// lost however many days the correction moved. Nothing flags it: the renewal cron bills
// from the renewal date, so a term quietly stretched by a week just bills a week late,
// for ever.
//
// The subtle half is the TERM LENGTH. A flex subscription's term is ONE month. Assuming
// twelve would turn a corrected monthly plan into an annual commitment inside the one
// dialog that promises "corrects the record only — it doesn't re-bill". So the term is
// read off the record's own start→renewal gap, and that is what the last case pins.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";
import type { Subscription } from "@/lib/supabase/database.types";

vi.mock("@/lib/queries/subscriptions", () => ({
  useUpdateSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
  /* R-1684: seats / plan / price (not exercised by date edits). */
  useCorrectSubscriptionTerms: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useScheduleInvoices: () => ({ data: undefined }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
/* R-1681: the dialog pauses through suspend_subscription; not exercised by date edits. */
vi.mock("./suspend-subscription-dialog", () => ({
  MIN_SUSPEND_REASON: 3,
  useSuspendSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

afterEach(cleanup);

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: "sub-1", tenant_id: "t1", customer_id: "c1", customer_name: "Arjun Uppal",
  plan: "Google Workspace Starter (2 seats)", vendor: "google",
  seats: 2, used: 0, mrr: 528, status: "active",
  start_date: "2026-09-03", renewal_date: "2027-09-02",
  term_months: 12, billing_cycle: "yearly",
  ...over,
} as unknown as Subscription);

function open(s: Subscription) {
  render(<EditSubscriptionDialog sub={s} open onOpenChange={() => {}} />);
  const start = document.querySelector<HTMLInputElement>("#sub_start")!;
  const renew = document.querySelector<HTMLInputElement>("#sub_renewal")!;
  return { start, renew };
}

/* ── THE RENEWAL DATE IS THE LAST COVERED DAY SINCE 11 SEP 2026 ──────────────
   Abhishek's change: a 12-month term starting 3 Sep 2026 ends 2 Sep 2027, not the 3rd.
   Both the fixtures and the expectations below moved one day earlier together, so what
   these cases still assert is the TERM LENGTH — which is what the dialog exists to
   preserve. */
describe("Correct subscription — the renewal date follows the start date", () => {
  it("moves the renewal by the same 12 months when the start is corrected", () => {
    const { start, renew } = open(sub());
    expect(renew.value).toBe("2027-09-02");
    fireEvent.change(start, { target: { value: "2026-08-01" } });
    // Before the fix this stayed put and the term grew by five weeks.
    expect(renew.value).toBe("2027-07-31");
  });

  it("keeps a ONE-MONTH term at one month — not a year", () => {
    /* A flex subscription: the record's own gap says one month. */
    const { start, renew } = open(sub({ start_date: "2026-09-03", renewal_date: "2026-10-02" }));
    fireEvent.change(start, { target: { value: "2026-08-15" } });
    expect(renew.value).toBe("2026-09-14");
  });

  it("clamps into a short month instead of rolling into the next one", () => {
    const { start, renew } = open(sub({ start_date: "2026-09-03", renewal_date: "2026-10-02" }));
    fireEvent.change(start, { target: { value: "2026-01-31" } });
    /* 2026 is not a leap year, so 31 Jan + 1 month clamps to 28 Feb — and the last day
       COVERED is the 27th. */
    expect(renew.value).toBe("2026-02-27");
  });

  it("prefers the record's own dates over a term_months column that disagrees", () => {
    /* Every row created before 9 Sep 2026 carries term_months 12 from the DB default,
       whatever was actually sold — this dialog wrote neither column. The DATES are what
       the operator can see, so they win. */
    const { start, renew } = open(sub({
      start_date: "2026-09-03", renewal_date: "2026-10-02", term_months: 12,
    }));
    fireEvent.change(start, { target: { value: "2026-11-01" } });
    expect(renew.value).toBe("2026-11-30");
  });

  it("reads a term that ENDS ON A MONTH BOUNDARY as a full year, not eleven months", () => {
    /* The trap the inclusive end date introduces. A year from 1 Apr 2026 now stores
       31 Mar 2027, and monthsBetween looks only at year+month — so measured against the
       stored date directly the gap reads ELEVEN, and correcting the start would quietly
       shorten an annual subscription by a month. The term is measured to the day AFTER
       the stored date for exactly this reason. */
    const { start, renew } = open(sub({
      start_date: "2026-04-01", renewal_date: "2027-03-31", term_months: 12,
    }));
    fireEvent.change(start, { target: { value: "2026-05-01" } });
    expect(renew.value).toBe("2027-04-30");   // twelve months, not eleven
  });

  it("still lets the renewal date be overridden afterwards", () => {
    const { start, renew } = open(sub());
    fireEvent.change(start, { target: { value: "2026-08-01" } });
    fireEvent.change(renew, { target: { value: "2027-12-31" } });
    expect(renew.value).toBe("2027-12-31");
  });

  it("says what it will do, next to the field", () => {
    open(sub());
    expect(document.body.textContent).toContain("keeping the term 12 months long");
  });
});
