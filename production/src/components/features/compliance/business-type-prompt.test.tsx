// @vitest-environment jsdom
/* While tenants.business_type is empty the app reads it as Pvt Ltd; this prompt asks the owner to set
   it, with a button to Settings → Company → Compliance profile. Shown on the Balance Sheet equity card
   and in Settings → Company. Hidden once a type is set, and while the column is not there yet. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ data: undefined as Record<string, unknown> | undefined }));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: state.data }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { BusinessTypePrompt } from "./business-type-prompt";

afterEach(cleanup);

describe("BusinessTypePrompt", () => {
  it("type empty: asks to set it, with a button to the compliance profile", () => {
    state.data = { businessType: null, gstFiling: null, columnsMissing: false };
    render(<BusinessTypePrompt />);
    expect(screen.getByText("Set your business type — owner/partner/director options depend on it")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Set business type" });
    expect(link.getAttribute("href")).toBe("/settings?tab=company#compliance-profile");
  });

  it("type set: nothing", () => {
    state.data = { businessType: "proprietor", gstFiling: null, columnsMissing: false };
    const { container } = render(<BusinessTypePrompt />);
    expect(container.textContent).toBe("");
  });

  it("still loading, or the column is not there yet: nothing", () => {
    state.data = undefined;
    expect(render(<BusinessTypePrompt />).container.textContent).toBe("");
    cleanup();
    state.data = { businessType: null, gstFiling: null, columnsMissing: true };
    expect(render(<BusinessTypePrompt />).container.textContent).toBe("");
  });
});
