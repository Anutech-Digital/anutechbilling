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
 */
import { z } from "zod";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import { trustedOrigin } from "@/lib/app-url";
import { istToday } from "@/lib/dates/ist";
import {
  buildReminderContext, emailTarget, payLinkNotice, reminderLineChoices, whatsappTarget,
} from "@/lib/collections/reminder-draft";
import { draftReminder, loadReminderRaw } from "@/lib/collections/reminder-draft.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  customerId: z.string().uuid("Open Remind from a customer row and try again."),
  /** R-2412: the bill picked under "This invoice" (absent → the most overdue one). */
  line: z.object({
    kind: z.enum(["invoice", "subscription"]),
    id: z.string().trim().min(1).max(200),
  }).strict().optional(),
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

    const gemini = await resolveGeminiConfig(supabase, tenantId);
    const draft = await draftReminder(ctx, gemini);
    const wa = whatsappTarget(loaded.customer.phone);
    const em = emailTarget(loaded.customer.email);
    const oldest = ctx.lines[0];

    return {
      subject: draft.subject,
      message: draft.message,
      mode: draft.mode,
      note: draft.note,
      amountDue: ctx.amountDue,
      line: pick,
      lines: reminderLineChoices(all),
      payLink: ctx.payLink,
      payLinkNotice: payLinkNotice(ctx),
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
