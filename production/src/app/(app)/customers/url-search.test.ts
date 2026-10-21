/**
 * R-1720 — opening /customers?q=T-V7 must put "T-V7" in the search box and filter the list,
 * like /invoices?q= already does. `?contact=` (the "Serves N customers" chip) keeps working.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { customerSearchFromUrl } from "./server-list";

describe("R-1720 — /customers reads ?q= into its search box", () => {
  it("?q= seeds the search", () => {
    expect(customerSearchFromUrl("?q=T-V7")).toBe("T-V7");
  });
  it("?contact= still seeds it (contact chip)", () => {
    expect(customerSearchFromUrl("?contact=anjali%40doodhsang.in")).toBe("anjali@doodhsang.in");
  });
  it("no param → empty box; ?q= wins over ?contact=", () => {
    expect(customerSearchFromUrl("")).toBe("");
    expect(customerSearchFromUrl("?contact=a&q=b")).toBe("b");
  });
  it("the page seeds the box and the server read from it once, on mount (no hydration mismatch)", () => {
    const page = readFileSync("src/app/(app)/customers/page.tsx", "utf8");
    expect(page).toContain("const fromUrl = customerSearchFromUrl(window.location.search);");
    expect(page).toContain("if (fromUrl) { setSearch(fromUrl); setServerSearch(fromUrl); }");
    expect(page).toContain('const [search, setSearch] = React.useState("");');
  });
});
