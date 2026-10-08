// @vitest-environment jsdom
/** R-316 — a word unit ("days") reads "0 days", not "0days"; a symbol unit ("%") stays tight. */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { KPI } from "./kpi";

afterEach(cleanup);

describe("KPI unit spacing", () => {
  it("puts a real space before a word unit", () => {
    const { container } = render(<KPI label="Avg days to close" value="0" unit="days" />);
    expect(container.textContent).toContain("0 days");
    expect(container.textContent).not.toContain("0days");
  });
  it("keeps a symbol unit tight to the number", () => {
    const { container } = render(<KPI label="Reply rate" value="45" unit="%" />);
    expect(container.textContent).toContain("45%");
  });
});
