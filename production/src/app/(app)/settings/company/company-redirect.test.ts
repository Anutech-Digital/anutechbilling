import { describe, it, expect, vi } from "vitest";

const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); });
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));

import CompanySettingsRedirect from "./page";

describe("/settings/company (R-1670 item 6)", () => {
  it("opens Settings → Company (the default tab) instead of a 404", () => {
    expect(() => CompanySettingsRedirect()).toThrow("REDIRECT /settings");
    expect(redirect).toHaveBeenCalledWith("/settings");
  });
});
