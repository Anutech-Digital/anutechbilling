/**
 * /api/marketing/whatsapp/reminders — S28 settings screen for WhatsApp renewal / invoice
 * reminders (tables from migration 20260928150000).
 *
 *   GET     switch + per-kind template mapping + what would block each kind today
 *           (approval, automation dial, WhatsApp connection) + last 20 log rows.
 *   PATCH   { enabled }                                   — the master switch.
 *   PUT     { kind, template_name, language, param_map, enabled } — map a template to a kind.
 *   DELETE  { kind }                                      — remove that mapping.
 *
 * Owner / manager only: the switch starts messages to CUSTOMERS, and the RLS policies on
 * both tables say the same. Writes go through the service role with tenant_id taken from
 * the caller's own users row (withRoute), never from the body.
 */
import { z } from "zod";
import { createAdminClientFor } from "@/lib/supabase/server";
import { withRoute, RouteError, dbFail } from "@/lib/api/with-route";
import { resolveWhatsAppCreds } from "@/lib/whatsapp/client";
import { loadAutonomyPolicy } from "@/lib/ai/autonomy.server";
import { resolveAutonomy } from "@/lib/ai/autonomy";
import {
  REMINDER_KINDS, REMINDER_PARAM_FIELDS, reminderAction, isReminderKind,
  type ReminderKind, type ReminderTemplateRow,
} from "@/lib/marketing/whatsapp-reminders";
import { kindReadiness, mappingProblem, REMINDER_KIND_ORDER, type KnownTemplate } from "@/lib/marketing/whatsapp-reminders-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OM = ["owner", "manager"] as const;
const ROLE_HINT = "Only the owner or a manager can change WhatsApp reminders — ask them.";
const LOG_LIMIT = 20;

export const GET = withRoute({ route: "api/marketing/whatsapp/reminders", roles: OM, roleHint: ROLE_HINT }, async ({ tenantId, user }) => {
  const db = createAdminClientFor(user.id);
  const [s, m, t, l, creds, policy] = await Promise.all([
    db.from("whatsapp_reminder_settings").select("enabled, updated_at").eq("tenant_id", tenantId).maybeSingle(),
    db.from("whatsapp_reminder_templates").select("kind, template_name, language, param_map, enabled, updated_at").eq("tenant_id", tenantId),
    db.from("whatsapp_templates").select("name, language, status, body").eq("tenant_id", tenantId).order("name"),
    db.from("whatsapp_reminder_log")
      .select("id, kind, subject_type, subject_id, step, phone, template_name, status, skip_reason, error_message, sent_at, delivered_at, read_at, failed_at, created_at")
      .eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(LOG_LIMIT),
    resolveWhatsAppCreds(tenantId).catch(() => null),
    loadAutonomyPolicy(tenantId),
  ]);
  dbFail(s.error, "Could not load WhatsApp reminder settings — refresh the page.");
  dbFail(m.error, "Could not load reminder templates — refresh the page.");
  dbFail(t.error, "Could not load WhatsApp templates — refresh the page.");
  dbFail(l.error, "Could not load the reminder log — refresh the page.");

  const enabled = s.data?.enabled === true;
  const connected = Boolean(creds);
  const templates: KnownTemplate[] = (t.data ?? []).map((x) => ({ name: x.name, language: x.language, status: x.status, body: x.body }));
  const mappings = (m.data ?? []) as (ReminderTemplateRow & { updated_at: string })[];

  const dial = {
    killSwitch: policy.killSwitch,
    renewal: resolveAutonomy("renewal.send", policy).mode,
    dunning: resolveAutonomy("dunning.send", policy).mode,
  };

  const kinds = REMINDER_KIND_ORDER.map((kind) => {
    const mapping = mappings.find((r) => r.kind === kind) ?? null;
    const dialMode = resolveAutonomy(reminderAction(kind), policy).mode;
    const known = mapping ? templates.find((x) => x.name === mapping.template_name && x.language === mapping.language) ?? null : null;
    return {
      kind,
      label: REMINDER_KINDS[kind].label,
      subject: REMINDER_KINDS[kind].subject,
      dialMode,
      mapping: mapping && {
        template_name: mapping.template_name, language: mapping.language,
        param_map: Array.isArray(mapping.param_map) ? mapping.param_map : [],
        enabled: mapping.enabled, updated_at: mapping.updated_at,
      },
      templateStatus: known?.status ?? null,
      readiness: kindReadiness({ kind, switchOn: enabled, connected, dialMode, killSwitch: policy.killSwitch, mapping, templates }),
    };
  });

  return {
    enabled,
    updatedAt: s.data?.updated_at ?? null,
    connected,
    dial,
    kinds,
    templates,
    log: l.data ?? [],
  };
});

