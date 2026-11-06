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
  planBankImport,
  useBankAccount,
  useHasBankLinesFrom,
  useBankLinesBetween,
} from "@/lib/queries/bank";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { openingMoveCheck, linesBeforeOpening } from "@/lib/banking/opening-move";
import { importBadge } from "./import-badge";
import { openingBalanceFromStatement } from "@/lib/banking/opening-balance";
import { isEncryptedPdf, pdfPageCount } from "@/lib/banking/pdf-check";
import {
  readStatementInChunks,
  chunkResultFrom,
  pagesLabel,
  STATEMENT_CHUNK_PAGES,
  type ChunkProgress,
  type PageRange,
} from "@/lib/banking/statement-chunks";
import {
  checkPreview,
  importBlocked,
  rereadBrokenPages,
  type RowCountIssue,
} from "@/lib/banking/statement-verify";
import { StatementChainBlock } from "./statement-chain-block";
import { fixStatementDates } from "@/lib/banking/statement-dates";
import { localDateISO } from "@/lib/leads/outcomes";
import { useTxnCategoryRules, useCreateTxnCategoryRule } from "@/lib/queries/txn-category-rules";
import { proposePatterns } from "@/lib/banking/rule-from-line";
import { directionOf } from "@/lib/banking/categorise";
import { EXPENSE_CATEGORIES, suggestCategory } from "@/lib/queries/expenses";
import { suggestForLine } from "@/lib/banking/categorise";
import { rupee, formatDate } from "@/lib/utils";
import { parseStatement, rowsToCsv, settleReversals, withReversalWarning, applySignChoice, type ParsedRow, type ParseResult, type SignChoice } from "@/lib/banking/statement-parse";
import { StatementSignCheck } from "./statement-sign-check";
// Only the small reader module — SheetJS itself is `await import("xlsx")` inside excelToRows,
// a separate chunk fetched when an Excel file is picked (R-1512).
import { excelToRows, isExcelFile } from "@/lib/banking/statement-xlsx";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
}

/** A preview row may carry the PDF pages it was read from (R-1693) — never sent to the database. */
type PreviewRow = ParsedRow & { page?: PageRange };
type Preview = {
  rows: PreviewRow[];
  skipped: number;
  warnings: string[];
  /** R-1693: pages where the AI wrote fewer lines than it counted. */
  rowCountIssues?: RowCountIssue[];
  /** R-1693: what was re-read page by page, if anything. */
  rereadNote?: string | null;
};

/** Exactly the columns of a bank line — the preview's page tag stays behind. */
const toLine = (r: PreviewRow): ParsedRow => ({
  txn_date: r.txn_date,
  description: r.description,
  debit: r.debit,
  credit: r.credit,
  balance_after: r.balance_after,
  reference: r.reference,
  /* R-2522: the value date travels when the file printed one that differs (opening meeting point). */
  ...(r.value_date ? { value_date: r.value_date } : {}),
});

/** R-2522: preview rows per page — 3,665 rows each with a category dropdown froze the dialog. */
export const PREVIEW_PAGE_SIZE = 100;
/** R-2522: the owner's reason for "set it anyway" — at least this many characters (the database's rule). */
const REASON_MIN = 5;

/**
 * Last gate before the preview (CSV and AI alike): every date must be a real calendar
 * date. A day/month swap is corrected — for the whole statement when it was read
 * day-first — and said out loud; a date impossible either way skips its row, counted.
 * Without this one bad date ("2026-21-08") failed the whole import in Postgres.
 */
function withRealDates(p: Preview | ParseResult, serverSwapped = 0): Preview {
  const fix = fixStatementDates(p.rows.map((r) => r.txn_date), localDateISO(new Date(Date.now() + 86_400_000)));   // +1 day: server clock may be UTC
  const rows = p.rows.flatMap((r, i) => (fix.dates[i] ? [{ ...r, txn_date: fix.dates[i]! }] : []));
  const dropped = p.rows.length - rows.length;
  const swapped = fix.swapped + serverSwapped;
  const warnings = [...p.warnings];
  if (fix.swappedAll) warnings.push(`The dates were in day-first order — all ${fix.swapped} were flipped. Check a few dates in the preview before importing.`);
  else if (swapped > 0) warnings.push(`${swapped} date${swapped === 1 ? " had its" : "s had their"} day and month swapped and ${swapped === 1 ? "was" : "were"} corrected — check ${swapped === 1 ? "it" : "them"} in the preview.`);
  if (dropped > 0) warnings.push(`${dropped} row${dropped === 1 ? "" : "s"} had an impossible date and ${dropped === 1 ? "was" : "were"} skipped.`);
  /* R-1890: a future date is kept as written, never swapped — only flagged. */
  if (fix.future > 0) warnings.push(`${fix.future} line${fix.future === 1 ? " is" : "s are"} dated after today — kept as written. Check ${fix.future === 1 ? "it" : "them"} in the preview before importing.`);
  /* R-2495: a line read as a reversal (negative amount) is said out loud on the PDF / photo
     path too. R-2508: settled again over the WHOLE statement (an AI chunk's first line had no
     neighbour) — a minus the running balance does not explain stays "check sign". */
  const settled = settleReversals(rows);
  return { ...p, rows: settled, skipped: p.skipped + dropped, warnings: withReversalWarning(warnings, settled) };
}

