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

const STORAGE_KEY = "anutech.cart.v1";
const NO_DRAWER_ROUTES = ["/cart", "/checkout", "/done"];

/**
 * The typed coupon code as the SERVER judged it (R-329): the code table is not in the
 * browser, so the cart asks POST /api/public/cart-coupon. "checking" while a reply is due
 * (no discount shown yet); "error" when the check could not be made — the checkout still
 * prices the code on the server, so nothing is charged wrongly.
 */
export type CouponStatus = "empty" | "checking" | "valid" | "invalid" | "error";

interface CartApi {
  lines: CartLine[];
  totals: CartTotals;
  coupon: string;
  setCoupon: (code: string) => void;
  couponStatus: CouponStatus;
  /** Adds (or bumps qty of an identical line) and opens the drawer. */
  add: (line: Omit<CartLine, "key" | "qty"> & { qty?: number }) => void;
  setQty: (key: string, delta: number) => void;
  /** Hosting: another of the same plan, as its own line right below (another website). */
  addAnother: (key: string) => void;
  /** Domain lines (R-156): pick the registration term; the price follows the search's totals. */
  setYears: (key: string, years: number) => void;
  remove: (key: string) => void;
  clear: () => void;
  drawerOpen: boolean;
  closeDrawer: () => void;
  /** The label of the line just added — the drawer's green headline. */
  justAdded: string | null;
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
      // A cart saved before single-unit lines existed can hold "5 ×" a trial.
      .map((l) => (isSingleUnit(l) ? { ...l, qty: 1 } : l))
      .filter((l) => l.label && Number.isFinite(l.unitPrice));
  } catch {
    return [];
  }
}

function save(lines: CartLine[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  } catch {
    /* Storage refused — the in-memory cart still works for this visit. */
  }
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
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
  }, []);

  const add = useCallback<CartApi["add"]>(
    (line) => {
      setLines((prev) => {
        /* Same label + same unit price = the same thing; bump qty instead of a duplicate
           row. A cart with two "Positive SSL ₹899" rows reads like a billing mistake. */
        /* A hosting plan is one account on one domain, so a second Starter is a second
           website, not a quantity of 2 (R-032, 1 Oct 2026): it gets its own line, and its own
           domain box at checkout. */
        const ownLine = (line.sku ?? "").startsWith("hosting:");
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

  const addAnother = useCallback((key: string) => {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.key === key);
      if (i < 0) return prev;
      const copy = { ...prev[i], qty: 1, key: `${prev[i].label}-${Date.now()}-${prev.length}` };
      const next = [...prev.slice(0, i + 1), copy, ...prev.slice(i + 1)];
      save(next);
      return next;
    });
  }, []);

  const setYears = useCallback((key: string, years: number) => {
    setLines((prev) => {
      const next = prev.map((l) => {
        if (l.key !== key) return l;
        const price = domainTermPrice(l.yearPrices, years, l.bundleFree);
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
      totals,
      coupon,
      setCoupon,
      couponStatus,
      add,
      setQty,
      addAnother,
      setYears,
      remove,
      clear,
      drawerOpen,
      closeDrawer: () => setDrawerOpen(false),
      justAdded,
    }),
    [lines, totals, coupon, couponStatus, add, setQty, addAnother, setYears, remove, clear, drawerOpen, justAdded],
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
