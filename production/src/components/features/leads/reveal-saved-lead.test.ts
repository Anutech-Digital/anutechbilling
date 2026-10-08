// R-208: the shared "lead saved" step both Add lead and Quick add use.
import { describe, it, expect, vi, afterEach } from "vitest";

const success = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => success(...a), dismiss: vi.fn() } }));

import { revealSavedLead, savedLeadHref } from "./reveal-saved-lead";

afterEach(() => success.mockReset());

describe("revealSavedLead", () => {
  it("a deal gets 'Open deal' to its own page and never auto-navigates", () => {
    const router = { push: vi.fn(), replace: vi.fn() };
    revealSavedLead({ id: "L-1", title: "Acme saved as Deal", isDeal: true, pathname: "/leads", router });
    const opts = success.mock.calls[0][1] as { action: { label: string; onClick: () => void } };
    expect(opts.action.label).toBe("Open deal");
    opts.action.onClick();
    expect(router.push).toHaveBeenCalledWith("/deals/L-1");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("a raw lead saved on /leads opens its drawer", () => {
    const router = { push: vi.fn(), replace: vi.fn() };
    revealSavedLead({ id: "L-2", title: "Acme added to your leads", isDeal: false, pathname: "/leads", router });
    expect(router.replace).toHaveBeenCalledWith("/leads?lead=L-2");
  });

  it("encodes the id", () => {
    expect(savedLeadHref("L 3", false)).toBe("/leads?lead=L%203");
  });
});
