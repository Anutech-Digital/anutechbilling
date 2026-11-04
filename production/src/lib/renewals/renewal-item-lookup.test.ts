import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   The renewal's catalogue lookup must key on item_id, not on the plan NAME.

   Found 24 Aug 2026, while about to rename two catalogue items. `create-renewal-quote.ts`
   matched `items.name = input.plan`, and `plan` is a TEXT COPY taken when the subscription
   was created — so the two drift the moment anybody renames a product. The rename was
   exactly that: the catalogue said "Google Workspace Standard" while customers write
   Google's real name, "Google Workspace Business Standard".

   A missed lookup here is not cosmetic. `catalogPerSeatMonth` is what `renewalTerm` checks
   the stored `mrr` against, and that check is the only thing that caught a 144× renewal on a
   live subscription. Renaming an item would have blinded the guard for every subscription
   sold under the old name — silently, until its renewal date, which for the live row is
   24 Aug 2027.

   Pinned on the SOURCE because the failure is a missing join key: a mock would need the
   whole supabase builder to prove which column was filtered on, and the thing to protect is
   the column choice itself.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("the renewal quote resolves its catalogue row by id", () => {
  const code = read("lib/renewals/create-renewal-quote.ts");

  it("takes item_id as an input", () => {
    expect(code).toContain("itemId?:");
  });

  it("filters items on the id, and does it BEFORE the name", () => {
    const byId = code.indexOf('.eq("id", input.itemId)');
    const byName = code.indexOf('.eq("name", catalogPlanName(input.plan))')   /* R-2095: read without an old "(N seats)" */;
    expect(byId, "the id lookup is missing entirely").toBeGreaterThan(0);
    expect(byName, "the name fallback is missing — pre-item_id rows need it").toBeGreaterThan(0);
    expect(byId, "the name lookup must be the FALLBACK, not the first try").toBeLessThan(byName);
  });

  it("says something when an item_id resolves to nothing", () => {
    /* A dangling item_id means the catalogue row was deleted under a live subscription,
       which is a bigger problem than this one renewal — so it is logged, not swallowed. */
    expect(code).toContain("no longer exists");
  });

  it("every caller passes it — a lookup nobody feeds is the same as no lookup", () => {
    /* The failure this catches: the input becomes optional, one of the three callers is
       missed, and that path silently keeps matching on the name. */
    for (const caller of [
      "app/api/cron/renewals/route.ts",
      "app/api/renewals/send-now/route.ts",
      "app/api/subscriptions/[id]/generate-renewal-quote/route.ts",
    ]) {
      const src = read(caller);
      expect(src, `${caller} does not pass itemId`).toContain("itemId:");
      expect(src, `${caller} does not select item_id`).toContain("item_id");
    }
  });
});
