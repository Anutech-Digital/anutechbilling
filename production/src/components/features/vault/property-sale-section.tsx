/**
 * R-2393 — Private Vault → Wealth → a property → "Sell this property".
 *
 * Pardeep (3 Nov): "property sell karta hai aur sell karne ki poori process jaise byana ko
 * handle karna kaise record karenge". One dialog follows the deal from agreement to registry:
 *   1. Sale details — whose property (you, or a family member from People: the gain is their
 *      income), buyer (People), agreement date, agreed price, stamp-duty value, and the cost
 *      side for the capital-gains estimate.
 *   2. Payments — byana (an open R-2386 "Advance received for a sale" can be MOVED in, so it is
 *      not counted twice), instalments, final payment; bank / cheque / cash, with a warning
 *      for cash of ₹20,000 or more (s.269SS / 269ST).
 *   3. Registry — date, final payment, TDS the buyer deducted (s.194-IA, 1% at ₹50 lakh+):
 *      the property leaves net worth.
 *   4. Cancel — refund the advance and/or forfeit the rest (Income from other sources).
 *   5. Capital gains — estimate (12.5% / 20% with indexation, s.50C, exemptions). The card's
 *      needsDecision: a CA confirms this wording and these rates before release.
 * Rules live in lib/vault/personal/property-sale.ts; money moves are one RPC each.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/providers/confirm-provider";
import { PersonPicker } from "@/components/features/vault/person-picker";
import { usePersonalAccounts } from "@/lib/queries/personal-vault";
import { usePersonalOweHold } from "@/lib/queries/personal-owe-hold";
import { usePersonalContacts } from "@/lib/queries/personal-contacts";
import {
  useAddPropertySaleReceipt,
  useCancelPropertySale,
  useDeletePropertySaleReceipt,
  usePersonalPropertySales,
  useRegisterPropertySale,
  useSavePersonalPropertySale,
  type PersonalPropertySale,
  type PersonalPropertySaleReceipt,
} from "@/lib/queries/personal-property-sales";
import {
  CG_EXEMPTION_NOTES,
  RECEIPT_KIND_LABEL,
  RECEIPT_MODE_LABEL,
  SALE_STATUS_LABEL,
  balanceDue,
  capitalGains,
  isCashWarning,
  receivedTotal,
  tds194IA,
  type ReceiptKind,
  type ReceiptMode,
} from "@/lib/vault/personal/property-sale";
import { isLiabilityAccount } from "@/lib/vault/personal/net-worth";
import { parseRupees } from "@/lib/vault/personal/parse-rupees";
import { istToday } from "@/lib/dates/ist";
import { formatDate, rupee } from "@/lib/utils";

const NONE = "none";
const SELF = "self";
const label = "block text-2xs uppercase tracking-wide text-ink-3 mb-1";

export interface SaleHolding {
  id: string;
  name: string;
  invested: number;
}

/** The live (not cancelled) deal of a holding, if any. */
export function liveSaleOf(holdingId: string, sales: readonly PersonalPropertySale[]): PersonalPropertySale | null {
  return sales.find((s) => s.holding_id === holdingId && s.status !== "cancelled") ?? null;
}

/** Positive whole rupees from a form field, or a §24 toast and null. */
function amountOrToast(raw: string, what: string, allowZero = false): number | null {
  const p = parseRupees(raw);
  if (!p.ok) {
    toast.error(`${what} must be a number`, { description: "Type digits only, e.g. 500000. No commas or ₹ sign needed." });
    return null;
  }
  if (!allowZero && p.value <= 0) {
    toast.error(`Enter the ${what.toLowerCase()}`, { description: "It must be more than ₹0." });
    return null;
  }
  return p.value;
}

interface DealForm {
  id?: string;
  seller: string; // SELF or a contact id
  buyer: { contactId: string | null; name: string };
  agreement_date: string;
  agreed_price: string;
  stamp_value: string;
  acquired_on: string;
  cost: string;
  improvements: string;
  transfer_expenses: string;
  note: string;
}

