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
 * All missing at once: createFromBill — a customer named after each domain and a subscription
 * with 1 user and NO price. Price and users are not on the PDF and are never guessed: those rows
 * come back as "Set price & users".
 */
import * as React from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/label";
import { GstStateSelect, EXPORT_STATE } from "@/components/shared/gst-state-select";
import { GST_STATE_BY_CODE } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { GOOGLE_PLANS, newSubscriptionRow, nameFromDomain, type CheckRow, type CustomerLite } from "@/lib/reconcile/google-bill";

export interface BillItem {
  domain: string;
  googleCost: number;
  /** existing customer to attach to; omitted = create one */
  customerId?: string;
  customerName: string;
  plan: string;
  users: number;
  sellPerUserMonth: number | null;
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
    domain: i.domain, plan: i.plan, users: i.users, sellPerUserMonth: i.sellPerUserMonth, googleCostMonth: i.googleCost, syncedAt,
  }));
  if (subs.some((s) => !s.customer_id)) throw new Error("A customer could not be matched to its subscription — nothing more was added. Refresh and try again.");
  for (let k = 0; k < subs.length; k += 200) {
    const { error } = await supabase.from("subscriptions").insert(subs.slice(k, k + 200));
    if (error) throw new Error(`Subscriptions not created (customers were): ${error.message}`);
  }
  return { customers: toCreate.length, subscriptions: subs.length };
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function AddFromBillDialog({ row, customers, tenantId, onClose, onDone }: {
  row: CheckRow; customers: readonly CustomerLite[]; tenantId: string; onClose: () => void; onDone: () => void;
}) {
  const existingRef = row.status === "no_subscription" ? row.customerRef : null;
  const [mode, setMode] = React.useState<"new" | "existing">(existingRef ? "existing" : "new");
  const [name, setName] = React.useState(nameFromDomain(row.domain));
  const [pick, setPick] = React.useState(existingRef ? row.customerName ?? "" : "");
  const [plan, setPlan] = React.useState<string>(GOOGLE_PLANS[0]);
  const [users, setUsers] = React.useState("1");
  const [price, setPrice] = React.useState("");
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
      toast.error("Choose the customer's state", { description: "The GST invoice needs it — it decides CGST + SGST or IGST. Pick \"Outside India\" for a foreign customer." });
      return;
    }
    setSaving(true);
    try {
      await createFromBill(tenantId, [{
        domain: row.domain, googleCost: row.googleCost,
        customerId: mode === "existing" ? picked!.id : undefined,
        customerName: mode === "existing" ? (existingRef ? row.customerName ?? name : pick) : name,
        plan, users: u, sellPerUserMonth: sell,
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
              <select id="afb-plan" value={plan} onChange={(e) => setPlan(e.target.value)} className="w-full rounded-md border border-hairline bg-paper px-2 py-2 text-sm">
                {GOOGLE_PLANS.map((p) => <option key={p}>{p}</option>)}
              </select>
            </FormField>
            <FormField label="Users" htmlFor="afb-users">
              <input id="afb-users" value={users} onChange={(e) => setUsers(e.target.value)} inputMode="numeric" className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm" />
            </FormField>
          </div>
          <FormField label="Your price per user per month (₹, before GST)" htmlFor="afb-price" hint="Leave empty if not known — it will show as 'Set price & users'">
            <input id="afb-price" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="e.g. 270" className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm" />
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
