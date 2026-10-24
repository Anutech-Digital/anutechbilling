/* R-1651 — the Team page told a manager "Invite teammates, assign roles, manage access" and
   showed "Pending invites 0", but a manager cannot invite: the invite API is owner-only and
   team_invites is owner-only under RLS, so the 0 was a query that never ran. roles.ts said
   the opposite (manager can_manage_team: true) and nothing read it.

   Now one source decides — can(role, "can_manage_team") — the page and the invite API both
   read it, it matches what the server allows (owner only), the manager sees an honest note
   instead of the promise, and Pending is hidden rather than a fake 0. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PERMISSIONS, USER_ROLES, can } from "@/lib/auth/roles";
import { teamAccess } from "./team-access";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("R-1651 — who may manage the team: one source, matching the server", () => {
  it("only the owner has can_manage_team (the invite API and team_invites RLS are owner-only)", () => {
    const managers = USER_ROLES.filter((r) => PERMISSIONS[r].can_manage_team);
    expect(managers).toEqual(["owner"]);
  });

  it("the invite API checks the same flag", () => {
    const src = read("src/app/api/team/invite/route.ts");
    expect(src).toMatch(/can\(\s*me\.role\s*,\s*"can_manage_team"\s*\)/);
  });

  it("the Team page checks the same flag, not its own role compare", () => {
    const src = read("src/app/(app)/team/page.tsx");
    expect(src).toMatch(/teamAccess\(/);
    expect(src).not.toMatch(/me\?\.role === "owner"/);
  });
});

describe("R-1651 — what the page promises", () => {
  it("owner: invite copy, pending shown", () => {
    const a = teamAccess("owner");
    expect(a.canManage).toBe(true);
    expect(a.showPending).toBe(true);
    expect(a.subtitle).toMatch(/Invite teammates/);
    expect(a.note).toBeNull();
  });

  it("manager: no invite promise, honest note, pending hidden", () => {
    const a = teamAccess("manager");
    expect(a.canManage).toBe(false);
    expect(a.showPending).toBe(false);
    expect(a.subtitle).not.toMatch(/invite/i);
    expect(a.note).toMatch(/Only the workspace owner can invite teammates or change roles/);
    expect(can("manager", "can_manage_team")).toBe(false);
  });
});

describe("R-1651 — the invite email names the role in words", () => {
  it("uses the role label, never the raw key ('as sales_senior')", () => {
    const src = read("src/app/api/team/invite/route.ts");
    expect(src).not.toMatch(/on ResellerOS as \$\{role\}/);
    expect(src).toMatch(/on ResellerOS as \$\{roleName\}/);
  });
});
