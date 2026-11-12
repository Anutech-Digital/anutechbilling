// @vitest-environment jsdom
/** R-2013: "Your rights" on /privacy-policy links to the request form (/privacy/request). */
import * as React from "react";
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { LegalDoc } from "./LegalDoc";

/* R-2720: no vitest `globals` = no automatic Testing Library cleanup. The page's real next/link
   leaves requestIdleCallback fallback timers that set state; left mounted they fire after jsdom is
   torn down ("window is not defined", red CI with every test passing). Unmounting cancels them. */
afterEach(cleanup);

describe("/privacy-policy #your-rights", () => {
  it("has a link to the data request form", () => {
    const { container } = render(<LegalDoc page="privacy" />);
    const block = container.querySelector("#your-rights")!;
    const a = block.querySelector('a[href="/privacy/request"]');
    expect(a?.textContent).toBe("Make a request about your data");
  });
});
