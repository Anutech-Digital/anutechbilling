/**
 * R-2155 ratchet — every place that can take money through Razorpay asks
 * `liveKeyCheckoutRefusal` (lib/checkout/live-guards.ts) BEFORE it does, so a rzp_live_ key on
 * staging (needed there only to READ settlements, R-2099) can never create an order, a payment
 * link, or settle a payment.
 *
 * A new file that creates a Razorpay order / payment link fails here until it calls the guard
 * before its first money call — then add it to KNOWN so the list stays honest.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(__dirname, "..", "..");
const GUARD = "liveKeyCheckoutRefusal(";

/** Calls that create an order / link / capture — i.e. take money. */
const MONEY_CALL = /\.orders\.create\(|\.paymentLink\.create\(|\.payments\.capture\(|\.subscriptions\.create\(|\/v1\/payment_links|\/v1\/orders|\/v1\/subscriptions|\/v1\/invoices/;

/** Not order-creating, but they turn a Razorpay payment into OUR money (verify) — also guarded. */
const SETTLES_PAYMENT = ["lib/checkout/verify-payment.server.ts"];

/** Every money-taking call site today (R-2155, 30 Oct 2026). */
const KNOWN = [
  "app/api/public/checkout/support/route.ts",
  "app/api/public/checkout/workspace/route.ts",
  "lib/checkout/cart-checkout.ts",
  "lib/checkout/quote-order.ts",
  "lib/payments/payment-link.server.ts",
].sort();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "generated") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split(sep).join("/");
/** Strip comments so a call named in prose does not count either way. */
const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const files = walk(SRC);
/** Only Razorpay counts (Google Reseller also has a subscriptions.create). */
const isRazorpay = (src: string) => /from "razorpay"|api\.razorpay\.com/.test(src);
const moneyFiles = files.filter((p) => { const s = code(p); return isRazorpay(s) && MONEY_CALL.test(s); }).map(rel).sort();

/** Where the first money call is. A URL kept in a const counts where the const is USED. */
function firstMoneyCall(src: string): number {
  const m = MONEY_CALL.exec(src);
  if (!m) return -1;
  const lineStart = src.lastIndexOf("\n", m.index) + 1;
  const decl = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/.exec(src.slice(lineStart, m.index));
  if (!decl) return m.index;
  return src.indexOf(decl[1], m.index);
}

describe("R-2155 — no Razorpay money call without the staging live-key guard", () => {
  it("the list of money-taking files is exactly the known one (a new one must be guarded and added)", () => {
    expect(moneyFiles).toEqual(KNOWN);
  });

  it.each(KNOWN)("%s asks liveKeyCheckoutRefusal before its first money call", (f) => {
    const src = code(join(SRC, f));
    const guardAt = src.indexOf(GUARD);
    const callAt = firstMoneyCall(src);
    expect(guardAt, `${f} never calls ${GUARD}`).toBeGreaterThan(-1);
    expect(callAt, `${f}: money call not found`).toBeGreaterThan(-1);
    expect(guardAt, `${f} calls the guard only after the Razorpay call`).toBeLessThan(callAt);
  });

  it.each(SETTLES_PAYMENT)("%s asks the guard before Razorpay is asked about the payment", (f) => {
    const src = code(join(SRC, f));
    const guardAt = src.indexOf(GUARD);
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(src.indexOf(".payments.fetch("));
  });

  it("the R-2099 settlement read is NOT guarded — a live key may read on staging", () => {
    for (const f of ["lib/razorpay/settlement.server.ts", "lib/razorpay/settlement-api.server.ts"]) {
      expect(code(join(SRC, f))).not.toContain(GUARD);
    }
  });
});
