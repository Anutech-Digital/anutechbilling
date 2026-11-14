/* R-2768 — Repair B (owner-approved 14 Nov 2026): old quotes whose stored notes carry an internal
   subscription id in the CUSTOMER part are rewritten, by SQL (public.r2768_repaired_notes, migration
   20261114043932), into the shape the quote editor saves on an edit (R-2754 editor-notes.ts):
     <what the customer reads>\n\nStaff only (not shown to the customer):\n<held back>

   PARITY: the case list lives ONCE, in supabase/tests/r2768_repair.test.sql (R2768-NOTES-CASES), which
   asserts the SQL side; this file reads the same list and asserts the TypeScript side — so the SQL port
   and the editor's own rules cannot drift silently. It also proves, per case, what the repair is for:
   the stored field after the repair shows the customer no id on every customer surface, the editor box
   opens on the same customer text, and the Renewals page still finds the quote. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitNotesForEditor } from "./editor-notes";
import { customerQuoteNotes, STAFF_NOTE_MARKER } from "./customer-notes";
import { openRenewalQuoteMap } from "@/app/(app)/renewals/open-renewal-quotes";

interface NotesCase {
  name: string;
  notes: string;
  lines: Array<{ name?: string | null; commitment?: string | null }> | null;
  plan: string | null;
  ext: number | null;
  expect: string | null;
}

function cases(): NotesCase[] {
  const sql = readFileSync(join(process.cwd(), "supabase/tests/r2768_repair.test.sql"), "utf8");
  const start = sql.indexOf("$cases$[");
  const end = sql.indexOf("]$cases$");
  if (start < 0 || end < start) throw new Error("R2768 notes cases not found in the SQL test");
  return JSON.parse(sql.slice(start + "$cases$".length, end + 1)) as NotesCase[];
}

/** What the editor stores when its box holds what the customer reads (joinEditorNotes on an edit). */
function editorSaved(c: NotesCase): string | null {
  const lines = Array.isArray(c.lines) ? c.lines : [];
  const parts = splitNotesForEditor(c.notes, lines, { plan: c.plan ?? null, extensionMonths: c.ext ?? null });
  if (!parts.hidden) return null;
  const line = parts.customer.trim();
  return line ? `${line}\n\n${STAFF_NOTE_MARKER}\n${parts.hidden}` : `${STAFF_NOTE_MARKER}\n${parts.hidden}`;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SUB_IN_NOTES = /subscription ([0-9a-fA-F-]{36})/; // seat-quotes-pending.ts / tg_quotes_add_seats_take_back

describe("R-2768 notes parity — SQL r2768_repaired_notes = the editor's own save, on the SQL test's cases", () => {
  const list = cases();
  it("reads the shared case list", () => {
    expect(list.length).toBeGreaterThanOrEqual(30);
  });
  for (const c of list) {
    it(c.name, () => {
      expect(editorSaved(c)).toBe(c.expect);
    });
  }
});

describe("R-2768 notes — what the repaired field does", () => {
  const list = cases().filter((c) => c.expect !== null && UUID.test(c.notes.split(STAFF_NOTE_MARKER)[0]));
  it("has repaired cases to check", () => {
    expect(list.length).toBeGreaterThanOrEqual(25);
  });
  for (const c of list) {
    it(`${c.name}: no id for the customer, same box text, link kept`, () => {
      const after = c.expect as string;
      const lines = Array.isArray(c.lines) ? c.lines : [];
      // customer part (before the marker) has no id
      expect(after.split(STAFF_NOTE_MARKER)[0]).not.toMatch(UUID);
      // every customer surface: accept page (with ctx), PDF / preview (without) — no id
      expect(customerQuoteNotes(after, lines, { plan: c.plan, extensionMonths: c.ext }) ?? "").not.toMatch(UUID);
      expect(customerQuoteNotes(after, lines) ?? "").not.toMatch(UUID);
      // the editor box opens on what it showed before the repair
      const before = splitNotesForEditor(c.notes, lines, { plan: c.plan ?? null, extensionMonths: c.ext ?? null });
      const now = splitNotesForEditor(after, lines, { plan: c.plan ?? null, extensionMonths: c.ext ?? null });
      expect(now.customer.trim()).toBe(before.customer.trim());
      // Renewals (open-renewal-quotes) and the add-seats link read the same subscription id
      const map = (n: string) => [...openRenewalQuoteMap([{ id: "q", notes: n }]).keys()];
      expect(map(after)).toEqual(map(c.notes));
      expect(after.match(SUB_IN_NOTES)?.[1] ?? null).toBe(c.notes.match(SUB_IN_NOTES)?.[1] ?? null);
    });
  }
});
