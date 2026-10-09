import { describe, it, expect } from "vitest";
import { parseLineQty, parseLineRate, firstLineInputProblem, builderIsDirty, MAX_LINE_QTY } from "./line-input";

describe("R-449: quote line Qty", () => {
  it("0 is refused with a message — it used to charge one seat silently", () => {
    expect(parseLineQty("0")).toEqual({ ok: false, problem: "Quantity must be 1 or more." });
  });
  it("an empty box is refused, not read as 1", () => {
    expect(parseLineQty("")).toEqual({ ok: false, problem: "Enter a quantity of 1 or more." });
  });
  it("negative, fractional and absurd values are refused", () => {
    expect(parseLineQty("-3").ok).toBe(false);
    expect(parseLineQty("2.5")).toEqual({ ok: false, problem: "Quantity must be a whole number." });
    expect(parseLineQty(String(MAX_LINE_QTY + 1)).ok).toBe(false);
  });
  it("a normal quantity passes", () => {
    expect(parseLineQty("25")).toEqual({ ok: true, value: 25 });
  });
});

describe("R-449: quote line Rate", () => {
  it("−100 is refused — it used to become 0100 / ₹100", () => {
    expect(parseLineRate("-100")).toEqual({ ok: false, problem: "Rate can't be negative. Use the quote discount instead." });
  });
  it("an empty box (what the browser gives for a lone '-') is not 0", () => {
    expect(parseLineRate("").ok).toBe(false);
  });
  it("0 is allowed (a free line), normal and decimal rates pass", () => {
    expect(parseLineRate("0")).toEqual({ ok: true, value: 0 });
    expect(parseLineRate("3240")).toEqual({ ok: true, value: 3240 });
    expect(parseLineRate("12.5")).toEqual({ ok: true, value: 12.5 });
  });
  it("an extra-zero slip is caught", () => {
    expect(parseLineRate("324000000").ok).toBe(false);
  });
  it("firstLineInputProblem names the first bad box", () => {
    expect(firstLineInputProblem({ a: undefined, b: "Quantity must be 1 or more." })).toBe("Quantity must be 1 or more.");
    expect(firstLineInputProblem({})).toBeNull();
  });
});

describe("R-472: builder dirty only after the user changes something", () => {
  it("a prefilled screen nobody touched is not dirty", () => {
    expect(builderIsDirty(null, '{"lines":[1]}')).toBe(false);
  });
  it("touched but unchanged is not dirty; changed is", () => {
    expect(builderIsDirty('{"lines":[1]}', '{"lines":[1]}')).toBe(false);
    expect(builderIsDirty('{"lines":[1]}', '{"lines":[1,2]}')).toBe(true);
  });
});
