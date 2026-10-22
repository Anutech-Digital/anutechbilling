// @vitest-environment jsdom
/**
 * R-1734: when the server says GSTN verification is not set up, the card shows that message
 * next to the button and never hands anything to the host form (onVerified / Fill form).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import GstinVerifyCard from "./gstin-verify-card";

const GSTIN = "07AAACR5055K1Z9";
const NOT_SET_UP = "GSTN verification is not set up — enter the details from the GST certificate.";

function renderCard(onVerified: () => void, onFillForm: () => void) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <GstinVerifyCard gstin={GSTIN} noPersist onVerified={onVerified} onFillForm={onFillForm} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GstinVerifyCard — provider not configured", () => {
  it("shows the message, fills nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, code: "provider_not_configured", error: NOT_SET_UP }), { status: 200 }),
    ));
    const onVerified = vi.fn();
    const onFillForm = vi.fn();
    renderCard(onVerified, onFillForm);
    fireEvent.click(screen.getByRole("button", { name: /Verify with GSTN/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(NOT_SET_UP));
    expect(onVerified).not.toHaveBeenCalled();
    expect(onFillForm).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Fill form from GST/ })).toBeNull();
  });

  it("mock answer (laptop) still reaches the host", async () => {
    const v = { status: "Active", legal_name: "AAACR Technologies Private Limited", source: "mock" };
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, mock: true, verification: v }), { status: 200 }),
    ));
    const onVerified = vi.fn();
    renderCard(onVerified, vi.fn());
    fireEvent.click(screen.getByRole("button", { name: /Verify with GSTN/ }));
    await waitFor(() => expect(onVerified).toHaveBeenCalledWith(v));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
