/**
 * R-2944 — a normaliser change must come with a decision about the stored scans.
 *
 * The FY scan (zoho_fy_scan.payload) keeps only what a normaliser MADE of a Zoho document — not the
 * document. So when a normaliser's rules change (a new field, a problem removed or added, other money),
 * every row stored before still carries the OLD result until its detail is read from Zoho again, and
 * "Read from Zoho again" reads a row again only when it changed in Zoho or its facts version is older
 * (fy-import/scan.ts SCAN_FACTS_VERSION). R-2702 changed the sales rules without raising the version:
 * on staging 79 invoices stayed "left out" with sentences the code no longer had.
 *
 * This test pins each normaliser file to the facts version it was written for. It goes red when a
 * normaliser file changes. Then decide, in the same commit:
 *   - the change alters what is STORED for some document (facts, problems, notes, amounts) → raise that
 *     list's SCAN_FACTS_VERSION. By default every older row is then read again (one detail call per
 *     document — a 2,780-invoice year is three days of Zoho's ~900-call day budget; say so on the
 *     card); add the new version to SCAN_FACTS_LEFT_OUT_ONLY only when the change frees or re-words
 *     LEFT-OUT documents and stores the same for every document the older rules took (tens of calls);
 *   - it does not (a comment, a rename, a helper only the plan uses) → keep the version;
 * and put the file's new hash + the version below. Never update the hash without that decision.
 * The hash is of the file's text with Windows line ends normalised. NOT seen here: a rule that lives in
 * a file the normaliser only imports — fy-fetch.ts `toDetail` (what a Zoho document is read as),
 * `parsePlaceOfSupply`, `mapGstTreatment`; a change there that alters stored facts needs the same
 * decision by hand. `tdsSectionOf` (purchase-import/normalise.ts) also names the SALES facts' tdsSection:
 * when that file's pin goes red, decide for invoices too.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FyReadKind } from "../fy-fetch";
import { factsVersionOf } from "./scan";
/* Imported so `vitest related <normaliser>` runs this file. */
import { zohoSaleFacts } from "../sales-import/normalise";
import { zohoReceiptFacts } from "../receipts-import/normalise";
import { zohoPurchaseFacts } from "../purchase-import/normalise";

const DIR = resolve(process.cwd(), "src/lib/integrations/zoho-books");

/** file → { hash of its text, the facts version of each list it normalises }. */
const PINS: Array<{ file: string; sha: string; versions: Partial<Record<FyReadKind, number>> }> = [
  { file: "sales-import/normalise.ts", sha: "7bbb6968e522ae99", versions: { invoices: 1 } },
  { file: "receipts-import/normalise.ts", sha: "9dfb7bd84e7dd964", versions: { customerpayments: 0 } },
  { file: "purchase-import/normalise.ts", sha: "1b0d3787ea139bd5", versions: { bills: 0, expenses: 0, vendorpayments: 0 } },
];

const hashOf = (file: string): string =>
  createHash("sha256").update(readFileSync(resolve(DIR, file), "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);

describe("R-2944 normaliser ↔ facts version pin", () => {
  it("the normalisers are the ones this file pins", () => {
    expect([zohoSaleFacts, zohoReceiptFacts, zohoPurchaseFacts].every((f) => typeof f === "function")).toBe(true);
  });

  for (const pin of PINS) {
    it(`${pin.file} is unchanged since its facts version was decided (else: decide the version, then update this pin)`, () => {
      const now = { sha: hashOf(pin.file), versions: Object.fromEntries(Object.keys(pin.versions).map((k) => [k, factsVersionOf(k as FyReadKind)])) };
      expect(now, `${pin.file} changed — read the note at the top of this test: raise SCAN_FACTS_VERSION if stored facts change, then pin the new hash`).toEqual({ sha: pin.sha, versions: pin.versions });
    });
  }
});
