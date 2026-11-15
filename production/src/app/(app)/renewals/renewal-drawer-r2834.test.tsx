// @vitest-environment jsdom
/* R-2834 — the Renewals drawer's "Renews <date>" line and the row's Due-cell tooltip give the SAME
   answer as the Due column (R-2817's anchor, due-anchor.ts dueCellFacts): "Part due 1 Oct 2026 ·
   renews 31 Oct 2026" when a part fell due before the renewal date; otherwise "Renews <date>". */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";
import { renewalStage, type StageSub } from "@/lib/renewals/stage";

vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "billing" } }) }));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<typeof import("@/lib/dates/ist")>()), istToday: () => "2026-11-14" }));
vi.mock("./drawer-data", () => ({
  useRenewalDrawerData: () => ({ data: { docs: undefined, paid: undefined }, isLoading: false, isError: false }),
}));
vi.mock("./drawer-cost-data", () => ({ useRenewalDrawerCatalog: () => ({ data: [], isError: false }) }));
vi.mock("@/components/features/renewals/renewal-actions", () => ({ RenewalActions: () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { RenewalDrawer, type DrawerItem } from "./renewal-drawer";
import { DueCell } from "./row-cells";
import { dueCellFacts } from "./due-anchor";
import { renewalAmount } from "./queue";

const TODAY = "2026-11-14";
/** Greentin Check 2095 (R-2817): monthly, renews 31 Oct, part 1 Oct – 1 Nov due 1 Oct unpaid. */
const greentinStage: StageSub = {
  status: "active", renewal_state: "renewed", renewal_date: "2026-10-31", term_months: 1,
  billing_cycle: "monthly", start_date: "2026-09-01", auto_renew: true, grace_until: null, renewal_quote_id: null,
};
const partDoc = (dueDate: string) => ({ doc: { kind: "part" as const, quoteId: "Q-P", status: "sent", dueDate, period: "Oct 2026" } });
const SUB = {
  id: "sub-1", tenant_id: "t-1", customer_id: "c-1", customer_name: "CT Greentin", plan: "Google Workspace Business Starter",
  seats: 5, vendor: "google", item_id: null, term_months: 1, mrr: 1000, term_amount: null, renewal_date: "2026-10-31",
  start_date: "2026-09-01", status: "active", renewal_quote_id: null, quote_id: null, reminder_count: 0, vendor_term_end: "2027-01-12",
  billing_cycle: "monthly",
};
const item = (sub: Record<string, unknown>, stage: DrawerItem["stage"]): DrawerItem => ({
  sub: sub as never, daysUntil: -14, stage, amount: renewalAmount(sub as never, null), frequency: "Monthly", payHref: null, docs: undefined,
  followup: { ownerId: null, nextFollowUpOn: null, promisedOn: null, promisedAmount: null, promiseStatus: null, confirmed: false } as never,
});
const show = (sub: Record<string, unknown>, stage: DrawerItem["stage"]) =>
  render(<RenewalDrawer item={item(sub, stage)} open onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
const renewsLine = () => screen.getByTestId("renewal-drawer-renews").textContent;

afterEach(cleanup);

describe("R-2834 drawer 'Renews' line = the row's Due answer", () => {
  it("part due before renewal → 'Part due 1 Oct 2026 · renews 31 Oct 2026'", () => {
    show(SUB, renewalStage({ sub: greentinStage, todayIst: TODAY, ...partDoc("2026-10-01") }));
    expect(renewsLine()).toBe("Part due 1 Oct 2026 · renews 31 Oct 2026");
  });
  it("no part due earlier → unchanged 'Renews 31 Oct 2026'", () => {
    show(SUB, renewalStage({ sub: greentinStage, todayIst: TODAY }));
    expect(renewsLine()).toBe("Renews 31 Oct 2026");
  });
  it("stage still loading → 'Renews <date>'; no date → 'Renews — no date'", () => {
    show(SUB, null);
    expect(renewsLine()).toBe("Renews 31 Oct 2026");
    cleanup();
    show({ ...SUB, renewal_date: null }, null);
    expect(renewsLine()).toBe("Renews — no date");
  });
  it("R-2823's vendor line stays", () => {
    show(SUB, renewalStage({ sub: greentinStage, todayIst: TODAY, ...partDoc("2026-10-01") }));
    expect(screen.getByTestId("renewal-drawer-vendor-term").textContent).toMatch(/^Google renews /);
  });
});

describe("R-2834 Due cell hover shows both dates", () => {
  it("the date's own tooltip is the two-date title, not just the full date", () => {
    const f = dueCellFacts(renewalStage({ sub: greentinStage, todayIst: TODAY, ...partDoc("2026-10-01") }), SUB, -14);
    render(<DueCell date={f.date} days={f.days} title={f.title} />);
    const date = screen.getByText("1 Oct 26");
    expect(date.closest("[title]")?.getAttribute("title")).toBe("Part due 1 Oct 2026 · renews 31 Oct 2026");
    expect(screen.getByText(/ago$/).closest("[title]")?.getAttribute("title")).toBe("Part due 1 Oct 2026 · renews 31 Oct 2026");
  });
  it("without a title the date still shows its full date on hover", () => {
    render(<DueCell date="2026-11-12" days={-2} />);
    expect(screen.getByText("12 Nov 26").closest("[title]")?.getAttribute("title")).toBe("12 Nov 2026");
  });
});
