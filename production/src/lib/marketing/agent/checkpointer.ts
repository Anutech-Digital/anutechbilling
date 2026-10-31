/**
 * R-2157 (G-ADS-AI, AI-01) — the marketing agent's LangGraph checkpointer, scoped to ONE company.
 *
 * Why not @langchain/langgraph-checkpoint-postgres: it opens its own pg pool and its tables
 * have no tenant. Here every read and write goes through a `CheckpointStore` that the server
 * builds from the signed-in session (prisma-store.ts → withTenant), so:
 *   - the database's RLS (same company AND owner / marketing) decides what is visible, and
 *   - no second connection pool exists beside the app's own (src/server/db boundary).
 * The saver logic itself is storage-free, so tests drive it with an in-memory store.
 *
 * Threads: thread_id = ad_plans.id (uuid). Anything else is refused before any query.
 * Same write rules as LangGraph's own savers: a regular write (idx >= 0) is never overwritten
 * on retry; a special write (error / interrupt / resume, idx < 0) replaces the old one.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";

export interface CheckpointRow {
  threadId: string;
  ns: string;
  checkpointId: string;
  parentCheckpointId: string | null;
  checkpointType: string;
  checkpoint: Uint8Array;
  metadataType: string;
  metadata: Uint8Array;
}

export interface WriteRow {
  threadId: string;
  ns: string;
  checkpointId: string;
  taskId: string;
  idx: number;
  channel: string;
  valueType: string;
  value: Uint8Array;
}

export interface CheckpointQuery {
  threadId?: string;
  ns?: string;
  checkpointId?: string;
  /** Only checkpoints with an id strictly below this one (ids are time-ordered uuid6). */
  beforeId?: string;
  limit?: number;
}

/** Storage port. Every implementation is already bound to one company (and one login). */
export interface CheckpointStore {
  /** One checkpoint, or the newest of the thread + namespace when `checkpointId` is missing. */
  getCheckpoint(threadId: string, ns: string, checkpointId?: string): Promise<CheckpointRow | null>;
  /** Newest first. */
  listCheckpoints(q: CheckpointQuery): Promise<CheckpointRow[]>;
  /** Ordered by task, then idx. */
  getWrites(threadId: string, ns: string, checkpointId: string): Promise<WriteRow[]>;
  /** Insert, or replace the same (thread, ns, id). */
  putCheckpoint(row: CheckpointRow): Promise<void>;
  /** Regular writes (idx >= 0) keep the first value; special writes (idx < 0) are replaced. */
  putWrites(rows: WriteRow[]): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9._:|-]{1,200}$/;

export class AgentThreadError extends Error {}

function threadOf(config: RunnableConfig, required: true): string;
function threadOf(config: RunnableConfig, required: false): string | undefined;
function threadOf(config: RunnableConfig, required: boolean): string | undefined {
  const t = config.configurable?.thread_id;
  if (t === undefined && !required) return undefined;
  if (typeof t !== "string" || !UUID.test(t)) {
    throw new AgentThreadError("Agent thread must be the plan id (a uuid).");
  }
  return t.toLowerCase();
}

function nsOf(config: RunnableConfig): string {
  const ns = config.configurable?.checkpoint_ns ?? "";
  if (typeof ns !== "string" || ns.length > 500) throw new AgentThreadError("Bad checkpoint namespace.");
  return ns;
}

function idOk(id: string, what: string): string {
  if (!SAFE_ID.test(id)) throw new AgentThreadError(`Bad ${what}.`);
  return id;
}

