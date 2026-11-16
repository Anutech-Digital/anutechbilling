// @vitest-environment jsdom
/* R-2824 — who to call for a renewal: the drawer header and the renewal follow-up dialog show
   contact name · phone (call + WhatsApp with the customer's own dialling code) · email, or
   "No contact — Add contact". Never a fixed +91. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Subscription } from "@/lib/supabase/database.types";

const CUST = "33333333-3333-4333-8333-333333333333";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { userId: "u1", role: "owner" } }) }));
vi.mock("@/lib/hooks/useUserNames", () => ({ useUserNames: () => ({ data: new Map() }) }));
vi.mock("@/lib/queries/payment-followups", () => ({
  FollowupSaveError: class extends Error {},
  useCustomerFollowups: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useAddFollowup: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/app/(app)/renewals/drawer-data", () => ({ useRenewalDrawerData: () => ({ data: undefined, isLoading: false, isError: false }) }));
vi.mock("@/components/features/renewals/renewal-actions", () => ({ RenewalActions: () => null }));

import { RenewalContact } from "./renewal-contact";
import { renewalContactView } from "./renewal-contact-rules";
import { RenewalDrawer, type DrawerItem } from "@/app/(app)/renewals/renewal-drawer";
import { FollowupDialog } from "@/components/features/collections/followup-dialog";
import { mergeContact } from "@/app/(app)/renewals/queue-data";

afterEach(cleanup);

describe("renewalContactView — the number follows the customer's country", () => {
  it("India: 10-digit number → +91, call + WhatsApp links", () => {
    const v = renewalContactView({ name: "Asha", phone: "9876500002", email: "asha@x.in", country: "India" })!;
    expect(v.telHref).toBe("tel:+919876500002");
    expect(v.whatsappHref).toBe("https://wa.me/919876500002");
    expect(v.mailHref).toBe("mailto:asha@x.in");
  });
  it("abroad: a UK number saved without a code gets 44, not 91", () => {
    const v = renewalContactView({ name: null, phone: "07911123456", email: null, country: "United Kingdom" })!;
    expect(v.telHref).toBe("tel:+447911123456");
    expect(v.whatsappHref).toBe("https://wa.me/447911123456");
    expect(v.phoneText).toBe("+44 7911123456"); /* R-2857: the one display form */
  });
  it("a number saved with its own code keeps it", () => {
    const v = renewalContactView({ name: null, phone: "+1 555 123 4567", email: null, country: "India" })!;
    expect(v.whatsappHref).toBe("https://wa.me/15551234567");
  });
  it("nothing on file → null", () => {
    expect(renewalContactView(null)).toBeNull();
    expect(renewalContactView({ name: "Only name", phone: " ", email: null })).toBeNull();
  });
  it("a masked number / email is shown, never linked", () => {
    const v = renewalContactView({ name: "A", phone: "••••••3210", email: "a••••@x.in", country: "India" })!;
    expect(v.masked).toBe(true);
    expect(v.telHref).toBeNull(); expect(v.whatsappHref).toBeNull(); expect(v.mailHref).toBeNull();
  });
});

