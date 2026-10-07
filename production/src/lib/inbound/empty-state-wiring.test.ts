/**
 * R-192: the empty Enquiries Inbox says what to do — add a lead, set up email — and how mail
 * arrives, instead of bare text.
 *
 * R-331 (7 Oct 2026): R-209 moved the two buttons out of page.tsx into AddLeadButton /
 * SetUpEmailButton in ./mobile-folders.tsx (so the phone layout shares them). This test still
 * grepped page.tsx for the button text and went red, which kept CI red and skipped lint + build.
 * The page was right; the test was stale. It now checks BOTH halves: the page wires the two
 * components into the empty-Inbox EmptyState, and the components carry the text and links.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "src", "app", "(app)", "enquiries");
const PAGE = readFileSync(join(DIR, "page.tsx"), "utf8");
const BUTTONS = readFileSync(join(DIR, "mobile-folders.tsx"), "utf8");

describe("/enquiries empty Inbox", () => {
  it("offers a primary and a secondary action, not bare text", () => {
    // The page puts the two buttons into the empty Inbox's EmptyState…
    expect(PAGE).toMatch(/action=\{isEmptySearch\(parsed\)[\s\S]*?<AddLeadButton \/>/);
    expect(PAGE).toMatch(/secondary=\{isEmptySearch\(parsed\) && folder === "inbox"[\s\S]*?<SetUpEmailButton \/>/);
    // …and those buttons say what to do and go to the right places.
    expect(BUTTONS).toMatch(/Add a lead manually/);
    expect(BUTTONS).toMatch(/Set up email in Settings/);
    expect(BUTTONS).toMatch(/\/settings\?tab=integrations/);
  });
  it("explains how enquiries arrive and names the folders", () => {
    expect(PAGE).toMatch(/enquiries-empty-guidance/);
    expect(PAGE).toMatch(/Enquiries arrive here when/);
  });
});
