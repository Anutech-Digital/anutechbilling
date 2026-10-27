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
  /* R-1970: the v2 page sections */
  "app/(public)/buy/workspace/_parts/hero.tsx",
  "app/(public)/buy/workspace/_parts/plan-cards.tsx",
  "app/(public)/buy/workspace/_parts/info-sections.tsx",
  "app/(public)/buy/workspace/_parts/site-header.tsx",
  "app/(public)/buy/workspace/_parts/checkout.tsx",
  "app/(public)/buy/workspace/_parts/order-summary.tsx",
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

  /* R-1971: no popup on the buy page any more — checkout is inline, so nothing traps focus
     away from Razorpay's window. The Pay button stays off while that window is open, and
     dismissing it hands the page back. */
  it("buy page: no modal; Pay waits while Razorpay's window is open and comes back on dismiss", () => {
    const checkout = read("app/(public)/buy/workspace/_parts/checkout.tsx");
    expect(read(FILES[0]) + checkout).not.toMatch(/<Dialog\b|@\/components\/ui\/dialog/);
    const submit = read("app/(public)/buy/workspace/_parts/submit-order.ts");
    expect(submit).toMatch(/onRazorpay\(true\);\s*rzp\.open\(\)/);
    expect(submit).toMatch(/ondismiss: \(\) => \{\s*onRazorpay\(false\)/);
    expect(checkout).toMatch(/const busy = co\.busy \|\| rzpOpen;/);
    expect(checkout).toMatch(/disabled=\{busy\}/);
  });

  it("PO / accept dialogs cannot be closed while the acceptance is being saved", () => {
    const src = read(FILES[1]);
    expect(src).toMatch(/<Dialog open=\{poOpen\} onOpenChange=\{\(o\) => \{ if \(!o && !accepting\)/);
    expect(src).toMatch(/<Dialog open=\{confirmOpen\} onOpenChange=\{\(o\) => \{ if \(!o && !accepting\)/);
  });
});
