/**
 * R-1414: what the "not linked yet" card on /attendance/me shows.
 *
 * After R-1001 the employees table is readable only by owner / manager / accountant.
 * Self-attendance itself never reads employees (my_attendance_today() is security definer
 * and returns the caller's own linked row), so a linked sales / support / delivery /
 * billing login is unaffected. The only place a list of people appears is the one-time
 * "Select your profile" picker for an unlinked login — and that list is now offered only to
 * the three employee-reading roles. Everyone else gets a plain message instead of an empty
 * dropdown.
 */

export const EMPLOYEE_READ_ROLES = ["owner", "manager", "accountant"] as const;

export const NOT_LINKED_MESSAGE =
  "Your login isn't linked to an employee profile yet. Ask the owner to link it in Team → Employees.";

export const NO_EMPLOYEES_MESSAGE = "No employees yet — add one in Employees.";

export const EMPLOYEES_HREF = "/accounting/employees";

export function canPickEmployee(role: string | null | undefined): boolean {
  return !!role && (EMPLOYEE_READ_ROLES as readonly string[]).includes(role);
}

export type LinkCardMode =
  /** low role (or unknown role): no list, ask the owner to link the login */
  | "ask-owner"
  /** owner / manager / accountant, but nothing to pick: empty state with a link */
  | "no-employees"
  /** owner / manager / accountant with names to pick */
  | "pick";

export function linkCardMode(role: string | null | undefined, choiceCount: number): LinkCardMode {
  if (!canPickEmployee(role)) return "ask-owner";
  return choiceCount > 0 ? "pick" : "no-employees";
}
