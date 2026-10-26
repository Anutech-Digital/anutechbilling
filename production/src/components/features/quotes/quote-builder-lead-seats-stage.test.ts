import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/* R-1959: Pardeep, localhost — a lead made from a quote showed Seats "—" for a 10-seat custom
   line, and a draft quote left the lead at New. Both lead paths of the builder (the new
   prospect lead and the existing lead) must use the SAME two helpers. */
const src = readFileSync("src/components/features/quotes/quote-builder.tsx", "utf8");

describe("R-1959: quote builder — one seats helper and one stage rule for every lead path", () => {
  it("no lead path counts seats with quoteSeatCount(...) ?? 0 (a custom line gave 0)", () => {
    expect(src).not.toMatch(/quoteSeatCount\(lineItems\)\s*\?\?\s*0/);
  });
  it("the new prospect lead and the existing-lead update both use leadSeatCount", () => {
    expect((src.match(/leadSeatCount\(lineItems\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it("the existing lead moves on a draft (stageAfterQuoteSaved) as well as on a send", () => {
    /* A send keeps the direct stageAfterQuoteSent call that quote-sent-stage-wiring.test.ts
       pins (stageAfterQuoteSaved(stage, true) is exactly that); a draft goes through
       stageAfterQuoteSaved(stage, false) — New → Contacted, never backward. */
    expect(src).toMatch(/stageAfterQuoteSent\(leadFromQuery\?\.stage\)/);
    expect(src).toMatch(/stageAfterQuoteSaved\(leadFromQuery\?\.stage,\s*false\)/);
    expect(src).toMatch(/draftMove\.nextStage !== null && \{ stage: draftMove\.nextStage \}/);
  });
});
