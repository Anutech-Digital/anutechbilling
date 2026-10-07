/**
 * ImportContactsDialog — upload a Google Contacts CSV, preview, select, import.
 *
 * Flow:
 *   1. File upload (.csv) — parsed entirely client-side
 *   2. Preview table with checkboxes (select-all + per-row)
 *   3. POST /api/contacts/import with selected rows
 *   4. Toast with imported / duplicates / skipped counts
 *
 * Where to get the CSV: contacts.google.com → Export → Google CSV (all)
 */

"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { parseGoogleContactsCsv, type ParsedContact } from "@/lib/contacts/parse-google-csv";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export default function ImportContactsDialog({ open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [parsing,   setParsing]   = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [rows,      setRows]      = React.useState<ParsedContact[]>([]);
  const [skipped,   setSkipped]   = React.useState(0);
  const [warnings,  setWarnings]  = React.useState<string[]>([]);
  const [selected,  setSelected]  = React.useState<Set<number>>(new Set());
  const [fileName,  setFileName]  = React.useState("");

  function reset() {
    setRows([]); setSkipped(0); setWarnings([]); setSelected(new Set()); setFileName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    setParsing(true);
    try {
      const text  = await f.text();
      const parsed = parseGoogleContactsCsv(text);
      setRows(parsed.rows);
      setSkipped(parsed.skipped);
      setWarnings(parsed.warnings);
      // Pre-select rows with email (best candidates)
      setSelected(new Set(
        parsed.rows.filter((r) => r.email).map((r) => r.rowIndex)
      ));
      toast.success(`Parsed ${parsed.rows.length} contacts from ${f.name}`);
    } catch (err) {
      // Parser text stays in the console for support; the operator gets the next step (§24).
      console.error("[import-contacts] CSV parse failed", err);
      toast.error("Could not read this CSV file.", {
        description: "Export it again from Google Contacts (Export → Google CSV) and choose that file.",
      });
    } finally {
      setParsing(false);
    }
  }

  function toggle(idx: number) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === rows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.rowIndex)));
    }
  }

  async function onSubmit() {
    if (selected.size === 0) {
      toast.error("Select at least one contact", {
        description: "Tick the contacts you want in the list below, then import.",
      });
      return;
    }
    setSubmitting(true);
    try {
      const chosen = rows.filter((r) => selected.has(r.rowIndex));
      const res = await fetch("/api/contacts/import", {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "google_csv",
          rows: chosen.map((r) => ({
            fullName: r.fullName,
            email:    r.email,
            phone:    r.phone,
            company:  r.company,
            title:    r.title,
            notes:    r.notes,
            tags:     r.tags,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toastError(json.error, {
          fallback: "Import failed.",
          description: "Nothing was imported. Try again — if it keeps failing, report it from Help.",
        });
        return;
      }
      toast.success(
        `Imported ${json.imported} contact${json.imported === 1 ? "" : "s"}` +
        (json.duplicates > 0 ? ` · ${json.duplicates} duplicates skipped` : "") +
        (json.skipped > 0    ? ` · ${json.skipped} invalid skipped` : "")
      );
      qc.invalidateQueries({ queryKey: ["imported_contacts"] });
      qc.invalidateQueries({ queryKey: ["contacts-merged"] });
      reset();
      onOpenChange(false);
    } catch (err) {
      toastError(err, {
        fallback: "Couldn't reach the server.",
        description: "Nothing was imported. Check your internet connection and try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const hasFile        = rows.length > 0;
  const allSelected    = hasFile && selected.size === rows.length;
  const withEmailCount = rows.filter((r) => r.email).length;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="md:!max-w-4xl">
        <DialogHeader>
          <DialogTitle>Import contacts from Google</DialogTitle>
          <DialogDescription>
            Export your Google Contacts as CSV from{" "}
            <a href="https://contacts.google.com" target="_blank" rel="noopener noreferrer" className="text-amber-ink hover:underline">
              contacts.google.com
            </a>{" "}
            (top right menu → <b>Export</b> → <b>Google CSV</b>). Then upload it here.
          </DialogDescription>
        </DialogHeader>

        {/* File picker */}
        {!hasFile && (
          <div className="border-2 border-dashed border-hairline rounded-lg p-8 text-center bg-paper-2/30">
            <Icon name="upload" size={32} className="text-ink-3 mx-auto mb-2" />
            <p className="text-sm font-medium text-ink mb-1">Upload Google Contacts CSV</p>
            <p className="text-xs text-ink-3 mb-4">Parsing happens entirely in your browser — nothing sent until you confirm</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              disabled={parsing}
              className="hidden"
              id="csv-upload"
            />
            <label htmlFor="csv-upload">
              <Button variant="primary" icon="upload" asChild>
                <span style={{ cursor: "pointer" }}>{parsing ? "Parsing…" : "Choose CSV file"}</span>
              </Button>
            </label>
          </div>
        )}

        {/* Preview table */}
        {hasFile && (
          <>
            <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
              <div className="flex items-center gap-2">
                <Icon name="check_circle" size={14} className="text-emerald" />
                <span className="font-medium text-ink">{fileName}</span>
                <Badge kind="muted" size="sm">{rows.length} contacts</Badge>
                {skipped > 0 && <Badge kind="warning" size="sm">{skipped} skipped (no name)</Badge>}
                <Badge kind="info" size="sm">{withEmailCount} with email</Badge>
              </div>
              <Button size="sm" variant="ghost" icon="x" onClick={reset}>Use different file</Button>
            </div>

            {warnings.length > 0 && (
              <div className="bg-amber-soft border border-amber/30 rounded-md p-2 text-2xs text-amber-ink space-y-0.5">
                {warnings.map((w, i) => <p key={i}>⚠️ {w}</p>)}
              </div>
            )}

            <div className="border border-hairline rounded-md overflow-hidden max-h-[400px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-paper-2 sticky top-0">
                  <tr>
                    <th className="px-2 py-2 w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all contacts"
                        checked={allSelected}
                        onChange={toggleAll}
                        className="accent-amber"
                      />
                    </th>
                    <th className="text-left px-2 py-2 font-semibold text-ink-3 uppercase tracking-wider">Name</th>
                    <th className="text-left px-2 py-2 font-semibold text-ink-3 uppercase tracking-wider">Email</th>
                    <th className="text-left px-2 py-2 font-semibold text-ink-3 uppercase tracking-wider">Phone</th>
                    <th className="text-left px-2 py-2 font-semibold text-ink-3 uppercase tracking-wider">Company</th>
                    <th className="text-left px-2 py-2 font-semibold text-ink-3 uppercase tracking-wider">Title</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isSel = selected.has(r.rowIndex);
                    return (
                      <tr
                        key={r.rowIndex}
                        onClick={() => toggle(r.rowIndex)}
                        className={`border-t border-hairline cursor-pointer ${isSel ? "bg-amber-soft/40" : "hover:bg-paper-2/40"}`}
                      >
                        <td className="px-2 py-1.5">
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.fullName}`}
                            checked={isSel}
                            onChange={() => toggle(r.rowIndex)}
                            onClick={(e) => e.stopPropagation()}
                            className="accent-amber"
                          />
                        </td>
                        <td className="px-2 py-1.5 font-medium text-ink truncate max-w-[180px]">{r.fullName}</td>
                        <td className="px-2 py-1.5 text-ink-2 font-mono text-2xs truncate max-w-[200px]">{r.email ?? "—"}</td>
                        <td className="px-2 py-1.5 text-ink-2 truncate max-w-[140px]">{r.phone ?? "—"}</td>
                        <td className="px-2 py-1.5 text-ink-2 truncate max-w-[160px]">{r.company ?? "—"}</td>
                        <td className="px-2 py-1.5 text-ink-3 truncate max-w-[160px]">{r.title ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="bg-paper-2 rounded-md p-3 text-2xs text-ink-3 flex items-start gap-2">
              <Icon name="info" size={12} className="text-amber-ink shrink-0 mt-0.5" />
              <p>
                Selected contacts land in your <b className="text-ink-2">Contacts directory</b> at status{" "}
                <code>pending</code> — NOT in the Deal Pipeline. Duplicates (same email) are silently skipped.
                Use <b className="text-ink-2">"Promote to lead"</b> later when you're ready to engage.
              </p>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          {hasFile && (
            <Button variant="primary" icon="upload" onClick={onSubmit} disabled={submitting || selected.size === 0}>
              {submitting
                ? "Importing…"
                : `Import ${selected.size} contact${selected.size === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
