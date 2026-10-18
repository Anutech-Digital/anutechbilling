/**
 * R-025, second half — a route must not hand Postgres's own words to the browser.
 *
 * The line is not "hide database errors". `raise exception` inside one of this project's
 * SECURITY DEFINER guards arrives as P0001 and its wording IS the next step the operator
 * needs (§24). Hiding those would replace every money guard with "something went wrong",
 * which is exactly the dead end §24 forbids. So the test pins BOTH sides.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { safeDbMessage, isAuthoredDbMessage, logDbError } from "./db-error";

afterEach(() => vi.restoreAllMocks());

const FALLBACK = "Could not save. Try again.";

describe("our own guards still speak", () => {
  it("passes a P0001 message through untouched", () => {
    /* A real one from the spine: record_payment's refusal names the next step, and the
       screen shows it beside a button. Swallowing it costs the operator the answer. */
    const msg = "Cannot delete: un-reconcile that bank line first.";
    expect(isAuthoredDbMessage({ code: "P0001", message: msg })).toBe(true);
    expect(safeDbMessage({ code: "P0001", message: msg }, FALLBACK)).toBe(msg);
  });
});

describe("the engine does not", () => {
  it.each([
    ["23505", 'duplicate key value violates unique constraint "quotes_pkey"'],
    ["42703", 'column "total_cost" does not exist'],
    ["42P01", 'relation "public.subscriptions" does not exist'],
    ["57014", "canceling statement due to statement timeout"],
    ["PGRST116", "JSON object requested, multiple (or no) rows returned"],
  ])("withholds %s and says something actionable instead", (code, message) => {
    const out = safeDbMessage({ code, message }, FALLBACK);
    expect(out).toContain(FALLBACK);
    expect(out).toContain(code);           // quotable in a support message
    expect(out).not.toContain(message);    // …but not the schema
    expect(isAuthoredDbMessage({ code, message })).toBe(false);
  });

  it("never leaks a table or column name that was in the raw text", () => {
    const out = safeDbMessage(
      { code: "23503", message: 'insert or update on table "payments" violates foreign key constraint "payments_quote_id_fkey"' },
      FALLBACK,
    );
    expect(out).not.toMatch(/payments|fkey|constraint/i);
  });

  it("falls back cleanly when there is no code at all", () => {
    expect(safeDbMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(safeDbMessage({ message: "boom" }, FALLBACK)).toBe(FALLBACK);
  });
});

describe("what is withheld from the customer is NOT withheld from us", () => {
  it("logDbError writes the whole error server-side", () => {
    /* Otherwise the fix for a leak is a silent failure, which is the worse bug
       (AGENTS.md §2, L92 — "it didn't work" is barely better than nothing). */
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logDbError("quotes/mark-accepted", { code: "23505", message: "dup", details: "d", hint: "h" });
    expect(spy).toHaveBeenCalledOnce();
    const [, payload] = spy.mock.calls[0];
    expect(payload).toMatchObject({ code: "23505", message: "dup", details: "d", hint: "h" });
  });
});

/**
 * Source scan for the wiring. The bug was never in a function — it was five call sites
 * each returning `err.message`, and no unit test of a helper can see that (L85).
 */
const ROUTES = [
  "src/app/api/payments/[id]/receipt/route.ts",
  "src/app/api/quotes/[id]/mark-accepted/route.ts",
  "src/app/api/quotes/[id]/recreate-subscription/route.ts",
  "src/app/api/webhooks/razorpay/webhook.server.ts",
] as const;

describe("the five R-025 routes no longer return raw text", () => {
  it.each(ROUTES)("%s classifies and logs", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain("logDbError(");
    /* No `error: <something>.message` left in a response body. The regex is deliberately
       about the SHAPE — `err.message`, `insErr.message`, `rpcErr.message` — so a new
       route that reintroduces the pattern under a different variable name still fails. */
    expect(src).not.toMatch(/error:\s*\w*[Ee]rr(or)?\.message/);
  });

  it("the razorpay webhook no longer ships a `detail` field at all", () => {
    /* It was a PUBLIC endpoint returning Postgres's text under `detail`. Anyone who can
       reach the URL could read our schema out of a failed event. */
    const src = readFileSync("src/app/api/webhooks/razorpay/webhook.server.ts", "utf8");
    expect(src).not.toMatch(/detail:\s*\w*Err\.message/);
  });
});
