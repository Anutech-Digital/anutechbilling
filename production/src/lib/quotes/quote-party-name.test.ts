import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isPlaceholderQuoteName,
  leadQuoteName,
  quoteMatchesSearch,
  quotePartyName,
} from "./quote-party-name";

/* R-278: the 6 Oct case — lead L-MUWVLYIU, company empty, contact Pardeep Sharma. */
const lead = {
  company: "",
  contact_name: "Pardeep Sharma",
  contact_email: "pardeep.webmaster@gmail.com",
  contact_phone: "+91 98990 12345",
};
const oldQuote = { id: "Q-FBB9-27-0009", customer_name: "Prospect", plan: "Business Starter" };

describe("leadQuoteName (what the builder saves)", () => {
  it("company first", () => {
    expect(leadQuoteName({ ...lead, company: "Acme Pvt Ltd" })).toBe("Acme Pvt Ltd");
  });
  it("no company -> contact name, not 'Prospect'", () => {
    expect(leadQuoteName(lead)).toBe("Pardeep Sharma");
  });
  it("then email, then phone", () => {
    expect(leadQuoteName({ ...lead, contact_name: " " })).toBe("pardeep.webmaster@gmail.com");
    expect(leadQuoteName({ contact_phone: "98990" })).toBe("98990");
  });
  it("nothing at all -> empty (caller falls back to 'Prospect')", () => {
    expect(leadQuoteName({})).toBe("");
  });
});

describe("quotePartyName (what the list shows)", () => {
  it("old 'Prospect' quote shows the lead contact, no data change", () => {
    expect(quotePartyName("Prospect", lead)).toBe("Pardeep Sharma");
    expect(quotePartyName("", lead)).toBe("Pardeep Sharma");
  });
  it("a real name always wins", () => {
    expect(quotePartyName("Acme Pvt Ltd", lead)).toBe("Acme Pvt Ltd");
  });
  it("no lead -> keeps the placeholder", () => {
    expect(quotePartyName("Prospect", null)).toBe("Prospect");
    expect(quotePartyName(null, undefined)).toBe("Prospect");
  });
  it("placeholder check", () => {
    expect(isPlaceholderQuoteName(" prospect ")).toBe(true);
    expect(isPlaceholderQuoteName("Prospect Labs")).toBe(false);
  });
});

describe("quoteMatchesSearch (Quotes list search)", () => {
  it("finds the quote by lead email, phone digits and contact name", () => {
    expect(quoteMatchesSearch(oldQuote, lead, "pardeep.webmaster@gmail.com")).toBe(true);
    expect(quoteMatchesSearch(oldQuote, lead, "98990")).toBe(true);
    expect(quoteMatchesSearch(oldQuote, lead, "9899012345")).toBe(true);
    expect(quoteMatchesSearch(oldQuote, lead, "Pardeep")).toBe(true);
  });
  it("still finds by id, name and plan; misses a stranger", () => {
    expect(quoteMatchesSearch(oldQuote, null, "fbb9")).toBe(true);
    expect(quoteMatchesSearch(oldQuote, null, "starter")).toBe(true);
    expect(quoteMatchesSearch(oldQuote, lead, "rahul@example.com")).toBe(false);
    expect(quoteMatchesSearch(oldQuote, null, "98990")).toBe(false);
  });
  it("empty search matches everything", () => {
    expect(quoteMatchesSearch(oldQuote, null, "  ")).toBe(true);
  });
});

/* Wiring: the two screens must use these rules, not their own copies. */
describe("R-278 wiring", () => {
  const root = path.resolve(__dirname, "../../..");
  const builder = fs.readFileSync(
    path.join(root, "src/components/features/quotes/quote-builder.tsx"),
    "utf8",
  );
  const list = fs.readFileSync(path.join(root, "src/app/(app)/quotes/page.tsx"), "utf8");

  it("builder saves lead-mode name via leadQuoteName (not company-only)", () => {
    expect(builder).toMatch(/leadQuoteName\(/);
    expect(builder).not.toMatch(/\?\s*\(leadCompany\?\.trim\(\)\s*\|\|\s*""\)/);
    expect(builder).not.toMatch(/leadCompany \?\? "Prospect"/);
  });
  it("list searches and shows through the shared rules", () => {
    expect(list).toMatch(/quoteMatchesSearch\(/);
    expect(list).toMatch(/quotePartyName\(/);
    expect(list).not.toMatch(/q\.customer_name\.toLowerCase\(\)\.includes\(s\)/);
  });
});
