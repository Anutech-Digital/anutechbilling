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

const nameWord = (raw: string) => raw.replace(/[^A-Za-zऀ-ॿ.'-]/g, "");
const isNameWord = (w: string) => w.length >= 3 && !STOP.has(w.toLowerCase());

/** The first name-like word of the title (letters, 3+), else null. */
export function quickAddNameGuess(title: string): string | null {
  for (const raw of title.split(/[\s,()/]+/)) {
    const w = nameWord(raw);
    if (isNameWord(w)) return w;
  }
  return null;
}

/**
 * R-445: the word right after the first name ("Call Rohit Gupta" → "Gupta"), else null.
 * Used only to narrow several first-name matches — never to find new ones.
 */
export function quickAddSurnameGuess(title: string): string | null {
  const words = title.split(/[\s,()/]+/).map(nameWord);
  const i = words.findIndex(isNameWord);
  const next = i >= 0 ? words[i + 1] : undefined;
  return next && isNameWord(next) ? next : null;
}

export interface QuickAddLink { kind: "lead" | "customer"; id: string; label: string }

const startsWord = (text: string | null | undefined, name: string) =>
  !!text && text.toLowerCase().split(/[\s,()/.-]+/).some((w) => w.startsWith(name.toLowerCase()));

/**
 * Leads first, then customers, whose contact or company has a word starting with `name`. Max 3.
 * R-445: with a `surname` ("Rohit Gupta"), matches that also have the surname win — two
 * Rohits become one Rohit Gupta, which is then linked by default. No surname match → all
 * first-name matches stay and the user picks.
 */
export function quickAddLinkCandidates(
  name: string | null,
  leads: readonly { id: string; company?: string | null; contact_name?: string | null }[],
  customers: readonly { id: string; name: string; contact_name?: string | null }[],
  surname: string | null = null,
): QuickAddLink[] {
  if (!name) return [];
  const out: { link: QuickAddLink; full: boolean }[] = [];
  const hasSurname = (...texts: (string | null | undefined)[]) =>
    !!surname && texts.some((t) => startsWord(t, surname));
  for (const l of leads) {
    if (startsWord(l.contact_name, name) || startsWord(l.company, name)) {
      const label = [l.contact_name, l.company].filter(Boolean).join(" · ") || "Lead";
      out.push({ link: { kind: "lead", id: l.id, label }, full: hasSurname(l.contact_name, l.company) });
    }
  }
  for (const c of customers) {
    if (startsWord(c.contact_name, name) || startsWord(c.name, name)) {
      const label = [c.contact_name, c.name].filter(Boolean).join(" · ");
      out.push({ link: { kind: "customer", id: c.id, label }, full: hasSurname(c.contact_name, c.name) });
    }
  }
  const narrowed = out.some((c) => c.full) ? out.filter((c) => c.full) : out;
  return narrowed.slice(0, 3).map((c) => c.link);
}
