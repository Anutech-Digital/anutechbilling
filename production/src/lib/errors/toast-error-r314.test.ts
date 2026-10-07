/**
 * R-314 — Vault, Vault expenses, Reset password, TDS detail, Leave request, Customer insights,
 * API keys, lead components and Project tasks now follow §24: every `toast.error` carries a
 * `description` (why / what next) and every caught error goes through `toastError()`, never
 * `err.message` straight onto the screen.
 *
 * Per-file and at ZERO, so a new bare toast in these files fails here even while the
 * global ratchet (toast-error-ratchet.test.ts) still has headroom.
 */
import { describe, it, expect } from "vitest";
import { join } from "path";
import { readFileSync } from "fs";
const { countRaw } = require("../../../scripts/count-raw-toast-errors.cjs");

const R314_FILES = [
  "src/app/(app)/vault/page.tsx",
  "src/app/(app)/vault/personal/expenses/page.tsx",
  "src/app/(auth)/reset-password/page.tsx",
  "src/components/features/accounting/tds-detail-dialog.tsx",
  "src/components/features/attendance/leave-request-dialog.tsx",
  "src/components/features/customers/customer-insights.tsx",
  "src/components/features/integrations/api-keys-card.tsx",
  "src/components/features/leads/expected-close-field.tsx",
  "src/components/features/leads/lead-email-composer.tsx",
  "src/components/features/leads/lead-list-view.tsx",
  "src/components/features/leads/leads-hot-card.tsx",
  "src/components/features/leads/priority-call-queue.tsx",
  "src/components/features/projects/project-tasks.tsx",
] as const;

describe("R-314 — no bare or raw error toasts in these components", () => {
  const { total, rawByFile } = countRaw(join(process.cwd(), "src")) as {
    total: number;
    rawByFile: Map<string, number>;
  };

  it("the scan actually saw toasts (an empty scan must not pass)", () => {
    expect(total).toBeGreaterThan(100);
  });

  it.each(R314_FILES)("%s has 0 bare toast.error", (rel) => {
    const abs = join(process.cwd(), rel);
    // Denominator: the file still exists and still shows error toasts, so "0 bare" means something.
    const src = readFileSync(abs, "utf8");
    expect(src).toMatch(/toast\.error\(|toastError\(/);
    expect(rawByFile.get(abs) ?? 0).toBe(0);
  });

  it.each(R314_FILES)("%s never toasts raw error text", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/toast\.error\(\s*\(?\s*\w+\s+as\s+Error\s*\)?\s*\.message/);
    expect(src).not.toMatch(/toast\.error\(\s*\w+\s+instanceof\s+Error\s*\?\s*\w+\.message/);
    expect(src).not.toMatch(/toast\.error\(\s*\w+\.message/);
  });
});
