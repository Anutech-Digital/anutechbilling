"use client";

/**
 * Make the missing customer + Google subscription straight from Google's bill (R-164, 5 Oct 2026,
 * Pardeep: "customer nahi hai to customer add karne ka option bhi hona chahiye aur sabki
 * subscription banaye aur google ke cost price ko handle kare").
 *
 * One domain: AddFromBillDialog — new customer or an existing one (a customer whose domain is
 * spelt differently is LINKED, not duplicated), plan, users, selling price. Google's cost for the
 * month is spread over the users into vendor_cost_per_seat_month (lib/reconcile/google-bill.ts).
 *
 * All missing at once: createFromBill — a customer named after each domain and a subscription.
 * R-320: the edition and users come from the bill line when it names them (Google's invoice CSV)
 * and the price from the tenant catalogue's list price for that edition (draftFromBill). The PDF
 * names neither, and a missing catalogue row has no price — those are never guessed and come back
 * as "Set price & users".
 */
import * as React from "react";
import { toast } from "sonner";
import { NEEDS_INPUT_CLASS } from "@/lib/ai/test-trail";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/label";
import { GstStateSelect, EXPORT_STATE } from "@/components/shared/gst-state-select";
import { GST_STATE_BY_CODE, rupee } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { GOOGLE_PLANS, catalogPriceForEdition, draftFromBill, newSubscriptionRow, nameFromDomain, type BillCatalogRow, type CheckRow, type CustomerLite } from "@/lib/reconcile/google-bill";

export interface BillItem {
  domain: string;
  googleCost: number;
  /** existing customer to attach to; omitted = create one */
  customerId?: string;
  customerName: string;
  plan: string;
  users: number;
  sellPerUserMonth: number | null;
  /** R-320: the catalogue row the price came from. */
  itemId?: string | null;
  /** R-174: new customer's GST state code (or "export"); omitted = not known — the customer then
   *  shows in Customers → "State missing" until someone picks it. */
  stateCode?: string;
}

/** Inserts customers (where needed) then subscriptions. Returns how many of each. */
export async function createFromBill(tenantId: string, items: readonly BillItem[]): Promise<{ customers: number; subscriptions: number }> {
  if (!tenantId) throw new Error("Your workspace is still loading — try again in a moment.");
  const supabase = createClient();
  const idByDomain = new Map<string, string>();
  const toCreate = items.filter((i) => !i.customerId);
  for (let k = 0; k < toCreate.length; k += 200) {
    const chunk = toCreate.slice(k, k + 200).map((i) => ({
      tenant_id: tenantId, name: i.customerName.trim() || nameFromDomain(i.domain), domain: i.domain,
      ...(i.stateCode === EXPORT_STATE ? { country: "Outside India" }
        : i.stateCode ? { state_code: i.stateCode, state: GST_STATE_BY_CODE[i.stateCode] ?? null } : {}),
    }));
    const { data, error } = await supabase.from("customers").insert(chunk).select("id, domain");
    if (error) throw new Error(`Customers not created: ${error.message}`);
    for (const c of data ?? []) if (c.domain) idByDomain.set(c.domain, c.id);
  }
  const syncedAt = new Date().toISOString();
  const subs = items.map((i) => newSubscriptionRow({
    tenantId, customerId: i.customerId ?? idByDomain.get(i.domain) ?? "", customerName: i.customerName.trim() || nameFromDomain(i.domain),
    domain: i.domain, plan: i.plan, users: i.users, sellPerUserMonth: i.sellPerUserMonth, googleCostMonth: i.googleCost, syncedAt, itemId: i.itemId ?? null,
  }));
  if (subs.some((s) => !s.customer_id)) throw new Error("A customer could not be matched to its subscription — nothing more was added. Refresh and try again.");
  for (let k = 0; k < subs.length; k += 200) {
    const { error } = await supabase.from("subscriptions").insert(subs.slice(k, k + 200));
    if (error) throw new Error(`Subscriptions not created (customers were): ${error.message}`);
  }
  return { customers: toCreate.length, subscriptions: subs.length };
}

/** Whole figures stay whole; a paise figure shows its 2 decimals. */
const inr = (n: number) => rupee(n, { decimals: Number.isInteger(n) ? 0 : 2 });

