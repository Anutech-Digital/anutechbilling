/**
 * R-022 (1 Oct 2026): the billing screens (customers, quotes, invoices, payments, projects,
 * items, subscriptions…) had 67 inputs a screen reader could not name, 18 labels not tied
 * to their box, and one hand-made popup without a focus trap. All fixed; this keeps them at
 * zero. Uses the same counter as `node scripts/a11y-count.mjs` (a heuristic over source).
 * Small text (text-2xs/3xs) is R-087's job, not counted here.
 */
import { describe, it, expect } from "vitest";
import { a11yReport } from "@/lib/testing/a11y-report"; // R-2564: in-process, shared read cache (was a node spawn per file)

const BILLING = [
  "production/src/app/(app)/customers/", "production/src/app/(app)/quotes/",
  "production/src/app/(app)/subscriptions/", "production/src/app/(app)/renewals/",
  "production/src/app/(app)/invoices/", "production/src/app/(app)/payments/",
  "production/src/app/(app)/projects/", "production/src/app/(app)/provisioning/",
  "production/src/app/(app)/hosting-domains/", "production/src/app/(app)/items/",
  "production/src/components/features/customers/", "production/src/components/features/quotes/",
  "production/src/components/features/subscriptions/", "production/src/components/features/invoices/",
  "production/src/components/features/projects/", "production/src/components/features/items/",
  "production/src/components/features/trials/",
];
const KINDS = ["input-no-name", "label-no-for", "modal-no-trap"];

type Hit = { file: string; kind: string; lines: number[] };

describe("billing screens stay accessible (R-022)", () => {
  it("no unnamed inputs, untied labels or trap-less popups", () => {
    const detail = (a11yReport() as { detail: Record<string, Hit[]> }).detail;
    const hits = Object.values(detail).flat()
      .filter((h) => KINDS.includes(h.kind) && BILLING.some((p) => h.file.startsWith(p)))
      .map((h) => `${h.file}:${h.lines.join(",")} ${h.kind}`);
    expect(hits).toEqual([]);
  }, 60_000);
});
