import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSettingsTab, settingsTabHref } from "./settings-tab";

const IDS = ["company", "integrations", "branding", "notifications", "security"];

describe("resolveSettingsTab (R-252)", () => {
  it("?tab=integrations opens Integrations", () => {
    expect(resolveSettingsTab("integrations", IDS)).toBe("integrations");
    expect(resolveSettingsTab(" Security ", IDS)).toBe("security");
  });
  it("missing or unknown tab falls back to Company", () => {
    expect(resolveSettingsTab(null, IDS)).toBe("company");
    expect(resolveSettingsTab("team", IDS)).toBe("company");
  });
});

describe("settingsTabHref (R-252)", () => {
  it("sets ?tab= and keeps other params", () => {
    expect(settingsTabHref("/settings", "google=connected", "integrations")).toBe("/settings?google=connected&tab=integrations");
  });
  it("Company drops ?tab=", () => {
    expect(settingsTabHref("/settings", "tab=branding", "company")).toBe("/settings");
  });
});

describe("settings page wiring (R-252)", () => {
  const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
  it("tab comes from the URL, not useState('company')", () => {
    expect(src).not.toMatch(/useState\("company"\)/);
    expect(src).toMatch(/useSearchParams\(\)/);
    expect(src).toMatch(/resolveSettingsTab\(/);
    expect(src).toMatch(/React\.Suspense/); // useSearchParams needs it to prerender
  });
  it("asks before a tab switch drops unsaved Company changes", () => {
    expect(src).toMatch(/onDirtyChange/);
    expect(src).toMatch(/companyDirty\.current/);
  });
  it("/team is a link, not plain text", () => {
    expect(src).toMatch(/<Link[^>]*href="\/team"/);
    expect(src).not.toMatch(/<span className="font-medium text-ink-2">\/team<\/span>/);
  });
  it("Company form pairs stack on phones (no bare grid-cols-2)", () => {
    expect(src).not.toMatch(/"grid grid-cols-2 /);
  });
});

describe("Settings → Network (R-2433, G-NETWORK)", () => {
  const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
  const tab = fs.readFileSync(path.join(__dirname, "network-tab.tsx"), "utf8");
  it("?tab=network opens the Network tab (Partners links here)", () => {
    expect(src).toMatch(/\{ id: "network",\s+label: "Network"\s+\}/);
    expect(src).toMatch(/tab === "network"\s+&& <NetworkTab \/>/);
    expect(resolveSettingsTab("network", [...IDS, "network"])).toBe("network");
  });
  it("only the owner gets the change buttons; suggestions say 'connect?'", () => {
    expect(tab).toMatch(/const isOwner = me\?\.role === "owner"/);
    expect(tab).toMatch(/is on ResellerOS — connect\?/);
    expect(tab).toMatch(/Send request/);
    expect(tab).toMatch(/Accept/);
    expect(tab).toMatch(/Disconnect/);
    expect(tab).toMatch(/Group company \(same owner\)/);
  });
});
