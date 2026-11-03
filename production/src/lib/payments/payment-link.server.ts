/**
 * Creating a Razorpay payment link and sending it — the IO half.
 *
 * Quote half (R-1608, not wired yet): createAndSendPaymentLink. Invoice half (R-2415, Send
 * reminder): getOrCreateInvoicePayLink / sweepStaleInvoicePayLinks — at the end of this file.
 *
 * The decisions are in payment-link.ts: what may be charged, in what unit, and whether a link
 * is allowed at all. This resolves credentials, calls the API, and sends the message through
 * the one chokepoint every customer-facing message in this codebase goes through.
 *
 * ─── THE SEND IS GATED, AND THAT IS WHY THIS FILE EXISTS ────────────────────
 * `autonomy-chokepoint.test.ts` refused the `payment.link.send` registry entry until something
 * actually passed it to `sendEmail`, on the grounds that "a registry entry nobody enforces is
 * worse than no entry — it reads as a control the operator does not have". It was right: the
 * dial was declared before the wiring existed, and the test caught it in the same minute.
 *
 * So the message goes through `sendEmail` with `automated`, which resolves the dial, records
 * the outcome in `email_log`, and refuses when the kill switch is on. Razorpay's own SMS and
 * email notifications are switched OFF in the request body for the same reason — see
 * `paymentLinkRequest`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { logDbError } from "@/lib/errors/db-error";
import { invoiceAmountDue } from "./amount-due";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { razorpayMode } from "./razorpay-readiness";
import { liveKeyCheckoutRefusal } from "@/lib/checkout/live-guards";
import { sendCustomerEmail } from "@/lib/messaging";
import {
  cardLinkNotice,
  decidePaymentLink,
  invoiceLinkAllocations,
  invoiceLinkKey,
  invoiceLinkRequest,
  linkAmountFor,
  paymentLinkMessage,
  paymentLinkRequest,
  planInvoiceLink,
  type CardLinkNotice,
  type InvoiceLinkScope,
  type LinkAllocation,
  type NoCardLinkReason,
} from "./payment-link";

const RAZORPAY_LINKS_URL = "https://api.razorpay.com/v1/payment_links";

/** A gateway call must not hold a request open indefinitely. */
const TIMEOUT_MS = 15_000;

export interface CreatePaymentLinkResult {
  ok: boolean;
  /** The short URL, when one was created. */
  url: string | null;
  /** One sentence a non-engineer can act on. */
  detail: string;
  /** Which gateway made it — so nothing downstream mistakes a sandbox link for revenue. */
  mode: "live" | "test" | null;
}

/**
 * Create a payment link for a quote and send it to the customer.
 *
 * Never throws: every caller is a route, a cron or an agent dispatcher, and none of them may
 * fail because a gateway was slow.
 */
