import { describe, it, expect } from "vitest";
import { extractEntities } from "@/lib/inbound/extract";
import {
  extractLeadPaste, findCompany, findGstin, seatsBeforeProduct, stateFromText,
} from "./smart-paste-lead";

const PLANS = [
  "Google Workspace Business Starter",
  "Google Workspace Standard",
  "Google Workspace Plus",
  "Microsoft 365 Business Basic",
  "Microsoft 365 Business Premium",
  "Zoho Workplace Standard",
].map((p) => ({ id: p, name: p }));

/* R-491: Abhishek's paste (R-459 scenario 13), the one that filled 5 fields and left 5 blank. */
const ABHISHEK = `Hi, main Rahul Gupta, Gupta Traders Pvt Ltd se.
Hume 15 Google Workspace Business Starter chahiye.
Email: rahul@guptatraders.in, Phone +91 98765 43210
GSTIN 07AABCG1234K1Z5, Delhi
Billing monthly rakhna hai.`;

describe("extractLeadPaste — Abhishek's message (R-491)", () => {
  const r = extractLeadPaste(ABHISHEK, PLANS);

  it("still finds what it found before", () => {
    expect(r.name.value).toBe("Rahul Gupta");
    expect(r.email.value).toBe("rahul@guptatraders.in");
    expect(r.phone.value).toBe("9876543210");
    expect(r.product.value?.name).toBe("Google Workspace Business Starter");
  });

  it("now fills company, seats, GSTIN, state and billing", () => {
    expect(r.company.value).toBe("Gupta Traders Pvt Ltd");
    expect(r.seats.value).toBe(15);
    expect(r.gstin.value).toBe("07AABCG1234K1Z5");
    /* This sample GSTIN's check digit does not match — it is filled, flagged, and NOT used
       for the state. The state comes from "Delhi" written in the text. */
    expect(r.gstinValid).toBe(false);
    expect(r.stateCode.value).toBe("07");
    expect(r.stateCode.source).toBe("Delhi");
    expect(r.billing.value).toBe("monthly");
  });
});

describe("inbound auto-quote outputs are unchanged (wrapper only adds)", () => {
  /* Golden check: every field the extractor returns comes back identical, except seats where
     the extractor said null. Covers the phrasings extract.test.ts is built around. */
  const MESSAGES = [
    "Hi, mujhe 20 email google workspace standard chahiye. Rahul, 98765 43210",
    "I need a quotation for 50 Google Workspace Business Starter users",
    "Please quote 20 Microsoft 365 Business Premium licenses.",
    "We already use Microsoft 365 accounts here.",
    "I sent you 20 emails and nobody replied",
    "12 months for 30 users of Zoho Workplace Standard",
    "What's the price monthly, and yearly?",
    "yearly commitment, monthly payment for 25 users",
    ABHISHEK,
    "Thanks\nPriya Shah\npriya@acme.co.in",
  ];
  for (const body of MESSAGES) {
    it(JSON.stringify(body.slice(0, 50)), () => {
      const base = extractEntities({ fromName: null, fromEmail: null, subject: "", body, catalogue: PLANS });
      const lead = extractLeadPaste(body, PLANS);
      expect(lead.name).toEqual(base.name);
      expect(lead.email).toEqual(base.email);
      expect(lead.phone).toEqual(base.phone);
      expect(lead.product).toEqual(base.product);
      expect(lead.term).toEqual(base.term);
      if (base.seats.value != null) expect(lead.seats).toEqual(base.seats);
    });
  }
});

describe("seatsBeforeProduct", () => {
  it.each([
    ["15 Google Workspace Business Starter", 15],
    ["need 25 Microsoft 365 Business Basic", 25],
    ["10 x Google Workspace", 10],
    ["8 Zoho Mail please", 8],
  ])("%s → %d", (text, n) => {
    expect(seatsBeforeProduct(text, PLANS).value).toBe(n);
  });

  it.each([
    "Rs 15 Google Workspace discount",
    "₹1,500 Google Workspace",
    "Microsoft 365 Business Basic",
    "2026 Google Workspace pricing",
    "Google Workspace 15",
  ])("%s → null", (text) => {
    expect(seatsBeforeProduct(text, PLANS).value).toBeNull();
  });

  it("'25 users' still comes from the extractor, not from here", () => {
    const r = extractLeadPaste("25 users of Google Workspace Standard", PLANS);
    expect(r.seats.value).toBe(25);
    expect(r.seats.source).toBe("25 users");
  });
});

