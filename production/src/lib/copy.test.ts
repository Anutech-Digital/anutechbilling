import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COPY } from "./copy";

// R-216: these screens had Hinglish buttons/labels ("Ho gaya", "Kholo", "Hatao").
// App UI copy must be short plain English (chat/AI text is out of scope).
const FILES = [
  "src/app/(app)/accounting/close/page.tsx",
  "src/app/(app)/marketing/page.tsx",
  "src/app/(app)/marketing/campaigns/page.tsx",
  "src/app/(app)/marketing/lead-finder/page.tsx",
  "src/app/(app)/marketing/links/page.tsx",
  "src/app/(app)/marketing/whatsapp/page.tsx",
  "src/app/(app)/marketing/whatsapp/reminders/page.tsx",
  "src/app/(public)/unsubscribe/unsubscribe-client.tsx",
];

// The card's list: these capitalised words only ever start a Hinglish button/label.
const CARD_WORDS = /\b(Ho gaya|Kholo|Bhejo|Dekho|Karo|Hatao|Jodo|Wapas|Band karo)\b/;
// Inside a button/link text or a confirm/label value, no Hinglish verb at all.
const VERBS = /\b(karo|kholo|dhoondho|dekho|bhejo|hatao|chhupao|dikhao|nahi|haan|baaki)\b/i;
const LABEL_SPOTS = [
  />([^<>]*)<\/(?:Button|button|Link)>/g,
  /\b(?:confirmLabel|cancelLabel|label|title):\s*("[^"]*"|`[^`]*`)/g,
];

describe("R-216 UI copy is English", () => {
  for (const f of FILES) {
    it(`${f} has no Hinglish button/label words`, () => {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      const lines = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
      const hits = lines.filter((l) => CARD_WORDS.test(l));
      for (const re of LABEL_SPOTS) {
        for (const m of src.matchAll(re)) if (VERBS.test(m[1])) hits.push(m[1].trim());
      }
      expect(hits).toEqual([]);
    });
  }

  it("shared words are short English", () => {
    for (const v of Object.values(COPY)) expect(v).toMatch(/^[A-Za-z ,]+$/);
  });
});
