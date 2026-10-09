// @vitest-environment jsdom
/* R-441 — typing 3240 in "Annual, yearly bill" must stay 3240 (it became ₹32.040, monthly
   ₹2.67, because the box was rewritten from the rounded monthly price on every keystroke). */
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { TierPriceInput, displayPrice, parsePrice } from "./tier-price-input";

afterEach(cleanup);

/** The item form's wiring: one stored ₹/seat/month, a monthly box and a yearly (× 12) box. */
function Harness() {
  const [perMonth, setPerMonth] = React.useState(0);
  const toStored = (raw: number, mult: number) => (mult === 12 ? Math.round((raw / 12) * 100) / 100 : raw);
  return (
    <>
      <TierPriceInput aria-label="monthly" value={perMonth} onValue={(n) => setPerMonth(toStored(n, 1))} />
      <TierPriceInput aria-label="yearly" value={perMonth * 12} onValue={(n) => setPerMonth(toStored(n, 12))} />
    </>
  );
}

function typeInto(el: HTMLInputElement, text: string) {
  fireEvent.focus(el);
  let acc = "";
  for (const ch of text) {
    acc += ch;
    fireEvent.change(el, { target: { value: acc } });
  }
}

describe("R-441 TierPriceInput", () => {
  it("typing 3240 in the yearly box keeps 3240 and sets monthly 270", () => {
    render(<Harness />);
    const yearly = screen.getByLabelText("yearly") as HTMLInputElement;
    const monthly = screen.getByLabelText("monthly") as HTMLInputElement;
    typeInto(yearly, "3240");
    expect(yearly.value).toBe("3240");
    expect(monthly.value).toBe("270");
    fireEvent.blur(yearly);
    expect(yearly.value).toBe("3240");
    expect(monthly.value).toBe("270");
  });

  it("cost 1320 a year is 110 a month", () => {
    render(<Harness />);
    const yearly = screen.getByLabelText("yearly") as HTMLInputElement;
    typeInto(yearly, "1320");
    fireEvent.blur(yearly);
    expect((screen.getByLabelText("monthly") as HTMLInputElement).value).toBe("110");
    expect(yearly.value).toBe("1320");
  });

  it("typing in the monthly box fills the yearly box", () => {
    render(<Harness />);
    typeInto(screen.getByLabelText("monthly") as HTMLInputElement, "270");
    expect((screen.getByLabelText("yearly") as HTMLInputElement).value).toBe("3240");
  });

  it("display and parse helpers", () => {
    expect(displayPrice(0)).toBe("");
    expect(displayPrice(32.04000001)).toBe("32.04");
    expect(displayPrice(3240)).toBe("3240");
    expect(parsePrice("")).toBe(0);
    expect(parsePrice("-5")).toBe(0);
    expect(parsePrice("3240")).toBe(3240);
  });
});
