/**
 * R-2394 — Private Vault → Banking → an account → "Import statement".
 *
 * The SAME readers the company import uses (statement-parse for CSV / text, statement-xlsx
 * for .xls / .xlsx — one way to read a bank file everywhere), then the personal mapping
 * (import.ts: kind + category from the person's own rules and keywords, dedupe hash) and
 * ONE RPC, personal_import_commit: the batch and its lines land together, and a line already
 * imported (same dedupe hash on this account) is skipped — an overlapping statement never
 * doubles the money. Lines come in UNMATCHED; the owner confirms each on the account page.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { parseStatement, parseStatementRows, type ParseResult } from "@/lib/banking/statement-parse";
import { excelToRows, isExcelFile } from "@/lib/banking/statement-xlsx";
import { mapStatement, verifyAgainstStatement } from "@/lib/vault/personal/import";
import { dbKindFor, toCategoryRules } from "@/lib/vault/personal/bank-ledger";
import {
  useCommitPersonalImport,
  usePersonalCategoryRules,
  type PersonalAccount,
} from "@/lib/queries/personal-vault";
import { rupee } from "@/lib/utils";

interface Props {
  account: PersonalAccount;
  /** Last digits of the person's OTHER accounts — a transfer to them is a self transfer. */
  otherTails: string[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function BankImportDialog({ account, otherTails, open, onOpenChange }: Props) {
  const rulesQ = usePersonalCategoryRules();
  const commit = useCommitPersonalImport();
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [fileKind, setFileKind] = React.useState<"csv" | "xlsx">("csv");
  const [parsed, setParsed] = React.useState<ParseResult | null>(null);
  const [readError, setReadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) { setFileName(null); setParsed(null); setReadError(null); }
  }, [open]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReadError(null);
    setFileName(file.name);
    try {
      if (isExcelFile(file)) {
        setFileKind("xlsx");
        setParsed(parseStatementRows(await excelToRows(await file.arrayBuffer())));
      } else if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
        setParsed(null);
        setReadError("PDF statements are not read here yet. Download the statement as Excel or CSV from your bank and upload that.");
      } else {
        setFileKind("csv");
        setParsed(parseStatement(await file.text()));
      }
    } catch {
      setParsed(null);
      setReadError("Could not read this file. Upload the bank's CSV or Excel statement.");
    }
  };

  const lines = React.useMemo(() => {
    if (!parsed) return [];
    return mapStatement(parsed.rows, {
      rules: toCategoryRules(rulesQ.data ?? []),
      ownAccountTails: otherTails,
    });
  }, [parsed, rulesQ.data, otherTails]);

  const check = React.useMemo(
    () => (parsed && parsed.rows.length ? verifyAgainstStatement(parsed.rows) : null),
    [parsed],
  );

  const dates = lines.map((l) => l.txn_date).sort();
  const moneyIn = lines.filter((l) => l.direction === "credit").reduce((s, l) => s + l.amount, 0);
  const moneyOut = lines.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amount, 0);

  const doImport = async () => {
    if (!lines.length) return;
    try {
      const res = await commit.mutateAsync({
        account_id: account.id,
        file_name: fileName,
        file_kind: fileKind,
        statement_from: dates[0] ?? null,
        statement_to: dates[dates.length - 1] ?? null,
        rows: lines.map((l) => {
          const { kind, category } = dbKindFor(l);
          return {
            kind: kind as never,
            amount: l.amount,
            occurred_on: l.txn_date,
            dedupe_hash: l.dedupeHash,
            category,
            reference: l.reference,
            raw_description: l.description,
            balance_after: l.balance_after,
          };
        }),
      });
      toast.success(
        res.inserted > 0
          ? `${res.inserted} new line${res.inserted === 1 ? "" : "s"} imported.`
          : "Nothing new — every line was already imported.",
        { description: res.skipped > 0 ? `${res.skipped} line${res.skipped === 1 ? " was" : "s were"} already here and skipped.` : undefined },
      );
      onOpenChange(false);
    } catch {
      /* the hook already showed why */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Import statement · {account.label}</DialogTitle>
          <DialogDescription className="text-xs">
            Upload the CSV or Excel statement from your bank. Lines already imported are skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label htmlFor="vbi-file" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Statement file</label>
            <input
              id="vbi-file"
              type="file"
              accept=".csv,.txt,.xls,.xlsx,text/csv,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => void onFile(e.target.files?.[0])}
              className="block w-full text-sm text-ink-2 file:mr-3 file:rounded-md file:border file:border-hairline file:bg-paper-2 file:px-3 file:py-1.5 file:text-sm"
            />
          </div>

          {readError && <p role="alert" className="text-sm text-rose">{readError}</p>}

          {parsed && lines.length === 0 && !readError && (
            <p role="alert" className="text-sm text-rose">
              No transaction lines found. Check that the file has Date, Description and Debit / Credit columns.
            </p>
          )}

          {lines.length > 0 && (
            <div className="rounded-lg border border-hairline bg-paper-2 p-3 text-sm space-y-1" data-testid="vbi-summary">
              <p className="text-ink"><strong>{lines.length}</strong> lines · {dates[0]} to {dates[dates.length - 1]}</p>
              <p className="text-ink-2">Money in {rupee(moneyIn)} · Money out {rupee(moneyOut)}</p>
              {check && (
                <p className={check.verdict === "off" && check.gaps.length > 0 ? "text-rose" : "text-ink-2"}>
                  {check.gaps.length > 0
                    ? `The statement's own running balance has ${check.gaps.length} gap${check.gaps.length === 1 ? "" : "s"} — a line may be missing from the file.`
                    : `Statement's closing balance ${rupee(check.statementBalance)} on ${check.statementDate}.`}
                </p>
              )}
              {parsed && parsed.skipped > 0 && (
                <p className="text-ink-3 text-xs">{parsed.skipped} row{parsed.skipped === 1 ? "" : "s"} without an amount (headings, totals) left out.</p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={doImport} disabled={!lines.length} loading={commit.isPending}>
            {lines.length ? `Import ${lines.length} lines` : "Import"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
