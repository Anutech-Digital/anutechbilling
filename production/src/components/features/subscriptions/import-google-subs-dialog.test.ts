import { describe, it, expect } from "vitest";
import { parseGoogle, classifyRows, buildSubscriptionRow, type RawSub, type GRow } from "./google-subs-parse";
import { planKey } from "@/lib/subscriptions/plan-match";

/**
 * The Google→app subscription matcher writes money rows, so its classification
 * + MRR estimate are tested. We feed a tiny Google-style CSV and assert each row
 * lands in the right bucket (link / new / in_app) and that MRR = catalog × seats.
 */
const HEADER =
  "Customer,Product,Sku,Creation date (PST),Subscription status,Payment plan,Renewal date (PST),Assigned licenses,Purchased licenses,Customer uid,Cloud Identity Id,Provisioning id,Customer Number";

function csv(...rows: string[]) {
  return [HEADER, ...rows].join("\n");
}

const lookups = {
  // existing customer with number C-100 and domain link.com
  byNumber: new Map([["c-100", { id: "cust-1", name: "Kappa Pvt Ltd" }]]),
  byDomain: new Map([["link.com", { id: "cust-1", name: "Kappa Pvt Ltd" }]]),
  // an app subscription already exists on tracked.com
  appSubDomains: new Set(["tracked.com"]),
};
/* Keyed through planKey, exactly as the dialog now builds it. The fixture is the
   CATALOGUE's spelling — "Google Workspace Starter" — while the CSV below carries
   Google's — "Google Workspace Business Starter". They must still meet: matching those
   two by raw lowercase is what imported four real subscriptions at ₹0 on 24 Sep 2026. */
const priceMap = new Map([[planKey("Google Workspace Starter"), 270]]);

describe("parseGoogle — Google reconciliation matcher", () => {
  it("links a row to an existing customer by Customer Number", () => {
    const text = csv(
      'newbiz.com,Google Workspace,Google Workspace Business Starter,"July 1, 2025",Active,ANNUAL,"July 1, 2026",5,5,uid1,cid1,prov1,C-100',
    );
    const { rows, custNumHeader } = parseGoogle(text, lookups, priceMap);
    expect(custNumHeader).toBe("Customer Number");
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("link");
    expect(rows[0].customer_id).toBe("cust-1");
    expect(rows[0].estMrr).toBe(270 * 5);      // catalog × seats
    expect(rows[0].status).toBe("active");
  });

  it("flags an unmatched domain/number as needing a new customer", () => {
    const text = csv(
      'orphan.com,Google Workspace,Google Workspace Business Starter,"July 1, 2025",Active,ANNUAL,"July 1, 2026",2,2,uid2,cid2,prov2,C-999',
    );
    const { rows } = parseGoogle(text, lookups, priceMap);
    expect(rows[0].category).toBe("new");
    expect(rows[0].customer_id).toBeUndefined();
    expect(rows[0].estMrr).toBe(540);
  });

  it("skips a domain already tracked in the app", () => {
    const text = csv(
      'tracked.com,Google Workspace,Google Workspace Business Starter,"July 1, 2025",Active,ANNUAL,"July 1, 2026",10,10,uid3,cid3,prov3,C-555',
    );
    const { rows } = parseGoogle(text, lookups, priceMap);
    expect(rows[0].category).toBe("in_app");
  });

  it("ignores Cloud Identity Free + blank-SKU rows", () => {
    const text = csv(
      'free.com,Cloud Identity,Cloud Identity Free,"July 1, 2025",Active,FLEXIBLE,"July 1, 2026",3,3,uid4,cid4,prov4,C-1',
      'blank.com,Cloud Identity,-,"July 1, 2025",Active,,,0,0,uid5,cid5,prov5,C-2',
    );
    const { rows, skippedFree } = parseGoogle(text, lookups, priceMap);
    expect(rows).toHaveLength(0);
    expect(skippedFree).toBe(2);
  });

  it("maps Google 'Suspended' to paused", () => {
    const text = csv(
      'orphan2.com,Google Workspace,Google Workspace Business Starter,"July 1, 2025",Suspended,ANNUAL,"July 1, 2026",1,1,uid6,cid6,prov6,C-2',
    );
    const { rows } = parseGoogle(text, lookups, priceMap);
    expect(rows[0].status).toBe("paused");
  });

  it("falls back to domain match when no Customer Number column exists", () => {
    const noNumHeader =
      "Customer,Product,Sku,Creation date (PST),Subscription status,Payment plan,Renewal date (PST),Assigned licenses,Purchased licenses";
    const text = [
      noNumHeader,
      'link.com,Google Workspace,Google Workspace Business Starter,"July 1, 2025",Active,ANNUAL,"July 1, 2026",4,4',
    ].join("\n");
    const { rows, custNumHeader } = parseGoogle(text, lookups, priceMap);
    expect(custNumHeader).toBeNull();
    expect(rows[0].category).toBe("link");     // matched via byDomain
    expect(rows[0].customer_id).toBe("cust-1");
  });
});

