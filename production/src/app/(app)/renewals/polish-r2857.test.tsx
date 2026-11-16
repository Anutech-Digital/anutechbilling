// @vitest-environment jsdom
/* R-2857 — Renewals drawer + rows polish (Pardeep 16 Nov, Chrome human test on staging). Display only:
     1. the History tabs (All · Quotes · Invoices · Payments · Timeline) stay on ONE line in the drawer
     2. Flags: "At risk" once, not "At risk — At risk"
     3. phones in ONE form, "+91 98765 98765" (staging: +919876598765 / +91-9898989898 / 9876543210)
     4. "Google Workspace Business Starter (1 seats) · 1 seats" → the count once; "1 seat"
   (5. the row's "quote ₹92.0K" is built in queue.ts — R-2854's file; not in this card's diff.) */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, within } from "@testing-library/react";

vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "billing" } }) }));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<typeof import("@/lib/dates/ist")>()), istToday: () => "2026-11-15" }));
vi.mock("./drawer-data", () => ({
  useRenewalDrawerData: () => ({ data: { docs: undefined, paid: undefined }, isLoading: false, isError: false }),
}));
vi.mock("./drawer-cost-data", () => ({ useRenewalDrawerCatalog: () => ({ data: [], isError: false }) }));
vi.mock("./drawer-seat-cut-data", () => ({ useRenewalDrawerSeatCuts: () => ({ data: [], isError: false }) }));
vi.mock("@/components/features/renewals/renewal-actions", () => ({ RenewalActions: () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { RenewalDrawer, type DrawerItem } from "./renewal-drawer";
import { renewalAmount } from "./queue";
import { drawerFlagRows, flagReasonAfterTitle } from "./drawer";
import { mergeContact } from "./queue-data";
import { planSeatsWords, seatsAfterPlan, seatCountWords } from "./plan-seats";
import { displayPhone, renewalContactView } from "@/components/features/renewals/renewal-contact-rules";

const SUB = {
  id: "sub-1", tenant_id: "t-1", customer_id: "c-1", customer_name: "FIRST POINT CREATIONS", plan: "Google Workspace Business Starter (1 seats)",
  seats: 1, vendor: "google", item_id: null, term_months: 12, mrr: 6500, term_amount: null, renewal_date: "2026-11-20",
  start_date: "2025-11-21", status: "active", renewal_quote_id: null, quote_id: null, reminder_count: 0, vendor_term_end: null,
};
const item = (over: Partial<DrawerItem> = {}, sub: Record<string, unknown> = SUB): DrawerItem => ({
  sub: sub as never, daysUntil: 5, stage: null, amount: renewalAmount(sub as never, null), frequency: "Yearly", payHref: null, docs: undefined,
  followup: { ownerId: null, nextFollowUpOn: null, promisedOn: null, promisedAmount: null, promiseStatus: null, confirmed: false } as never,
  ...over,
});
const show = (it: DrawerItem) => render(<RenewalDrawer item={it} open onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
const stage = (flags: { key: string; reason: string }[]) =>
  ({ key: "not_started", label: "Not started", note: null, tone: "neutral", flags, quoteId: null, quoteStatus: null }) as never;

afterEach(cleanup);

describe("R-2857 (1) History tabs on one line", () => {
  it("the tab strip is compact (the one-line fit itself is measured in e2e/cards/R-2857.spec.ts)", () => {
    show(item());
    const list = screen.getByTestId("renewal-drawer-history-tabs");
    /* no gap between tabs, and nothing that clips or hides a tab (no sideways scroll) */
    expect(list.className).toMatch(/\bgap-0\b/);
    expect(list.className).not.toMatch(/overflow-/);
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["All", "Quotes", "Invoices", "Payments", "Timeline"]);
    for (const t of tabs) {
      expect(t.className).toMatch(/\bwhitespace-nowrap\b/);
      expect(t.className).toMatch(/\bpx-1(?![.\d])/);
      expect(t.className).not.toMatch(/\bpx-2\.5\b/);
    }
  });
});

describe("R-2857 (2) a flag's label is not repeated", () => {
  it("the reason is only what the title does not already say", () => {
    expect(flagReasonAfterTitle("At risk", "At risk")).toBe("");
    expect(flagReasonAfterTitle("At risk", "at risk ")).toBe("");
    expect(flagReasonAfterTitle("At risk", "At risk: Renewal 11d overdue")).toBe("Renewal 11d overdue");
    expect(flagReasonAfterTitle("At risk", "At risk — low usage")).toBe("low usage");
    /* a reason that only happens to start with the same letters stays whole */
    expect(flagReasonAfterTitle("At risk", "At risky terms")).toBe("At risky terms");
    expect(flagReasonAfterTitle("Previous term unpaid", "Previous term ₹98 still unpaid")).toBe("Previous term ₹98 still unpaid");
    /* the other flags whose reason starts with their title */
    expect(flagReasonAfterTitle("Follow-up due", "Follow-up due 12 Nov 2026")).toBe("12 Nov 2026");
    expect(flagReasonAfterTitle("Renewal held", "Renewal held. The renewal date was kept.")).toBe("The renewal date was kept.");
    expect(drawerFlagRows([{ key: "atRisk", reason: "At risk" }])[0]).toMatchObject({ title: "At risk", reason: "" });
    expect(drawerFlagRows([{ key: "atRisk", reason: "At risk: Renewal 11d overdue" }])[0].reason).toBe("Renewal 11d overdue");
  });
  it("drawer Flags: 'At risk' once — no 'At risk — At risk'", () => {
    show(item({ stage: stage([{ key: "atRisk", reason: "At risk" }]) }));
    const flag = within(screen.getByTestId("renewal-drawer-flags")).getByTestId("renewal-drawer-flag");
    expect(flag.querySelector("p")?.textContent).toBe("At risk");
    expect(flag.textContent).not.toMatch(/At risk\s*—\s*At risk/);
  });
  it("drawer Flags: a real reason still follows the title", () => {
    show(item({ stage: stage([{ key: "atRisk", reason: "At risk: Unpaid balance (₹5K)" }]) }));
    const flag = within(screen.getByTestId("renewal-drawer-flags")).getByTestId("renewal-drawer-flag");
    expect(flag.querySelector("p")?.textContent).toBe("At risk — Unpaid balance (₹5K)");
  });
});

describe("R-2857 (3) one phone format", () => {
  it("the three ways staging showed a number all read '+91 xxxxx xxxxx'", () => {
    expect(displayPhone("+919876598765", "India")).toBe("+91 98765 98765");
    expect(displayPhone("+91-9898989898", "India")).toBe("+91 98989 89898");
    expect(displayPhone("9876543210", "India")).toBe("+91 98765 43210");
    expect(displayPhone("9876543210", null)).toBe("+91 98765 43210");
    expect(displayPhone("098765 43210", "")).toBe("+91 98765 43210");
  });
  it("country-aware: a number saved without a code takes the customer's country, never a fixed +91", () => {
    expect(displayPhone("2025550143", "United States")).toBe("+1 202 555 0143");
    expect(displayPhone("07911123456", "United Kingdom")).toBe("+44 7911123456");
    expect(displayPhone("+1 555 123 4567", "India")).toBe("+1 555 123 4567");
  });
  it("masked, unreadable or empty stays as it is", () => {
    expect(displayPhone("••••••3210", "India")).toBe("••••••3210");
    expect(displayPhone("12345", "India")).toBe("12345");
    /* not plainly ONE mobile number → as saved, never a guessed (and dialled) wrong number */
    expect(displayPhone("9876543210 / 9000000001", "India")).toBe("9876543210 / 9000000001");
    expect(displayPhone("9876543210 9000000001", "India")).toBe("9876543210 9000000001");
    expect(displayPhone("9876543210 (accounts)", "India")).toBe("9876543210 (accounts)");
    expect(displayPhone("98765987651", "India")).toBe("98765987651");
    expect(displayPhone("1800 123 4567", "India")).toBe("1800 123 4567");
    expect(displayPhone("011 2345 6789", "India")).toBe("011 2345 6789");
    expect(mergeContact(undefined, { contact_email: null, contact_phone: "9876543210 / 9000000001", country: "India" }).phone).toBe("9876543210 / 9000000001");
    expect(displayPhone("  ", "India")).toBeNull();
    expect(displayPhone(null)).toBeNull();
  });
  it("the row's contact (mergeContact) carries the display form; the links still dial the same number", () => {
    const c = mergeContact({ name: "Asha", email: null, phone: "+919876598765" }, { contact_email: null, contact_phone: "9876543210", country: "India" });
    expect(c.phone).toBe("+91 98765 98765");
    expect(mergeContact(undefined, { contact_email: null, contact_phone: "+91-9898989898", country: null }).phone).toBe("+91 98989 89898");
    expect(mergeContact(undefined, { contact_email: null, contact_phone: "2025550143", country: "United States" }).phone).toBe("+1 202 555 0143");
    expect(mergeContact(undefined, undefined).phone).toBeNull();
    /* the row's tel: link strips the spaces → the same E.164 number */
    expect(`tel:${c.phone!.replace(/\s+/g, "")}`).toBe("tel:+919876598765");
    const v = renewalContactView(c)!;
    expect(v.phoneText).toBe("+91 98765 98765");
    expect(v.telHref).toBe("tel:+919876598765");
    expect(v.whatsappHref).toBe("https://wa.me/919876598765");
  });
  it("drawer header shows the same form as the row", () => {
    show(item({ contact: mergeContact(undefined, { contact_email: null, contact_phone: "9876543210", country: "India" }) }));
    expect(within(screen.getByTestId("renewal-contact")).getByText("+91 98765 43210").closest("a")?.getAttribute("href")).toBe("tel:+919876543210");
  });
});

describe("R-2857 (4) the seat count is said once", () => {
  it("'1 seat', not '1 seats'", () => {
    expect(seatCountWords(1)).toBe("1 seat");
    expect(seatCountWords(20)).toBe("20 seats");
    expect(seatCountWords(0)).toBe("0 seats");
  });
  it("a plan name that already carries the count gets nothing appended", () => {
    expect(planSeatsWords("Google Workspace Business Starter (1 seats)", 1)).toBe("Google Workspace Business Starter (1 seats)");
    expect(planSeatsWords("Microsoft 365 Business Basic - 5 Seats", 5)).toBe("Microsoft 365 Business Basic - 5 Seats");
    expect(planSeatsWords("Workspace 25 Seats pack", 25)).toBe("Workspace 25 Seats pack");
    expect(seatsAfterPlan("Google Workspace Business Starter (1 seats)", 1)).toBeNull();
  });
  it("otherwise the count follows the plan", () => {
    expect(planSeatsWords("Google Workspace Business Starter", 1)).toBe("Google Workspace Business Starter · 1 seat");
    expect(planSeatsWords("Google Workspace Business Standard", 20)).toBe("Google Workspace Business Standard · 20 seats");
    /* a number in the name that is not a seat count ("365", "E3 Users") never hides the seats */
    expect(planSeatsWords("Microsoft 365 Business Basic", 365)).toBe("Microsoft 365 Business Basic · 365 seats");
    expect(planSeatsWords("Microsoft 365 E3 Users", 3)).toBe("Microsoft 365 E3 Users · 3 seats");
    expect(planSeatsWords("Zoho Mail 20 users", 20)).toBe("Zoho Mail 20 users · 20 seats");
    expect(planSeatsWords("Domain .com", null)).toBe("Domain .com");
    expect(planSeatsWords(null, 3)).toBe("3 seats");
  });
  it("drawer header: 'Google Workspace Business Starter (1 seats) · Google' — the count once", () => {
    show(item());
    const header = screen.getByRole("dialog");
    expect(header.textContent).toContain("Google Workspace Business Starter (1 seats) · Google");
    expect(header.textContent).not.toMatch(/\(1 seats\) · 1 seats?/);
  });
  it("drawer header: a plain plan name reads '· 1 seat'", () => {
    show(item({}, { ...SUB, plan: "Google Workspace Business Starter" }));
    expect(screen.getByRole("dialog").textContent).toContain("Google Workspace Business Starter · 1 seat · Google");
  });
});
