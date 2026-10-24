/**
 * R-1007 — exports built on the SERVER: role-checked, tenant-scoped, logged, and signed.
 *
 * WHY: every CSV was built in the browser from whatever the page had read. Nothing stopped a
 * role that may not export (roles.ts can_export_data — "a leaving employee with a laptop")
 * from pressing the button, and the file carried no trace of who took it. The most sensitive
 * lists — customers and leads (names, emails, phones) and invoices — now come from
 * POST /api/exports/<kind>, which:
 *   1. checks the caller's role (mayExport below) before reading a row;
 *   2. reads through the caller's own session, so RLS keeps it to their company and to the
 *      rows they may see;
 *   3. masks phone / email for a role without can_view_contact_details (maskContact);
 *   4. writes one export_log row (R-1006 log_export — what, rows, format; never file contents);
 *   5. ends the file with a footer naming who exported it, when (IST) and for which company.
 *
 * This file is pure (no Supabase, no request) so every rule above is unit-tested.
 */
import { buildCSV } from "@/lib/csv";
import { can, maskContact, roleLabel } from "@/lib/auth/roles";
import { formatIstDate, formatIstTime, istToday } from "@/lib/dates/ist";

export const EXPORT_KINDS = ["customers", "leads", "invoices"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportKind(v: unknown): v is ExportKind {
  return typeof v === "string" && (EXPORT_KINDS as readonly string[]).includes(v);
}

/**
 * Every role that may export at least one kind — the route's first gate. mayExport() then
 * answers per kind. Kept as a list (not derived) so the route's gate is readable at a glance;
 * export-roles.test proves it matches mayExport exactly.
 */
export const EXPORT_ROLES = ["owner", "manager", "accountant", "billing"] as const;

/**
 * May this role take this list out of the app?
 *   - customers / leads: can_export_data only (owner, manager) — the contact book is the leak.
 *   - invoices: also the money roles (can_view_financials: accountant, billing) — the CA needs
 *     the invoice register, and it carries no phone or email.
 * Unknown or missing role → false.
 */
export function mayExport(kind: ExportKind, role: string | null | undefined): boolean {
  if (can(role, "can_export_data")) return true;
  return kind === "invoices" && can(role, "can_view_financials");
}

/** The columns that hold a phone or an email, per kind — masked for a role that may not see them. */
export const CONTACT_COLUMNS: Record<ExportKind, readonly string[]> = {
  customers: ["Contact email", "Contact phone"],
  leads: ["Email", "Phone"],
  invoices: [],
};

export type Cell = string | number;

/** Mask the contact columns unless the role may see contact details. Returns new rows. */
export function maskContactColumns(kind: ExportKind, role: string | null | undefined, headers: readonly string[], rows: readonly Cell[][]): Cell[][] {
  if (can(role, "can_view_contact_details")) return rows.map((r) => [...r]);
  const idx = CONTACT_COLUMNS[kind].map((h) => headers.indexOf(h)).filter((i) => i >= 0);
  if (idx.length === 0) return rows.map((r) => [...r]);
  return rows.map((r) => r.map((v, i) => (idx.includes(i) && String(v ?? "").trim() !== "" ? maskContact(String(v)) : v)));
}

export interface Watermark {
  /** The signed-in person's name, or their email when the name is empty. */
  by: string;
  email: string | null;
  role: string | null | undefined;
  company: string;
  at: Date;
}

/**
 * The footer line: who, when (IST), which company. One sentence, so it survives being opened
 * in Excel, Tally or a text editor. It starts with a word, never with = + @ - (csvEscape would
 * neutralise those anyway).
 */
export function watermarkLine(w: Watermark): string {
  const by = w.by.trim();
  const who = by && w.email && by !== w.email ? `${by} <${w.email}>` : by || w.email || "unknown user";
  const when = `${formatIstDate(w.at)}, ${formatIstTime(w.at)} IST`;
  const company = w.company.trim() || "this workspace";
  return `Exported by ${who} (${roleLabel(w.role)}) on ${when} from ${company}. Confidential - for ${company} internal use only.`;
}

/**
 * The file: UTF-8 BOM (Excel on Windows), the table, a blank line, then the footer as a
 * single-cell row. Same escaping as every other CSV (lib/csv buildCSV).
 */
export function buildExportCsv(headers: readonly string[], rows: readonly Cell[][], footer: string): string {
  return `﻿${buildCSV([...headers], rows.map((r) => [...r]))}\r\n\r\n${buildCSV([footer], [])}\r\n`;
}

/** customers-2026-10-23.csv — the IST date, like the browser exports it replaces. */
export function exportFilename(kind: ExportKind, at: Date, selected = false): string {
  return `${selected ? "selected-" : ""}${kind}-${istToday(at)}.csv`;
}

/** A filename from a Content-Disposition header, or the fallback. Only safe characters survive. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  const m = /filename="([^"]+)"/.exec(header ?? "");
  const name = (m?.[1] ?? "").replace(/[^A-Za-z0-9._-]/g, "");
  return name || fallback;
}
