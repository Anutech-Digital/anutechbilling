/**
 * R-2017 — the checker behind admin-client-allowlist.scan.test.ts. Pure: it takes file texts
 * (relative path under src/app/api/public → source) and the allowlist, and returns problems.
 * Kept out of the test file so the test can also feed it small made-up routes and prove each
 * rule turns red.
 */
import type { PublicAdminEntry } from "./admin-client-allowlist";

/** Comments out, so a file that only TALKS about a guard does not pass for having one. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

export const USES_SERVICE_ROLE = /\bcreateAdminClient(For)?\b|SUPABASE_SERVICE_ROLE_KEY/;

export interface Call {
  kind: "from" | "rpc";
  name: string;
  chain: string;
  reads: boolean;
  writes: boolean;
  /** .select(...) first argument: string-literal columns, an identifier, or null. */
  columns: string[] | null;
}

/** Every .from("t") / .rpc("f") in the code, with its chain up to the next call or `;`. */
export function calls(code: string): Call[] {
  const out: Call[] = [];
  const re = /\.(from|rpc)\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;
  const starts: { i: number; kind: "from" | "rpc"; name: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) starts.push({ i: m.index, kind: m[1] as "from" | "rpc", name: m[2] });
  starts.forEach((s, k) => {
    const next = k + 1 < starts.length ? starts[k + 1].i : code.length;
    const semi = code.indexOf(";", s.i);
    const end = Math.min(next, semi === -1 ? code.length : semi);
    const chain = code.slice(s.i, end).replace(/\s+/g, " ");
    const writes = s.kind === "rpc" || /\.(insert|update|upsert|delete)\(/.test(chain);
    const sel = chain.match(/\.select\(\s*(?:["'`]([^"'`]*)["'`]|([A-Za-z_$][\w$]*))?/);
    let columns: string[] | null = null;
    if (sel && sel[1] !== undefined) columns = sel[1].split(",").map((c) => c.trim()).filter(Boolean);
    else if (sel && sel[2]) columns = [sel[2]];
    else if (sel) columns = ["*"];
    out.push({ kind: s.kind, name: s.name, chain, reads: !!sel, writes, columns });
  });
  return out;
}

export interface ScanInput {
  /** path under src/app/api/public (forward slashes) → source text; test files left out. */
  files: Record<string, string>;
  /** "@/lib/<x>" module → true when that lib uses the service role. */
  libUsesServiceRole: (mod: string) => boolean;
  allowlist: Record<string, PublicAdminEntry>;
  infraLibs: Record<string, string>;
  piiTables: readonly string[];
}

const hasFilter = (chain: string, col: string) =>
  new RegExp(`\\.(eq|ilike|in|match|is|filter)\\(\\s*["'\`]${col}["'\`]`).test(chain);

export function scanPublicAdminClient(input: ScanInput): string[] {
  const problems: string[] = [];
  const pii = new Set(input.piiTables);
  const needed = new Set<string>();

  for (const [file, src] of Object.entries(input.files)) {
    const code = stripComments(src);
    const direct = USES_SERVICE_ROLE.test(code);
    const libs = [...code.matchAll(/from\s+["']@\/lib\/([^"']+)["']/g)].map((x) => x[1]);
    const viaLibs = libs.filter((l) => !(l in input.infraLibs) && input.libUsesServiceRole(l));
    if (!direct && viaLibs.length === 0) continue;
    needed.add(file);
    const entry = input.allowlist[file];
    if (!entry) {
      problems.push(`${file}: uses the service role${direct ? "" : ` via @/lib/${viaLibs.join(", @/lib/")}`} but has no entry in _lib/admin-client-allowlist.ts (reason + scope + tables)`);
      continue;
    }
    if (!direct && entry.via && !viaLibs.includes(entry.via)) {
      problems.push(`${file}: entry says via @/lib/${entry.via}, but the file no longer imports it`);
    }
    for (const word of entry.mustContain) {
      if (!code.includes(word)) problems.push(`${file}: guard "${word}" named in the allowlist is no longer in the code`);
    }

    const seenReads = new Set<string>();
    const seenWrites = new Set<string>();
    for (const c of calls(code)) {
      if (c.writes) {
        seenWrites.add(c.name);
        if (!entry.writes.includes(c.name)) problems.push(`${file}: writes ${c.kind === "rpc" ? "rpc " : ""}${c.name}, not listed in its entry's writes`);
      }
      if (c.kind === "from" && c.reads) {
        seenReads.add(c.name);
        const r = entry.reads[c.name];
        if (!r) { problems.push(`${file}: reads ${c.name}, not listed in its entry's reads`); continue; }
        const cols = c.columns ?? ["*"];
        if (cols.includes("*")) {
          if (pii.has(c.name)) problems.push(`${file}: select("*") on personal-data table ${c.name} — name the columns`);
          else if (r.columns !== "*") problems.push(`${file}: select("*") on ${c.name}, the entry lists columns`);
        } else if (r.columns !== "*") {
          for (const col of cols) if (!r.columns.includes(col)) problems.push(`${file}: reads ${c.name}.${col}, not in the entry's columns`);
        } else if (pii.has(c.name)) {
          problems.push(`${file}: entry allows "*" on personal-data table ${c.name}`);
        }
        /* A select right after an insert reads back the new row only — no filter needed. */
        if (!c.writes) for (const by of r.by) if (!hasFilter(c.chain, by)) problems.push(`${file}: a read of ${c.name} lost its "${by}" filter`);
        if (pii.has(c.name) && !c.writes && r.by.length === 0) problems.push(`${file}: a read of personal-data table ${c.name} has no filter in the entry`);
      }
    }
    for (const t of Object.keys(entry.reads)) if (!seenReads.has(t)) problems.push(`${file}: entry lists a read of ${t} the code no longer does (stale)`);
    for (const t of entry.writes) if (!seenWrites.has(t)) problems.push(`${file}: entry lists a write to ${t} the code no longer does (stale)`);
  }

  for (const file of Object.keys(input.allowlist)) {
    if (!needed.has(file)) problems.push(`${file}: allowlist entry but the file does not exist or no longer uses the service role (stale — remove it)`);
  }
  return problems;
}
