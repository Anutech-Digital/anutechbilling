// @vitest-environment jsdom
/* R-1518 — Remind dialog: opening it only DRAFTS (no send). "Open WhatsApp" opens wa.me with
   the EDITED text and logs a follow-up (kind whatsapp, first line, next date) through R-1517's
   route; no phone → the button is off and says how to fix it; "Send email" posts the edited
   text to the email route (which sends through lib/messaging and logs on the server). */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const CUST = "33333333-3333-4333-8333-333333333333";

const st = vi.hoisted(() => ({
  mutate: vi.fn(),
  draft: {} as Record<string, unknown>,
  calls: [] as { url: string; body: Record<string, unknown> }[],
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/queries/payment-followups", () => ({
  followupsKey: (id: string) => ["payment-followups", id],
  useAddFollowup: () => ({ mutate: st.mutate, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ReminderDialog } from "./reminder-dialog";

const FIRST = "Hi Rahul, a gentle reminder from Anutech: ₹72,500 is pending for Sharma Traders, 12 days overdue.";

beforeEach(() => {
  st.mutate.mockReset();
  st.calls = [];
  st.draft = {
    ok: true, subject: "Payment reminder: ₹72,500 pending", message: `${FIRST}\n\n• Invoice INV-101: ₹68,000`,
    mode: "template", note: "AI is not set up (no Gemini key) — this is the standard reminder. Edit it as you like.",
    amountDue: 72500, whatsapp: "919876543210", whatsappBlocked: null, email: "accounts@sharma.in", emailBlocked: null,
    about: { invoiceId: "INV-101", subscriptionId: null, quoteId: "Q-1" },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    st.calls.push({ url, body });
    const json = url.endsWith("/draft") ? st.draft : { ok: true, sentTo: "accounts@sharma.in", logged: true };
    return { ok: true, status: 200, json: async () => json } as unknown as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const renderDialog = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReminderDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" />
    </QueryClientProvider>,
  );
};

const message = async () => (await screen.findByLabelText(/Message/)) as HTMLTextAreaElement;

describe("Remind dialog", () => {
  it("opening only drafts — the draft fills the editable message, nothing is sent", async () => {
    renderDialog();
    expect((await message()).value).toContain(FIRST);
    expect(screen.getByText("Standard reminder")).toBeTruthy();
    expect(st.calls.map((c) => c.url)).toEqual(["/api/collections/reminder/draft"]);
    expect(st.calls[0].body).toEqual({ customerId: CUST });
    expect(st.mutate).not.toHaveBeenCalled();
  });

  it("Open WhatsApp → wa.me with the EDITED text in a new tab, and the follow-up is logged", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderDialog();
    const box = await message();
    fireEvent.change(box, { target: { value: "Hi Rahul, ₹72,500 pending — please pay by Monday.\nThanks" } });
    fireEvent.click(screen.getByRole("button", { name: "Open WhatsApp" }));
    expect(open).toHaveBeenCalledWith(
      `https://wa.me/919876543210?text=${encodeURIComponent("Hi Rahul, ₹72,500 pending — please pay by Monday.\nThanks")}`,
      "_blank", "noopener,noreferrer",
    );
    expect(st.mutate).toHaveBeenCalledTimes(1);
    const body = st.mutate.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      customerId: CUST, kind: "whatsapp", note: "Hi Rahul, ₹72,500 pending — please pay by Monday.",
      invoiceId: "INV-101", quoteId: "Q-1",
    });
    expect(body.nextFollowUpOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("no phone → WhatsApp off with the reason; clicking does nothing", async () => {
    st.draft = { ...st.draft, whatsapp: null, whatsappBlocked: "No mobile number for this customer — add one to the primary contact on the customer page to send on WhatsApp." };
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderDialog();
    await message();
    const btn = screen.getByRole("button", { name: "Open WhatsApp" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/No mobile number for this customer/)).toBeTruthy();
    fireEvent.click(btn);
    expect(open).not.toHaveBeenCalled();
    expect(st.mutate).not.toHaveBeenCalled();
  });

  it("empty message → nothing opens, nothing is logged, the field says why", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderDialog();
    fireEvent.change(await message(), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Open WhatsApp" }));
    expect(open).not.toHaveBeenCalled();
    expect(st.mutate).not.toHaveBeenCalled();
    expect(await screen.findByText(/The message is empty/)).toBeTruthy();
  });

  it("Send email posts the edited subject + text to the email route (no recipient in the body)", async () => {
    renderDialog();
    await message();
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    await waitFor(() => expect(st.calls.map((c) => c.url)).toContain("/api/collections/reminder/email"));
    const sent = st.calls.find((c) => c.url.endsWith("/email"))!.body;
    expect(sent).toMatchObject({ customerId: CUST, subject: "Payment reminder: ₹72,500 pending", invoiceId: "INV-101", quoteId: "Q-1" });
    expect(sent.message).toContain(FIRST);
    expect(sent).not.toHaveProperty("to");
    // R-1544: the same id on a retry (Send pressed again while this dialog is open).
    expect(String(sent.requestId)).toMatch(/^[0-9a-f-]{36}$/);
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    await waitFor(() => expect(st.calls.filter((c) => c.url.endsWith("/email"))).toHaveLength(2));
    expect(st.calls.filter((c) => c.url.endsWith("/email"))[1].body.requestId).toBe(sent.requestId);
  });
});
