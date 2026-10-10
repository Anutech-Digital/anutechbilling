// @vitest-environment jsdom
//
// R-835 (10 Oct 2026): after R-433 the /leads board holds only New and Contacted — quotes,
// demos, trials and won live on /deals. The shared board still said "No deals in Contacted"
// and "Add deal" on /leads, and the empty Lost folder said "No deals lost yet". The board
// and the folder hint now take the page's word; /deals keeps "deal".
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { LeadsKanbanBoard } from "./leads-kanban-board";
import { DEAL_STAGES } from "@/lib/leads/stage-meta";
import { SALES_FOLDERS } from "@/lib/leads/folders";

afterEach(cleanup);

const board = (noun?: "lead" | "deal") =>
  render(
    <LeadsKanbanBoard
      boardLeads={[]}
      stages={DEAL_STAGES.filter((s) => s.id === "new" || s.id === "contact")}
      changeStage={vi.fn() as never}
      setSelected={() => {}}
      setAddOpen={() => {}}
      noun={noun}
    />,
  );

describe("R-835: the board speaks the page's word", () => {
  it("on /leads says leads, never deals", () => {
    const { container } = board("lead");
    expect(screen.getByText("No leads in Contacted")).toBeTruthy();
    expect(screen.getAllByText(/Add lead/).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/\bdeals?\b/i);
  });

  it("on /deals keeps the deal wording (the default)", () => {
    board();
    expect(screen.getByText("No deals in Contacted")).toBeTruthy();
    expect(screen.getAllByText(/Add deal/).length).toBeGreaterThan(0);
  });

  it("the page hands the board its word", () => {
    const page = readFileSync(join(__dirname, "../../../app/(app)/leads/page.tsx"), "utf8");
    expect(page).toMatch(/noun=\{isDealsPage \? "deal" : "lead"\}/);
  });
});

describe("R-835: the empty Lost folder hint", () => {
  const lost = SALES_FOLDERS.find((f) => f.id === "lost")!;
  it("says leads on /leads and deals on /deals", () => {
    expect(lost.leadHint).toMatch(/^No leads lost yet/);
    expect(lost.hint).toMatch(/^No deals lost yet/);
  });
  it("the page picks leadHint on /leads", () => {
    const page = readFileSync(join(__dirname, "../../../app/(app)/leads/page.tsx"), "utf8");
    expect(page).toMatch(/isDealsPage \? f\.hint : \(f\.leadHint \?\? f\.hint\)/);
  });
});
