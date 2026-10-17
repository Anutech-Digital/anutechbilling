/**
 * R-1518 — the reminder draft: amounts in whole rupees from the books, where it can go, and the
 * template when there is no AI (or the AI names a figure it was not given).
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildReminderContext, buildReminderTemplate, emailTarget, NO_EMAIL, NO_PHONE, reminderAllowedAmounts,
  reminderNote, waMeUrl, whatsappTarget, type ReminderRaw,
} from "./reminder-draft";
import { draftReminder, NOTE_AI_BLOCKED, NOTE_AI_DOWN, NOTE_NO_KEY } from "./reminder-draft.server";

const TODAY = "2026-10-17";

const raw = (over: Partial<ReminderRaw> = {}): ReminderRaw => ({
  customerName: "Sharma Traders",
  contactName: "Rahul",
  sellerName: "Anutech",
  invoices: [
    // ₹1,18,000 invoice, ₹50,000.4 paid → ₹68,000 still due (whole rupees), 12 days late
    { id: "INV-101", amount: 118000, net_payable: 118000, paid_amount: 50000.4, status: "overdue", invoice_date: "2026-09-20", due_date: "2026-10-05", quote_id: "Q-1" },
    // paid → not in the reminder
    { id: "INV-102", amount: 5000, net_payable: 5000, paid_amount: 0, status: "paid", invoice_date: "2026-10-01", due_date: "2026-10-10", quote_id: null },
  ],
  subscriptions: [
    { id: "S-1", plan: "Google Workspace", domain: "sharma.in", quote_id: "Q-2", outstanding_amount: 4500, payment_due_date: "2026-10-15", created_at: null },
    // its quote already has an invoice → the invoice is the claim, not counted twice
    { id: "S-2", plan: "M365", domain: null, quote_id: "Q-1", outstanding_amount: 68000, payment_due_date: null, created_at: "2026-09-01" },
  ],
  invoicedQuoteIds: new Set(["Q-1"]),
  quoteTokens: new Map([["Q-2", "tok_abcdefghijklmnopqrstuvwxyz"]]),
  lastPromise: { promised_on: "2026-10-12", promised_amount: 20000 },
  upiVpa: "anutech@hdfcbank",
  upiPayeeName: null,
  origin: "https://app.example.in",
  ...over,
});

describe("buildReminderContext", () => {
  it("sums what is owed in whole rupees, oldest first, without counting a quote twice", () => {
    const ctx = buildReminderContext(raw(), TODAY);
    expect(ctx.lines.map((l) => [l.id, l.amountDue, l.daysOverdue])).toEqual([
      ["INV-101", 68000, 12],
      ["S-1", 4500, 2],
    ]);
    expect(ctx.amountDue).toBe(72500);
    expect(ctx.daysOverdue).toBe(12);
    expect(ctx.lastPromise).toEqual({ on: "2026-10-12", amount: 20000, broken: true });
  });

  it("links the quote's public page only when it has a token and the app has an origin", () => {
    expect(buildReminderContext(raw(), TODAY).lines[1].link).toBe("https://app.example.in/quote/Q-2/accept?t=tok_abcdefghijklmnopqrstuvwxyz");
    expect(buildReminderContext(raw({ origin: null }), TODAY).lines[1].link).toBeNull();
    expect(buildReminderContext(raw(), TODAY).lines[0].link).toBeNull();   // Q-1 has no token
  });

  it("UPI pay link for the whole balance only when the company has a UPI id", () => {
    expect(buildReminderContext(raw(), TODAY).payLink).toContain("am=72500");
    expect(buildReminderContext(raw({ upiVpa: null }), TODAY).payLink).toBeNull();
  });
});

describe("the plain template", () => {
  const t = buildReminderTemplate(buildReminderContext(raw(), TODAY));

  it("states the amounts with rupee() — whole rupees, Indian grouping", () => {
    expect(t.message.split("\n")[0]).toBe("Hi Rahul, a gentle reminder from Anutech: ₹72,500 is pending for Sharma Traders, 12 days overdue.");
    expect(t.message).toContain("• Invoice INV-101: ₹68,000");
    expect(t.message).toContain("• Google Workspace · sharma.in: ₹4,500");
    expect(t.message).toMatch(/You had mentioned paying ₹20,000 by/);
    expect(t.message).toContain("Pay by UPI (open on your phone): upi://pay?");
    expect(t.message).toMatch(/— Anutech team$/);
    expect(t.subject).toBe("Payment reminder: ₹72,500 pending — Sharma Traders");
    expect(t.message).not.toMatch(/\.\d{2}\b/);   // no paise
  });

  it("names only figures the money guard allows", () => {
    const ctx = buildReminderContext(raw(), TODAY);
    expect(reminderAllowedAmounts(ctx).sort((a, b) => a - b)).toEqual([4500, 20000, 68000, 72500]);
  });
});

describe("where it can go", () => {
  it("missing or short phone → WhatsApp off, with the reason and the fix", () => {
    expect(whatsappTarget(null)).toEqual({ ok: false, reason: NO_PHONE });
    expect(whatsappTarget("12345")).toEqual({ ok: false, reason: NO_PHONE });
    expect(NO_PHONE).toMatch(/customer page/);
  });

  it("an Indian mobile becomes 91 + 10 digits for wa.me", () => {
    expect(whatsappTarget("098765 43210")).toEqual({ ok: true, to: "919876543210" });
    expect(whatsappTarget("+91 98765-43210")).toEqual({ ok: true, to: "919876543210" });
  });

  it("missing email → email off with the reason", () => {
    expect(emailTarget("")).toEqual({ ok: false, reason: NO_EMAIL });
    expect(emailTarget("not-an-email")).toEqual({ ok: false, reason: NO_EMAIL });
    expect(emailTarget(" accounts@sharma.in ")).toEqual({ ok: true, to: "accounts@sharma.in" });
  });

  it("wa.me carries the edited text, encoded", () => {
    expect(waMeUrl("919876543210", "Hi ₹72,500 & more")).toBe(`https://wa.me/919876543210?text=${encodeURIComponent("Hi ₹72,500 & more")}`);
  });

  it("the follow-up note is the first non-empty line", () => {
    expect(reminderNote("\n  Hi Rahul, ₹72,500 pending.\n\nmore")).toBe("Hi Rahul, ₹72,500 pending.");
    expect(reminderNote("x".repeat(400))).toHaveLength(300);
  });
});

describe("draftReminder", () => {
  const ctx = buildReminderContext(raw(), TODAY);

  it("no Gemini key → the template, and the AI is never called", async () => {
    const ai = vi.fn();
    const d = await draftReminder(ctx, { apiKey: null, model: "m" }, ai);
    expect(ai).not.toHaveBeenCalled();
    expect(d).toEqual({ ...buildReminderTemplate(ctx), mode: "template", note: NOTE_NO_KEY });
  });

  it("the AI does not answer → the template, saying so", async () => {
    const d = await draftReminder(ctx, { apiKey: "k", model: "m" }, vi.fn().mockResolvedValue(null));
    expect(d.mode).toBe("template");
    expect(d.note).toBe(NOTE_AI_DOWN);
  });

  it("an AI draft that names an amount not on the bills is thrown away", async () => {
    const ai = vi.fn().mockResolvedValue({ subject: "Reminder", message: "Hi Rahul, ₹7,25,000 is pending." });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = await draftReminder(ctx, { apiKey: "k", model: "m" }, ai);
    spy.mockRestore();
    expect(d.mode).toBe("template");
    expect(d.note).toBe(NOTE_AI_BLOCKED);
    expect(d.message).toContain("₹72,500");
  });

  it("a clean AI draft is returned as written, with the facts in the prompt", async () => {
    const ai = vi.fn().mockResolvedValue({ subject: "Payment due", message: "Hi Rahul, gentle reminder: ₹72,500 pending (12 days)." });
    const d = await draftReminder(ctx, { apiKey: "k", model: "m" }, ai);
    expect(d).toEqual({ subject: "Payment due", message: "Hi Rahul, gentle reminder: ₹72,500 pending (12 days).", mode: "gemini", note: null });
    const args = ai.mock.calls[0][0] as { user: string; system: string };
    expect(args.user).toContain("Total pending: ₹72,500");
    expect(args.user).toContain("date passed, NOT paid");
    expect(args.system).toMatch(/never invent/);
  });
});
