/**
 * R-305 — the Welcome (signup) page, Create coupon, Customers import and Razorpay setup now
 * follow §24: every `toast.error` carries a `description` (why / what next) and every
 * caught error goes through `toastError()`, never `err.message` straight onto the screen.
 *
 * Per-file and at ZERO, so a new bare toast in these files fails here even while the
 * global ratchet (toast-error-ratchet.test.ts) still has headroom. Kept in its own file
 * because the ratchet file is locked by another worker (R-304) when this landed.
 */
import { describe, it, expect } from "vitest";
import { join } from "path";
import { readFileSync } from "fs";
const { countRaw } = require("../../../scripts/count-raw-toast-errors.cjs");

const R305_FILES = [
  "src/app/(auth)/welcome/page.tsx",
  "src/components/features/coupons/create-coupon-dialog.tsx",
  "src/components/features/customers/import-customers-dialog.tsx",
  "src/components/features/integrations/razorpay-configure-dialog.tsx",
] as const;

describe("R-305 — no bare or raw error toasts in these components", () => {
  const { total, rawByFile } = countRaw(join(process.cwd(), "src")) as {
    total: number;
    rawByFile: Map<string, number>;
  };

  it("the scan actually saw toasts (an empty scan must not pass)", () => {
    expect(total).toBeGreaterThan(100);
  });

  it.each(R305_FILES)("%s has 0 bare toast.error", (rel) => {
    const abs = join(process.cwd(), rel);
    // Denominator: the file still exists and still shows error toasts, so "0 bare" means something.
    const src = readFileSync(abs, "utf8");
    expect(src).toMatch(/toast\.error\(|toastError\(/);
    expect(rawByFile.get(abs) ?? 0).toBe(0);
  });

  it.each(R305_FILES)("%s never toasts raw error text", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/toast\.error\(\s*\(?\s*\w+\s+as\s+Error\s*\)?\s*\.message/);
    expect(src).not.toMatch(/toast\.error\(\s*\w+\s+instanceof\s+Error\s*\?\s*\w+\.message/);
    expect(src).not.toMatch(/toast\.error\(\s*\w+\.message/);
  });
});
