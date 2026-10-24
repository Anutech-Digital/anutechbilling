/**
 * R-1009 — POST /api/contacts/reveal { table, id, field, purpose }
 *
 * A role without can_view_contact_details (sales, accountant) sees leads / customers / contacts
 * with the phone and email masked (the data gateway masks them — server/postgrest/contact-mask.ts).
 * roles.ts: "contact details stay masked until an explicit call / email action". This is that
 * action: the Call / WhatsApp / Email button asks here for the ONE value it is about to use.
 *
 *   · only a role with can_contact_customers (the partner agent has not),
 *   · read through the caller's own session, so RLS still decides which records it may open
 *     (a seller's assigned leads only),
 *   · only a contact column (CONTACT_COLUMNS) — this door opens nothing else,
 *   · every reveal written to activity_log (who, which record, what for — never the value),
 *   · 60 an hour per person, so a list cannot be copied out one click at a time.
 */
import { z } from "zod";
import { withRoute, RouteError, dbFail } from "@/lib/api/with-route";
import { createAdminClientFor } from "@/lib/supabase/server";
import { rateLimitShared } from "@/lib/security/rate-limit";
import { CONTACT_COLUMNS } from "@/server/postgrest/contact-mask";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENTITY = { leads: "lead", customers: "customer", contacts: "contact" } as const;
const PURPOSE = { call: "to call", whatsapp: "for WhatsApp", email: "to email" } as const;

const Input = z.object({
  table: z.enum(["leads", "customers", "contacts"]),
  id: z.string().uuid(),
  field: z.string(),
  purpose: z.enum(["call", "whatsapp", "email"]),
}).refine((v) => CONTACT_COLUMNS[v.table]?.includes(v.field), { message: "That is not a phone or email field." });

export const POST = withRoute(
  {
    route: "api/contacts/reveal",
    input: Input,
    permission: "can_contact_customers",
    roleHint: "Your role cannot call or email customers from the app. Ask the owner.",
  },
  async ({ supabase, input, tenantId, user }) => {
    const rl = await rateLimitShared(`contact-reveal:${user.id}`, { limit: 60, windowMs: 60 * 60_000 });
    if (!rl.ok) {
      throw new RouteError(429, `You have opened 60 numbers in the last hour. Try again in ${Math.ceil(rl.retryAfterSec / 60)} minutes, or ask the owner.`);
    }
    const from = supabase.from as unknown as (t: string) => {
      select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null }> } } };
    };
    const { data, error } = await from.call(supabase, input.table)
      .select(input.field)
      .eq("id", input.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    dbFail(error, "Could not open this number. Nothing changed — try again.");
    if (!data) throw new RouteError(404, `This ${ENTITY[input.table]} is not open to you, or it was deleted. Reload the list.`);
    const value = typeof data[input.field] === "string" ? (data[input.field] as string).trim() : "";
    const kind = input.field.includes("email") ? "email" : "phone number";
    if (!value) throw new RouteError(404, `No ${kind} is saved on this ${ENTITY[input.table]}. Add one first.`);

    const { error: logErr } = await createAdminClientFor(user.id).from("activity_log").insert({
      tenant_id: tenantId,
      user_id: user.id,
      action: "reveal_contact",
      entity: ENTITY[input.table],
      entity_id: input.id,
      label: `Opened the ${kind} ${PURPOSE[input.purpose]}`,
    });
    if (logErr) console.error("[api/contacts/reveal] activity_log insert failed:", logErr.message);
    return { value };
  },
);
