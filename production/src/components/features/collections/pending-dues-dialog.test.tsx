// @vitest-environment jsdom
/* R-1526 — "Send pending dues": opening only READS the preview (nothing sent). "Open WhatsApp"
   opens wa.me with the edited text and logs a follow-up (kind whatsapp, next date) through
   R-1517's route; "Send email" posts to the statement email route (which sends via lib/messaging
   with the PDF attached and logs on the server). No UPI ID → the §24 Settings note. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const CUST = "33333333-3333-4333-8333-333333333333";

const st = vi.hoisted(() => ({
  mutate: vi.fn(),
  preview: {} as Record<string, unknown>,
  calls: [] as { url: string; method: string; body: Record<string, unknown> | null }[],
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/queries/payment-followups", () => ({
  followupsKey: (id: string) => ["payment-followups", id],
  useAddFollowup: () => ({ mutate: st.mutate, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { PendingDuesDialog } from "./pending-dues-dialog";

const WA = "Hi Rahul, statement of pending dues from Demo Co: ₹72,300 across 2 bills as on 17 Oct 2026.\n\nTotal due: ₹72,300";

beforeEach(() => {
  st.mutate.mockReset();
  st.calls = [];
  st.preview = {
    ok: true, customerName: "Acme", asOn: "2026-10-17", total: 72300,
    lines: [
      { kind: "invoice", id: "INV-1", label: "INV-1", quoteId: null, date: "2026-08-01", dueDate: "2026-08-15", daysOverdue: 63, amountDue: 59000 },
      { kind: "invoice", id: "INV-2", label: "INV-2", quoteId: null, date: "2026-10-01", dueDate: "2026-10-10", daysOverdue: 7, amountDue: 13300 },
    ],
    qrNotice: { reason: "no-upi", text: "Add your UPI ID in Settings to show a Pay QR — the statement will then carry a scan-to-pay QR for the full amount.", action: { label: "Open Settings", href: "/settings?tab=company#payment-details" } },
    hasBank: true,
    subject: "Statement of pending dues: ₹72,300", emailText: "Hi Rahul, please find attached the statement: ₹72,300.", whatsappText: WA,
    whatsapp: "919876543210", whatsappBlocked: null, email: "accounts@acme.in", emailBlocked: null,
    about: { invoiceId: "INV-1", subscriptionId: null, quoteId: null },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    st.calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) as Record<string, unknown> : null });
    const json = url.endsWith("/email") ? { ok: true, sentTo: "accounts@acme.in", logged: true } : st.preview;
    return { ok: true, status: 200, json: async () => json } as unknown as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const renderDialog = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PendingDuesDialog open onOpenChange={() => {}} customerId={CUST} customerName="Acme" />
    </QueryClientProvider>,
  );
};

describe("Send pending dues dialog", () => {
  it("opening only reads the preview: bills, total, PDF link, the no-UPI Settings note — nothing sent", async () => {
    renderDialog();
    expect(await screen.findByText("INV-1")).toBeTruthy();
    expect(screen.getAllByText("₹72,300").length).toBeGreaterThan(0);
    expect(screen.getByText(/Add your UPI ID in Settings/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Settings" }).getAttribute("href")).toMatch(/^\/settings/);
    expect(screen.getByRole("link", { name: /Open statement PDF/ }).getAttribute("href")).toBe(`/api/customers/${CUST}/pending-dues/pdf`);
    expect(st.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(st.mutate).not.toHaveBeenCalled();
  });

  it("Open WhatsApp → wa.me with the text, then a whatsapp follow-up with the next date", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderDialog();
    await waitFor(() => expect((screen.getByLabelText(/Message/) as HTMLTextAreaElement).value).toBe(WA));
    fireEvent.click(screen.getByRole("button", { name: "Open WhatsApp" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0][0])).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
    expect(decodeURIComponent(String(open.mock.calls[0][0]).split("text=")[1])).toContain("₹72,300");
    expect(st.mutate).toHaveBeenCalledTimes(1);
    expect(st.mutate.mock.calls[0][0]).toMatchObject({ customerId: CUST, kind: "whatsapp", invoiceId: "INV-1" });
    expect(st.mutate.mock.calls[0][0].nextFollowUpOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("Email → posts subject + message + next date to the statement email route (no recipient, no amounts)", async () => {
    renderDialog();
    await screen.findByText("INV-1");
    fireEvent.click(screen.getByRole("button", { name: /Email \(PDF attached\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Send email" }));
    await waitFor(() => expect(st.calls.some((c) => c.url.endsWith("/email"))).toBe(true));
    const sent = st.calls.find((c) => c.url.endsWith("/email"))!;
    expect(sent.url).toBe(`/api/customers/${CUST}/pending-dues/email`);
    expect(Object.keys(sent.body ?? {}).sort()).toEqual(["message", "nextFollowUpOn", "requestId", "subject"]);
    // R-1544: one id per opening — a retry sends the same id, so the server sends one email.
    expect(String(sent.body?.requestId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("no mobile number → WhatsApp button off, says how to fix it", async () => {
    st.preview = { ...st.preview, whatsapp: null, whatsappBlocked: "No mobile number for this customer — add one to the primary contact on the customer page to send on WhatsApp." };
    renderDialog();
    await screen.findByText("INV-1");
    fireEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
    expect((screen.getByRole("button", { name: "Open WhatsApp" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No mobile number/)).toBeTruthy();
  });
});
