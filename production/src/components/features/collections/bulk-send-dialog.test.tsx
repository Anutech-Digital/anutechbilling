// @vitest-environment jsdom
/* R-2413 — bulk Send reminder / Send statement: one dialog lists who gets it and who is skipped
   (promised / disputed / not due / no email) and why; opening only READS (standard template, no
   AI); nothing is sent until the person presses "Email N customers"; a failed one is offered
   again with the SAME requestId (never mailed twice). */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CollectionRow, OwedItem } from "@/lib/queries/collections";

const st = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; body: Record<string, unknown> | null }[],
  failOnce: new Set<string>(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: st.toast }));

import { BulkSendDialog } from "./bulk-send-dialog";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const E = "55555555-5555-4555-8555-555555555555";

const item = (id: string, amountDue: number, daysOverdue: number): OwedItem => ({
  kind: "invoice", id, label: id, href: `/invoices/${id}`, quoteId: null, quoteHref: null, subscriptionHref: null,
  amountDue, daysOverdue, tdsHint: null,
});
function row(id: string, name: string, p: Partial<CollectionRow> & { days?: number; due?: number } = {}): CollectionRow {
  const days = p.days ?? 10;
  const due = p.due ?? 1000;
  const { days: _d, due: _a, ...rest } = p;
  void _d; void _a;
  return {
    key: id, customerId: id, customerName: name, customerHref: `/customers/${id}`, ownerId: null, assignedTo: null,
    items: [item(`INV-${name}`, due, days)], amountDue: due, renewals: [], renewalAmount: 0, daysOverdue: days,
    promisedOn: null, promisedAmount: null, promiseStatus: null, promiseBroken: false, payments: [],
    nextFollowUpOn: null, followUpDue: false, lastNote: null, lastNoteOn: null, hold: null, stage: "notContacted", priorityScore: 0,
    ...rest,
  };
}

const ROWS = [
  row(A, "Sharma Traders", { due: 68_000, days: 12 }),
  row(B, "Gupta & Sons", { due: 5_900, days: 3 }),
  row(C, "Promised Ltd", { hold: { kind: "promise", until: "2026-11-09", amount: null } }),
  row(D, "Not Due Co", { days: -4 }),
  row(E, "No Mail Pvt", { due: 2_000, days: 40 }),
];

const emailOf: Record<string, string | null> = { [A]: "accounts@sharma.in", [B]: "pay@gupta.in", [E]: null, [C]: "x@p.in", [D]: "y@n.in" };

