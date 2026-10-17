/**
 * ImportStatementDialog — paste / upload a bank statement.
 *
 * Accepts: CSV pasted text; a .csv / .txt file; an Excel .xls / .xlsx file
 * (first sheet, read in the browser with SheetJS loaded only then — R-1512 —
 * and turned into the same CSV text); or a PDF / photo (read by AI on the
 * server). Parsing lives in lib/banking/statement-parse.ts: it finds the real
 * header row below the bank's info rows and auto-detects the column mapping.
 * Supports the column layouts used by HDFC, ICICI, SBI, Axis, Kotak,
 * IndusInd — which all use slightly different names.
 *
 * Phase 1 limitation: the operator may need to nudge the mapping if
 * their bank's header text is unusual. A "Sample row preview" pane
 * shows what we parsed so they can spot issues before importing.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import {
  useImportBankTransactions,
  useExistingTxnKeys,
  bankTxnKeys,
  useBankAccount,
  useUpdateBankAccount,
} from "@/lib/queries/bank";
import { openingBalanceFromStatement, fyStartFor } from "@/lib/banking/opening-balance";
import { isEncryptedPdf } from "@/lib/banking/pdf-check";
import { fixStatementDates } from "@/lib/banking/statement-dates";
import { localDateISO } from "@/lib/leads/outcomes";
import { useTxnCategoryRules, useCreateTxnCategoryRule } from "@/lib/queries/txn-category-rules";
import { proposePatterns } from "@/lib/banking/rule-from-line";
import { directionOf } from "@/lib/banking/categorise";
import { EXPENSE_CATEGORIES, suggestCategory } from "@/lib/queries/expenses";
import { suggestForLine } from "@/lib/banking/categorise";
import { rupee, formatDate } from "@/lib/utils";
import { parseStatement, rowsToCsv, type ParsedRow, type ParseResult } from "@/lib/banking/statement-parse";
// Only the small reader module — SheetJS itself is `await import("xlsx")` inside excelToRows,
// a separate chunk fetched when an Excel file is picked (R-1512).
import { excelToRows, isExcelFile } from "@/lib/banking/statement-xlsx";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
}

/**
 * Last gate before the preview (CSV and AI alike): every date must be a real calendar
 * date. A day/month swap is corrected — for the whole statement when it was read
 * day-first — and said out loud; a date impossible either way skips its row, counted.
 * Without this one bad date ("2026-21-08") failed the whole import in Postgres.
 */
function withRealDates(p: ParseResult, serverSwapped = 0): ParseResult {
  const fix = fixStatementDates(p.rows.map((r) => r.txn_date), localDateISO(new Date(Date.now() + 86_400_000)));   // +1 day: server clock may be UTC
  const rows = p.rows.flatMap((r, i) => (fix.dates[i] ? [{ ...r, txn_date: fix.dates[i]! }] : []));
  const dropped = p.rows.length - rows.length;
  const swapped = fix.swapped + serverSwapped;
  const warnings = [...p.warnings];
  if (fix.swappedAll) warnings.push(`The dates were in day-first order — all ${fix.swapped} were flipped. Check a few dates in the preview before importing.`);
  else if (swapped > 0) warnings.push(`${swapped} date${swapped === 1 ? " had its" : "s had their"} day and month swapped and ${swapped === 1 ? "was" : "were"} corrected — check ${swapped === 1 ? "it" : "them"} in the preview.`);
  if (dropped > 0) warnings.push(`${dropped} row${dropped === 1 ? "" : "s"} had an impossible date and ${dropped === 1 ? "was" : "were"} skipped.`);
  return { rows, skipped: p.skipped + dropped, warnings };
}

// ─── Component ─────────────────────────────────────────────────────────────

