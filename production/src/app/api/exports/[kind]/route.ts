/**
 * R-1007 — POST /api/exports/<customers|leads|invoices>  →  the CSV file.
 *
 * The only way the customers list, the leads list and the invoice register leave the app.
 * Body: { ids?: string[] } — the ticked rows (invoices' bulk bar); no ids = every row the
 * caller can see. Order of work:
 *   1. withRoute: signed in, linked to a company, role in EXPORT_ROLES (else 403);
 *   2. mayExport(kind, role) — customers / leads need can_export_data (owner, manager);
 *      invoices also allow the money roles (accountant, billing);
 *   3. rows read through the caller's own session (RLS: own company, own visible rows);
 *   4. phone / email masked for a role without can_view_contact_details;
 *   5. one export_log row (R-1006 log_export: what, rows, format — never the file's contents);
 *   6. the file ends with "Exported by <who> (<role>) on <IST time> from <company>".
 * Logging never blocks the file (R-1006's rule) — a failed log is a server warning.
 */
import { z } from "zod";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { logExport } from "@/lib/export-log";
import {
  EXPORT_ROLES, buildExportCsv, exportFilename, isExportKind, maskContactColumns, mayExport, watermarkLine,
} from "@/lib/exports/server-export";
import { readExportRows } from "@/lib/exports/read-rows.server";
import { errorMessage } from "@/lib/ops/fetch-all";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const input = z.object({
  ids: z.array(z.string().regex(UUID, "One of the selected rows is not valid — reload the page and select again."))
    .max(5000, "Select at most 5,000 rows to export at a time.").optional(),
});

export const POST = withRoute(
  {
    roles: EXPORT_ROLES,
    route: "api/exports",
    input,
    roleHint: "Your role cannot export lists — ask the workspace owner or a manager for the file.",
  },
  async ({ params, input: body, supabase, user, tenantId, role }) => {
    const kind = params.kind;
    if (!isExportKind(kind)) throw new RouteError(404, "This list cannot be exported. Reload the page and try again.");
    if (!mayExport(kind, role)) {
      throw new RouteError(403, `Your role cannot export ${kind} — ask the workspace owner or a manager for the file.`);
    }

    let table;
    try {
      table = await readExportRows(supabase, tenantId, kind, body.ids);
    } catch (e) {
      throw new RouteError(500, `Could not read the ${kind} to export. Nothing was downloaded — try again in a minute.`, errorMessage(e));
    }
    if (table.rows.length === 0) {
      throw new RouteError(404, `There are no ${kind} to export${body.ids?.length ? " in your selection" : ""}. Nothing was downloaded.`);
    }

    const rows = maskContactColumns(kind, role, table.headers, table.rows);

    const [{ data: me }, { data: company }] = await Promise.all([
      supabase.from("users").select("full_name, email").eq("id", user.id).maybeSingle(),
      supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
    ]);
    const at = new Date();
    const footer = watermarkLine({
      by: me?.full_name?.trim() || me?.email || user.email || "",
      email: me?.email ?? user.email,
      role,
      company: company?.name ?? "",
      at,
    });

    const selected = Boolean(body.ids?.length);
    await logExport(
      { what: selected ? `${kind}-selected` : kind, rowCount: rows.length, format: "csv" },
      (args) => supabase.rpc("log_export", args),
    );

    return new Response(buildExportCsv(table.headers, rows, footer), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(kind, at, selected)}"`,
        "Cache-Control": "no-store",
        "X-Export-Rows": String(rows.length),
      },
    });
  },
);
