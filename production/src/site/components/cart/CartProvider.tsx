"use client";
/**
 * Cart state for the whole site — one provider, so the header badge, the drawer, the cart
 * page and the checkout all read the SAME lines and the same totals.
 *
 * Persistence is `localStorage` under `anutech.cart.v1`, exactly the handoff's key, with the
 * same caveat the handoff itself states: in production this should become a server-backed
 * cart (or at minimum a signed cookie) so it survives devices and support can recover it.
 * The key is kept so that upgrade can migrate rather than orphan.
 *
 * The drawer-opens-on-add behaviour is the handoff's core commerce interaction: EVERY add
 * opens the right-hand drawer, on every route except cart/checkout/done — those three render
 * the cart already, and a drawer over the cart page would be the site talking over itself.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { cartTotals, domainTermPrice, isSingleUnit, type CartLine, type CartTotals } from "@/site/lib/money";
import { SEVERAL_HOSTING_PLANS_READY } from "@/lib/checkout/hosting-limit";
import { MAILBOX_YR } from "@/site/lib/data/domains-landing";
import { cartPricesFromCatalog, repriceCartLines, type CartPrices, type PriceChange } from "@/site/lib/cart-reprice";
import type { DomainRenewals } from "@/site/lib/renewal-line";

const STORAGE_KEY = "anutech.cart.v1";
const NO_DRAWER_ROUTES = ["/cart", "/checkout", "/done"];
/** R-1797: the pages that show a total to pay — they re-price the cart from the price book. */
const REPRICE_ROUTES = ["/cart", "/checkout"];

/**
 * The typed coupon code as the SERVER judged it (R-329): the code table is not in the
 * browser, so the cart asks POST /api/public/cart-coupon. "checking" while a reply is due
 * (no discount shown yet); "error" when the check could not be made — the checkout still
 * prices the code on the server, so nothing is charged wrongly.
 */
export type CouponStatus = "empty" | "checking" | "valid" | "invalid" | "error";

interface CartApi {
  lines: CartLine[];
  /**
   * R-1502: false until the saved cart has been read from this browser (it can only be read
   * after the page starts). Until then `lines` is empty for every visitor, so a page must
   * not say "the cart is empty" — the cart page showed "Nothing in it yet" with hosting in it.
   */
  loaded: boolean;
  totals: CartTotals;
  coupon: string;
  setCoupon: (code: string) => void;
  couponStatus: CouponStatus;
  /**
   * The totals with the domain typed for each hosting plan at checkout (R-1601) — which
   * domain is free depends on the plan's domain, and only the checkout form knows it.
   * `totals` assumes the first plan is on the first domain in the cart (the form's pre-fill).
   */
  totalsFor: (planTyped: readonly string[]) => CartTotals;
  /** Adds (or bumps qty of an identical line) and opens the drawer. */
  add: (line: Omit<CartLine, "key" | "qty"> & { qty?: number }) => void;
  setQty: (key: string, delta: number) => void;
  /** Domain lines (R-156): pick the registration term; the price follows the search's totals. */
  setYears: (key: string, years: number) => void;
  remove: (key: string) => void;
  clear: () => void;
  drawerOpen: boolean;
  closeDrawer: () => void;
  /** The label of the line just added — the drawer's green headline. */
  justAdded: string | null;
  /**
   * R-1797: the price book as GET /api/public/catalog gave it on the cart page / checkout —
   * null until read, and always null with CATALOG_FROM_DB off (the cart is left as today).
   */
  prices: CartPrices | null;
  /** Lines whose saved price the book changed on this visit — the one-line notice. */
  priceChanges: PriceChange[];
  /**
   * R-1628: extension → renewal ₹/yr ex GST from the live rate card (the figure /domains prints),
   * so the cart page and checkout say what a domain renews at. Empty when the card is unknown.
   */
  domainRenewals: DomainRenewals;
}

const CartContext = createContext<CartApi | null>(null);

export function useCart(): CartApi {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart outside CartProvider");
  return ctx;
}

function load(): CartLine[] {
  /* try/catch on every storage touch — private windows and blocked site data throw on the
     accessor itself, and a cart that crashes the page is worse than an empty one. */
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    /* The handoff mentions a migration path for legacy rows ({amount} instead of
       {unitPrice}); honour it rather than dropping a returning visitor's cart. */
    return parsed
      .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
      .map((l, i) => ({
        key: typeof l.key === "string" ? l.key : `legacy-${i}`,
        label: String(l.label ?? ""),
        detail: String(l.detail ?? ""),
        unitPrice: Number(l.unitPrice ?? l.amount ?? 0),
        qty: Math.max(1, Number(l.qty ?? 1)),
        unit: String(l.unit ?? "item"),
        cycle: (l.cycle === "monthly" || l.cycle === "yearly" ? l.cycle : "once") as CartLine["cycle"],
        /* Preserve the server-repriceable SKU across a reload — without this it was
           dropped on load, so every line reached checkout unpriced and was refused. */
        sku: typeof l.sku === "string" ? l.sku : undefined,
        domain: typeof l.domain === "string" ? l.domain : undefined,
        years: Number.isInteger(Number(l.years)) && Number(l.years) >= 1 && Number(l.years) <= 10 ? Number(l.years) : undefined,
        yearPrices: l.yearPrices && typeof l.yearPrices === "object" ? (l.yearPrices as Record<string, number>) : undefined,
        bundleFree: l.bundleFree === true ? true : undefined,
      }))
      .map(fullPrice)
      // A cart saved before single-unit lines existed can hold "5 ×" a trial.
      .map((l) => (isSingleUnit(l) ? { ...l, qty: 1 } : l))
      .filter((l) => l.label && Number.isFinite(l.unitPrice));
  } catch {
    return [];
  }
}

