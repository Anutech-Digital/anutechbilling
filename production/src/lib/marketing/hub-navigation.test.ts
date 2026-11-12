import { describe, expect, it } from "vitest";
import { isRouteAllowed } from "@/lib/nav";
import { MARKETING_HUB_SECTIONS, MARKETING_TOOLS } from "./tool-catalog";
import { TOOL_WORKSPACES, workspaceRoute } from "./hub-navigation";

describe("Marketing Hub section navigation", () => {
  it("opens Paid ads directly in Ad accounts", () => {
    expect(MARKETING_HUB_SECTIONS.find((section) => section.group === "ads")?.href).toBe("/marketing/ads");
  });

  it("gives every platform a working destination, with paid platforms opening Ad accounts", () => {
    for (const tool of MARKETING_TOOLS) {
      expect(TOOL_WORKSPACES[tool.key]?.href, tool.key).toBeTruthy();
      if (tool.group === "ads") expect(workspaceRoute(TOOL_WORKSPACES[tool.key].href)).toBe("/marketing/ads");
    }
  });

  it("keeps section pages within Marketing Hub access", () => {
    for (const section of MARKETING_HUB_SECTIONS) {
      expect(isRouteAllowed("owner", section.href)).toBe(true);
      expect(isRouteAllowed("marketing", section.href)).toBe(true);
      expect(isRouteAllowed("sales", section.href)).toBe(false);
      expect(isRouteAllowed("billing", section.href)).toBe(false);
    }
  });
});
