/**
 * An in-memory stand-in for supabase-js `client.storage` — FOR TESTS ONLY (R-2337).
 *
 * list(prefix, { limit, offset }) answers like the Storage API: the immediate children of the
 * folder, sorted by name — a sub-folder as { name, id: null }, a file as { name, id, created_at }.
 * remove(paths) deletes and records. Every list prefix and every removed path is recorded.
 */
type Obj = { path: string; created_at: string };

export function fakeStorage(buckets: Record<string, Obj[]>) {
  const state = {
    removed: [] as string[],
    removeCalls: 0,
    maxBatch: 0,
    listedPrefixes: [] as { bucket: string; prefix: string }[],
    failRemove: null as string | null,
  };

  function bucket(name: string) {
    const objs = () => (buckets[name] ??= []);
    return {
      async list(prefix = "", opts: { limit?: number; offset?: number } = {}) {
        state.listedPrefixes.push({ bucket: name, prefix });
        const base = prefix ? `${prefix.replace(/\/+$/, "")}/` : "";
        const children = new Map<string, { name: string; id: string | null; created_at: string | null }>();
        for (const o of objs()) {
          if (!o.path.startsWith(base)) continue;
          const rest = o.path.slice(base.length);
          const slash = rest.indexOf("/");
          if (slash === -1) children.set(rest, { name: rest, id: `id-${o.path}`, created_at: o.created_at });
          else if (!children.has(rest.slice(0, slash))) children.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null, created_at: null });
        }
        const sorted = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const offset = opts.offset ?? 0;
        const limit = opts.limit ?? 100;
        return { data: sorted.slice(offset, offset + limit), error: null };
      },
      async remove(paths: string[]) {
        state.removeCalls += 1;
        state.maxBatch = Math.max(state.maxBatch, paths.length);
        if (state.failRemove) return { data: null, error: { message: state.failRemove } };
        const set = new Set(paths);
        const gone = objs().filter((o) => set.has(o.path));
        buckets[name] = objs().filter((o) => !set.has(o.path));
        state.removed.push(...gone.map((o) => o.path));
        return { data: gone.map((o) => ({ name: o.path })), error: null };
      },
    };
  }

  return Object.assign(state, {
    client: { from: (b: string) => bucket(b) },
    paths: (b: string) => (buckets[b] ?? []).map((o) => o.path),
  });
}
