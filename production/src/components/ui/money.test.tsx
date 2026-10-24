// @vitest-environment jsdom
//
// The formatting itself is covered in lib/utils.test.ts. What's locked here is
// the *invariant* this component exists for: every rupee figure renders with
// tabular numerals (so live-updating numbers don't make rows jitter), and the
// semantic colour roles stay fixed.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Money } from "./money";

afterEach(cleanup);

const el = (ui: React.ReactElement) => {
  const { container } = render(ui);
  return container.firstElementChild as HTMLElement;
};

describe("Money — the non-negotiable", () => {
  it("ALWAYS sets tabular-nums, whatever the size or tone", () => {
    // This is the whole reason the component exists: a proportional figure
    // changes width as it updates and the row visibly jumps.
    for (const size of ["display", "cell", "inline"] as const) {
      for (const tone of ["default", "positive", "negative", "muted"] as const) {
        cleanup();
        expect(el(<Money amount={50_000} size={size} tone={tone} />).className)
          .toContain("tabular-nums");
      }
    }
  });

  it("keeps tabular-nums even when a caller passes its own classes", () => {
    expect(el(<Money amount={1000} className="text-right w-full" />).className)
      .toContain("tabular-nums");
  });
});

describe("Money — rendering", () => {
  it("formats in Indian grouping", () => {
    render(<Money amount={1_560_000} />);
    expect(screen.getByText("₹15,60,000")).toBeDefined();
  });

  it("renders an em dash for null/undefined — never ₹0 or ₹NaN", () => {
    // An unpriced record is not a zero-value record.
    render(<Money amount={null} />);
    expect(screen.getByText("—")).toBeDefined();
    cleanup();
    render(<Money amount={undefined} />);
    expect(screen.getByText("—")).toBeDefined();
  });

  it("still renders a real zero as ₹0", () => {
    render(<Money amount={0} />);
    expect(screen.getByText("₹0")).toBeDefined();
  });

  it("compact keeps the full figure reachable in the title", () => {
    const node = el(<Money amount={1_560_000} compact />);
    expect(node.textContent).toBe("₹15.6L");
    expect(node.getAttribute("title")).toBe("₹15,60,000");
  });
});

describe("Money — semantic colour roles", () => {
  it("maps each tone to its reserved colour", () => {
    expect(el(<Money amount={1} tone="positive" />).className).toContain("text-emerald");
    cleanup();
    expect(el(<Money amount={1} tone="negative" />).className).toContain("text-rose");
    cleanup();
    expect(el(<Money amount={1} tone="muted" />).className).toContain("text-ink-3");
    cleanup();
    expect(el(<Money amount={1} />).className).toContain("text-ink");
  });

  it("colours a negative amount rose without being asked", () => {
    expect(el(<Money amount={-5_000} />).className).toContain("text-rose");
  });

  it("respects autoNegative={false} where a negative is expected and neutral", () => {
    // e.g. a GST input credit, which is a normal negative, not an alarm.
    const node = el(<Money amount={-5_000} autoNegative={false} />);
    expect(node.className).toContain("text-ink");
    expect(node.className).not.toContain("text-rose");
  });

  it("does not override an explicit tone with the negative rule", () => {
    expect(el(<Money amount={-5_000} tone="muted" />).className).toContain("text-ink-3");
  });

  it("greys a missing amount rather than colouring it", () => {
    // R-1135: muted grey that still reads at 4.5:1 (ink-4 is for placeholders only).
    expect(el(<Money amount={null} tone="positive" />).className).toContain("text-ink-3");
  });
});

describe("Money — size variants follow the project's type hierarchy", () => {
  it("display uses the serif face (§6: big numbers are serif, mono is for IDs)", () => {
    expect(el(<Money amount={1} size="display" />).className).toContain("font-serif");
  });
  it("cell stays in the UI sans at table density", () => {
    expect(el(<Money amount={1} size="cell" />).className).not.toContain("font-serif");
  });
});
