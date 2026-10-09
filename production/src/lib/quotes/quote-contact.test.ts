import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteContact } from "./quote-contact";

const gupta = { contact_name: "Rohit Gupta", contact_email: "rohit@guptainfotech.in", contact_phone: "9812345678" };

describe("quoteContact (R-445)", () => {
  it("lead quote (no customer yet) carries the lead's name, email and phone", () => {
    expect(quoteContact(null, gupta)).toEqual({
      contactName: "Rohit Gupta", contactEmail: "rohit@guptainfotech.in", contactPhone: "9812345678",
    });
  });

  it("customer wins over the lead, field by field", () => {
    expect(quoteContact({ contact_name: "R. Gupta", contact_email: null, contact_phone: " " }, gupta)).toEqual({
      contactName: "R. Gupta", contactEmail: "rohit@guptainfotech.in", contactPhone: "9812345678",
    });
  });

  it("nothing known → nulls, never empty strings", () => {
    expect(quoteContact(undefined, undefined)).toEqual({ contactName: null, contactEmail: null, contactPhone: null });
    expect(quoteContact({ contact_name: "  " })).toEqual({ contactName: null, contactEmail: null, contactPhone: null });
  });
});

describe("every quote preview passes the contact (R-445)", () => {
  // Source guard: the bug was callers handing the preview literal nulls.
  const files = [
    "src/app/(app)/quotes/[id]/page.tsx",
    "src/app/(app)/quotes/page.tsx",
    "src/components/features/quotes/quote-builder.tsx",
  ];
  it.each(files)("%s never passes contactName/Email/Phone = null to QuotePreviewDialog", (f) => {
    const src = readFileSync(join(process.cwd(), f), "utf8");
    expect(src).toContain("<QuotePreviewDialog");
    expect(src).not.toMatch(/contact(Name|Email|Phone)=\{null\}/);
    expect(src).toContain("quoteContact(");
  });
});