describe("classifyRows — shared by the live Reseller-API sync", () => {
  it("classifies API rows (no customer number) the same way as the CSV path", () => {
    const raws: RawSub[] = [
      { domain: "link.com",   sku: "Google Workspace Business Starter", seats: 4, status: "active" },           // → link via domain
      { domain: "tracked.com", sku: "Google Workspace Business Starter", seats: 9, status: "active" },           // → already in app
      { domain: "fresh.io",   sku: "Google Workspace Business Starter", seats: 3, status: "paused" },           // → new
    ];
    const rows = classifyRows(raws, lookups, priceMap);
    const byDomain = Object.fromEntries(rows.map((r) => [r.domain, r]));
    expect(byDomain["link.com"].category).toBe("link");
    expect(byDomain["link.com"].customer_id).toBe("cust-1");
    expect(byDomain["link.com"].estMrr).toBe(270 * 4);
    expect(byDomain["tracked.com"].category).toBe("in_app");
    expect(byDomain["fresh.io"].category).toBe("new");
    expect(byDomain["fresh.io"].status).toBe("paused");
    // Sorted: actionable (link, new) before already-in-app.
    expect(rows[rows.length - 1].category).toBe("in_app");
  });
});

/**
 * ─── A ROW IMPORTED FROM GOOGLE HAS BEEN CHECKED AGAINST GOOGLE ─────────────
 *
 * Reported 21 Sep 2026. Four subscriptions were imported straight from the Google
 * export and every one of them immediately read "— / 2 · NOT CHECKED" in the
 * licence-leakage column: the app had been handed Google's seat count by Google, and
 * then reported that it had never asked.
 *
 * The cause was a missing key in an object literal, which is the kind of defect that
 * survives review because it looks like nothing. These tests assert the payload, which
 * is why the builder was pulled out of the dialog.
 */
describe("buildSubscriptionRow — what an imported subscription knows", () => {
  const row: GRow = {
    rowNum: 2,
    domain: "accesstel.in",
    customer_number: "",
    plan: "Google Workspace Business Starter",
    seats: 2,
    estMrr: 540,
    status: "active",
    start_date: "2026-08-29",
    renewal_date: "2027-08-29",
    category: "link",
    customer_id: "cust-1",
    customer_name: "Accesstel",
  };
  const input = { tenantId: "t1", customerId: "cust-1", syncedAt: "2026-09-21T10:00:00.000Z" };

  it("records the VENDOR seat count, not only what we bill", () => {
    const out = buildSubscriptionRow(row, input)!;
    expect(out.seats).toBe(2);
    expect(out.vendor_seats).toBe(2);
  });

  it("stamps when the vendor figure was read, so it is not 'never checked'", () => {
    // vendor_synced_at is what the leakage card reads to decide "never reconciled".
    // Without it the row is unknown forever, however many times it was imported.
    expect(buildSubscriptionRow(row, input)!.vendor_synced_at).toBe("2026-09-21T10:00:00.000Z");
  });

  it("starts matched — the two counts came from the same file", () => {
    const out = buildSubscriptionRow(row, input)!;
    expect(out.vendor_seats).toBe(out.seats);
  });

  it("carries the rest of the row through unchanged", () => {
    expect(buildSubscriptionRow(row, input)).toMatchObject({
      tenant_id: "t1",
      customer_id: "cust-1",
      customer_name: "Accesstel",
      vendor: "google",
      domain: "accesstel.in",
      status: "active",
      start_date: "2026-08-29",
      renewal_date: "2027-08-29",
      outstanding_amount: 0,
      used: 0,
    });
  });

  it("returns null when no customer could be resolved, rather than an orphan row", () => {
    expect(buildSubscriptionRow(row, { ...input, customerId: undefined })).toBeNull();
  });

  it("falls back to the domain when Google gave no customer name", () => {
    const out = buildSubscriptionRow({ ...row, customer_name: undefined }, input)!;
    expect(out.customer_name).toBe("accesstel.in");
  });
});
