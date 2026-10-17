"use client";
/**
 * The always-on domain search — Pardeep, 2 Sep 2026: "domain search Anutech
 * Digital ke home page par ek tool ki tarah hamesha visible ho, taki visitor
 * kabhi domain search karna chahe to kar sake."
 *
 * It sits under the sticky header at EVERY scroll position, so the tool is
 * always within reach. It replaced the hero's big search card outright (Pardeep:
 * "yaha se search wala section hi hata do") — once the bar never leaves the
 * screen, a second copy in the hero was the same tool twice.
 *
 * It shares one lookup with the hero (site/lib/domain-search) — two copies of an
 * availability-and-price call is how the two drift apart, and only one of them
 * gets fixed. Results drop below the bar; an unreachable platform says so rather
 * than guessing.
 */
import * as React from "react";
import Link from "@/site/components/ui/SiteLink";
import { useCart } from "@/site/components/cart/CartProvider";
import { rupee } from "@/site/lib/money";
import { searchDomains, normaliseName, domainHelpLinks, type DomainResult } from "@/site/lib/domain-search";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; base: string; domains: DomainResult[] }
  | { kind: "error"; message: string };

export function DomainSearchDock() {
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<State>({ kind: "idle" });
  const [open, setOpen] = React.useState(false);
  /* The name the last search actually ran on — the error's recovery actions name
     it, and the input may have been edited since. */
  const [lastTried, setLastTried] = React.useState("");
  const reqId = React.useRef(0);
  const cart = useCart();

  /* Clicking anywhere else closes the results panel — it is a dropdown over the
     page, not a section of it. */
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function runSearch() {
    const base = normaliseName(query);
    if (!base) {
      setState({ kind: "error", message: "Type a name to check." });
      setOpen(true);
      return;
    }
    const mine = ++reqId.current;
    setLastTried(base);
    setState({ kind: "loading" });
    setOpen(true);
    const out = await searchDomains(base);
    if (mine !== reqId.current) return;
    setState(out.ok
      ? { kind: "done", base: out.base, domains: out.domains }
      : { kind: "error", message: out.message });
  }

  const add = (r: DomainResult) => {
    cart.add({
      /* sku + domain: the checkout re-prices this exact name live and registers
         it. Without them every search result was refused at payment. */
      sku: `domain:${r.domain.slice(r.domain.indexOf(".") + 1)}`,
      domain: r.domain,
      label: r.domain,
      detail: "Domain registration · 1 year",
      unitPrice: r.price,
      unit: "year",
      cycle: "yearly",
      years: 1,
      yearPrices: r.prices, // R-156: the terms the registry priced; the cart offers them
    });
  };

  return (
    <div
      ref={wrapRef}
      style={{
        position: "sticky",
        top: 68,                       /* directly under the sticky header */
        zIndex: 70,                    /* under the header's own menus (79) */
        background: "#fff",
        borderBottom: "1px solid var(--border-light)",
        boxShadow: "0 8px 24px -20px rgba(12,17,22,.5)",
      }}
    >
      <div className="wrap" style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 48px" }}>
        <span className="mono-label hide-mobile" style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
          SEARCH A DOMAIN
        </span>
        <form
          onSubmit={(e) => { e.preventDefault(); void runSearch(); }}
          style={{ display: "flex", flex: 1, minWidth: 0, border: "1.5px solid var(--dark)", borderRadius: 6, overflow: "hidden" }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => { if (state.kind !== "idle") setOpen(true); }}
            placeholder="yourbusiness"
            aria-label="Search for a domain name"
            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", padding: "8px 12px", fontSize: 15, fontFamily: "inherit" }}
          />
          <button type="submit" className="btn btn-primary btn-sm" style={{ borderRadius: 0, padding: "8px 18px" }}>
            Search
          </button>
        </form>
      </div>

      {open && state.kind !== "idle" && (
        <div
          style={{
            position: "absolute", left: 0, right: 0, top: "100%",
            background: "#fff", borderBottom: "1px solid var(--border)",
            boxShadow: "var(--shadow-menu)", animation: "wDrop .16s ease",
          }}
        >
          <div className="wrap" style={{ padding: "10px 48px 16px", maxHeight: "58vh", overflowY: "auto" }}>
            {state.kind === "loading" &&
              [1, 2, 3].map((i) => (
                <div key={i} style={{ height: 42, borderBottom: "1px solid var(--border-hairline)", display: "flex", alignItems: "center" }}>
                  <div style={{ height: 11, width: `${40 + i * 10}%`, background: "var(--border-hairline)", borderRadius: 4, animation: "wPulse 1.1s infinite" }} />
                </div>
              ))}

            {/* An honest failure is not enough on its own. A visitor who typed a
                name and got only red text has been stopped with nowhere to go —
                and this failure is EXPECTED right now, because the platform that
                answers availability is not deployed yet. So the message carries
                the two ways a person actually gets helped: ask us for the name by
                quote, or on WhatsApp with the name already written in.
                (CLAUDE.md §24 — a block always names the next step.) */}
            {state.kind === "error" && (
              <div style={{ padding: "10px 0", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px" }}>
                <span className="meta" style={{ color: "var(--danger)" }}>{state.message}</span>
                {lastTried && (
                  <>
                    <Link href={domainHelpLinks(lastTried).quoteHref} className="btn btn-primary btn-sm" style={{ padding: "6px 14px" }}>
                      Ask us about {lastTried}
                    </Link>
                    <a
                      href={domainHelpLinks(lastTried).whatsappHref}
                      target="_blank"
                      rel="noopener"
                      className="btn btn-outline btn-sm"
                      style={{ padding: "6px 14px" }}
                    >
                      WhatsApp us
                    </a>
                  </>
                )}
              </div>
            )}

            {state.kind === "done" && state.domains.length === 0 && (
              <p className="meta" style={{ padding: "10px 0" }}>No results — try another spelling.</p>
            )}

            {state.kind === "done" && state.domains.map((r) => (
              <div key={r.domain} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--border-hairline)" }}>
                <span className="mono" style={{ fontSize: 15, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.domain}>
                  {r.domain}
                </span>
                <span className="mono-label" style={{ color: r.available ? "var(--success)" : "var(--danger)" }}>
                  {r.available ? "AVAILABLE" : "TAKEN"}
                </span>
                {r.available ? (
                  <>
                    {r.priceKnown
                      ? <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap" }}>{rupee(r.price)}</span>
                      : <span className="meta">price on request</span>}
                    {r.priceKnown && (
                      <button
                        onClick={() => add(r)}
                        style={{ fontSize: 13, fontWeight: 600, color: "var(--primary)", border: "1px solid #9FC5F3", borderRadius: 5, background: "#fff", padding: "4px 12px", cursor: "pointer" }}
                      >
                        Add
                      </button>
                    )}
                  </>
                ) : (
                  <span className="meta">already registered</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
