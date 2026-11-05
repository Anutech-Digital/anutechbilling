/**
 * R-2476: the company switcher's logic (lib/auth/company-switch.ts) — when it shows, what a refused
 * switch says (§24: what happened · why · next step), and that a finished switch leaves nothing of
 * the old company in the browser.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeSwitchRefusal, finishCompanySwitch, shouldShowSwitcher, toCompanyOptions, WORKSPACE_TABS_STORAGE_KEY,
} from "./company-switch";
import { MFA_PENDING_DATA_REFUSAL } from "./mfa-gate";

const row = (tenant_id: string, is_current: boolean, role = "sales") => ({ tenant_id, company_name: ` ${tenant_id} Co `, role, is_current });

describe("company switch (R-2476)", () => {
  it("shows only for 2+ active companies", () => {
    expect(shouldShowSwitcher(undefined)).toBe(false);
    expect(shouldShowSwitcher([])).toBe(false);
    expect(shouldShowSwitcher(toCompanyOptions([row("a", true)]))).toBe(false);
    expect(shouldShowSwitcher(toCompanyOptions([row("a", true), row("b", false)]))).toBe(true);
  });

  it("maps rows to names, role labels and the current flag", () => {
    const [a, b] = toCompanyOptions([row("a", true, "manager"), { tenant_id: "b", company_name: null as unknown as string, role: "billing", is_current: false }]);
    expect(a).toEqual({ tenantId: "a", name: "a Co", role: "manager", roleLabel: "Manager", isCurrent: true });
    expect(b.name).toBe("Unnamed company");
    expect(b.roleLabel).toBe("Billing / Accounts");
  });

  it("MFA refusal (switch_company or the gateway) → next step + button to /mfa", () => {
    for (const msg of [
      "Finish two-step sign-in before switching company: open the two-step sign-in page, type the 6-digit code from your authenticator app, then switch again.",
      MFA_PENDING_DATA_REFUSAL,
    ]) {
      const r = describeSwitchRefusal(new Error(msg));
      expect(r.message).toMatch(/two-step sign-in/);
      expect(r.description).toMatch(/authenticator app/);
      expect(r.action).toEqual({ label: "Open two-step sign-in", href: "/mfa" });
    }
  });

  it("ended membership → why + who to ask; anything else → still in the same company, try again", () => {
    const ended = describeSwitchRefusal(new Error("You are not a member of that company, or your access there has ended. Ask that company's owner to invite you again."));
    expect(ended.message).toMatch(/access there has ended/);
    expect(ended.description).toMatch(/invite you again/);
    const other = describeSwitchRefusal(new Error("Failed to fetch"));
    expect(other.description).toMatch(/still in the same company/);
    expect(other.message).not.toMatch(/fetch/);
  });

  it("finishCompanySwitch: cancel reads, clear every cache, forget tabs, then load home fresh", async () => {
    const calls: string[] = [];
    const queryClient = { cancelQueries: vi.fn(async () => { calls.push("cancel"); }), clear: vi.fn(() => { calls.push("clear"); }) };
    const storage = { removeItem: vi.fn((k: string) => { calls.push(`remove:${k}`); }) };
    const go = vi.fn((h: string) => { calls.push(`go:${h}`); });
    await finishCompanySwitch({ queryClient, storage, go });
    expect(calls).toEqual(["cancel", "clear", `remove:${WORKSPACE_TABS_STORAGE_KEY}`, "go:/dashboard"]);
  });

  it("forgets the SAME key the workspace tabs provider saves under", () => {
    const src = readFileSync(join(process.cwd(), "src/components/providers/workspace-tabs-provider.tsx"), "utf8");
    expect(src).toContain(`const STORAGE_KEY = "${WORKSPACE_TABS_STORAGE_KEY}";`);
  });

  it("finishCompanySwitch still reloads when storage is blocked", async () => {
    const go = vi.fn();
    await finishCompanySwitch({
      queryClient: { cancelQueries: vi.fn(async () => {}), clear: vi.fn() },
      storage: { removeItem: () => { throw new Error("SecurityError"); } },
      go,
    });
    expect(go).toHaveBeenCalledWith("/dashboard");
  });
});
