/* R-1730 — "Customer domain" moved from Record payment to the quote's "Setting up" card. */
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
import { needsDomainSetup } from "./provisioning-card";

const placeholder = { status: "pending", vendor: null, domain: null };

describe("needsDomainSetup (R-1730)", () => {
  it("paid Workspace quote, no domain anywhere → the card asks for it", () => {
    expect(needsDomainSetup({ tasks: [placeholder], quoteDomain: null, planItems: [{ domain: null }] })).toBe(true);
  });
  it("a domain known on the quote, a line or a task → not asked again", () => {
    expect(needsDomainSetup({ tasks: [placeholder], quoteDomain: "acme.com", planItems: [{ domain: null }] })).toBe(false);
    expect(needsDomainSetup({ tasks: [placeholder], quoteDomain: null, planItems: [{ domain: "acme.com" }] })).toBe(false);
    expect(needsDomainSetup({ tasks: [{ ...placeholder, domain: "acme.com" }], quoteDomain: null, planItems: [{ domain: null }] })).toBe(false);
  });
  it("nothing to set up (no tasks, all not required, or no product) → not asked", () => {
    expect(needsDomainSetup({ tasks: [], quoteDomain: null, planItems: [{ domain: null }] })).toBe(false);
    expect(needsDomainSetup({ tasks: [{ ...placeholder, status: "not_required" }], quoteDomain: null, planItems: [{ domain: null }] })).toBe(false);
    expect(needsDomainSetup({ tasks: [placeholder], quoteDomain: null, planItems: [] })).toBe(false);
  });
});
