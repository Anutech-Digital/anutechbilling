import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
