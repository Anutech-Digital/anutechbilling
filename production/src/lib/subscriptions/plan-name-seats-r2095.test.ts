/* R-2095 (staging 5f52fc6, 30 Oct 2026): Add Subscription → "Payment Received" saved the plan as
   "Google Workspace Business Starter (2 seats)" — same family as R-812. The plan is the catalogue
   name; seats live in the seats column. Rows already saved with "(N seats)" are read without it. */
import { describe, expect, it } from "vitest";
import { onboardingQuoteLine } from "@/components/features/subscriptions/onboarding-line";
import { billingTerms } from "@/lib/subscriptions/catalog-options";
import { catalogPlanName, planKey } from "./plan-match";

describe("R-2095 plan name without '(N seats)'", () => {
  it("the onboarding line is named by the plan alone", () => {
    const line = onboardingQuoteLine({ id: "l", plan: "Google Workspace Business Starter", seats: 2, pricePerSeat: 3240, terms: billingTerms("annual_yearly"), startDate: "2026-10-30" });
    expect(line.name).toBe("Google Workspace Business Starter");
    expect(line.qty).toBe(2);
  });
  it("an old '(2 seats)' name reads as the catalogue name", () => {
    expect(catalogPlanName("Google Workspace Business Starter (2 seats)")).toBe("Google Workspace Business Starter");
    expect(catalogPlanName("Zoho Mail Lite (1 seat)")).toBe("Zoho Mail Lite");
    expect(catalogPlanName("Microsoft 365 Basic")).toBe("Microsoft 365 Basic");
    expect(planKey("Google Workspace Business Starter (2 seats)")).toBe(planKey("Google Workspace Business Starter"));
  });
});