const switchSchema = z.object({
  enabled: z.boolean({ message: "enabled (true / false) is required." }),
});

export const PATCH = withRoute(
  { route: "api/marketing/whatsapp/reminders", input: switchSchema, roles: OM, roleHint: ROLE_HINT },
  async ({ input, tenantId, user }) => {
    const { error } = await createAdminClientFor(user.id).from("whatsapp_reminder_settings").upsert(
      { tenant_id: tenantId, enabled: input.enabled, updated_by: user.id, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id" },
    );
    dbFail(error, "Switch was not saved — refresh the page and try again.");
    return { enabled: input.enabled };
  },
);

const kindSchema = z.string({ message: "Reminder kind is required." })
  .refine((k): k is ReminderKind => isReminderKind(k), "This is not a reminder kind — refresh the page.");

const mappingSchema = z.object({
  kind: kindSchema,
  template_name: z.string({ message: "Enter the template name." }).trim().toLowerCase().min(1, "Enter the template name."),
  language: z.string().trim().min(2, "Enter the language (e.g. en).").max(10, "Language can be up to 10 characters.").default("en"),
  param_map: z.array(z.enum(Object.keys(REMINDER_PARAM_FIELDS) as [keyof typeof REMINDER_PARAM_FIELDS, ...(keyof typeof REMINDER_PARAM_FIELDS)[]], {
    message: "Pick a field from the list for each {{n}}.",
  })).max(20, "There can be at most 20 {{n}}."),
  enabled: z.boolean().default(true),
});

export const PUT = withRoute(
  { route: "api/marketing/whatsapp/reminders", input: mappingSchema, roles: OM, roleHint: ROLE_HINT },
  async ({ input, tenantId, user }) => {
    const db = createAdminClientFor(user.id);
    /* Agar app ke paas is naam + language ka text hai to {{n}} ki ginti usi se milao — Meta
       ek bhi kam/zyada parameter wala send reject karta hai, aur wo failure cron me dikhta. */
    const { data: known, error: kErr } = await db.from("whatsapp_templates").select("body")
      .eq("tenant_id", tenantId).eq("name", input.template_name).eq("language", input.language).maybeSingle();
    dbFail(kErr, "Could not check the template — try again.");

    const problem = mappingProblem(input.template_name, input.language, input.param_map, known?.body ?? null);
    if (problem) throw new RouteError(400, problem);

    const { error } = await db.from("whatsapp_reminder_templates").upsert(
      {
        tenant_id: tenantId, kind: input.kind, template_name: input.template_name, language: input.language,
        param_map: input.param_map, enabled: input.enabled, updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,kind" },
    );
    dbFail(error, "Template mapping was not saved — try again.");
    return { kind: input.kind };
  },
);

const deleteSchema = z.object({ kind: kindSchema });

export const DELETE = withRoute(
  { route: "api/marketing/whatsapp/reminders", input: deleteSchema, roles: OM, roleHint: ROLE_HINT },
  async ({ input, tenantId, user }) => {
    const { error } = await createAdminClientFor(user.id).from("whatsapp_reminder_templates")
      .delete().eq("tenant_id", tenantId).eq("kind", input.kind);
    dbFail(error, "Could not remove the mapping — try again.");
    return { kind: input.kind };
  },
);
