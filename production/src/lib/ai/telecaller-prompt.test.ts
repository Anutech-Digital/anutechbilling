import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTHORISED_SELLING_POINTS,
  TELECALLER_NAME,
  buildTelecallPrompt,
  spokenDate,
} from "./telecaller-prompt";
import { perSeatPerYear, type SalesCatalogEntry } from "./sales-agent";

/* The live figures, measured against `items` for tenant fbb976f1… on 25 Aug 2026. Written as
   the MONTHLY value the column actually holds, converted here by the same function the quote
   path uses — so this fixture cannot drift into being a second source of the unit. */
const CATALOGUE: SalesCatalogEntry[] = [
  {
    sku: "GW-STR-fbb",
    name: "Google Workspace Business Starter",
    vendor: "google",
    msrpPerSeatPerYear: perSeatPerYear(270),
    wholesalePerSeatPerYear: perSeatPerYear(110),
    monthlyFlexPerSeatPerMonth: null,
  },
  {
    sku: "GW-STD-fbb",
    name: "Google Workspace Business Standard",
    vendor: "google",
    msrpPerSeatPerYear: perSeatPerYear(864),
    wholesalePerSeatPerYear: perSeatPerYear(620),
    monthlyFlexPerSeatPerMonth: null,
  },
];

const BASE = {
  callType: "lead_qualification" as const,
  sellerName: "ANUTECH DIGITAL PVT LTD",
  customerName: "Rakesh",
  currentPlan: null,
  seats: null,
  renewalDate: null,
  pendingAmount: null,
  catalogue: CATALOGUE,
};