/** R-1623: where an import came from (bank_import_batches.source). */
type ImportOrigin = "pdf" | "csv" | "xlsx" | "paste" | "image";

// ─── Component ─────────────────────────────────────────────────────────────

export function ImportStatementDialog({ open, onOpenChange, accountId }: Props) {
  const [csvText, setCsvText] = React.useState("");
  const [rawParsed, setParsed] = React.useState<Preview | null>(null);
  /* R-2508: the owner's Money in / Money out answers for "check sign" lines, kept apart from the
     parse (and tied to it) so answering never resets the other choices made in the preview. */
  const [signPicks, setSignPicks] = React.useState<{ of: Preview | null; picks: Record<number, SignChoice> }>({ of: null, picks: {} });
  const parsed = React.useMemo(() => {
    const picks = rawParsed && signPicks.of === rawParsed ? Object.entries(signPicks.picks) : [];
    if (!rawParsed || picks.length === 0) return rawParsed;
    const rows = picks.reduce((rs, [i, c]) => applySignChoice(rs, Number(i), c), rawParsed.rows);
    return { ...rawParsed, rows, warnings: withReversalWarning(rawParsed.warnings, rows) };
  }, [rawParsed, signPicks]);
  const chooseSign = (index: number, choice: SignChoice) => setSignPicks((s) => ({
    of: rawParsed,
    picks: { ...(s.of === rawParsed ? s.picks : {}), [index]: choice },
  }));
  // "csv" = parsed from pasted/CSV text; "ai" = read from a PDF/photo via Gemini.
  const [mode, setMode]       = React.useState<"csv" | "ai">("csv");
  const [reading, setReading] = React.useState(false);
  const [readMsgIdx, setReadMsgIdx] = React.useState(0);
  /* R-1690: real progress while a long PDF is read a few pages per call. null = one call. */
  const [chunkProgress, setChunkProgress] = React.useState<ChunkProgress | null>(null);
  /* R-1693: pages being read again one at a time because the balance chain broke. */
  const [rereadProgress, setRereadProgress] = React.useState<{ done: number; total: number; reading: number[] } | null>(null);
  const importMut = useImportBankTransactions();
  /* R-1623: which file (and kind) this import came from — the account's Imports list shows it. */
  const [origin, setOrigin] = React.useState<{ name: string | null; source: ImportOrigin } | null>(null);

  // Rotating status while the AI reads — so a multi-second read never looks stuck.
  const READ_MSGS = ["Opening the file…", "Finding transactions…", "Extracting rows…", "Checking amounts…", "Almost done…"];
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
  /* R-1693: does the preview hold every line? The bank's running balance must chain from
     line to line (lib/banking/statement-verify.ts). Lines missing → Import waits for an
     explicit tick. Same check for CSV / Excel as for a PDF. */
  const [ackIncomplete, setAckIncomplete] = React.useState(false);
  const chainCheck = React.useMemo(
    () => (parsed && parsed.rows.length > 0 ? checkPreview(parsed.rows, parsed.rowCountIssues ?? []) : null),
    [parsed],
  );
  const blocked = importBlocked(chainCheck, ackIncomplete);
  React.useEffect(() => { setOverride({}); setRuleDone({}); setAckIncomplete(false); }, [rawParsed]);

  const categoryFor = (i: number): string | null =>
    override[i] !== undefined ? (override[i] || null) : (suggestions[i]?.category ?? null);

  const categorisedCount = parsed ? parsed.rows.filter((_, i) => categoryFor(i)).length : 0;

  /* ── Opening balance from this statement ──────────────────────────────────
     Off by default: replacing an account's opening balance moves every balance it
     shows, so it happens only when the operator ticks it. R-2522: the date defaults to the
     statement's FIRST date — a year's statement sets the opening at its start (it used to
     default to the FY of the LATEST line, so a FY 25-26 statement ending on 1 Apr 2026
     proposed 1 Apr 2026 and the date had to be typed by hand). */
  const { data: account } = useBankAccount(open ? accountId : null);
  /* R-2497: never a plain overwrite — the import carries the opening to the database
     (set_bank_opening_from_statement), which checks that today's balance stays the same and
     keeps the old opening in bank_opening_history. */
  const { data: me } = useCurrentUser();
  /* Lines already counted under the current opening (dated on/after it) — the database's
     "money to keep" next to the opening amount. */
  const { data: hasCountedLines } = useHasBankLinesFrom(open ? accountId : null, account?.opening_balance_date);
  const isOwner = me?.role === "owner";
  const [applyOpening, setApplyOpening] = React.useState(false);
  const [acceptDifference, setAcceptDifference] = React.useState(false);
  /* R-2522: the owner's reason for "set it anyway" — required, kept in the account's history. */
  const [acceptReason, setAcceptReason] = React.useState("");
  const [openingDate, setOpeningDate] = React.useState("");
  React.useEffect(() => {
    setApplyOpening(false);
    const earliest = rawParsed?.rows.reduce<string | null>(
      (min, r) => (min === null || r.txn_date < min ? r.txn_date : min), null);
    setOpeningDate(earliest ?? "");
  }, [rawParsed]);
  const opening = React.useMemo(
    () => (parsed && openingDate ? openingBalanceFromStatement(parsed.rows, openingDate) : null),
    [parsed, openingDate],
  );
  const openingOn = applyOpening && opening?.ok === true;
  React.useEffect(() => { setAcceptDifference(false); setAcceptReason(""); }, [rawParsed, openingDate, applyOpening]);

  /* R-2497: with the opening left as it is, lines dated before the account's opening date are
     imported but NOT counted in the balance (the opening already holds them) — said up front. */
  const beforeOpeningCount = parsed && account && !openingOn
    ? linesBeforeOpening(parsed.rows, account.opening_balance_date)
    : 0;

  /* Lines dated before the opening date are already inside the opening balance —
     importing them too would count that money twice. */
  const isExcluded = React.useCallback(
    (r: ParsedRow) => openingOn && r.txn_date < openingDate,
    [openingOn, openingDate],
  );
  const excludedCount = parsed ? parsed.rows.filter(isExcluded).length : 0;
  /* R-2508: a minus the file does not explain waits for the owner — never guessed. A line that
     will not be imported (before the new opening date) does not hold the import up. */
  const signWaits = parsed ? parsed.rows.some((r) => r.checkSign && !isExcluded(r)) : false;

  /* How many parsed rows are already in the books (will be skipped on import) — the same
     function the import itself runs (planBankImport, R-1691), so the count shown here is
     the count skipped. R-1644: it counts — each stored line accounts for one line here, and
     lines of this upload are never matched to each other. The skipped lines are listed and
     the owner can take them anyway — never dropped silently. */
  const plan = React.useMemo(() => {
    if (!parsed) return null;
    const rows = parsed.rows.filter((r) => !isExcluded(r));
    if (!existingKeys) return { duplicates: 0, freshCount: rows.length, fresh: rows, skipped: [] as ParsedRow[] };
    const p = planBankImport(rows, existingKeys);
    return { duplicates: p.duplicates, freshCount: p.fresh.length, fresh: p.fresh as ParsedRow[], skipped: p.skipped };
  }, [parsed, existingKeys, isExcluded]);
  const [importSkipped, setImportSkipped] = React.useState(false);
  React.useEffect(() => { setImportSkipped(false); }, [rawParsed]);
  const dupCount = importSkipped ? 0 : (plan?.duplicates ?? 0);
  const skippedLines = plan?.skipped ?? [];
  const freshCount = (plan?.freshCount ?? 0) + (importSkipped ? skippedLines.length : 0);

  /* R-2497 · R-2522: moving the opening EARLIER must keep today's balance — the statement's
     balance where it meets the app's existing data must equal the old opening (±₹1). The SAME
     rule the database applies on save (set_bank_opening_from_statement): the lines the import
     adds (`newRows`), and the lines the app already holds between the two dates — manual ones
     too (`existingInWindow`), so the preview and the save never show different differences. */
  const movingEarlier = openingOn && !!account?.opening_balance_date && openingDate < account.opening_balance_date;
  const { data: windowLines } = useBankLinesBetween(
    open && movingEarlier ? accountId : null, openingDate, account?.opening_balance_date);
  const moveCheck = React.useMemo(() => {
    if (!openingOn || !opening?.ok || !parsed || !account || !plan) return null;
    return openingMoveCheck({
      rows: parsed.rows,
      newRows: importSkipped ? [...plan.fresh, ...plan.skipped] : plan.fresh,
      existingInWindow: windowLines,
      newOpening: opening.amount,
      newDate: openingDate,
      oldOpening: account.opening_balance ?? 0,
      oldDate: account.opening_balance_date,
      accountHasMoney: (account.opening_balance ?? 0) !== 0 || hasCountedLines === true,
    });
  }, [openingOn, opening, parsed, account, hasCountedLines, openingDate, plan, importSkipped, windowLines]);
  const openingMismatch = moveCheck?.kind === "earlier" && !moveCheck.matches;
  const reasonOk = acceptReason.trim().length >= REASON_MIN;
  const openingWaits = openingMismatch && !(isOwner && acceptDifference && reasonOk);
  /* R-2522: hand-entered lines between the new and the old opening date — after the move they
     count, and one may be the same payment as a statement line (real case: manual "EMI 1 Thar
     Roxx" ₹27,764 on 3 Mar 2026 next to the bank's EMI ₹30,183 on 5 Mar). */
  const manualInWindow = movingEarlier ? (windowLines ?? []).filter((l) => l.source === "manual") : [];

  /* R-2522: the preview table shows one page of rows at a time. */
  const [previewPage, setPreviewPage] = React.useState(0);
  React.useEffect(() => { setPreviewPage(0); }, [rawParsed]);

  React.useEffect(() => {
    if (!open) { setCsvText(""); setParsed(null); setMode("csv"); setReading(false); setOrigin(null); }
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
    const isPdf = /pdf/i.test(file.type);
    const bytes = isPdf ? new Uint8Array(await file.arrayBuffer()) : null;
    if (bytes && isEncryptedPdf(bytes)) {
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

      /* R-1690: a PDF longer than one chunk is read a few pages per call. In one call a
         month of entries timed out at 60 s on both models, every time (staging, 19 Oct). */
      const pageCount = bytes ? await pdfPageCount(bytes) : null;
      if (pageCount && pageCount > STATEMENT_CHUNK_PAGES) {
        setChunkProgress({ pagesDone: 0, pageCount, reading: [] });
        const out = await readStatementInChunks<ParsedRow>({
          pageCount,
          onProgress: setChunkProgress,
          readChunk: async (pages) => {
            const res = await fetch("/api/ai/extract-statement", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ fileBase64: base64, mimeType: file.type, pages: { ...pages, total: pageCount } }),
            });
            return chunkResultFrom<ParsedRow>(res.ok, await res.json().catch(() => null));
          },
        });
        if (out.allFailed) {
          toastError(out.failed[0]?.error, {
            fallback: "Couldn't read the statement.",
            description: "Nothing was imported. Download the statement as CSV / Excel from net banking and upload that instead.",
          });
          setParsed(null);
          return;
        }
        /* R-1693: every chunk can come back 200 with lines simply left out. Check the
           running-balance chain now; where it breaks, read those pages again one at a time. */
        setChunkProgress(null);
        const checked = await rereadBrokenPages<ParsedRow>({
          chunks: out.chunks,
          today: localDateISO(new Date(Date.now() + 86_400_000)),   // +1 day, as withRealDates
          onProgress: setRereadProgress,
          readPage: async (page) => {
            const res = await fetch("/api/ai/extract-statement", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ fileBase64: base64, mimeType: file.type, pages: { from: page, to: page, total: pageCount } }),
            });
            return chunkResultFrom<ParsedRow>(res.ok, await res.json().catch(() => null));
          },
        });
        if (checked.failed.length > 0) {
          toast.warning(`Page ${checked.failed.map(pagesLabel).join(", ")} could not be read — the other rows are in the preview.`, {
            description: "Read the preview warning before importing: entries from those pages must be imported separately (CSV / a smaller PDF).",
            duration: 12000,
          });
        }
        setParsed(withRealDates({
          rows: checked.rows,
          skipped: checked.skipped,
          warnings: [
            ...checked.warnings,
            ...(checked.rows.length === 0 ? ["The AI found no transactions in this file — download the statement as CSV and use that instead."] : []),
          ],
          rowCountIssues: checked.rowCountIssues,
          rereadNote: checked.note,
        }));
        return;
      }

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
      /* R-1693: one call reads the whole file, so its rows are tagged with all its pages and
         the model's own count is compared with what it wrote (no re-read on this path). */
      const whole: PageRange = { from: 1, to: pageCount ?? 1 };
      const counted = typeof json.rowCount === "number" ? json.rowCount : null;
      const returned = typeof json.rowsReturned === "number" ? json.rowsReturned : (json.rows ?? []).length;
      setParsed(withRealDates({
        rows: ((json.rows ?? []) as ParsedRow[]).map((r) => ({ ...r, page: whole })),
        skipped: json.skipped ?? 0,
        warnings: (json.rows ?? []).length === 0 ? ["The AI found no transactions in this file — download the statement as CSV and use that instead."] : [],
        rowCountIssues: counted !== null && returned < counted ? [{ pages: whole, counted, returned }] : [],
      }, Number(json.datesSwapped) || 0));
    } catch {
      toast.error("Upload failed.", { description: "Nothing was imported. Check your connection and try again — or paste the CSV instead." });
      setParsed(null);
    } finally {
      setReading(false);
      setChunkProgress(null);
      setRereadProgress(null);
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
        setOrigin({ name: file.name, source: "xlsx" });
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
    if (/pdf|image/i.test(file.type)) {
      setOrigin({ name: file.name, source: /pdf/i.test(file.type) ? "pdf" : "image" });
      await readPdf(file);
      return;
    }
    setMode("csv");
    setOrigin({ name: file.name, source: "csv" });
    setCsvText(await file.text());
  };

  const handleImport = async () => {
    if (!parsed || parsed.rows.length === 0) {
      toast.error("Nothing to import yet.", { description: "Upload the statement file or paste its CSV text above first." });
      return;
    }
    if (signWaits) {
      toast.error("Check the sign of the marked lines first.", { description: "Read the \"Check the sign\" box in the preview and choose Money in or Money out for each line." });
      return;
    }
    if (blocked) {
      toast.error("Some statement lines are missing from the preview.", { description: "Read the red box in the preview — import a CSV / Excel file instead, or tick the box to import the incomplete statement knowingly." });
      return;
    }
    /* R-2497: a statement that does not match the current opening waits for the owner's tick —
       checked BEFORE anything is saved. */
    if (openingOn && openingWaits) {
      toast.error("The statement does not match the current opening.", { description: "Read the opening balance box — only the owner can set it anyway." });
      return;
    }
    const withOpening = openingOn && opening?.ok
      ? {
          amount: opening.amount, date: openingDate, acceptDifference: isOwner && acceptDifference,
          /* R-2522: the owner's reason travels only with an accepted difference. */
          ...(isOwner && acceptDifference ? { reason: acceptReason.trim() } : {}),
        }
      : undefined;
    try {
      /* Categories travel with the rows. category_source is 'manual' where the operator
         picked it and 'rule' where a layer did, because the DB refuses a category with no
         stated source — an unattributable number in the books is the thing an auditor
         asks about first.
         R-2497: with the opening tick, the lines and the opening move are ONE database
         transaction (import_bank_statement_with_opening) — if the opening is refused, no line
         stays behind; with every line already in, only the opening moves. */
      if (freshCount > 0 || withOpening) {
        await importMut.mutateAsync({
          accountId,
          opening: withOpening,
          fileName: origin?.name ?? null,
          source: origin?.source ?? "paste",
          importSkipped,
          rows: parsed.rows.flatMap((r, i) => {
            if (isExcluded(r)) return [];
            const category = categoryFor(i);
            if (!category) return [toLine(r)];
            const touched = override[i] !== undefined;
            return [{
              ...toLine(r),
              category,
              category_source: touched ? ("manual" as const) : ("rule" as const),
              category_confidence: 100,
            }];
          }),
        });
      }
      onOpenChange(false);
    } catch {
      /* hook handles toast (a refused opening: nothing was saved; the dialog stays open) */
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
            the text below). AI reads the PDF and extracts the rows; Excel and CSV columns are
            detected automatically (Date / Description / Debit / Credit). Check the preview
            before importing.
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
                {rereadProgress ? (
                  /* R-1693: the balance chain broke — those pages are read again, one at a time. */
                  <>
                    <span className="text-sm font-medium text-ink" role="status" aria-live="polite">
                      {rereadProgress.reading.length > 0
                        ? `Balance chain broke — re-reading page ${rereadProgress.reading.join(", ")}…`
                        : "Checking the balance chain…"}
                    </span>
                    <span className="text-xs text-ink-3 tabular-nums">
                      {rereadProgress.done} / {rereadProgress.total} pages re-read — looking for missing lines
                    </span>
                  </>
                ) : chunkProgress ? (
                  /* R-1690: a long PDF, a few pages per call — real numbers, not a rotating line. */
                  <>
                    <span className="text-sm font-medium text-ink" role="status" aria-live="polite">
                      {chunkProgress.reading.length > 0
                        ? `Page ${chunkProgress.reading[0].from}–${chunkProgress.reading[chunkProgress.reading.length - 1].to} of ${chunkProgress.pageCount}…`
                        : `Reading a ${chunkProgress.pageCount}-page statement…`}
                    </span>
                    <div
                      className="w-44 h-1.5 rounded-full bg-hairline overflow-hidden"
                      role="progressbar"
                      aria-label="Statement pages read"
                      aria-valuemin={0}
                      aria-valuemax={chunkProgress.pageCount}
                      aria-valuenow={chunkProgress.pagesDone}
                    >
                      <div
                        className="h-full rounded-full bg-amber transition-[width] duration-500"
                        style={{ width: `${Math.max(4, Math.round((chunkProgress.pagesDone / chunkProgress.pageCount) * 100))}%` }}
                      />
                    </div>
                    <span className="text-xs text-ink-3 tabular-nums">
                      {chunkProgress.pagesDone} / {chunkProgress.pageCount} pages done — a long statement is read in parts
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium text-ink">{READ_MSGS[readMsgIdx]}</span>
                    <div className="w-44 h-1.5 rounded-full bg-hairline overflow-hidden">
                      <div className="h-full w-1/3 rounded-full bg-amber" style={{ animation: "ros-loadbar 1.1s ease-in-out infinite" }} />
                    </div>
                    <span className="text-xs text-ink-3">A large statement can take a little longer — please wait.</span>
                  </>
                )}
              </div>
            ) : (
              <label className="cursor-pointer flex flex-col items-center text-center gap-2">
                <Icon name="upload" size={20} className="text-ink-3" />
                <span className="text-sm font-medium">Choose file — PDF / Excel / CSV</span>
                <span className="text-xs text-ink-3">Bank statement PDF (AI reads it) · Excel .xls / .xlsx · or .csv / .txt (HDFC &quot;Delimited&quot;) · up to 8 MB</span>
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
              onChange={(e) => { setMode("csv"); setOrigin((o) => (o && o.source !== "pdf" && o.source !== "image" ? o : { name: null, source: "paste" })); setCsvText(e.target.value); }}
            />
          </div>

          {/* Parse summary */}
          {parsed && (
            <div className="rounded-md border border-hairline bg-paper-2/30 p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold">Parse summary</p>
                {/* R-1692: what Import will add (the same plan), not every parsed line. */}
                {(() => {
                  const b = importBadge({ parsedCount: parsed.rows.length, freshCount });
                  return <Badge kind={b.kind} dot size="sm">{b.text}</Badge>;
                })()}
              </div>
              {chainCheck && (
                <StatementChainBlock
                  check={chainCheck}
                  source={mode === "ai" ? "ai" : "csv"}
                  ack={ackIncomplete}
                  onAck={setAckIncomplete}
                  note={parsed.rereadNote}
                />
              )}
              <StatementSignCheck rows={parsed.rows} onChoose={chooseSign} skip={isExcluded} />
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
              {skippedLines.length > 0 && (
                <div className="text-xs text-amber-ink mb-2 rounded-md border border-amber/40 bg-amber-soft/20 p-2">
                  <p className="flex items-start gap-1.5">
                    <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                    <span>
                      {importSkipped
                        ? <>{skippedLines.length} line{skippedLines.length === 1 ? "" : "s"} that look already imported will be imported <b>again</b>.</>
                        : <>{skippedLines.length} line{skippedLines.length === 1 ? "" : "s"} skipped as already imported{freshCount > 0 ? ` (only ${freshCount} new will be imported)` : " (nothing new)"}:</>}
                    </span>
                  </p>
                  {/* R-1644: say WHICH lines — two equal ₹500 payments on one day are two payments. */}
                  <ul className="mt-1 ml-5 space-y-0.5 text-ink-2 max-h-24 overflow-y-auto">
                    {skippedLines.map((r, i) => (
                      <li key={i} className="truncate">
                        {formatDate(r.txn_date)} · {r.debit ? `${rupee(r.debit)} out` : `${rupee(r.credit ?? 0)} in`} · {r.description ?? "—"}
                      </li>
                    ))}
                  </ul>
                  <label className="mt-1.5 ml-5 flex items-center gap-2 cursor-pointer text-ink-2">
                    <input type="checkbox" className="accent-amber" checked={importSkipped}
                      onChange={(e) => setImportSkipped(e.target.checked)} />
                    Import these anyway — they are real, separate transactions
                  </label>
                </div>
              )}
              {parsed.rows.length > 0 && (
                <div className="overflow-x-auto">
                  {/* Every row, in a scroll box — not the first five. A five-row preview
                      beside an editable category column would let somebody set 5 of 39
                      categories and believe they had reviewed the statement.
                      R-2522: one page of PREVIEW_PAGE_SIZE rows at a time — every row is still
                      reachable (Previous / Next), but 3,665 rows each with a dropdown froze it. */}
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
                      {parsed.rows.slice(previewPage * PREVIEW_PAGE_SIZE, (previewPage + 1) * PREVIEW_PAGE_SIZE).map((r, j) => {
                        const i = previewPage * PREVIEW_PAGE_SIZE + j;
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
                  {parsed.rows.length > PREVIEW_PAGE_SIZE && (() => {
                    const pages = Math.ceil(parsed.rows.length / PREVIEW_PAGE_SIZE);
                    const from = previewPage * PREVIEW_PAGE_SIZE + 1;
                    const to = Math.min(parsed.rows.length, (previewPage + 1) * PREVIEW_PAGE_SIZE);
                    return (
                      <div data-testid="preview-pager" className="mt-1.5 flex items-center justify-between gap-2 text-xs text-ink-3">
                        <span>Rows {from}–{to} of {parsed.rows.length}</span>
                        <span className="flex items-center gap-1">
                          <Button type="button" variant="ghost" size="sm" disabled={previewPage === 0}
                            onClick={() => setPreviewPage((p) => Math.max(0, p - 1))}>Previous</Button>
                          <span className="tabular-nums">Page {previewPage + 1} of {pages}</span>
                          <Button type="button" variant="ghost" size="sm" disabled={previewPage >= pages - 1}
                            onClick={() => setPreviewPage((p) => Math.min(pages - 1, p + 1))}>Next</Button>
                        </span>
                      </div>
                    );
                  })()}
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

          {/* Opening balance from this statement's running-balance column.
              R-2522: shown whenever the preview has lines — it used to render only while the date
              was filled, so typing a date (the field is empty mid-typing) made the whole box,
              checkbox and date field included, disappear. */}
          {parsed && parsed.rows.length > 0 && (
            <div data-testid="opening-box" className="rounded-md border border-hairline bg-paper-2/30 p-3">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-amber"
                  checked={applyOpening}
                  disabled={!opening?.ok}
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
                {opening?.ok && (
                  <span className="text-sm font-semibold tabular-nums text-ink">{rupee(opening.amount)}</span>
                )}
              </div>

              <div className="mt-1.5 pl-6 space-y-1 text-xs">
                {!opening && <p className="text-ink-3">Pick the &quot;As of&quot; date to read the opening balance from the statement.</p>}
                {opening && !opening.ok && <p className="text-rose-ink">{opening.reason}</p>}
                {opening?.ok && (
                  <p className="text-ink-3">
                    Balance just before the {formatDate(opening.firstLineDate)} line (its balance, plus its debit, minus its credit).
                  </p>
                )}
                {opening?.ok && opening.firstLineDate > openingDate && (
                  <p className="text-amber-ink flex items-start gap-1.5">
                    <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                    <span>
                      The statement&apos;s first line on or after {formatDate(openingDate)} is on {formatDate(opening.firstLineDate)}.
                      This figure is the balance on {formatDate(openingDate)} only if nothing moved in between — check it against your passbook.
                    </span>
                  </p>
                )}
                {opening?.ok && opening.chainBreaks > 0 && (
                  <p className="text-amber-ink flex items-start gap-1.5">
                    <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                    <span>
                      {opening.chainBreaks} line{opening.chainBreaks === 1 ? "" : "s"} where the running balance does not follow from the line before.
                      Some lines may have been skipped while reading the statement — check before using this figure.
                    </span>
                  </p>
                )}
                {/* R-2522: lines printed out of order inside one day whose day-end balance is right —
                    nothing is missing, so a note, not a warning (the chain box above agrees). */}
                {opening?.ok && opening.outOfOrder && (
                  <p data-testid="out-of-order-note" className="text-ink-3 flex items-start gap-1.5">
                    <Icon name="info" size={12} className="mt-0.5 shrink-0" />
                    <span>
                      {opening.outOfOrder.lines} line{opening.outOfOrder.lines === 1 ? " is" : "s are"} printed out of order within the day
                      ({opening.outOfOrder.days.map((d) => formatDate(d)).join(", ")}); each day&apos;s closing balance is right, so nothing is missing.
                    </span>
                  </p>
                )}
                {moveCheck?.kind === "earlier" && (
                  <div
                    data-testid="opening-move-check"
                    className={`mt-1 rounded border px-2 py-1.5 ${moveCheck.matches ? "border-emerald/30 bg-emerald-50 text-emerald-ink" : "border-rose/30 bg-rose-50 text-rose-ink"}`}
                  >
                    <p>
                      By this statement the balance at the start of {formatDate(moveCheck.oldDate)} is{" "}
                      <b className="tabular-nums">{rupee(moveCheck.balanceOnOldDate)}</b>; the current opening on that date is{" "}
                      <b className="tabular-nums">{rupee(moveCheck.oldOpening)}</b>.
                    </p>
                    {moveCheck.linesOnOldDate > 0 && (
                      <p>
                        Includes {moveCheck.linesOnOldDate} new line{moveCheck.linesOnOldDate === 1 ? "" : "s"} dated {formatDate(moveCheck.oldDate)} (or with
                        a value date before it) — the bank counts {moveCheck.linesOnOldDate === 1 ? "it" : "them"} in the balance the current opening was taken from.
                      </p>
                    )}
                    {moveCheck.roundingDrift !== 0 && (
                      <p>
                        This is the statement&apos;s own balance; its amounts rounded to whole rupees add up to {rupee(Math.abs(moveCheck.roundingDrift))}{" "}
                        {moveCheck.roundingDrift < 0 ? "less" : "more"} (paise rounding, not a missing line).
                      </p>
                    )}
                    {moveCheck.matches ? (
                      <p>It matches the current opening, so today&apos;s balance stays the same. The old opening is kept in the account&apos;s history.</p>
                    ) : (
                      <>
                        <p>
                          It differs by {moveCheck.difference < 0 ? "−" : "+"}{rupee(Math.abs(moveCheck.difference))}, so today&apos;s balance would change by that much.
                          A line may be missing from the statement, or the date may be wrong — check the preview and the date.
                        </p>
                        {isOwner ? (
                          <>
                            <label className="mt-1 flex items-start gap-2 cursor-pointer text-ink">
                              <input
                                type="checkbox"
                                className="mt-0.5 accent-amber"
                                checked={acceptDifference}
                                onChange={(e) => setAcceptDifference(e.target.checked)}
                              />
                              <span>The figures differ — set it anyway (the difference is recorded in the account&apos;s history)</span>
                            </label>
                            {acceptDifference && (
                              <div className="mt-1 pl-6">
                                <label htmlFor="opening-accept-reason" className="block text-ink-2">Why do the figures differ? (required, kept in the history)</label>
                                <textarea
                                  id="opening-accept-reason"
                                  rows={2}
                                  value={acceptReason}
                                  onChange={(e) => setAcceptReason(e.target.value)}
                                  placeholder="e.g. Passbook checked — the bank reversed a charge after the statement date"
                                  className="mt-0.5 w-full rounded border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber"
                                />
                                {!reasonOk && <p className="text-rose-ink">Write the reason ({REASON_MIN}+ characters) to import.</p>}
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="font-semibold">Only the owner can accept a difference — ask the owner to import this statement.</p>
                        )}
                      </>
                    )}
                  </div>
                )}
                {/* R-2522: hand-entered lines between the two dates now count — one may be the same
                    payment as a statement line. */}
                {moveCheck?.kind === "earlier" && manualInWindow.length > 0 && (
                  <div data-testid="manual-in-window" className="text-amber-ink flex items-start gap-1.5">
                    <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                    <div>
                      {manualInWindow.length} hand-entered line{manualInWindow.length === 1 ? " is" : "s are"} already in this account
                      between {formatDate(openingDate)} and {formatDate(moveCheck.oldDate)}; after this move {manualInWindow.length === 1 ? "it counts" : "they count"} too.
                      If {manualInWindow.length === 1 ? "it is" : "one is"} the same payment as a statement line, delete it on the transactions page first:
                      <ul className="mt-0.5 ml-4 list-disc">
                        {manualInWindow.slice(0, 5).map((l) => (
                          <li key={l.id}>{formatDate(l.txn_date)} · {l.debit ? `${rupee(l.debit)} out` : `${rupee(l.credit)} in`} · {l.description || "—"}</li>
                        ))}
                        {manualInWindow.length > 5 && <li>…and {manualInWindow.length - 5} more</li>}
                      </ul>
                    </div>
                  </div>
                )}
                {openingOn && excludedCount > 0 && (
                  <p className="text-ink-2">
                    {excludedCount} line{excludedCount === 1 ? "" : "s"} dated before {formatDate(openingDate)} will <b>not</b> be imported — the opening balance already includes {excludedCount === 1 ? "it" : "them"}.
                  </p>
                )}
              </div>
            </div>
          )}

          {beforeOpeningCount > 0 && account && (
            <p data-testid="lines-before-opening" className="rounded-md border border-amber/30 bg-amber-50 px-3 py-2 text-xs text-amber-ink">
              {beforeOpeningCount} line{beforeOpeningCount === 1 ? " is" : "s are"} dated before this account&apos;s opening date ({formatDate(account.opening_balance_date)}).
              {" "}They will be imported but will <b>not be counted</b> in the balance — the opening balance already holds them.
              To count them, tick &quot;Set opening balance from this statement&quot; with an earlier date.
            </p>
          )}

          <div className="rounded-md bg-indigo-50 border border-indigo/20 px-3 py-2 text-xs text-indigo-ink">
            <b>Tip:</b> Download the statement from net banking as <b>PDF</b>, <b>Excel</b> or <b>CSV</b> — all work.
            AI reads the PDF; Excel and CSV are detected automatically (HDFC, ICICI, SBI, Axis,
            Kotak, IndusInd, Yes Bank). Always check the preview before importing.
          </div>
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="upload"
            disabled={(freshCount === 0 && !openingOn) || blocked || signWaits || (openingOn && openingWaits)}
            title={signWaits
              ? "Check the sign of the marked lines — see the \"Check the sign\" box in the preview"
              : blocked
              ? "Some statement lines are missing — see the red box in the preview"
              : openingOn && openingWaits
                ? "The statement does not match the current opening — see the opening balance box"
                : undefined}
            loading={importMut.isPending}
            onClick={handleImport}
          >
            {freshCount === 0 && openingOn
              ? "Set opening balance"
              : dupCount > 0 && freshCount === 0
                ? "All already imported"
                : `Import ${freshCount} row${freshCount === 1 ? "" : "s"}${openingOn ? " + opening balance" : ""}`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
