/**
 * Which address this workspace's mail leaves from — the first route moved onto the Prisma
 * path (plan: docs/PLAN-move-off-supabase.md, Phase 3). Before, it read `tenants` and
 * `users` with the service-role key and relied on `.eq("id", tenantId)`; now RLS decides,
 * so asking for another tenant's sender simply returns nothing.
 *
 * Never guesses: on Resend (a domain, no mailbox) or with nothing connected, the address is
 * null rather than the signed-in user's own email.
 */
import "server-only";
import { withTenant, type TenantSession } from "@/server/db";

export interface EmailSender {
  provider: string | null;
  address: string | null;
}

export async function emailSenderFor(session: TenantSession): Promise<EmailSender> {
  return withTenant(session, async (tx) => {
    const tenant = await tx.tenants.findUnique({
      where: { id: session.tenantId },
      select: { email_provider: true, gmail_sender_user_id: true },
    });
    const provider = tenant?.email_provider ?? null;
    if (provider !== "gmail" || !tenant?.gmail_sender_user_id) return { provider, address: null };

    const sender = await tx.public_users.findUnique({
      where: { id: tenant.gmail_sender_user_id },
      select: { email: true },
    });
    return { provider, address: sender?.email ?? null };
  });
}
