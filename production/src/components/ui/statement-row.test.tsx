// @vitest-environment jsdom
/**
 * R-1899 — every statement report row lights up across its full width on hover and on keyboard
 * focus, from ONE shared style (statement-row.tsx), with the contrast still at AA in light and dark.
 *
 * Pardeep (25 Oct, staging P&L): "kisi row ke upar mouse aane par wo poori row highlight honi
 * chahiye" — on a long line the label is far left and the amount far right.
 */
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { StatementRow, STATEMENT_ROW } from "./statement-row";
import { Row, SubRows, UnknownRow } from "@/app/(app)/accounting/pnl/statement-rows";

afterEach(cleanup);

const SRC = path.join(process.cwd(), "src");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("R-1899: the shared statement row", () => {
  it("highlights on hover (real hover devices only — no stuck tint on a phone) and on focus-within", () => {
    expect(STATEMENT_ROW).toContain("[@media(hover:hover)]:hover:bg-paper-2");
    expect(STATEMENT_ROW).toContain("focus-within:bg-paper-2");
    /* A bare `hover:` would leave the last tapped row tinted on a phone. */
    expect(STATEMENT_ROW.split(" ")).not.toContain("hover:bg-paper-2");
  });

  it("darkens red / amber figures inside a highlighted row so they stay at AA", () => {
    expect(STATEMENT_ROW).toContain("[@media(hover:hover)]:[&:hover_.text-rose]:text-rose-ink");
    expect(STATEMENT_ROW).toContain("[&:focus-within_.text-rose]:text-rose-ink");
    expect(STATEMENT_ROW).toContain("[&:focus-within_.text-amber]:text-amber-ink");
  });

  it("<StatementRow> bleeds past the text and gets a pointer only when the row itself is clickable", () => {
    render(
      <>
        <StatementRow data-testid="plain">Rent</StatementRow>
        <StatementRow data-testid="click" clickable>Owner&apos;s capital</StatementRow>
      </>,
    );
    const plain = screen.getByTestId("plain");
    const click = screen.getByTestId("click");
    for (const el of [plain, click]) {
      expect(el.className).toContain("focus-within:bg-paper-2");
      expect(el.className).toContain("-mx-2");
      expect(el.className).toContain("px-2");
    }
    expect(plain.className).not.toContain("cursor-pointer");
    expect(click.className).toContain("cursor-pointer");
  });
});

describe("R-1899: the P&L rows use it — main lines, unknown lines and the category lines", () => {
  it("Revenue, an unknown line and every expense category are statement rows", () => {
    const { container } = render(
      <>
        <Row label="Revenue" amount={400000} tone="ink" />
        <UnknownRow label="Gross Margin" value="Unknown" note="needs the cost of goods" />
        <SubRows
          group={{
            lines: [
              { key: "salaries", label: "Salaries", now: 120000, was: null, sense: "more-is-bad", kind: "item" },
              { key: "rent", label: "Rent", now: 50000, was: null, sense: "more-is-bad", kind: "item" },
            ],
            itemCount: 2,
          } as never}
          cmpOn={false} cmpLoading={false} showAll={false} onToggleAll={() => {}} onOpen={() => {}}
        />
      </>,
    );
    const rows = container.querySelectorAll("[data-statement-row]");
    expect(rows.length).toBe(4);
    const text = Array.from(rows).map((r) => r.textContent);
    expect(text[0]).toContain("Revenue");
    expect(text[1]).toContain("Gross Margin");
    expect(text[2]).toContain("Salaries");
    expect(text[3]).toContain("Rent");
    /* The row is not itself clickable — the category name is the button — so no pointer on the row. */
    for (const r of Array.from(rows)) expect(r.className).not.toContain("cursor-pointer");
  });
});

describe("R-1899: every statement report takes the row style from the one shared file", () => {
  const reports = [
    "app/(app)/accounting/pnl/statement-rows.tsx",
    "app/(app)/accounting/pnl/page.tsx",
    "app/(app)/accounting/balance-sheet/bs-lines.tsx",
    "app/(app)/accounting/balance-sheet/page.tsx",
    "app/(app)/accounting/trial-balance/page.tsx",
    "app/(app)/accounting/gst/page.tsx",
    "app/(app)/accounting/cash-flow/page.tsx",
  ];
  it.each(reports)("%s imports @/components/ui/statement-row", (rel) => {
    expect(read(rel)).toMatch(/from "@\/components\/ui\/statement-row"/);
  });

  it("no statement report keeps its own one-off row hover tint", () => {
    for (const rel of ["app/(app)/accounting/balance-sheet/bs-lines.tsx", "app/(app)/accounting/cash-flow/page.tsx"]) {
      expect(read(rel)).not.toMatch(/hover:bg-paper-2\/(40|50)/);
    }
  });

  it("Balance Sheet totals do not force red with !text-rose (the highlight could not darken it)", () => {
    expect(read("app/(app)/accounting/balance-sheet/bs-lines.tsx")).not.toContain("!text-rose");
  });
});

/* ─── Contrast, computed from the real tokens in globals.css, light AND dark ─── */
function tokens(block: "root" | "dark"): Record<string, [number, number, number]> {
  const css = read("app/globals.css");
  const start = block === "root" ? css.indexOf(":root {") : css.indexOf(".dark {");
  const body = css.slice(start, css.indexOf("}", start));
  const out: Record<string, [number, number, number]> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g)) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}
function lum([h, s, l]: [number, number, number]): number {
  const S = s / 100, L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
}
const ratio = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe.each(["root", "dark"] as const)("R-1899: contrast on the highlighted row (%s)", (mode) => {
  const t = tokens(mode);
  it("the highlight token exists in this mode and differs from the page", () => {
    expect(t["paper-2"]).toBeDefined();
    expect(t["paper-2"]).not.toEqual(t.paper);
  });
  it.each(["ink", "ink-2", "ink-3", "rose-ink", "amber-ink", "emerald"])("%s on paper-2 is at least 4.5:1", (fg) => {
    expect(ratio(t[fg], t["paper-2"])).toBeGreaterThanOrEqual(4.5);
  });
});

it("R-1899: light mode — text-rose on paper-2 is under AA, which is why the row swaps it to rose-ink", () => {
  const t = tokens("root");
  expect(ratio(t.rose, t["paper-2"])).toBeLessThan(4.5);
});
