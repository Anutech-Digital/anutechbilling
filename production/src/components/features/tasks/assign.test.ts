import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSIGN_ME, assigneeToTell, meIdForSave, meNotKnownYet, ownerAfterSave, ownerPatch } from "./assign";

const ME = "u-me", HITESH = "u-hitesh";
const NOW = new Date("2026-11-18T18:00:00Z");
const STAMP = { delegated_by: ME, delegated_at: NOW.toISOString() };

describe("R-2925 Assign to → owner_id", () => {
  it("new task, 'Me (myself)': owner is left to the default (the creator)", () => {
    expect(ownerPatch({ assignee: ASSIGN_ME, isEdit: false, meId: ME, currentOwnerId: null })).toEqual({});
  });

  it("new task, a teammate: owner is that teammate, and it says I handed it over", () => {
    expect(ownerPatch({ assignee: HITESH, isEdit: false, meId: ME, currentOwnerId: null, now: NOW })).toEqual({ owner_id: HITESH, ...STAMP });
  });

  it("editing my task and picking a teammate: handed over by me, now", () => {
    expect(ownerPatch({ assignee: HITESH, isEdit: true, meId: ME, currentOwnerId: ME, now: NOW }))
      .toEqual({ owner_id: HITESH, ...STAMP, progress: "not_started" }); // R-2927: the new owner has not started
  });

  it("editing a teammate's task without changing the person sends no owner change (and no new hand-over)", () => {
    expect(ownerPatch({ assignee: HITESH, isEdit: true, meId: ME, currentOwnerId: HITESH, now: NOW })).toEqual({});
  });

  it("editing a teammate's task and picking 'Me (myself)' takes the task (it used to change nothing)", () => {
    expect(ownerPatch({ assignee: ASSIGN_ME, isEdit: true, meId: ME, currentOwnerId: HITESH }))
      .toEqual({ owner_id: ME, delegated_by: null, delegated_at: null, progress: "not_started" });
  });

  it("editing a task with NO owner (the form shows 'Me' by default) does not silently take it", () => {
    expect(ownerPatch({ assignee: ASSIGN_ME, isEdit: true, meId: ME, currentOwnerId: null })).toEqual({});
  });

  it("'Me' on a teammate's task before we know who I am: the save waits instead of dropping the change", () => {
    expect(meNotKnownYet({ assignee: ASSIGN_ME, isEdit: true, meId: null, currentOwnerId: HITESH })).toBe(true);
    expect(meNotKnownYet({ assignee: ASSIGN_ME, isEdit: true, meId: ME, currentOwnerId: HITESH })).toBe(false);
    expect(meNotKnownYet({ assignee: ASSIGN_ME, isEdit: false, meId: null, currentOwnerId: null })).toBe(false);
    expect(meNotKnownYet({ assignee: HITESH, isEdit: true, meId: null, currentOwnerId: HITESH })).toBe(false);
  });

  it("editing my own task with 'Me (myself)' sends no owner change", () => {
    expect(ownerPatch({ assignee: ASSIGN_ME, isEdit: true, meId: ME, currentOwnerId: ME })).toEqual({});
  });

  it("editing before we know who I am never guesses an owner", () => {
    expect(ownerPatch({ assignee: ASSIGN_ME, isEdit: true, meId: null, currentOwnerId: HITESH })).toEqual({});
  });
});

describe("R-2925 who is told about an assignment", () => {
  it("a new task for a teammate: the teammate", () => {
    expect(assigneeToTell({ newOwnerId: HITESH, previousOwnerId: null, meId: ME })).toBe(HITESH);
  });
  it("a task handed from me (or anyone) to a teammate: the teammate", () => {
    expect(assigneeToTell({ newOwnerId: HITESH, previousOwnerId: ME, meId: ME })).toBe(HITESH);
  });
  it("my own task: nobody", () => {
    expect(assigneeToTell({ newOwnerId: ME, previousOwnerId: null, meId: ME })).toBeNull();
    expect(assigneeToTell({ newOwnerId: undefined, previousOwnerId: null, meId: ME })).toBeNull();
  });
  it("an edit that keeps the same teammate (title / due date change): nobody", () => {
    expect(assigneeToTell({ newOwnerId: HITESH, previousOwnerId: HITESH, meId: ME })).toBeNull();
  });
});

