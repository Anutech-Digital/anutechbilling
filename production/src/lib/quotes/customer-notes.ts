/**
 * R-813 — what the CUSTOMER may read of a quote's notes.
 *
 * Staging, 10 Oct 2026: add-seats quote Q-5F40-27-0012 showed the customer "Add-seats
 * pro-rata for subscription c28000ac-… (backdated by Pardeep Sharma on 2026-10-10) …
 * (factor 99.7260%)" — on the accept page, the PDF and so the email attachment. A
 * subscription UUID, a staff member's action and our pro-rata arithmetic are staff facts.
 *
 * quotes has no internal-notes column, so `notes` holds both, in two parts:
 *
 *   <customer line>
 *
 *   Staff only (not shown to the customer):
 *   <audit text>
 *
 * Staff screens show the whole field (the audit stays where staff look for it). Every
 * customer surface — accept page, QuotePDF (email / WhatsApp / download), the staff
 * "preview as customer" dialog — renders customerQuoteNotes() instead, which cuts at the
 * marker. Quotes stored BEFORE this change hold only the audit text; they are not
 * rewritten — the old add-seats pattern is recognised on display and replaced by the
 * same plain line a new quote would carry.
 */
import { formatIstDate } from "@/lib/dates/ist";
import { extensionTitle, monthsWords, quoteServicePeriod } from "@/lib/quotes/service-period";

/** Everything after this line in quotes.notes is staff-only. */
export const STAFF_NOTE_MARKER = "Staff only (not shown to the customer):";

/** The audit text every add-seats quote was written with before R-813 (since May 2026). */
const LEGACY_ADD_SEATS = /^\s*Add-seats pro-rata for subscription\b/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "Additional seats from 25 Sep 2026 to 31 Mar 2027 (pro-rata)." */
export function addSeatsCustomerNote(from: string | null | undefined, to: string | null | undefined): string {
  const f = from && ISO_DAY.test(from.slice(0, 10)) ? formatIstDate(from.slice(0, 10)) : null;
  const t = to && ISO_DAY.test(to.slice(0, 10)) ? formatIstDate(to.slice(0, 10)) : null;
  if (f && t) return `Additional seats from ${f} to ${t} (pro-rata).`;
  if (f)      return `Additional seats from ${f} (pro-rata).`;
  return "Additional seats, charged pro-rata for the rest of the term.";
}

/** The stored field for a new quote: the customer line, then the staff-only audit. */
export function composeQuoteNotes(customerLine: string, staffAudit: string): string {
  return `${customerLine.trim()}\n\n${STAFF_NOTE_MARKER}\n${staffAudit.trim()}`;
}

/** The staff-only part of a stored note ("" when there is none), for staff screens. */
export function staffQuoteNotes(notes: string | null | undefined): string {
  if (!notes) return "";
  const at = notes.indexOf(STAFF_NOTE_MARKER);
  if (at >= 0) return notes.slice(at + STAFF_NOTE_MARKER.length).trim();
  return LEGACY_ADD_SEATS.test(notes) ? notes.trim() : "";
}

/* ── R-817: renewal / extension quotes ──────────────────────────────────────────────────────
   The app writes these notes itself, and they name the subscription by its internal id:
     create-renewal-quote.ts     "Renewal quote for subscription <uuid>"
     cron/renewals/route.ts      "Auto-generated renewal quote for subscription <uuid>"
     generate-renewal-quote      "Renewal quote (operator-generated) for subscription <uuid>"
     create-extension-quote.ts   "3-month extension for subscription <uuid>. On payment the renewal
                                  date advances by 3 months (to 30 Jun 2027)."
     domains/renewal.ts          "Domain renewal for x.in (subscription <uuid>), at ResellerClub's
                                  live renewal price of ₹799 + GST."
   The STORED text stays exactly as written — renewals/open-renewal-quotes.ts reads
   "subscription <uuid>" back out of it to find a subscription's open quote. Only what the
   customer reads changes: the system sentence becomes a plain line, anything a staff member
   typed after it is kept, and every UUID / staff-only phrase is scrubbed as a last guard. */

const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SYS_RENEWAL = new RegExp(
  `^\\s*(?:Auto-generated renewal quote|Renewal quote(?: \\(operator-generated\\))?) for subscription ${UUID_SRC}\\.?`, "i");
const SYS_EXTENSION = new RegExp(
  `^\\s*(\\d{1,3})-(year|month) extension for subscription ${UUID_SRC}\\.?` +
  `(?:\\s*On payment the renewal date advances by [^.(]*?(?:\\s*\\(to ([^)]+)\\))?\\.)?`, "i");
const SYS_DOMAIN = new RegExp(
  `^\\s*Domain renewal for (\\S+?) \\(subscription ${UUID_SRC}\\)(?:,\\s*at .*?\\+\\s*GST)?\\.?`, "i");
const HAS_UUID = new RegExp(UUID_SRC, "i");
/** Sentences that are staff arithmetic or a staff member's action, never customer copy. */
const STAFF_PHRASE = /backdated by|\bfactor\s+[\d.]+%?|\bsubscription id\b/i;

export interface CustomerNoteContext {
  /** quotes.plan — what a renewal renews. */
  plan?: string | null;
  /** quotes.extension_months — the months record_payment rolls the subscription by. */
  extensionMonths?: number | null;
}

