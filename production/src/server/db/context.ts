/**
 * @internal — imported only by src/server/db/index.ts, src/server/db/gateway.ts and
 * src/server/db/jobs.ts. The one place set_config is written. `true` = local to the transaction
 * (see index.ts).
 *
 * app.aal (R-731): the session's authenticator assurance level — "aal2" only after the second
 * step. public.session_mfa_ok() reads it: a user with a verified factor whose session is not
 * aal2 has NO tenant (current_tenant_id() is NULL), so every tenant policy gives them nothing.
 * Unknown ("" / undefined) is treated as aal1 — fail closed. Callers without a browser session
 * (jobs for a tenant, service work) pass nothing and are not users, so nothing changes for them.
 */
import type { Prisma } from "./generated/client";

export type Aal = "aal1" | "aal2";

export async function setContext(
  tx: Prisma.TransactionClient, userId: string | null, tenantId: string, aal?: Aal | null,
): Promise<void> {
  const aalValue = aal === "aal2" ? "aal2" : aal === "aal1" ? "aal1" : "";
  await tx.$executeRaw`select set_config('app.user_id', ${userId ?? ""}, true),
                              set_config('app.tenant_id', ${tenantId}, true),
                              set_config('app.aal', ${aalValue}, true)`;
}
