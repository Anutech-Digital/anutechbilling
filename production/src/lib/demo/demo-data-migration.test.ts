/**
 * R-361: the invoice half of demo data lives in SQL (no INSERT/DELETE policy on invoices).
 * A source check of the migration — the database refuses on its own, not only the app.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const DIR = "supabase/migrations";
const file = readdirSync(DIR).find((f) => f.endsWith("_demo_data_invoices.sql"));
const raw = file ? readFileSync(`${DIR}/${file}`, "utf8") : "";
const code = raw.replace(/^\s*--.*$/gm, "");
const fn = (name: string) => {
  const start = code.indexOf(`create or replace function public.${name}(`);
  return start < 0 ? "" : code.slice(start, code.indexOf("end $$;", start));
};

describe("demo data invoices migration", () => {
  it("exists and opens with a deploy-peek line", () => {
    expect(file).toBeDefined();
    expect(raw.split("\n")[0]).toMatch(/^-- deploy-peek: /);
    expect(raw.split("\n")[0]).not.toMatch(/[|"$]/);
  });

  it("the database switch is off unless someone turns it on, and only service_role can see it", () => {
    expect(code).toMatch(/enabled\s+boolean not null default false/);
    expect(code).toMatch(/revoke all on table public\.demo_data_switch from anon, authenticated/);
    expect(code).toMatch(/create policy demo_data_switch_service_role on public\.demo_data_switch\s+to service_role/);
    expect(code).not.toMatch(/insert into public\.demo_data_switch/);
  });

  it("both functions go through the shared gate: switch on + owner/manager + caller's tenant", () => {
    const gate = fn("_demo_data_tenant");
    expect(gate).toMatch(/from public\.demo_data_switch where enabled/);
    expect(gate).toMatch(/current_user_has_role\('owner', 'manager'\)/);
    expect(gate).toMatch(/v_tenant uuid := public\.current_tenant_id\(\)/);
    expect(gate).toMatch(/if v_tenant is null or/);
    for (const f of ["demo_data_add_invoices", "demo_data_clear_invoices"]) {
      expect(fn(f), f).toMatch(/v_tenant\s+uuid := public\._demo_data_tenant\(\)/);
    }
  });

  it("add: only DEMO-INV- ids, only the caller's DEMO customers, only DEMO-Q- quotes, amounts add up", () => {
    const add = fn("demo_data_add_invoices");
    expect(add).toMatch(/starts_with\(coalesce\(r->>'id', ''\), 'DEMO-INV-'\)/);
    expect(add).toMatch(/c\.tenant_id = v_tenant and starts_with\(c\.name, 'DEMO · '\)/);
    expect(add).toMatch(/q\.tenant_id = v_tenant and starts_with\(q\.id, 'DEMO-Q-'\)/);
    expect(add).toMatch(/v_taxable \+ v_tax <> v_amount/);
    expect(add).toMatch(/r->>'id', v_tenant, v_cust, v_name/);   // tenant from the session, name from the customer
    expect(add).not.toMatch(/next_document_number/);
  });

  it("clear: only the caller's DEMO-INV- invoices of DEMO customers, hatch set for this transaction only", () => {
    const clr = fn("demo_data_clear_invoices");
    expect(clr).toMatch(/where i\.tenant_id = v_tenant\s+and starts_with\(i\.id, 'DEMO-INV-'\)\s+and starts_with\(i\.customer_name, 'DEMO · '\)/);
    expect(clr).toMatch(/set_config\('app\.invoice_amend_reason', '[^']+', true\)/);
    expect(clr).toMatch(/set_config\('app\.invoice_amend_reason', '', true\)/);
    expect((clr.match(/delete from/g) ?? []).length).toBe(1);
  });

  it("no anon EXECUTE; the gate is not callable at all", () => {
    expect(code).toMatch(/revoke all on function public\._demo_data_tenant\(\) from public, anon, authenticated;/);
    for (const sig of ["demo_data_add_invoices(jsonb)", "demo_data_clear_invoices()"]) {
      expect(code).toContain(`revoke all on function public.${sig} from public, anon;`);
      expect(code).toContain(`grant execute on function public.${sig} to authenticated;`);
    }
    expect(code).not.toMatch(/grant[^;]*\banon\b/i);
  });

  it("every definer function pins search_path", () => {
    const defs = code.match(/security definer\s+set search_path = public/g) ?? [];
    expect(defs.length).toBe(3);
  });
});
