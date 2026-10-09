/**
 * AddReferralDialog — tag a referral partner to a customer's deal with commission
 * terms. When a payment later lands for this customer, the commission auto-accrues
 * (migration 0156 trigger). You can pick an existing partner or create a new one
 * inline. One active agreement per customer.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import {
  useReferralPartners, useCreatePartner, useCreateAgreement,
} from "@/lib/queries/referral-partners";
import { panProblem, normalisePan, commissionPercentProblem } from "@/lib/referrals/partner-fields";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string | null;
}

const NEW = "__new__";
const selectCls =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

export function AddReferralDialog({ open, onOpenChange, customerId, customerName }: Props) {
  const { data: partners } = useReferralPartners();
  const createPartner = useCreatePartner();
  const createAgreement = useCreateAgreement();
  const busy = createPartner.isPending || createAgreement.isPending;

  // Partner selection
  const [partnerId, setPartnerId] = React.useState<string>(NEW);
  const [newName, setNewName] = React.useState("");
  const [newPhone, setNewPhone] = React.useState("");
  const [newPan, setNewPan] = React.useState("");

  // Terms
  const [basis, setBasis] = React.useState<"percent" | "fixed">("percent");
  const [percent, setPercent] = React.useState("");
  const [fixedAmount, setFixedAmount] = React.useState("");
  const [scope, setScope] = React.useState<"one_time" | "recurring">("one_time");
  const [deductTds, setDeductTds] = React.useState(false);
  const [label, setLabel] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setPartnerId((partners && partners.length > 0) ? partners[0].id : NEW);
      setNewName(""); setNewPhone(""); setNewPan("");
      setBasis("percent"); setPercent(""); setFixedAmount("");
      setScope("one_time"); setDeductTds(false); setLabel("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // When picking an existing partner, adopt their default TDS setting.
  React.useEffect(() => {
    if (partnerId !== NEW) {
      const p = partners?.find((x) => x.id === partnerId);
      if (p) setDeductTds(p.deduct_tds);
    }
  }, [partnerId, partners]);

  const isNewPartner = partnerId === NEW;
  const pctNum = Number(percent) || 0;
  const fixedNum = Math.round(Number(fixedAmount) || 0);
  /* R-472: PAN is checked (TDS 194H needs a real one); blank is still allowed. */
  const panErr = panProblem(newPan);

  async function submit() {
    // Validate
    if (isNewPartner && !newName.trim()) { toast.error("Enter the partner's name.", { description: "A new partner needs a name before the referral can be saved." }); return; }
    if (isNewPartner && panErr) { toast.error("Check the partner's PAN.", { description: panErr }); return; }
    const pctErr = basis === "percent" ? commissionPercentProblem(percent) : null;
    if (pctErr) { toast.error("Check the commission percent.", { description: pctErr }); return; }
    if (basis === "fixed" && fixedNum <= 0) { toast.error("Fixed amount must be more than ₹0.", { description: "Enter the rupees the partner earns for this referral." }); return; }

    try {
      let usePartnerId = partnerId;
      if (isNewPartner) {
        const created = await createPartner.mutateAsync({
          name: newName.trim(),
          phone: newPhone.trim() || null,
          pan: normalisePan(newPan) || null,
          deduct_tds: deductTds,
        });
        usePartnerId = created.id;
      }
      await createAgreement.mutateAsync({
        partner_id: usePartnerId,
        customer_id: customerId,
        label: label.trim() || null,
        basis,
        percent: basis === "percent" ? pctNum : null,
        fixed_amount: basis === "fixed" ? fixedNum : null,
        scope,
        deduct_tds: deductTds,
      });
      onOpenChange(false);
    } catch {
      /* toast handled in the hooks */
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="!p-5 border-b border-hairline">
          <SheetTitle>Add referral partner</SheetTitle>
          <SheetDescription>
            Kisi ne ye deal refer / close karayi? Partner ko tag karo{customerName ? <> — <b>{customerName}</b></> : null}.
            Jab payment aayega, commission apne aap ban jayegi.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Partner */}
          <FormField label="Partner" htmlFor="ref_partner">
            <select id="ref_partner" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} className={selectCls}>
              {(partners ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value={NEW}>＋ New partner…</option>
            </select>
          </FormField>

          {isNewPartner && (
            <div className="rounded-md border border-hairline bg-paper-2/40 p-3 space-y-3">
              <FormField label="Name" htmlFor="ref_new_name">
                <Input id="ref_new_name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Rakesh Verma" />
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Phone (optional)" htmlFor="ref_new_phone">
                  <Input id="ref_new_phone" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="+91…" />
                </FormField>
                <FormField label="PAN (for TDS)" htmlFor="ref_new_pan">
                  <Input id="ref_new_pan" value={newPan} onChange={(e) => setNewPan(e.target.value.toUpperCase())} placeholder="e.g. ABCDE1234F" maxLength={12}
                         error={newPan.trim().length >= 10 ? panErr ?? undefined : undefined} />
                </FormField>
              </div>
            </div>
          )}

          {/* Basis */}
          <FormField label="Commission" htmlFor="ref_basis">
            <div className="flex gap-2">
              <select id="ref_basis" value={basis} onChange={(e) => setBasis(e.target.value as "percent" | "fixed")} className={selectCls + " max-w-[9rem]"}>
                <option value="percent">% of deal</option>
                <option value="fixed">Fixed ₹</option>
              </select>
              {basis === "percent" ? (
                <Input aria-label="Commission percent" type="text" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value.replace(/[^\d.]/g, ""))} placeholder="10" suffix="%" />
              ) : (
                <Input aria-label="Commission amount" type="text" inputMode="numeric" prefix="₹" value={fixedAmount} onChange={(e) => setFixedAmount(e.target.value.replace(/[^\d]/g, ""))} placeholder="e.g. 5000" />
              )}
            </div>
            <p className="mt-1 text-xs text-ink-3">
              {basis === "percent"
                ? "Deal ke ex-GST value ka % (GST par commission nahi)."
                : "Har qualifying payment par tay amount."}
            </p>
          </FormField>

          {/* Scope */}
          <FormField label="Kab tak milegi?" htmlFor="ref_scope">
            <select id="ref_scope" value={scope} onChange={(e) => setScope(e.target.value as "one_time" | "recurring")} className={selectCls}>
              <option value="one_time">One-time — sirf pehli sale par</option>
              <option value="recurring">Recurring — har renewal par bhi</option>
            </select>
          </FormField>

          {/* TDS */}
          <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
            <input type="checkbox" checked={deductTds} onChange={(e) => setDeductTds(e.target.checked)} className="h-4 w-4 rounded border-hairline text-amber focus:ring-amber/40" />
            2% TDS (194H) deduct karo — ek vyakti ko saal mein ₹20,000 se zyada commission ho to zaroori
          </label>

          <FormField label="Note (optional)" htmlFor="ref_label">
            <Input id="ref_label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Google Workspace — 50 seats" />
          </FormField>

          <div className="rounded-md bg-amber-soft/40 border border-amber/30 px-3 py-2 text-xs text-amber-ink leading-relaxed">
            {basis === "percent"
              ? <>Har {scope === "recurring" ? "payment" : "pehli payment"} par <b>{percent.trim() ? `${pctNum}%` : "…%"}</b> commission banegi{deductTds ? " (− 2% TDS)" : ""}. Manually approve karke pay karoge.</>
              : <>Har {scope === "recurring" ? "payment" : "pehli payment"} par <b>{rupee(fixedNum)}</b> commission banegi{deductTds ? " (− 2% TDS)" : ""}.</>}
          </div>
        </div>

        <SheetFooter className="!p-5 border-t border-hairline">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" icon="check" loading={busy} onClick={submit}>Save referral</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
