/**
 * BulkDomainsDialog — build ONE quote line that covers MANY domains.
 *
 * A reseller customer bulk-orders a plan (e.g. Google Workspace) on many domains,
 * each with its own seat count. This creates a single "bulk" line (qty = Σ seats,
 * carrying the per-domain breakdown). On payment, record_payment expands it into
 * one subscription per domain — one quote + one invoice for the whole order.
 *
 * Domains come from: a CSV (domain,seats) OR the customer's saved domains
 * (customer_domains). Pricing = one negotiated rate/seat across all domains.
 *
 * R-2712 (Pratik, 16 Oct): "Start date" for every plan and, for a domain plan, "Register for
 * 1–10 years" — a client had paid 3 years of registration and this dialog could only make a
 * 1-year line starting today. The line then carries `start_date` and `years`; its rate is the
 * whole term's price (lib/quotes/bulk.ts buildBulkLine), billed once.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { rupee, cn } from "@/lib/utils";
import { buildBulkLine, dedupeDomains, bulkDomainProblems, isDomainPlan, type DomainSeat } from "@/lib/quotes/bulk";
import { addMonthsIso, isoDateOf, periodDate } from "@/lib/quotes/service-period";
import { catalogYearlyPrice } from "@/lib/quotes/catalog-line";
import { istToday } from "@/lib/dates/ist";
import type { Item, QuoteLineItem } from "@/lib/supabase/database.types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  catalog: Item[] | undefined;
  /** Selected customer (enables "pick from saved domains"). Empty in prospect mode. */
  customerId: string;
  onAdd: (line: QuoteLineItem) => void;
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

