/**
 * R-295 — import duplicate checks must see EVERY existing row, not the first 1000.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readAllRows, existingCustomerKeys, type PagedClient, type ExistingCustomerRow } from "./import-existing";

/** A fake PostgREST: answers at most 1000 rows per request, silently, like max_rows does. */
function cappedClient(tables: Record<string, Record<string, unknown>[]>): PagedClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    from(table) {
      return {
        select() {
          return {
            order(column) {
              return {
                range(from, to) {
                  calls.push(`${table}:${column}:${from}-${to}`);
                  const all = tables[table] ?? [];
                  const end = Math.min(to + 1, from + 1000);
                  return Promise.resolve({ data: all.slice(from, end), error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

const customers = (n: number): ExistingCustomerRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `c-${String(i + 1).padStart(5, "0")}`,
    name: `Customer ${i + 1}`,
    customer_number: `CUS-${i + 1}`,
    contact_email: `owner${i + 1}@example.in`,
  }));

describe("R-295 import lookups read past the 1000-row cap", () => {
  it("the 1001st existing customer is caught as a duplicate", async () => {
    const client = cappedClient({ customers: customers(1205) });
    const rows = await readAllRows<ExistingCustomerRow>(client, "customers", "id, contact_email, customer_number");
    expect(rows).toHaveLength(1205);
    const { nums, emails } = existingCustomerKeys(rows);
    expect(nums.has("cus-1001")).toBe(true);
    expect(emails.has("owner1205@example.in")).toBe(true);
    expect(client.calls).toEqual(["customers:id:0-999", "customers:id:1000-1999"]);
  });

  it("a failed page throws instead of passing as 'no duplicates'", async () => {
    const client: PagedClient = {
      from: () => ({ select: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: "permission denied" } }) }) }) }),
    };
    await expect(readAllRows(client, "customers", "id")).rejects.toMatchObject({ message: "permission denied" });
  });

  it("keys are trimmed and lower-cased", () => {
    const { nums, emails } = existingCustomerKeys([{ customer_number: " CUS-7 ", contact_email: " A@B.IN " }]);
    expect([...nums]).toEqual(["cus-7"]);
    expect([...emails]).toEqual(["a@b.in"]);
  });
});

/* The defect is an ABSENCE (a missing page loop), so the dialogs are also scanned: no lookup
   may go back to a bare `supabase.from(x).select(...)` that stops at 1000 rows. */
const strip = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const DIALOGS = [
  "src/components/features/customers/import-customers-dialog.tsx",
  "src/components/features/customers/import-domains-dialog.tsx",
  "src/components/features/subscriptions/import-google-subs-dialog.tsx",
  "src/components/features/subscriptions/import-subscriptions-dialog.tsx",
];

describe("R-295 import dialogs read existing rows through readAllRows", () => {
  it.each(DIALOGS)("%s", (file) => {
    const src = strip(file);
    expect(src).toContain("readAllRows");
    /* Reads of existing data: a `.from("…").select(` that is not right after an insert. */
    const bare = src.match(/\.from\("[a-z_]+"\)\s*\.select\(/g) ?? [];
    expect(bare, "bare select (1000-row cap) still used for a lookup").toEqual([]);
  });
});
