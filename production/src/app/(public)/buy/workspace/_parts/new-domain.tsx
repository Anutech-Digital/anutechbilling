"use client";
/**
 * R-1977 (Pardeep, 26 Oct 2026): "I need a new domain" is a real booking. The buyer types a
 * name and an ending, presses Check, and sees LIVE availability and the 1-year price for it and a
 * few other endings (the site's own search — site/lib/domain-search.ts → /api/domains/availability
 * → lib/domains/live-lookup.ts). Choosing one puts it in the order; the checkout route prices it
 * again on the server and never reads the price shown here. When the registry can't be reached
 * the box says so and offers a way on — never a guessed "available" or price.
 */
import * as React from "react";
import { rupee } from "@/lib/utils";
import { searchDomains, domainHelpLinks, TEST_PRICE_LABEL, type DomainResult } from "@/site/lib/domain-search";
import { NEW_DOMAIN_TLDS, newDomainName, type DomainChoice, type NewDomainTld } from "./checkout-form";

/** The endings checked with every search: the three offered first, then two common ones. */
export const SEARCH_TLDS = ["in", "com", "co.in", "org", "net"] as const;

type Search =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; rows: DomainResult[] }
  | { status: "error"; message: string };

const input = (bad?: string) =>
  `w-full h-12 px-3.5 text-base border rounded-[10px] bg-paper focus:outline-none focus-visible:ring-2 focus-visible:ring-amber ${bad ? "border-rose" : "border-hairline"}`;

/** The searched name first (the ending the buyer picked), then the other endings, available first. */
export function orderRows(rows: readonly DomainResult[], wanted: string): DomainResult[] {
  const first = rows.filter((r) => r.domain === wanted);
  const rest = rows.filter((r) => r.domain !== wanted).sort((a, b) => Number(b.available && b.priceKnown) - Number(a.available && a.priceKnown));
  return [...first, ...rest];
}

export function NewDomainSearch({
  value, onChange, error, onClearError, billsWithOrder,
}: {
  value: DomainChoice;
  onChange: (d: DomainChoice) => void;
  error?: string;
  onClearError: () => void;
  /** The domain is bought with THIS order (annual, paying) — otherwise it is billed separately. */
  billsWithOrder: boolean;
}) {
  const [search, setSearch] = React.useState<Search>({ status: "idle" });
  const name = newDomainName(value);
  const wanted = name ? `${name}${value.tld}` : "";

  async function check() {
    onClearError();
    if (name.length < 2) { onChange({ ...value, picked: null }); setSearch({ status: "idle" }); return; }
    setSearch({ status: "checking" });
    const out = await searchDomains(name, SEARCH_TLDS);
    if (!out.ok) { setSearch({ status: "error", message: out.message }); return; }
    const rows = orderRows(out.domains, wanted);
    setSearch({ status: "done", rows });
    /* The name asked for, when free with a known price, is chosen at once — one press, not two. */
    const hit = rows.find((r) => r.domain === wanted && r.available && r.priceKnown && r.price > 0);
    onChange({ ...value, picked: hit ? { domain: hit.domain, price: Math.round(hit.price), testPrice: hit.testPrice === true } : null });
  }

  const edit = (patch: Partial<DomainChoice>) => { onChange({ ...value, ...patch, picked: null }); setSearch({ status: "idle" }); onClearError(); };
  const help = domainHelpLinks(wanted || name);

  return (
    <>
      <label htmlFor="buy-newdomain" className="block text-[13px] font-semibold text-ink-2 mb-1.5">The domain you want</label>
      <div className="flex gap-2 flex-wrap">
        <input id="buy-newdomain" value={value.newName} placeholder="yourcompany" autoComplete="off" aria-invalid={!!error} aria-describedby="buy-newdomain-err"
          onChange={(e) => edit({ newName: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void check(); } }}
          className={`${input(error)} flex-[1_1_180px] w-auto min-w-0 font-mono`} />
        <label htmlFor="buy-tld" className="sr-only">Domain ending</label>
        <select id="buy-tld" value={value.tld} onChange={(e) => edit({ tld: e.target.value as NewDomainTld })}
          className="h-12 px-3 text-[15px] border border-hairline rounded-[10px] bg-paper">
          {NEW_DOMAIN_TLDS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button type="button" onClick={() => void check()} aria-busy={search.status === "checking"}
          className="h-12 px-5 rounded-[10px] bg-ink text-paper text-[15px] font-semibold hover:bg-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">
          {search.status === "checking" ? "Checking…" : "Check"}
        </button>
      </div>
      <div id="buy-newdomain-err" className="text-[13px] text-rose min-h-5 mt-1">{error ?? ""}</div>

      {search.status === "error" && (
        <p role="alert" className="text-sm text-ink-2 px-3.5 py-3 border border-hairline rounded-[10px] bg-white mb-3">
          {search.message}{" "}
          <a href={help.whatsappHref} target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">WhatsApp us</a>
          {" "}or choose &quot;I already have a domain&quot;.
        </p>
      )}

      {search.status === "done" && (
        <div role="radiogroup" aria-label="Available domains" className="flex flex-col gap-2 mb-3" data-testid="domain-results">
          {search.rows.length === 0 && <p className="text-sm text-ink-2 m-0">No result for that name — try another.</p>}
          {search.rows.map((r) => {
            const free = r.available && r.priceKnown && r.price > 0;
            const on = value.picked?.domain === r.domain;
            return (
              <div key={r.domain} className={`flex items-center gap-3 px-3.5 py-2.5 rounded-[10px] border ${on ? "border-amber bg-amber-soft" : "border-hairline bg-white"}`}>
                <span className="font-mono text-[15px] text-ink flex-1 min-w-0 break-all">{r.domain}</span>
                {free ? (
                  <>
                    <span className="text-sm text-ink-2 whitespace-nowrap">
                      {rupee(Math.round(r.price))}/yr{r.testPrice ? <span className="ml-1 text-xs text-amber-ink">({TEST_PRICE_LABEL})</span> : null}
                    </span>
                    <button type="button" role="radio" aria-checked={on} aria-label={`Choose ${r.domain}`}
                      onClick={() => { onClearError(); onChange({ ...value, picked: { domain: r.domain, price: Math.round(r.price), testPrice: r.testPrice === true } }); }}
                      className={`min-h-11 px-3 rounded-lg text-sm font-semibold ${on ? "text-emerald" : "text-amber-ink underline underline-offset-[3px]"}`}>
                      {on ? "✓ Chosen" : "Choose"}
                    </button>
                  </>
                ) : (
                  <span className="text-sm text-ink-3 whitespace-nowrap">{r.available ? "Price not confirmed" : "Taken"}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[13px] text-ink-3 leading-relaxed m-0">
        {billsWithOrder
          ? "Registered in your name after payment, for 1 year — price plus GST is in your order. We confirm by email when it is live."
          : "We register it in your name and bill it separately — we confirm the name and price with you first."}
      </p>
    </>
  );
}