type NoteLine = { name?: string | null; commitment?: string | null };

/** "12 months" from extension_months, else from the lines' commitment; null when unknown. */
function renewalPeriodWords(lineItems: ReadonlyArray<NoteLine>, months: number | null | undefined): string | null {
  if (typeof months === "number" && Number.isInteger(months) && months > 0) return monthsWords(months);
  const p = quoteServicePeriod({
    lines: lineItems.map((l) => ({ name: l.name ?? null, commitment: l.commitment ?? null })),
  });
  return p?.kind === "months" ? monthsWords(p.months) : null;
}

/** "Renewal of Google Workspace Business Starter for 12 months." / "Renewal for the next term." */
export function renewalCustomerNote(plan: string | null | undefined, period: string | null | undefined): string {
  const what = plan && plan.trim() && !HAS_UUID.test(plan) ? plan.trim() : null;
  const span = period ?? "the next term";
  return what ? `Renewal of ${what} for ${span}.` : `Renewal for ${span}.`;
}

/** "3-month extension. Your renewal date moves to 30 Jun 2027." */
export function extensionCustomerNote(months: number, newEnd: string | null | undefined): string {
  const t = extensionTitle({ isExtension: true, extensionMonths: months }) ?? "extension";
  const title = `${t[0].toUpperCase()}${t.slice(1)}`;
  return newEnd?.trim() ? `${title}. Your renewal date moves to ${newEnd.trim()}.` : `${title} of your subscription.`;
}

/** Last guard on anything a customer reads: no internal id, no staff-only sentence. */
export function scrubCustomerText(text: string): string {
  const lines = text.split("\n").map((line) => {
    const cleaned = line
      .replace(new RegExp(`\\s*\\(\\s*subscription(?:\\s+id)?[:\\s]+${UUID_SRC}\\s*\\)`, "gi"), "")
      .replace(new RegExp(`\\s*\\bfor\\s+subscription(?:\\s+id)?[:\\s]+${UUID_SRC}`, "gi"), "")
      .replace(new RegExp(`\\s*\\bsubscription(?:\\s+id)?[:\\s]+${UUID_SRC}`, "gi"), "")
      .replace(new RegExp(UUID_SRC, "gi"), "")
      .replace(/[ \t]+([.,;:])/g, "$1");
    return cleaned
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !STAFF_PHRASE.test(sentence))
      .join(" ")
      .trimEnd();
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The plain line for a system-written renewal / extension note, plus what follows it. */
function renewalOrExtensionNote(
  visible: string,
  lineItems: ReadonlyArray<NoteLine>,
  ctx: CustomerNoteContext | undefined,
): { line: string; rest: string } | null {
  let m = SYS_EXTENSION.exec(visible);
  if (m) {
    const months = Number(m[1]) * (m[2].toLowerCase() === "year" ? 12 : 1);
    return { line: extensionCustomerNote(months, m[3] ?? null), rest: visible.slice(m[0].length) };
  }
  m = SYS_DOMAIN.exec(visible);
  if (m) {
    return {
      line: renewalCustomerNote(m[1], renewalPeriodWords(lineItems, ctx?.extensionMonths)),
      rest: visible.slice(m[0].length),
    };
  }
  m = SYS_RENEWAL.exec(visible);
  if (m) {
    const plan = ctx?.plan ?? (lineItems.length === 1 ? lineItems[0].name : null);
    return {
      line: renewalCustomerNote(plan, renewalPeriodWords(lineItems, ctx?.extensionMonths)),
      rest: visible.slice(m[0].length),
    };
  }
  return null;
}

/**
 * The notes a customer may see, or null for none.
 *
 * `lineItems` lets an OLD add-seats note name its end date: the audit text never carried
 * it, but the line does — "(pro-rata from 2026-09-25 to 2027-03-31)". For a renewal it
 * names the plan and the term when `ctx` does not (R-817).
 */
export function customerQuoteNotes(
  notes: string | null | undefined,
  lineItems?: ReadonlyArray<NoteLine> | null,
  ctx?: CustomerNoteContext,
): string | null {
  if (!notes) return null;
  const at = notes.indexOf(STAFF_NOTE_MARKER);
  const visible = (at >= 0 ? notes.slice(0, at) : notes).trim();
  if (!visible) return null;
  if (!LEGACY_ADD_SEATS.test(visible)) {
    const sys = renewalOrExtensionNote(visible, lineItems ?? [], ctx);
    if (!sys) return scrubCustomerText(visible) || null;
    const rest = scrubCustomerText(sys.rest);
    if (!rest) return sys.line;
    return `${sys.line}${/^[ \t]*\n/.test(sys.rest) ? "\n" : " "}${rest}`;
  }

  /* An old add-seats note is ALL audit text — none of it was written for the customer. */
  const from = /Effective date (\d{4}-\d{2}-\d{2})/.exec(visible)?.[1]
    ?? /pro-rata from (\d{4}-\d{2}-\d{2})/.exec((lineItems ?? []).map((l) => l.name ?? "").join(" "))?.[1]
    ?? null;
  let to: string | null = null;
  for (const l of lineItems ?? []) {
    const m = /\bto (\d{4}-\d{2}-\d{2})\)/.exec(l.name ?? "");
    if (m && (!to || m[1] > to)) to = m[1];
  }
  return addSeatsCustomerNote(from, to);
}
