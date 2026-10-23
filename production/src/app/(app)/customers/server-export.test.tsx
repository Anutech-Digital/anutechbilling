// @vitest-environment jsdom
//
// R-1801: /customers exports through POST /api/exports/customers (R-1007) — role check
// (can_export_data), contact mask, export_log row, "Exported by …" footer. Before, More →
// Export CSV and the bulk bar's Export built the file in the browser with downloadCSV, so any
// role that could open /customers (sales, support…) took the whole contact book, unsigned.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CustomersBulkBar } from "@/components/features/customers/customers-bulk-bar";

afterEach(cleanup);

const bar = (onExport?: () => void) => (
  <CustomersBulkBar
    count={2} groups={[]} onExport={onExport}
    onArchive={vi.fn()} onReactivate={vi.fn()} onSetGroup={vi.fn()} onDelete={vi.fn()} onDeselectAll={vi.fn()}
  />
);

describe("Companies bulk bar — Export only for a role the server serves", () => {
  it("shows Export when the page passes onExport", () => {
    render(bar(vi.fn()));
    expect(screen.queryByRole("button", { name: /Export selected to CSV/ })).not.toBeNull();
  });
  it("hides Export when the page passes none (sales, billing, accountant…)", () => {
    render(bar(undefined));
    expect(screen.queryByRole("button", { name: /Export selected to CSV/ })).toBeNull();
  });
});

describe("/customers page wiring (source)", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/customers/page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("asks the server for the file — whole list and the ticked ids", () => {
    expect(src).toMatch(/downloadServerExport\("customers"\)/);
    expect(src).toMatch(/downloadServerExport\("customers", \{ ids/);
  });
  it("never builds a customers CSV in the browser any more", () => {
    expect(src).not.toMatch(/downloadCSV\(/);
    expect(src).not.toMatch(/customersCsvRows/);
  });
  it("gates both buttons on mayExport('customers', role)", () => {
    expect(src).toMatch(/mayExport\("customers", myRole\)/);
    expect(src).toMatch(/onExport=\{canExport \? bulkExport : undefined\}/);
    expect(src).toMatch(/\{canExport && \(\s*<DropdownMenuItem[^>]*onClick=\{handleExport\}/);
  });
});