/**
 * A cart stored before R-1601 can hold a line ADDED at its bundle price — a ₹0 domain
 * (`bundleFree`) or a ₹0 mailbox from the domains page. What is free is now derived on every
 * render (priceCart in site/lib/money), so the line goes back to its full price; otherwise
 * removing the yearly plan would leave it at ₹0 while the server charges it.
 */
function fullPrice(l: CartLine): CartLine {
  const { bundleFree, ...rest } = l;
  const sku = (l.sku ?? "").toLowerCase();
  if (bundleFree && sku.startsWith("domain:")) {
    const full = domainTermPrice(l.yearPrices, l.years ?? 1);
    return full === null ? rest : { ...rest, unitPrice: full };
  }
  if (sku === "mailbox:anutech" && l.unitPrice === 0) return { ...rest, unitPrice: MAILBOX_YR };
  return rest;
}

/* R-1114 (23 Oct 2026): the typed coupon code, so a reload of /cart or /checkout keeps the
   discount. Only the code is kept — never the rate: the server judges it again on load (R-329). */
const COUPON_KEY = "anutech.cart.coupon.v1";

function loadCoupon(): string {
  try {
    return (window.localStorage.getItem(COUPON_KEY) ?? "").slice(0, 40);
  } catch {
    return "";
  }
}

function saveCoupon(code: string): void {
  try {
    if (code.trim()) window.localStorage.setItem(COUPON_KEY, code);
    else window.localStorage.removeItem(COUPON_KEY);
  } catch {
    /* Storage refused — the code still applies for this visit. */
  }
}

function save(lines: CartLine[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  } catch {
    /* Storage refused — the in-memory cart still works for this visit. */
  }
}

const NO_RENEWALS: DomainRenewals = {};

