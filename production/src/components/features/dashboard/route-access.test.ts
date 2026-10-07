import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canOpenRoute } from "./route-access";

describe("R-253 canOpenRoute follows the route guard", () => {
  it("billing cannot open quotes or the catalog, can open payments and invoices", () => {
    expect(canOpenRoute("billing", "/quotes")).toBe(false);
    expect(canOpenRoute("billing", "/quotes/new")).toBe(false);
    expect(canOpenRoute("billing", "/items")).toBe(false);
    expect(canOpenRoute("billing", "/payments")).toBe(true);
    expect(canOpenRoute("billing", "/invoices")).toBe(true);
  });
  it("owner and manager open everything; sales opens quotes", () => {
    for (const r of ["owner", "manager"]) expect(canOpenRoute(r, "/quotes")).toBe(true);
    expect(canOpenRoute("sales", "/quotes/new")).toBe(true);
  });
});

/* Billing lands on /invoices and also sees the Dashboard. Every /quotes link on those screens
   must sit behind a role check, or it throws billing back to /invoices. */
const SRC = join(process.cwd(), "src");
const FILES = [
  "app/(app)/invoices/page.tsx",
  "components/features/dashboard/priority-action-hub.tsx",
];
describe("R-253 no unguarded /quotes link on billing's screens", () => {
  for (const f of FILES) {
    it(f, () => {
      const text = readFileSync(join(SRC, f), "utf8");
      const lines = text.split(/\r?\n/);
      const bare: string[] = [];
      lines.forEach((line, i) => {
        if (!/["'`]\/quotes/.test(line) || /import /.test(line)) return;
        const ctx = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
        if (!/canQuotes|canOpenQuotes|canOpenRoute/.test(ctx)) bare.push(`${i + 1}: ${line.trim()}`);
      });
      expect(bare).toEqual([]);
    });
  }
});
