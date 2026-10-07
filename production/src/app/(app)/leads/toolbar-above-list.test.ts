/**
 * R-277 — on /leads and /deals the search + filter bar sits directly above the list / Kanban.
 *
 * Pardeep (6 Oct 2026, screenshot): "ye lead list ke just upar hona chahiye". The order was
 * toolbar → hot-lead card → today's call queue → (deals) loss reasons → list, so a search
 * or a filter change put its result a scroll away.
 *
 * Like board-reachable.test.ts this reads page.tsx: the page needs the whole data layer to
 * render, and what went wrong is the ORDER of elements in this one file. /deals re-exports
 * this page, so one order covers both.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(HERE, "page.tsx"), "utf8");
const deals = readFileSync(join(HERE, "..", "deals", "page.tsx"), "utf8");

const at = (tag: string) => {
  const i = page.indexOf(`<${tag}`);
  expect(i, `<${tag}> not found in leads/page.tsx`).toBeGreaterThan(-1);
  return i;
};

describe("R-277: toolbar sits right above the list / Kanban", () => {
  it("/deals renders the same page", () => {
    expect(deals).toMatch(/export \{ default \} from "\.\.\/leads\/page"/);
  });

  it("the cards come first, then the toolbar", () => {
    const toolbar = at("LeadsToolbar");
    for (const card of ["LeadsHotCard", "PriorityCallQueue", "LossReasonsCard"]) {
      expect(at(card), `${card} must sit above the toolbar`).toBeLessThan(toolbar);
    }
  });

  it("nothing but the empty states sits between the toolbar and the list / Kanban", () => {
    const toolbar = at("LeadsToolbar");
    const firstView = Math.min(at("LeadsKanbanBoard"), at("LeadListView"));
    expect(toolbar).toBeLessThan(firstView);
    const between = page.slice(toolbar, firstView);
    const tags = [...between.matchAll(/<([A-Z]\w+)/g)].map((m) => m[1]);
    expect(tags.filter((t) => t !== "LeadsToolbar" && t !== "LeadsStatusStates")).toEqual([]);
  });

  it("the toolbar is sticky inside the scrolling column, with a background", () => {
    const wrapper = page.slice(0, at("LeadsToolbar")).match(/<div className="([^"]*)">\s*$/);
    expect(wrapper, "toolbar wrapper div not found").not.toBeNull();
    expect(wrapper?.[1]).toMatch(/\bsticky\b/);
    expect(wrapper?.[1]).toMatch(/\btop-0\b/);
    expect(wrapper?.[1]).toMatch(/\bbg-/);
    const mainCol = page.indexOf('<div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto');
    expect(mainCol).toBeGreaterThan(-1);
    expect(mainCol).toBeLessThan(at("LeadsToolbar"));
  });
});
