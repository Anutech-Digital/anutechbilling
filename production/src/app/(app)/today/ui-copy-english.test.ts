import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HINGLISH_ALLOWED_BY_DESIGN, hinglishHits, scanHinglish, uiSourceFiles } from "@/lib/ui-copy/hinglish-scan";
import { HINGLISH_ALLOWLIST } from "@/lib/ui-copy/hinglish-allowlist";

/* R-246 (after R-216): screens that still showed Hinglish labels, toasts and hints
   ("Samajh gaya", "Andaza", "jod me nahi", "Wajah kam se kam…"). App UI copy is short plain
   English; comments, AI replies and the customer WhatsApp template are out of scope. */
const FILES = [
  "src/app/(app)/today/page.tsx",
  "src/app/(app)/enquiries/page.tsx",
  "src/app/(app)/quotes/[id]/page.tsx",
  "src/app/(app)/payments/page.tsx",
  "src/app/(app)/renewals/page.tsx",
  "src/lib/nav.ts",
  "src/components/shared/ai-help.tsx",
];

const HINGLISH = /\b(karo|karein|nahi|Samajh|Wajah|Andaza|Aapka|aapke|dabaiye|kharcha|daalo|Pehle|mein|chahiye|Kya|jod me|apne aap)\b/;

/** Source without comments and without the customer-facing WhatsApp message template. */
function uiSource(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/const message =[\s\S]*?;\r?\n/g, "");
}

describe("R-246 UI copy is English", () => {
  for (const f of FILES) {
    it(`${f} has no Hinglish UI text`, () => {
      const hits = uiSource(f).split(/\r?\n/).filter((l) => HINGLISH.test(l)).map((l) => l.trim());
      expect(hits).toEqual([]);
    });
  }

  it("the quote delete dialog opens the invoice itself, not the invoice list", () => {
    const src = uiSource("src/app/(app)/quotes/[id]/page.tsx");
    expect(src).not.toMatch(/<Link href=\{"\/invoices" as any\}>Open<\/Link>/);
    expect(src).toMatch(/<Link href=\{invoiceHref\(quote\.invoice_id\) as any\}>Open<\/Link>/);
  });
});

/* R-1731 (decision R-1728, 22 Oct 2026): the whole app UI is English — Hinglish only in AI help
   and AI prompts/replies. The guard now reads EVERY file under src/app and src/components, so a
   new Hinglish label, toast or tooltip anywhere turns CI red. Files still waiting for their
   card are listed in src/lib/ui-copy/hinglish-allowlist.ts; a listed file with no Hinglish left
   also fails, so that list only shrinks. */
