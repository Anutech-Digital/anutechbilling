// @vitest-environment jsdom
//
// R-1427 (Pawan, staging 17 Oct): More → "Import from Google" → Close left /leads frozen —
// body kept `pointer-events: none`, so Filter and every click were dead until a reload.
// Cause: @radix-ui/react-menu ships its own copy of react-dismissable-layer (1.1.11) and
// react-dialog uses another (1.1.19). A MODAL menu sets body pointer-events:none; the dialog
// opened from its item mounts while the menu is still there, so the dialog's copy saves
// "none" as the page's original value and puts "none" back when it closes. The More menu is
// non-modal now (same fix as R-457 in leads-bulk-bar), so there is nothing wrong to save.
// This test uses the REAL menu and the REAL dialog — a mocked one cannot show the bug.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import * as React from "react";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/queries/team", () => ({ useTeamMembers: () => ({ data: [] }) }));
vi.mock("@/lib/exports/download-server-export", () => ({ downloadServerExport: vi.fn() }));
vi.mock("@/components/shared/team-view-toggle", () => ({ TeamViewToggle: () => null }));
vi.mock("@/components/features/leads/leads-smart-views", () => ({ LeadsSmartViews: () => null }));

import { LeadsToolbar, type LeadsToolbarProps } from "./leads-toolbar";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const g = globalThis as unknown as { ResizeObserver?: unknown; DOMRect?: unknown };
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = "";
});

function props(over: Partial<LeadsToolbarProps>): LeadsToolbarProps {
  const noop = () => {};
  return {
    pool: { total: 3, unassigned: 0 } as LeadsToolbarProps["pool"],
    leadMeMember: null, leadTeam: [], leadTeamMode: "mine" as LeadsToolbarProps["leadTeamMode"],
    setLeadTeamMode: noop, search: "", setSearch: noop,
    viewCounts: {} as LeadsToolbarProps["viewCounts"], everythingCount: 3, currentUser: undefined,
    duplicateCountForTab: 0, junkCount: 0, junkSuspectCount: 0,
    smartView: "all" as LeadsToolbarProps["smartView"], selectSmartView: noop,
    folderRows: [], folder: "all", selectFolder: noop, effectiveView: "list", setView: noop,
    activeFilterCount: 0, filterStages: [], stageFilter: [], setStageFilter: noop,
    priorityFilter: [], setPriorityFilter: noop, ownerFilter: [], setOwnerFilter: noop,
    sourceFilter: [], setSourceFilter: noop, leadSort: "newest" as const, setLeadSort: noop,
    isSales: false, kpiOpen: false, setKpiOpen: noop, setCsvImportOpen: noop,
    setCampaignOpen: noop, setGoogleImportOpen: noop, setShareOpen: noop,
    ...over,
  };
}

/** /leads in miniature: the toolbar plus one dialog its More menu opens. */
function Page() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <LeadsToolbar {...props({ setGoogleImportOpen: setOpen })} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Import contacts from Google</DialogTitle>
          <DialogDescription>Not available</DialogDescription>
          <button type="button" onClick={() => setOpen(false)}>Close it</button>
        </DialogContent>
      </Dialog>
    </>
  );
}

function openMore() {
  const more = screen.getByRole("button", { name: /^More$/ });
  // Radix opens menus on pointerdown (button 0, mouse), then the keyboard path as a fallback.
  fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: "mouse" });
  if (!screen.queryByRole("menu")) fireEvent.keyDown(more, { key: "Enter" });
}

describe("R-1427: a dialog opened from the /leads More menu leaves the page usable after Close", () => {
  it("Import from Google → Close: body pointer-events is not stuck at none", async () => {
    render(<Page />);
    openMore();
    const item = await screen.findByRole("menuitem", { name: /Import from Google/ });
    await act(async () => { fireEvent.click(item); });
    expect(await screen.findByRole("dialog")).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close it" })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe("none");
  });
});
