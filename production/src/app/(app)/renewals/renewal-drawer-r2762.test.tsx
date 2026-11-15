// @vitest-environment jsdom
/* R-2762 — the Renewals drawer's Follow-ups section lists the renewal reminders sent (email +
   WhatsApp) with the count, newest first; nothing sent → "No reminder sent yet". */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, within, fireEvent } from "@testing-library/react";
import type { ReminderLog } from "./reminder-log";

type Q = { data: { docs: undefined; paid: undefined; reminders: ReminderLog | null } | undefined; isLoading: boolean; isError: boolean; isSuccess: boolean };
const drawerQuery = vi.fn((): Q => ({ data: { docs: undefined, paid: undefined, reminders: { email: [], whatsapp: [] } }, isLoading: false, isError: false, isSuccess: true }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("./drawer-data", () => ({ useRenewalDrawerData: () => drawerQuery() }));
vi.mock("./drawer-cost-data", () => ({ useRenewalDrawerCatalog: () => ({ data: [], isError: false }) }));
vi.mock("@/components/features/renewals/renewal-actions", () => ({ RenewalActions: () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { RenewalDrawer, type DrawerItem } from "./renewal-drawer";
import { renewalAmount } from "./queue";

const SUB = {
  id: "sub-1", tenant_id: "t-1", customer_id: "c-1", customer_name: "CT R2762 Plan", plan: "Google Workspace Business Standard",
  seats: 5, vendor: "google", item_id: null, term_months: 12, mrr: 1000, term_amount: null, renewal_date: "2026-12-01",
  start_date: "2025-12-01", status: "active", renewal_quote_id: null, quote_id: null, reminder_count: 0,
};
const item = (sub: Record<string, unknown> = SUB): DrawerItem => ({
  sub: sub as never, daysUntil: 17, stage: null, amount: renewalAmount(sub as never, null), frequency: "Yearly", payHref: null, docs: undefined,
  followup: { ownerId: null, nextFollowUpOn: null, promisedOn: null, promisedAmount: null, promiseStatus: null, confirmed: false } as never,
});
const show = (it = item()) => render(<RenewalDrawer item={it} open onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
const fu = () => within(screen.getByTestId("renewal-drawer-followups"));
const withLog = (reminders: ReminderLog | null) => drawerQuery.mockReturnValue({ data: { docs: undefined, paid: undefined, reminders }, isLoading: false, isError: false, isSuccess: true });

afterEach(() => { cleanup(); drawerQuery.mockReset(); withLog({ email: [], whatsapp: [] }); });

const email = (id: string, day: string, step = "reminder_1", status = "sent") => ({ id, cadence_step: step, recipient_email: "ap@client.in", status, sent_at: `${day}T04:00:00Z` });

describe("R-2762 drawer: reminders sent", () => {
  it("nothing sent → No reminder sent yet, no list", () => {
    withLog({ email: [], whatsapp: [] });
    show();
    expect(fu().getByTestId("renewal-drawer-reminders-summary").textContent).toBe("No reminder sent yet");
    expect(fu().queryByTestId("renewal-drawer-reminders")).toBeNull();
  });

  it("lists email + WhatsApp newest first with date · channel · step · to whom, and the count", () => {
    withLog({
      email: [email("e1", "2026-10-01", "early_notice"), email("e2", "2026-11-02")],
      whatsapp: [{ id: "w1", kind: "renewal_upcoming", step: "notice_sent", phone: "+919800000001", status: "delivered", sent_at: "2026-10-20T04:00:00Z", created_at: "2026-10-20T04:00:00Z" }],
    });
    show();
    expect(fu().getByTestId("renewal-drawer-reminders-summary").textContent).toBe("3 reminders sent this term (2 email, 1 WhatsApp) · last 2 Nov 2026");
    const rows = fu().getAllByTestId("renewal-drawer-reminder");
    expect(rows.map((r) => r.getAttribute("data-channel"))).toEqual(["Email", "WhatsApp", "Email"]);
    expect(rows[0].textContent).toContain("2 Nov 2026 · Email · Reminder 1 (T-12)");
    expect(rows[0].textContent).toContain("to ap@client.in");
    expect(rows[1].textContent).toContain("WhatsApp · Notice sent (T-15)");
    expect(rows[1].textContent).toContain("Delivered");
    expect(rows[2].textContent).toContain("Early notice (T-30)");
  });

  it("shows 5, then Show all N reminders", () => {
    withLog({ email: Array.from({ length: 7 }, (_, i) => email(`e${i}`, `2026-10-1${i}`)), whatsapp: [] });
    show();
    expect(fu().getAllByTestId("renewal-drawer-reminder")).toHaveLength(5);
    fireEvent.click(fu().getByRole("button", { name: "Show all 7" }));
    expect(fu().getAllByTestId("renewal-drawer-reminder")).toHaveLength(7);
  });

  it("log could not be read → the subscription's counter + a plain line, documents unaffected", () => {
    withLog(null);
    show(item({ ...SUB, reminder_count: 2, last_reminder_sent_at_v2: "2026-11-02T05:00:00Z" }));
    expect(fu().getByTestId("renewal-drawer-reminders-summary").textContent).toBe("2 reminders sent · last 2 Nov 2026");
    expect(fu().getByText(/Couldn.t load the reminder list/)).toBeTruthy();
  });
});
