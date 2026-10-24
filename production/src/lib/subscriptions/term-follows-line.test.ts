/**
 * R-1445 + R-1442 follow-up — the subscription filed from a quote follows ITS LINE's term.
 *
 * Every filing path (record_payment, activate_quote_on_credit, file_invoiced_quote_subscriptions)
 * writes renewal_date = start + 1 year (1 month on flex), so a domain line "Register for 3 years"
 * renewed after one year, and the Onboard dialog's hand-edited Renewal / Expiry date was lost on
 * "Payment Received". One BEFORE INSERT trigger (same pattern as subscriptions_cycle_follows_quote)
 * fixes all paths. Behaviour is proven on local Docker in a rolled-back run (see the card); this
 * pins the shape so a later edit cannot quietly drop a rule.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const dir = "supabase/migrations";
const file = readdirSync(dir).find((f) => /_r1445_subscription_term_follows_line\.sql$/.test(f));
const sql = file ? readFileSync(`${dir}/${file}`, "utf8") : "";

describe("R-1445 migration: subscription_term_follows_line", () => {
  it("exists, with a deploy-peek first line that never casts ::regclass", () => {
    expect(file).toBeTruthy();
    const first = sql.split("\n")[0];
    expect(first).toMatch(/^-- deploy-peek: /);
    expect(first).not.toMatch(/::regclass/);
    expect(sql).toMatch(/^-- deploy-key: /m);
  });
  it("is a BEFORE INSERT trigger on subscriptions", () => {
    expect(sql).toMatch(/create trigger subscriptions_term_follows_line\s+before insert on public\.subscriptions/i);
  });
  it("only replaces the filers' own default (start + 1 year / + 1 month)", () => {
    expect(sql).toMatch(/new\.start_date \+ interval '1 year'/);
    expect(sql).toMatch(/new\.start_date \+ interval '1 month'/);
  });
  it("reads the line's renewal_date (bounded) and years 2..10, spreading mrr over the years", () => {
    expect(sql).toMatch(/->>'renewal_date'/);
    expect(sql).toMatch(/->>'years'/);
    expect(sql).toMatch(/between 2 and 10/);
    expect(sql).toMatch(/new\.mrr\s*:=/);
  });
  it("is internal: no execute for app roles", () => {
    expect(sql).toMatch(/revoke all on function public\.subscription_term_follows_line\(\) from public, anon, authenticated/i);
  });
});