export class TenantCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly store: CheckpointStore, serde?: SerializerProtocol) {
    super(serde);
  }

  private async tuple(row: CheckpointRow, writes: WriteRow[]): Promise<CheckpointTuple> {
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      writes.map(async (w) => [w.taskId, w.channel, await this.serde.loadsTyped(w.valueType, w.value)] as CheckpointPendingWrite),
    );
    const out: CheckpointTuple = {
      config: { configurable: { thread_id: row.threadId, checkpoint_ns: row.ns, checkpoint_id: row.checkpointId } },
      checkpoint: (await this.serde.loadsTyped(row.checkpointType, row.checkpoint)) as Checkpoint,
      metadata: (await this.serde.loadsTyped(row.metadataType, row.metadata)) as CheckpointMetadata,
      pendingWrites,
    };
    if (row.parentCheckpointId) {
      out.parentConfig = { configurable: { thread_id: row.threadId, checkpoint_ns: row.ns, checkpoint_id: row.parentCheckpointId } };
    }
    return out;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = threadOf(config, true);
    const ns = nsOf(config);
    const wanted = getCheckpointId(config);
    const row = await this.store.getCheckpoint(threadId, ns, wanted ? idOk(wanted, "checkpoint id") : undefined);
    if (!row) return undefined;
    return this.tuple(row, await this.store.getWrites(threadId, ns, row.checkpointId));
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const threadId = threadOf(config, false);
    const nsRaw = config.configurable?.checkpoint_ns;
    const ns = nsRaw === undefined ? undefined : nsOf(config);
    const checkpointId = config.configurable?.checkpoint_id ? idOk(String(config.configurable.checkpoint_id), "checkpoint id") : undefined;
    const before = options?.before?.configurable?.checkpoint_id;
    const filter = options?.filter;
    const hasFilter = !!filter && Object.keys(filter).length > 0;
    const rows = await this.store.listCheckpoints({
      threadId, ns, checkpointId,
      beforeId: before ? idOk(String(before), "checkpoint id") : undefined,
      // A metadata filter is applied after decoding, so the limit is applied after it too.
      limit: hasFilter ? undefined : options?.limit,
    });
    let left = options?.limit;
    for (const row of rows) {
      if (left !== undefined && left <= 0) return;
      const t = await this.tuple(row, await this.store.getWrites(row.threadId, row.ns, row.checkpointId));
      const meta = (t.metadata ?? {}) as Record<string, unknown>;
      if (hasFilter && !Object.entries(filter!).every(([k, v]) => meta[k] === v)) continue;
      if (left !== undefined) left -= 1;
      yield t;
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _newVersions: ChannelVersions): Promise<RunnableConfig> {
    const threadId = threadOf(config, true);
    const ns = nsOf(config);
    const parent = config.configurable?.checkpoint_id;
    const [[checkpointType, bytes], [metadataType, meta]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    await this.store.putCheckpoint({
      threadId, ns,
      checkpointId: idOk(checkpoint.id, "checkpoint id"),
      parentCheckpointId: parent ? idOk(String(parent), "parent checkpoint id") : null,
      checkpointType, checkpoint: bytes, metadataType, metadata: meta,
    });
    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = threadOf(config, true);
    const ns = nsOf(config);
    const checkpointId = config.configurable?.checkpoint_id;
    if (!checkpointId) throw new AgentThreadError("Writes need a checkpoint id.");
    const rows = await Promise.all(writes.map(async ([channel, value], i): Promise<WriteRow> => {
      const [valueType, bytes] = await this.serde.dumpsTyped(value);
      return {
        threadId, ns, checkpointId: idOk(String(checkpointId), "checkpoint id"), taskId: idOk(taskId, "task id"),
        idx: WRITES_IDX_MAP[channel] ?? i, channel, valueType, value: bytes,
      };
    }));
    if (rows.length) await this.store.putWrites(rows);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.store.deleteThread(threadOf({ configurable: { thread_id: threadId } }, true));
  }
}

/** In-memory store with the same rules as the database one — for tests and dry runs. */
export function memoryCheckpointStore(): CheckpointStore & { rows: CheckpointRow[]; writes: WriteRow[] } {
  const rows: CheckpointRow[] = [];
  const writes: WriteRow[] = [];
  const desc = (a: CheckpointRow, b: CheckpointRow) => (a.checkpointId < b.checkpointId ? 1 : a.checkpointId > b.checkpointId ? -1 : 0);
  return {
    rows, writes,
    async getCheckpoint(threadId, ns, checkpointId) {
      const mine = rows.filter((r) => r.threadId === threadId && r.ns === ns && (!checkpointId || r.checkpointId === checkpointId)).sort(desc);
      return mine[0] ?? null;
    },
    async listCheckpoints(q) {
      const out = rows.filter((r) => (q.threadId === undefined || r.threadId === q.threadId)
        && (q.ns === undefined || r.ns === q.ns)
        && (q.checkpointId === undefined || r.checkpointId === q.checkpointId)
        && (q.beforeId === undefined || r.checkpointId < q.beforeId)).sort(desc);
      return q.limit === undefined ? out : out.slice(0, q.limit);
    },
    async getWrites(threadId, ns, checkpointId) {
      return writes.filter((w) => w.threadId === threadId && w.ns === ns && w.checkpointId === checkpointId)
        .sort((a, b) => (a.taskId === b.taskId ? a.idx - b.idx : a.taskId < b.taskId ? -1 : 1));
    },
    async putCheckpoint(row) {
      const i = rows.findIndex((r) => r.threadId === row.threadId && r.ns === row.ns && r.checkpointId === row.checkpointId);
      if (i >= 0) rows[i] = row; else rows.push(row);
    },
    async putWrites(next) {
      for (const w of next) {
        const i = writes.findIndex((x) => x.threadId === w.threadId && x.ns === w.ns && x.checkpointId === w.checkpointId && x.taskId === w.taskId && x.idx === w.idx);
        if (i < 0) writes.push(w); else if (w.idx < 0) writes[i] = w;
      }
    },
    async deleteThread(threadId) {
      for (const list of [rows, writes] as Array<Array<{ threadId: string }>>) {
        for (let i = list.length - 1; i >= 0; i--) if (list[i].threadId === threadId) list.splice(i, 1);
      }
    },
  };
}
