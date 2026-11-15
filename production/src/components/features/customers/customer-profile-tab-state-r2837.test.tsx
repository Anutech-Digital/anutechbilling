// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/customers/abc",
  useSearchParams: () => new URLSearchParams(search),
}));

import { useProfileTabState } from "./customer-profile-tab-state";

beforeEach(() => { replace.mockClear(); search = ""; });

describe("R-2837 customer profile tab in the URL", () => {
  it("page: ?tab=transactions&show=payments lands on Transactions → Payments", () => {
    search = "tab=transactions&show=payments";
    const { result } = renderHook(() => useProfileTabState(false));
    expect(result.current.mainTab).toBe("transactions");
    expect(result.current.txnFilter).toBe("payments");
  });

  it("page: no params → Overview / all; junk values fall back", () => {
    const a = renderHook(() => useProfileTabState(false));
    expect(a.result.current.mainTab).toBe("overview");
    search = "tab=nope&show=zzz";
    const b = renderHook(() => useProfileTabState(false));
    expect(b.result.current.mainTab).toBe("overview");
    expect(b.result.current.txnFilter).toBe("all");
  });

  it("page: show is ignored outside Transactions", () => {
    search = "tab=statement&show=payments";
    const { result } = renderHook(() => useProfileTabState(false));
    expect(result.current.mainTab).toBe("statement");
    expect(result.current.txnFilter).toBe("all");
  });

  it("page: picking a tab / segment writes the URL (replace, no scroll jump)", () => {
    const { result } = renderHook(() => useProfileTabState(false));
    act(() => result.current.setMainTab("transactions"));
    expect(replace).toHaveBeenLastCalledWith("/customers/abc?tab=transactions", { scroll: false });
    act(() => result.current.setTxnFilter("invoices"));
    expect(replace).toHaveBeenLastCalledWith("/customers/abc?tab=transactions&show=invoices", { scroll: false });
    act(() => result.current.setMainTab("overview"));
    expect(replace).toHaveBeenLastCalledWith("/customers/abc", { scroll: false });
  });

  it("page: keeps other params (e.g. from=) and drops show on tab change", () => {
    search = "from=renewals&tab=transactions&show=quotes";
    const { result } = renderHook(() => useProfileTabState(false));
    act(() => result.current.setMainTab("statement"));
    expect(replace).toHaveBeenLastCalledWith("/customers/abc?from=renewals&tab=statement", { scroll: false });
  });

  it("panel: local state only, URL never read or written", () => {
    search = "tab=transactions&show=payments";
    const { result } = renderHook(() => useProfileTabState(true));
    expect(result.current.mainTab).toBe("overview");
    act(() => result.current.setMainTab("transactions"));
    act(() => result.current.setTxnFilter("quotes"));
    expect(result.current.mainTab).toBe("transactions");
    expect(result.current.txnFilter).toBe("quotes");
    expect(replace).not.toHaveBeenCalled();
  });
});
