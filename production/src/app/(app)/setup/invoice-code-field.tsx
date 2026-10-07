/**
 * R-259 — "Invoice code" input with a live preview of the next invoice number.
 * Used by the setup wizard (step 1) and Settings → Company. Reads and saves through
 * /api/tenant/invoice-code; once a GST number has been issued it turns read-only.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { invoiceCodeProblem, normalizeInvoiceCode, previewInvoiceNumber } from "./invoice-code";

export interface InvoiceCodeState {
  saved: string | null;
  code: string;
  locked: boolean;
  nextNumber: number;
  fyYY: string;
  preview: string;
}

const KEY = ["invoice-code"] as const;

async function readJson(res: Response): Promise<unknown> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

export function useInvoiceCode() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => readJson(await fetch("/api/tenant/invoice-code", { cache: "no-store" })) as Promise<InvoiceCodeState>,
    staleTime: 30_000,
  });
}

export function useSaveInvoiceCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) =>
      readJson(
        await fetch("/api/tenant/invoice-code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        }),
      ) as Promise<InvoiceCodeState>,
    onSuccess: (state) => {
      qc.setQueryData(KEY, state);
      qc.invalidateQueries({ queryKey: ["current-user"] });
    },
  });
}

export function InvoiceCodeField({
  id,
  value,
  onChange,
  state,
  disabled,
  serverError,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  state: InvoiceCodeState | undefined;
  disabled?: boolean;
  /** Error from the last save (e.g. "already used by another business"). */
  serverError?: string | null;
}) {
  if (!state) {
    return <p className="text-xs text-ink-3">Loading invoice numbering…</p>;
  }

  if (state.locked) {
    return (
      <div>
        <Input id={id} className="font-mono" value={state.code} readOnly aria-readonly="true" disabled />
        <p className="mt-1 inline-flex items-center gap-1 text-3xs text-ink-3">
          <Icon name="lock" size={11} />
          Locked — your invoices already use {state.code}. Next invoice:{" "}
          <span className="font-mono text-ink-2">{state.preview}</span>
        </p>
      </div>
    );
  }

  const code = normalizeInvoiceCode(value);
  const problem = code ? invoiceCodeProblem(code) : null;
  const preview = code && !problem ? previewInvoiceNumber(code, state.fyYY, state.nextNumber) : null;
  const error = problem ?? serverError ?? undefined;

  return (
    <div>
      <Input
        id={id}
        className="font-mono uppercase"
        placeholder="e.g. SHRM"
        maxLength={4}
        autoComplete="off"
        value={value}
        disabled={disabled}
        error={error}
        onChange={(e) => onChange(normalizeInvoiceCode(e.target.value).slice(0, 4))}
      />
      {!error && (
        <p className="mt-1 text-3xs text-ink-3" aria-live="polite">
          {preview ? (
            <>Next invoice: <span className="font-mono text-ink-2">{preview}</span> · locks after your first invoice</>
          ) : (
            <>2–4 letters. Blank keeps <span className="font-mono">{state.preview}</span></>
          )}
        </p>
      )}
    </div>
  );
}
