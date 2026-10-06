// @vitest-environment jsdom
/**
 * R-271 (6 Oct 2026) — form labels a screen reader can follow.
 *
 * The audit counted 114 labels not tied to their box (label-no-for) and 107 inputs with
 * no name (input-no-name). A sighted user reads "Company" above a box and never notices;
 * a screen-reader user tabs into an anonymous "edit text". Three guards:
 *
 *  1. FormField wires itself: with no htmlFor it gives its single control a useId() id and
 *     points the label at it — so every `<FormField label="X"><Input/></FormField>` in the
 *     app is announced by name without each call site remembering an id.
 *  2. The contact form (16 fields) stays at zero on the source counter.
 *  3. A ratchet on the app-wide totals: they may only go DOWN. Fix one elsewhere → lower
 *     the number here in the same commit.
 *
 * Same counter as `node scripts/a11y-count.mjs --json` (a heuristic over source — it does
 * not know about guard 1, so the totals fall only as call sites get explicit ids).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { FormField } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

type Hit = { file: string; kind: string; lines: number[] };
type Report = { totals: Record<string, Record<string, number>>; detail: Record<string, Hit[]> };

const report = (): Report =>
  JSON.parse(execFileSync(process.execPath, [join(process.cwd(), "scripts", "a11y-count.mjs"), "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })) as Report;

/** Measured 6 Oct 2026 after R-271; lowered by R-288 (96/87 → 57/52). Only ever lower these. */
const BASELINE = { "label-no-for": 57, "input-no-name": 52 } as const;

/** R-288: screens that hold secrets or money stay at zero untied labels / unnamed inputs. */
const ZERO_FILES = [
  "components/features/contacts/contact-form.tsx",
  "app/(app)/vault/personal/banking/page.tsx",
  "app/(app)/vault/personal/wealth/page.tsx",
  "app/(app)/vault/personal/expenses/page.tsx",
  "app/(app)/platform/page.tsx",
  "components/features/integrations/razorpay-configure-dialog.tsx",
  "components/features/integrations/whatsapp-configure-dialog.tsx",
  "components/features/integrations/sandbox-configure-dialog.tsx",
];

afterEach(cleanup);

describe("FormField ties its label to its control (R-271)", () => {
  it("with no htmlFor, the label names the input", () => {
    render(<FormField label="Company"><Input placeholder="e.g. Acme" /></FormField>);
    const box = screen.getByLabelText("Company");
    expect(box.tagName).toBe("INPUT");
    expect(box.id).not.toBe("");
  });

  it("two fields get two different ids", () => {
    render(
      <>
        <FormField label="City"><Input /></FormField>
        <FormField label="Website"><Input /></FormField>
      </>,
    );
    expect(screen.getByLabelText("City").id).not.toBe(screen.getByLabelText("Website").id);
  });

  it("an explicit htmlFor / id is left alone", () => {
    render(<FormField label="Full name" htmlFor="full_name"><Input id="full_name" /></FormField>);
    expect(screen.getByLabelText("Full name").id).toBe("full_name");
  });

  it("a child that already has an id is pointed at, not renamed", () => {
    render(<FormField label="Notes"><Input id="my-notes" /></FormField>);
    expect(screen.getByLabelText("Notes").id).toBe("my-notes");
  });
});

describe("a11y ratchet (R-271)", () => {
  const r = report();

  it.each(ZERO_FILES)("%s has no untied label and no unnamed input", (file) => {
    const hits = Object.values(r.detail).flat()
      .filter((h) => h.file.endsWith(file))
      .filter((h) => h.kind === "label-no-for" || h.kind === "input-no-name")
      .map((h) => `${h.kind}:${h.lines.join(",")}`);
    expect(hits).toEqual([]);
  });

  it.each(Object.keys(BASELINE) as (keyof typeof BASELINE)[])("%s total does not grow", (kind) => {
    const total = Object.values(r.totals).reduce((s, t) => s + (t[kind] ?? 0), 0);
    expect(total, `${kind} is ${total}; limit ${BASELINE[kind]}. Fix the new one, or lower the limit if you fixed old ones.`)
      .toBeLessThanOrEqual(BASELINE[kind]);
  });
});
