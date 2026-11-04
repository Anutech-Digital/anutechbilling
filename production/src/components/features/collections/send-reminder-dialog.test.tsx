// @vitest-environment jsdom
/* R-2412 — ONE "Send reminder" dialog: "This invoice" or "Full statement"; a pay link for the right
   amount in the message (or why not + the fix); WhatsApp first, email fallback; opening, switching
   the choice or picking a bill only drafts / reads — nothing is sent until a person presses. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const CUST = "44444444-4444-4444-8444-444444444444";
const UPI_ONE = "upi://pay?pa=anutech%40hdfcbank&pn=Anutech&am=68000&cu=INR&tn=Invoice+INV-101";
const UPI_TWO = "upi://pay?pa=anutech%40hdfcbank&pn=Anutech&am=5900&cu=INR&tn=Invoice+INV-105";
const UPI_ALL = "upi://pay?pa=anutech%40hdfcbank&pn=Anutech&am=73900&cu=INR&tn=Dues+Sharma+Traders";

const st = vi.hoisted(() => ({
  mutate: vi.fn(),
  phone: "919876543210" as string | null,
  upi: true,
  calls: [] as { url: string; method: string; body: Record<string, unknown> | null }[],
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/queries/payment-followups", () => ({
  followupsKey: (id: string) => ["payment-followups", id],
  useAddFollowup: () => ({ mutate: st.mutate, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SendReminderDialog } from "./send-reminder-dialog";
import { ReminderDialog } from "./reminder-dialog";
import { PendingDuesDialog } from "./pending-dues-dialog";

const LINES = [
  { kind: "invoice", id: "INV-101", label: "INV-101", amountDue: 68000, daysOverdue: 12 },
  { kind: "invoice", id: "INV-105", label: "INV-105", amountDue: 5900, daysOverdue: 0 },
];

const draftFor = (lineId: string) => {
  const one = lineId === "INV-105";
  const amount = one ? 5900 : 68000;
  const link = st.upi ? (one ? UPI_TWO : UPI_ONE) : null;
  const first = `Hi Rahul, a gentle reminder from Anutech: ₹${one ? "5,900" : "68,000"} is pending for Sharma Traders.`;
  return {
    ok: true, subject: `Payment reminder: ₹${one ? "5,900" : "68,000"} pending`,
    message: `${first}\n\n• Invoice ${lineId}${link ? `\n\nPay by UPI (open on your phone): ${link}` : ""}`,
    mode: "gemini", note: null, amountDue: amount,
    line: { kind: "invoice", id: lineId }, lines: LINES,
    payLink: link,
    payLinkNotice: link ? null : { reason: "no-upi", text: "No pay link in this message — add your UPI ID in Settings and the message will carry a UPI pay link for the amount.", action: { label: "Open Settings", href: "/settings?tab=company#payment-details" } },
    whatsapp: st.phone, whatsappBlocked: st.phone ? null : "No mobile number for this customer — add one to the primary contact on the customer page to send on WhatsApp.",
    email: "accounts@sharma.in", emailBlocked: null,
    about: { invoiceId: lineId, subscriptionId: null, quoteId: null },
  };
};

const preview = () => ({
  ok: true, customerName: "Sharma Traders", asOn: "2026-11-03",
  lines: [
    { kind: "invoice", id: "INV-101", label: "INV-101", quoteId: null, date: "2026-09-20", dueDate: "2026-10-05", daysOverdue: 29, amountDue: 68000 },
    { kind: "invoice", id: "INV-105", label: "INV-105", quoteId: null, date: "2026-10-10", dueDate: "2026-11-09", daysOverdue: 0, amountDue: 5900 },
  ],
  total: 73900, qrNotice: null, hasBank: true,
  subject: "Statement of pending dues: ₹73,900",
  emailText: `Hi Rahul, please find attached the statement of pending dues: ₹73,900 across 2 bills.\n\nPay the total by UPI (open on your phone): ${UPI_ALL}`,
  whatsappText: `Hi Rahul, statement of pending dues: ₹73,900 across 2 bills.\n\nPay the total by UPI (open on your phone): ${UPI_ALL}`,
  payLink: UPI_ALL,
  whatsapp: st.phone, whatsappBlocked: null, email: "accounts@sharma.in", emailBlocked: null,
  about: { invoiceId: "INV-101", subscriptionId: null, quoteId: null },
});

beforeEach(() => {
  st.mutate.mockReset();
  st.calls = [];
  st.phone = "919876543210";
  st.upi = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    st.calls.push({ url, method: init?.method ?? "GET", body });
    let json: unknown = { ok: true, sentTo: "accounts@sharma.in", logged: true };
    if (url.endsWith("/reminder/draft")) json = draftFor((body?.line as { id?: string } | undefined)?.id ?? "INV-101");
    else if (url.endsWith("/pending-dues")) json = preview();
    return { ok: true, status: 200, json: async () => json } as unknown as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};
const box = async (contains: string) => {
  let el: HTMLTextAreaElement | null = null;
  await waitFor(() => {
    el = screen.getByLabelText(/Message/) as HTMLTextAreaElement;
    expect(el.value).toContain(contains);
  });
  return el as unknown as HTMLTextAreaElement;
};
const sends = () => st.calls.filter((c) => c.url.endsWith("/email"));
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

describe("Send reminder — one dialog", () => {
  it("offers This invoice and Full statement; This invoice drafts ONE bill with a pay link for its amount, sends nothing", async () => {
    wrap(<SendReminderDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" />);
    expect(screen.getByText("Send reminder · Sharma Traders")).toBeTruthy();
    expect(pressed("This invoice")).toBe("true");
    expect(pressed("Full statement")).toBe("false");
    const msg = await box("₹68,000 is pending");
    expect(msg.value).toContain(UPI_ONE);
    expect(screen.getByText(/Pay link in the message: UPI for/).textContent).toContain("₹68,000");
    expect(screen.getByText("AI draft")).toBeTruthy();
    // WhatsApp first when there is a number.
    expect(pressed("WhatsApp")).toBe("true");
    expect(screen.getByRole("button", { name: "Open WhatsApp" })).toBeTruthy();
    expect(st.calls.map((c) => c.url)).toEqual(["/api/collections/reminder/draft"]);
    expect(st.mutate).not.toHaveBeenCalled();
    expect(sends()).toHaveLength(0);
  });

  it("picking another bill redrafts for THAT bill and its amount — still nothing sent", async () => {
    wrap(<SendReminderDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" />);
    await box("₹68,000");
    fireEvent.click(screen.getByRole("button", { name: /INV-105/ }));
    const msg = await box("₹5,900 is pending");
    expect(msg.value).toContain(UPI_TWO);
    expect(st.calls[1]).toMatchObject({ url: "/api/collections/reminder/draft", body: { customerId: CUST, line: { kind: "invoice", id: "INV-105" } } });
    expect(sends()).toHaveLength(0);
    expect(st.mutate).not.toHaveBeenCalled();
  });

  it("Full statement lists every open bill; the pay link amount = the total; PDF link; nothing sent", async () => {
    wrap(<SendReminderDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" />);
    await box("₹68,000");
    fireEvent.click(screen.getByRole("button", { name: "Full statement" }));
    const msg = await box("₹73,900 across 2 bills");
    expect(msg.value).toContain(UPI_ALL);
    const bills = screen.getByRole("list", { name: "Open bills on the statement" });
    expect(bills.textContent).toContain("INV-101");
    expect(bills.textContent).toContain("INV-105");
    expect(screen.getByText(/Pay link in the message: UPI for/).textContent).toContain("₹73,900");
    expect(screen.getByRole("link", { name: /Open statement PDF/ })).toBeTruthy();
    expect(st.calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "/api/collections/reminder/draft"],
      ["POST", `/api/customers/${CUST}/pending-dues`],   // R-2439: POST makes the link; GET only reads
    ]);
    expect(sends()).toHaveLength(0);
    expect(st.mutate).not.toHaveBeenCalled();
  });

  it("statement by email → the statement email route (PDF attached on the server), only on Send", async () => {
    wrap(<PendingDuesDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" />);
    expect(pressed("Full statement")).toBe("true");
    await box("₹73,900");
    fireEvent.click(screen.getByRole("button", { name: "Email (PDF attached)" }));
    await box("please find attached");
    expect(sends()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0].url).toBe(`/api/customers/${CUST}/pending-dues/email`);
    expect(String(sends()[0].body?.message)).toContain(UPI_ALL);
    expect(sends()[0].body).not.toHaveProperty("to");
  });

  it("no mobile number → email is the fallback channel", async () => {
    st.phone = null;
    wrap(<ReminderDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" />);
    await box("₹68,000");
    expect(pressed("Email")).toBe("true");
    expect(screen.getByRole("button", { name: "Send email" })).toBeTruthy();
  });

  it("no UPI ID → no pay link, the dialog says why with an Open Settings step", async () => {
    st.upi = false;
    wrap(<SendReminderDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" />);
    const msg = await box("₹68,000");
    expect(msg.value).not.toContain("upi://");
    expect(screen.getByText(/No pay link in this message — add your UPI ID in Settings/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Settings" }).getAttribute("href")).toBe("/settings?tab=company#payment-details");
  });

  it("Open WhatsApp → wa.me with the edited text (pay link inside) and the follow-up is about the chosen bill", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    wrap(<SendReminderDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" invoiceId="INV-105" />);
    await box("₹5,900");
    expect(st.calls[0].body).toEqual({ customerId: CUST, line: { kind: "invoice", id: "INV-105" } });
    fireEvent.click(screen.getByRole("button", { name: "Open WhatsApp" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(String(open.mock.calls[0][0]).split("text=")[1])).toContain(UPI_TWO);
    expect(st.mutate.mock.calls[0][0]).toMatchObject({ customerId: CUST, kind: "whatsapp", invoiceId: "INV-105" });
  });
});

/* R-2415 — the bill's / statement's ONE Razorpay link, next to the UPI link. */
describe("Send reminder — Razorpay card / net-banking link (R-2415)", () => {
  const stubWith = (extra: (url: string) => Record<string, unknown>) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      st.calls.push({ url, method: init?.method ?? "GET", body });
      const base = url.endsWith("/reminder/draft") ? draftFor("INV-101") : url.endsWith("/pending-dues") ? preview() : { ok: true };
      return { ok: true, status: 200, json: async () => ({ ...base, ...extra(url) }) } as unknown as Response;
    }));

  it("This invoice: says the link is in the message, for the bill amount, and marks a test key", async () => {
    stubWith(() => ({ cardLink: { url: "https://rzp.io/i/abc", amount: 68000, billAmount: 68000, mode: "test" }, cardLinkNotice: null }));
    wrap(<SendReminderDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" />);
    await box("₹68,000 is pending");
    expect(screen.getByText(/Card \/ UPI \/ net-banking link in the message/).textContent).toContain("₹68,000");
    expect(screen.getByText("Test mode — takes no real money")).toBeTruthy();
    expect(sends()).toHaveLength(0);
  });

  it("Full statement: the link for the total", async () => {
    stubWith((url) => (url.endsWith("/pending-dues")
      ? { cardLink: { url: "https://rzp.io/i/all", amount: 73900, billAmount: 73900, mode: "live" }, cardLinkNotice: null }
      : {}));
    wrap(<SendReminderDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" defaultScope="statement" />);
    await waitFor(() => expect(screen.getByText(/Card \/ UPI \/ net-banking link in the message/).textContent).toContain("₹73,900"));
    expect(screen.queryByText("Test mode — takes no real money")).toBeNull();
  });

  it("no Razorpay link → why, and the step to fix it (§24)", async () => {
    stubWith(() => ({
      cardLink: null,
      cardLinkNotice: { reason: "not_configured", text: "No card / net-banking link — Razorpay is not connected.", action: { label: "Open Settings", href: "/settings?tab=integrations" } },
    }));
    wrap(<SendReminderDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" />);
    await waitFor(() => expect(screen.getByText(/Razorpay is not connected/)).toBeTruthy());
    expect(screen.getByRole("link", { name: "Open Settings" }).getAttribute("href")).toBe("/settings?tab=integrations");
  });
});

/* R-2439: the statement preview is a POST (it makes the Razorpay link). A demo visitor's POSTs
   are all refused by middleware ({demo: true}) — the dialog then READS the statement with GET
   (no link is made for a demo), instead of showing an error. */
describe("Full statement for a demo visitor (R-2439)", () => {
  it("POST refused as demo → falls back to the read-only GET and shows the statement", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      st.calls.push({ url, method, body: null });
      if (method !== "GET") {
        return { ok: false, status: 403, json: async () => ({ ok: false, error: "This is a demo — changes are off.", demo: true }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => preview() } as unknown as Response;
    }));
    wrap(<SendReminderDialog open onOpenChange={() => {}} customerId={CUST} customerName="Sharma Traders" defaultScope="statement" />);
    await box("₹73,900 across 2 bills");
    expect(st.calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", `/api/customers/${CUST}/pending-dues`],
      ["GET", `/api/customers/${CUST}/pending-dues`],
    ]);
  });
});
