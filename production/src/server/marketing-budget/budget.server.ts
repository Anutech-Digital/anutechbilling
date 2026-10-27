/**
 * Marketing budget & payments (R-1792) — reads and writes, through RLS (withTenant).
 *
 * The rules that move money live in the database (migration 20261023120000): only the owner
 * approves, a payment must fit what is left, only billing / owner mark it paid. This file asks
 * for those changes and turns the database's refusal into the sentence a person reads.
 */
import "server-only";
import { NextResponse } from "next/server";
import { getTenantSession } from "@/server/auth/session";
import { withTenant, type TenantSession, type Tx } from "@/server/db";
import { notifyPeople } from "@/lib/notifications/notify.server";
import { rupee } from "@/lib/utils";
import {
  BUDGET_ROLES, budgetLeft, budgetPaid, channelLabel, expenseFor, type BudgetChannel,
} from "@/lib/marketing-budget/budget";

export type Run = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface BudgetContext { session: TenantSession; run: Run; role: string; name: string }

export async function budgetContext(): Promise<BudgetContext | NextResponse> {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const run: Run = (fn) => withTenant(session, fn);
  const me = await run((tx) => tx.public_users.findUnique({
    where: { id: session.userId }, select: { role: true, is_active: true, full_name: true, email: true },
  }));
  const role = me && me.is_active !== false ? String(me.role) : null;
  if (!role || !(BUDGET_ROLES as readonly string[]).includes(role)) {
    return NextResponse.json(
      { error: "Marketing budgets are for marketing, the owner and billing.", detail: "Ask the owner to change your role on the Team page." },
      { status: 403 },
    );
  }
  return { session, run, role, name: me?.full_name?.trim() || me?.email || "Someone" };
}

/** The sentence from a database refusal (our triggers raise plain-language messages). */
export function dbMessage(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err ?? "");
  const m = /(?:ERROR:\s*|Message: `|message: ")([^`"\n]+)/.exec(text);
  const msg = (m?.[1] ?? "").trim();
  return msg && /budget|payment|owner|billing|left|approved|pending|cancel/i.test(msg) ? msg : null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export interface PaymentRow {
  id: string; budgetId: string; amount: number; payTo: string; purpose: string | null; billLink: string | null;
  dueOn: string | null; status: string; requestedBy: string; requestedByName: string; createdAt: string;
  paidOn: string | null; paidByName: string | null; paymentMode: string | null; reference: string | null;
  expenseId: string | null; decisionNote: string | null;
}

export interface BudgetRow {
  id: string; channel: string; channelLabel: string; productName: string | null; month: string;
  amountRequested: number; amountApproved: number | null; note: string | null; status: string;
  requestedBy: string; requestedByName: string; decidedByName: string | null; decidedAt: string | null;
  decisionNote: string | null; createdAt: string; left: number; paid: number; payments: PaymentRow[];
}

/** Everything this person may see (RLS decides: their own, or all for owner / billing). */
export async function listBudgets(run: Run): Promise<BudgetRow[]> {
  return run(async (tx) => {
    const budgets = await tx.marketing_budgets.findMany({ orderBy: [{ month: "desc" }, { created_at: "desc" }], take: 300 });
    const payments = budgets.length
      ? await tx.marketing_payment_requests.findMany({ where: { budget_id: { in: budgets.map((b) => b.id) } }, orderBy: { created_at: "desc" } })
      : [];
    const peopleIds = [...new Set([
      ...budgets.flatMap((b) => [b.requested_by, b.decided_by]),
      ...payments.flatMap((p) => [p.requested_by, p.paid_by]),
    ].filter((x): x is string => !!x))];
    const people = new Map((await tx.public_users.findMany({
      where: { id: { in: peopleIds } }, select: { id: true, full_name: true, email: true },
    })).map((u) => [u.id, u.full_name?.trim() || u.email || "Someone"]));
    const who = (id: string | null) => (id ? people.get(id) ?? "Someone" : null);

    return budgets.map((b) => {
      const mine = payments.filter((p) => p.budget_id === b.id);
      return {
        id: b.id, channel: b.channel, channelLabel: channelLabel(b.channel), productName: b.product_name,
        month: day(b.month) as string, amountRequested: b.amount_requested, amountApproved: b.amount_approved,
        note: b.note, status: b.status, requestedBy: b.requested_by, requestedByName: who(b.requested_by) as string,
        decidedByName: who(b.decided_by), decidedAt: iso(b.decided_at), decisionNote: b.decision_note,
        createdAt: iso(b.created_at) as string,
        left: b.status === "approved" ? budgetLeft(b.amount_approved, mine) : 0,
        paid: budgetPaid(mine),
        payments: mine.map((p) => ({
          id: p.id, budgetId: p.budget_id, amount: p.amount, payTo: p.pay_to, purpose: p.purpose, billLink: p.bill_link,
          dueOn: day(p.due_on), status: p.status, requestedBy: p.requested_by, requestedByName: who(p.requested_by) as string,
          createdAt: iso(p.created_at) as string, paidOn: day(p.paid_on), paidByName: who(p.paid_by),
          paymentMode: p.payment_mode, reference: p.reference, expenseId: p.expense_id, decisionNote: p.decision_note,
        })),
      };
    });
  });
}

export type Refusal = { ok: false; status: number; error: string; detail?: string };
export type Result<T = object> = ({ ok: true } & T) | Refusal;

function refused(err: unknown, fallback: string): Refusal {
  const msg = dbMessage(err);
  if (msg) return { ok: false, status: 409, error: msg };
  console.error(`[marketing-budget] ${fallback}:`, err);
  return { ok: false, status: 500, error: fallback, detail: "Try again in a moment." };
}

const rupees = (n: number) => rupee(n);
const monthName = (d: Date) => d.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });

