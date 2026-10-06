"use client";
/**
 * Two-step checkout. Step 1 collects who the invoice is for (GSTIN optional, plus the
 * hosting domain when a hosting line is in the cart); step 2 shows the payment methods
 * and a terms checkbox that GATES the pay button until ticked.
 *
 * Real payment (2 Sep 2026): "Pay" now calls /api/public/checkout/cart — which re-prices
 * every line SERVER-SIDE from its SKU (the client price is never trusted), creates a draft
 * quote, and returns a Razorpay order. The Razorpay widget opens; on success the webhook
 * flips the quote to paid, creates the customer/subscription/invoice and queues provisioning.
 * A line with no server-priceable SKU is refused with a clear message (request a quote).
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useCart } from "@/site/components/cart/CartProvider";
import { rupee, cycleLabel } from "@/site/lib/money";
import { missingCheckoutDetails, missingDetailsMessage } from "@/site/lib/checkout-details";
import { BUY_A_DOMAIN_HREF } from "@/lib/checkout/hosting-domain";
import { hostingLimitWarning } from "@/lib/checkout/hosting-limit";
import { GST_STATE_BY_CODE } from "@/lib/utils";

/* Indian states and union territories by GST code, A to Z, for the State field (R-091).
   "97" (other territory) and "99" (centre jurisdiction) are not places a buyer lives. */
const STATE_OPTIONS = Object.entries(GST_STATE_BY_CODE)
  .filter(([code]) => Number(code) < 97)
  .sort((a, b) => a[1].localeCompare(b[1]));
import { razorpayContact } from "@/lib/checkout/razorpay-contact";
import { BusyPanel } from "@/components/ui/busy-panel";
import { CheckoutNotice } from "@/site/components/cart/CheckoutNotice";
import { settlePageScroll } from "@/lib/ui/scroll-lock";
import { checkoutProblem, actionLabel, type ProblemAction, type ProblemFlags } from "@/site/lib/checkout-problem";
import { paidHostingLine } from "@/site/lib/hosting-cart-line";
import { HOSTING_TIERS } from "@/site/lib/data/hosting-landing-v2";
import { COMPANY } from "@/site/lib/config";
import { TRIAL_PLAN_NAME } from "@/lib/hosting/trial-plan";

/* 30 Sep 2026: the choice was never sent anywhere, so every option opened the same Razorpay
   window, and "Bank transfer — NEFT/RTGS, activated on credit" was not a path this checkout
   has. Each option now opens Razorpay on that method (`prefill.method`); the customer can
   still switch inside Razorpay's window. */
const METHODS = [
  { label: "UPI", note: "GPay, PhonePe, Paytm or any UPI app", razorpay: "upi" },
  { label: "Netbanking", note: "All major Indian banks", razorpay: "netbanking" },
  { label: "Card", note: "Visa, Mastercard, RuPay", razorpay: "card" },
] as const;

const RAZORPAY_SRC = "https://checkout.razorpay.com/v1/checkout.js";
interface RzpCtor { new (opts: Record<string, unknown>): { open: () => void; on: (e: string, cb: (r: { error?: { description?: string } }) => void) => void }; }

/** Read the Razorpay global via a cast — a `declare global` here would clash with
 *  the one in buy-workspace-client.tsx (same property, different local type). */
function rzpGlobal(): RzpCtor | undefined {
  return (window as unknown as { Razorpay?: RzpCtor }).Razorpay;
}

function loadRazorpay(): Promise<RzpCtor> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    const have = rzpGlobal();
    if (have) return resolve(have);
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => { const g = rzpGlobal(); g ? resolve(g) : reject(new Error("no global")); });
      existing.addEventListener("error", () => reject(new Error("load failed")));
      return;
    }
    const s = document.createElement("script");
    s.src = RAZORPAY_SRC; s.async = true;
    s.onload = () => { const g = rzpGlobal(); g ? resolve(g) : reject(new Error("no global")); };
    s.onerror = () => reject(new Error("load failed"));
    document.body.appendChild(s);
  });
}