describe("findCompany — Indian legal suffixes", () => {
  it.each([
    ["Gupta Traders Pvt Ltd se baat kar raha hoon", "Gupta Traders Pvt Ltd"],
    ["We are Sharma & Sons Private Limited, Jaipur", "Sharma & Sons Private Limited"],
    ["main Ravi from Bright Path Consulting LLP", "Bright Path Consulting LLP"],
    ["Acme Infotech Pvt. Ltd.", "Acme Infotech Pvt. Ltd"],
    ["Company: Shree Balaji Enterprises", "Shree Balaji Enterprises"],
    ["company name - Taksh IT Solutions\nphone 9876543210", "Taksh IT Solutions"],
    ["hi gupta traders pvt ltd se", "Gupta Traders Pvt Ltd"],
    ["Hello Team, Nova Labs Ltd needs 10 users", "Nova Labs Ltd"],
  ])("%s → %s", (text, want) => {
    expect(findCompany(text).value).toBe(want);
  });

  it.each([
    "mujhe 20 email chahiye",
    "Rahul Gupta, 9876543210",
  ])("%s → null", (text) => {
    expect(findCompany(text).value).toBeNull();
  });
});

describe("GSTIN and state", () => {
  it("reads a GSTIN in any case and upper-cases it", () => {
    expect(findGstin("gst no 07abdca0298h1zp thanks").value).toBe("07ABDCA0298H1ZP");
  });

  it("does not read a GSTIN out of a longer run", () => {
    expect(findGstin("ref X07ABDCA0298H1ZP9").value).toBeNull();
  });

  it("a checksum-valid GSTIN decides the state, over a city/state word", () => {
    const r = extractLeadPaste("GSTIN 07ABDCA0298H1ZP, office in Haryana", PLANS);
    expect(r.gstinValid).toBe(true);
    expect(r.stateCode.value).toBe("07");
  });

  it("an invalid GSTIN alone gives no state (its prefix is not trusted)", () => {
    const r = extractLeadPaste("GSTIN 27AABCE9876D1Z3", PLANS);
    expect(r.gstin.value).toBe("27AABCE9876D1Z3");
    expect(r.gstinValid).toBe(false);
    expect(r.stateCode.value).toBeNull();
  });

  it.each([
    ["based in Uttar Pradesh", "09"],
    ["Jammu & Kashmir office", "01"],
    ["New Delhi", "07"],
    ["Maharashtra", "27"],
  ])("%s → %s", (text, code) => {
    expect(stateFromText(text).value).toBe(code);
  });

  it("two different states → null", () => {
    expect(stateFromText("Delhi office, Maharashtra warehouse").value).toBeNull();
  });

  it("a state word inside the company name or email does not count", () => {
    const r = extractLeadPaste("Kerala Spices Pvt Ltd, sales@goa.example.com", PLANS);
    expect(r.stateCode.value).toBeNull();
  });
});

describe("phone prefixes (Indian)", () => {
  it.each([
    "+91 98765 43210", "+91-98765-43210", "098765 43210", "919876543210", "0091 9876543210",
  ])("%s → 9876543210", (text) => {
    expect(extractLeadPaste(text).phone.value).toBe("9876543210");
  });
});

describe("billing", () => {
  it.each([
    ["monthly chahiye", "monthly"],
    ["yearly plan", "yearly"],
    ["annual billing please", "yearly"],
    ["yearly commitment, monthly payment", "monthly"],
  ])("%s → %s", (text, want) => {
    expect(extractLeadPaste(text).billing.value).toBe(want);
  });

  it("both asked as a question → null", () => {
    expect(extractLeadPaste("price monthly and yearly?").billing.value).toBeNull();
  });
});