function dealForm(h: SaleHolding, s?: PersonalPropertySale | null): DealForm {
  if (s) {
    return {
      id: s.id,
      seller: s.seller_contact_id ?? SELF,
      buyer: { contactId: s.contact_id, name: s.party },
      agreement_date: s.agreement_date,
      agreed_price: String(s.agreed_price),
      stamp_value: s.stamp_value ? String(s.stamp_value) : "",
      acquired_on: s.acquired_on ?? "",
      cost: String(s.cost_of_acquisition),
      improvements: s.improvement_cost ? String(s.improvement_cost) : "",
      transfer_expenses: s.transfer_expenses ? String(s.transfer_expenses) : "",
      note: s.note ?? "",
    };
  }
  return {
    seller: SELF, buyer: { contactId: null, name: "" }, agreement_date: istToday(),
    agreed_price: "", stamp_value: "", acquired_on: "", cost: h.invested ? String(h.invested) : "",
    improvements: "", transfer_expenses: "", note: "",
  };
}

type Panel = null | "pay" | "registry" | "cancel";

/** Mounts the sale dialog only while a property is picked, so its queries run only then. */
export function PropertySaleDialog({ holding, open, onOpenChange }: {
  holding: SaleHolding | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!holding) return null;
  return <SaleDialogBody key={holding.id} holding={holding} open={open} onOpenChange={onOpenChange} />;
}

