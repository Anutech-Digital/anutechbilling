// @vitest-environment jsdom
/**
 * R-836 — the mouse wheel over a focused number box must not change it (₹150 became ₹149 in
 * the 1-Click Onboard dialog). jsdom does not step number inputs on wheel, so what is pinned
 * is the mechanism: the focused number box loses focus on wheel (a browser only steps the
 * FOCUSED box), the event is not cancelled (the page still scrolls), and text boxes and
 * unfocused boxes are left alone. Both layers: <Input> itself and the app-wide guard.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Input } from "./input";
import { installNumberWheelGuard } from "@/lib/ui/number-wheel-guard";

afterEach(cleanup);

const wheel = (el: Element) => {
  const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
  el.dispatchEvent(e);
  return e;
};

describe("<Input type=number> on wheel", () => {
  it("a focused price box is blurred, keeps ₹150, and the wheel is not cancelled (page scrolls)", () => {
    const { getByLabelText } = render(<label>Price<Input type="number" defaultValue="150" /></label>);
    const box = getByLabelText("Price") as HTMLInputElement;
    box.focus();
    expect(document.activeElement).toBe(box);
    const e = wheel(box);
    expect(document.activeElement).not.toBe(box);
    expect(box.value).toBe("150");
    expect(e.defaultPrevented).toBe(false);
  });

  it("still calls the caller's own onWheel", () => {
    const onWheel = vi.fn();
    const { getByLabelText } = render(<label>Seats<Input type="number" defaultValue="10" onWheel={onWheel} /></label>);
    const box = getByLabelText("Seats") as HTMLInputElement;
    box.focus();
    fireEvent.wheel(box, { deltaY: 50 });
    expect(onWheel).toHaveBeenCalledTimes(1);
  });

  it("a text box keeps its focus on wheel", () => {
    const { getByLabelText } = render(<label>Name<Input defaultValue="Acme" /></label>);
    const box = getByLabelText("Name") as HTMLInputElement;
    box.focus();
    wheel(box);
    expect(document.activeElement).toBe(box);
  });
});

describe("installNumberWheelGuard (raw <input type=number> anywhere)", () => {
  it("blurs a focused raw number input; leaves other focus alone; cleanup removes it", () => {
    const off = installNumberWheelGuard();
    const { container } = render(
      <div>
        <input type="number" defaultValue="150" aria-label="raw" />
        <input type="text" defaultValue="x" aria-label="text" />
      </div>,
    );
    const raw = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    const text = container.querySelector<HTMLInputElement>('input[type="text"]')!;

    raw.focus();
    const e = wheel(raw);
    expect(document.activeElement).not.toBe(raw);
    expect(raw.value).toBe("150");
    expect(e.defaultPrevented).toBe(false);

    // Wheel over the number box while ANOTHER field is focused changes nothing.
    text.focus();
    wheel(raw);
    expect(document.activeElement).toBe(text);

    off();
    raw.focus();
    wheel(raw);
    expect(document.activeElement).toBe(raw);
  });

  it("is mounted once for the whole app in <Providers>", () => {
    const src = readFileSync(join(process.cwd(), "src/components/providers/index.tsx"), "utf8");
    expect(src).toMatch(/useEffect\(\(\) => installNumberWheelGuard\(\), \[\]\)/);
  });
});
