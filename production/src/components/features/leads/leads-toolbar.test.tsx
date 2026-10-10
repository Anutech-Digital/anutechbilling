// @vitest-environment jsdom
//
// R-056: on a phone /leads always shows the list — page.tsx forces
// `effectiveView = isMobile ? "list" : view` because the board needs width. The Kanban
// button stayed live anyway: tapping it called setView("kanban"), nothing changed on
// screen, and nothing said why. A control that silently does nothing teaches people that
// controls do nothing. On mobile it is now marked unavailable and says why; on desktop it
// is exactly what it was.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

const toastInfo = vi.fn();
vi.mock("sonner", () => ({ toast: { info: (...a: unknown[]) => toastInfo(...a), success: vi.fn() } }));
const members = vi.fn((): Array<{ id: string; full_name: string; email: string }> => []);
vi.mock("@/lib/queries/team", () => ({ useTeamMembers: () => ({ data: members() }) }));
vi.mock("@/lib/queries/leads", () => ({ fetchLeadsForExport: vi.fn() }));
vi.mock("@/components/shared/team-view-toggle", () => ({ TeamViewToggle: () => null }));
vi.mock("@/components/features/leads/leads-smart-views", () => ({ LeadsSmartViews: () => null }));
/* Every menu rendered open — R-392's tests read the Filter menu's contents. */
vi.mock("@/components/ui/dropdown-menu", () => {
  type P = { children?: ReactNode };
  const Pass = ({ children }: P) => <>{children}</>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: ({ children, className }: P & { className?: string }) => (
      <div role="menu" className={className}>{children}</div>
    ),
    DropdownMenuLabel: ({ children }: P) => <div>{children}</div>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({ children, onSelect }: P & { onSelect?: () => void }) => (
      <div role="menuitem" onClick={() => onSelect?.()}>{children}</div>
    ),
    DropdownMenuCheckboxItem: ({ children, checked, onCheckedChange }: P & {
      checked?: boolean; onCheckedChange?: (c: boolean) => void;
    }) => (
      <div role="menuitemcheckbox" aria-checked={!!checked} onClick={() => onCheckedChange?.(!checked)}>{children}</div>
    ),
  };
});

import { LeadsToolbar, FILTER_MENU_CLASS, type LeadsToolbarProps } from "./leads-toolbar";

afterEach(() => {
  cleanup();
  toastInfo.mockReset();
  members.mockReset();
  members.mockReturnValue([]);
});

function props(over: Partial<LeadsToolbarProps> = {}): LeadsToolbarProps {
  const noop = () => {};
  return {
    pool: { total: 3, unassigned: 0 } as LeadsToolbarProps["pool"],
    leadMeMember: null,
    leadTeam: [],
    leadTeamMode: "mine" as LeadsToolbarProps["leadTeamMode"],
    setLeadTeamMode: noop,
    search: "",
    setSearch: noop,
    viewCounts: {} as LeadsToolbarProps["viewCounts"],
    everythingCount: 3,
    currentUser: undefined,
    duplicateCountForTab: 0,
    junkCount: 0,
    junkSuspectCount: 0,
    smartView: "all" as LeadsToolbarProps["smartView"],
    selectSmartView: noop,
    folderRows: [],
    folder: "all",
    selectFolder: noop,
    effectiveView: "list",
    setView: vi.fn(),
    activeFilterCount: 0,
    filterStages: [],
    stageFilter: [],
    setStageFilter: noop,
    priorityFilter: [],
    setPriorityFilter: noop,
    ownerFilter: [],
    setOwnerFilter: noop,
    sourceFilter: [],
    setSourceFilter: noop,
    leadSort: "newest" as const,
    setLeadSort: noop,
    isSales: false,
    kpiOpen: false,
    setKpiOpen: noop,
    setCsvImportOpen: noop,
    setCampaignOpen: noop,
    setGoogleImportOpen: noop,
    setShareOpen: noop,
    ...over,
  };
}

const kanbanButton = () => screen.getByRole("button", { name: /kanban/i });

describe("R-056: the Kanban toggle on a phone", () => {
  it("is marked unavailable, says why, and cannot switch the view", () => {
    const setView = vi.fn();
    render(<LeadsToolbar {...props({ isMobile: true, setView })} />);
    const btn = kanbanButton();
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("title")).toBe("Kanban needs a larger screen");
    fireEvent.click(btn);
    expect(setView).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith("Kanban needs a larger screen");
  });

  it("stays a normal toggle on desktop", () => {
    const setView = vi.fn();
    render(<LeadsToolbar {...props({ setView })} />);
    const btn = kanbanButton();
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    expect(btn.getAttribute("title")).toBe("Kanban view");
    fireEvent.click(btn);
    expect(setView).toHaveBeenCalledWith("kanban");
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

/* R-392 (Abhishek, 7 Oct): no Source filter on /leads, and the person filter said "Owner"
   while the lead calls it "assigned". The dropdown is mocked open (above), so the menu
   contents are on screen without driving Radix's pointer events in jsdom. */
function openFilter() { /* menus render open under the mock */ }

describe("R-392: Filter → Source and Assigned to", () => {
  it("lists only the sources the workspace's leads carry, labelled, with counts", () => {
    render(<LeadsToolbar {...props({
      pool: { total: 5, unassigned: 0, high_priority: 0, by_owner: {}, by_source: { "google-ads": 3, "meta-ads": 2 } },
    })} />);
    openFilter();
    expect(screen.getByText("Source")).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: /Google Ads\s*3/ })).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: /Facebook \/ Instagram Ads\s*2/ })).toBeTruthy();
    expect(screen.queryByRole("menuitemcheckbox", { name: /LinkedIn Ads/ })).toBeNull();
  });

  it("ticking a source adds its key to the filter", () => {
    const setSourceFilter = vi.fn();
    render(<LeadsToolbar {...props({
      pool: { total: 3, unassigned: 0, high_priority: 0, by_owner: {}, by_source: { "google-ads": 3 } },
      setSourceFilter,
    })} />);
    openFilter();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Google Ads/ }));
    expect(setSourceFilter).toHaveBeenCalledTimes(1);
    const update = setSourceFilter.mock.calls[0][0] as (prev: string[]) => string[];
    expect(update([])).toEqual(["google-ads"]);
  });

  it("no Source section when no lead has a source (older server: no by_source)", () => {
    render(<LeadsToolbar {...props()} />);
    openFilter();
    expect(screen.queryByText("Source")).toBeNull();
  });

  it("the person filter is headed 'Assigned to', not 'Owner'", () => {
    members.mockReturnValue([
      { id: "u1", full_name: "Asha", email: "a@x.in" },
      { id: "u2", full_name: "Ravi", email: "r@x.in" },
    ]);
    render(<LeadsToolbar {...props({
      pool: { total: 3, unassigned: 1, high_priority: 0, by_owner: { u1: 1, u2: 1 } },
    })} />);
    openFilter();
    expect(screen.getByText("Assigned to")).toBeTruthy();
    expect(screen.queryByText("Owner")).toBeNull();
  });
});