export function BulkDomainsDialog({ open, onOpenChange, catalog, customerId, onAdd }: Props) {
  const [itemId, setItemId] = React.useState("");
  const [rate, setRate] = React.useState(0);          // ₹/seat/year
  const [years, setYears] = React.useState(1);        // R-2712: "Register for" — domain plans only
  const [startDate, setStartDate] = React.useState(() => istToday());   // R-2712
  const [tab, setTab] = React.useState<"manual" | "csv" | "pick">("manual");
  const [manual, setManual] = React.useState<DomainSeat[]>([{ domain: "", seats: 1 }]);
  const [csvName, setCsvName] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<Array<{ domain: string; seats: number; on: boolean }>>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) {
      setItemId(""); setRate(0); setTab("manual"); setManual([{ domain: "", seats: 1 }]);
      setYears(1); setStartDate(istToday());
      setCsvName(null); setSaved([]);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (!customerId) return;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.from("customer_domains").select("domain").eq("customer_id", customerId);
      setSaved((data ?? []).map((d) => ({ domain: d.domain, seats: 1, on: true })));
    })();
  }, [open, customerId]);

  const item = catalog?.find((i) => i.id === itemId);
  /* R-2712: years only for a domain plan (the normal line's rule, R-1445) — a Workspace plan
     chosen after picking 3 years is a 1-year line, whatever the hidden picker still holds. */
  const domainPlan = isDomainPlan(item);
  const termYears = domainPlan ? years : 1;

  function pickItem(id: string) {
    setItemId(id);
    const it = catalog?.find((i) => i.id === id);
    /* R-2712: the catalogue row's own billing unit decides the yearly figure (R-526,
       catalogYearlyPrice — the one way every adder prices). This dialog multiplied every price by
       12, so a per-YEAR domain item at ₹800 came in at ₹9,600 a year. */
    if (it) setRate(Math.round(catalogYearlyPrice(it).rate)); // ₹/seat/year (annual list)
  }

  async function handleCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error("File too large (over 8 MB).", {
        description: "Keep only the domain and seats columns, or split the file into smaller parts.",
      });
      return;
    }
    setCsvName(file.name);
    try {
      let text = await file.text();
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length === 0) {
        toast.error("The file is empty.", {
          description: "Check you picked the right file, or type the domains under Type domains.",
        });
        return;
      }

      const first = parseLine(lines[0]).map((h) => h.trim().toLowerCase());
      const findDom  = (hs: string[]) => hs.findIndex((h) => h.includes("domain") || h === "website" || h === "url");
      const findSeat = (hs: string[]) => hs.findIndex((h) => h.includes("seat") || h === "qty" || h.includes("licen") || h.includes("quantity") || h.includes("user"));

      // Is row 0 a header (has keyword columns) or already data? A non-technical
      // user's CSV often has no header at all — handle both.
      const hasHeader = findDom(first) !== -1 || findSeat(first) !== -1;
      let iDom: number, iSeat: number, dataLines: string[];
      if (hasHeader) {
        iDom = findDom(first); iSeat = findSeat(first);
        if (iDom === -1) iDom = 0;                 // header present but no domain col → first col
        dataLines = lines.slice(1);
      } else {
        iDom = 0; iSeat = first.length > 1 ? 1 : -1; // no header → col0=domain, col1=seats
        dataLines = lines;
      }

      const seatsMissing = iSeat === -1;
      const rows = dataLines.map((l) => {
        const c = parseLine(l);
        const n = iSeat >= 0 ? Math.floor(Number(String(c[iSeat] ?? "").trim())) : 0;
        return { domain: c[iDom] ?? "", seats: n > 0 ? n : 1 };
      });
      const clean = dedupeDomains(rows);
      if (clean.length === 0) {
        toast.error("No domains found in the file.", {
          description: "Put one domain per row in the first column (e.g. example.com), seats in the second.",
        });
        return;
      }

      // Load into the editable list so seats are always VISIBLE and correctable —
      // never a silent 1-per-domain default that surprises the user later.
      setManual(clean);
      setTab("manual");
      if (seatsMissing) {
        toast.warning(`Loaded ${clean.length} domains — no seat column found, so each is 1. Review the seats below.`);
      } else {
        toast.success(`Loaded ${clean.length} domains from ${file.name} — review the seats below.`);
      }
    } catch (err) {
      toastError(err, {
        fallback: "Couldn't read the file.",
        description: "Save it as CSV (comma separated) from Excel or Google Sheets and upload it again.",
      });
    }
  }

  // The domains the bulk line will use, from the active tab.
  const domains: DomainSeat[] = React.useMemo(() => {
    // CSV upload loads into `manual`, so both share one source of truth.
    if (tab === "pick") return dedupeDomains(saved.filter((s) => s.on).map((s) => ({ domain: s.domain, seats: s.seats })));
    return dedupeDomains(manual.filter((m) => m.domain.trim().length > 0));
  }, [tab, manual, saved]);

  const totalSeats = domains.reduce((s, d) => s + d.seats, 0);
  const lineNet = rate * totalSeats * termYears; // ex-GST, the whole term (R-2712); GST added at quote level
  /* R-2712: the day each subscription comes up for renewal — start + the years paid for. A
     cleared date means today: the builder dates a line with no start today when it is added. */
  const startIso = isoDateOf(startDate) ?? istToday();
  const renewsOn = addMonthsIso(startIso, 12 * termYears);

  function handleAdd() {
    if (!item) {
      toast.error("Pick a plan first.", {
        description: "Choose the plan in the Plan box at the top — it sets the rate per seat.",
      });
      return;
    }
    if (rate <= 0) {
      toast.error("Enter a rate per seat.", {
        description: "Type the yearly price per seat in the Rate box, before GST.",
      });
      return;
    }
    if (tab !== "pick") {
      const bad = bulkDomainProblems(manual);
      if (bad.invalid.length > 0) {
        toast.error(`"${bad.invalid[0]}" is not a domain`, {
          description: "Type it like example.com — no spaces.",
        });
        return;
      }
      if (bad.duplicates.length > 0) {
        toast.error(`${bad.duplicates[0]} is entered twice`, {
          description: "Keep one row for it and put all its seats there.",
        });
        return;
      }
    }
    if (domains.length === 0 || totalSeats <= 0) {
      toast.error("Add domains with seats first.", {
        description: "Type at least one domain with 1 or more seats, or upload a CSV.",
      });
      return;
    }
    const line = buildBulkLine(
      { id: crypto.randomUUID(), item_id: item.id, name: item.name, cost: Math.round(catalogYearlyPrice(item).cost) },
      rate,
      domains,
      "annual_yearly",
      { years: termYears, startDate: startIso },
    );
    onAdd(line);
    toast.success(`Added bulk line — ${domains.length} domains, ${totalSeats} seats${termYears > 1 ? `, ${termYears} years` : ""}`);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl overflow-x-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle className="inline-flex items-center gap-2">
            <Icon name="layers" size={18} className="text-amber" /> Bulk order — many domains
          </DialogTitle>
          <DialogDescription className="break-words">
            One quote line covering many domains. On payment it becomes one subscription per domain — one quote + one invoice for the whole order.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Plan + rate */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="bulk-plan" className="block text-xs font-medium text-ink-2 mb-1">Plan</label>
              <select id="bulk-plan" value={itemId} onChange={(e) => pickItem(e.target.value)}
                className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber">
                <option value="">Choose a plan…</option>
                {(catalog ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="bulk-rate" className="block text-xs font-medium text-ink-2 mb-1">Rate (₹/seat/year)</label>
              <Input id="bulk-rate" type="number" prefix="₹" value={rate || ""} onChange={(e) => setRate(Math.max(0, Number(e.target.value) || 0))} />
            </div>
            {/* R-2712: when the subscriptions start, and (domain plans) how many years are paid now. */}
            <div>
              <label htmlFor="bulk-start" className="block text-xs font-medium text-ink-2 mb-1">Start date</label>
              <Input id="bulk-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            {domainPlan && (
              <div>
                <label htmlFor="bulk-years" className="block text-xs font-medium text-ink-2 mb-1">Register for</label>
                <select id="bulk-years" value={years} onChange={(e) => setYears(Number(e.target.value))}
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((y) => <option key={y} value={y}>{y} year{y === 1 ? "" : "s"}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 border-b border-hairline">
            <TabBtn active={tab === "manual"} onClick={() => setTab("manual")}>Type domains</TabBtn>
            <TabBtn active={tab === "csv"} onClick={() => setTab("csv")}>Upload CSV</TabBtn>
            <TabBtn active={tab === "pick"} onClick={() => setTab("pick")} disabled={!customerId}>
              Customer&apos;s domains{customerId ? "" : " (select customer first)"}
            </TabBtn>
          </div>

          {tab === "manual" && (
            <div className="space-y-2">
              <div className="max-h-[240px] overflow-y-auto rounded-md border border-hairline divide-y divide-hairline">
                {manual.map((row, idx) => (
                  <div key={idx} className="flex items-center gap-2 px-2 py-1.5">
                    <Input
                      className="flex-1 h-8 text-sm font-mono"
                      aria-label={`Domain ${idx + 1}`}
                      placeholder="e.g. domain.in"
                      value={row.domain}
                      onChange={(e) => setManual((arr) => arr.map((x, i) => i === idx ? { ...x, domain: e.target.value } : x))}
                    />
                    <Input
                      type="number" min={1}
                      aria-label="Seats for this domain"
                      className="w-20 h-8 text-sm tabular-nums"
                      value={row.seats}
                      onChange={(e) => setManual((arr) => arr.map((x, i) => i === idx ? { ...x, seats: Math.max(0, Number(e.target.value) || 0) } : x))}
                    />
                    <span className="text-3xs text-ink-3 w-8 shrink-0">seats</span>
                    <button
                      type="button" aria-label="Remove domain"
                      onClick={() => setManual((arr) => arr.length > 1 ? arr.filter((_, i) => i !== idx) : [{ domain: "", seats: 1 }])}
                      className="text-ink-3 hover:text-rose p-1 shrink-0"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <Button type="button" size="sm" variant="default" icon="plus"
                onClick={() => setManual((arr) => [...arr, { domain: "", seats: 1 }])}>
                Add domain
              </Button>
              <p className="text-2xs text-ink-3">
                Each domain has its own seat count — that seat count is what carries to its subscription on payment.
              </p>
            </div>
          )}

          {tab === "csv" && (
            <div className="space-y-2">
              <label htmlFor="bulk-csv" className={cn(
                "block border-2 border-dashed border-hairline-strong rounded-lg p-6 text-center cursor-pointer hover:bg-paper-2/40 transition-colors",
              )}>
                <Icon name="upload" size={22} className="text-ink-3 mx-auto mb-1" />
                <p className="text-sm font-medium text-ink">{csvName ?? "Choose CSV (domain, seats)"}</p>
                <p className="text-2xs text-ink-3 mt-0.5">Two columns: <b>domain</b>, <b>seats</b>. We load them into the list so you can review before adding.</p>
                <input ref={fileRef} id="bulk-csv" type="file" accept=".csv,text/csv" onChange={handleCsv} className="sr-only" />
              </label>
            </div>
          )}

          {tab === "pick" && (
            <div className="border border-hairline rounded-md max-h-[240px] overflow-y-auto">
              {saved.length === 0 ? (
                <p className="p-4 text-xs text-ink-3">No saved domains for this customer. Use "Link domains" on the Customers page, or upload a CSV.</p>
              ) : saved.map((s, idx) => (
                <div key={s.domain} className="flex items-center gap-2 px-3 py-1.5 border-b border-hairline last:border-0">
                  <input type="checkbox" aria-label={`Include ${s.domain}`} className="accent-amber" checked={s.on}
                    onChange={(e) => setSaved((arr) => arr.map((x, i) => i === idx ? { ...x, on: e.target.checked } : x))} />
                  <span className="font-mono text-2xs text-ink flex-1 truncate">{s.domain}</span>
                  <Input type="number" aria-label={`Seats for ${s.domain}`} className="w-20 h-7 text-xs" value={s.seats}
                    onChange={(e) => setSaved((arr) => arr.map((x, i) => i === idx ? { ...x, seats: Math.max(0, Number(e.target.value) || 0) } : x))} />
                  <span className="text-3xs text-ink-3">seats</span>
                </div>
              ))}
            </div>
          )}

          {/* Summary */}
          <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2 text-sm" data-testid="bulk-summary">
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-2"><b>{domains.length}</b> domains · <b>{totalSeats}</b> seats</span>
              <span className="font-semibold tabular-nums">{rupee(lineNet)} <span className="text-ink-3 font-normal text-xs">{termYears > 1 ? `for ${termYears} years, billed once (ex-GST)` : "/yr (ex-GST)"}</span></span>
            </div>
            {/* R-2712: one fact, said once — when each subscription starts and comes up for renewal. */}
            <p className="mt-0.5 text-2xs text-ink-3">
              Each subscription starts {periodDate(startIso)} and renews {periodDate(renewsOn)}.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" disabled={!item || rate <= 0 || totalSeats <= 0} onClick={handleAdd}>
            Add bulk line ({domains.length})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TabBtn({ active, onClick, disabled, children }: { active: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={cn(
        "px-3 py-2 text-xs font-medium -mb-px border-b-2 transition-colors",
        active ? "border-amber text-ink" : "border-transparent text-ink-3 hover:text-ink",
        disabled && "opacity-40 cursor-not-allowed",
      )}>
      {children}
    </button>
  );
}
