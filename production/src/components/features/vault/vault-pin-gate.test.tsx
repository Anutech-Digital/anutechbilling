// @vitest-environment jsdom
//
// R-2112 / GP-02b — the PIN gate fails CLOSED. Before: `if (!status?.configured …) return
// children` — when the status request failed (network, 500, expired session) `status` was
// undefined, so the private vault opened with no PIN asked. Now a failed or empty status
// keeps the vault hidden and offers a retry.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

type Status = { configured: boolean; locked: boolean; retryAfterSec: number; attemptsLeft: number };
let pinStatus: { data?: Status; isLoading: boolean; isError: boolean; error?: unknown; refetch: () => void };
const refetch = vi.fn();

vi.mock("@/lib/queries/personal-vault", () => ({
  usePinStatus: () => pinStatus,
  useVerifyPin: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { VaultPinGate } from "./vault-pin-gate";

const SECRET = "Net worth 1,25,00,000";
const renderGate = () => render(<VaultPinGate><p>{SECRET}</p></VaultPinGate>);

afterEach(() => {
  cleanup();
  refetch.mockClear();
});

describe("GP-02b: VaultPinGate fails closed", () => {
  it("a failed status fetch keeps the vault locked and offers a retry", () => {
    pinStatus = { data: undefined, isLoading: false, isError: true, error: new Error("Could not load PIN status"), refetch };
    renderGate();
    expect(screen.queryByText(SECRET)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("a status request that returns nothing keeps the vault locked", () => {
    pinStatus = { data: undefined, isLoading: false, isError: false, refetch };
    renderGate();
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("a locked PIN shows the lock screen, not the vault", () => {
    pinStatus = { data: { configured: true, locked: true, retryAfterSec: 600, attemptsLeft: 0 }, isLoading: false, isError: false, refetch };
    renderGate();
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByText(/Private Vault is locked/)).toBeTruthy();
  });

  it("no PIN configured (a real answer) still opens the vault", () => {
    pinStatus = { data: { configured: false, locked: false, retryAfterSec: 0, attemptsLeft: 5 }, isLoading: false, isError: false, refetch };
    renderGate();
    expect(screen.getByText(SECRET)).toBeTruthy();
  });
});
