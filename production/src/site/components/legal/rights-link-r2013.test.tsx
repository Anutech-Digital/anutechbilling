// @vitest-environment jsdom
/** R-2013: "Your rights" on /privacy-policy links to the request form (/privacy/request). */
import * as React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LegalDoc } from "./LegalDoc";

describe("/privacy-policy #your-rights", () => {
  it("has a link to the data request form", () => {
    const { container } = render(<LegalDoc page="privacy" />);
    const block = container.querySelector("#your-rights")!;
    const a = block.querySelector('a[href="/privacy/request"]');
    expect(a?.textContent).toBe("Make a request about your data");
  });
});
