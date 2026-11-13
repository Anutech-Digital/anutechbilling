/** R-2710 — a renewal quote changed to 3 years says so on the PDF / email / accept page (they all read
 *  the period from extension_months, which quotes_r2710_renewal_term_follows_years keeps at 36). */
import { it, expect } from "vitest";
import { linePeriodText, quoteLinePeriodContext } from "./service-period";

it("renewal for 30 Nov 2026, extension 36 months → 'Subscription period: 3 Years (01/12/2026 – 30/11/2029)'", () => {
  const ctx = quoteLinePeriodContext({ is_renewal: true, extension_months: 36, renewal_term_date: "2026-11-30" } as never, null);
  expect(linePeriodText({ name: "Domain Registration .com", commitment: "annual_yearly" }, ctx))
    .toBe("Subscription period: 3 Years (01/12/2026 – 30/11/2029)");
});
