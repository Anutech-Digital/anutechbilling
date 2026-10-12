/**
 * S28 — send one WhatsApp reminder and log it. Called by the renewals and invoice-dunning
 * crons, AFTER their own email step, and it NEVER THROWS: a WhatsApp problem must not turn
 * into a re-sent email or a dunning step logged as failed.
 *
 * ─── WHY AN INJECTED STORE ─────────────────────────────────────────────────
 * The three reminder tables are not in the generated Database type (AGENTS.md L31 — one more
 * table collapses the whole type), so they are reached through an untyped handle, kept in
 * this one file. The store interface also lets the tests prove the default-off guard and
 * the opt-out skip without a database or a network.
 *
 * Untyped means NOTHING checks the tenant filter — every query below carries an explicit
 * `.eq("tenant_id", …)`, and that line is the boundary.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { sendCustomerWhatsApp, type WhatsAppSendOpts } from "@/lib/messaging";
import { WhatsAppNotConfiguredError } from "@/lib/whatsapp/send-failure";
import { loadAutonomyPolicy } from "@/lib/ai/autonomy.server";
import { resolveAutonomy } from "@/lib/ai/autonomy";
import { primaryContactFor } from "@/lib/contacts/primary";
import { normalizeWaPhone } from "./whatsapp-broadcast";
import {
  decideReminder, pickReminderTemplate, reminderAction, reminderComponents, slotValues,
  type ApprovedTemplate, type ReminderKind, type ReminderSubject, type ReminderTemplateRow,
  type ReminderValues, type SkipReason,
} from "./whatsapp-reminders";

export interface ReminderRequest {
  tenantId: string;
  kind: ReminderKind;
  subjectType: ReminderSubject;
  subjectId: string;
  /** Cadence / dunning step — the dedupe key together with the subject. */
  step: string;
  customerId: string | null;
  values: ReminderValues;
}

export type ReminderOutcome =
  | { status: "sent"; wamid: string | null }
  | { status: "skipped"; reason: SkipReason }
  | { status: "failed"; error: string };

export interface TenantReminderConfig {
  enabled: boolean;
  templates: ReminderTemplateRow[];
  approved: ApprovedTemplate[];
}

export interface ReminderLogRow {
  tenant_id: string; kind: ReminderKind; subject_type: ReminderSubject; subject_id: string; step: string;
  phone: string | null; template_name: string | null; wamid: string | null;
  status: "sent" | "failed" | "skipped"; skip_reason: string | null; error_message: string | null;
  sent_at: string | null;
}

export interface ReminderStore {
  loadConfig(tenantId: string): Promise<TenantReminderConfig>;
  resolvePhone(tenantId: string, customerId: string | null): Promise<string | null>;
  isOptedOut(tenantId: string, phone: string): Promise<boolean>;
  alreadySent(tenantId: string, subjectType: ReminderSubject, subjectId: string, step: string): Promise<boolean>;
  insertLog(row: ReminderLogRow): Promise<void>;
}

export interface ReminderDeps {
  store: ReminderStore;
  automationAllows(tenantId: string, kind: ReminderKind): Promise<boolean>;
  send(opts: WhatsAppSendOpts): Promise<{ wamid: string | null }>;
  now(): Date;
}

export interface ReminderSender {
  send(req: ReminderRequest): Promise<ReminderOutcome>;
  /** Counts for the cron's result body. */
  readonly totals: { sent: number; skipped: number; failed: number; disabled: number };
}