export function ImportStatementDialog({ open, onOpenChange, accountId }: Props) {
  const [csvText, setCsvText] = React.useState("");
  const [parsed, setParsed]   = React.useState<{ rows: ParsedRow[]; skipped: number; warnings: string[] } | null>(null);
  // "csv" = parsed from pasted/CSV text; "ai" = read from a PDF/photo via Gemini.
  const [mode, setMode]       = React.useState<"csv" | "ai">("csv");
  const [reading, setReading] = React.useState(false);
  const [readMsgIdx, setReadMsgIdx] = React.useState(0);
  const importMut = useImportBankTransactions();

  // Rotating status while the AI reads — so a multi-second read never looks stuck.
  const READ_MSGS = ["File khol rahe hai…", "Transactions dhoondh rahe hai…", "Rows nikaal rahe hai…", "Amounts check kar rahe hai…", "Almost done…"];
  React.useEffect(() => {
    if (!reading) { setReadMsgIdx(0); return; }
    const t = setInterval(() => setReadMsgIdx((i) => Math.min(i + 1, READ_MSGS.length - 1)), 1600);
    return () => clearInterval(t);
  }, [reading]);
  const { data: existingKeys } = useExistingTxnKeys(open ? accountId : null);

  /* ── Categorisation (docs/AI-CATEGORISATION-PLAN.md, Phase 2) ─────────────
     Two deterministic layers and no model: the tenant's own rules first, then the
     built-in keyword list lib/queries/expenses.ts already had. Whatever neither answers
     stays EMPTY and says so — see the counter under the table. */
  const { data: rules = [] } = useTxnCategoryRules();
  const createRule = useCreateTxnCategoryRule();

  /* Rows whose "remember this?" offer has been dealt with — saved or dismissed. Kept per
     row index so the offer disappears once acted on and never nags twice. */
  const [ruleDone, setRuleDone] = React.useState<Record<number, true>>({});

  /** Suggestion per row index, recomputed when the parse or the rules change. */
  const suggestions = React.useMemo(() => {
    if (!parsed) return [];
    return parsed.rows.map((r) => suggestForLine(r, rules, suggestCategory));
  }, [parsed, rules]);

  /* The operator's overrides, by row index. Kept apart from `suggestions` so a re-parse
     cannot silently discard a choice somebody made, and so "set to no category" stays
     distinguishable from "never touched". */
  const [override, setOverride] = React.useState<Record<number, string>>({});
  React.useEffect(() => { setOverride({}); setRuleDone({}); }, [parsed]);

  const categoryFor = (i: number): string | null =>
    override[i] !== undefined ? (override[i] || null) : (suggestions[i]?.category ?? null);

  const categorisedCount = parsed ? parsed.rows.filter((_, i) => categoryFor(i)).length : 0;

  /* ── Opening balance from this statement ──────────────────────────────────
     Off by default: replacing an account's opening balance moves every balance it
     shows, so it happens only when the operator ticks it. The date defaults to the
     start of the FY the statement's LATEST line is in — a statement that dips a few
     days into March is still this year's statement. */
  const { data: account } = useBankAccount(open ? accountId : null);
  const updateAccount = useUpdateBankAccount();
  const [applyOpening, setApplyOpening] = React.useState(false);
  const [openingDate, setOpeningDate] = React.useState("");
  React.useEffect(() => {
    setApplyOpening(false);
    const latest = parsed?.rows.reduce<string | null>(
      (max, r) => (max === null || r.txn_date > max ? r.txn_date : max), null);
    setOpeningDate(latest ? fyStartFor(latest) : "");
  }, [parsed]);
  const opening = React.useMemo(
    () => (parsed && openingDate ? openingBalanceFromStatement(parsed.rows, openingDate) : null),
    [parsed, openingDate],
  );
  const openingOn = applyOpening && opening?.ok === true;

  /* Lines dated before the opening date are already inside the opening balance —
     importing them too would count that money twice. */
  const isExcluded = React.useCallback(
    (r: ParsedRow) => openingOn && r.txn_date < openingDate,
    [openingOn, openingDate],
  );
  const excludedCount = parsed ? parsed.rows.filter(isExcluded).length : 0;

  // How many parsed rows are already in the books (will be skipped on import).
  const dupCount = React.useMemo(() => {
    if (!parsed || !existingKeys) return 0;
    return parsed.rows.filter((r) => !isExcluded(r) && bankTxnKeys(r).some((k) => existingKeys.has(k))).length;
  }, [parsed, existingKeys, isExcluded]);
  const freshCount = (parsed?.rows.length ?? 0) - excludedCount - dupCount;

  React.useEffect(() => {
    if (!open) { setCsvText(""); setParsed(null); setMode("csv"); setReading(false); }
  }, [open]);

  // Re-parse the textarea (CSV mode only — don't clobber an AI/PDF result).
  React.useEffect(() => {
    if (mode !== "csv") return;
    if (!csvText.trim()) { setParsed(null); return; }
    setParsed(withRealDates(parseStatement(csvText)));
  }, [csvText, mode]);

  // Read a bank-statement PDF/photo with AI → transaction rows (operator reviews).
  const readPdf = async (file: File) => {
    /* A password-protected PDF (bank e-statements usually are) cannot be read by the AI —
       it fails with a bare 400. Say so before uploading it, and say what works instead. */
    if (/pdf/i.test(file.type) && isEncryptedPdf(new Uint8Array(await file.arrayBuffer()))) {
      toast.error("This PDF is password-protected, so it can't be read.", {
        description: "Download the statement as CSV / \"Delimited\" (.txt) from net banking — or open the PDF with its password, Print → Save as PDF, and upload that copy.",
        duration: 12000,
      });
      return;
    }
    setReading(true);
    setMode("ai");
    setCsvText("");
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload  = () => resolve((r.result as string).split(",")[1] ?? "");
        r.onerror = () => reject(new Error("read failed"));
        r.readAsDataURL(file);
      });
      const res = await fetch("/api/ai/extract-statement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileBase64: base64, mimeType: file.type }),
      });
      const json = await res.json();
      if (!res.ok) {
        toastError(json.error, {
          fallback: "Couldn't read the statement.",
          description: "Nothing was imported. Download the statement as CSV from net banking and upload or paste that instead.",
        });
        setParsed(null);
        return;
      }
      setParsed(withRealDates({
        rows: (json.rows ?? []) as ParsedRow[],
        skipped: json.skipped ?? 0,
        warnings: (json.rows ?? []).length === 0 ? ["The AI found no transactions in this file — download the statement as CSV and use that instead."] : [],
      }, Number(json.datesSwapped) || 0));
    } catch {
      toast.error("Upload failed.", { description: "Nothing was imported. Check your connection and try again — or paste the CSV instead." });
      setParsed(null);
    } finally {
      setReading(false);
    }
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error("File too large (over 8 MB).", { description: "Download a shorter date range, or paste the CSV text instead." });
      return;
    }
    /* Excel (.xls / .xlsx) → first sheet's rows → the same CSV text the textarea parses,
       so the header auto-detect, preview and import are exactly the CSV path (R-1512). */
    if (isExcelFile(file)) {
      setReading(true);
      try {
        const rows = await excelToRows(await file.arrayBuffer());
        if (rows.length === 0) {
          toast.error("This Excel file has no rows on its first sheet.", { description: "Open it in Excel, check the statement is on the first sheet, and upload again — or download the CSV instead." });
          return;
        }
        setMode("csv");
        setCsvText(rowsToCsv(rows));
      } catch {
        toast.error("Couldn't read this Excel file.", {
          description: "If it is password-protected, open it in Excel and Save As without a password — or download the statement as CSV / \"Delimited\" (.txt) from net banking.",
          duration: 12000,
        });
      } finally {
        setReading(false);
      }
      return;
    }
    // PDF / image → AI reader; CSV / text → parse in the browser.
    if (/pdf|image/i.test(file.type)) { await readPdf(file); return; }
    setMode("csv");
    setCsvText(await file.text());
  };

  const handleImport = async () => {
    if (!parsed || parsed.rows.length === 0) {
      toast.error("Nothing to import yet.", { description: "Upload the statement file or paste its CSV text above first." });
      return;
    }
    try {
      /* Categories travel with the rows. category_source is 'manual' where the operator
         picked it and 'rule' where a layer did, because the DB refuses a category with no
         stated source — an unattributable number in the books is the thing an auditor
         asks about first. */
      if (freshCount > 0) {
        await importMut.mutateAsync({
          accountId,
          rows: parsed.rows.flatMap((r, i) => {
            if (isExcluded(r)) return [];
            const category = categoryFor(i);
            if (!category) return [r];
            const touched = override[i] !== undefined;
            return [{
              ...r,
              category,
              category_source: touched ? ("manual" as const) : ("rule" as const),
              category_confidence: 100,
            }];
          }),
        });
      }
      /* After the lines, not before: if the import fails the account keeps its old
         opening balance rather than one that assumes lines which never arrived. */
      if (openingOn && opening?.ok) {
        await updateAccount.mutateAsync({
          id: accountId,
          patch: { opening_balance: opening.amount, opening_balance_date: openingDate },
        });
      }
      onOpenChange(false);
    } catch {
      /* hook handles toast */
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[600px] md:max-w-[720px] p-0 flex flex-col overflow-x-hidden"
      >
        <SheetHeader>
          <SheetTitle>Import bank statement</SheetTitle>
          <SheetDescription>
            Upload a <b>PDF</b> statement, an <b>Excel</b> (.xls / .xlsx) or a <b>.csv</b> file (or paste
            the text below). PDF ko AI padh ke rows nikaal deta hai; Excel aur CSV auto-detect hoti
            hai (Date / Description / Debit / Credit). Aap import se pehle preview
            check karo.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* File upload — PDF/photo (AI), Excel or CSV. Shows a live progress state
              while the AI reads, so a multi-second read never looks frozen. */}
          <div className="rounded-md border border-dashed border-hairline-strong bg-paper-2/30 p-4">
            <style>{"@keyframes ros-loadbar{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}"}</style>
            {reading ? (
              <div className="flex flex-col items-center text-center gap-3 py-1">
                <Icon name="sparkles" size={22} className="text-amber-ink animate-pulse" />
                <span className="text-sm font-medium text-ink">{READ_MSGS[readMsgIdx]}</span>
                <div className="w-44 h-1.5 rounded-full bg-hairline overflow-hidden">
                  <div className="h-full w-1/3 rounded-full bg-amber" style={{ animation: "ros-loadbar 1.1s ease-in-out infinite" }} />
                </div>
                <span className="text-xs text-ink-3">Bade statement mein thoda zyada waqt lag sakta hai — ruko mat 😊</span>
              </div>
            ) : (
              <label className="cursor-pointer flex flex-col items-center text-center gap-2">
                <Icon name="upload" size={20} className="text-ink-3" />
                <span className="text-sm font-medium">Choose file — PDF / Excel / CSV</span>
                <span className="text-xs text-ink-3">Bank statement PDF (AI reads it) · Excel .xls / .xlsx · ya .csv / .txt (HDFC &quot;Delimited&quot;) · up to 8 MB</span>
                <input
                  type="file"
                  accept=".csv,.txt,.xls,.xlsx,text/csv,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf,image/*"
                  className="hidden"
                  onChange={onFileChange}
                />
              </label>
            )}
          </div>

          {/* OR paste */}
          <div>
            <label htmlFor="import-statement-or-paste-csv-text" className="text-xs font-medium text-ink-2">Or paste CSV text</label>
            <textarea id="import-statement-or-paste-csv-text"
              rows={6}
              placeholder={"Date,Description,Debit,Credit,Balance\n28/05/2026,UPI/RAZORPAY/...,0,521088,..."}
              className="mt-1 w-full rounded-md border border-hairline bg-paper px-3 py-2 text-xs font-mono text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber resize-y"
              value={csvText}
              onChange={(e) => { setMode("csv"); setCsvText(e.target.value); }}
            />
          </div>

          {/* Parse summary */}
          {parsed && (
            <div className="rounded-md border border-hairline bg-paper-2/30 p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold">Parse summary</p>
                {parsed.rows.length > 0 ? (
                  <Badge kind="success" dot size="sm">
                    {parsed.rows.length} ready to import
                  </Badge>
                ) : (
                  <Badge kind="danger" dot size="sm">Couldn&apos;t parse</Badge>
                )}
              </div>
              {parsed.warnings.length > 0 && (
                <ul className="text-xs text-rose space-y-0.5 mb-2">
                  {parsed.warnings.map((w, i) => <li key={i}>• {w}</li>)}
                </ul>
              )}
              {parsed.skipped > 0 && (
                <p className="text-xs text-ink-3 mb-2">
                  Skipped {parsed.skipped} row{parsed.skipped === 1 ? "" : "s"} (missing date or both amounts zero — usually opening-balance / sub-total lines)
                </p>
              )}
              {dupCount > 0 && (
                <p className="text-xs text-amber-ink mb-2 flex items-start gap-1.5">
                  <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                  {dupCount} line{dupCount === 1 ? "" : "s"} pehle se books me hain — ye <b>skip</b> ho jaayengi{freshCount > 0 ? ` (sirf ${freshCount} nayi import hongi)` : " (kuch naya nahi)"}.
                </p>
              )}
              {parsed.rows.length > 0 && (
                <div className="overflow-x-auto">
                  {/* Every row, in a scroll box — not the first five. A five-row preview
                      beside an editable category column would let somebody set 5 of 39
                      categories and believe they had reviewed the statement. */}
                  <div className="max-h-[320px] overflow-y-auto custom-scrollbar">
                  <table className="w-full text-xs">
                    <thead className="text-ink-3 sticky top-0 bg-paper">
                      <tr>
                        <th className="text-left py-1">Date</th>
                        <th className="text-left py-1">Description</th>
                        <th className="text-right py-1">Debit</th>
                        <th className="text-right py-1">Credit</th>
                        <th className="text-left py-1 pl-2">Category</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.rows.map((r, i) => {
                        const suggestion = suggestions[i];
                        const chosen = categoryFor(i);
                        return (
                          <tr
                            key={i}
                            className={`border-t border-hairline ${isExcluded(r) ? "opacity-40 line-through" : ""}`}
                            title={isExcluded(r) ? "Before the opening-balance date — already inside the opening balance, not imported" : undefined}
                          >
                            <td className="py-1 whitespace-nowrap">{formatDate(r.txn_date)}</td>
                            <td className="py-1 truncate max-w-[170px]" title={r.description}>{r.description}</td>
                            <td className="py-1 text-right text-rose tabular-nums">{r.debit > 0 ? rupee(r.debit) : "—"}</td>
                            <td className="py-1 text-right text-emerald tabular-nums">{r.credit > 0 ? rupee(r.credit) : "—"}</td>
                            <td className="py-1 pl-2">
                              <select
                                aria-label={`Category for ${r.description}`}
                                value={chosen ?? ""}
                                onChange={(e) => setOverride((o) => ({ ...o, [i]: e.target.value }))}
                                className="w-full max-w-[150px] rounded border border-hairline bg-paper px-1 py-0.5 text-2xs text-ink"
                              >
                                {/* Named, not blank. An empty option reads as "nothing
                                    needed here"; this one admits there is no answer yet. */}
                                <option value="">— not set —</option>
                                {EXPENSE_CATEGORIES.map((c) => (
                                  <option key={c} value={c}>{c}</option>
                                ))}
                              </select>
                              {/* Why, and from which layer. Hidden once overridden, because
                                  then the reason is simply "you chose it". */}
                              {suggestion && override[i] === undefined && (
                                <span className="block text-xs text-ink-3 truncate max-w-[150px]">
                                  {suggestion.layer === "tenant-rule" ? suggestion.reason : "keyword"}
                                </span>
                              )}

                              {/* ── Phase 4: a correction becomes a rule ─────────────
                                  Offered only when the operator has actually CHANGED
                                  something, and only when the narration yields a pattern
                                  that is not the whole line. The candidates are the
                                  repeating part — SALARY out of
                                  "50100784857169-TPT-JULY SALARY-PAWAN" — because a rule
                                  built from the full narration carries a unique reference
                                  and matches exactly one line, ever.

                                  Which candidate to use is a bookkeeping decision (all
                                  wages, or this one person), so both are offered and
                                  neither is preselected. Nothing is saved until a click. */}
                              {override[i] !== undefined && override[i] !== "" && !ruleDone[i] && (() => {
                                const direction = directionOf(r);
                                const candidates = proposePatterns(r.description, 3);
                                if (!direction || candidates.length === 0) return null;
                                return (
                                  <span className="mt-1 block">
                                    <span className="block text-xs text-ink-3">Always file as {override[i]} when it says:</span>
                                    <span className="flex flex-wrap items-center gap-1 mt-0.5">
                                      {candidates.map((c) => (
                                        <button
                                          key={c}
                                          type="button"
                                          disabled={createRule.isPending}
                                          onClick={() => {
                                            createRule.mutate(
                                              { pattern: c, category: override[i], direction },
                                              { onSuccess: () => setRuleDone((d) => ({ ...d, [i]: true })) },
                                            );
                                          }}
                                          className="rounded border border-amber/50 bg-amber-soft px-1 py-0.5 text-3xs font-medium text-amber-ink hover:bg-amber/20 disabled:opacity-50"
                                        >
                                          {c}
                                        </button>
                                      ))}
                                      {/* A way to say no. Without it the offer is a nag. */}
                                      <button
                                        type="button"
                                        onClick={() => setRuleDone((d) => ({ ...d, [i]: true }))}
                                        className="text-xs text-ink-3 underline hover:text-ink-2"
                                      >
                                        just this once
                                      </button>
                                    </span>
                                  </span>
                                );
                              })()}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                  {/* The honest number — it says what is NOT done, so a half-categorised
                      statement cannot read as a finished one. */}
                  <p className="text-xs text-ink-3 mt-1.5">
                    <b className="text-ink-2">{categorisedCount} of {parsed.rows.length}</b> line
                    {parsed.rows.length === 1 ? "" : "s"} have a category.
                    {categorisedCount < parsed.rows.length && (
                      <> The other {parsed.rows.length - categorisedCount} will import without one — set them above, or later on the transactions page.</>
                    )}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Opening balance from this statement's running-balance column. */}
          {parsed && parsed.rows.length > 0 && opening && (
            <div className="rounded-md border border-hairline bg-paper-2/30 p-3">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-amber"
                  checked={applyOpening}
                  disabled={!opening.ok}
                  onChange={(e) => setApplyOpening(e.target.checked)}
                />
                <span>
                  <span className="block text-sm font-semibold text-ink">Set opening balance from this statement</span>
                  <span className="block text-xs text-ink-3">
                    Currently {account ? <>{rupee(account.opening_balance)} as of {formatDate(account.opening_balance_date)}</> : "…"}
                  </span>
                </span>
              </label>

              <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
                <label htmlFor="opening-date" className="text-xs text-ink-2">As of</label>
                <input
                  id="opening-date"
                  type="date"
                  value={openingDate}
                  onChange={(e) => setOpeningDate(e.target.value)}
                  className="rounded border border-hairline bg-paper px-2 py-0.5 text-2xs text-ink focus:outline-none focus:ring-2 focus:ring-amber"
                />
                {opening.ok && (
                  <span className="text-sm font-semibold tabular-nums text-ink">{rupee(opening.amount)}</span>
                )}
              </div>

              <div className="mt-1.5 pl-6 space-y-1 text-xs">
                {!opening.ok && <p className="text-rose-ink">{opening.reason}</p>}
                {opening.ok && (
                  <p className="text-ink-3">
                    Balance just before the {formatDate(opening.firstLineDate)} line (its balance, plus its debit, minus its credit).
                  </p>
                )}
                {opening.ok && opening.firstLineDate > openingDate && (
                  <p className="text-amber-ink flex items-start gap-1.5">
                    <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                    <span>
                      The statement&apos;s first line on or after {formatDate(openingDate)} is on {formatDate(opening.firstLineDate)}.
                      This figure is the balance on {formatDate(openingDate)} only if nothing moved in between — check it against your passbook.
                    </span>
                  </p>
                )}
                {opening.ok && opening.chainBreaks > 0 && (
                  <p className="text-amber-ink flex items-start gap-1.5">
                    <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                    <span>
                      {opening.chainBreaks} line{opening.chainBreaks === 1 ? "" : "s"} where the running balance does not follow from the line before.
                      Some lines may have been skipped while reading the statement — check before using this figure.
                    </span>
                  </p>
                )}
                {openingOn && excludedCount > 0 && (
                  <p className="text-ink-2">
                    {excludedCount} line{excludedCount === 1 ? "" : "s"} dated before {formatDate(openingDate)} will <b>not</b> be imported — the opening balance already includes {excludedCount === 1 ? "it" : "them"}.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="rounded-md bg-indigo-50 border border-indigo/20 px-3 py-2 text-xs text-indigo-ink">
            <b>Tip:</b> Net banking se statement <b>PDF</b>, <b>Excel</b> ya <b>CSV</b> — sab chalti hai.
            PDF ko AI padh leta hai, Excel aur CSV auto-detect hoti hai (HDFC, ICICI, SBI, Axis,
            Kotak, IndusInd, Yes Bank). Import se pehle preview zaroor check karo.
          </div>
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="upload"
            disabled={freshCount === 0 && !openingOn}
            loading={importMut.isPending || updateAccount.isPending}
            onClick={handleImport}
          >
            {freshCount === 0 && openingOn
              ? "Set opening balance"
              : dupCount > 0 && freshCount === 0
                ? "Sab pehle se hain"
                : `Import ${freshCount} row${freshCount === 1 ? "" : "s"}${openingOn ? " + opening balance" : ""}`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
