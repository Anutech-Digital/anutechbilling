/**
 * Bank statement Excel (.xls / .xlsx) → rows of cell text (R-1512, 17 Oct 2026).
 *
 * Pardeep chose SheetJS Community Edition from the official cdn.sheetjs.com tarball
 * (pinned 0.20.3 in package.json) — not npm's xlsx@0.18.5 (known CVEs). It is loaded with
 * a dynamic `import("xlsx")` ONLY when an Excel file is picked, so the ~1 MB library is
 * its own chunk and never part of the page bundle.
 *
 * The rows go into the SAME path as a CSV (statement-parse.ts → header auto-detect,
 * whole-rupee amounts), so there is no second mapping UI.
 *
 * Dates: a bank's Excel stores a date either as text ("01/04/26") — passed through — or
 * as an Excel serial number with a date format. A serial is turned into YYYY-MM-DD from
 * its calendar parts (SSF.parse_date_code), never via a JS Date, so the browser's time
 * zone can't move it a day (IST-safe).
 */
import type { CellObject } from "xlsx";

const pad2 = (n: number) => String(n).padStart(2, "0");

type Xlsx = typeof import("xlsx");

function cellText(cell: CellObject | undefined, X: Xlsx): string {
  if (!cell || cell.v == null) return "";
  switch (cell.t) {
    case "n": {
      const v = cell.v as number;
      if (cell.z != null && X.SSF.is_date(cell.z)) {
        const p = X.SSF.parse_date_code(v);
        if (p && p.y > 0) return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
      }
      return String(v);
    }
    case "d": {
      // Only with cellDates (not used here); SheetJS builds these from the calendar parts
      // in local time, so read them back the same way.
      const d = cell.v as Date;
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
    case "e": return "";
    default:  return String(cell.v);
  }
}

/** First sheet of an .xls / .xlsx file → non-empty rows of cell text (columns from A). */
export async function excelToRows(data: ArrayBuffer | Uint8Array): Promise<string[][]> {
  const X: Xlsx = await import("xlsx");
  const wb = X.read(data, { type: "array", cellNF: true });
  const name = wb.SheetNames[0];
  const ws = name ? wb.Sheets[name] : undefined;
  if (!ws || !ws["!ref"]) return [];
  const range = X.utils.decode_range(ws["!ref"]);
  const rows: string[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = 0; c <= range.e.c; c++) {
      row.push(cellText(ws[X.utils.encode_cell({ r, c })] as CellObject | undefined, X).trim());
    }
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  return rows;
}

/** .xls / .xlsx by name or MIME type. */
export function isExcelFile(file: { name: string; type: string }): boolean {
  return /\.xlsx?$/i.test(file.name)
    || file.type === "application/vnd.ms-excel"
    || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}
