/**
 * R-023 (6 Oct 2026) — the public buy / quote-accept / cart screens: every popup on
 * ui/dialog (focus trap, Esc, focus return), every box named for a screen reader.
 * Measured with the same scanner as `node scripts/a11y-count.mjs --owner pawan`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FILES = [
  "app/(public)/buy/workspace/buy-workspace-client.tsx",
  "app/(public)/quote/[id]/accept/quote-accept-view.tsx",
  "app/(marketing)/cart/page.tsx",
  "app/(public)/assessment/[token]/page.tsx",
  "site/components/domains/DomainLanding.tsx",
  "app/(app)/online-orders/page.tsx",
];
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

type Hit = { file: string; kind: string; lines: number[] };
const KINDS = ["modal-no-trap", "input-no-name", "label-no-for"];

describe("R-023 a11y on the public buy screens", () => {
  it("no hand-made modal, no unnamed box, no orphan label", () => {
    const out = execFileSync(process.execPath, [join(process.cwd(), "scripts", "a11y-count.mjs"), "--json"], { encoding: "utf8" });
    const detail = (JSON.parse(out) as { detail: Record<string, Hit[]> }).detail;
    const hits = Object.values(detail).flat()
      .filter((h) => KINDS.includes(h.kind) && FILES.some((f) => h.file === "production/src/" + f))
      .map((h) => `${h.file}:${h.lines.join(",")} ${h.kind}`);
    expect(hits).toEqual([]);
  }, 60_000);

  it("Buy-now dialog steps aside while Razorpay's window is open, and comes back on dismiss", () => {
    const src = read(FILES[0]);
    // A Radix modal blocks pointer events + focus outside itself; Razorpay's window is outside.
    expect(src).toMatch(/<Dialog open=\{!rzpOpen\}/);
    expect(src).toMatch(/setRzpOpen\(true\);\s*rzp\.open\(\)/);
    expect(src).toMatch(/ondismiss: \(\) => \{\s*setRzpOpen\(false\)/);
  });

  it("PO / accept dialogs cannot be closed while the acceptance is being saved", () => {
    const src = read(FILES[1]);
    expect(src).toMatch(/<Dialog open=\{poOpen\} onOpenChange=\{\(o\) => \{ if \(!o && !accepting\)/);
    expect(src).toMatch(/<Dialog open=\{confirmOpen\} onOpenChange=\{\(o\) => \{ if \(!o && !accepting\)/);
  });
});