export async function createAndSendPaymentLink(args: {
  admin: ReturnType<typeof createAdminClient>;
  tenantId: string;
  quoteId: string;
  /** The lead this quote belongs to, when there is one — the timeline note needs it, and
   *  `lead_activities.lead_id` is NOT NULL so there is nowhere to put an orphan note. */
  leadId?: string | null;
  /** ₹ outstanding, from lib/payments/amount-due — never recomputed here. */
  amountDue: number;
  quoteStatus: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  sellerName: string;
  fromEmail: string;
  expiresOn: string | null;
  callbackUrl?: string;
}): Promise<CreatePaymentLinkResult> {
  try {
    const { data: raw } = await args.admin
      .from("tenant_secrets")
      .select("razorpay_key_id, razorpay_key_secret")
      .eq("tenant_id", args.tenantId)
      .maybeSingle();

    const secrets = decryptTenantSecrets(raw);
    const keyId = secrets?.razorpay_key_id?.trim() ?? "";
    const keySecret = secrets?.razorpay_key_secret?.trim() ?? "";
    const mode = razorpayMode(keyId);

    /* R-2155: a live key on staging may read settlements, never mint a payment link. */
    const stagingLive = liveKeyCheckoutRefusal(keyId);
    if (stagingLive) return { ok: false, url: null, detail: stagingLive, mode: null };

    const decision = decidePaymentLink({
      mode,
      configured: Boolean(keyId && keySecret),
      amountDue: args.amountDue,
      quoteStatus: args.quoteStatus,
      contact: args.customerEmail ?? args.customerPhone,
    });

    if (!decision.create) {
      return { ok: false, url: null, detail: decision.detail, mode: null };
    }

    const body = paymentLinkRequest({
      quoteId: args.quoteId,
      amountDue: args.amountDue,
      customerName: args.customerName,
      customerEmail: args.customerEmail,
      customerPhone: args.customerPhone,
      sellerName: args.sellerName,
      tenantId: args.tenantId,
      expiresOn: args.expiresOn,
      callbackUrl: args.callbackUrl,
    });

    const res = await fetch(RAZORPAY_LINKS_URL, {
      method: "POST",
      headers: {
        /* Basic auth, key_id as the user and key_secret as the password — Razorpay's scheme. */
        authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await res.text();
    if (!res.ok) {
      /* Razorpay's own message, truncated. It is the only thing distinguishing "amount below
         the minimum" from "key revoked", and both arrive as a 400. */
      return {
        ok: false,
        url: null,
        mode,
        detail: `Razorpay refused the payment link (${res.status}): ${text.slice(0, 300)}`,
      };
    }

    const parsed = JSON.parse(text) as { short_url?: string; id?: string };
    const url = parsed.short_url?.trim();
    if (!url) {
      return { ok: false, url: null, mode, detail: "Razorpay returned no link URL" };
    }

    /* On the quote's timeline BEFORE the send, so a link that was created but could not be
       mailed is still recoverable by hand rather than lost. */
    if (args.leadId) {
      await args.admin.from("lead_activities").insert({
        tenant_id: args.tenantId,
        lead_id: args.leadId,
        kind: "note",
        detail:
          `Payment link created for ${args.quoteId} — ${url}` +
          (decision.note ? ` · ${decision.note}` : ""),
      }).then(() => undefined, () => undefined);
    }

    if (!args.customerEmail?.trim()) {
      /* No address: the link exists and is on the record, and the operator sends it on
         WhatsApp by hand. CLAUDE.md §24 — say what is missing and who can supply it. */
      return {
        ok: true,
        url,
        mode,
        detail: `Link created but not emailed — this customer has no email address. Copy it from the timeline. ${decision.note ?? ""}`.trim(),
      };
    }

    const sent = await sendCustomerEmail({
      to: args.customerEmail.trim(),
      from: args.fromEmail,
      subject: `Payment link for quote ${args.quoteId}`,
      text: paymentLinkMessage({
        customerName: args.customerName,
        quoteId: args.quoteId,
        amountDue: args.amountDue,
        url,
        mode,
      }),
      route: { tenantId: args.tenantId },
      kind: "quote_payment_link",
      /* THE GATE. Resolves `payment.link.send`, logs the outcome in email_log, and refuses when
         the kill switch is on — the same chokepoint every other customer-facing message uses. */
      automated: { tenantId: args.tenantId, action: "payment.link.send" },
    });

    return {
      ok: sent.status === "sent",
      url,
      mode,
      detail:
        sent.status === "sent"
          ? `Payment link sent to ${args.customerEmail}. ${decision.note ?? ""}`.trim()
          : `Link created but not sent (${sent.status}) — it is on the quote's timeline. ${decision.note ?? ""}`.trim(),
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : "unknown error";
    console.error("[payment-link] crashed:", err);
    return { ok: false, url: null, mode: null, detail: `Payment link failed — ${why}` };
  }
}

// ─── R-2415: one Razorpay link per open invoice / statement total ───────────
//
// Send reminder asks for the link of the bill (or the statement total) it is about. The FIRST
// ask makes it at Razorpay and keeps it in invoice_payment_links; every later ask gets the SAME
// link back while the amount is unchanged. A changed amount, other bills, a link near expiry →
// the old one is cancelled at Razorpay first, then a new one is made. A bill that was paid or
// closed another way has its link cancelled by sweepStaleInvoicePayLinks (on each ask for that
// customer, and daily from the invoice-dunning cron). Razorpay sends nothing itself — the
// reminder carries the link. The payment_link.paid webhook books it (settle_invoice_payment_link).

type Db = SupabaseClient;
type Fetch = typeof fetch;

export interface CardPayLink {
  url: string;
  /** Whole rupees the link asks for (linkAmountFor). */
  amount: number;
  /** Whole rupees of the bills it pays. */
  billAmount: number;
  mode: "live" | "test";
}

export type CardPayLinkResult =
  | { link: CardPayLink; notice: null }
  | { link: null; notice: CardLinkNotice | null };

interface LinkRow {
  id: string;
  status: string;
  amount: number;
  bill_amount: number;
  allocations: LinkAllocation[];
  created_at: string;
  expires_at: string | null;
  razorpay_link_id: string | null;
  short_url: string | null;
  mode: "live" | "test" | null;
}

const LINK_COLS = "id, status, amount, bill_amount, allocations, created_at, expires_at, razorpay_link_id, short_url, mode";

function basicAuth(keyId: string, keySecret: string): string {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

/** Razorpay's own error text, short — it is the only thing telling "key revoked" from "amount too low". */
function gatewayMessage(status: number, text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { description?: string } };
    if (j.error?.description) return `Razorpay ${status}: ${j.error.description}`.slice(0, 200);
  } catch {
    /* not JSON */
  }
  return `Razorpay ${status}`;
}

interface Keys { keyId: string; keySecret: string; mode: "live" | "test" }

async function tenantKeys(db: Db, tenantId: string): Promise<Keys | { refusal: NoCardLinkReason; detail?: string }> {
  const { data: raw } = await db
    .from("tenant_secrets")
    .select("razorpay_key_id, razorpay_key_secret")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const secrets = decryptTenantSecrets((raw ?? null) as { razorpay_key_id: string | null; razorpay_key_secret: string | null } | null);
  const keyId = secrets?.razorpay_key_id?.trim() ?? "";
  const keySecret = secrets?.razorpay_key_secret?.trim() ?? "";
  if (!keyId || !keySecret) return { refusal: "not_configured" };
  /* R-2155: a live key on staging may read settlements, never mint a payment link. */
  const stagingLive = liveKeyCheckoutRefusal(keyId);
  if (stagingLive) return { refusal: "live_key_on_staging", detail: stagingLive };
  return { keyId, keySecret, mode: razorpayMode(keyId) };
}

/**
 * Cancel a link at Razorpay. True when it is dead there (cancelled now, or already
 * cancelled / expired); false when it is still payable or was PAID — then nothing here may make
 * a second one (the webhook books the payment).
 */
export async function cancelRazorpayLink(keys: Keys, linkId: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${RAZORPAY_LINKS_URL}/${encodeURIComponent(linkId)}/cancel`, {
      method: "POST",
      headers: { authorization: basicAuth(keys.keyId, keys.keySecret), "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return true;
    const look = await fetchImpl(`${RAZORPAY_LINKS_URL}/${encodeURIComponent(linkId)}`, {
      headers: { authorization: basicAuth(keys.keyId, keys.keySecret) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!look.ok) return false;
    const j = (await look.json().catch(() => ({}))) as { status?: string };
    return j.status === "cancelled" || j.status === "expired";
  } catch (err) {
    console.error("[payment-link] cancel failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

async function markLink(db: Db, tenantId: string, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const { error } = await db
    .from("invoice_payment_links")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", id);
  if (error) logDbError("payment-link:mark", error);
  return !error;
}

/** Ids per invoices read — keeps the PostgREST URL short. */
const SWEEP_INVOICE_CHUNK = 100;

/**
 * Cancel the live links of bills that were paid, closed, written off or part-paid another way
 * (their due is now below what the link asks). Scoped to a tenant (+ customer) when given; the
 * cron passes neither, a limit and its per-tenant gate. Links past their Razorpay expiry are
 * closed here without a call (Razorpay already refuses them). The rows checked longest ago go
 * first, so a pile of still-open bills never hides a newer paid one.
 * Best-effort: a read error cancels NOTHING; a link that cannot be cancelled stays active, and
 * if it is paid anyway the webhook sends it to review instead of booking it.
 */
export async function sweepStaleInvoicePayLinks(args: {
  admin?: ReturnType<typeof createAdminClient>;
  tenantId?: string;
  customerId?: string;
  limit?: number;
  fetchImpl?: Fetch;
  /** R-897: the cron's per-tenant gate. */
  tenantAllowed?: (tenantId: string) => boolean;
  nowMs?: number;
}): Promise<{ checked: number; cancelled: number }> {
  const db = (args.admin ?? createAdminClient()) as unknown as Db;
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();

  /* Past their expiry at Razorpay → no longer live; no API call needed. */
  let exp = db
    .from("invoice_payment_links")
    .update({ status: "cancelled", cancelled_at: nowIso, cancel_reason: "expired", updated_at: nowIso })
    .eq("status", "active")
    .lt("expires_at", nowIso);
  if (args.tenantId) exp = exp.eq("tenant_id", args.tenantId);
  if (args.customerId) exp = exp.eq("customer_id", args.customerId);
  const { error: expErr } = await exp;
  if (expErr) logDbError("payment-link:sweep-expired", expErr);

  let q = db
    .from("invoice_payment_links")
    .select("id, tenant_id, allocations, razorpay_link_id")
    .eq("status", "active")
    .order("updated_at", { ascending: true })
    .limit(args.limit ?? 50);
  if (args.tenantId) q = q.eq("tenant_id", args.tenantId);
  if (args.customerId) q = q.eq("customer_id", args.customerId);
  const { data: rows, error } = await q;
  if (error || !rows?.length) {
    if (error) logDbError("payment-link:sweep", error);
    return { checked: 0, cancelled: 0 };
  }
  const links = (rows as { id: string; tenant_id: string; allocations: LinkAllocation[]; razorpay_link_id: string | null }[])
    .filter((l) => !args.tenantAllowed || args.tenantAllowed(l.tenant_id));
  const ids = [...new Set(links.flatMap((l) => (Array.isArray(l.allocations) ? l.allocations.map((a) => a.invoice_id) : [])))];
  type Inv = { id: string; tenant_id: string; status: string; amount: number | null; net_payable: number | null; paid_amount: number | null; written_off_at: string | null };
  const byId = new Map<string, Inv>();
  for (let i = 0; i < ids.length; i += SWEEP_INVOICE_CHUNK) {
    const { data: invs, error: invErr } = await db
      .from("invoices")
      .select("id, tenant_id, status, amount, net_payable, paid_amount, written_off_at")
      .in("id", ids.slice(i, i + SWEEP_INVOICE_CHUNK));
    /* A failed read must never look like "every bill is gone" — cancel nothing. */
    if (invErr) {
      logDbError("payment-link:sweep-invoices", invErr);
      return { checked: 0, cancelled: 0 };
    }
    for (const inv of (invs ?? []) as Inv[]) byId.set(`${inv.tenant_id}:${inv.id}`, inv);
  }

  const keysByTenant = new Map<string, Keys | null>();
  const kept: string[] = [];
  let cancelled = 0;
  for (const l of links) {
    const stale = (l.allocations ?? []).some((a) => {
      const inv = byId.get(`${l.tenant_id}:${a.invoice_id}`);
      if (!inv || (inv.status !== "pending" && inv.status !== "overdue")) return true;
      return Math.round(invoiceAmountDue(inv)) < Math.round(a.amount);
    });
    if (!stale || !l.razorpay_link_id) { kept.push(l.id); continue; }
    if (!keysByTenant.has(l.tenant_id)) {
      const k = await tenantKeys(db, l.tenant_id);
      keysByTenant.set(l.tenant_id, "refusal" in k ? null : k);
    }
    const keys = keysByTenant.get(l.tenant_id);
    if (keys && (await cancelRazorpayLink(keys, l.razorpay_link_id, args.fetchImpl))) {
      await markLink(db, l.tenant_id, l.id, { status: "cancelled", cancelled_at: nowIso, cancel_reason: "bill paid or closed" });
      cancelled += 1;
    } else {
      kept.push(l.id);
    }
  }
  /* Checked now → to the back of the queue. */
  if (kept.length) {
    const { error: touchErr } = await db.from("invoice_payment_links").update({ updated_at: nowIso }).in("id", kept);
    if (touchErr) logDbError("payment-link:sweep-touch", touchErr);
  }
  return { checked: links.length, cancelled };
}

/**
 * The Razorpay link for one open invoice (scope "invoice", one line) or for a customer's
 * statement total (scope "statement", every open line) — reused, replaced or made.
 *
 * Never throws: Send reminder must open with the UPI link even when Razorpay is down; the
 * answer then carries a notice saying why there is no card link (§24).
 * `tenantId` / `customerId` come from the route, which has already checked the caller.
 */
export async function getOrCreateInvoicePayLink(args: {
  tenantId: string;
  customerId: string;
  scope: InvoiceLinkScope;
  lines: readonly { kind: "invoice" | "subscription"; id: string; amountDue: number }[];
  sellerName: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  admin?: ReturnType<typeof createAdminClient>;
  fetchImpl?: Fetch;
  nowMs?: number;
}): Promise<CardPayLinkResult> {
  const nowMs = args.nowMs ?? Date.now();
  const fetchImpl = args.fetchImpl ?? fetch;
  const none = (reason: NoCardLinkReason, detail?: string | null): CardPayLinkResult => ({ link: null, notice: cardLinkNotice(reason, detail) });
  try {
    const db = (args.admin ?? createAdminClient()) as unknown as Db;

    const invoiceIds = args.lines.filter((l) => l.kind === "invoice").map((l) => l.id);
    const { data: invs, error: invErr } = invoiceIds.length
      ? await db.from("invoices").select("id, customer_id, quote_id, currency, status")
          .eq("tenant_id", args.tenantId).in("id", invoiceIds)
      : { data: [], error: null };
    if (invErr) throw invErr;
    const invoices = (invs ?? []) as { id: string; customer_id: string | null; quote_id: string | null; currency: string | null; status: string }[];
    const quoteIds = [...new Set(invoices.map((i) => i.quote_id).filter((x): x is string => !!x))];
    const { data: qs, error: qErr } = quoteIds.length
      ? await db.from("quotes").select("id, invoice_id").eq("tenant_id", args.tenantId).in("id", quoteIds)
      : { data: [], error: null };
    if (qErr) throw qErr;

    const pick = invoiceLinkAllocations({
      customerId: args.customerId,
      lines: args.lines,
      invoices,
      quotes: (qs ?? []) as { id: string; invoice_id: string | null }[],
    });
    if (!pick.ok) return none(pick.reason);

    const keys = await tenantKeys(db, args.tenantId);
    if ("refusal" in keys) return none(keys.refusal, keys.detail);

    /* Links of this customer's bills that were paid / closed another way go first. */
    await sweepStaleInvoicePayLinks({ admin: args.admin, tenantId: args.tenantId, customerId: args.customerId, fetchImpl })
      .catch((e: unknown) => console.error("[payment-link] sweep failed:", e instanceof Error ? e.message : e));

    const billAmount = pick.allocations.reduce((s, a) => s + a.amount, 0);
    const amount = linkAmountFor({ billAmount });
    const linkKey = args.scope === "invoice"
      ? invoiceLinkKey("invoice", pick.allocations[0].invoice_id)
      : invoiceLinkKey("statement", args.customerId);

    const { data: cur, error: curErr } = await db
      .from("invoice_payment_links")
      .select(LINK_COLS)
      .eq("tenant_id", args.tenantId)
      .eq("link_key", linkKey)
      .in("status", ["creating", "active"])
      .maybeSingle();
    if (curErr) throw curErr;
    let existing = (cur ?? null) as LinkRow | null;

    /* The key changed test ↔ live since this link was made: it belongs to the other Razorpay
       account (a test link takes no real money; the new key cannot cancel it) — retire it here
       and make one with the current key. */
    if (existing && existing.status === "active" && existing.mode && existing.mode !== keys.mode) {
      const ok = await markLink(db, args.tenantId, existing.id, {
        status: "cancelled", cancelled_at: new Date(nowMs).toISOString(), cancel_reason: `Razorpay key changed to ${keys.mode}`,
      });
      if (!ok) return none("gateway_error", null);
      existing = null;
    }

    const plan = planInvoiceLink(existing, { amount, allocations: pick.allocations }, nowMs);
    if (plan.action === "wait") return none("busy");
    if (plan.action === "reuse" && existing?.short_url) {
      return {
        link: { url: existing.short_url, amount: existing.amount, billAmount: existing.bill_amount, mode: existing.mode ?? keys.mode },
        notice: null,
      };
    }
    if (existing && plan.action !== "create") {
      if (existing.razorpay_link_id) {
        const dead = await cancelRazorpayLink(keys, existing.razorpay_link_id, fetchImpl);
        if (!dead) return none("gateway_error", "the old link could not be cancelled — it may have just been paid; reload in a minute");
        await markLink(db, args.tenantId, existing.id, {
          status: "cancelled", cancelled_at: new Date(nowMs).toISOString(),
          cancel_reason: plan.action === "replace" ? plan.reason : "replaced",
        });
      } else {
        await markLink(db, args.tenantId, existing.id, { status: "failed", cancel_reason: "stuck while creating" });
      }
    }

    /* Reserve first: the unique index lets ONE request make the link; a second gets "busy". */
    const { data: made, error: insErr } = await db
      .from("invoice_payment_links")
      .insert({
        tenant_id: args.tenantId,
        customer_id: args.customerId,
        scope: args.scope,
        invoice_id: args.scope === "invoice" ? pick.allocations[0].invoice_id : null,
        link_key: linkKey,
        allocations: pick.allocations,
        bill_amount: billAmount,
        amount,
        mode: keys.mode,
        status: "creating",
      })
      .select("id")
      .single();
    if (insErr) {
      if ((insErr as { code?: string }).code === "23505") return none("busy");
      throw insErr;
    }
    const rowId = (made as { id: string }).id;

    const body = invoiceLinkRequest({
      rowId,
      tenantId: args.tenantId,
      scope: args.scope,
      label: args.scope === "invoice"
        ? pick.allocations[0].invoice_id
        : `${pick.allocations.length} ${pick.allocations.length === 1 ? "bill" : "bills"}`,
      amount,
      sellerName: args.sellerName,
      customerName: args.customerName,
      customerEmail: args.customerEmail,
      customerPhone: args.customerPhone,
      nowMs,
    });
    const res = await fetchImpl(RAZORPAY_LINKS_URL, {
      method: "POST",
      headers: { authorization: basicAuth(keys.keyId, keys.keySecret), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      const why = gatewayMessage(res.status, text);
      await markLink(db, args.tenantId, rowId, { status: "failed", cancel_reason: why });
      return none("gateway_error", why);
    }
    const parsed = JSON.parse(text) as { id?: string; short_url?: string };
    const linkId = parsed.id?.trim() ?? "";
    const url = parsed.short_url?.trim() ?? "";
    if (!/^plink_[A-Za-z0-9]{6,40}$/.test(linkId) || !url.startsWith("https://")) {
      await markLink(db, args.tenantId, rowId, { status: "failed", cancel_reason: "Razorpay returned no link" });
      return none("gateway_error", "Razorpay returned no link");
    }
    const saved = await markLink(db, args.tenantId, rowId, {
      status: "active",
      razorpay_link_id: linkId,
      short_url: url,
      expires_at: body.expire_by ? new Date(body.expire_by * 1000).toISOString() : null,
    });
    if (!saved) {
      /* A link we could not record must never reach a customer — the webhook could not book it. */
      await cancelRazorpayLink(keys, linkId, fetchImpl);
      return none("gateway_error", "the link could not be saved");
    }
    return { link: { url, amount, billAmount, mode: keys.mode }, notice: null };
  } catch (err) {
    console.error("[payment-link] invoice link failed:", err instanceof Error ? err.message : err);
    return none("gateway_error", null);
  }
}