describe("R-1731 UI copy is English across the whole app", () => {
  const root = process.cwd();
  const found = scanHinglish(root);

  it("no file outside the allow-list shows Hinglish on screen", () => {
    const offenders: Record<string, string[]> = {};
    for (const [file, hits] of found) if (!(file in HINGLISH_ALLOWLIST)) offenders[file] = hits;
    expect(offenders).toEqual({});
  });

  it("every allow-listed file still has Hinglish (remove its line when the card cleans it)", () => {
    const stale = Object.keys(HINGLISH_ALLOWLIST).filter((f) => !found.has(f));
    expect(stale).toEqual([]);
  });

  it("every allow-list entry names the card that will clean it", () => {
    for (const [file, card] of Object.entries(HINGLISH_ALLOWLIST)) expect(card, file).toMatch(/^R-17(32|33)$/);
  });

  it("Accounting, Banking and Expenses are not on the allow-list (R-1731)", () => {
    const mine = Object.keys(HINGLISH_ALLOWLIST).filter((f) =>
      /^src\/app\/\(app\)\/accounting\/|^src\/components\/features\/(banking|accounting)\//.test(f));
    expect(mine).toEqual([]);
  });

  it("the scanner catches the owner's examples and skips comments and code", () => {
    expect(hinglishHits(`<span>Imports · 1 chalu · 1 hataye</span>`)).not.toEqual([]);
    expect(hinglishHits(`toast.error("Paisa de diya?")`)).not.toEqual([]);
    expect(hinglishHits(`label="Kis liye?"`)).not.toEqual([]);
    expect(hinglishHits(`/* kharcha nahi */ const x = 1;`)).toEqual([]);
    expect(hinglishHits(`// ye comment hai`)).toEqual([]);
    expect(hinglishHits(`<option value="KA">Karnataka (29)</option>`)).toEqual([]);
    expect(hinglishHits(`<label htmlFor="payroll-kis-mahine-ka">Period</label>`)).toEqual([]);
    expect(hinglishHits(`<span>Imports · 1 active · 1 removed · last: 20 Oct 2026 · no file name</span>`)).toEqual([]);
  });
});

/* R-1733: the allow-list is empty — the guard covers the whole app (src/app, src/components and
   now src/lib) with no exceptions except the AI / keyword files named in HINGLISH_ALLOWED_BY_DESIGN.
   The scanner also learnt three things the R-1732 worker found it missing. */
describe("R-1733 Hinglish guard has no gaps", () => {
  it("the allow-list is empty", () => {
    expect(Object.keys(HINGLISH_ALLOWLIST)).toEqual([]);
  });

  it("scans src/lib too (query/API/PDF/tax helpers put text on screen)", () => {
    expect(uiSourceFiles(process.cwd())).toContain("src/lib/tax/itr.ts");
    expect(uiSourceFiles(process.cwd())).toContain("src/lib/queries/bank.ts");
  });

  it("a doc comment before a JSX comment no longer hides the text between them (call-log-dialog)", () => {
    /* The old JSX-comment strip started at "({" + a doc comment and ran to the next "*\/}". */
    const src = [
      "export function CallLogDialog({",
      "  /** Kis lead ka call. */",
      "  companyName,",
      "}: Props) {",
      "  return (",
      "    <DialogDescription>",
      "      Kya baat hui? Bolkar ya likhkar darj kariye.",
      "    </DialogDescription>",
      "    {/* mic note */}",
      "  );",
      "}",
    ].join("\n");
    expect(hinglishHits(src).join(" ")).toMatch(/darj kariye/);
  });

  it("reads text inside ${…} strings of a template but not code, and skips regex keyword lists", () => {
    expect(hinglishHits("const c = `hsl(${row.hue}, 50%, 55%)`;")).toEqual([]);
    expect(hinglishHits("const t = `Saved ${ok ? \"\" : \"nahi\"}`;")).not.toEqual([]);
    expect(hinglishHits(`const re = [/\b(team ke liye|b'?day)\b/i, "Staff Welfare"];`)).toEqual([]);
    expect(hinglishHits(`  sender: "Rohit Kumar", initials: "RK", hue: 220,`)).toEqual([]);
    expect(hinglishHits(`  error: "Pehle apna employee link karo",`)).not.toEqual([]);
  });

  it("JSX text that starts with a digit is read", () => {
    expect(hinglishHits("<p>\n  20 se zyada fields nahi ho sakte.\n</p>")).not.toEqual([]);
  });

  /* R-1752 (22 Oct 2026, Pardeep: the public website is English too): src/site is scanned, with
     no allow-list. Before this card the Ads landing page dictionary (lp-copy.ts) had 116 Hinglish
     lines the guard never saw. */
  it("scans the public website src/site too, and no site file is allowed by design", () => {
    const files = uiSourceFiles(process.cwd());
    expect(files).toContain("src/site/components/lp/lp-copy.ts");
    expect(files).toContain("src/site/components/home/HomeV2.tsx");
    expect(files.filter((f) => f.startsWith("src/site/")).length).toBeGreaterThan(60);
    expect(HINGLISH_ALLOWED_BY_DESIGN.some((re) => re.test("src/site/components/lp/lp-copy.ts"))).toBe(false);
    expect([...scanHinglish(process.cwd()).keys()].filter((f) => f.startsWith("src/site/"))).toEqual([]);
  });

  it("files allowed by design are AI help / prompts / keyword matchers only", () => {
    for (const f of ["src/lib/tax/itr.ts", "src/lib/queries/bank.ts", "src/lib/api/with-route.ts", "src/lib/leads/lead-contacts.ts"])
      expect(HINGLISH_ALLOWED_BY_DESIGN.some((re) => re.test(f)), f).toBe(false);
  });
});