export function CartProvider({ children, domainRenewals = NO_RENEWALS }: { children: React.ReactNode; domainRenewals?: DomainRenewals }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [coupon, setCoupon] = useState("");
  /* The last server answer, for the code it was about. A reply for an older code never
     applies to the code now in the box. */
  const [couponCheck, setCouponCheck] = useState<{ code: string; status: CouponStatus; ratePct: number }>({ code: "", status: "empty", ratePct: 0 });
  const couponCode = coupon.trim().toUpperCase();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    setLines(load());
    setCoupon(loadCoupon());
    setLoaded(true);
  }, []);
  /* R-1114: keep the code across a reload — written only after the saved one was read. */
  useEffect(() => {
    if (loaded) saveCoupon(coupon);
  }, [coupon, loaded]);

  /* R-1797: the checkout API charges every hosting and mailbox line at the price book's price
     (lib/checkout/cart-checkout repriceLine), never the price saved in this browser. So the
     cart page and checkout read the same book when they open and move each line to it — the
     total shown is the total charged, and a change is said in one line (PriceChangeNotice).
     Flag off → the API says source "code" → prices stay null and nothing changes. */
  const [prices, setPrices] = useState<CartPrices | null>(null);
  const [priceChanges, setPriceChanges] = useState<PriceChange[]>([]);
  const repriceHere = loaded && REPRICE_ROUTES.includes(pathname);
  useEffect(() => {
    if (!repriceHere) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/public/catalog", { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) return; // the server still re-prices at Pay and says so if the total moved
        setPrices(cartPricesFromCatalog(await res.json()));
      } catch {
        /* Offline or aborted — the Pay step's server check still guards the total. */
      }
    })();
    return () => ctrl.abort();
  }, [repriceHere]);
  useEffect(() => {
    if (!prices) return;
    const r = repriceCartLines(lines, prices);
    if (!r.changes.length) return;
    save(r.lines);
    setLines(r.lines);
    setPriceChanges((prev) => {
      // One entry per line: keep the price it was first shown at, update where it is now.
      const byKey = new Map(prev.map((c) => [c.key, c]));
      for (const c of r.changes) byKey.set(c.key, byKey.has(c.key) ? { ...c, from: byKey.get(c.key)!.from } : c);
      return [...byKey.values()].filter((c) => c.from !== c.to);
    });
  }, [prices, lines]);

  const add = useCallback<CartApi["add"]>(
    (line) => {
      setLines((prev) => {
        /* Same label + same unit price = the same thing; bump qty instead of a duplicate
           row. A cart with two "Positive SSL ₹899" rows reads like a billing mistake. */
        /* A hosting plan is one account on one domain, so a second Starter is a second
           website, not a quantity of 2 (R-032, 1 Oct 2026): it gets its own line, and its own
           domain box at checkout. Only once several plans can be set up in one order. */
        const ownLine = SEVERAL_HOSTING_PLANS_READY && (line.sku ?? "").startsWith("hosting:");
        const existing = ownLine ? undefined : prev.find((l) => l.label === line.label && l.unitPrice === line.unitPrice);
        const single = isSingleUnit(line);
        const next = existing
          ? prev.map((l) => (l.key === existing.key ? { ...l, qty: single ? 1 : l.qty + (line.qty ?? 1) } : l))
          : [...prev, { ...line, qty: single ? 1 : line.qty ?? 1, key: `${line.label}-${Date.now()}-${prev.length}` }];
        save(next);
        return next;
      });
      setJustAdded(line.label);
      if (!NO_DRAWER_ROUTES.includes(pathname)) setDrawerOpen(true);
    },
    [pathname],
  );

  const setQty = useCallback((key: string, delta: number) => {
    setLines((prev) => {
      const next = prev
        .map((l) => (l.key === key && !isSingleUnit(l) ? { ...l, qty: Math.max(1, l.qty + delta) } : l));
      save(next);
      return next;
    });
  }, []);

  const setYears = useCallback((key: string, years: number) => {
    setLines((prev) => {
      const next = prev.map((l) => {
        if (l.key !== key) return l;
        // The term's FULL price; a free first year is taken off on render (priceCart).
        const price = domainTermPrice(l.yearPrices, years);
        if (price === null) return l; // a term the search did not price is not offered
        // "Registration, 1 year" / "Domain registration · 1 year" → the picked term.
        const term = `${years} year${years === 1 ? "" : "s"}`;
        return { ...l, years, unitPrice: price, detail: l.detail.replace(/(registration\W+)\d+ years?/i, `$1${term}`) };
      });
      save(next);
      return next;
    });
  }, []);

  const remove = useCallback((key: string) => {
    setLines((prev) => {
      const next = prev.filter((l) => l.key !== key);
      save(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setLines(() => {
      save([]);
      return [];
    });
    setPriceChanges([]);
    setCoupon("");
    setDrawerOpen(false);
  }, []);

  useEffect(() => {
    if (!couponCode) return;
    const ctrl = new AbortController();
    // Wait for the typing to pause — one check per code, not one per key.
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/public/cart-coupon", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: couponCode }),
          signal: ctrl.signal,
        });
        const data = (await res.json().catch(() => null)) as { valid?: boolean; ratePct?: number } | null;
        if (res.ok && data?.valid === true && typeof data.ratePct === "number") {
          setCouponCheck({ code: couponCode, status: "valid", ratePct: data.ratePct });
        } else if (res.ok && data?.valid === false) {
          setCouponCheck({ code: couponCode, status: "invalid", ratePct: 0 });
        } else {
          setCouponCheck({ code: couponCode, status: "error", ratePct: 0 });
        }
      } catch {
        if (!ctrl.signal.aborted) setCouponCheck({ code: couponCode, status: "error", ratePct: 0 });
      }
    }, 350);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [couponCode]);

  const couponStatus: CouponStatus = !couponCode ? "empty" : couponCheck.code === couponCode ? couponCheck.status : "checking";
  const couponRate = couponStatus === "valid" ? couponCheck.ratePct / 100 : 0;
  const totals = useMemo(() => cartTotals(lines, couponRate), [lines, couponRate]);

  const api = useMemo<CartApi>(
    () => ({
      lines,
      loaded,
      totals,
      coupon,
      setCoupon,
      couponStatus,
      totalsFor: (planTyped) => cartTotals(lines, couponRate, planTyped),
      add,
      setQty,
      setYears,
      remove,
      clear,
      drawerOpen,
      closeDrawer: () => setDrawerOpen(false),
      justAdded,
      prices,
      // Only lines still in the cart (a removed line's change is no longer news).
      priceChanges: priceChanges.filter((c) => lines.some((l) => l.key === c.key)),
      domainRenewals,
    }),
    [lines, loaded, totals, coupon, couponStatus, couponRate, add, setQty, setYears, remove, clear, drawerOpen, justAdded, prices, priceChanges, domainRenewals],
  );

  return (
    <CartContext.Provider value={api}>
      {children}
      {/* README "Accessibility": an aria-live region announces cart changes. */}
      <div aria-live="polite" className="sr-only">
        {lines.length === 0
          ? "Cart is empty"
          : `${lines.length} item(s) in cart, ₹${Math.round(totals.payable).toLocaleString("en-IN")} including GST`}
      </div>
    </CartContext.Provider>
  );
}
