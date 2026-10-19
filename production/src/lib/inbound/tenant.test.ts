/** R-1555 — inboundTenantId: no silent Anutech fallback on a deployed server. */
import { describe, it, expect } from "vitest";
import { inboundTenantId, inboundTenantMissingMessage } from "./tenant";

const DEV = "fbb976f1-9090-4f10-9726-0901bd144e42";

describe("inboundTenantId", () => {
  it("INBOUND_EMAIL_TENANT_ID first, then BUY_PAGE_TENANT_ID", () => {
    expect(inboundTenantId({ INBOUND_EMAIL_TENANT_ID: " a ", BUY_PAGE_TENANT_ID: "b", NODE_ENV: "production" })).toBe("a");
    expect(inboundTenantId({ BUY_PAGE_TENANT_ID: "b", NODE_ENV: "production" })).toBe("b");
  });
  it("deployed + nothing set → null (route answers 503)", () => {
    expect(inboundTenantId({ NODE_ENV: "production" })).toBeNull();
    expect(inboundTenantId({ NEXT_PUBLIC_APP_ENV: "staging" })).toBeNull();
    expect(inboundTenantId({ K_SERVICE: "resellersos" })).toBeNull();
    expect(inboundTenantId({ NODE_ENV: "production", INBOUND_EMAIL_TENANT_ID: "  " })).toBeNull();
  });
  it("laptop keeps the dev tenant", () => {
    expect(inboundTenantId({ NODE_ENV: "development" })).toBe(DEV);
  });
  it("refusal message names the env vars", () => {
    expect(inboundTenantMissingMessage("x")).toMatch(/INBOUND_EMAIL_TENANT_ID[\s\S]*BUY_PAGE_TENANT_ID/);
  });
});
