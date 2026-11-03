/**
 * POST /api/collections/reminder/draft — R-1518 "Remind": draft ONE payment reminder for one
 * customer. Returns text only; it sends nothing (R-1514: a human sends every reminder).
 *
 *   • Gate: the roles that can open /collections, like the follow-up route.
 *   • The body carries only the customer id. The balance, links, promise and contact are read
 *     here on the caller's session (RLS), so the draft states what the books say — not what the
 *     browser sent.
 *   • Gemini via resolveGeminiConfig / geminiJson; no key or a bad answer → the plain template
 *     (lib/collections/reminder-draft.server.ts). Every amount is checked by the money guard.
 *   • Also returns where it can go: the WhatsApp number or why not, the email or why not, and
 *     what the follow-up should be about (the oldest bill).
 *   • R-2412 "Send reminder → This invoice": the reminder is about ONE open bill — `line` from
 *     the picker, else the most overdue one. Its amount and its UPI pay link only; `lines` lists
 *     every open bill for the picker, `payLinkNotice` says why there is no link and the fix (§24).
 *     A bill that is no longer open → 409 (never another bill's money).
 *   • R-2413 bulk "Send reminder": `standard: true` drafts the plain template (no AI call), so
 *     ticking 20 customers does not make 20 AI calls; every amount still comes from the books.
 *   • R-2415: the bill's ONE Razorpay pay link (card / UPI / net banking) goes into the message
 *     next to the UPI link — made on the first Send reminder, the same link on every later one,
 *     replaced when the amount changes (lib/payments/payment-link.server). `cardLink` says what it
 *     asks for; `cardLinkNotice` says why there is none and the fix (§24). Razorpay sends nothing.
 */
import { z } from "zod";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import { trustedOrigin } from "@/lib/app-url";
import { istToday } from "@/lib/dates/ist";
import {
  buildReminderContext, buildReminderTemplate, emailTarget, payLinkNotice, reminderLineChoices, whatsappTarget,
} from "@/lib/collections/reminder-draft";
import { draftReminder, loadReminderRaw } from "@/lib/collections/reminder-draft.server";
import { withCardPayLink } from "@/lib/payments/payment-link";
import { getOrCreateInvoicePayLink } from "@/lib/payments/payment-link.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  customerId: z.string().uuid("Open Remind from a customer row and try again."),
  /** R-2412: the bill picked under "This invoice" (absent → the most overdue one). */
  line: z.object({
    kind: z.enum(["invoice", "subscription"]),
    id: z.string().trim().min(1).max(200),
  }).strict().optional(),
  /** R-2413 bulk Send reminder: the plain template (no AI call) — one standard wording for many customers. */
  standard: z.boolean().optional(),
}).strict("Only the customer may be sent — reload the page and try again.");

export const POST = withRoute(
  {
    route: "api/collections/reminder/draft",
    input: bodySchema,
    pages: ["/collections"],
    roleHint: "Your role cannot draft payment reminders. Ask your manager to give you access to Payment Follow-up.",
  },
  async ({ req, supabase, input, tenantId }) => {
    let loaded: Awaited<ReturnType<typeof loadReminderRaw>>;
    try {
      loaded = await loadReminderRaw(supabase, { customerId: input.customerId, tenantId, origin: trustedOrigin(req.headers) });
    } catch (e) {
      const detail = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      throw new RouteError(500, "Could not read this customer's bills — reload the page and press Remind again.", detail);
    }
    if (!loaded) {
      throw new RouteError(404, "This customer is not in your list any more — reload Payment Follow-up and pick them again.");
    }

    const today = istToday();
    const all = buildReminderContext(loaded.raw, today);
    if (all.amountDue <= 0) {
      throw new RouteError(409, "This customer owes nothing now — there is nothing to remind them about. Reload the list.");
    }
    const pick = input.line ?? { kind: all.lines[0].kind, id: all.lines[0].id };
    const ctx = buildReminderContext(loaded.raw, today, pick);
    if (ctx.amountDue <= 0) {
      throw new RouteError(409, "That bill is paid or closed now — pick another bill in the list, or choose Full statement.");
    }

    /* R-2413: a bulk send uses the standard wording — no AI call per customer. */
    const draft = input.standard
      ? { ...buildReminderTemplate(ctx), mode: "template" as const, note: null }
      : await draftReminder(ctx, await resolveGeminiConfig(supabase, tenantId));
    /* R-2415: the Razorpay link for exactly this bill — reused while its amount is unchanged. */
    const card = await getOrCreateInvoicePayLink({
      tenantId,
      customerId: input.customerId,
      scope: "invoice",
      lines: ctx.lines.map((l) => ({ kind: l.kind, id: l.id, amountDue: l.amountDue })),
      sellerName: ctx.sellerName,
      customerName: loaded.customer.customerName,
      customerEmail: loaded.customer.email,
      customerPhone: loaded.customer.phone,
    });
    const message = card.link ? withCardPayLink(draft.message, card.link.url) : draft.message;
    const wa = whatsappTarget(loaded.customer.phone);
    const em = emailTarget(loaded.customer.email);
    const oldest = ctx.lines[0];

    return {
      subject: draft.subject,
      message,
      mode: draft.mode,
      note: draft.note,
      amountDue: ctx.amountDue,
      line: pick,
      lines: reminderLineChoices(all),
      payLink: ctx.payLink,
      payLinkNotice: payLinkNotice(ctx),
      cardLink: card.link,
      cardLinkNotice: card.notice,
      whatsapp: wa.ok ? wa.to : null,
      whatsappBlocked: wa.ok ? null : wa.reason,
      email: em.ok ? em.to : null,
      emailBlocked: em.ok ? null : em.reason,
      about: {
        invoiceId: oldest?.kind === "invoice" ? oldest.id : null,
        subscriptionId: oldest?.kind === "subscription" ? oldest.id : null,
        quoteId: oldest?.quoteId ?? null,
      },
    };
  },
);
