// @vitest-environment jsdom
/**
 * R-2175 (checker FAIL 2 + 3): a PERSONAL session opening Help made the data gateway refuse
 * `feedback` (the "already reported?" matcher, help-report-matches.tsx) and `page_test_runs`
 * (AI Help's last test run) — business tables the personal allowlist (R-2125) never opens.
 * businessTenantId() is the one rule both readers use: the tenant for a business session, null
 * for a personal one (null = the reader does not run, exactly as for a signed-out user).
 * And the personal bell's empty state no longer talks about follow-ups and leads.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { businessTenantId } from "@/lib/workspace/kind";
import { bellEmptyBody } from "@/components/layout/notification-panel";

const me: { data: Record<string, unknown> } = { data: {} };
vi.mock("next/navigation", () => ({ usePathname: () => "/vault/personal", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => me }));
vi.mock("@/lib/queries/feedback", () => ({ useSubmitFeedback: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("./help-report-matches", () => ({
  HelpReportMatches: ({ tenantId }: { tenantId: string | null }) => <div data-testid="matches" data-tenant={tenantId ?? ""} />,
}));

import { HelpReportTab } from "./help-report-tab";

afterEach(() => cleanup());

describe("businessTenantId (R-2175)", () => {
  it("business session → its tenant", () => {
    expect(businessTenantId({ role: "owner", tenantId: "t1" })).toBe("t1");
    expect(businessTenantId({ role: "employee", tenantId: "t1" })).toBe("t1");
  });
  it("personal session, no identity or no tenant → null", () => {
    expect(businessTenantId({ role: "personal", tenantId: "t1" })).toBeNull();
    expect(businessTenantId(null)).toBeNull();
    expect(businessTenantId(undefined)).toBeNull();
    expect(businessTenantId({ role: "owner", tenantId: null })).toBeNull();
  });
});

describe("Help → Report a problem: the 'already reported?' matcher (R-2175)", () => {
  const renderTab = () => render(
    <HelpReportTab pathname="/vault/personal" getTrail={() => []} caughtError={null} onCaughtErrorUsed={() => {}} onFiled={() => {}} />,
  );
  it("a business user's matcher reads their company's reports", () => {
    me.data = { tenantId: "t1", userId: "u1", role: "owner", fullName: "O", authEmail: "o@x.in" };
    renderTab();
    expect(screen.getByTestId("matches").getAttribute("data-tenant")).toBe("t1");
  });
  it("a personal session's matcher gets no tenant, so it never reads `feedback`", () => {
    me.data = { tenantId: "t1", userId: "u1", role: "personal", fullName: "P", authEmail: "p@x.in" };
    renderTab();
    expect(screen.getByTestId("matches").getAttribute("data-tenant")).toBe("");
  });
});

describe("the bell's empty state (R-2175)", () => {
  it("business wording unchanged", () => {
    expect(bellEmptyBody(true)).toBe("Follow-ups due today and new leads will show up here.");
  });
  it("personal wording says nothing about leads or follow-ups", () => {
    const t = bellEmptyBody(false);
    expect(t).not.toMatch(/lead|follow-up/i);
    expect(t.length).toBeGreaterThan(10);
  });
});
