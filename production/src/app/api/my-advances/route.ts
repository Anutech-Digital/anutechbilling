/**
 * Employee advances — /api/my-advances.
 *
 * ─── WHY THIS ROUTE EXISTS ──────────────────────────────────────────────────
 * It uses `createAdminClientFor(authData.user.id)`, which means **RLS is off**. The `expenses` table
 * does not grant read to the individual-contributor roles (sales, sales_senior,
 * support, delivery), so an employee could not see their own advance at all.
 *
 * The direct consequence: with RLS out of the picture, the visibility decision in
 * `lib/expenses/advance-visibility.ts` is the ONLY thing between one employee and
 * another employee's money. It used to be six lines of substring matching written
 * inline here, with a hardcoded ladder of six colleagues' first names and no test.
 * Both halves — read and write — now go through that one tested module.
 *
 * ─── WHAT IS STILL A STOPGAP ────────────────────────────────────────────────
 * `expenses` has no employee link (measured 22 Aug 2026: `vendor_name` text,
 * `vendor_id` is a *vendor* FK, `prepaid_advance_id`). So "whose advance is this"
 * is answered from a typed-in name. Two employees sharing a first name are
 * indistinguishable, and no string rule fixes that. The real fix is an id column
 * on the advance; see the module header.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { isOwnAdvance, visibleAdvances } from "@/lib/expenses/advance-visibility";

type ExpenseRow = Database["public"]["Tables"]["expenses"]["Row"];

/* R-101 (1 Oct 2026): a staff advance is a prepaid_advances row (an asset), not an
   'Employee Advance Disbursal' expense. Spends are expenses with payment_method
   'employee_advance' + prepaid_advance_id; the trigger in 20261001150000 keeps
   consumed_amount right. */
const ADVANCE_CATEGORY = "Employee advance";

/** The shape the client's `EmployeeAdvance` type expects (lib/queries/advances.ts). */
interface AdvanceView {
  id: string;
  tenant_id: string;
  employee_id: string | null;
  employee_name: string;
  disbursed_amount: number;
  disbursed_date: string;
  payment_method: string;
  bank_account_id: string | null;
  purpose: string | null;
  status: "active" | "closed";
  notes: string | null;
  created_at: string;
  updated_at: string;
  total_spent: number;
  remaining_balance: number;
  linked_expenses: ExpenseRow[];
}

