/**
 * Merge hui pehchan ki HAR company search me mile — source par pehra.
 *
 * 1 Sep 2026: "demo 7" ki lead bani thi par /contacts ki search me nahi mili.
 * Wajah design thi (ek insaan = ek card: same email/phone wali saari rows ek
 * pehchan me judti hain, chehra sabse mazboot rishta) — par search sirf
 * CHEHRE ki company dekhta tha, merge hui leads ki companies nahi. Pardeep
 * ki saari test-leads ek hi email/phone par hain, to har nayi lead usi card
 * me samaa kar search se gayab ho jati thi.
 *
 * Assembly client-hook ke andar hai (Supabase ke saath), isliye yahan
 * source-pin: (1) merge companies[] jama karta hai, (2) page ka filter unhe
 * bhi dekhta hai. Behaviour ka asli saboot prod par "demo 7" search hai.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* R-535: assembly moved to the pure lib/contacts/book.ts (the hook only fetches now). */
const lib = readFileSync(join(process.cwd(), "src/lib/contacts/book.ts"), "utf8");
const page = readFileSync(join(process.cwd(), "src/app/(app)/contacts/page.tsx"), "utf8");

describe("merged identity carries every company", () => {
  it("assembly har merge hui row ki company jama karta hai (dedup, '—' chhod kar)", () => {
    expect(lib).toContain("const companies: string[] = []");
    expect(lib).toMatch(/co !== "—" && !seenC\.has\(ck\)/);
    // emit hota hai — sirf jama nahi
    expect(lib).toMatch(/phones,\s*\n\s*companies,/);
  });

  it("page ka search-filter merged companies ko bhi dekhta hai", () => {
    expect(page).toContain("!inArr(c.companies)");
  });
});