/* R-420 (Pardeep, 7 Oct): a Sort menu for the list and the Kanban. */
describe("R-420: Sort", () => {
  it("offers every order with short labels and ticks the current one", () => {
    render(<LeadsToolbar {...props({ leadSort: "value" })} />);
    const items = screen.getAllByRole("menuitemcheckbox")
      .map((el) => el.textContent ?? "")
      .filter((t) => ["Newest first", "Oldest first", "Value: high to low", "Next follow-up", "Name A–Z", "Stage", "Waiting for reply"].includes(t));
    expect(items).toEqual(["Newest first", "Oldest first", "Value: high to low", "Next follow-up", "Name A–Z", "Stage", "Waiting for reply"]);
    expect(screen.getByRole("menuitemcheckbox", { name: "Value: high to low" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Newest first" }).getAttribute("aria-checked")).toBe("false");
  });

  it("picking an order hands it to the page", () => {
    const setLeadSort = vi.fn();
    render(<LeadsToolbar {...props({ setLeadSort })} />);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Next follow-up" }));
    expect(setLeadSort).toHaveBeenCalledWith("followup");
  });

  it("the button names the order for screen readers (icon-only on a phone)", () => {
    render(<LeadsToolbar {...props({ leadSort: "name" })} />);
    expect(screen.getByRole("button", { name: "Sort: Name A–Z" })).toBeTruthy();
  });
});

/* R-816 (Abhishek, 10 Oct): the Filter menu ran past the bottom of the window, so the
   Source section could not be seen or clicked. The toolbar's own `max-h-[70vh]` was
   replacing the base menu's "space left on screen" limit. */
describe("R-816: the Filter menu fits the window and scrolls", () => {
  const filterMenu = () => screen.getByText("Source").closest("[role=menu]") as HTMLElement;

  it("is height-limited by the space Radix measures, not a bare 70vh, and scrolls itself", () => {
    render(<LeadsToolbar {...props({
      pool: { total: 3, unassigned: 0, high_priority: 0, by_owner: {}, by_source: { "google-ads": 3 } },
    })} />);
    const cls = filterMenu().className.split(/\s+/);
    expect(cls).toContain("max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))]");
    expect(cls).not.toContain("max-h-[70vh]");
    expect(cls).toContain("overflow-y-auto");
    // Source and Stage live in that same scrolling box, so scrolling reaches Source.
    expect(filterMenu().textContent).toMatch(/Stage[\s\S]*Priority[\s\S]*Source/);
  });

  it("survives the real DropdownMenuContent's class merge (one max-h, ours, and it scrolls)", async () => {
    const real = await vi.importActual<typeof import("@/components/ui/dropdown-menu")>("@/components/ui/dropdown-menu");
    const g = globalThis as unknown as { ResizeObserver?: unknown };
    g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
    render(
      <real.DropdownMenu defaultOpen modal={false}>
        <real.DropdownMenuTrigger>Filter</real.DropdownMenuTrigger>
        <real.DropdownMenuContent align="end" className={FILTER_MENU_CLASS}>
          <real.DropdownMenuLabel>Stage</real.DropdownMenuLabel>
          <real.DropdownMenuLabel>Source</real.DropdownMenuLabel>
        </real.DropdownMenuContent>
      </real.DropdownMenu>,
    );
    const menu = (await screen.findByText("Source")).closest("[role=menu]") as HTMLElement;
    const cls = menu.className.split(/\s+/);
    expect(cls.filter((c) => c.startsWith("max-h-"))).toEqual([
      "max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))]",
    ]);
    expect(cls).toContain("overflow-y-auto");
    expect(cls).not.toContain("overflow-hidden");
  });

  it("picking a Source hands it to the page's filter", () => {
    const setSourceFilter = vi.fn();
    render(<LeadsToolbar {...props({
      pool: { total: 5, unassigned: 0, high_priority: 0, by_owner: {}, by_source: { "google-ads": 3, "meta-ads": 2 } },
      setSourceFilter,
    })} />);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Facebook \/ Instagram Ads/ }));
    const update = setSourceFilter.mock.calls[0][0] as (prev: string[]) => string[];
    expect(update(["google-ads"])).toEqual(["google-ads", "meta-ads"]);
  });
});
