/**
 * R-2933 — up to 3 people working with a task's owner, and the task's link.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_TASK_COLLABORATORS, TOO_MANY_COLLABORATORS, cleanCollaborators, collaboratorDiff, collaboratorEmail,
  collaboratorNotification, normalizeTaskLink, safeTaskLink, sameCollaborators, taskLinkLabel, toggleCollaborator,
} from "./collaborators";

const TEAM = new Set(["a", "b", "c", "d", "owner"]);

describe("R-2933 cleanCollaborators", () => {
  it("keeps up to 3 active teammates, once each, never the task's owner", () => {
    expect(MAX_TASK_COLLABORATORS).toBe(3);
    expect(cleanCollaborators({ userIds: ["a", "b", "a", "owner", " "], ownerId: "owner", activeMemberIds: TEAM }))
      .toEqual({ ok: true, userIds: ["a", "b"] });
    expect(cleanCollaborators({ userIds: [], ownerId: "owner", activeMemberIds: TEAM })).toEqual({ ok: true, userIds: [] });
  });

  it("a 4th person is refused in plain words (not silently dropped)", () => {
    expect(cleanCollaborators({ userIds: ["a", "b", "c", "d"], ownerId: "owner", activeMemberIds: TEAM }))
      .toEqual({ ok: false, error: TOO_MANY_COLLABORATORS });
    // the owner in the list does not count towards the limit
    expect(cleanCollaborators({ userIds: ["a", "b", "c", "owner"], ownerId: "owner", activeMemberIds: TEAM }))
      .toEqual({ ok: true, userIds: ["a", "b", "c"] });
  });

  it("someone who is not an active member of this company is refused", () => {
    const r = cleanCollaborators({ userIds: ["a", "stranger"], ownerId: "owner", activeMemberIds: TEAM });
    expect(r.ok).toBe(false);
  });
});

describe("R-2933 collaboratorDiff / sameCollaborators / toggleCollaborator", () => {
  it("who to add and who to remove", () => {
    expect(collaboratorDiff(["a", "b"], ["b", "c"])).toEqual({ add: ["c"], remove: ["a"] });
    expect(collaboratorDiff([], [])).toEqual({ add: [], remove: [] });
    expect(sameCollaborators(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameCollaborators(["a"], ["a", "b"])).toBe(false);
  });

  it("the dialog adds up to 3 and says when it is full; a picked person can always be removed", () => {
    expect(toggleCollaborator(["a"], "b")).toEqual({ selected: ["a", "b"], full: false });
    expect(toggleCollaborator(["a", "b", "c"], "d")).toEqual({ selected: ["a", "b", "c"], full: true });
    expect(toggleCollaborator(["a", "b", "c"], "b")).toEqual({ selected: ["a", "c"], full: false });
  });
});

describe("R-2933 the task's link", () => {
  it("blank is no link; a web address is kept; one typed without https:// gets it", () => {
    expect(normalizeTaskLink("")).toEqual({ ok: true, url: null });
    expect(normalizeTaskLink("   ")).toEqual({ ok: true, url: null });
    expect(normalizeTaskLink(null)).toEqual({ ok: true, url: null });
    expect(normalizeTaskLink("https://drive.google.com/file/d/abc/view?usp=sharing"))
      .toEqual({ ok: true, url: "https://drive.google.com/file/d/abc/view?usp=sharing" });
    expect(normalizeTaskLink(" drive.google.com/x ")).toEqual({ ok: true, url: "https://drive.google.com/x" });
    expect(normalizeTaskLink("http://example.com")).toEqual({ ok: true, url: "http://example.com/" });
  });

  it("anything that is not a web address is refused — never javascript: or data:", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "file:///c:/x", "mailto:a@b.in", "not a link", "hello", "https://", `https://a.in/${"x".repeat(2000)}`]) {
      expect(normalizeTaskLink(bad).ok, bad).toBe(false);
    }
  });

  it("the row opens a saved link only when it is http(s), and names its site", () => {
    expect(safeTaskLink("https://docs.google.com/d/1")).toBe("https://docs.google.com/d/1");
    expect(safeTaskLink("javascript:alert(1)")).toBeNull();
    expect(safeTaskLink("nonsense")).toBeNull();
    expect(safeTaskLink(null)).toBeNull();
    expect(taskLinkLabel("https://www.drive.google.com/x/y")).toBe("drive.google.com");
  });
});

describe("R-2933 what a person added to a task reads", () => {
  const task = { id: "T1", title: "Call Acme", notes: null, due_at: "2026-11-19T10:00:00Z" };
  it("the bell line says who added them and opens the task", () => {
    expect(collaboratorNotification({ task, actorName: "Pardeep" })).toEqual({
      kind: "task.assigned", title: "Pardeep added you to a task: Call Acme", body: "Due 19 Nov 2026, 3:30 pm",
      href: "/tasks?tab=all&task=T1", entityId: "T1",
    });
    expect(collaboratorNotification({ task, actorName: "Pardeep", canOpenTasks: false }).href).toBe("/dashboard");
  });
  it("the email names the owner of the task too", () => {
    const mail = collaboratorEmail({ task, assigneeName: "Pawan", actorName: "Pardeep", ownerName: "Hitesh", companyName: "E2E Test Co", baseUrl: "https://app.example.test", related: null });
    expect(mail.subject).toBe("Added to a task: Call Acme");
    expect(mail.text).toContain("Pardeep added you to work on this task in E2E Test Co (owner: Hitesh).");
    expect(mail.text).toContain("Open the task: https://app.example.test/tasks?tab=all&task=T1");
  });
});