export async function askBudget(ctx: BudgetContext, input: {
  channel: BudgetChannel; productItemId: string | null; productName: string | null; month: Date; amount: number; note: string | null;
}): Promise<Result<{ id: string }>> {
  try {
    const row = await ctx.run((tx) => tx.marketing_budgets.create({
      data: {
        tenant_id: ctx.session.tenantId, requested_by: ctx.session.userId, channel: input.channel,
        product_item_id: input.productItemId, product_name: input.productName, month: input.month,
        amount_requested: input.amount, note: input.note,
      },
      select: { id: true },
    }));
    await notifyPeople({
      tenantId: ctx.session.tenantId, kind: "marketing.budget",
      title: `${ctx.name} asks for ${rupees(input.amount)} — ${channelLabel(input.channel)}, ${monthName(input.month)}`,
      body: [input.productName, input.note].filter(Boolean).join(" · ") || undefined,
      href: "/marketing/budget", entityId: row.id,
    }, { roles: ["owner"] });
    return { ok: true, id: row.id };
  } catch (err) { return refused(err, "Could not send the budget request."); }
}

export async function decideBudget(ctx: BudgetContext, id: string, input: {
  decision: "approve" | "reject"; amount: number | null; note: string | null;
}): Promise<Result> {
  try {
    const b = await ctx.run(async (tx) => {
      const cur = await tx.marketing_budgets.findUnique({ where: { id } });
      if (!cur) return null;
      await tx.marketing_budgets.update({
        where: { id },
        data: input.decision === "approve"
          ? { status: "approved", amount_approved: input.amount ?? cur.amount_requested, decision_note: input.note }
          : { status: "rejected", decision_note: input.note },
      });
      return cur;
    });
    if (!b) return { ok: false, status: 404, error: "That budget request is not here any more.", detail: "Refresh the page." };
    const approved = input.amount ?? b.amount_requested;
    await notifyPeople({
      tenantId: ctx.session.tenantId, kind: "marketing.budget",
      title: input.decision === "approve"
        ? `Budget approved: ${rupees(approved)} — ${channelLabel(b.channel)}, ${monthName(b.month)}`
        : `Budget not approved — ${channelLabel(b.channel)}, ${monthName(b.month)}`,
      body: input.note ?? undefined, href: "/marketing/budget", entityId: id,
    }, { userIds: [b.requested_by], roles: input.decision === "approve" ? ["billing"] : [] });
    return { ok: true };
  } catch (err) { return refused(err, "Could not save the decision."); }
}

export async function cancelBudget(ctx: BudgetContext, id: string): Promise<Result> {
  try {
    const n = await ctx.run((tx) => tx.marketing_budgets.updateMany({ where: { id, status: "pending" }, data: { status: "cancelled" } }));
    return n.count ? { ok: true } : { ok: false, status: 409, error: "Only a request still waiting for the owner can be withdrawn." };
  } catch (err) { return refused(err, "Could not withdraw the request."); }
}

