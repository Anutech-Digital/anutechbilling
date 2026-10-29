/**
 * R-2099 — Banking → Reconcile → "Razorpay settlement" for one money-in line.
 *
 *   GET  ?txnId=<uuid>[&settlementId=setl_…]   find the settlement in Razorpay and show what it
 *                                              carried, matched to the app's payments (nothing saved)
 *   POST {txnId, settlementId?, picks?}        rebuild that plan from Razorpay (never trusting the
 *                                              browser's numbers) and, when nothing blocks it,
 *                                              reconcile in ONE database call
 *                                              (reconcile_razorpay_settlement)
 *
 * Owner / manager / accountant / billing — the roles that reconcile bank receipts. App reads and
 * the reconcile run on the signed-in user's own client (RLS + the RPC's own role check); the
 * service role only reads the company's sealed Razorpay keys.
 */
import { z } from "zod";
import { withRoute, dbFail, RouteError } from "@/lib/api/with-route";
import { createAdminClientFor } from "@/lib/supabase/server";
import { loadSettlementPlan } from "@/lib/razorpay/settlement.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES = ["owner", "manager", "accountant", "billing"] as const;
const ROLE_HINT = "Only Owner, Manager, Accountant or Billing can reconcile bank lines. Ask one of them.";

/** reconcile_razorpay_settlement's guard errcodes — its messages say what to do next. */
const GUARD_CODES = new Set(["P0001", "22023", "23514", "23505", "P0002", "42501"]);

const settlementId = z.string().regex(/^setl_[A-Za-z0-9]+$/, "Not a Razorpay settlement id").optional();

const getSchema = z.object({
  txnId: z.string().uuid("Bank line id is not valid — refresh the page."),
  settlementId,
});

const postSchema = z.object({
  txnId: z.string().uuid("Bank line id is not valid — refresh the page."),
  settlementId,
  picks: z.record(z.string().regex(/^pay_[A-Za-z0-9]+$/), z.string().uuid()).optional(),
});

export const GET = withRoute(
  { route: "api/banking/razorpay-settlement", roles: ROLES, roleHint: ROLE_HINT, input: getSchema },
  async ({ supabase, tenantId, user, input }) => {
    const result = await loadSettlementPlan({
      db: supabase,
      admin: createAdminClientFor(user.id),
      tenantId,
      txnId: input.txnId,
      settlementId: input.settlementId ?? null,
    });
    return { result };
  },
);

export const POST = withRoute(
  { route: "api/banking/razorpay-settlement", roles: ROLES, roleHint: ROLE_HINT, input: postSchema },
  async ({ supabase, tenantId, user, input }) => {
    const result = await loadSettlementPlan({
      db: supabase,
      admin: createAdminClientFor(user.id),
      tenantId,
      txnId: input.txnId,
      settlementId: input.settlementId ?? null,
      picks: input.picks ?? {},
    });
    if (result.state !== "plan") throw new RouteError(409, result.message);
    if (!result.plan.ready || !result.plan.rpcArg) {
      throw new RouteError(409, result.plan.blockers[0] ?? "This settlement cannot be reconciled yet — fetch it again.");
    }
    const { data, error } = await (supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
    }).rpc("reconcile_razorpay_settlement", { p_txn_id: input.txnId, p_settlement: result.plan.rpcArg });
    /* The function's own refusals are written for the user (what happened + next step). */
    if (error && error.code && GUARD_CODES.has(error.code)) {
      throw new RouteError(error.code === "42501" ? 403 : 409, error.message, `${error.code} ${error.message}`);
    }
    dbFail(error, "Could not reconcile the settlement — nothing was saved. Try again.", { passGuardMessage: true });
    return { reconciled: data, plan: result.plan };
  },
);
