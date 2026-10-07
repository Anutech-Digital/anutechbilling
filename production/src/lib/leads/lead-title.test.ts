// R-279 (Pardeep, 6 Oct night): "company ka naam na ho to contact name show karo".
// leadDisplayName() existed since 29 Aug but only two screens used it; the Kanban card, the
// lead sheet header, the hot card, the call queue, the swipe card, the right rail, the
// dashboard and tasks printed `lead.company` straight, so a lead without a company showed a
// blank title. leadTitle() keeps the company where there is one and falls back otherwise.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { leadTitle, leadDisplayName } from "./display-name";

describe("leadTitle — company where the screen shows a company, else who it is", () => {
  it("company present: company, no hint", () => {
    expect(leadTitle({ company: "Acme Pvt Ltd", contact_name: "Raj" })).toEqual({ label: "Acme Pvt Ltd", source: "company", hint: null });
  });

  it("company blank: the contact's name, with a hint saying why", () => {
    const t = leadTitle({ company: "  ", contact_name: "Raj Kumar" });
    expect(t.label).toBe("Raj Kumar");
    expect(t.source).toBe("contact");
    expect(t.hint).toMatch(/no company/i);
  });

  it("then email, then phone, then '(no name)' — never blank", () => {
    expect(leadTitle({ company: "", contact_email: "raj@x.in" }).label).toBe("raj@x.in");
    expect(leadTitle({ company: "", contact_phone: " 98100 00000 " }).label).toBe("98100 00000");
    expect(leadTitle({ company: "" }).label).toBe("(no name)");
    expect(leadTitle(null).label).toBe("(no name)");
  });
});

describe("leadDisplayName — phone fallback (R-279)", () => {
  it("phone after email, before '(no name)'", () => {
    expect(leadDisplayName({ contact_phone: "9810000000" })).toMatchObject({ label: "9810000000", source: "phone" });
    expect(leadDisplayName({ contact_email: "a@b.in", contact_phone: "9810000000" }).source).toBe("email");
  });
});

/* The screens: no bare `lead.company` rendered as a name. Data passed on (URL params that
   prefill a quote, the saved company) is R-278's and is matched out by the patterns below. */
const FILES = [
  "src/components/features/leads/lead-card.tsx",
  "src/components/features/leads/leads-kanban-board.tsx",
  "src/components/features/leads/lead-detail-header.tsx",
  "src/components/features/leads/lead-detail-sheet.tsx",
  "src/components/features/leads/leads-hot-card.tsx",
  "src/components/features/leads/priority-call-queue.tsx",
  "src/components/features/leads/swipe-lead-card.tsx",
  "src/components/features/leads/leads-right-rail.tsx",
  "src/components/features/leads/call-log-dialog.tsx",
  "src/app/(app)/dashboard/page.tsx",
  "src/app/(app)/tasks/page.tsx",
];

describe("R-279: screens name a lead through leadTitle", () => {
  for (const f of FILES) {
    it(f, () => {
      const src = readFileSync(join(process.cwd(), f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/gm, "$1");
      /* JSX text, template literals and titles that print the company as the name. */
      /* `company={lead.company}` passes the data on (a prop), it does not print it. */
      expect(src).not.toMatch(/(?<!=)\{\s*(lead|l|topHot|pending)\??\.company\s*\}/);
      expect(src).not.toMatch(/\$\{\s*(lead|l|topHot)\??\.company\b/);
      expect(src).not.toMatch(/cleanDisplayName\(\s*(lead|l)\.company\s*\)/);
      expect(src).not.toMatch(/(who|title|linkLabel|companyName):\s*[\w?.]*\.company\b/);
      expect(src).not.toMatch(/leads\?\.company\s*\?\?/);
      expect(src).not.toMatch(/companyName=\{[\w?.]*\.company\b/);
    });
  }
});