export function AddFromBillDialog({ row, customers, catalog, tenantId, onClose, onDone }: {
  row: CheckRow; customers: readonly CustomerLite[]; catalog: readonly BillCatalogRow[]; tenantId: string; onClose: () => void; onDone: () => void;
}) {
  const draft = React.useMemo(() => draftFromBill(row, catalog), [row, catalog]);
  const existingRef = row.status === "no_subscription" ? row.customerRef : null;
  const [mode, setMode] = React.useState<"new" | "existing">(existingRef ? "existing" : "new");
  const [name, setName] = React.useState(nameFromDomain(row.domain));
  const [pick, setPick] = React.useState(existingRef ? row.customerName ?? "" : "");
  // R-320: edition + users from the bill when it names them; price from the catalogue for that edition.
  const [plan, setPlan] = React.useState<string>(draft.editionUnknown ? GOOGLE_PLANS[0] : draft.plan);
  const [users, setUsers] = React.useState(String(draft.users));
  const [price, setPrice] = React.useState(draft.sellPerUserMonth ? String(draft.sellPerUserMonth) : "");
  /** Typed by hand → a plan change no longer overwrites it with the catalogue price. */
  const [priceTyped, setPriceTyped] = React.useState(false);
  const catalogPrice = React.useMemo(() => catalogPriceForEdition(plan, catalog), [plan, catalog]);
  function changePlan(p: string) {
    setPlan(p);
    if (!priceTyped) {
      const cp = catalogPriceForEdition(p, catalog);
      setPrice(cp ? String(cp.perSeatPm) : "");
    }
  }
  const [saving, setSaving] = React.useState(false);
  const [stateCode, setStateCode] = React.useState("");

  const byName = React.useMemo(() => new Map(customers.map((c) => [c.name.trim().toLowerCase(), c])), [customers]);
  const picked = existingRef ? { id: existingRef } : byName.get(pick.trim().toLowerCase()) ?? null;
  const u = Math.max(1, Math.round(Number(users) || 0));
  const sell = Number(price) > 0 ? Number(price) : null;
  const costPerUser = row.googleCost / u;
  const monthly = sell ? sell * u : 0;

  async function save() {
    if (mode === "existing" && !picked) {
      toast.error("Pick a customer from the list.", { description: "Type a few letters and choose a name that appears — or switch to New customer." });
      return;
    }
    if (mode === "new" && !stateCode) {
      toast.error("Choose the customer's state", { className: NEEDS_INPUT_CLASS, description: "The GST invoice needs it — it decides CGST + SGST or IGST. Pick \"Outside India\" for a foreign customer." });
      return;
    }
    setSaving(true);
    try {
      await createFromBill(tenantId, [{
        domain: row.domain, googleCost: row.googleCost,
        customerId: mode === "existing" ? picked!.id : undefined,
        customerName: mode === "existing" ? (existingRef ? row.customerName ?? name : pick) : name,
        plan, users: u, sellPerUserMonth: sell,
        itemId: catalogPrice && sell === catalogPrice.perSeatPm ? catalogPrice.itemId : null,
        stateCode: mode === "new" ? stateCode : undefined,
      }]);
      toast.success(`${row.domain}: ${mode === "new" ? "customer and " : ""}subscription added`);
      onDone();
      onClose();
    } catch (e) {
      toast.error((e as Error).message, { description: "Nothing else was changed. Fix it and press Add again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add {row.domain}</DialogTitle>
          <DialogDescription>Google charged {inr(row.googleCost)} for this domain this month. Make the customer and the subscription you bill.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!existingRef && (
            <div className="flex gap-2 text-sm">
              <Button size="sm" variant={mode === "new" ? "primary" : "outline"} onClick={() => setMode("new")}>New customer</Button>
              <Button size="sm" variant={mode === "existing" ? "primary" : "outline"} onClick={() => setMode("existing")}>Existing customer</Button>
            </div>
          )}
          {mode === "new" ? (
            <FormField label="Customer name" htmlFor="afb-name">
              <input id="afb-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm" />
              <div className="mt-2">
                <GstStateSelect id="afb-state" value={stateCode} onChange={setStateCode} allowExport />
              </div>
            </FormField>
          ) : existingRef ? (
            <div className="text-sm">Customer: <b>{row.customerName}</b></div>
          ) : (
            <FormField label="Customer" htmlFor="afb-pick" hint={pick && !picked ? "Pick a name from the list" : "The domain on the bill is added to this customer's subscription"}>
              <input id="afb-pick" list="afb-customers" value={pick} onChange={(e) => setPick(e.target.value)} placeholder="Type to search…" className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm" />
              <datalist id="afb-customers">{customers.slice(0, 2000).map((c) => <option key={c.id} value={c.name} />)}</datalist>
            </FormField>
          )}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Plan" htmlFor="afb-plan">
              <select id="afb-plan" value={plan} onChange={(e) => changePlan(e.target.value)} className="w-full rounded-md border border-hairline bg-paper px-2 py-2 text-sm">
                {GOOGLE_PLANS.map((p) => <option key={p}>{p}</option>)}
              </select>
            </FormField>
            <FormField label="Users" htmlFor="afb-users">
              <input id="afb-users" value={users} onChange={(e) => setUsers(e.target.value)} inputMode="numeric" className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm" />
            </FormField>
          </div>
          {!draft.editionUnknown && (
            <p className="text-2xs text-ink-3">From Google&apos;s bill: {draft.plan}{row.billSeats ? `, ${row.billSeats} user${row.billSeats === 1 ? "" : "s"}` : ""}.</p>
          )}
          <FormField label="Your price per user per month (₹, before GST)" htmlFor="afb-price"
            hint={catalogPrice
              ? (sell === catalogPrice.perSeatPm ? "Your catalogue list price for this plan" : `Catalogue list price is ${inr(catalogPrice.perSeatPm)}`)
              : plan === "Google Workspace"
                ? "Pick the edition to use your catalogue price — or leave empty: it will show as 'Set price & users'"
                : `No catalogue price for ${plan} — add it in Catalog or type your price. Empty shows as 'Set price & users'`}>
            <input id="afb-price" value={price} onChange={(e) => { setPrice(e.target.value); setPriceTyped(true); }} inputMode="decimal" placeholder="e.g. 270" className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm" />
          </FormField>
          <div className="rounded-lg bg-paper-2 p-3 text-xs text-ink-2 space-y-0.5">
            <div>Google cost: {inr(row.googleCost)} ÷ {u} user{u > 1 ? "s" : ""} = <b>{inr(Math.round(costPerUser))}</b> per user / month (saved as cost price)</div>
            <div>You bill: <b>{sell ? inr(monthly) : "not set"}</b> per month{sell ? <> · margin <b className={monthly - row.googleCost < 0 ? "text-rose" : "text-emerald"}>{inr(monthly - row.googleCost)}</b></> : null}</div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>Add</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
