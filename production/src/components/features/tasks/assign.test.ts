import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSIGN_ME, assigneeToTell, meNotKnownYet, ownerPatch } from "./assign";

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
    expect(ownerPatch({ assignee: HITESH, isEdit: true, meId: ME, currentOwnerId: ME, now: NOW })).toEqual({ owner_id: HITESH, ...STAMP });
  });

  it("editing a teammate's task without changing the person sends no owner change (and no new hand-over)", () => {
    expect(ownerPatch({ assignee: HITESH, isEdit: true, meId: ME, currentOwnerId: HITESH, now: NOW })).toEqual({});
  });

  it("editing a teammate's task and picking 'Me (myself)' takes the task (it used to change nothing)", () => {
    expect(ownerPatch({ assignee: ASSIGN_ME, isEdit: true, meId: ME, currentOwnerId: HITESH }))
      .toEqual({ owner_id: ME, delegated_by: null, delegated_at: null });
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
    expect(src).toMatch(/NOT_TOLD_MESSAGE/); // a notice that could not be sent is said to the assigner
  });
});
