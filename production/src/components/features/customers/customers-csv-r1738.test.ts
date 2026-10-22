/**
 * R-1738 — the customer import CSV reads PAN, GST treatment, payment terms (days) and
 * place of supply, with the customer form's own rules (R-1736), and the sample shows them.
 */
import { describe, it, expect } from "vitest";
import { parseCustomersCsv, SAMPLE_CSV, CSV_HEADER, parseGstTreatmentCell, parsePaymentTermsCell } from "./customers-csv";

const GSTIN = "07AAACR5055K1Z9"; // checksum-valid, Delhi, PAN AAACR5055K
const read = (csv: string) => parseCustomersCsv(csv, new Set(), new Set());

describe("customer import CSV — new columns (R-1738)", () => {
  it("the sample file has PAN, GST treatment, payment terms and place of supply columns", () => {
    for (const c of ["pan", "gst_treatment", "payment_terms_days", "place_of_supply"]) {
      expect(CSV_HEADER.split(",")).toContain(c);
    }
    const rows = read(SAMPLE_CSV);
    expect(rows.every((r) => !r.error)).toBe(true);
    expect(rows[1]).toMatchObject({ pan: "ABCDE1234F", gst_treatment: "unregistered_business", payment_terms_days: 0, state_code: "07" });
  });

  it("owner's example: 'Bharat Tiles' with only an email imports, contact = Bharat Tiles", () => {
    const [r] = read("company_name,email\nBharat Tiles,accounts@bharattiles.in");
    expect(r.error).toBeUndefined();
    expect(r.contact_name).toBe("Bharat Tiles");
    expect(r.gst_treatment).toBe("unregistered_business");
  });

  it("reads Zoho headers and values: GST Treatment code, PAN, Payment Terms, Place Of Supply", () => {
    const [r] = read(
      `Company Name,Email,GST Identification Number (GSTIN),GST Treatment,PAN,Payment Terms,Place Of Supply\n` +
      `Acme SEZ,a@acme.in,${GSTIN},business_sez,AAACR5055K,Net 15,DL`,
    );
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ gst_treatment: "sez_with_payment", pan: "AAACR5055K", payment_terms_days: 15, state_code: "07", state: "Delhi" });
  });

  it("PAN comes from the GSTIN when the column is blank", () => {
    const [r] = read(`company_name,gstin,pan\nAcme,${GSTIN},`);
    expect(r.pan).toBe("AAACR5055K");
    expect(r.gst_treatment).toBe("registered_regular");
  });

  it("refuses a malformed PAN, and a PAN that differs from the GSTIN's", () => {
    expect(read("company_name,pan\nAcme,ABC123")[0].error).toMatch(/PAN/);
    expect(read(`company_name,gstin,pan\nAcme,${GSTIN},ABCDE1234F`)[0].error).toMatch(/does not match the GSTIN/);
  });

  it("refuses an unknown treatment and one the facts contradict (R-1736 rule)", () => {
    expect(read("company_name,gst_treatment\nAcme,wholesale")[0].error).toMatch(/not recognised/);
    expect(read("company_name,gst_treatment\nAcme,registered_regular")[0].error).toMatch(/GSTIN/);
    expect(read("company_name,gst_treatment\nAcme,Overseas")[0].error).toMatch(/outside India/);
    expect(read("company_name,country,gst_treatment\nAcme LLC,United States,overseas")[0].error).toBeUndefined();
  });

  it("refuses a place of supply that is not a state, or that disagrees with the GSTIN", () => {
    expect(read("company_name,place_of_supply\nAcme,Narnia")[0].error).toMatch(/not a GST state/);
    expect(read(`company_name,gstin,place_of_supply\nAcme,${GSTIN},Punjab`)[0].error).toMatch(/does not match/);
  });

  it("refuses payment terms that are not a number of days", () => {
    expect(read("company_name,payment_terms_days\nAcme,soon")[0].error).toMatch(/Payment terms/);
    expect(read("company_name,payment_terms_days\nAcme,400")[0].error).toMatch(/Payment terms/);
  });

  it("cell parsers", () => {
    expect(parseGstTreatmentCell("Registered Business – Regular")).toBe("registered_regular");
    expect(parseGstTreatmentCell("business_none")).toBe("unregistered_business");
    expect(parseGstTreatmentCell("")).toBeNull();
    expect(parsePaymentTermsCell("Due on receipt")).toBe(0);
    expect(parsePaymentTermsCell("30 days")).toBe(30);
  });

  it("a plain billing state still works as before", () => {
    const [r] = read("company_name,billing_state\nAcme,Punjab");
    expect(r).toMatchObject({ state: "Punjab", state_code: "03" });
  });
});
