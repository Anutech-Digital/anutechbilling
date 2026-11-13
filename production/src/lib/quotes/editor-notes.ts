/**
 * R-2754 — what the quote editor's "Notes for customer" box holds.
 *
 * User audit, 14 Nov 2026: Renewals → "Review renewal quote" opened the editor with the box
 * reading "Renewal quote (operator-generated) for subscription c2458000-…" under the hint
 * "Shown on customer-facing quote PDF". The PDF never showed it (customer-notes.ts scrubs it),
 * but the owner reading the box believes the customer gets a UUID — and may delete the line,
 * which is how the Renewals page finds the quote again (renewals/open-renewal-quotes.ts reads
 * "subscription <id>" out of quotes.notes).
 *
 * So the box shows exactly what the customer reads (customerQuoteNotes), and everything
 * else in the stored field — the system sentence and the "Staff only" part — is held back
 * and stored again on save:
 *   - notes not edited      → the stored field is saved back byte for byte (no data rewrite);
 *   - notes edited          → "<what was typed>\n\nStaff only (not shown to the customer):\n<held back>",
 *                             so the subscription id stays in the field and the link holds.
 * A note with nothing to hold back (a normal quote) behaves exactly as before.
 */
import {
  STAFF_NOTE_MARKER,
  STAFF_PHRASE,
  customerQuoteNotes,
  staffDisplayNotes,
  systemNoteLead,
  type CustomerNoteContext,
} from "@/lib/quotes/customer-notes";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface EditorNotes {
  /** What the "Notes for customer" box starts with — what the customer reads. */
  customer: string;
  /** Staff-only text held out of the box ("" when none) — stored again on save. */
  hidden: string;
  /** The stored field as loaded ("" when none). */
  original: string;
}

type NoteLine = { name?: string | null; commitment?: string | null };

/** Split a stored quotes.notes into the editor's box and the part kept out of it. */
export function splitNotesForEditor(
  notes: string | null | undefined,
  lineItems?: ReadonlyArray<NoteLine> | null,
  ctx?: CustomerNoteContext,
): EditorNotes {
  const original = notes ?? "";
  if (!original.trim()) return { customer: "", hidden: "", original };

  const at = original.indexOf(STAFF_NOTE_MARKER);
  const visible = (at >= 0 ? original.slice(0, at) : original).trim();
  const staff = at >= 0 ? original.slice(at + STAFF_NOTE_MARKER.length).trim() : "";
  const lead = systemNoteLead(visible);

  /* Every sentence after the system lead that the customer never sees (customerQuoteNotes
     scrubs it: an internal id, "backdated by …", "factor …%") is held back VERBATIM — so an
     edit of the box never deletes staff text, and a hand-typed "subscription <id>" keeps
     exactly the form it had (no new link is invented). */
  const rest = lead ? visible.slice(visible.indexOf(lead) + lead.length) : visible;
  const scrubbed = rest
    .split("\n")
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s && (UUID.test(s) || STAFF_PHRASE.test(s)));
  const hidden = [lead, ...scrubbed, staff].filter((p): p is string => !!p).join("\n");

  if (!hidden) return { customer: original, hidden: "", original };
  return { customer: customerQuoteNotes(original, lineItems, ctx) ?? "", hidden, original };
}

/** The quotes.notes to store for what the box holds now; null for none. */
export function joinEditorNotes(parts: EditorNotes, boxText: string): string | null {
  if (!parts.hidden) return boxText || null;
  /* Untouched → the stored field exactly as it was (existing quotes are never rewritten). */
  if (boxText.trim() === parts.customer.trim()) return parts.original || null;
  const line = boxText.trim();
  return line
    ? `${line}\n\n${STAFF_NOTE_MARKER}\n${parts.hidden}`
    : `${STAFF_NOTE_MARKER}\n${parts.hidden}`;
}

/** The held-back part as staff may read it under the box — ids taken out; "" for none. */
export function editorStaffNote(parts: EditorNotes): string {
  return parts.hidden ? staffDisplayNotes(parts.hidden) : "";
}
