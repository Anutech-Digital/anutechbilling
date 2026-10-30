/**
 * R-2157 (G-ADS-AI, AI-01) — the database side of the agent checkpointer.
 *
 * Every call is its own withTenant transaction: app.user_id / app.tenant_id are set first,
 * and the agent_checkpoints RLS (same company AND owner / marketing,
 * migration 20261030084415) decides what is visible. tenant_id is ALSO written and filtered
 * explicitly from the verified session — never from the request — so a missing policy could
 * not leak another company's thread either. A node's LLM call never runs inside one of these
 * transactions: the graph calls the store between steps.
 */
import "server-only";
import { Prisma, withTenant, type TenantSession, type Tx } from "@/server/db";
import type { CheckpointQuery, CheckpointRow, CheckpointStore, WriteRow } from "./checkpointer";

interface RawCheckpoint {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint_type: string;
  checkpoint: Uint8Array;
  metadata_type: string;
  metadata: Uint8Array;
}

interface RawWrite {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  value_type: string;
  value: Uint8Array;
}

const bytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : Buffer.from(v as ArrayBuffer));
const buf = (v: Uint8Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

const toRow = (r: RawCheckpoint): CheckpointRow => ({
  threadId: String(r.thread_id), ns: r.checkpoint_ns, checkpointId: r.checkpoint_id,
  parentCheckpointId: r.parent_checkpoint_id, checkpointType: r.checkpoint_type,
  checkpoint: bytes(r.checkpoint), metadataType: r.metadata_type, metadata: bytes(r.metadata),
});

const toWrite = (r: RawWrite): WriteRow => ({
  threadId: String(r.thread_id), ns: r.checkpoint_ns, checkpointId: r.checkpoint_id, taskId: r.task_id,
  idx: Number(r.idx), channel: r.channel, valueType: r.value_type, value: bytes(r.value),
});

const COLS = Prisma.sql`thread_id::text as thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
  checkpoint_type, checkpoint, metadata_type, metadata`;

export function prismaCheckpointStore(session: TenantSession): CheckpointStore {
  const tenant = session.tenantId;
  const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(session, fn);

  return {
    async getCheckpoint(threadId, ns, checkpointId) {
      const rows = await run((tx) => tx.$queryRaw<RawCheckpoint[]>`
        select ${COLS} from agent_checkpoints.checkpoints
         where tenant_id = ${tenant}::uuid and thread_id = ${threadId}::uuid and checkpoint_ns = ${ns}
           ${checkpointId ? Prisma.sql`and checkpoint_id = ${checkpointId}` : Prisma.empty}
         order by checkpoint_id desc limit 1`);
      return rows[0] ? toRow(rows[0]) : null;
    },

    async listCheckpoints(q: CheckpointQuery) {
      const where = [Prisma.sql`tenant_id = ${tenant}::uuid`];
      if (q.threadId !== undefined) where.push(Prisma.sql`thread_id = ${q.threadId}::uuid`);
      if (q.ns !== undefined) where.push(Prisma.sql`checkpoint_ns = ${q.ns}`);
      if (q.checkpointId !== undefined) where.push(Prisma.sql`checkpoint_id = ${q.checkpointId}`);
      if (q.beforeId !== undefined) where.push(Prisma.sql`checkpoint_id < ${q.beforeId}`);
      const limit = q.limit === undefined ? Prisma.empty : Prisma.sql`limit ${Math.max(0, Math.min(1000, Math.trunc(q.limit)))}`;
      const rows = await run((tx) => tx.$queryRaw<RawCheckpoint[]>`
        select ${COLS} from agent_checkpoints.checkpoints
         where ${Prisma.join(where, " and ")}
         order by checkpoint_id desc ${limit}`);
      return rows.map(toRow);
    },

    async getWrites(threadId, ns, checkpointId) {
      const rows = await run((tx) => tx.$queryRaw<RawWrite[]>`
        select thread_id::text as thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value
          from agent_checkpoints.writes
         where tenant_id = ${tenant}::uuid and thread_id = ${threadId}::uuid
           and checkpoint_ns = ${ns} and checkpoint_id = ${checkpointId}
         order by task_id, idx`);
      return rows.map(toWrite);
    },

    async putCheckpoint(row) {
      await run((tx) => tx.$executeRaw`
        insert into agent_checkpoints.checkpoints
          (tenant_id, thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
           checkpoint_type, checkpoint, metadata_type, metadata)
        values (${tenant}::uuid, ${row.threadId}::uuid, ${row.ns}, ${row.checkpointId}, ${row.parentCheckpointId},
                ${row.checkpointType}, ${buf(row.checkpoint)}, ${row.metadataType}, ${buf(row.metadata)})
        on conflict (tenant_id, thread_id, checkpoint_ns, checkpoint_id) do update
          set parent_checkpoint_id = excluded.parent_checkpoint_id,
              checkpoint_type = excluded.checkpoint_type, checkpoint = excluded.checkpoint,
              metadata_type = excluded.metadata_type, metadata = excluded.metadata`);
    },

    async putWrites(rows) {
      await run(async (tx) => {
        for (const w of rows) {
          const onConflict = w.idx < 0
            ? Prisma.sql`do update set channel = excluded.channel, value_type = excluded.value_type, value = excluded.value`
            : Prisma.sql`do nothing`;
          await tx.$executeRaw`
            insert into agent_checkpoints.writes
              (tenant_id, thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value)
            values (${tenant}::uuid, ${w.threadId}::uuid, ${w.ns}, ${w.checkpointId}, ${w.taskId}, ${w.idx},
                    ${w.channel}, ${w.valueType}, ${buf(w.value)})
            on conflict (tenant_id, thread_id, checkpoint_ns, checkpoint_id, task_id, idx) ${onConflict}`;
        }
      });
    },

    async deleteThread(threadId) {
      await run(async (tx) => {
        await tx.$executeRaw`delete from agent_checkpoints.writes where tenant_id = ${tenant}::uuid and thread_id = ${threadId}::uuid`;
        await tx.$executeRaw`delete from agent_checkpoints.checkpoints where tenant_id = ${tenant}::uuid and thread_id = ${threadId}::uuid`;
      });
    },
  };
}
