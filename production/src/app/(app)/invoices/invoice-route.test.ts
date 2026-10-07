// R-086 (6 Oct 2026): every invoice has its own address, /invoices/<id>, instead of a sheet
// that only `/invoices?open=<id>` could open. These pin the three things that make that true:
// the address is built one way (and survives a "/" in a custom series prefix), the old links
// already sent on WhatsApp/email still land on the invoice, and the list really navigates
// rather than quietly keeping a second, sheet-based copy of the detail.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { invoiceHref, legacyOpenRedirect, invoiceIdFromParam } from "./invoice-href";

const dir = join(process.cwd(), "src/app/(app)/invoices");
const list = readFileSync(join(dir, "page.tsx"), "utf8");

describe("invoiceHref", () => {
  it("puts a plain invoice number straight into the path", () => {
    expect(invoiceHref("INV-2026-0042")).toBe("/invoices/INV-2026-0042");
  });

  it("encodes a series prefix with a slash, so it stays one path segment", () => {
    expect(invoiceHref("ANU/26-27/001")).toBe("/invoices/ANU%2F26-27%2F001");
  });

  it("round-trips through the [id] segment back to the same invoice number", () => {
    for (const id of ["INV-1", "ANU/26-27/001", "INV 7", "A&B#1"]) {
      const segment = invoiceHref(id).slice("/invoices/".length);
      expect(invoiceIdFromParam(segment)).toBe(id);
      // Next.js usually hands the segment over already decoded — must be the same answer
      if (!id.includes("%")) expect(invoiceIdFromParam(decodeURIComponent(segment))).toBe(id);
    }
  });

  it("keeps a malformed escape as written instead of throwing (page then says not found)", () => {
    expect(invoiceIdFromParam("INV-%E0%A4")).toBe("INV-%E0%A4");
    expect(invoiceIdFromParam(undefined)).toBe("");
  });
});

describe("old ?open= links", () => {
  it("forward to the invoice's own page", () => {
    expect(legacyOpenRedirect("INV-9")).toBe("/invoices/INV-9");
    expect(legacyOpenRedirect(" INV-9 ")).toBe("/invoices/INV-9");
  });

  it("leave the list alone when there is nothing to open", () => {
    expect(legacyOpenRedirect(null)).toBeNull();
    expect(legacyOpenRedirect("")).toBeNull();
    expect(legacyOpenRedirect("   ")).toBeNull();
  });

  it("are redirected with replace(), so Back does not bounce through the old URL", () => {
    expect(list).toMatch(/legacyOpenRedirect\(searchParams\.get\("open"\)\)/);
    const redirect = list.slice(list.indexOf("function LegacyOpenRedirect"));
    expect(redirect).toMatch(/router\.replace\(to/);
    expect(redirect).not.toMatch(/router\.push\(/);
  });
});

describe("the list opens the page, not a sheet", () => {
  it("has no sheet copy of the invoice detail left in the list", () => {
    expect(list).not.toMatch(/InvoicePreviewContainer/);
    expect(list).not.toMatch(/<Sheet\b/);
    expect(list).not.toMatch(/autoOpen/);
  });

  it("row, View, the menu item and the phone card all go to invoiceHref", () => {
    expect(list).toMatch(/const openInvoice = \(\) => router\.push\(invoiceHref\(inv\.id\)/);
    expect(list.match(/onClick=\{openInvoice\}/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(list).toMatch(/<Link\s+href=\{invoiceHref\(inv\.id\)/);
  });

  it("copies the new address, not the old ?open= one", () => {
    expect(list).toMatch(/\$\{window\.location\.origin\}\$\{invoiceHref\(inv\.id\)\}/);
    expect(list).not.toMatch(/\/invoices\?open=/);
  });
});

describe("the /invoices/[id] page", () => {
  const pagePath = join(dir, "[id]", "page.tsx");

  it("exists and renders the shared InvoiceDetail", () => {
    expect(existsSync(pagePath)).toBe(true);
    const page = readFileSync(pagePath, "utf8");
    expect(page).toMatch(/<InvoiceDetail invoice=\{invoice\} \/>/);
  });

  it("reads under the [\"invoices\"] key, so payments/notes/deletes refresh it", () => {
    const page = readFileSync(pagePath, "utf8");
    expect(page).toMatch(/queryKey: \["invoices", "detail", invoiceId\]/);
  });

  it("never dead-ends: not-found offers a search, a failed read offers a retry (§24)", () => {
    const page = readFileSync(pagePath, "utf8");
    expect(page).toMatch(/Search invoices/);
    expect(page).toMatch(/Try again/);
  });
});
