// @vitest-environment jsdom
/* R-2823 — the Renewals row's vendor hold reads in words ("Hold at Google — unpaid"), the lock icon kept;
   the other flags stay icon-only with their reason as the accessible name. */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { StageFlagIcon } from "./stage-flag";

afterEach(cleanup);

describe("StageFlagIcon (R-2823)", () => {
  it("vendor hold: icon + the words on the row", () => {
    render(<StageFlagIcon flag={{ key: "vendorHold", reason: "Payment due — do not renew at the vendor yet", words: "Hold at Google — unpaid" }} />);
    const el = document.querySelector('[data-flag="vendorHold"]')!;
    expect(el.textContent).toBe("Hold at Google — unpaid");
    expect(el.querySelector("svg")).toBeTruthy();
    expect(el.getAttribute("title")).toBe("Payment due — do not renew at the vendor yet");
    expect(screen.getByRole("img", { name: "Hold at Google — unpaid: Payment due — do not renew at the vendor yet" })).toBe(el);
  });

  it("a flag without words stays an icon with its reason as the name", () => {
    render(<StageFlagIcon flag={{ key: "followUpDue", reason: "Follow-up due" }} />);
    expect(screen.getByRole("img", { name: "Follow-up due" }).textContent).toBe("");
  });
});
