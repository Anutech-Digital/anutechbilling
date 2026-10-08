/**
 * R-346 — the customer's "Pay later" terms: may their quotes be activated on credit, and up to
 * how much (empty = ₹50,000). Only the owner changes them (the database refuses anyone else,
 * so "only the owner can go over the limit" cannot be sidestepped by raising the limit).
 * Before the migration the columns are absent and the card says so instead of failing.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toastError } from "@/lib/errors/toast-error";
import { rupee } from "@/lib/utils";
import { CREDIT_DEFAULT_LIMIT, effectiveCreditLimit, owedOnInvoices, NEEDS_DB_UPDATE_MESSAGE } from "@/lib/credit/activate-on-credit";
import { useCustomerOpenInvoices, useUpdateCustomerCredit } from "@/lib/credit/queries";

interface Props {
  customer: { id: string; allow_pay_later?: boolean | null; credit_limit?: number | null };
  isOwner: boolean;
}

/** "" → null (default limit); otherwise a whole, non-negative rupee amount, or undefined = invalid. */
export function parseCreditLimit(raw: string): number | null | undefined {
  const t = raw.replace(/[,₹\s]/g, "");
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return undefined;
  return Number(t);
}

export function CreditSettingsCard({ customer, isOwner }: Props) {
  const dbReady = "allow_pay_later" in customer;
  const savedAllow = customer.allow_pay_later !== false;
  const savedLimit = customer.credit_limit ?? null;
  const [allow, setAllow] = React.useState(savedAllow);
  const [limitText, setLimitText] = React.useState(savedLimit === null ? "" : String(savedLimit));
  const update = useUpdateCustomerCredit();
  const { data: openInvoices } = useCustomerOpenInvoices(customer.id, dbReady);

  React.useEffect(() => {
    setAllow(savedAllow);
    setLimitText(savedLimit === null ? "" : String(savedLimit));
  }, [savedAllow, savedLimit]);

  if (!dbReady) {
    return (
      <Card title="Pay later">
        <p className="text-xs text-ink-3">{NEEDS_DB_UPDATE_MESSAGE}</p>
      </Card>
    );
  }

  const parsed = parseCreditLimit(limitText);
  const limitOk = parsed !== undefined;
  const dirty = allow !== savedAllow || (limitOk && parsed !== savedLimit);
  const owed = openInvoices ? owedOnInvoices(openInvoices) : null;
  const limit = effectiveCreditLimit(savedLimit);

  const onSave = () => {
    if (!limitOk || parsed === undefined) return;
    update.mutate(
      { customerId: customer.id, allowPayLater: allow, creditLimit: parsed },
      {
        onSuccess: () => toast.success("Pay later terms saved"),
        onError: (err) => toastError(err, { fallback: "Could not save the Pay later terms." }),
      },
    );
  };

  return (
    <Card title="Pay later" sub={savedAllow ? `Limit ${rupee(limit)}${savedLimit === null ? " (default)" : ""}` : "Off"}>
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`pay-later-${customer.id}`} className="mb-0">Allow pay later</Label>
          <Switch
            id={`pay-later-${customer.id}`}
            checked={allow}
            onCheckedChange={setAllow}
            disabled={!isOwner || update.isPending}
          />
        </div>
        <div>
          <Label htmlFor={`credit-limit-${customer.id}`}>Credit limit (₹)</Label>
          <Input
            id={`credit-limit-${customer.id}`} inputMode="numeric" className="font-mono"
            placeholder={`${CREDIT_DEFAULT_LIMIT.toLocaleString("en-IN")} (default)`}
            value={limitText} onChange={(e) => setLimitText(e.target.value)}
            disabled={!isOwner || update.isPending}
            aria-invalid={!limitOk}
          />
          {!limitOk && <p className="text-xs text-rose mt-1">Whole rupees, or leave empty for {rupee(CREDIT_DEFAULT_LIMIT)}.</p>}
        </div>
        {owed !== null && (
          <p className="text-xs text-ink-3">
            Unpaid invoices now: <b className="text-ink-2">{rupee(owed)}</b>
            {owed > limit && <span className="text-rose"> · above the limit</span>}
          </p>
        )}
        {isOwner ? (
          dirty && (
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={onSave} disabled={!limitOk} loading={update.isPending}>Save</Button>
            </div>
          )
        ) : (
          <p className="text-xs text-ink-3">Only the owner can change these.</p>
        )}
      </div>
    </Card>
  );
}