describe("RenewalContact", () => {
  it("shows name · phone (tel) · WhatsApp · email (mailto)", () => {
    render(<RenewalContact customerId={CUST} contact={{ name: "Asha Rao", phone: "9876500002", email: "asha@x.in", country: "India" }} />);
    const box = screen.getByTestId("renewal-contact");
    expect(within(box).getByText("Asha Rao")).toBeTruthy();
    expect(within(box).getByText("+91 98765 00002").closest("a")?.getAttribute("href")).toBe("tel:+919876500002");
    expect(within(box).getByText("WhatsApp").closest("a")?.getAttribute("href")).toBe("https://wa.me/919876500002");
    expect(within(box).getByText("asha@x.in").closest("a")?.getAttribute("href")).toBe("mailto:asha@x.in");
  });
  it("customer abroad: WhatsApp link carries the customer's country code", () => {
    render(<RenewalContact customerId={CUST} contact={{ name: "Sam", phone: "2025550143", email: null, country: "United States" }} />);
    expect(screen.getByText("WhatsApp").closest("a")?.getAttribute("href")).toBe("https://wa.me/12025550143");
  });
  it("no contact → 'No contact — Add contact' linking to the customer", () => {
    render(<RenewalContact customerId={CUST} contact={{ name: null, phone: null, email: null }} />);
    expect(screen.getByTestId("renewal-contact").getAttribute("data-state")).toBe("none");
    expect(screen.getByText("Add contact").closest("a")?.getAttribute("href")).toBe(`/customers/${CUST}`);
  });
  it("contacts still loading → nothing (never a wrong 'No contact')", () => {
    const { container } = render(<RenewalContact customerId={CUST} contact={undefined} loading />);
    expect(container.textContent).toBe("");
  });
});

describe("mergeContact keeps the customer's country", () => {
  it("country comes from the customer row", () => {
    expect(mergeContact(undefined, { contact_email: null, contact_phone: "1", country: " India " }).country).toBe("India");
    expect(mergeContact(undefined, undefined).country).toBeNull();
  });
});

const SUB = { id: "s1", customer_id: CUST, customer_name: "Acme", plan: "Workspace", seats: 5, vendor: "google", renewal_date: "2026-12-01" } as unknown as Subscription;
const item = (contact: DrawerItem["contact"]): DrawerItem => ({
  sub: SUB, daysUntil: 10, stage: null, amount: { text: "₹1,000", gst: "+ GST", value: 1000 } as DrawerItem["amount"],
  frequency: null, followup: {} as DrawerItem["followup"], payHref: null, docs: undefined, contact,
});

describe("the drawer header", () => {
  it("shows the contact", () => {
    render(<QueryClientProvider client={new QueryClient()}><RenewalDrawer item={item({ name: "Asha", phone: "9876500002", email: null, country: "India" })} open onClose={() => {}} names={undefined} followupRows={[]} strong={false} /></QueryClientProvider>);
    const head = screen.getByTestId("renewal-drawer");
    expect(within(head).getByText("+91 98765 00002")).toBeTruthy();
  });
  it("shows 'Add contact' when the customer has none", () => {
    render(<QueryClientProvider client={new QueryClient()}><RenewalDrawer item={item({ name: null, phone: null, email: null })} open onClose={() => {}} names={undefined} followupRows={[]} strong={false} /></QueryClientProvider>);
    expect(screen.getByText("Add contact")).toBeTruthy();
  });
});

describe("the renewal follow-up dialog", () => {
  const dlg = (contact: React.ComponentProps<typeof FollowupDialog>["contact"], renewal = true) => render(
    <FollowupDialog open onOpenChange={() => {}} customerId={CUST} customerName="Acme" ownerId={null}
      items={[{ kind: "subscription", id: "s1", label: "Workspace", quoteId: null }]} stillOwes amountDue={0}
      renewal={renewal ? { subscriptionId: "s1" } : undefined} contact={contact} />,
  );
  it("shows who to call", () => {
    dlg({ name: "Asha", phone: "9876500002", email: "asha@x.in", country: "India" });
    expect(within(screen.getByTestId("renewal-contact")).getByText("Asha")).toBeTruthy();
    expect(within(screen.getByTestId("renewal-contact")).getByText("WhatsApp")).toBeTruthy();
  });
  it("no contact → Add contact", () => {
    dlg({ name: null, phone: null, email: null });
    expect(screen.getByText("Add contact")).toBeTruthy();
  });
  it("a Payment follow-up (not a renewal) shows no contact block", () => {
    dlg({ name: "Asha", phone: "9876500002", email: null }, false);
    expect(screen.queryByTestId("renewal-contact")).toBeNull();
  });
});
