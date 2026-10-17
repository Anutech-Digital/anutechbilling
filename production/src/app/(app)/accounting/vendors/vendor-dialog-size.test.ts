// R-1408: the "Add vendor" / "Edit vendor" dialog is wide enough on a desktop.
//
// Pawan, staging AI Help, 12 Oct 2026 (/accounting/vendors): the modal was "too narrow
// and cramped". It holds ~17 fields (GSTIN check, PAN, MSME, bank, products, contact,
// address) in a 512px box (md:!max-w-lg). The shared DialogContent's width uses `!`,
// so a dialog widens itself with the same `md:!max-w-…` pattern R-1448 used, and keeps
// its 90vh cap with the form scrolling inside. Phones keep the bottom sheet.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.resolve(__dirname, "page.tsx"), "utf8");

function vendorDialogClass(): string[] {
  const m = src.match(
    /<DialogContent className="([^"]+)">\s*<DialogHeader>\s*<DialogTitle>\{vendor \? "Edit vendor" : "Add vendor"\}/,
  );
  if (!m) throw new Error("vendor dialog DialogContent not found in page.tsx");
  return m[1].split(/\s+/);
}

describe("R-1408 — Add vendor dialog size", () => {
  it("opens at a wide desktop size, not the cramped 512px", () => {
    const cls = vendorDialogClass();
    expect(cls).toContain("md:!max-w-3xl");
    expect(cls).not.toContain("md:!max-w-lg");
  });

  it("stays within the screen height and scrolls inside", () => {
    const cls = vendorDialogClass();
    expect(cls).toContain("max-h-[90vh]");
    expect(cls).toContain("overflow-y-auto");
  });
});
