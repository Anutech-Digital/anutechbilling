/**
 * R-2567: when the project-invoices read failed, Companies showed TWO "Try again" buttons — the
 * generic money banner (R-1806) and R-2562's "Project invoices couldn't be read" line. One failure,
 * one Try again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { moneyErrorRetry } from "./money-error-retry";

describe("R-2567 moneyErrorRetry — exactly one Try again for a failed money read", () => {
  it("only the owed reads failed and the line is on screen → the line's button, no banner", () => {
    expect(moneyErrorRetry({ failed: 1, owedFailed: 1, owedLineShown: true })).toEqual({ banner: false, lineButton: true });
    expect(moneyErrorRetry({ failed: 2, owedFailed: 2, owedLineShown: true })).toEqual({ banner: false, lineButton: true });
  });
  it("another money read failed too → the banner (it retries all), the line keeps its words but no button", () => {
    expect(moneyErrorRetry({ failed: 2, owedFailed: 1, owedLineShown: true })).toEqual({ banner: true, lineButton: false });
  });
  it("the line is not on screen (another view, a search) → the banner", () => {
    expect(moneyErrorRetry({ failed: 1, owedFailed: 1, owedLineShown: false })).toEqual({ banner: true, lineButton: false });
  });
  it("nothing failed → neither", () => {
    expect(moneyErrorRetry({ failed: 0, owedFailed: 0, owedLineShown: false })).toEqual({ banner: false, lineButton: false });
  });
});

describe("R-2567 Companies page uses it for both places", () => {
  const src = readFileSync("src/app/(app)/customers/page.tsx", "utf8");
  it("the banner and the line's Try again are both gated by moneyErrorRetry", () => {
    expect(src).toMatch(/moneyRetry\.banner\s*&&\s*\(\s*<LoadErrorBanner/);
    expect(src).toMatch(/moneyRetry\.lineButton\s*&&\s*\(?\s*<Button[^>]*onClick=\{retryOwed\}/);
  });
});