function SaleDialogBody({ holding, open, onOpenChange }: {
  holding: SaleHolding;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const salesQ = usePersonalPropertySales();
  const { data: accounts = [] } = usePersonalAccounts();
  const { data: oweHold = [] } = usePersonalOweHold();
  const { data: contacts = [] } = usePersonalContacts();
  const saveDeal = useSavePersonalPropertySale();
  const addReceipt = useAddPropertySaleReceipt();
  const delReceipt = useDeletePropertySaleReceipt();
  const register = useRegisterPropertySale();
  const cancel = useCancelPropertySale();
  const confirm = useConfirm();

  const sales = salesQ.data?.sales ?? [];
  const receipts = salesQ.data?.receipts ?? [];
  const sale = holding ? liveSaleOf(holding.id, sales) : null;
  const saleReceipts = sale ? receipts.filter((r) => r.sale_id === sale.id) : [];

  const [editing, setEditing] = React.useState(false);
  const [form, setForm] = React.useState<DealForm | null>(null);
  const [panel, setPanel] = React.useState<Panel>(null);
  const [pay, setPay] = React.useState({ kind: "byana" as ReceiptKind, from_hold: NONE, amount: "", received_on: istToday(), mode: "bank" as ReceiptMode, account_id: NONE, note: "" });
  const [reg, setReg] = React.useState({ registry_date: istToday(), final_amount: "", mode: "bank" as ReceiptMode, account_id: NONE, tds: "" });
  const [can, setCan] = React.useState({ cancelled_on: istToday(), refund: "", account_id: NONE, note: "" });


  const pickable = accounts.filter((a) => a.is_active && !isLiabilityAccount(a.kind));
  const accountName = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.label ?? "Removed account" : "—");
  const openAdvances = oweHold.filter((o) => o.kind === "advance_received" && o.status === "open");
  const activeContacts = contacts.filter((c) => !c.archived);

  const showForm = !sale || editing;
  const f = form ?? dealForm(holding, editing ? sale : null);
  const setF = (patch: Partial<DealForm>) => setForm({ ...f, ...patch });

  const handleSaveDeal = async () => {
    if (!f.buyer.name.trim()) { toast.error("Pick the buyer", { description: "Choose a person from People, or add them with \"+ New contact\"." }); return; }
    const agreed = amountOrToast(f.agreed_price, "Agreed price");
    if (agreed === null) return;
    const stamp = f.stamp_value.trim() ? amountOrToast(f.stamp_value, "Stamp-duty value") : null;
    if (f.stamp_value.trim() && stamp === null) return;
    const cost = amountOrToast(f.cost, "Purchase cost", true);
    const impr = amountOrToast(f.improvements, "Improvement cost", true);
    const exp = amountOrToast(f.transfer_expenses, "Transfer expenses", true);
    if (cost === null || impr === null || exp === null) return;
    if (f.acquired_on && f.acquired_on > f.agreement_date) {
      toast.error("Bought on is after the agreement date", { description: "Check the purchase date." });
      return;
    }
    try {
      await saveDeal.mutateAsync({
        id: f.id,
        holding_id: holding.id,
        seller_contact_id: f.seller === SELF ? null : f.seller,
        contact_id: f.buyer.contactId,
        party: f.buyer.name.trim(),
        agreement_date: f.agreement_date || istToday(),
        agreed_price: agreed,
        stamp_value: stamp,
        acquired_on: f.acquired_on || null,
        cost_of_acquisition: cost,
        improvement_cost: impr,
        transfer_expenses: exp,
        note: f.note.trim() || null,
      });
      toast.success(f.id ? "Sale details updated" : "Sale started", { description: f.id ? undefined : "Now add the byana and other payments as they come." });
      setEditing(false);
      setForm(null);
    } catch { /* the hook showed why */ }
  };

  const openPay = () => {
    const firstAdvance = saleReceipts.length === 0 && openAdvances.length > 0 ? openAdvances[0].id : NONE;
    setPay({ kind: saleReceipts.length === 0 ? "byana" : "instalment", from_hold: firstAdvance, amount: "", received_on: istToday(), mode: "bank", account_id: NONE, note: "" });
    setPanel("pay");
  };

  const handleAddPayment = async () => {
    if (!sale) return;
    const fromHold = pay.kind === "byana" && pay.from_hold !== NONE ? pay.from_hold : null;
    let amount: number | null = null;
    if (!fromHold) {
      amount = amountOrToast(pay.amount, "Amount received");
      if (amount === null) return;
    }
    try {
      const r = await addReceipt.mutateAsync({
        sale_id: sale.id, kind: pay.kind, received_on: fromHold ? null : pay.received_on, amount,
        mode: pay.mode, account_id: pay.account_id === NONE ? null : pay.account_id, owe_hold_id: fromHold,
        note: pay.note.trim() || null,
      });
      if (r?.cash_warning) {
        toast.warning("Payment added — cash of ₹20,000 or more", { description: "Cash for a property deal at this size can attract a penalty (s.269SS / 269ST). Ask your CA." });
      } else {
        toast.success(fromHold ? "Byana moved into the sale" : "Payment added");
      }
      setPanel(null);
    } catch { /* the hook showed why */ }
  };

  const handleDeletePayment = async (r: PersonalPropertySaleReceipt) => {
    const ok = await confirm({
      title: `Delete this ${RECEIPT_KIND_LABEL[r.kind].toLowerCase()}?`,
      body: r.owe_hold_id
        ? `${rupee(r.amount)} goes back to "Money I owe / hold for others" as an open advance.`
        : `${rupee(r.amount)}${r.tx_id ? " also comes off the account it was added to" : ""}.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try { await delReceipt.mutateAsync(r.id); toast.success("Payment deleted"); } catch { /* shown */ }
  };

  const openRegistry = () => {
    if (!sale) return;
    const tds = tds194IA(sale.agreed_price, sale.stamp_value);
    const remaining = Math.max(sale.agreed_price - receivedTotal(sale.id, receipts) - tds, 0);
    setReg({ registry_date: istToday(), final_amount: remaining ? String(remaining) : "", mode: "bank", account_id: NONE, tds: String(tds) });
    setPanel("registry");
  };

  const handleRegister = async () => {
    if (!sale) return;
    const tds = amountOrToast(reg.tds, "TDS deducted", true);
    const fin = amountOrToast(reg.final_amount, "Final payment", true);
    if (tds === null || fin === null) return;
    if (reg.registry_date < sale.agreement_date) {
      toast.error("Registry date is before the agreement", { description: `The agreement is dated ${formatDate(sale.agreement_date)}.` });
      return;
    }
    try {
      const r = await register.mutateAsync({
        sale_id: sale.id, registry_date: reg.registry_date, tds_deducted: tds, final_amount: fin || null,
        final_mode: reg.mode, final_account_id: reg.account_id === NONE ? null : reg.account_id, note: null,
      });
      toast.success("Registry recorded — property sold", {
        description: r && r.balance_due > 0 ? `${rupee(r.balance_due)} of the price is still to come. Add it as a payment when it arrives.` : "The property is no longer in your net worth.",
      });
      setPanel(null);
    } catch { /* shown */ }
  };

  const openCancel = () => {
    if (!sale) return;
    setCan({ cancelled_on: istToday(), refund: String(receivedTotal(sale.id, receipts)), account_id: NONE, note: "" });
    setPanel("cancel");
  };

  const handleCancel = async () => {
    if (!sale) return;
    const refund = amountOrToast(can.refund, "Refund", true);
    if (refund === null) return;
    const got = receivedTotal(sale.id, receipts);
    if (refund > got) { toast.error("Refund is more than you received", { description: `You received ${rupee(got)} on this sale.` }); return; }
    try {
      await cancel.mutateAsync({
        sale_id: sale.id, cancelled_on: can.cancelled_on, refund,
        refund_account_id: can.account_id === NONE ? null : can.account_id, note: can.note.trim() || null,
      });
      toast.success("Sale cancelled", { description: got - refund > 0 ? `${rupee(got - refund)} forfeited — added to Income as Other sources.` : undefined });
      setPanel(null);
    } catch { /* shown */ }
  };

  const accountSelect = (id: string, value: string, onChange: (v: string) => void, none = "Not in an account") => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{none}</SelectItem>
        {pickable.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Sell {holding.name}</DialogTitle>
          <DialogDescription className="text-xs">
            Agreement → byana → instalments → registry. Tax figures are an estimate — confirm with your CA.
          </DialogDescription>
        </DialogHeader>

        {salesQ.isLoading && <p className="text-sm text-ink-3">Loading…</p>}

        {!salesQ.isLoading && showForm && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="ps-seller" className={label}>Whose property</label>
                <Select value={f.seller} onValueChange={(v) => setF({ seller: v })}>
                  <SelectTrigger id="ps-seller"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SELF}>Mine</SelectItem>
                    {activeContacts.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-2xs text-ink-3 mt-1">The capital gain is the income of the person who owns it.</p>
              </div>
              <div>
                <label htmlFor="ps-buyer" className={label}>Buyer</label>
                <PersonPicker id="ps-buyer" value={f.buyer} onChange={(v) => setF({ buyer: v })} placeholder="Pick the buyer" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label htmlFor="ps-agreement" className={label}>Agreement date</label>
                <Input id="ps-agreement" type="date" value={f.agreement_date} onChange={(e) => setF({ agreement_date: e.target.value })} />
              </div>
              <div>
                <label htmlFor="ps-price" className={label}>Agreed price (₹)</label>
                <Input id="ps-price" inputMode="numeric" placeholder="6500000" value={f.agreed_price} onChange={(e) => setF({ agreed_price: e.target.value })} />
              </div>
              <div>
                <label htmlFor="ps-stamp" className={label}>Stamp-duty value (₹)</label>
                <Input id="ps-stamp" inputMode="numeric" placeholder="circle rate value" value={f.stamp_value} onChange={(e) => setF({ stamp_value: e.target.value })} />
              </div>
            </div>
            <p className="text-2xs uppercase tracking-wide text-ink-3 pt-1">For the capital-gains estimate</p>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label htmlFor="ps-bought" className={label}>Bought on</label>
                <Input id="ps-bought" type="date" value={f.acquired_on} onChange={(e) => setF({ acquired_on: e.target.value })} />
              </div>
              <div>
                <label htmlFor="ps-cost" className={label}>Purchase cost (₹)</label>
                <Input id="ps-cost" inputMode="numeric" value={f.cost} onChange={(e) => setF({ cost: e.target.value })} />
              </div>
              <div>
                <label htmlFor="ps-impr" className={label}>Improvements (₹)</label>
                <Input id="ps-impr" inputMode="numeric" placeholder="0" value={f.improvements} onChange={(e) => setF({ improvements: e.target.value })} />
              </div>
              <div>
                <label htmlFor="ps-exp" className={label}>Brokerage, legal (₹)</label>
                <Input id="ps-exp" inputMode="numeric" placeholder="0" value={f.transfer_expenses} onChange={(e) => setF({ transfer_expenses: e.target.value })} />
              </div>
            </div>
            <div>
              <label htmlFor="ps-note" className={label}>Note</label>
              <Input id="ps-note" placeholder="optional" value={f.note} onChange={(e) => setF({ note: e.target.value })} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => (sale ? (setEditing(false), setForm(null)) : onOpenChange(false))}>Cancel</Button>
              <Button variant="primary" onClick={handleSaveDeal} loading={saveDeal.isPending}>{f.id ? "Save" : "Start sale"}</Button>
            </div>
          </div>
        )}

        {!salesQ.isLoading && sale && !editing && (
          <DealView
            sale={sale}
            receipts={saleReceipts}
            sellerName={sale.seller_contact_id ? contacts.find((c) => c.id === sale.seller_contact_id)?.name ?? "a family member" : null}
            accountName={accountName}
            onEdit={() => { setEditing(true); setForm(null); }}
            onPay={openPay}
            onRegistry={openRegistry}
            onCancel={openCancel}
            onDeletePayment={handleDeletePayment}
            panel={panel}
          >
            {panel === "pay" && (
              <div className="rounded-lg border border-hairline p-3 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label htmlFor="ps-pay-kind" className={label}>Payment</label>
                    <Select value={pay.kind} onValueChange={(v) => setPay((p) => ({ ...p, kind: v as ReceiptKind }))}>
                      <SelectTrigger id="ps-pay-kind"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="byana">{RECEIPT_KIND_LABEL.byana}</SelectItem>
                        <SelectItem value="instalment">{RECEIPT_KIND_LABEL.instalment}</SelectItem>
                        <SelectItem value="final">{RECEIPT_KIND_LABEL.final}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {pay.kind === "byana" && openAdvances.length > 0 && (
                    <div className="col-span-2">
                      <label htmlFor="ps-pay-hold" className={label}>Already noted as an advance?</label>
                      <Select value={pay.from_hold} onValueChange={(v) => setPay((p) => ({ ...p, from_hold: v }))}>
                        <SelectTrigger id="ps-pay-hold"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>No — a new payment</SelectItem>
                          {openAdvances.map((o) => (
                            <SelectItem key={o.id} value={o.id}>Move {rupee(o.amount)} from {o.party} ({formatDate(o.occurred_on)})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
                {!(pay.kind === "byana" && pay.from_hold !== NONE) && (
                  <div className="grid grid-cols-4 gap-3">
                    <div>
                      <label htmlFor="ps-pay-amount" className={label}>Amount (₹)</label>
                      <Input id="ps-pay-amount" inputMode="numeric" placeholder="500000" value={pay.amount} onChange={(e) => setPay((p) => ({ ...p, amount: e.target.value }))} />
                    </div>
                    <div>
                      <label htmlFor="ps-pay-date" className={label}>Received on</label>
                      <Input id="ps-pay-date" type="date" value={pay.received_on} onChange={(e) => setPay((p) => ({ ...p, received_on: e.target.value }))} />
                    </div>
                    <div>
                      <label htmlFor="ps-pay-mode" className={label}>Mode</label>
                      <Select value={pay.mode} onValueChange={(v) => setPay((p) => ({ ...p, mode: v as ReceiptMode }))}>
                        <SelectTrigger id="ps-pay-mode"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {(["bank", "cheque", "cash"] as const).map((m) => <SelectItem key={m} value={m}>{RECEIPT_MODE_LABEL[m]}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label htmlFor="ps-pay-account" className={label}>Into account</label>
                      {accountSelect("ps-pay-account", pay.account_id, (v) => setPay((p) => ({ ...p, account_id: v })))}
                    </div>
                  </div>
                )}
                {pay.kind === "byana" && pay.from_hold !== NONE && (
                  <p className="text-xs text-ink-3">The advance leaves &quot;Money I owe / hold for others&quot; and becomes this sale&apos;s byana — counted once.</p>
                )}
                {!(pay.kind === "byana" && pay.from_hold !== NONE) && isCashWarning(pay.mode, parseRupees(pay.amount).ok ? (parseRupees(pay.amount) as { value: number }).value : 0) && (
                  <CashWarning />
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setPanel(null)}>Close</Button>
                  <Button variant="primary" onClick={handleAddPayment} loading={addReceipt.isPending}>Add payment</Button>
                </div>
              </div>
            )}

            {panel === "registry" && (
              <div className="rounded-lg border border-hairline p-3 space-y-3">
                <div className="grid grid-cols-4 gap-3">
                  <div>
                    <label htmlFor="ps-reg-date" className={label}>Registry date</label>
                    <Input id="ps-reg-date" type="date" value={reg.registry_date} onChange={(e) => setReg((r) => ({ ...r, registry_date: e.target.value }))} />
                  </div>
                  <div>
                    <label htmlFor="ps-reg-final" className={label}>Final payment (₹)</label>
                    <Input id="ps-reg-final" inputMode="numeric" value={reg.final_amount} onChange={(e) => setReg((r) => ({ ...r, final_amount: e.target.value }))} />
                  </div>
                  <div>
                    <label htmlFor="ps-reg-mode" className={label}>Mode</label>
                    <Select value={reg.mode} onValueChange={(v) => setReg((r) => ({ ...r, mode: v as ReceiptMode }))}>
                      <SelectTrigger id="ps-reg-mode"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(["bank", "cheque", "cash"] as const).map((m) => <SelectItem key={m} value={m}>{RECEIPT_MODE_LABEL[m]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label htmlFor="ps-reg-account" className={label}>Into account</label>
                    {accountSelect("ps-reg-account", reg.account_id, (v) => setReg((r) => ({ ...r, account_id: v })))}
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <div>
                    <label htmlFor="ps-reg-tds" className={label}>TDS by buyer (₹)</label>
                    <Input id="ps-reg-tds" inputMode="numeric" value={reg.tds} onChange={(e) => setReg((r) => ({ ...r, tds: e.target.value }))} />
                  </div>
                  <p className="col-span-3 text-xs text-ink-3 self-end">
                    s.194-IA: the buyer deducts 1% when the price is ₹50 lakh or more and deposits it with Form 26QB.
                    It shows in your 26AS — claim it in your ITR.
                  </p>
                </div>
                {isCashWarning(reg.mode, parseRupees(reg.final_amount).ok ? (parseRupees(reg.final_amount) as { value: number }).value : 0) && <CashWarning />}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setPanel(null)}>Close</Button>
                  <Button variant="primary" onClick={handleRegister} loading={register.isPending}>Record registry</Button>
                </div>
              </div>
            )}

            {panel === "cancel" && (
              <div className="rounded-lg border border-rose/30 p-3 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label htmlFor="ps-can-date" className={label}>Cancelled on</label>
                    <Input id="ps-can-date" type="date" value={can.cancelled_on} onChange={(e) => setCan((c) => ({ ...c, cancelled_on: e.target.value }))} />
                  </div>
                  <div>
                    <label htmlFor="ps-can-refund" className={label}>Refund to buyer (₹)</label>
                    <Input id="ps-can-refund" inputMode="numeric" value={can.refund} onChange={(e) => setCan((c) => ({ ...c, refund: e.target.value }))} />
                  </div>
                  <div>
                    <label htmlFor="ps-can-account" className={label}>Refund from account</label>
                    {accountSelect("ps-can-account", can.account_id, (v) => setCan((c) => ({ ...c, account_id: v })), "Cash / not in an account")}
                  </div>
                </div>
                {(() => {
                  const got = receivedTotal(sale.id, receipts);
                  const p = parseRupees(can.refund);
                  const forfeit = p.ok ? Math.max(got - p.value, 0) : 0;
                  return forfeit > 0 ? (
                    <p className="text-xs text-ink-2">
                      You keep <b>{rupee(forfeit)}</b> (forfeited advance). It is added to Income as <b>Income from other sources</b> (s.56(2)(ix)).
                    </p>
                  ) : null;
                })()}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setPanel(null)}>Close</Button>
                  <Button variant="danger" onClick={handleCancel} loading={cancel.isPending}>Cancel the sale</Button>
                </div>
              </div>
            )}
          </DealView>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CashWarning() {
  return (
    <div role="alert" className="rounded-lg border border-amber/30 bg-amber-soft p-2.5 flex gap-2">
      <Icon name="alert" size={14} className="text-amber-ink flex-shrink-0 mt-0.5" />
      <p className="text-xs text-amber-ink">
        Cash of ₹20,000 or more for a property deal can attract a penalty equal to the amount (s.269SS / 269ST). Ask your CA.
      </p>
    </div>
  );
}

function DealView({
  sale, receipts, sellerName, accountName, onEdit, onPay, onRegistry, onCancel, onDeletePayment, panel, children,
}: {
  sale: PersonalPropertySale;
  receipts: PersonalPropertySaleReceipt[];
  sellerName: string | null;
  accountName: (id: string | null) => string;
  onEdit: () => void;
  onPay: () => void;
  onRegistry: () => void;
  onCancel: () => void;
  onDeletePayment: (r: PersonalPropertySaleReceipt) => void;
  panel: Panel;
  children: React.ReactNode;
}) {
  const got = receivedTotal(sale.id, receipts);
  const tdsDue = tds194IA(sale.agreed_price, sale.stamp_value);
  const due = balanceDue(sale, receipts);
  const registered = sale.status === "registered";
  const cg = capitalGains({
    acquiredOn: sale.acquired_on,
    transferOn: sale.registry_date ?? istToday(),
    agreedPrice: sale.agreed_price,
    stampValue: sale.stamp_value,
    cost: sale.cost_of_acquisition,
    improvements: sale.improvement_cost,
    transferExpenses: sale.transfer_expenses,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge kind={registered ? "success" : "info"} size="sm">{SALE_STATUS_LABEL[sale.status]}</Badge>
        <span className="text-sm text-ink">Buyer <b>{sale.party}</b></span>
        <span className="text-xs text-ink-3">· agreement {formatDate(sale.agreement_date)}</span>
        {registered && sale.registry_date && <span className="text-xs text-ink-3">· registry {formatDate(sale.registry_date)}</span>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onEdit}>
          <Icon name="edit" size={13} className="mr-1" />Edit details
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Stat title="Agreed price"><Money amount={sale.agreed_price} size="cell" /></Stat>
        <Stat title="Received"><Money amount={got} size="cell" /></Stat>
        <Stat title={registered ? "TDS by buyer" : "TDS 194-IA (1%)"}>
          <Money amount={registered ? sale.tds_deducted : tdsDue} size="cell" />
        </Stat>
        <Stat title="Still to come"><Money amount={due} size="cell" /></Stat>
      </div>
      {!registered && got > 0 && (
        <p className="text-xs text-ink-3">
          Until the registry, the {rupee(got)} received is owed to the buyer — it is counted under &quot;I owe / hold for others&quot; on the Overview.
        </p>
      )}

      <div>
        <p className="text-2xs uppercase tracking-wide text-ink-3 mb-1.5">Payments received</p>
        {receipts.length === 0 ? (
          <p className="text-sm text-ink-3">No payments yet. Start with the byana.</p>
        ) : (
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {receipts.map((r) => (
              <li key={r.id} className="px-3 py-2 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-ink">{RECEIPT_KIND_LABEL[r.kind]}</span>
                    <Badge kind="muted" size="sm">{RECEIPT_MODE_LABEL[r.mode]}</Badge>
                    {isCashWarning(r.mode, r.amount) && <Badge kind="warning" size="sm">Cash ₹20,000+ — ask your CA</Badge>}
                    {r.owe_hold_id && <Badge kind="info" size="sm">From advance</Badge>}
                  </div>
                  <p className="text-xs text-ink-3 mt-0.5">
                    {formatDate(r.received_on)} · {accountName(r.account_id)}{r.note && <> · {r.note}</>}
                  </p>
                </div>
                <Money amount={r.amount} size="cell" />
                <Button size="sm" variant="ghost" className="text-rose" aria-label="Delete payment" onClick={() => onDeletePayment(r)}>
                  <Icon name="trash" size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {panel === null && (
        <div className="flex justify-end gap-2">
          {!registered && <Button variant="outline" className="text-rose" onClick={onCancel}>Cancel sale</Button>}
          {(!registered || due > 0) && <Button variant={registered ? "primary" : "outline"} onClick={onPay}>Add payment</Button>}
          {!registered && <Button variant="primary" onClick={onRegistry}>Record registry</Button>}
        </div>
      )}
      {children}

      <div className="rounded-lg border border-hairline p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-ink">Capital gains — estimate</p>
          <Badge kind="warning" size="sm">Confirm with your CA</Badge>
        </div>
        {sellerName && <p className="text-xs text-ink-2">This gain is <b>{sellerName}</b>&apos;s income — the property is theirs.</p>}
        <Row k={cg.usesStampValue ? "Sale value (stamp-duty value, s.50C)" : "Sale value"} v={cg.fullValue} />
        {cg.usesStampValue && <p className="text-2xs text-ink-3">The stamp-duty value is more than 110% of the agreed price, so tax uses it (s.50C).</p>}
        <Row k="Less brokerage, legal" v={-sale.transfer_expenses} />
        <Row k="Less purchase cost" v={-sale.cost_of_acquisition} />
        {sale.improvement_cost > 0 && <Row k="Less improvements" v={-sale.improvement_cost} />}
        <Row k={cg.gain >= 0 ? "Gain" : "Loss"} v={cg.gain} strong />
        {cg.term === null && <p className="text-xs text-ink-3">Add the purchase date (Edit details) to see short / long term and the tax.</p>}
        {cg.term === "short" && (
          <p className="text-xs text-ink-2">
            Held {cg.months} months (24 or less) — <b>short-term</b>. The gain is added to your income and taxed at your slab rate.
          </p>
        )}
        {cg.term === "long" && cg.newRegime && (
          <>
            <p className="text-xs text-ink-2">Held {cg.months} months (more than 24) — <b>long-term</b>.</p>
            <Row k="Tax at 12.5% without indexation (+4% cess)" v={cg.newRegime.total} />
            {cg.indexed && (
              <Row k={`Tax at 20% with indexation (CII ${cg.indexed.ciiFrom} → ${cg.indexed.ciiTo}; indexed cost ${rupee(cg.indexed.indexedCost)}) (+4% cess)`} v={cg.indexed.total} />
            )}
            {cg.indexedMissing && <p className="text-2xs text-ink-3">20% with indexation: {cg.indexedMissing}</p>}
            {cg.indexed && cg.bestTotal !== null && (
              <p className="text-xs text-ink-2">Bought before 23 Jul 2024: an individual / HUF pays the lower of the two — <b>{rupee(cg.bestTotal)}</b>.</p>
            )}
            <ul className="text-2xs text-ink-3 list-disc pl-4 pt-1">
              {CG_EXEMPTION_NOTES.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </>
        )}
        <p className="text-2xs text-ink-3 pt-1">Surcharge is not included. Estimate only — confirm with your CA before filing.</p>
      </div>
    </div>
  );
}

function Stat({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-hairline p-2.5">
      <p className="text-2xs uppercase tracking-wide text-ink-3">{title}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={`text-xs ${strong ? "font-medium text-ink" : "text-ink-2"}`}>{k}</span>
      <span className={strong ? "font-medium" : ""}><Money amount={v} size="cell" /></span>
    </div>
  );
}