describe("the prices come from the catalogue, never from this file", () => {
  it("renders the live per-seat-per-year rate", () => {
    const { systemPrompt } = buildTelecallPrompt(BASE);
    expect(systemPrompt).toContain("Rs 10,368 per seat per year");
    expect(systemPrompt).toContain("Rs 3,240 per seat per year");
  });

  it("has no price literal anywhere in the source", () => {
    /* THE TEST THIS MODULE EXISTS FOR. The brief specified "Standard Rs 750/mo", which is
       wrong today (the live figure is Rs 864) and would have been wrong silently — a hardcoded
       price agrees with itself forever. `quote-builder.tsx` still carries a plan→price map that
       disagrees with the catalogue on 8 of 8 lines, and it survives only because it is
       unreachable. This asserts on the SOURCE so the next person cannot paste one back in. */
    const source = readFileSync(join(process.cwd(), "src/lib/ai/telecaller-prompt.ts"), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments — the header discusses the figures
      .replace(/^\s*\/\/.*$/gm, "")
      /* "Microsoft 365" is a product NAME whose last word happens to be a number, and it has to
         appear in the script because the agent must ask which product family they want. Named
         explicitly rather than loosening the pattern: an allow-list of one is reviewable, and a
         regex relaxed to "numbers that do not look like prices" would let 750 back in. */
      .replace(/Microsoft 365/g, "Microsoft <product>");

    /* Any 3+ digit number sitting in the code is a candidate price. The only ones that may
       legitimately appear are none at all: every figure this file emits arrives as an argument. */
    const literals = code.match(/(?<![\w.])\d{3,}(?![\w])/g) ?? [];
    expect(literals, `numeric literals found in telecaller-prompt.ts: ${literals.join(", ")}`).toEqual([]);
  });

  it("the money block and the authorised list are built from the SAME array", () => {
    /* 24 Aug 2026: `verifyDraftMoney` approved a below-cost price because its allow-list was
       built from the same wrong source as the draft. The inverse failure is just as bad — a
       guard whose list is built from a DIFFERENT array flags the agent for saying exactly what
       it was told to say. One array, both outputs. */
    const built = buildTelecallPrompt(BASE);
    for (const figure of built.authorisedFigures) {
      expect(built.systemPrompt).toContain(figure.toLocaleString("en-IN"));
    }
  });

  it("never authorises the wholesale cost", () => {
    const { systemPrompt, authorisedFigures } = buildTelecallPrompt(BASE);
    expect(authorisedFigures).not.toContain(perSeatPerYear(620));
    expect(systemPrompt).not.toContain("7,440");
  });
});

describe("the agent is not given arithmetic", () => {
  it("forbids totals in so many words", () => {
    const { systemPrompt } = buildTelecallPrompt(BASE);
    expect(systemPrompt).toContain("Do NOT multiply");
    expect(systemPrompt).toContain("Do NOT give a total");
  });

  it("forbids discounts", () => {
    expect(buildTelecallPrompt(BASE).systemPrompt).toContain("Do NOT offer a discount");
  });

  it("cannot discuss price at all when the catalogue is empty", () => {
    /* A failed catalogue read and a fresh tenant look identical from here, and in both the
       agent must be unable to price anything — rather than fall back on whatever it knows
       about Google Workspace pricing from training. */
    const { systemPrompt, authorisedFigures } = buildTelecallPrompt({ ...BASE, catalogue: [] });
    expect(systemPrompt).toContain("You have NO price list on this call");
    expect(authorisedFigures).toEqual([]);
  });
});

describe("the persona", () => {
  it("introduces itself by name and company", () => {
    const { systemPrompt } = buildTelecallPrompt(BASE);
    expect(systemPrompt).toContain(`You are ${TELECALLER_NAME}`);
    expect(systemPrompt).toContain("ANUTECH DIGITAL PVT LTD");
  });

  it("must admit it is an AI when asked", () => {
    /* Not politeness. A denial that is later discovered costs the relationship, and it is a
       lie told in the company's name — which is not a thing this app may do unattended. */
    expect(buildTelecallPrompt(BASE).systemPrompt).toContain("Never deny it");
  });

  it("carries the three selling points the business actually stands behind", () => {
    const { systemPrompt } = buildTelecallPrompt(BASE);
    for (const point of AUTHORISED_SELLING_POINTS) {
      expect(systemPrompt).toContain(point);
    }
    expect(systemPrompt).toContain("GST invoice");
  });

  it("refuses to read out DNS record values", () => {
    /* The support agent learned this on 24 Aug: a wrong MX record read to a customer takes
       their mail down, and they follow it exactly because we said it. On a phone call there is
       not even a written record to re-check against. */
    const { systemPrompt } = buildTelecallPrompt(BASE);
    expect(systemPrompt).toContain("no MX host");
    expect(systemPrompt).toContain("no DKIM key");
  });

  it("refuses to take a password, an OTP or a card number", () => {
    const { systemPrompt } = buildTelecallPrompt(BASE);
    expect(systemPrompt).toContain("Never ask for a password");
    expect(systemPrompt).toContain("Nothing on this call is a payment");
  });

  it("asks for the seat count on a qualification call", () => {
    const { systemPrompt } = buildTelecallPrompt(BASE);
    expect(systemPrompt).toContain("HOW MANY SEATS");
    expect(systemPrompt).toContain("Do not invent a number");
  });

  it("asks permission before sending the quotation on WhatsApp", () => {
    expect(buildTelecallPrompt(BASE).systemPrompt).toContain("May we send the quotation on WhatsApp");
  });
});

describe("dynamic variables", () => {
  it("names them exactly as the voice provider interpolates them", () => {
    const { dynamicVariables } = buildTelecallPrompt({
      ...BASE,
      callType: "renewal_reminder",
      customerName: "Rakesh",
      renewalDate: "2026-09-14",
      pendingAmount: 24500,
    });
    expect(dynamicVariables.customer_name).toBe("Rakesh");
    expect(dynamicVariables.subscription_expiry_date).toBe("14 September 2026");
    expect(dynamicVariables.pending_amount).toBe("Rs 24,500");
  });

  it("formats money for SPEECH, not as a raw number", () => {
    /* A provider reads a raw number out as digits — "two four five zero zero". The app formats
       it once, here, so there is a single place that could be wrong. */
    const { dynamicVariables } = buildTelecallPrompt({ ...BASE, pendingAmount: 124416 });
    expect(dynamicVariables.pending_amount).toBe("Rs 1,24,416");
  });

  it("never emits the word null, which a provider will happily read aloud", () => {
    const { dynamicVariables } = buildTelecallPrompt({
      ...BASE,
      customerName: null,
      currentPlan: null,
      seats: null,
      renewalDate: null,
      pendingAmount: null,
    });
    for (const value of Object.values(dynamicVariables)) {
      expect(value).not.toContain("null");
      expect(value).not.toContain("undefined");
      expect(value).not.toContain("NaN");
    }
    expect(dynamicVariables.customer_name).toBe("there");
  });

  it("says nothing about money when nothing is owed", () => {
    /* Zero outstanding is not a fact worth opening a call with. "You owe zero rupees" is worse
       than not mentioning money at all. */
    const built = buildTelecallPrompt({ ...BASE, pendingAmount: 0 });
    expect(built.dynamicVariables.pending_amount).toBe("");
    expect(built.authorisedFigures).not.toContain(0);
  });

  it("authorises the outstanding amount, because the APP computed it", () => {
    const { authorisedFigures } = buildTelecallPrompt({ ...BASE, pendingAmount: 24500 });
    expect(authorisedFigures).toContain(24500);
  });
});

describe("spokenDate", () => {
  it("turns an ISO date into something a voice can read", () => {
    expect(spokenDate("2026-09-14")).toBe("14 September 2026");
  });

  it("returns an empty string rather than 'Invalid Date'", () => {
    expect(spokenDate(null)).toBe("");
    expect(spokenDate("not-a-date")).toBe("");
  });
});

describe("cold-call pitch (R-1663)", () => {
  it("Google Workspace campaigns get the Workspace pitch and objection lines", () => {
    const p = buildTelecallPrompt({ ...BASE, coldCall: { product: "Google Workspace Business Starter" } }).systemPrompt;
    expect(p).toContain("THE PITCH — GOOGLE WORKSPACE");
    expect(p).toContain("OBJECTIONS");
    expect(p).toContain("has NOT enquired");
  });
  it("another product gets the plain pitch, never the Workspace one", () => {
    const p = buildTelecallPrompt({ ...BASE, coldCall: { product: "Zoho Mail Lite" } }).systemPrompt;
    expect(p).toContain("THE PITCH");
    expect(p).not.toContain("GOOGLE WORKSPACE");
  });
  it("a call back carries the pitch too", () => {
    const p = buildTelecallPrompt({ ...BASE, coldCall: { product: null, callback: true } }).systemPrompt;
    expect(p).toContain("CALL BACK");
    expect(p).toContain("OBJECTIONS");
  });
  it("lead and renewal calls are unchanged — no pitch", () => {
    expect(buildTelecallPrompt(BASE).systemPrompt).not.toContain("THE PITCH");
  });
});
