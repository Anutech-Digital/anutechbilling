"use client";
/**
 * The hero's domain-search card.
 *
 * ─── REAL, since the merge Phase-1 (1 Sep 2026) ─────────────────────────────
 * Availability + price used to be a deterministic string-hash (a modulo of
 * the name decided TAKEN) with prices from the hardcoded catalogue. Both are
 * gone. It now
 * asks the domains platform (app.anutech.in) through the site's own proxy
 * (/api/domains/availability → /api/public/domain-availability), which returns
 * the SAME real ResellerClub answer + customer price the logged-in app shows.
 *
 * The face never claims a domain is free that the shop cannot sell, and never
 * a price the cart will not charge. If the platform is unreachable the card
 * says so — it does NOT fall back to a guess.
 *
 *   · Enter or the Search button fires the check (no fake debounce theatre).
 *   · Skeleton rows (wPulse) while the request is in flight.
 *   · AVAILABLE rows get the real price + Add (yearly cart line at that price).
 *   · A clear, honest message on empty / error — no invented status.
 */
import { useRef, useState } from "react";
import { useCart } from "@/site/components/cart/CartProvider";
import { rupee } from "@/site/lib/money";
import { searchDomains, normaliseName, TEST_PRICE_LABEL, type DomainResult } from "@/site/lib/domain-search";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; base: string; domains: DomainResult[] }
  | { kind: "error"; message: string };

export function DomainSearch() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const reqId = useRef(0);
  const cart = useCart();

  async function runSearch() {
    const base = normaliseName(query);
    if (!base) {
      setState({ kind: "error", message: "Type a name to check." });
      return;
    }
    const mine = ++reqId.current;
    setState({ kind: "loading" });
    const out = await searchDomains(base);
    if (mine !== reqId.current) return; // a newer search superseded this one
    setState(out.ok
      ? { kind: "done", base: out.base, domains: out.domains }
      : { kind: "error", message: out.message });
  }

  const addDomain = (r: DomainResult) => {
    cart.add({
      /* sku + domain: the checkout re-prices this exact name live and registers
         it. Without them every search result was refused at payment. */
      sku: `domain:${r.domain.slice(r.domain.indexOf(".") + 1)}`,
      domain: r.domain,
      label: r.domain,
      detail: r.testPrice ? `${TEST_PRICE_LABEL} · Domain registration · 1 year` : `Domain registration · 1 year`,
      unitPrice: r.price,
      unit: "year",
      cycle: "yearly",
    });
  };

  return (
    <div className="card" style={{ padding: 26 }}>
      <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>
        FIND YOUR NAME — LIVE PRICES, RENEWAL INCLUDED
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); void runSearch(); }}
        style={{ display: "flex", border: "2px solid var(--dark)", borderRadius: 6, overflow: "hidden" }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="yourbusiness"
          aria-label="Domain name to search"
          style={{ flex: 1, border: "none", outline: "none", padding: "13px 14px", fontSize: 16, fontFamily: "inherit", minWidth: 0 }}
        />
        <button type="submit" className="btn btn-primary" style={{ borderRadius: 0, padding: "13px 20px" }}>
          Search
        </button>
      </form>

      <div style={{ marginTop: 8 }}>
        {state.kind === "idle" && (
          <p className="meta" style={{ padding: "10px 0" }}>
            Enter a name and we&apos;ll check it live across .in, .com and more.
          </p>
        )}

        {state.kind === "loading" &&
          [1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ height: 46, borderBottom: "1px solid var(--border-hairline)", display: "flex", alignItems: "center" }}>
              <div style={{ height: 12, width: `${40 + i * 8}%`, background: "var(--border-hairline)", borderRadius: 4, animation: "wPulse 1.1s infinite" }} />
            </div>
          ))}

        {state.kind === "error" && (
          <p className="meta" style={{ padding: "10px 0", color: "var(--danger)" }}>{state.message}</p>
        )}

        {state.kind === "done" && state.domains.length === 0 && (
          <p className="meta" style={{ padding: "10px 0" }}>No results — try another spelling.</p>
        )}

        {state.kind === "done" &&
          state.domains.map((r) => (
            <div key={r.domain} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-hairline)" }}>
              <span className="mono" style={{ fontSize: 15, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.domain}>
                {r.domain}
              </span>
              <span className="mono-label" style={{ color: r.available ? "var(--success)" : "var(--danger)" }}>
                {r.available ? "AVAILABLE" : "TAKEN"}
              </span>
              {r.available ? (
                <>
                  {r.priceKnown ? (
                    <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap" }}>
                      {rupee(r.price)}
                      {r.testPrice && <span className="mono-label" style={{ marginLeft: 6, color: "var(--accent-hover)" }}>{TEST_PRICE_LABEL}</span>}
                    </span>
                  ) : (
                    <span className="meta">price on request</span>
                  )}
                  {r.priceKnown && (
                    <button
                      onClick={() => addDomain(r)}
                      style={{ fontSize: 13, fontWeight: 600, color: "var(--primary)", border: "1px solid #9FC5F3", borderRadius: 5, background: "#fff", padding: "5px 12px", cursor: "pointer" }}
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
  );
}
