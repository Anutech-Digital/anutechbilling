/**
 * R-857: who may move employee-advance money — give, top up, settle.
 *
 * The database decides (R-717: give_employee_advance / top_up_employee_advance /
 * settle_employee_advance refuse anyone but owner, manager, accountant). /accounting/advances is
 * open to billing too (it books expenses there), so the page hides the three buttons from a role
 * the RPC would refuse instead of letting the click fail. Same list as payroll (PAYROLL_ROLES);
 * advance-buttons-by-role.test.tsx pins both against the migrations.
 *
 * Edit / Delete are NOT in this rule: update_employee_advance / delete_employee_advance allow
 * billing as well.
 */
import type { UserRole } from "@/lib/auth/roles";

export const ADVANCE_MONEY_ROLES: readonly UserRole[] = ["owner", "manager", "accountant"];

export function canMoveAdvanceMoney(role: string | null | undefined): boolean {
  return !!role && (ADVANCE_MONEY_ROLES as readonly string[]).includes(role);
}
