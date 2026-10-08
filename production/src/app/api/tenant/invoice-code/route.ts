/**
 * /api/tenant/invoice-code — R-259. The owner's invoice code (tenants.doc_code).
 *
 *   GET  → { code, saved, locked, nextNumber, preview, fyYY }   (any member may read)
 *   POST { code } → saves it, owner only, refused once locked or taken by another tenant
 *
 * Why a route and not the generic tenants update: the two checks that matter need to see
 * past this tenant's RLS — whether ANOTHER tenant already prints the code (invoices.id is
 * a global primary key, so a duplicate code collides on the first invoice of a year), and
 * the document_series counters, which are not in the generated types (see
 * api/invoices/series/route.ts). Every query below filters by the session's tenant
 * except the uniqueness scan, which reads only id + doc_code of other tenants and
 * returns nothing but a yes/no.
 *
 * Never renumbers: existing invoices keep their numbers; this only changes what the
 * NEXT number prints, and only until the first GST number has been issued.
 */
import { NextResponse } from "next/server";
import { createClient as createSessionClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
/* Staging (R-161): built through @/lib/supabase/bare so the in-process gateway / Auth.js switches reach it. */
import { createBareClient } from "@/lib/supabase/bare";
import { effectiveDocCode } from "@/lib/actions/consequence";
import {
  GST_DOC_TYPES,
  codeTakenByOther,
  decideInvoiceCodeSave,
  fyEndYear,
  previewInvoiceNumber,
  type OtherTenantCode,
} from "@/app/(app)/setup/invoice-code";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Me { tenantId: string; role: string | null }

async function whoAmI(): Promise<Me | NextResponse> {
  const supabase = createSessionClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const { data: me, error } = await supabase
    .from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (error) return NextResponse.json({ error: "Could not read your workspace. Try again." }, { status: 503 });
  const row = me as { tenant_id?: string | null; role?: string | null } | null;
  if (!row?.tenant_id) return NextResponse.json({ error: "No workspace on your account." }, { status: 403 });
  return { tenantId: row.tenant_id, role: row.role ?? null };
}

function bareClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

interface State {
  saved: string | null;
  code: string;
  locked: boolean;
  nextNumber: number;
  fyYY: string;
}

/** This tenant's code, lock and next invoice number. Throws on a failed read — a failed
 *  read must never look like "not locked". */
async function readState(db: SupabaseClient, tenantId: string): Promise<State> {
  const fyYY = fyEndYear(new Date());
  const [tenantRes, seriesRes, invoiceRes] = await Promise.all([
    db.from("tenants").select("doc_code").eq("id", tenantId).maybeSingle(),
    db.from("document_series")
      .select("doc_type, fiscal_year, last_number")
      .eq("tenant_id", tenantId)                       // <- tenant boundary
      .in("doc_type", [...GST_DOC_TYPES]),
    db.from("invoices").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
  ]);
  if (tenantRes.error) throw new Error(`tenant: ${tenantRes.error.message}`);
  if (seriesRes.error) throw new Error(`series: ${seriesRes.error.message}`);
  if (invoiceRes.error) throw new Error(`invoices: ${invoiceRes.error.message}`);

  const saved = ((tenantRes.data as { doc_code?: string | null } | null)?.doc_code ?? "").trim() || null;
  const rows = (seriesRes.data ?? []) as Array<{ doc_type: string; fiscal_year: string; last_number: number }>;
  const locked = (invoiceRes.count ?? 0) > 0 || rows.some((r) => (r.last_number ?? 0) > 0);
  const current = rows.find((r) => r.doc_type === "invoice" && r.fiscal_year.endsWith(fyYY));
  return {
    saved,
    code: effectiveDocCode(saved, tenantId),
    locked,
    nextNumber: (current?.last_number ?? 0) + 1,
    fyYY,
  };
}

function shape(s: State) {
  return { ...s, preview: previewInvoiceNumber(s.code, s.fyYY, s.nextNumber) };
}

export async function GET() {
  const me = await whoAmI();
  if (me instanceof NextResponse) return me;
  const db = bareClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured on the server." }, { status: 500 });
  try {
    return NextResponse.json(shape(await readState(db, me.tenantId)));
  } catch (e) {
    console.error(`[api/tenant/invoice-code] tenant ${me.tenantId}: ${(e as Error).message}`);
    return NextResponse.json({ error: "Could not read your invoice numbering." }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const me = await whoAmI();
  if (me instanceof NextResponse) return me;
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can change the invoice code." }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const raw = typeof body?.code === "string" ? body.code : "";

  const db = bareClient();
  if (!db) return NextResponse.json({ error: "Supabase is not configured on the server." }, { status: 500 });

  try {
    const state = await readState(db, me.tenantId);
    const { data: others, error: othersErr } = await db.from("tenants").select("id, doc_code");
    if (othersErr) throw new Error(`others: ${othersErr.message}`);

    const decision = decideInvoiceCodeSave({
      raw,
      currentCode: state.code,
      locked: state.locked,
      takenByOther: codeTakenByOther(raw, me.tenantId, (others ?? []) as OtherTenantCode[]),
    });
    if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: decision.status });
    if (decision.code === state.saved) return NextResponse.json(shape(state));

    /* Belt and braces against a number already printed with this code elsewhere (a tenant
       whose code was changed by hand in the database). */
    const { count: clash, error: clashErr } = await db
      .from("invoices").select("id", { count: "exact", head: true })
      .neq("tenant_id", me.tenantId)
      .like("id", `%-${decision.code}-%`);
    if (clashErr) throw new Error(`clash: ${clashErr.message}`);
    if ((clash ?? 0) > 0) {
      return NextResponse.json(
        { error: `${decision.code} is already used by another business. Try a different code.` },
        { status: 409 },
      );
    }

    const { error: upErr } = await db
      .from("tenants").update({ doc_code: decision.code }).eq("id", me.tenantId); // <- tenant boundary
    if (upErr) throw new Error(`update: ${upErr.message}`);

    return NextResponse.json(shape({ ...state, saved: decision.code, code: decision.code }));
  } catch (e) {
    console.error(`[api/tenant/invoice-code] POST tenant ${me.tenantId}: ${(e as Error).message}`);
    return NextResponse.json({ error: "Could not save the invoice code. Try again." }, { status: 503 });
  }
}
