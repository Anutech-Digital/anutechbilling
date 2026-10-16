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

/* §24 — what happened, why, what to do next. R-1436 (open): the app has no screen yet where
   the owner links SOMEONE ELSE's login to an employee (only set_my_employee, the caller's own
   link), so this text must not point at one. The next step that exists today is Help →
   Report a problem; the card puts that button under the text. */
export const NOT_LINKED_MESSAGE =
  "Your login isn't linked to an employee profile yet, so attendance can't be recorded for it. " +
  "Only an owner, manager or accountant can pick their own profile here, and linking another " +
  "person's login isn't in the app yet — tell your owner, or report it below so support can link it.";

/* Owner / manager / accountant with nothing in my_employee_link_choices(). That list can be
   empty even when employees exist (all linked, or their e-mail is someone else's), so never
   "No employees yet". The reason is the rule set_my_employee enforces. */
export const NO_EMPLOYEES_MESSAGE = "No employee profile is free to link to your login.";

export function noEmployeesReason(email: string | null | undefined): string {
  const mine = email ? `yours (${email})` : "the one you sign in with";
  return (
    "A profile can be linked only if it is active, not linked to another login, and its e-mail " +
    `is empty or ${mine}. Add yourself in Employees, or correct the e-mail on your profile there.`
  );
}

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
