import { describe, expect, it } from "vitest";
import { editCustomerHref, returnPathFromSearch, safeReturnPath } from "./return-path";

describe("R-2108 customer edit ?return=", () => {
  it("round-trips Hosting & Domains", () => {
    const href = editCustomerHref("abc-1", "/hosting-domains");
    expect(href).toBe("/customers/abc-1/edit?return=%2Fhosting-domains");
    expect(returnPathFromSearch(href.slice(href.indexOf("?")))).toBe("/hosting-domains");
  });

  it("follows only paths inside the app", () => {
    expect(safeReturnPath("//evil.example")).toBeNull();
    expect(safeReturnPath("https://evil.example")).toBeNull();
    expect(safeReturnPath("/\\evil.example")).toBeNull();
    expect(safeReturnPath("")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(returnPathFromSearch("")).toBeNull();
  });
});
