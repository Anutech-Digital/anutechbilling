import { describe, it, expect } from "vitest";
import { USER_ROLES } from "@/lib/auth/roles";
import {
  EXPORT_KINDS, EXPORT_ROLES, buildExportCsv, exportFilename, filenameFromDisposition, isExportKind,
  maskContactColumns, mayExport, watermarkLine,
} from "./server-export";

describe("R-1007 server export rules", () => {
  it("EXPORT_ROLES is exactly the roles mayExport admits for some kind", () => {
    const admitted = USER_ROLES.filter((r) => EXPORT_KINDS.some((k) => mayExport(k, r)));
    expect([...admitted].sort()).toEqual([...EXPORT_ROLES].sort());
  });

  it("contact lists: owner + manager only; invoices: also accountant + billing", () => {
    for (const k of ["customers", "leads"] as const) {
      expect(USER_ROLES.filter((r) => mayExport(k, r)).sort()).toEqual(["manager", "owner"]);
    }
    expect(USER_ROLES.filter((r) => mayExport("invoices", r)).sort()).toEqual(["accountant", "billing", "manager", "owner"]);
    expect(mayExport("customers", null)).toBe(false);
    expect(mayExport("invoices", "nobody")).toBe(false);
  });

  it("isExportKind", () => {
    expect(isExportKind("leads")).toBe(true);
    expect(isExportKind("salary-register")).toBe(false);
    expect(isExportKind(undefined)).toBe(false);
  });

  it("masks phone and email for a role without contact details, leaves the rest", () => {
    const headers = ["Company", "Contact", "Email", "Phone"];
    const rows = [["Beta", "Meena", "meena@beta.example", "9876501234"], ["Gamma", "", "", ""]];
    expect(maskContactColumns("leads", "owner", headers, rows)).toEqual(rows);
    const masked = maskContactColumns("leads", "accountant", headers, rows);
    expect(masked[0]).toEqual(["Beta", "Meena", "me•••@beta.example", "••••••1234"]);
    expect(masked[1]).toEqual(["Gamma", "", "", ""]);
    expect(rows[0][2]).toBe("meena@beta.example"); // input not mutated
  });

  it("footer names who, role, IST time and company", () => {
    const at = new Date("2026-10-23T18:05:00Z"); // 23:35 IST
    const line = watermarkLine({ by: "Asha Rao", email: "asha@example.invalid", role: "manager", company: "Acme Pvt Ltd", at });
    expect(line).toBe("Exported by Asha Rao <asha@example.invalid> (Manager) on 23 Oct 2026, 11:35 pm IST from Acme Pvt Ltd. Confidential - for Acme Pvt Ltd internal use only.");
    expect(watermarkLine({ by: "", email: "x@example.invalid", role: null, company: "", at })).toMatch(/^Exported by x@example\.invalid \(Member\) .* from this workspace\./);
  });

  it("file = BOM + table + blank line + footer; a formula in a cell or the company stays text", () => {
    const csv = buildExportCsv(["Name"], [["=cmd"]], "Exported by A from =evil");
    expect(csv).toBe("﻿Name\r\n'=cmd\r\n\r\nExported by A from =evil\r\n");
  });

  it("filenames", () => {
    const at = new Date("2026-10-23T20:00:00Z"); // already 24 Oct in IST
    expect(exportFilename("leads", at)).toBe("leads-2026-10-24.csv");
    expect(exportFilename("invoices", at, true)).toBe("selected-invoices-2026-10-24.csv");
    expect(filenameFromDisposition('attachment; filename="leads-2026-10-24.csv"', "x.csv")).toBe("leads-2026-10-24.csv");
    expect(filenameFromDisposition('attachment; filename="../../evil.sh"', "x.csv")).toBe("....evil.sh");
    expect(filenameFromDisposition(null, "x.csv")).toBe("x.csv");
  });
});
