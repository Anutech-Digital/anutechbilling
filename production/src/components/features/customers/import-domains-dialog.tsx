/**
 * ImportDomainsDialog — link domains to existing customers (customer_domains).
 *
 * A customer can own MANY domains. This loads a CSV of (Customer Number, Domain)
 * — e.g. a Zoho subscription export — and maps each domain to the existing
 * customer with that number. Then the Google "Sync from Google" can link those
 * domains' subscriptions to the right customer instead of creating duplicates.
 *
 * Read-first: a dry-run preview shows link-new / already-mapped / customer-not-found
 * before anything is written. Idempotent — re-running only adds missing maps.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { readAllRows, type ExistingCustomerRow } from "./import-existing";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { cn } from "@/lib/utils";

type Status = "new" | "mapped" | "no_customer";
interface Row {
  customer_number: string;
  domain: string;
  customer_id?: string;
  customer_name?: string;
  status: Status;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onComplete?: () => void;
}

function normDomain(s: string): string {
  return (s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

function parseLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}

export function ImportDomainsDialog({ open, onOpenChange, onComplete }: Props) {
  const { data: me } = useCurrentUser();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [visible, setVisible] = React.useState(60);

  const lookups = React.useRef<{
    byNumber: Map<string, { id: string; name: string }>;
    mapped: Set<string>;
  }>({ byNumber: new Map(), mapped: new Set() });

  React.useEffect(() => {
    if (!open) {
      setRows(null); setFileName(null); setSaving(false); setVisible(60);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    (async () => {
      const supabase = createClient();
      try {
        // R-295: every row, not the first 1000 — else a domain past #1000 links twice.
        const [custs, cdoms] = await Promise.all([
          readAllRows<ExistingCustomerRow>(supabase, "customers", "id, name, customer_number"),
          readAllRows<{ domain: string }>(supabase, "customer_domains", "id, domain"),
        ]);
        const byNumber = new Map<string, { id: string; name: string }>();
        for (const c of custs) if (c.customer_number) byNumber.set(String(c.customer_number).trim().toLowerCase(), { id: c.id, name: c.name });
        const mapped = new Set<string>();
        for (const cd of cdoms) mapped.add(normDomain(cd.domain));
        lookups.current = { byNumber, mapped };
      } catch (e) {
        toastError(e, { description: "Existing customers and domains didn't load, so duplicates can't be checked. Close and reopen." });
      }
    })();
  }, [open]);

  React.useEffect(() => { setVisible(60); }, [rows]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error("File too large (over 8 MB).", {
        description: "Export only the Customer Number and Domain columns, or split the file into smaller parts.",
      });
      return;
    }
    setFileName(file.name);
    try {
      let text = await file.text();
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) {
        toast.error("This CSV has no data rows.", {
          description: "The first row must be the column names and the rows below it the domains. Check you picked the right file.",
        });
        return;
      }
      const header = parseLine(lines[0]).map((h) => h.trim().toLowerCase());
      const iNum = header.findIndex((h) => h.includes("customer number") || h === "customer_number" || h === "customer no");
      const iDom = header.findIndex((h) => h.includes("domain") || h === "website");
      if (iNum === -1) {
        toast.error("Couldn't find a 'Customer Number' column.", {
          description: "Rename the column in the first row to 'Customer Number' and upload the file again.",
        });
        return;
      }
      if (iDom === -1) {
        toast.error("Couldn't find a 'Domain' column.", {
          description: "Rename the column in the first row to 'Domain' and upload the file again.",
        });
        return;
      }

      const { byNumber, mapped } = lookups.current;
      const seen = new Set<string>();
      const parsed: Row[] = [];
      for (let i = 1; i < lines.length; i++) {
        const c = parseLine(lines[i]);
        const customer_number = (c[iNum] ?? "").trim();
        const domain = normDomain(c[iDom] ?? "");
        if (!customer_number || !domain) continue;
        if (seen.has(domain)) continue;     // a domain maps to one customer; first wins
        seen.add(domain);
        const match = byNumber.get(customer_number.toLowerCase());
        let status: Status;
        if (!match) status = "no_customer";
        else if (mapped.has(domain)) status = "mapped";
        else status = "new";
        parsed.push({ customer_number, domain, customer_id: match?.id, customer_name: match?.name, status });
      }
      // Actionable (new) first, then mapped, then no_customer.
      const order: Record<Status, number> = { new: 0, mapped: 1, no_customer: 2 };
      parsed.sort((a, b) => order[a.status] - order[b.status]);
      setRows(parsed);
    } catch (err) {
      toastError(err, {
        fallback: "Couldn't read the file.",
        description: "Save it as CSV (comma separated) from Excel or Google Sheets and upload it again.",
      });
    }
  }

  const counts = React.useMemo(() => {
    const r = rows ?? [];
    return {
      new: r.filter((x) => x.status === "new"),
      mapped: r.filter((x) => x.status === "mapped").length,
      noCustomer: r.filter((x) => x.status === "no_customer").length,
    };
  }, [rows]);

  async function handleApply() {
    if (!rows || !me) return;
    const toAdd = counts.new;
    if (toAdd.length === 0) {
      toast.error("No new domain links to add.", {
        description: "Every domain in the file is already mapped or has no matching customer. Import those customers first.",
      });
      return;
    }
    setSaving(true);
    try {
      const supabase = createClient();
      const payload = toAdd.map((r) => ({ tenant_id: me.tenantId, customer_id: r.customer_id!, domain: r.domain }));
      let added = 0;
      for (let i = 0; i < payload.length; i += 500) {
        const chunk = payload.slice(i, i + 500);
        const { error } = await supabase.from("customer_domains").insert(chunk);
        if (error) throw error;
        added += chunk.length;
      }
      toast.success(`Linked ${added} domain${added === 1 ? "" : "s"} to existing customers. Now run "Sync from Google".`);
      onComplete?.();
      onOpenChange(false);
    } catch (err) {
      toastError(err, {
        fallback: "Couldn't save the domain links.",
        description: "Some links may already be saved. Upload the same file again — saved ones show as already mapped and only the rest are added.",
      });
    } finally {
      setSaving(false);
    }
  }

  const shown = rows?.slice(0, visible) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl overflow-x-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle className="break-words inline-flex items-center gap-2">
            <Icon name="link" size={18} className="text-amber" /> Link domains to customers
          </DialogTitle>
          <DialogDescription className="break-words">
            CSV with <span className="font-mono text-2xs">Customer Number</span> + <span className="font-mono text-2xs">Domain</span> (e.g. a Zoho subscription export).
            Each domain is attached to the customer with that number — a customer can own many domains.
          </DialogDescription>
        </DialogHeader>

        {!rows && (
          <label htmlFor="dom-file" className={cn(
            "block border-2 border-dashed border-hairline-strong rounded-lg p-8 text-center cursor-pointer hover:bg-paper-2/40 transition-colors",
            "focus-within:ring-2 focus-within:ring-amber focus-within:ring-offset-2",
          )}>
            <Icon name="upload" size={26} className="text-ink-3 mx-auto mb-2" />
            <p className="text-sm font-medium text-ink">Choose the CSV</p>
            <p className="text-xs text-ink-3 mt-1">Needs columns: Customer Number + Domain (extra columns ignored)</p>
            <input ref={fileRef} id="dom-file" type="file" accept=".csv,text/csv" onChange={handleFile} className="sr-only" />
          </label>
        )}

        {rows && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm font-semibold text-ink truncate min-w-0">{fileName}</p>
              <Button type="button" variant="ghost" size="sm" icon="x"
                onClick={() => { setRows(null); setFileName(null); if (fileRef.current) fileRef.current.value = ""; }}>
                Choose another file
              </Button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Stat label="Will link (new)" value={String(counts.new.length)} tone="emerald" />
              <Stat label="Already mapped" value={String(counts.mapped)} tone="muted" />
              <Stat label="Customer not found" value={String(counts.noCustomer)} tone="amber" />
            </div>

            <div className="border border-hairline rounded-md overflow-hidden">
              <div className="max-h-[300px] overflow-y-auto overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-paper-2 border-b border-hairline sticky top-0">
                    <tr>
                      <th className="p-2 text-left font-semibold text-ink-3">Domain</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Customer</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.domain} className="border-b border-hairline last:border-0">
                        <td className="p-2 font-mono text-2xs text-ink">{r.domain}</td>
                        <td className="p-2 text-ink-2">{r.customer_name ?? <span className="text-ink-3">{r.customer_number}</span>}</td>
                        <td className="p-2">
                          {r.status === "new" && <Badge kind="success" size="sm">will link</Badge>}
                          {r.status === "mapped" && <Badge kind="muted" size="sm">already mapped</Badge>}
                          {r.status === "no_customer" && <Badge kind="warning" size="sm">no customer</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > visible && (
                <button type="button" onClick={() => setVisible((v) => v + 100)}
                  className="w-full py-2 text-xs font-medium text-amber-ink hover:bg-paper-2/60 border-t border-hairline">
                  Show more ({rows.length - visible} left)
                </button>
              )}
            </div>

            <p className="text-2xs text-ink-3">
              <b>No customer</b> = that Customer Number isn&apos;t in your customers (import that customer first). Only <b>will link</b> rows are written.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          {rows && counts.new.length > 0 && (
            <Button type="button" variant="primary" loading={saving} onClick={handleApply}>
              Link {counts.new.length} domain{counts.new.length === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "emerald" | "amber" | "muted" }) {
  const color = tone === "emerald" ? "text-emerald" : tone === "amber" ? "text-amber-ink" : "text-ink";
  return (
    <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={cn("text-sm font-semibold tabular-nums mt-0.5", color)}>{value}</div>
    </div>
  );
}
