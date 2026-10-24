/**
 * R-1007 — the browser half of a server export: ask POST /api/exports/<kind> for the file and
 * hand it to the browser. The server checks the role, masks contacts, logs the export
 * (export_log) and signs the footer — so this file does NOT call logExport (the route did;
 * export-log-scan.test.ts lists it with that reason).
 *
 * Never throws: the caller gets { ok: false, error } with the server's own sentence (§24) and
 * says it in a toast.
 */
import { filenameFromDisposition, type ExportKind } from "./server-export";

export type ServerExportResult = { ok: true; rows: number; filename: string } | { ok: false; error: string };

export async function downloadServerExport(kind: ExportKind, opts: { ids?: readonly string[] } = {}): Promise<ServerExportResult> {
  let res: Response;
  try {
    res = await fetch(`/api/exports/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.ids?.length ? { ids: opts.ids } : {}),
    });
  } catch {
    return { ok: false, error: "We couldn't reach our server. Nothing was downloaded — check your connection and try again." };
  }
  if (!res.ok) {
    let error = "";
    try { error = String(((await res.json()) as { error?: unknown }).error ?? ""); } catch { /* an HTML gateway page */ }
    return { ok: false, error: error || `The export did not go through (error ${res.status}). Nothing was downloaded — try again.` };
  }
  const blob = await res.blob();
  const filename = filenameFromDisposition(res.headers.get("Content-Disposition"), `${kind}.csv`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { ok: true, rows: Number(res.headers.get("X-Export-Rows")) || 0, filename };
}