beforeEach(() => {
  st.calls = []; st.failOnce = new Set(); st.toast.success.mockReset(); st.toast.warning.mockReset(); st.toast.error.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    st.calls.push({ url, method: init?.method ?? "GET", body });
    const ok = (j: unknown) => new Response(JSON.stringify({ ok: true, ...(j as object) }), { status: 200 });
    if (url === "/api/collections/reminder/draft") {
      const id = String(body?.customerId);
      const em = emailOf[id];
      return ok({
        subject: "Payment reminder", message: `Hi, ₹ pending for ${id}`, mode: "template", note: null,
        amountDue: id === A ? 68_000 : id === B ? 5_900 : 2_000,
        email: em, emailBlocked: em ? null : "No email for this customer — add one on the customer page.",
        whatsapp: null, whatsappBlocked: "no phone",
        about: { invoiceId: `INV-${id}`, subscriptionId: null, quoteId: null },
      });
    }
    if (url.startsWith("/api/customers/") && (init?.method ?? "GET") === "GET") {
      const id = url.split("/")[3];
      const em = emailOf[id];
      return ok({ customerName: id, asOn: "2026-11-03", lines: [], total: 1_000, qrNotice: null, hasBank: true,
        subject: "Statement", emailText: "Your statement", whatsappText: "x", payLink: null,
        email: em, emailBlocked: em ? null : "No email for this customer.", whatsapp: null, whatsappBlocked: "no phone",
        about: { invoiceId: null, subscriptionId: null, quoteId: null } });
    }
    if (url === "/api/collections/reminder/email" || url.endsWith("/pending-dues/email")) {
      const key = String(body?.customerId ?? url.split("/")[3]);
      if (st.failOnce.has(key)) {
        st.failOnce.delete(key);
        return new Response(JSON.stringify({ ok: false, error: "Email is not set up" }), { status: 503 });
      }
      return ok({ sentTo: "x", logged: true });
    }
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderDialog(mode: "reminder" | "statement", onDone = vi.fn(), onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BulkSendDialog open onOpenChange={onOpenChange} mode={mode} rows={ROWS} onDone={onDone} />
    </QueryClientProvider>,
  );
  return { onDone, onOpenChange };
}

const sends = () => st.calls.filter((c) => c.method === "POST" && c.url.endsWith("/email"));

describe("R-2413 bulk Send reminder", () => {
  it("lists recipients and every skipped customer with the reason; reading sends nothing and asks for the standard text", async () => {
    renderDialog("reminder");
    expect(await screen.findByText("accounts@sharma.in")).toBeTruthy();
    expect(screen.getByText("pay@gupta.in")).toBeTruthy();
    expect(screen.getByText(/Will be emailed/).textContent).toMatch(/2 customers/);
    const skipped = screen.getByRole("region", { name: "Skipped" }).textContent ?? "";
    expect(skipped).toMatch(/Promised Ltd — promised to pay on 9 Nov 2026 — reminders paused/);
    expect(skipped).toMatch(/Not Due Co — nothing is late yet/);
    expect(skipped).toMatch(/No Mail Pvt — No email for this customer/);
    /* Drafts were read only for the 3 not skipped by the rule, all with standard: true (no AI). */
    const drafts = st.calls.filter((c) => c.url === "/api/collections/reminder/draft");
    expect(drafts.map((c) => c.body)).toEqual([A, B, E].map((id) => ({ customerId: id, standard: true })));
    expect(sends()).toHaveLength(0);
  });

  it("sends only when the person presses Email — one email per recipient through the reminder route", async () => {
    const { onDone } = renderDialog("reminder");
    fireEvent.click(await screen.findByRole("button", { name: "Email 2 customers" }));
    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends().map((c) => [c.url, c.body?.customerId, c.body?.invoiceId])).toEqual([
      ["/api/collections/reminder/email", A, `INV-${A}`],
      ["/api/collections/reminder/email", B, `INV-${B}`],
    ]);
    expect(sends().every((c) => typeof c.body?.requestId === "string" && /^\d{4}-\d{2}-\d{2}$/.test(String(c.body?.nextFollowUpOn)))).toBe(true);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith([]));
    expect(st.toast.success).toHaveBeenCalledWith("2 reminders emailed");
  });

  it("a failed email stays in the list with why; Send again re-sends only it with the SAME requestId", async () => {
    st.failOnce.add(B);
    const { onDone } = renderDialog("reminder");
    fireEvent.click(await screen.findByRole("button", { name: "Email 2 customers" }));
    const again = await screen.findByRole("button", { name: "Send 1 again" });
    expect(screen.getByText(/Not sent: Email is not set up/)).toBeTruthy();
    /* Only the failed one stays ticked on the page — a new run never re-reads (re-mails) Sharma. */
    expect(onDone).toHaveBeenLastCalledWith([B]);
    const firstId = sends()[1].body?.requestId;
    fireEvent.click(again);
    await waitFor(() => expect(sends()).toHaveLength(3));
    expect(sends()[2].body?.customerId).toBe(B);
    expect(sends()[2].body?.requestId).toBe(firstId);
    await waitFor(() => expect(onDone).toHaveBeenLastCalledWith([]));
  });

  it("emailed but not logged → a warning to log it by hand (not a clean success)", async () => {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (url === "/api/collections/reminder/email"
      ? new Response(JSON.stringify({ ok: true, sentTo: "x", logged: false, warning: "not logged" }), { status: 200 })
      : real(url, init))));
    renderDialog("reminder");
    fireEvent.click(await screen.findByRole("button", { name: "Email 2 customers" }));
    await waitFor(() => expect(st.toast.warning).toHaveBeenCalled());
    expect(st.toast.warning.mock.calls[0][1].description).toMatch(/follow-up was not logged for Sharma Traders, Gupta & Sons — log it with Follow-up, do not send again/);
    expect(st.toast.success).not.toHaveBeenCalled();
  });
});

describe("R-2413 bulk Send statement", () => {
  it("not-due and promised customers get a statement; each goes through the pending-dues email route", async () => {
    renderDialog("statement");
    expect(await screen.findByText("x@p.in")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Email 4 customers" }));
    await waitFor(() => expect(sends()).toHaveLength(4));
    expect(sends().map((c) => c.url)).toEqual([A, B, C, D].map((id) => `/api/customers/${id}/pending-dues/email`));
    expect(screen.queryByText(/Not Due Co — /)).toBeNull();
  });
});
