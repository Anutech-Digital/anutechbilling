/**
 * R-2654 — Banking → Razorpay settlements for a whole month.
 *
 *   GET  ?accountId=<uuid>&month=YYYY-MM          the ready / blocked table (Razorpay read once; nothing saved)
 *   POST {action: "run", accountId, month, txnIds?}  re-plan on the server and book every ready line under
 *                                                  ONE run id (razorpay_batch_run_start +
 *                                                  reconcile_razorpay_settlement_in_run per line)
 *   POST {action: "undo", runId}                   "Undo this run" (undo_bank_recon_run)
 *
 * Owner / accountant only — a run books fee expenses for many lines at once and its Undo removes them
 * (the same gate as Reconcile from Zoho's run, R-2535). The browser sends no amount: every number comes
 * from Razorpay and the app's own rows, and the database re-checks each line (R-2099).
 */
import { z } from "zod";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { createAdminClientFor } from "@/lib/supabase/server";
import { loadMonthBatch, runMonthBatch, undoMonthRun } from "@/lib/razorpay/settlement-batch.server";
import { MONTH_RE } from "@/lib/razorpay/settlement-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ROLES = ["owner", "accountant"] as const;
const ROLE_HINT = "Only the Owner or Accountant can reconcile Razorpay settlements in bulk. Ask one of them, or reconcile a line on its own from Reconcile.";

const uuid = z.string().uuid("Bank account id is not valid — refresh the page.");
const month = z.string().regex(MONTH_RE, "Pick a month (YYYY-MM).");

const getSchema = z.object({ accountId: uuid, month });

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run"), accountId: uuid, month, txnIds: z.array(z.string().uuid()).max(300).optional() }),
  z.object({ action: z.literal("undo"), runId: z.string().uuid("Run id is not valid — refresh the page.") }),
]);

export const GET = withRoute(
  { route: "api/banking/razorpay-settlement/month", roles: ROLES, roleHint: ROLE_HINT, input: getSchema },
  async ({ supabase, tenantId, user, input }) => {
    const result = await loadMonthBatch({ db: supabase, admin: createAdminClientFor(user.id), tenantId, accountId: input.accountId, month: input.month });
    return { result };
  },
);

export const POST = withRoute(
  { route: "api/banking/razorpay-settlement/month", roles: ROLES, roleHint: ROLE_HINT, input: postSchema },
  async ({ supabase, tenantId, user, input }) => {
    if (input.action === "undo") {
      try {
        return { undo: await undoMonthRun(supabase, input.runId) };
      } catch (e) {
        const code = (e as { code?: string }).code;
        throw new RouteError(code === "42501" ? 403 : 409, (e as Error).message);
      }
    }
    const out = await runMonthBatch({
      db: supabase, admin: createAdminClientFor(user.id), tenantId,
      accountId: input.accountId, month: input.month, txnIds: input.txnIds,
    });
    if (out.state !== "done") throw new RouteError(409, out.message);
    return { run: out.result };
  },
);
