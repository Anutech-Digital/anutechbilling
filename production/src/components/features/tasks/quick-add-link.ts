/**
 * R-471 (via R-486) — quick add suggests WHO the task is about.
 *
 * "Email Vikas Monday 11 AM" saved a task linked to nobody, though Vikas is a lead
 * (Bansal). Now the bar takes the name out of the title, looks it up among leads and
 * customers, and offers the match as a link — pre-selected only when exactly one matches.
 * Pure: the lists are passed in.
 */

/** Words that are never the person: the task verbs and common fillers. */
const STOP = new Set([
  "call", "phone", "ring", "email", "e-mail", "mail", "meet", "meeting", "demo", "visit", "whatsapp",
  "follow", "followup", "follow-up", "up", "with", "to", "for", "about", "re", "regarding", "and",
  "send", "share", "check", "remind", "reminder", "ask", "the", "a", "an", "on", "at", "of",
  "quote", "invoice", "payment", "renewal", "proposal", "details", "pricing", "price", "today", "tomorrow",
]);

/** The first name-like word of the title (letters, 3+), else null. */
export function quickAddNameGuess(title: string): string | null {
  for (const raw of title.split(/[\s,()/]+/)) {
    const w = raw.replace(/[^A-Za-zऀ-ॿ.'-]/g, "");
    if (w.length < 3) continue;
    if (STOP.has(w.toLowerCase())) continue;
    return w;
  }
  return null;
}

export interface QuickAddLink { kind: "lead" | "customer"; id: string; label: string }

const startsWord = (text: string | null | undefined, name: string) =>
  !!text && text.toLowerCase().split(/[\s,()/.-]+/).some((w) => w.startsWith(name.toLowerCase()));

/** Leads first, then customers, whose contact or company has a word starting with `name`. Max 3. */
export function quickAddLinkCandidates(
  name: string | null,
  leads: readonly { id: string; company?: string | null; contact_name?: string | null }[],
  customers: readonly { id: string; name: string; contact_name?: string | null }[],
): QuickAddLink[] {
  if (!name) return [];
  const out: QuickAddLink[] = [];
  for (const l of leads) {
    if (startsWord(l.contact_name, name) || startsWord(l.company, name)) {
      const label = [l.contact_name, l.company].filter(Boolean).join(" · ") || "Lead";
      out.push({ kind: "lead", id: l.id, label });
    }
  }
  for (const c of customers) {
    if (startsWord(c.contact_name, name) || startsWord(c.name, name)) {
      out.push({ kind: "customer", id: c.id, label: [c.contact_name, c.name].filter(Boolean).join(" · ") });
    }
  }
  return out.slice(0, 3);
}
