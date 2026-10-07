/**
 * In-app khabar bhejne ka EK darwaza (audit B4).
 *
 * Server-side hi — browser se khabar banana spoofing hota (RLS insert bhi
 * service-role-only hai). Best-effort by design: khabar ka fail hona kabhi
 * us kaam ko na roke jiski wo khabar hai — payment record hona notification
 * se zyada zaroori hai. Isliye ye function throw NAHI karta; console.error
 * karta hai (jo health-digest ke stderr filter me aata hai).
 *
 * Recipients: tenant ke owner + manager (active). Row-per-recipient — read
 * state har insaan ki apni.
 */
import "server-only";
import { createAdminClient } from "@/lib/supabase/server";

export interface NotifyInput {
  tenantId: string;
  kind: "payment.received" | "payment.refunded" | "quote.accepted" | "lead.created" | "ticket.created";
  title: string;
  body?: string;
  href?: string;
  entityId?: string;
}

export async function notifyTenantOwners(input: NotifyInput): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: recipients, error: rErr } = await admin
      .from("users")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .in("role", ["owner", "manager"])
      .eq("is_active", true);
    if (rErr || !recipients?.length) {
      if (rErr) console.error("[notify] recipients read failed:", rErr.message);
      return;
    }

    const rows = recipients.map((u) => ({
      tenant_id: input.tenantId,
      user_id:   u.id,
      kind:      input.kind,
      title:     input.title.slice(0, 200),
      body:      input.body?.slice(0, 500) ?? null,
      href:      input.href ?? null,
      entity_id: input.entityId ?? null,
    }));
    const { error } = await admin.from("notifications").insert(rows);
    if (error) console.error("[notify] insert failed:", error.message);
  } catch (e) {
    console.error("[notify] crashed:", (e as Error).message);
  }
}