export async function askPayment(ctx: BudgetContext, input: {
  budgetId: string; amount: number; payTo: string; purpose: string | null; billLink: string | null; dueOn: Date | null;
}): Promise<Result<{ id: string }>> {
  try {
    const row = await ctx.run((tx) => tx.marketing_payment_requests.create({
      data: {
        tenant_id: ctx.session.tenantId, budget_id: input.budgetId, requested_by: ctx.session.userId,
        amount: input.amount, pay_to: input.payTo, purpose: input.purpose, bill_link: input.billLink, due_on: input.dueOn,
      },
      select: { id: true },
    }));
    await notifyPeople({
      tenantId: ctx.session.tenantId, kind: "marketing.budget",
      title: `Please pay ${rupees(input.amount)} to ${input.payTo} — marketing budget`,
      body: input.purpose ?? undefined, href: "/marketing/budget", entityId: row.id,
    }, { roles: ["billing"] });
    return { ok: true, id: row.id };
  } catch (err) { return refused(err, "Could not send the payment request."); }
}

/**
 * Billing paid it: the request is marked paid and the expense is written in the SAME
 * transaction — either both happen or neither.
 */
export async function markPaid(ctx: BudgetContext, id: string, input: {
  paidOn: Date; mode: string | null; reference: string | null;
}): Promise<Result<{ expenseId: string }>> {
  try {
    const out = await ctx.run(async (tx) => {
      const p = await tx.marketing_payment_requests.findUnique({ where: { id } });
      if (!p) return null;
      const b = await tx.marketing_budgets.findUnique({ where: { id: p.budget_id } });
      if (!b) return null;
      const e = expenseFor(b, p);
      const expenseId = `EXP-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 256).toString(16).padStart(2, "0").toUpperCase()}`;
      await tx.expenses.create({
        data: {
          id: expenseId, tenant_id: ctx.session.tenantId, category: e.category, channel: e.channel,
          vendor_name: e.vendor_name, description: e.description, expense_date: input.paidOn, amount: p.amount,
          payment_method: input.mode, paid: true, paid_date: input.paidOn,
          notes: input.reference ? `UTR / ref: ${input.reference}` : null,
        },
      });
      /* One update, after the expense: a paid request is final (the database refuses any later
         change), so the expense link must ride on the same write that marks it paid. If the
         database refuses (not billing, already paid), the expense above rolls back with it. */
      await tx.marketing_payment_requests.update({
        where: { id },
        data: { status: "paid", paid_on: input.paidOn, payment_mode: input.mode, reference: input.reference, expense_id: expenseId },
      });
      return { p, expenseId };
    });
    if (!out) return { ok: false, status: 404, error: "That payment request is not here any more.", detail: "Refresh the page." };
    await notifyPeople({
      tenantId: ctx.session.tenantId, kind: "marketing.budget",
      title: `Paid ${rupees(out.p.amount)} to ${out.p.pay_to}`,
      body: input.reference ? `UTR / ref: ${input.reference}` : undefined, href: "/marketing/budget", entityId: id,
    }, { userIds: [out.p.requested_by] });
    return { ok: true, expenseId: out.expenseId };
  } catch (err) { return refused(err, "Could not mark it paid."); }
}

/** Billing sends it back (wrong details), or the person who asked cancels it. */
export async function closePayment(ctx: BudgetContext, id: string, input: { status: "rejected" | "cancelled"; note: string | null }): Promise<Result> {
  try {
    const p = await ctx.run(async (tx) => {
      const cur = await tx.marketing_payment_requests.findUnique({ where: { id } });
      if (!cur) return null;
      await tx.marketing_payment_requests.update({ where: { id }, data: { status: input.status, decision_note: input.note } });
      return cur;
    });
    if (!p) return { ok: false, status: 404, error: "That payment request is not here any more.", detail: "Refresh the page." };
    if (input.status === "rejected") {
      await notifyPeople({
        tenantId: ctx.session.tenantId, kind: "marketing.budget",
        title: `Payment sent back: ${rupees(p.amount)} to ${p.pay_to}`,
        body: input.note ?? undefined, href: "/marketing/budget", entityId: id,
      }, { userIds: [p.requested_by] });
    }
    return { ok: true };
  } catch (err) { return refused(err, "Could not update the payment request."); }
}
