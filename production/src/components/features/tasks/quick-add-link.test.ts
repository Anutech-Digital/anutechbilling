import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quickAddNameGuess, quickAddSurnameGuess, quickAddLinkCandidates } from "./quick-add-link";

describe("quickAddNameGuess", () => {
  it("finds the person after the verb", () => {
    expect(quickAddNameGuess("Email Vikas")).toBe("Vikas");
    expect(quickAddNameGuess("Call Amit (Sharma Traders)")).toBe("Amit");
    expect(quickAddNameGuess("Follow up with Ravi about quote")).toBe("Ravi");
  });
  it("null when there is no name", () => {
    expect(quickAddNameGuess("Call")).toBeNull();
    expect(quickAddNameGuess("Send quote")).toBeNull();
  });
});

describe("quickAddLinkCandidates", () => {
  const leads = [
    { id: "L-1", company: "Bansal Enterprises", contact_name: "Vikas Bansal" },
    { id: "L-2", company: "Kumar Pharma", contact_name: "Rajesh Kumar" },
  ];
  const customers = [{ id: "C-1", name: "Sharma Traders", contact_name: "Amit Sharma" }];
  it("Vikas → the Bansal lead", () => {
    expect(quickAddLinkCandidates("Vikas", leads, customers)).toEqual([
      { kind: "lead", id: "L-1", label: "Vikas Bansal · Bansal Enterprises" },
    ]);
  });
  it("matches customers too, by contact or company word", () => {
    expect(quickAddLinkCandidates("amit", leads, customers).map((c) => c.id)).toEqual(["C-1"]);
    expect(quickAddLinkCandidates("Sharma", leads, customers).map((c) => c.id)).toEqual(["C-1"]);
  });
  it("no name or no match → nothing (never a wrong link)", () => {
    expect(quickAddLinkCandidates(null, leads, customers)).toEqual([]);
    expect(quickAddLinkCandidates("Zoya", leads, customers)).toEqual([]);
    expect(quickAddLinkCandidates("ikas", leads, customers)).toEqual([]);
  });
});

describe("snooze + quick-add wiring (R-471)", () => {
  const dir = join(process.cwd(), "src", "components", "features", "tasks");
  const row = readFileSync(join(dir, "task-row.tsx"), "utf8");
  const bar = readFileSync(join(dir, "task-quick-add.tsx"), "utf8");
  it("snooze is a menu with choices and Pick a date", () => {
    expect(row).toMatch(/snoozeChoices\(\)\.map/);
    expect(row).toMatch(/Pick a date…/);
    expect(row).not.toMatch(/Snooze 1 day/);
  });
  it("quick add saves the chosen link", () => {
    expect(bar).toMatch(/quickAddLinkCandidates\(/);
    expect(bar).toMatch(/relatedToLinkColumns\(/);
  });
});

describe("full name narrows the match (R-445)", () => {
  const leads = [
    { id: "L-1", company: "Gupta Infotech", contact_name: "Rohit Gupta" },
    { id: "L-2", company: "Mehra Traders", contact_name: "Rohit Mehra" },
  ];
  it("reads the surname after the first name", () => {
    expect(quickAddSurnameGuess("Call Rohit Gupta")).toBe("Gupta");
    expect(quickAddSurnameGuess("Call Rohit about quote")).toBeNull();
    expect(quickAddSurnameGuess("Call Rohit")).toBeNull();
    expect(quickAddSurnameGuess("Send quote")).toBeNull();
  });
  it("Rohit Gupta → only the Gupta lead, so it is linked by default", () => {
    expect(quickAddLinkCandidates("Rohit", leads, [], "Gupta")).toEqual([
      { kind: "lead", id: "L-1", label: "Rohit Gupta · Gupta Infotech" },
    ]);
  });
  it("no surname, or a surname nobody has → every Rohit stays to pick from", () => {
    expect(quickAddLinkCandidates("Rohit", leads, []).map((c) => c.id)).toEqual(["L-1", "L-2"]);
    expect(quickAddLinkCandidates("Rohit", leads, [], "Kapoor").map((c) => c.id)).toEqual(["L-1", "L-2"]);
  });
  it("the bar passes the surname in", () => {
    const bar = readFileSync(join(process.cwd(), "src", "components", "features", "tasks", "task-quick-add.tsx"), "utf8");
    expect(bar).toMatch(/quickAddSurnameGuess\(parsed\.title\)/);
    expect(bar).toMatch(/quickAddLinkCandidates\(searchName, leads \?\? \[\], customers \?\? \[\], surname\)/);
  });
});