export default function CheckoutPage() {
  const cart = useCart();
  const router = useRouter();
  const t = cart.totals;

  const [step, setStep] = useState<"details" | "payment">("details");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [gstin, setGstin] = useState("");
  const [phone, setPhone] = useState("");
  const [domain, setDomain] = useState("");
  /* The domain for each hosting plan after the first, by cart line (30 Sep 2026: one domain
     per plan). The first plan keeps using `domain`, so a one-plan cart is exactly as before. */
  const [planDomain, setPlanDomain] = useState<Record<string, string>>({});
  // Registrant address — asked only when the cart holds a domain (owner decision 22).
  const [addrLine1, setAddrLine1] = useState("");
  const [addrCity, setAddrCity] = useState("");
  /* The buyer's GST state, as its code ("07"). One field for every paid order (R-091): the
     place of supply on the GST invoice, and the domain owner's address state too. */
  const [stateCode, setStateCode] = useState("");
  const [addrPin, setAddrPin] = useState("");
  const [method, setMethod] = useState<string>("UPI");
  const [agreed, setAgreed] = useState(false);
  const [paying, setPaying] = useState(false);
  /* True while the server prepares a PAID order, until Razorpay's own window opens — the
     progress panel must not keep counting behind Razorpay (30 Sep 2026). */
  const [preparingPayment, setPreparingPayment] = useState(false);
  /* What stopped the order or the trial, shown as a pop-up with the ways to fix it
     (1 Oct 2026, Pawan: a red line above the button "looks flimsy" for this). */
  const [problem, setProblem] = useState<{ during: "trial" | "order" | "payment"; message: string; flags: ProblemFlags } | null>(null);
  const closeProblem = useCallback(() => setProblem(null), []);
  /* The Razorpay order a failed payment belongs to, so "Try again" reopens the same order
     instead of taking a second quote number for one purchase. */
  const lastOrder = useRef<StartedOrder | null>(null);
  /* Set once the buyer presses Continue / Start trial with something missing, so the list
     of what is missing shows from then on and shrinks as they type. */
  const [showMissing, setShowMissing] = useState(false);
  /* Set when Pay is pressed before the terms box is ticked, so the press says why. */
  const [agreeNudge, setAgreeNudge] = useState(false);
  /* Set when the server's re-priced total differs from what this page showed. */
  const [priceCheck, setPriceCheck] = useState<{
    server: number; shown: number;
    order: { orderId: string; amount: number; currency?: string; razorpayKeyId: string; quoteId?: string; totalRupees?: number };
  } | null>(null);

  const hasHosting = cart.lines.some((l) => (l.sku || "").startsWith("hosting:"));
  /* Paid hosting plans in cart order. Each is its own account on its own domain. */
  const hostingLines = cart.lines.filter((l) => (l.sku || "").startsWith("hosting:"));
  const typedFor = (key: string, i: number) => (i === 0 ? domain : planDomain[key] ?? "");
  /* Two of the same plan (two websites on Starter) read "Starter hosting · 1" and "· 2", so
     each domain box and each message says which one it means (R-032). */
  const planName = (i: number) => {
    const label = hostingLines[i].label;
    const same = hostingLines.filter((l) => l.label === label);
    return same.length > 1 ? `${label} · ${hostingLines.slice(0, i + 1).filter((l) => l.label === label).length}` : label;
  };
  const plans = hostingLines.length > 1 ? hostingLines.map((l, i) => ({ label: planName(i), typed: typedFor(l.key, i) })) : undefined;
  const hasDomain = cart.lines.some((l) => (l.sku || "").startsWith("domain:"));
  /* A free hosting trial (24 Sep 2026: "Start free trial" goes straight to the cart,
     no form in between). It checks out on its own, with no payment step: the
     server starts the trial and emails a confirmation link. */
  const hasTrial = cart.lines.some((l) => (l.sku || "").startsWith("hosting-trial:"));
  const isTrialCart = hasTrial && cart.lines.length === 1;
  /* Trials need the DMS engine (lib/dms-engine/trials.ts#trialsConfigured). null = still asking. */
  const [trialsOpen, setTrialsOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (!hasTrial) return;
    fetch("/api/public/trial/hosting/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { open?: boolean }) => setTrialsOpen(j.open !== false))
      .catch(() => setTrialsOpen(true)); // the server still refuses with a clear message
  }, [hasTrial]);
  const trialMixed = hasTrial && cart.lines.length > 1;
  /* More than one hosting account in the cart: the server refuses it at Pay, so say it here. */
  const hostingWarning = hostingLimitWarning(cart.lines);

  // Remember the buyer's details across a refresh so nothing has to be re-typed.
  useEffect(() => {
    try {
      const s = JSON.parse(window.localStorage.getItem("anutech.checkout") || "{}");
      if (typeof s.name === "string") setName(s.name);
      if (typeof s.company === "string") setCompany(s.company);
      if (typeof s.email === "string") setEmail(s.email);
      if (typeof s.gstin === "string") setGstin(s.gstin);
      if (typeof s.phone === "string") setPhone(s.phone);
      if (typeof s.domain === "string") setDomain(s.domain);
      if (s.planDomain && typeof s.planDomain === "object") setPlanDomain(s.planDomain as Record<string, string>);
      if (typeof s.addrLine1 === "string") setAddrLine1(s.addrLine1);
      if (typeof s.addrCity === "string") setAddrCity(s.addrCity);
      if (typeof s.stateCode === "string") setStateCode(s.stateCode);
      if (typeof s.addrPin === "string") setAddrPin(s.addrPin);
    } catch { /* private window / blocked storage — just start empty */ }
  }, []);
  // Hosting + a domain being bought in the same cart: the hosting goes on that domain,
  // so pre-fill it rather than making the customer type what is already in the cart.
  const cartDomain = cart.lines.find((l) => l.domain)?.domain ?? "";
  useEffect(() => {
    if (hasHosting && cartDomain) setDomain((d) => d.trim() || cartDomain);
  }, [hasHosting, cartDomain]);
  useEffect(() => {
    try {
      window.localStorage.setItem("anutech.checkout", JSON.stringify({ name, company, email, gstin, phone, domain, planDomain, addrLine1, addrCity, stateCode, addrPin }));
    } catch { /* ignore */ }
  }, [name, company, email, gstin, phone, domain, planDomain, addrLine1, addrCity, stateCode, addrPin]);

  if (cart.lines.length === 0) {
    return (
      <section className="section rise">
        <div className="wrap" style={{ maxWidth: 640 }}>
          <h1 className="h1-narrow" style={{ marginBottom: 16 }}>Checkout</h1>
          <p className="body-lg">The cart is empty — nothing to pay for.</p>
        </div>
      </section>
    );
  }

  /* The company name is optional (owner, 29 Sep 2026); the server uses the buyer's name.
     The buttons are never silently disabled for missing details any more — pressing one
     says what is still needed (lib/checkout-details). */
  const missing = missingCheckoutDetails({
    name, email, phone, domain, plans, hasHosting: hasHosting || hasTrial, hasDomain,
    needsState: !isTrialCart, stateCode,
    address: { line1: addrLine1, city: addrCity, state: GST_STATE_BY_CODE[stateCode] ?? "", pin: addrPin },
  });
  const missingMsg = missingDetailsMessage(missing);
  const detailsOk = missing.length === 0 && !trialMixed;
  /** Go on only when the details are complete; otherwise show what is missing. */
  function proceed(next: () => void) {
    if (trialMixed) return;
    if (hostingWarning) return; // the amber alert above the button says why and links back to the cart
    if (!detailsOk) { setShowMissing(true); return; }
    next();
  }

  /** The trial path: no payment, no quote — the server starts the trial and we show the done page. */
  async function startTrial() {
    if (paying) return;
    setPaying(true);
    setProblem(null);
    try {
      const res = await fetch("/api/public/checkout/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: name.trim(),
          companyName: company.trim(),
          email: email.trim(),
          phone: phone.trim(),
          domain: domain.trim() || undefined,
          lines: cart.lines.map((l) => ({ sku: l.sku, label: l.label, qty: l.qty, cycle: l.cycle })),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; trial?: boolean; error?: string; confirmationSent?: boolean } & ProblemFlags;
      if (!res.ok || !json.success || !json.trial) {
        setProblem({ during: "trial", message: json.error || "Could not start your trial. Nothing was saved — please try again.", flags: json });
        setPaying(false);
        return;
      }
      try {
        window.sessionStorage.setItem("anutech.trial", email.trim());
        // Whether the confirmation link really left — the done page must not claim it did.
        window.sessionStorage.setItem("anutech.trial.sent", json.confirmationSent === false ? "0" : "1");
        window.sessionStorage.removeItem("anutech.order");
      } catch { /* done page falls back */ }
      cart.clear();
      router.push("/done" as never);
    } catch {
      setProblem({ during: "trial", message: "We couldn't reach our server, so nothing was saved. Check your internet connection and try again.", flags: {} });
      setPreparingPayment(false);
      setPaying(false);
    }
  }

  interface StartedOrder {
    orderId: string; amount: number; currency?: string; razorpayKeyId: string;
    quoteId?: string; totalRupees?: number;
  }

  async function placeOrder() {
    if (!agreed || paying) return;
    setPriceCheck(null);
    setPaying(true);
    setPreparingPayment(true);
    setProblem(null);
    try {
      const res = await fetch("/api/public/checkout/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: name.trim(),
          companyName: company.trim(),
          email: email.trim(),
          phone: phone.trim(),
          gstin: gstin.trim() || undefined,
          stateCode: stateCode || undefined,
          domain: hasHosting ? domain.trim() : undefined,
          lines: cart.lines.map((l) => {
            const i = hostingLines.findIndex((h) => h.key === l.key);
            return { sku: l.sku, label: l.label, qty: l.qty, cycle: l.cycle, domain: l.domain, ...(l.years && l.years > 1 ? { years: l.years } : {}), ...(i >= 0 ? { hostingDomain: typedFor(l.key, i).trim() || undefined } : {}) };
          }),
          coupon: cart.coupon.trim() || undefined,
          address: hasDomain
            ? { line1: addrLine1.trim(), city: addrCity.trim(), state: GST_STATE_BY_CODE[stateCode] ?? "", zipcode: addrPin.trim(), country: "IN" }
            : undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean; simulated?: boolean; orderId?: string; amount?: number;
        currency?: string; razorpayKeyId?: string; quoteId?: string; error?: string;
        totalRupees?: number;
      } & ProblemFlags;
      if (!res.ok || !json.success) {
        setProblem({ during: "order", message: json.error || "Could not start checkout. Nothing was charged — please try again.", flags: json });
        setPreparingPayment(false);
        setPaying(false);
        return;
      }

      if (json.simulated) {
        try { window.sessionStorage.removeItem("anutech.trial"); window.sessionStorage.setItem("anutech.order", json.quoteId || ""); } catch { /* default shown */ }
        cart.clear();
        router.push("/done" as never);
        return;
      }

      if (!json.orderId || !json.razorpayKeyId || !json.amount) {
        throw new Error("Payment details missing from server. Please retry.");
      }
      const order: StartedOrder = {
        orderId: json.orderId, amount: json.amount, currency: json.currency,
        razorpayKeyId: json.razorpayKeyId, quoteId: json.quoteId, totalRupees: json.totalRupees,
      };
      /* The server re-prices every line (domains live, coupon from the same table). If
         its total differs from what this page showed, say so and let the customer decide
         — never open Razorpay on a figure they were not shown. Confirming reuses THIS
         order: placing it again would take a second quote number for one purchase. */
      const shown = Math.round(t.payable);
      if (typeof order.totalRupees === "number" && Math.abs(order.totalRupees - shown) > 1) {
        setPriceCheck({ server: order.totalRupees, shown, order });
        setPreparingPayment(false);
        setPaying(false);
        return;
      }
      await openPayment(order);
    } catch (err) {
      setProblem({ during: "order", message: (err as Error).message, flags: {} });
      setPreparingPayment(false);
      setPaying(false);
    }
  }

  async function openPayment(order: StartedOrder) {
    setPriceCheck(null);
    setPaying(true);
    lastOrder.current = order;
    try {
      const Razorpay = await loadRazorpay();
      /* Razorpay saves the page's scroll style when it opens and puts it back when it closes —
         which, with our progress card open, was "locked". Re-apply our own state once it has
         closed (3 Oct 2026: /done could not be scrolled after paying). */
      const afterRazorpay = () => { for (const ms of [0, 300, 1000]) window.setTimeout(settlePageScroll, ms); };
      const rzp = new Razorpay({
        key: order.razorpayKeyId,
        amount: order.amount,
        currency: order.currency ?? "INR",
        name: "ANUTECH DIGITAL PVT LTD",
        description: `Order ${order.quoteId ?? ""}`,
        order_id: order.orderId,
        prefill: {
          name, email, contact: razorpayContact(phone),
          method: METHODS.find((m) => m.label === method)?.razorpay,
        },
        notes: { quoteId: order.quoteId ?? "", domain: hasHosting ? domain.trim() : "" },
        /* The storefront blue (site.css --primary), so the payment window matches the shop
           around it (3 Oct 2026). It was the staff app's orange. */
        theme: { color: "#1668E3" },
        handler: () => {
          try { window.sessionStorage.removeItem("anutech.trial"); window.sessionStorage.setItem("anutech.order", order.quoteId || ""); } catch { /* default */ }
          cart.clear();
          afterRazorpay();
          router.push("/done" as never);
        },
        modal: { ondismiss: () => { setPaying(false); afterRazorpay(); }, escape: true },
      });
      rzp.on("payment.failed", (resp) => {
        setProblem({ during: "payment", message: resp.error?.description ?? "", flags: {} });
        setPaying(false);
      });
      rzp.open();
      setPreparingPayment(false); // Razorpay's window now shows its own progress
    } catch {
      setProblem({ during: "order", message: "The secure payment window didn't load, so nothing was charged. Check your internet connection and try again.", flags: {} });
      setPreparingPayment(false);
      setPaying(false);
    }
  }

  /* The paid plan the trial would have become, on the same billing cycle — what
     "Buy Starter" puts in the cart. */
  const trialLine = cart.lines.find((l) => (l.sku || "").startsWith("hosting-trial:"));
  const trialYearly = trialLine?.cycle !== "monthly";
  const paidTier = HOSTING_TIERS.find((p) => p.name === TRIAL_PLAN_NAME);
  const paidPrice = paidTier
    ? `${rupee(Math.round(trialYearly ? paidTier.yearlyTotal : paidTier.monthly))}/${trialYearly ? "year" : "month"} + GST`
    : undefined;

  function runAction(a: ProblemAction, field?: string) {
    const was = problem;
    setProblem(null);
    const mail = (subject: string, body: string) => {
      window.location.href = `mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    };
    switch (a) {
      case "buy-paid-plan":
        if (!paidTier) { router.push("/hosting" as never); return; }
        // Add first, then take the trial out, so the cart is never empty in between.
        cart.add(paidHostingLine(paidTier, trialYearly));
        for (const l of cart.lines) if ((l.sku || "").startsWith("hosting-trial:")) cart.remove(l.key);
        setShowMissing(false);
        return;
      case "ask-more-time":
        mail("More time on my free hosting trial", `Hi Anutech team,\n\nCould I have more time on my free hosting trial?\n\nEmail: ${email.trim()}\nMobile: ${phone.trim()}\nDomain: ${domain.trim()}\n\nThanks,\n${name.trim()}`);
        return;
      case "edit-details":
        window.setTimeout(() => {
          const el = document.getElementById(`checkout-${field ?? "email"}`);
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
          (el as HTMLInputElement | null)?.focus();
        }, 50);
        return;
      case "register-domain":
        router.push(BUY_A_DOMAIN_HREF as never);
        return;
      case "retry":
        if (was?.during === "trial") void startTrial();
        else if (was?.during === "payment" && lastOrder.current) void openPayment(lastOrder.current);
        else void placeOrder();
        return;
      case "email-support":
        mail("Problem at checkout", `Hi Anutech team,\n\nI couldn't finish my order. The page said:\n"${was?.message ?? ""}"\n\nEmail: ${email.trim()}\nMobile: ${phone.trim()}\n\nThanks,\n${name.trim()}`);
        return;
      case "back-to-cart":
        router.push("/cart" as never);
        return;
    }
  }
  const shownProblem = problem ? checkoutProblem(problem.during, problem.message, problem.flags, TRIAL_PLAN_NAME) : null;

  return (
    <section className="section rise">
      {shownProblem && (
        <CheckoutNotice
          tone={shownProblem.tone}
          title={shownProblem.title}
          body={shownProblem.body}
          footnote={shownProblem.footnote}
          buttons={shownProblem.actions.map((a) => ({
            label: actionLabel(a, shownProblem, paidPrice, TRIAL_PLAN_NAME),
            onClick: () => runAction(a, shownProblem.field),
          }))}
          onClose={closeProblem}
        />
      )}
      <div className="wrap" style={{ display: "grid", gridTemplateColumns: "1.2fr .8fr", gap: 40, alignItems: "start" }} data-grid>
        <div>
          <h1 className="h1-narrow" style={{ marginBottom: 6 }}>Checkout</h1>
          <p className="meta" style={{ marginBottom: 24 }}>
            {isTrialCart
              ? "Your details — no card needed, nothing is charged"
              : step === "details" ? "Step 1 of 2 — who the invoice is for" : "Step 2 of 2 — how you would like to pay"}
          </p>

          {step === "details" ? (
            <div style={{ maxWidth: 460 }}>
              {/* Required first, optional last (owner, 30 Sep 2026): a buyer fills top to
                  bottom and can stop at the "Optional" line. */}
              <Field label="YOUR NAME" value={name} onChange={setName} />
              <Field id="checkout-email" label="EMAIL — THE GST INVOICE GOES HERE" value={email} onChange={setEmail} type="email" />
              <Field label="MOBILE" value={phone} onChange={setPhone} type="tel" />
              {(hasHosting || hasTrial) && (
                <>
                  {hostingLines.length > 1 ? (
                    /* One box per plan: two plans cannot share a domain (planDomains says so). */
                    hostingLines.map((l, i) => (
                      <Field
                        key={l.key}
                        id={i === 0 ? "checkout-domain" : undefined}
                        label={`DOMAIN FOR ${planName(i).toUpperCase()} (e.g. yourcompany.in)`}
                        value={typedFor(l.key, i)}
                        onChange={(v) => (i === 0 ? setDomain(v) : setPlanDomain((m) => ({ ...m, [l.key]: v })))}
                        mono
                      />
                    ))
                  ) : (
                    <Field id="checkout-domain" label="DOMAIN FOR YOUR HOSTING (e.g. yourcompany.in)" value={domain} onChange={setDomain} mono />
                  )}
                  {/* Required for hosting and the trial alike (owner, 30 Sep 2026), so a buyer
                      without one is shown where to get one rather than left stuck. */}
                  {!cartDomain && (
                    <p className="meta" style={{ margin: "-6px 0 14px" }}>
                      Don&apos;t have a domain yet?{" "}
                      <a href={BUY_A_DOMAIN_HREF} style={{ color: "var(--primary)", fontWeight: 600 }}>
                        {hasTrial ? "Register one first" : "Find and add one to this order"}
                      </a>
                      {hasTrial
                        ? " — then come back and start your free trial."
                        : " — the domain is free with yearly hosting."}
                    </p>
                  )}
                </>
              )}
              {!isTrialCart && (
                /* Required on every paid order (R-091): without it the GST invoice cannot be
                   issued, because GST picks CGST+SGST or IGST by the buyer's state. */
                <label style={{ display: "block", marginBottom: 14 }}>
                  <span className="mono-label" style={{ color: "var(--text-muted)", display: "block", marginBottom: 6 }}>STATE — DECIDES THE GST ON YOUR INVOICE</span>
                  <select
                    id="checkout-state"
                    value={stateCode}
                    onChange={(e) => setStateCode(e.target.value)}
                    style={{ width: "100%", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "11px 12px", fontSize: 15, fontFamily: "inherit", background: "#fff" }}
                  >
                    <option value="">Choose your state</option>
                    {STATE_OPTIONS.map(([code, nameOf]) => <option key={code} value={code}>{nameOf}</option>)}
                  </select>
                </label>
              )}
              {hasDomain && (
                <>
                  <p className="meta" style={{ margin: "6px 0 2px" }}>
                    The domain is registered in your name, so the registry needs the owner&apos;s postal address.
                  </p>
                  <Field label="ADDRESS" value={addrLine1} onChange={setAddrLine1} />
                  <Field label="CITY" value={addrCity} onChange={setAddrCity} />
                  <Field label="PIN CODE" value={addrPin} onChange={setAddrPin} mono />
                </>
              )}

              <div className="mono-label" style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border-hairline)", paddingTop: 16, margin: "8px 0 14px" }}>
                OPTIONAL
              </div>
              <Field label="COMPANY / BUSINESS NAME — YOUR NAME IS USED IF BLANK" value={company} onChange={setCompany} />
              <Field label="GSTIN — FOR INPUT CREDIT" value={gstin} onChange={setGstin} mono />

              {trialMixed && (
                <div role="alert" style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "11px 14px", fontSize: 14, marginBottom: 12 }}>
                  The free trial checks out on its own. Remove the other items to start the trial now, or
                  remove the trial to pay for them.{" "}
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => router.push("/cart" as never)}>Back to cart</button>
                </div>
              )}
              {hostingWarning && (
                <div role="alert" style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "11px 14px", fontSize: 14, marginBottom: 12 }}>
                  {hostingWarning}{" "}
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => router.push("/cart" as never)}>Back to cart</button>
                </div>
              )}
              {showMissing && missingMsg && (
                <div role="alert" style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "11px 14px", fontSize: 14, marginBottom: 12 }}>
                  {missingMsg}
                </div>
              )}
              {isTrialCart ? (
                <>
                  <BusyPanel
                    active={paying}
                    variant="modal"
                    title="Starting your free trial"
                    steps={[
                      "Saving your trial request",
                      "Checking this is your first trial with us",
                      "Emailing your confirmation link",
                    ]}
                  />
                  {trialsOpen === false ? (
                    <div role="status" style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "11px 14px", fontSize: 14 }}>
                      Free hosting trials are paused for a few days. Email{" "}
                      <a href={`mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent("Please start my hosting trial")}`} style={{ fontWeight: 600 }}>{COMPANY.supportEmail}</a>
                      {" "}and we will set your trial up by hand.
                    </div>
                  ) : (
                  <button className="btn btn-primary" style={{ width: "100%", marginTop: 8 }} disabled={paying || trialMixed} onClick={() => proceed(() => void startTrial())}>
                    {paying ? "Starting your trial…" : "Start my 15-day free trial"}
                  </button>
                  )}
                  <p className="meta" style={{ marginTop: 10 }}>
                    We email you a link to confirm your address; the account is set up once you click it.
                  </p>
                </>
              ) : (
                <button className="btn btn-primary" style={{ width: "100%", marginTop: 8 }} disabled={trialMixed} onClick={() => proceed(() => setStep("payment"))}>
                  Continue
                </button>
              )}
            </div>
          ) : (
            <div style={{ maxWidth: 460 }}>
              {METHODS.map((m) => {
                const on = method === m.label;
                return (
                  <button
                    key={m.label}
                    onClick={() => setMethod(m.label)}
                    aria-pressed={on}
                    style={{
                      display: "flex", width: "100%", textAlign: "left", alignItems: "center", gap: 12,
                      border: on ? "2px solid var(--primary)" : "1px solid var(--border)",
                      background: on ? "var(--tint)" : "#fff",
                      borderRadius: 8, padding: "14px 16px", marginBottom: 10, cursor: "pointer", fontFamily: "inherit",
                    }}
                  >
                    <span aria-hidden style={{ color: on ? "var(--primary)" : "#B8C0C9", fontSize: 16 }}>{on ? "●" : "○"}</span>
                    <span>
                      <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>{m.label}</span>
                      <span className="meta">{m.note}</span>
                    </span>
                  </button>
                );
              })}

              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "16px 0", cursor: "pointer" }}>
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 3, accentColor: "var(--primary)" }} />
                <span style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                  I have read the{" "}
                  <a href="/terms-and-conditions" target="_blank" rel="noopener" style={{ color: "var(--primary)", fontWeight: 600 }}>terms and conditions</a>{" "}
                  and the{" "}
                  <a href="/refund" target="_blank" rel="noopener" style={{ color: "var(--primary)", fontWeight: 600 }}>refund policy</a>, including that domain
                  registrations are non-refundable once submitted to the registry.
                </span>
              </label>

              {priceCheck && (
                <div role="alert" style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "11px 14px", fontSize: 14, marginBottom: 12 }}>
                  The total has changed from {rupee(priceCheck.shown)} to <strong>{rupee(priceCheck.server)}</strong> — usually because a
                  domain&apos;s registry price moved since you added it. Nothing has been charged.
                  <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void openPayment(priceCheck.order)}>
                      Pay {rupee(priceCheck.server)}
                    </button>
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => router.push("/cart" as never)}>
                      Back to cart
                    </button>
                  </div>
                </div>
              )}
              {agreeNudge && !agreed && (
                <div role="alert" style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "11px 14px", fontSize: 14, marginBottom: 12 }}>
                  Please tick the box above to accept the terms and the refund policy, then press Pay.
                </div>
              )}

              <BusyPanel
                active={preparingPayment}
                variant="modal"
                title="Preparing your secure payment"
                steps={[
                  "Re-checking every price on our server",
                  ...(hasDomain ? ["Checking the live price of your domain with the registry"] : []),
                  "Creating your order",
                  "Opening the Razorpay payment window",
                ]}
              />
              {/* Not disabled until the box is ticked: a press says why (29 Sep 2026). */}
              <button
                className="btn"
                style={{
                  width: "100%",
                  background: agreed && !paying ? "var(--primary)" : "#C8D4E4",
                  color: "#fff",
                  cursor: agreed && !paying ? "pointer" : "not-allowed",
                }}
                disabled={paying}
                onClick={() => { if (!agreed) { setAgreeNudge(true); return; } void placeOrder(); }}
              >
                {paying ? "Starting secure payment…" : `Pay ${rupee(t.payable)}`}
              </button>
              <button
                onClick={() => setStep("details")}
                style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 14, cursor: "pointer", marginTop: 12 }}
              >
                ← Back to details
              </button>
            </div>
          )}
        </div>

        {/* Sticky — payment method chunte waqt total nazron me rahe. */}
        <aside className="card" style={{ position: "sticky", top: 84 }}>
          {cart.lines.map((l) => (
            <div key={l.key} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border-hairline)" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{l.label} × {l.qty}</div>
                <div className="meta" style={{ fontSize: 12 }}>{cycleLabel(l.cycle)}</div>
              </div>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{rupee(l.unitPrice * l.qty)}</span>
            </div>
          ))}
          <div style={{ paddingTop: 10 }}>
            {t.discount > 0 && <Row label="Discount" value={`−${rupee(t.discount)}`} color="var(--success)" />}
            <Row label="Subtotal" value={rupee(t.subtotal)} />
            <Row label="GST 18%" value={rupee(t.gst)} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0" }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Payable</span>
              <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.03em" }}>{rupee(t.payable)}</span>
            </div>
            {t.recurring > 0 && (
              <div className="meta">Then {rupee(t.recurring * 1.18)}/month from next month, GST included</div>
            )}
            <div className="meta" style={{ marginTop: 10 }}>
              GST invoice with GSTIN issued on every order — it reaches your inbox with the receipt.
            </div>
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-hairline)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12.5, color: "var(--text-muted)" }}>
              <span aria-hidden>🔒</span>
              <span>Payments secured &amp; powered by</span>
              <RazorpayMark />
            </div>
            <div className="meta" style={{ textAlign: "center", marginTop: 4, fontSize: 11.5 }}>UPI · Cards · Netbanking · Wallets</div>
          </div>
        </aside>
      </div>
    </section>
  );
}

function Field({ id, label, value, onChange, type = "text", mono }: { id?: string; label: string; value: string; onChange: (v: string) => void; type?: string; mono?: boolean }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <span className="mono-label" style={{ color: "var(--text-muted)", display: "block", marginBottom: 6 }}>{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "11px 12px", fontSize: 15, fontFamily: mono ? "var(--font-mono)" : "inherit" }}
      />
    </label>
  );
}

/** "Powered by Razorpay" mark — the slanted glyph + wordmark in Razorpay's blues.
 *  Rendered inline (no external image) so it never breaks; the real Razorpay-branded
 *  secure modal (with the full logo) opens when the customer taps Pay. */
function RazorpayMark() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <svg width="13" height="13" viewBox="0 0 40 40" aria-hidden style={{ display: "block" }}>
        <path d="M23 3 L31 3 L17 37 L9 37 Z" fill="#3395FF" />
        <path d="M15 13 L25 13 L20 30 L13 30 Z" fill="#0A1F44" />
      </svg>
      <span style={{ fontWeight: 700, color: "#0A1F44", fontSize: 13.5, letterSpacing: "-0.01em" }}>Razorpay</span>
    </span>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "2px 0", color: color ?? "var(--text-secondary)" }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
