/** R-1109: the Buy dialog's GST row follows the place of supply. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { workspaceGstLabel } from "./gst-heads";

describe("R-1109 workspaceGstLabel", () => {
  it("Delhi (our state) is CGST + SGST", () => {
    expect(workspaceGstLabel({ stateCode: "07" })).toBe("GST 18% (CGST 9% + SGST 9%)");
  });
  it("Maharashtra is IGST", () => {
    expect(workspaceGstLabel({ stateCode: "27" })).toBe("IGST 18%");
  });
  it("no state yet is a neutral GST 18%", () => {
    expect(workspaceGstLabel({})).toBe("GST 18%");
    expect(workspaceGstLabel({ stateCode: "" })).toBe("GST 18%");
  });
  it("a valid GSTIN gives the state when none was picked", () => {
    expect(workspaceGstLabel({ gstin: "27AAPFU0939F1ZV" })).toBe("IGST 18%");
  });
});

describe("R-1109 wiring", () => {
  /* R-1971: the inline checkout's summary and invoice preview split GST by the buyer's state
     against the website tenant's (_parts/checkout-form.ts gstLines) — never a fixed CGST+SGST. */
  const summary = readFileSync("src/app/(public)/buy/workspace/_parts/order-summary.tsx", "utf8");
  it("the checkout no longer hard-codes CGST 9% + SGST 9%", () => {
    expect(summary).not.toMatch(/\+ GST 18% \(CGST 9% \+ SGST 9%\)/);
    expect(summary).toMatch(/gstLines\(co\.totals\.gst, co\.buyerState, brand\?\.stateCode \?\? null\)/);
  });
});
