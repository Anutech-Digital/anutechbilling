import { describe, it, expect } from "vitest";
import { csvEscape, deFormula, buildCSV } from "./csv";

describe("deFormula — spreadsheet injection guard", () => {
  it.each(["=1+1", "+1", "@SUM(A1)", "\tx", "\rx"])(
    "neutralises a field starting with %j",
    (input) => {
      expect(deFormula(input)).toBe(`'${input}`);
    },
  );

  it("neutralises the real-world attack shape", () => {
    // A customer name is user-typed and lands straight in the export.
    expect(deFormula("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  it("leaves a negative number alone so the CA can still sum the column", () => {
    // This is the case that makes a blanket "-" guard wrong: credits are
    // everywhere in these exports, and quoting them as text breaks totals.
    expect(deFormula("-4500")).toBe("-4500");
    expect(deFormula("-4500.50")).toBe("-4500.50");
  });

  it("still guards a leading minus that is not a number", () => {
    expect(deFormula("-=1+1")).toBe("'-=1+1");
    expect(deFormula("-- comment")).toBe("'-- comment");
  });

  it("leaves ordinary text untouched", () => {
    expect(deFormula("Demo Co Pvt Ltd")).toBe("Demo Co Pvt Ltd");
    expect(deFormula("")).toBe("");
  });
});

describe("csvEscape", () => {
  it("quotes fields containing a comma, quote, LF or CR", () => {
    expect(csvEscape("Sharma, Anil")).toBe('"Sharma, Anil"');
    expect(csvEscape('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    // A CR in the MIDDLE is only a quoting concern — the formula guard is
    // anchored to the first character, so nothing is prefixed here.
    expect(csvEscape("line1\rline2")).toBe('"line1\rline2"');
  });

  it("guards a CR only when it leads the field", () => {
    expect(csvEscape("\rline")).toBe('"\'\rline"');
  });

  it("never guards a number — a quoted number stops being summable", () => {
    expect(csvEscape(-4500)).toBe("-4500");
    expect(csvEscape(0)).toBe("0");
  });

  it("renders a non-finite number as blank rather than the text NaN", () => {
    // NaN in a money column reads as a value; blank reads as missing, which is true.
    expect(csvEscape(NaN)).toBe("");
    expect(csvEscape(Infinity)).toBe("");
  });

  it("treats null and undefined as empty", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });

  it("quotes AND de-formulas a field that needs both", () => {
    expect(csvEscape("=A1,B2")).toBe("\"'=A1,B2\"");
  });
});

describe("buildCSV", () => {
  it("joins with CRLF per RFC 4180", () => {
    expect(buildCSV(["a", "b"], [[1, 2]])).toBe("a,b\r\n1,2");
  });

  it("survives a hostile customer name end to end", () => {
    const csv = buildCSV(
      ["Customer", "Amount"],
      [["=HYPERLINK(\"http://evil\")", -4500]],
    );
    // Guarded, quoted (it contains a quote), and the amount still a bare number.
    expect(csv).toContain("'=HYPERLINK");
    expect(csv.endsWith(",-4500")).toBe(true);
  });
});