describe("R-2925 the Add task dialog uses these rules", () => {
  const src = readFileSync(join(__dirname, "add-task-dialog.tsx"), "utf8");
  it("builds the owner change with ownerPatch and tells the assignee after the save", () => {
    expect(src).toMatch(/ownerPatch\(/);
    expect(src).toMatch(/assigneeToTell\(/);
    expect(src).toMatch(/tellAssignee\(/);
    expect(src).toMatch(/meNotKnownYet\(/);
    expect(src).toMatch(/meIdForSave\(me\?\.userId/); // 19 Nov: never the bare profile id (it loads late)
    expect(src).toMatch(/NOT_TOLD_MESSAGE/); // a notice that could not be sent is said to the assigner
  });
});

/* R-2925 (19 Nov): the profile query waits on a slow call, so for the first seconds after the
   page opens "me" is unknown. A task given to a teammate in that time was saved without
   delegated_by, and the server then refused to tell them ("not your assignment") — silently. */
describe("meIdForSave — who is saving, even before the profile has loaded", () => {
  it("uses the loaded profile and does not ask the session", async () => {
    const readSession = vi.fn(async () => "session-id");
    expect(await meIdForSave("profile-id", readSession)).toBe("profile-id");
    expect(readSession).not.toHaveBeenCalled();
  });

  it("falls back to the signed-in session when the profile is not loaded yet", async () => {
    expect(await meIdForSave(null, async () => "session-id")).toBe("session-id");
    expect(await meIdForSave(undefined, async () => "session-id")).toBe("session-id");
  });

  it("answers null (never throws) when the session cannot be read", async () => {
    expect(await meIdForSave(null, async () => null)).toBeNull();
    expect(await meIdForSave(null, async () => { throw new Error("offline"); })).toBeNull();
  });

  it("a teammate's new task saved before the profile loaded still records who handed it over", async () => {
    const meId = await meIdForSave(undefined, async () => "me");
    const patch = ownerPatch({ assignee: "sales", isEdit: false, meId, currentOwnerId: null, now: new Date("2026-11-19T01:00:00Z") });
    expect(patch).toEqual({ owner_id: "sales", delegated_by: "me", delegated_at: "2026-11-19T01:00:00.000Z" });
  });
});

describe("R-2933 ownerAfterSave — who has the task once the form is saved", () => {
  it("a new task: the person picked, or me", () => {
    expect(ownerAfterSave({ assignee: HITESH, isEdit: false, meId: ME, currentOwnerId: null })).toBe(HITESH);
    expect(ownerAfterSave({ assignee: ASSIGN_ME, isEdit: false, meId: ME, currentOwnerId: null })).toBe(ME);
    expect(ownerAfterSave({ assignee: undefined, isEdit: false, meId: null, currentOwnerId: null })).toBeNull();
  });
  it("an edit: the same owner, the new owner, me when I take it, nobody when it has no owner", () => {
    expect(ownerAfterSave({ assignee: HITESH, isEdit: true, meId: ME, currentOwnerId: HITESH })).toBe(HITESH);
    expect(ownerAfterSave({ assignee: HITESH, isEdit: true, meId: ME, currentOwnerId: ME })).toBe(HITESH);
    expect(ownerAfterSave({ assignee: ASSIGN_ME, isEdit: true, meId: ME, currentOwnerId: HITESH })).toBe(ME);
    expect(ownerAfterSave({ assignee: ASSIGN_ME, isEdit: true, meId: ME, currentOwnerId: null })).toBeNull();
  });
});