/** A sender for one cron run. Tenant config is read once per tenant per run, not per row. */
export function createReminderSender(deps: ReminderDeps = defaultDeps()): ReminderSender {
  const configs = new Map<string, Promise<TenantReminderConfig>>();
  const totals = { sent: 0, skipped: 0, failed: 0, disabled: 0 };

  const configFor = (tenantId: string) => {
    let p = configs.get(tenantId);
    if (!p) {
      /* Config read fail hua to OFF maano — "pata nahi ON hai ya nahi" ka jawab bhejna nahi hai. */
      p = deps.store.loadConfig(tenantId).catch((): TenantReminderConfig => ({ enabled: false, templates: [], approved: [] }));
      configs.set(tenantId, p);
    }
    return p;
  };

  async function send(req: ReminderRequest): Promise<ReminderOutcome> {
    try {
      const cfg = await configFor(req.tenantId);
      if (!cfg.enabled) { totals.disabled++; return { status: "skipped", reason: "disabled" }; }

      const [alreadySent, automationAllows, phone] = await Promise.all([
        deps.store.alreadySent(req.tenantId, req.subjectType, req.subjectId, req.step),
        deps.automationAllows(req.tenantId, req.kind),
        deps.store.resolvePhone(req.tenantId, req.customerId),
      ]);
      const optedOut = phone ? await deps.store.isOptedOut(req.tenantId, phone) : false;
      const pick = pickReminderTemplate(req.kind, cfg.templates, cfg.approved);
      const decision = decideReminder({ enabled: true, automationAllows, pick, phone, optedOut, alreadySent });

      const base = {
        tenant_id: req.tenantId, kind: req.kind, subject_type: req.subjectType,
        subject_id: req.subjectId, step: req.step, phone,
      };

      if (!decision.send) {
        totals.skipped++;
        if (decision.log) {
          await deps.store.insertLog({
            ...base, template_name: pick.ok ? pick.template.name : null, wamid: null,
            status: "skipped", skip_reason: decision.reason, error_message: null, sent_at: null,
          });
        }
        return { status: "skipped", reason: decision.reason };
      }

      const slots = slotValues(decision.template.paramMap, req.values);
      if (!slots.ok) {
        totals.skipped++;
        await deps.store.insertLog({
          ...base, template_name: decision.template.name, wamid: null, status: "skipped",
          skip_reason: "missing_value", error_message: `No value for {{${slots.missing}}}`, sent_at: null,
        });
        return { status: "skipped", reason: "missing_value" };
      }

      try {
        const r = await deps.send({
          tenantId: req.tenantId,
          to: phone!,
          message: {
            kind: "template",
            name: decision.template.name,
            language: decision.template.language,
            components: reminderComponents(slots.values),
          },
          related: { customerId: req.customerId },
        });
        await deps.store.insertLog({
          ...base, template_name: decision.template.name, wamid: r.wamid, status: "sent",
          skip_reason: null, error_message: null, sent_at: deps.now().toISOString(),
        });
        totals.sent++;
        return { status: "sent", wamid: r.wamid };
      } catch (e) {
        const notConfigured = e instanceof WhatsAppNotConfiguredError;
        const message = e instanceof Error ? e.message : String(e);
        await deps.store.insertLog({
          ...base, template_name: decision.template.name, wamid: null,
          status: notConfigured ? "skipped" : "failed",
          skip_reason: notConfigured ? "not_configured" : null,
          error_message: message.slice(0, 500), sent_at: null,
        });
        if (notConfigured) { totals.skipped++; return { status: "skipped", reason: "not_configured" }; }
        totals.failed++;
        return { status: "failed", error: message };
      }
    } catch (e) {
      /* Log likhna bhi fail ho gaya — cron ko phir bhi mat roko, bas ginti me dikhao. */
      totals.failed++;
      return { status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { send, totals };
}

/* ─── The real store ─────────────────────────────────────────────────────── */

/* Schema-less client: same untyped handle as lib/contacts/primary.ts (see header). */
type Untyped = Pick<SupabaseClient, "from">;

export function supabaseReminderStore(admin: ReturnType<typeof createAdminClient>): ReminderStore {
  const db = admin as unknown as Untyped;
  return {
    async loadConfig(tenantId) {
      const [s, t, a] = await Promise.all([
        db.from("whatsapp_reminder_settings").select("enabled").eq("tenant_id", tenantId).maybeSingle(),
        db.from("whatsapp_reminder_templates").select("kind, template_name, language, param_map, enabled").eq("tenant_id", tenantId),
        db.from("whatsapp_templates").select("name, language, status").eq("tenant_id", tenantId).eq("status", "approved"),
      ]);
      if (s.error) throw s.error;
      if (t.error) throw t.error;
      if (a.error) throw a.error;
      return {
        enabled: (s.data as { enabled?: boolean } | null)?.enabled === true,
        templates: (t.data ?? []) as ReminderTemplateRow[],
        approved: (a.data ?? []) as ApprovedTemplate[],
      };
    },
    async resolvePhone(tenantId, customerId) {
      if (!customerId) return null;
      const primary = await primaryContactFor(admin, customerId);
      let raw = primary.phone;
      if (!raw) {
        /* Wahi floor jo email ke liye hai (lib/contacts/primary.ts): contact row na ho to
           purana customers.contact_phone. */
        const { data } = await db.from("customers").select("contact_phone")
          .eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
        raw = (data as { contact_phone?: string | null } | null)?.contact_phone ?? null;
      }
      return normalizeWaPhone(raw);
    },
    async isOptedOut(tenantId, phone) {
      const { data, error } = await db.from("whatsapp_opt_outs").select("phone")
        .eq("tenant_id", tenantId).eq("phone", phone).maybeSingle();
      /* Opt-out padh nahi paaye to bhejo MAT — STOP bolne wale ko message jaana report hota hai. */
      if (error) return true;
      return Boolean(data);
    },
    async alreadySent(tenantId, subjectType, subjectId, step) {
      const { data, error } = await db.from("whatsapp_reminder_log").select("id")
        .eq("tenant_id", tenantId).eq("subject_type", subjectType).eq("subject_id", subjectId)
        .eq("step", step).in("status", ["sent", "delivered", "read"]).limit(1);
      if (error) return true;
      return (data ?? []).length > 0;
    },
    async insertLog(row) {
      const { error } = await db.from("whatsapp_reminder_log").insert(row);
      /* 23505 = do run ek saath — doosre ne pehle likh diya. Wahi sahi hai, error nahi. */
      if (error && error.code !== "23505") throw error;
    },
  };
}

function defaultDeps(): ReminderDeps {
  const admin = createAdminClient();
  const policies = new Map<string, ReturnType<typeof loadAutonomyPolicy>>();
  return {
    store: supabaseReminderStore(admin),
    async automationAllows(tenantId, kind) {
      let p = policies.get(tenantId);
      if (!p) { p = loadAutonomyPolicy(tenantId); policies.set(tenantId, p); }
      return resolveAutonomy(reminderAction(kind), await p).mode === "auto";
    },
    send: (opts) => sendCustomerWhatsApp(opts),
    now: () => new Date(),
  };
}