/* A Supabase/PostgREST error is a plain object, not an Error — String() of it is the
   "[object Object]" toast seen on 1 Oct (R-101). Read its message. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export async function GET(_request: NextRequest) {
  try {
    const supabase = createClient();
    const { data: authData, error: authErr } = await supabase.auth.getUser();

    if (authErr || !authData?.user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const admin = createAdminClientFor(authData.user.id);

    const { data: profile, error: profErr } = await admin
      .from("users")
      .select("tenant_id, full_name, email, role, employee_id")
      .eq("id", authData.user.id)
      .single();

    if (profErr || !profile) {
      return NextResponse.json({ error: "User profile not found" }, { status: 404 });
    }

    const { tenant_id, full_name, role } = profile;

    const [{ data: disbursals, error: dErr }, { data: claims, error: cErr }] = await Promise.all([
      admin
        .from("prepaid_advances")
        .select("*")
        .eq("tenant_id", tenant_id)
        .eq("category", ADVANCE_CATEGORY)
        .order("paid_date", { ascending: false }),
      admin
        .from("expenses")
        .select("*")
        .eq("tenant_id", tenant_id)
        .eq("payment_method", "employee_advance")
        .not("prepaid_advance_id", "is", null)
        .order("expense_date", { ascending: false }),
    ]);

    if (dErr) throw dErr;
    if (cErr) throw cErr;

    const claimMap = new Map<string, ExpenseRow[]>();
    for (const c of claims ?? []) {
      if (!c.prepaid_advance_id) continue;
      const list = claimMap.get(c.prepaid_advance_id) ?? [];
      list.push(c);
      claimMap.set(c.prepaid_advance_id, list);
    }

    const allAdvances: AdvanceView[] = (disbursals ?? []).map((d) => {
      const linked = claimMap.get(d.id) ?? [];
      /* consumed_amount is kept by the database trigger — the one number the
         over-spend check also uses, so the page and the refusal never disagree. */
      const total_spent = d.consumed_amount ?? 0;
      const remaining_balance = Math.max(0, (d.total_amount ?? 0) - total_spent);

      return {
        id: d.id,
        tenant_id: d.tenant_id,
        /* NOT the viewer's employee_id. This used to be `profile.employee_id`, which
         * stamped the CALLER's id onto every row in the list — so to an owner, all
         * ten advances claimed to be theirs. There is no employee link on `expenses`
         * to read the true value from, and inventing one is the §2 mistake, so the
         * honest answer is null. */
        employee_id: null,
        employee_name: d.vendor_name || "Employee",
        disbursed_amount: d.total_amount ?? 0,
        disbursed_date: d.paid_date,
        payment_method: d.payment_method || "cash",
        bank_account_id: d.bank_account_id ?? null,
        purpose: (d.notes ?? "").split("\n")[0] || null,
        /* Closed only when settled. Spent down to ₹0 is still open — a top-up refills it. */
        status: d.closed_at ? "closed" : "active",
        notes: d.notes ?? null,
        created_at: d.created_at,
        updated_at: d.updated_at,
        total_spent,
        remaining_balance,
        linked_expenses: linked,
      };
    });

    /* One decision, one module, both verbs. `visibleAdvances` returns everything for
     * owner/manager/accountant and only the viewer's own rows otherwise — matching on
     * the RAW vendor_name, never the "Employee" display fallback. */
    const advances = visibleAdvances(
      allAdvances,
      (a) => (a.employee_name === "Employee" ? null : a.employee_name),
      { role, fullName: full_name },
    );

    return NextResponse.json({ advances });
  } catch (err) {
    console.error("GET /api/my-advances error:", err);
    return NextResponse.json({ error: errorMessage(err) || "Failed to load advances" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient();
    const { data: authData, error: authErr } = await supabase.auth.getUser();

    if (authErr || !authData?.user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body: unknown = await request.json();
    const {
      advance_id, category, amount, expense_date, vendor_name, description, attachment_url,
    } = (body ?? {}) as Record<string, unknown>;

    if (!advance_id || !category || !amount || !expense_date) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const admin = createAdminClientFor(authData.user.id);

    const { data: profile, error: profErr } = await admin
      .from("users")
      .select("tenant_id, full_name, role")
      .eq("id", authData.user.id)
      .single();

    if (profErr || !profile) {
      return NextResponse.json({ error: "User profile not found" }, { status: 404 });
    }

    /* ─── The advance must be one this caller may spend against ────────────────
     * This check did not exist. The insert took `advance_id` from the request body
     * and wrote it straight into `prepaid_advance_id`, so any authenticated employee
     * could file a claim against a COLLEAGUE's advance — and because GET derives
     * `total_spent` and `remaining_balance` by summing the claims linked to an
     * advance, a Rs 5,000 claim against somebody's Rs 2,000 advance drove their
     * remaining balance to zero and flipped it to "closed". Someone else's money,
     * moved by a request body.
     *
     * It also let the id cross a tenant boundary (AGENTS.md §4): nothing tied
     * `advance_id` to the caller's tenant, so the claim landed in the caller's
     * tenant pointing at a row in another one. Loading the advance under an explicit
     * tenant_id filter closes both at once. */
    const { data: advance, error: advErr } = await admin
      .from("prepaid_advances")
      .select("id, vendor_name, tenant_id, category")
      .eq("id", String(advance_id))
      .eq("tenant_id", profile.tenant_id)
      .eq("category", ADVANCE_CATEGORY)
      .maybeSingle();

    if (advErr) throw advErr;
    if (!advance) {
      /* Deliberately the same answer whether the advance is missing, in another
       * tenant, or somebody else's — a distinct message here would confirm that a
       * given id exists. §24 still applies, so it says what to do next. */
      return NextResponse.json(
        { error: "That advance is not available to you. Open Advances and pick one of your own." },
        { status: 404 },
      );
    }

    const mayClaim =
      isOwnAdvance(profile.full_name, advance.vendor_name) ||
      // Owners/managers/accountants settle advances on an employee's behalf.
      visibleAdvances([advance], (a) => a.vendor_name, { role: profile.role, fullName: profile.full_name }).length > 0;

    if (!mayClaim) {
      return NextResponse.json(
        { error: "That advance belongs to a colleague. Open Advances and pick one of your own." },
        { status: 403 },
      );
    }

    const newId = crypto.randomUUID();
    const { data: newExpense, error: insErr } = await admin
      .from("expenses")
      .insert({
        id: newId,
        tenant_id: profile.tenant_id,
        category: String(category),
        amount: Number(amount),
        expense_date: String(expense_date),
        vendor_name: vendor_name ? String(vendor_name) : null,
        description: description ? String(description) : null,
        attachment_url: attachment_url ? String(attachment_url) : null,
        paid: true,
        paid_date: String(expense_date),
        prepaid_advance_id: advance.id,
        payment_method: "employee_advance",
      })
      .select()
      .single();

    /* The database trigger refuses more than what is left, or a settled advance —
       that is the person's mistake to fix (400 with the sentence), not a crash (500). */
    if (insErr && (insErr as { code?: string }).code === "23514") {
      return NextResponse.json({ error: insErr.message }, { status: 400 });
    }
    if (insErr) throw insErr;

    return NextResponse.json({ success: true, expense: newExpense });
  } catch (err) {
    console.error("POST /api/my-advances error:", err);
    return NextResponse.json(
      { error: errorMessage(err) || "Failed to record expense claim" },
      { status: 500 },
    );
  }
}
