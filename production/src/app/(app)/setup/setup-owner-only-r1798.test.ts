// R-1798 (R-1129 follow-up) — /setup opened by a manager: the tenant row is owner-only
// (RLS tenants_self_update), so every save failed with a raw "JSON object requested" toast.
// A non-owner now gets a read-only wizard: a note naming the owner, nothing saved on the way.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { canSaveSetup, ownerOnlySetupNote } from "./owner-only";
import { DONE_STEP, wizardMove } from "./wizard-nav";

const page = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("who can save setup", () => {
  it("only the owner", () => {
    expect(canSaveSetup("owner")).toBe(true);
    expect(canSaveSetup("manager")).toBe(false);
    expect(canSaveSetup("accountant")).toBe(false);
    expect(canSaveSetup(null)).toBe(false);
  });
});

describe("the read-only note", () => {
  it("names the owner when known", () => {
    expect(ownerOnlySetupNote("Pardeep Sharma")).toBe("Only the owner can finish setup — ask Pardeep Sharma.");
  });
  it("falls back to 'the workspace owner'", () => {
    expect(ownerOnlySetupNote(null)).toBe("Only the owner can finish setup — ask the workspace owner.");
    expect(ownerOnlySetupNote("  ")).toBe("Only the owner can finish setup — ask the workspace owner.");
  });
});

describe("a non-owner moves through the wizard without saving", () => {
  it("leaving step 1 does not save the company", () => {
    expect(wizardMove(0, 1, false)).toBe("advance");
  });
  it("reaching Done does not stamp setup_completed_at", () => {
    expect(wizardMove(3, DONE_STEP, false)).toBe("advance");
  });
  it("the owner still saves and finishes", () => {
    expect(wizardMove(0, 1, true)).toBe("save-company");
    expect(wizardMove(3, DONE_STEP, true)).toBe("finish");
  });
  it("page passes the owner check into every move and locks the company form", () => {
    expect(page).toMatch(/wizardMove\(step, target, canSave\)/);
    expect(page).toMatch(/<fieldset disabled=\{!canSave\}/);
    expect(page).toMatch(/<OwnerOnlyNote/);
  });
});
