/**
 * R-015 — the document number's shape exists in TWO implementations, and they must agree.
 *
 *   SQL  public.format_document_number  — mints the number that is actually stored
 *   TS   formatDocumentNumber           — predicts it for the operator, before they spend it
 *
 * The TS one is shown in the "Issue invoice?" dialog as *the number you are about to
 * use up*. If it drifts, the operator is warned about one number and the books get
 * another — a wrong figure that looks authoritative, which AGENTS.md §2 is entirely
 * about. There is no way to share the code across the two runtimes, so the agreement is
 * pinned here instead: the same worked examples, plus a scan of the SQL for the one
 * expression that distinguishes the new shape from the old.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { formatDocumentNumber, type SeriesState } from "@/lib/actions/consequence";

const MIGRATION = "supabase/migrations/20260930172000_document_number_ist_fy_and_16_chars.sql";
const sql = readFileSync(MIGRATION, "utf8");

const S = (over: Partial<SeriesState> = {}): SeriesState => ({
  prefix: "INV", docCode: "ADPL", fiscalYear: "FY2627",
  lastNumber: 1, documentCount: 0, ...over,
});

describe("the two implementations produce the same string", () => {
  /* These are the exact values the SQL test asserts in
     supabase/tests/document_number_ist_fy_and_length.test.sql. If one file is updated
     and the other is not, one of them goes red. */
  it.each([
    [S(), 2, "INV-ADPL-27-0002"],
    [S({ docCode: "BDPL" }), 1, "INV-BDPL-27-0001"],
    [S({ docCode: "TOOLONGCODE" }), 1, "INV-TOOL-27-0001"],
    [S({ fiscalYear: "FY2526" }), 1, "INV-ADPL-26-0001"],
    [S({ prefix: "RFV" }), 9999, "RFV-ADPL-27-9999"],
  ])("%#", (series, n, expected) => {
    expect(formatDocumentNumber(series, n)).toBe(expected);
    expect(formatDocumentNumber(series, n).length).toBeLessThanOrEqual(16);
  });
});

describe("the SQL side is the shape these examples came from", () => {
  it("takes the END year of the FY, two characters", () => {
    /* The old body was `'-20' || substring(from 3 for 2) || '-' || substring(from 5 for 2)`
       — the start year, the end year and a century, which is the five characters that put
       the number at 21. */
    expect(sql).toContain("substring(p_fiscal_year from 5 for 2)");
    expect(sql).not.toContain("'-20' || substring(p_fiscal_year from 3 for 2)");
  });

  it("still carries the tenant code", () => {
    /* Dropping it was offered as the cheaper way to save characters. invoices.id is a
       bare GLOBAL primary key, so without it two tenants' first invoice of a year is a
       primary-key violation at the moment of issue. */
    expect(sql).toContain("v_prefix || '-' || v_code");
  });

  it("caps the tenant code at four, as the TS does", () => {
    expect(sql).toContain("substring(v_code from 1 for 4)");
    expect(formatDocumentNumber(S({ docCode: "TOOLONGCODE" }), 1)).toContain("-TOOL-");
  });
});

describe("the financial year comes from the document, not the clock", () => {
  it("the allocator takes a date and defaults it to IST today", () => {
    /* This database is UTC. `current_date` between 00:00 and 05:30 IST is yesterday, so
       on 1 April an invoice raised at 02:00 took its number from the closing year. */
    expect(sql).toContain("p_on        date default null");
    expect(sql).toContain("coalesce(p_on, public.ist_today())");
    expect(sql).toContain("public.indian_fiscal_year(v_on)");
  });

  it("every GST document creator dates itself in IST too", () => {
    /* Fixing the number alone would make the document disagree with its own number,
       which is worse than either. Six creators, one `current_date` each. */
    /* Comments AND single-quoted strings are stripped: two `comment on function` bodies
       quote the words "current_date" in order to explain why it is wrong, and a scan
       that punishes the explanation is how the explanation gets deleted (L46). */
    const body = sql
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*--.*$/gm, "")
      .replace(/'(?:[^']|'')*'/g, "''");
    for (const fn of [
      "generate_invoice", "raise_project_milestone_invoice", "raise_subscription_billing",
      "issue_credit_note", "issue_debit_note", "create_direct_invoice",
    ]) {
      expect(body).toContain(`FUNCTION public.${fn}`);
    }
    // No naive server-clock date left anywhere in the migration's code.
    expect(body).not.toMatch(/\bcurrent_date\b/);
  });
});

describe("R-1617 — past 9999 the number grows, it is never cut", () => {
  /* lpad(n, 4, '0') TRUNCATES in Postgres: #10000 printed as "…-1000", the same string as
     the real #1000, and the 10,000th document of a year was a duplicate primary key. The
     SQL now pads to AT LEAST 4 and refuses (does not cut) a number over 16 characters.
     Same worked examples as supabase/tests/r1617_document_number_past_9999.test.sql. */
  const R1617 = readFileSync(
    "supabase/migrations/20261019001426_r1617_document_number_no_truncate.sql", "utf8");

  it("the TS predictor never cuts either", () => {
    expect(formatDocumentNumber(S({ prefix: "RV", docCode: "ABCD" }), 9999)).toBe("RV-ABCD-27-9999");
    expect(formatDocumentNumber(S({ prefix: "RV", docCode: "ABCD" }), 10000)).toBe("RV-ABCD-27-10000");
    expect(formatDocumentNumber(S({ docCode: "ABC" }), 10000)).toBe("INV-ABC-27-10000");
  });

  it("the SQL pads only when shorter than 4, and refuses over 16", () => {
    const code = R1617.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
    expect(code).toMatch(/if length\(v_\w+\) < 4 then/);
    expect(code).toContain("if length(v_number) > 16 then");
    expect(code).toContain("raise exception");
  });
});
