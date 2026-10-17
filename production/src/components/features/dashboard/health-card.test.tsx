// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { HealthCard, HEALTH_ITEMS } from "./health-card";
import { SETUP_HREF } from "@/lib/onboarding/setup-links";

/* R-1451: the card reads the signed-in role — only a role that can open Settings AND connect
   company integrations gets a "Set up" link; everyone else is told to ask the owner. */
let mockRole: string | null = "owner";
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: mockRole ? { role: mockRole } : undefined }),
}));

afterEach(() => { cleanup(); mockRole = "owner"; });

const notSetUp = HEALTH_ITEMS.filter((i) => i.status === "Not set up");
const linkable = notSetUp.filter((i) => i.setupHref);

function row(name: string) {
  return screen.getByText(name).closest("[data-health-row]") as HTMLElement;
}

describe("HealthCard (R-1451)", () => {
  it("has Not set up items that point at the Integrations tab", () => {
    expect(linkable.length).toBeGreaterThan(0);
    for (const i of linkable) expect(i.setupHref).toBe(SETUP_HREF.integrations);
    expect(SETUP_HREF.integrations).toBe("/settings?tab=integrations");
  });

  it("owner: each Not set up item with a setup screen links to it", () => {
    render(<HealthCard />);
    for (const i of linkable) {
      const link = within(row(i.name)).getByRole("link", { name: `Set up ${i.name} in Settings` });
      expect(link.getAttribute("href")).toBe(SETUP_HREF.integrations);
    }
  });

  it("owner: a live item and an item with no setup screen have no link", () => {
    render(<HealthCard />);
    for (const i of HEALTH_ITEMS.filter((x) => x.status !== "Not set up" || !x.setupHref)) {
      expect(within(row(i.name)).queryByRole("link")).toBeNull();
    }
  });

  it("manager gets the links too", () => {
    mockRole = "manager";
    render(<HealthCard />);
    expect(screen.getAllByRole("link")).toHaveLength(linkable.length);
  });

  it.each(["billing", "sales", "accountant", "support"])("%s sees ask-the-owner, no link", (role) => {
    mockRole = role;
    render(<HealthCard />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    for (const i of linkable) expect(within(row(i.name)).getByText(/ask the owner/i)).toBeTruthy();
  });
});
