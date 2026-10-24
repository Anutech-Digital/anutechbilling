/* R-1623 (follow-up, 23 Oct UI rules): the "Remove import" dialog shows the database's refusal
   text as-is (bank-imports-section.tsx, catch → setProblem), and the Activity log shows the
   label remove_bank_import writes. So every refusal and that label must be English like the rest
   of the app (R-1731) — this reads the LATEST migration that defines each R-1623 function and
   fails on any Hinglish in a raise / format string, naming file:line. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HINGLISH_UI } from "@/lib/ui-copy/hinglish-scan";

const DIR = join(__dirname, "../../../supabase/migrations");
const FNS = ["import_bank_statement", "bank_import_history", "remove_bank_import"] as const;

/** The newest migration file that (re)defines public.<fn>, and that definition's lines. */
function latestDefinition(fn: string): { file: string; startLine: number; lines: string[] } {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  const head = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, "i");
  for (const file of [...files].reverse()) {
    const all = readFileSync(join(DIR, file), "utf8").split(/\r?\n/);
    const start = all.findIndex((l) => head.test(l));
    if (start < 0) continue;
    const end = all.findIndex((l, i) => i > start && /^\$function\$;/.test(l.trim()));
    return { file, startLine: start + 1, lines: all.slice(start, end < 0 ? undefined : end + 1) };
  }
  throw new Error(`no migration defines public.${fn}`);
}

/** Screen text in a definition: raise exception '…' (may continue on the next line) and format('…'). */
function screenStrings(def: ReturnType<typeof latestDefinition>): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  def.lines.forEach((line, i) => {
    const m = line.match(/(?:raise\s+exception|format\s*\()\s*'((?:[^']|'')*)'/i);
    if (m) out.push({ at: `supabase/migrations/${def.file}:${def.startLine + i}`, text: m[1].replace(/''/g, "'") });
  });
  return out;
}

describe("R-1623 database text is English (shown in the Remove import dialog and the Activity log)", () => {
  for (const fn of FNS) {
    it(`${fn}: no Hinglish in its refusals / labels`, () => {
      const strings = screenStrings(latestDefinition(fn));
      expect(strings.length).toBeGreaterThan(0);
      const hinglish = strings.filter((s) => HINGLISH_UI.test(s.text)).map((s) => `${s.at}  ${s.text}`);
      expect(hinglish).toEqual([]);
    });
  }

  it("the books-lock refusal still names Month-end close (the dialog's 'Open Month-end close' link keys on it)", () => {
    const lock = screenStrings(latestDefinition("remove_bank_import")).find((s) => /locked/i.test(s.text));
    expect(lock?.text).toMatch(/Month-end close/);
  });
});
