/**
 * R-1436: the owner links an employee profile to a teammate's login (users.employee_id) on the
 * Employees page, so a sales / support / delivery login can check in at /attendance/me.
 *
 * No new DB code: users_tenant_update keeps the write inside the caller's workspace, and
 * guard_privileged_user_columns (R-712, 20261011041200) lets only an ACTIVE OWNER of that
 * workspace change another login's employee_id, checks the employee is in the same workspace,
 * and refuses a second login on one employee. This file is the pure part: who sees the control,
 * which logins are offered, and the order of writes that guard accepts.
 */

export interface TenantLogin {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
  employee_id: string | null;
  is_active: boolean | null;
}

/** One users-row write: set (or clear, when null) that login's employee link. */
export interface LoginLinkWrite {
  userId: string;
  employeeId: string | null;
}

/** Only the owner — the guard refuses every other role, so nobody else gets a control that fails. */
export function canLinkLogins(role: string | null | undefined): boolean {
  return role === "owner";
}

export function linkedLoginFor(employeeId: string, logins: readonly TenantLogin[]): TenantLogin | null {
  return logins.find((l) => l.employee_id === employeeId) ?? null;
}

/** Active logins that are free, plus the one already linked to this employee. */
export function loginChoicesFor(employeeId: string, logins: readonly TenantLogin[]): TenantLogin[] {
  return logins.filter(
    (l) => l.is_active !== false && (l.employee_id === null || l.employee_id === employeeId),
  );
}

export function loginLabel(l: TenantLogin): string {
  return `${l.full_name || l.email || "Teammate"} · ${l.role}`;
}

/**
 * The writes for "this employee's login should now be `userId`" (null = unlink).
 * The old login is cleared FIRST: the guard refuses an employee_id another login still holds.
 */
export function planLoginLink(
  employeeId: string,
  userId: string | null,
  logins: readonly TenantLogin[],
): LoginLinkWrite[] {
  const current = linkedLoginFor(employeeId, logins);
  if (current && current.id === userId) return [];
  const writes: LoginLinkWrite[] = [];
  if (current) writes.push({ userId: current.id, employeeId: null });
  if (userId) writes.push({ userId, employeeId });
  return writes;
}
