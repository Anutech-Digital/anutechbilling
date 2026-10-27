// @vitest-environment jsdom
/* R-1842 — Settings → Company → Compliance profile: picking a different business type shows what
   will change before anything is saved; Cancel saves nothing; the button names the action. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  saved: { businessType: "proprietor", gstFiling: "monthly", columnsMissing: false } as Record<string, unknown>,
  mutate: vi.fn(),
}));
vi.mock("@/lib/compliance/profile", () => ({
  useComplianceProfile: () => ({ data: state.saved, isLoading: false, isError: false }),
  useSaveComplianceProfile: () => ({ mutate: state.mutate, isPending: false }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: null }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ComplianceProfileCard } from "./compliance-profile-card";

function renderCard() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><ComplianceProfileCard isOwner /></QueryClientProvider>);
}
const typeButton = (name: string) =>
  within(screen.getByRole("group", { name: "Business type" })).getByRole("button", { name });

beforeEach(() => {
  state.saved = { businessType: "proprietor", gstFiling: "monthly", columnsMissing: false };
  state.mutate.mockReset();
});
afterEach(cleanup);

describe("ComplianceProfileCard — 'what will change' before saving a new business type", () => {
  it("Proprietor → Pvt Ltd: Save shows the filings that come in and ITR-3 → ITR-6, and saves nothing yet", () => {
    renderCard();
    fireEvent.click(typeButton("Pvt Ltd"));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(state.mutate).not.toHaveBeenCalled();
    const panel = screen.getByRole("region", { name: "What will change" });
    const text = panel.textContent ?? "";
    for (const f of ["AOC-4", "MGT-7A", "ADT-1", "AGM"]) expect(text).toContain(f);
    expect(text).toContain("ITR-3 on the owner's PAN");
    expect(text).toContain("ITR-6 for the company");
    expect(text).toContain("Share capital + Reserves and surplus");
    expect(text).toMatch(/correction/i);
    expect(text).toMatch(/new company/i);
  });

  it("the confirm button names the action and saves the new type", () => {
    renderCard();
    fireEvent.click(typeButton("Partnership"));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Change to Partnership" }));
    expect(state.mutate).toHaveBeenCalledWith({ business_type: "partnership", gst_filing: "monthly" });
  });

  it("Cancel saves nothing and puts the stored type back", () => {
    renderCard();
    fireEvent.click(typeButton("Pvt Ltd"));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "What will change" })).toBeNull();
    expect(typeButton("Proprietor").getAttribute("aria-pressed")).toBe("true");
  });

  it("only the GST mode changed: saves straight away, no confirm", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "QRMP (quarterly)" }));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(screen.queryByRole("region", { name: "What will change" })).toBeNull();
    expect(state.mutate).toHaveBeenCalledWith({ business_type: "proprietor", gst_filing: "qrmp" });
  });

  it("type not set yet → Pvt Ltd: nothing changes (not set already means Pvt Ltd), so it saves straight away", () => {
    state.saved = { businessType: null, gstFiling: null, columnsMissing: false };
    renderCard();
    fireEvent.click(typeButton("Pvt Ltd"));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(state.mutate).toHaveBeenCalledWith({ business_type: "pvt_ltd" });
  });

  it("the hint under the type comes from the shared helper", () => {
    renderCard();
    expect(screen.getByText("No ROC filings. ITR-3 on the owner's PAN.")).toBeTruthy();
  });
});
