/**
 * R-2180 — the customer import CSV takes any ISO country: Estonia / Cayman Islands import
 * as overseas customers (no Indian state needed), and short forms map to the list name.
 */
import { describe, it, expect } from "vitest";
import { parseCustomersCsv } from "./customers-csv";

const read = (csv: string) => parseCustomersCsv(csv, new Set(), new Set());

describe("customer import CSV — every country (R-2180)", () => {
  it("Cayman Islands → overseas, no state needed", () => {
    const [r] = read("company_name,email,country\nZynk Labs,ap@zynk.example,Cayman Islands");
    expect(r.error).toBeUndefined();
    expect(r.country).toBe("Cayman Islands");
    expect(r.gst_treatment).toBe("overseas");
    expect(r.state_code).toBeUndefined();
  });

  it("'estonia' (any case) is saved as the list name Estonia, overseas", () => {
    const [r] = read("company_name,email,billing country\nWoollyes OU,billing@woollyes.example,estonia");
    expect(r.error).toBeUndefined();
    expect(r.country).toBe("Estonia");
    expect(r.gst_treatment).toBe("overseas");
  });

  it("short forms map to the list name: USA → United States, EE → Estonia", () => {
    const rows = read("company_name,email,country\nA Co,a@a.example,USA\nB Co,b@b.example,EE");
    expect(rows.map((r) => r.country)).toEqual(["United States", "Estonia"]);
  });
});
