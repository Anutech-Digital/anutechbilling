/**
 * R-1651 — what the Team page offers and promises, from the one permission that decides
 * it: can(role, "can_manage_team") in lib/auth/roles.ts, the same check the invite API
 * makes. Pure, so the copy is tested next to the rule.
 */
import { can } from "@/lib/auth/roles";

export interface TeamAccess {
  /** Invite, change roles, offboard, reporting lines, temporary passwords. */
  canManage: boolean;
  /** Pending invites are readable only by those who can manage (RLS) — anyone else would see a fake 0. */
  showPending: boolean;
  subtitle: string;
  /** Shown to everyone else, so the page does not look broken. */
  note: string | null;
}

export function teamAccess(role: string | null | undefined): TeamAccess {
  const canManage = can(role, "can_manage_team");
  return canManage
    ? { canManage, showPending: true, subtitle: "Invite teammates, assign roles, manage access", note: null }
    : {
        canManage,
        showPending: false,
        subtitle: "Everyone in this workspace and their roles",
        note: "Only the workspace owner can invite teammates or change roles. Ask the owner if someone needs to be added.",
      };
}
