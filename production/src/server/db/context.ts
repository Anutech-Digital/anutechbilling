/**
 * @internal — imported only by src/server/db/index.ts and src/server/db/jobs.ts.
 * The one place set_config is written. `true` = local to the transaction (see index.ts).
 */
import type { Prisma } from "./generated/client";

export async function setContext(tx: Prisma.TransactionClient, userId: string | null, tenantId: string): Promise<void> {
  await tx.$executeRaw`select set_config('app.user_id', ${userId ?? ""}, true),
                              set_config('app.tenant_id', ${tenantId}, true)`;
}
