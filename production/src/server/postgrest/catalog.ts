/**
 * What exists in the `public` schema — tables, columns, keys, foreign keys, functions — read
 * once per server instance from the database itself.
 *
 * This is the gateway's injection barrier: every table, column, relation and function name in
 * a request is looked up here, and only names found here are ever written into SQL (quoted).
 * Values never are — they always travel as bind parameters.
 */
import "server-only";
import { withIdentity } from "@/server/db/gateway";

export interface Column {
  name: string;
  /** format_type(), e.g. "uuid", "text", "numeric(12,2)", "text[]", "user_role" */
  type: string;
  hasDefault: boolean;
  generated: boolean;
}

export interface Table {
  name: string;
  kind: "table" | "view";
  columns: Map<string, Column>;
  pk: string[];
  uniques: string[][];
}

export interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface FunctionArg {
  name: string;
  type: string;
  hasDefault: boolean;
  /** VARIADIC parameter — must be passed as `VARIADIC name => array`. */
  variadic: boolean;
}

export interface Fn {
  name: string;
  args: FunctionArg[];
  returnsSet: boolean;
  /** "scalar" (incl. json/jsonb), "composite" (a table row type or record/TABLE()), "void" */
  returns: "scalar" | "composite" | "void";
  volatile: boolean;
  /** Return type name as format_type() prints it (e.g. "jsonb", "leads", "record"). */
  retType: string;
  /** Output columns of RETURNS TABLE(...) / OUT parameters, when the function declares them. */
  resultColumns: Column[];
}

export interface Catalog {
  tables: Map<string, Table>;
  fks: ForeignKey[];
  functions: Map<string, Fn[]>;
}

type Row = Record<string, unknown>;

async function load(): Promise<Catalog> {
  return withIdentity({ mode: "service" }, async (tx) => {
    const cols = await tx.$queryRawUnsafe<Row[]>(`
      select c.relname as table, case c.relkind when 'v' then 'view' when 'm' then 'view' else 'table' end as kind,
             a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
             a.atthasdef as has_default, (a.attgenerated <> '' or a.attidentity = 'a') as generated
        from pg_class c join pg_attribute a on a.attrelid = c.oid
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m')
         and a.attnum > 0 and not a.attisdropped
       order by c.relname, a.attnum`);

    const keys = await tx.$queryRawUnsafe<Row[]>(`
      select con.conname as name, con.contype::text as type, c.relname as table,
             array(select a.attname from unnest(con.conkey) with ordinality k(n, i)
                   join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.i)::text[] as columns,
             rc.relname as ref_table,
             array(select a.attname from unnest(con.confkey) with ordinality k(n, i)
                   join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.i)::text[] as ref_columns
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        left join pg_class rc on rc.oid = con.confrelid
       where c.relnamespace = 'public'::regnamespace and con.contype in ('p','u','f')
         and (con.contype <> 'f' or rc.relnamespace = 'public'::regnamespace)`);

    const fns = await tx.$queryRawUnsafe<Row[]>(`
      select p.proname as name, p.proretset as returns_set, p.provolatile <> 'v' as stable,
             format_type(p.prorettype, null) as ret_type, rt.typtype::text as ret_typtype,
             coalesce(p.proargnames, '{}')::text[] as arg_names,
             coalesce(p.proargmodes::text[], '{}') as arg_modes,
             array(select format_type(t, null) from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) t)::text[] as arg_types,
             p.pronargs as nargs, p.pronargdefaults as ndefaults
        from pg_proc p join pg_type rt on rt.oid = p.prorettype
       where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'`);

    const tables = new Map<string, Table>();
    for (const r of cols) {
      const name = r.table as string;
      let t = tables.get(name);
      if (!t) {
        t = { name, kind: r.kind as Table["kind"], columns: new Map(), pk: [], uniques: [] };
        tables.set(name, t);
      }
      t.columns.set(r.name as string, {
        name: r.name as string,
        type: r.type as string,
        hasDefault: Boolean(r.has_default),
        generated: Boolean(r.generated),
      });
    }

    const fks: ForeignKey[] = [];
    for (const k of keys) {
      const t = tables.get(k.table as string);
      if (!t) continue;
      const columns = k.columns as string[];
      if (k.type === "p") { t.pk = columns; t.uniques.push(columns); }
      else if (k.type === "u") t.uniques.push(columns);
      else fks.push({ name: k.name as string, table: t.name, columns, refTable: k.ref_table as string, refColumns: k.ref_columns as string[] });
    }

    const functions = new Map<string, Fn[]>();
    for (const f of fns) {
      const names = f.arg_names as string[];
      const modes = f.arg_modes as string[];
      const types = f.arg_types as string[];
      const nargs = Number(f.nargs);
      const ndefaults = Number(f.ndefaults);
      // Input arguments only (modes i / b / v, or no modes at all = all inputs).
      const inputs: FunctionArg[] = [];
      types.forEach((type, i) => {
        const mode = modes[i] ?? "i";
        if (mode === "i" || mode === "b" || mode === "v") inputs.push({ name: names[i] ?? "", type, hasDefault: false, variadic: mode === "v" });
      });
      inputs.slice(0, nargs).forEach((a, i) => { a.hasDefault = i >= nargs - ndefaults; });
      const hasTableOut = modes.includes("t") || modes.includes("o");
      const resultColumns: Column[] = [];
      types.forEach((type, i) => {
        if (modes[i] === "t" || modes[i] === "o" || modes[i] === "b") {
          resultColumns.push({ name: names[i] ?? `column${i + 1}`, type, hasDefault: false, generated: false });
        }
      });
      const retType = f.ret_type as string;
      const returns: Fn["returns"] = retType === "void" ? "void"
        : f.ret_typtype === "c" || retType === "record" || hasTableOut ? "composite" : "scalar";
      const fn: Fn = {
        name: f.name as string, args: inputs.slice(0, nargs), returnsSet: Boolean(f.returns_set), returns,
        volatile: !f.stable, retType: retType.replace(/^public./, ""), resultColumns: hasTableOut ? resultColumns : [],
      };
      const list = functions.get(fn.name) ?? [];
      list.push(fn);
      functions.set(fn.name, list);
    }

    return { tables, fks, functions };
  });
}

const cache = globalThis as unknown as { __rosCatalog?: Promise<Catalog> };

/** The catalog, loaded on first use. A failed load is not cached, so the next request retries. */
export function getCatalog(): Promise<Catalog> {
  cache.__rosCatalog ??= load().catch((e) => {
    cache.__rosCatalog = undefined;
    throw e;
  });
  return cache.__rosCatalog;
}

/** For tests: forget the cached catalog (e.g. after a migration in the same process). */
export function resetCatalog(): void {
  cache.__rosCatalog = undefined;
}
