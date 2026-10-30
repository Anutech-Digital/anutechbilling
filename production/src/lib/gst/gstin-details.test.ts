/** R-2168: GSTN's lstupdt is when the registration record was last updated — not a return
 *  filing date. Rows cached before the rename carry it as last_return_filed; read both. */
import { describe, it, expect } from "vitest";
import { gstDetailsLastUpdated, GST_DETAILS_LAST_UPDATED_LABEL } from "./gstin-details";

describe("gstDetailsLastUpdated", () => {
  it("reads the new field", () => {
    expect(gstDetailsLastUpdated({ details_last_updated: "2026-03-04" })).toBe("2026-03-04");
  });
  it("reads a cached row saved before the rename", () => {
    expect(gstDetailsLastUpdated({ last_return_filed: "2026-03-04" })).toBe("2026-03-04");
  });
  it("prefers the new field, null when neither", () => {
    expect(gstDetailsLastUpdated({ details_last_updated: "2026-05-01", last_return_filed: "2026-03-04" })).toBe("2026-05-01");
    expect(gstDetailsLastUpdated({})).toBeNull();
    expect(gstDetailsLastUpdated(null)).toBeNull();
  });
  it("the label never claims a return was filed", () => {
    expect(GST_DETAILS_LAST_UPDATED_LABEL).toBe("GST details last updated");
  });
});

describe("no screen says 'Last return filed' (R-2168)", () => {
  it("the verify card uses the helper and the new label", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const s = readFileSync(join(process.cwd(), "src/components/features/gstin/gstin-verify-card.tsx"), "utf8");
    expect(s).not.toMatch(/Last return filed/i);
    expect(s).toMatch(/gstDetailsLastUpdated\(/);
  });
});
