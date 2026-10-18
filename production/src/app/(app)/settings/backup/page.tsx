/**
 * Backup — owner takes a downloadable snapshot of their tenant's data. Safety
 * net before experiments / big changes (the free Supabase plan has no automatic
 * DB backups). Snapshots are tenant-scoped via SECURITY DEFINER RPCs.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { useConfirm } from "@/components/providers/confirm-provider";
import { toast } from "sonner";
import { useBackups, useCreateBackup, useDeleteBackup, useRestoreBackup, downloadBackup, autoBackupIfStale, SNAPSHOT_RETENTION } from "@/lib/queries/backups";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { IST_TZ } from "@/lib/dates/ist";
import { ResetDataCard } from "@/components/features/settings/reset-data-card";
import { LoadError } from "@/components/shared/load-error";
import { backupListState } from "./backup-list-state";
import { BackupRow, BACKUP_ROW_BUTTON } from "./backup-row";

function humanSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
function whenLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: IST_TZ });
}

export default function BackupPage() {
  const q = useBackups();
  const create = useCreateBackup();
  const del = useDeleteBackup();
  const restore = useRestoreBackup();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: me } = useCurrentUser();
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);
  const autoRan = React.useRef(false);

  // Auto restore point: once per app session, make a daily 'auto' snapshot if
  // the newest one is stale (>20h). Keeps ~15 points rolling with zero effort.
  /* R-1542: Backup is an owner-only menu row; middleware bounces other roles, and the database
     refuses them (R-1556). The page says so too instead of offering buttons that fail. */
  const notOwner = me != null && me.role !== "owner";
  React.useEffect(() => {
    if (autoRan.current || me?.role !== "owner") return;
    autoRan.current = true;
    autoBackupIfStale().then((created) => { if (created) qc.invalidateQueries({ queryKey: ["tenant_backups"] }); });
  }, [qc, me?.role]);

  const rows = q.data ?? [];
  // R-823: a failed load must say so — never fall through to "No backups yet".
  const listState = backupListState({ isLoading: q.isLoading, isError: q.isError, error: q.error, rowCount: rows.length });

  async function takeBackup() {
    try {
      const res = await create.mutateAsync(undefined);
      // Immediately hand the owner a downloaded copy of the fresh snapshot.
      setDownloadingId(res.id);
      await downloadBackup(res.id, res.created_at);
      toast.success(`Backup ban gaya — ${res.table_count} tables, ${humanSize(res.bytes)}. Copy download ho gayi.`);
    } catch {
      /* create surfaces its own error toast */
    } finally {
      setDownloadingId(null);
    }
  }

  async function onDownload(id: string, createdAt: string) {
    setDownloadingId(id);
    try { await downloadBackup(id, createdAt); }
    finally { setDownloadingId(null); }
  }

  if (notOwner) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1000px] mx-auto">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Settings</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight mb-4">Backup &amp; Restore</h1>
        <Card className="py-2">
          <EmptyState icon="lock" title="Only the workspace owner can see backups"
            body="A backup holds every table in the workspace, including salaries and connected-account tokens. Ask an owner to open this page." />
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1000px] mx-auto">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Settings</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Backup &amp; Restore</h1>
          <p className="text-sm text-ink-2 mt-1 max-w-2xl">
            Har restore point tumhare poore data ka ek copy hai — customers, leads, quotes, invoices,
            payments, expenses, sab kuch. Galat direction me chale gaye to kisi bhi purane point par
            <b> wapas jaa sakte ho</b>. Restore points <b>apne aap roz</b> bhi bante hain (last {SNAPSHOT_RETENTION} rakhe jaate hain).
          </p>
        </div>
        <Button variant="primary" icon="download" loading={create.isPending || downloadingId != null} onClick={takeBackup} className="shrink-0 self-start h-11 md:h-9">
          Take backup now
        </Button>
      </div>

      {/* What this does + honest note */}
      <Card className="p-4 mb-4 bg-paper-2/40">
        <div className="flex items-start gap-2 text-[12px] text-ink-2">
          <Icon name="info" size={14} className="text-indigo mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p><b>Backup lene par:</b> tumhare tenant ka saara data ek JSON file me download ho jaata hai (tumhare computer par). App ke andar bhi last {SNAPSHOT_RETENTION} backups save rehte hain — jab chaaho dobara download kar lo.</p>
            <p className="text-ink-3">Note: ye tumhare apne data ka copy hai (kisi aur tenant ka nahi). Restore ke liye ye file surakshit rakho — zarurat padne par isi se data wapas laaya ja sakta hai.</p>
          </div>
        </div>
      </Card>

      {listState.kind === "loading" ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : listState.kind === "owner_only" ? (
        <Card className="py-2">
          <EmptyState icon="lock" title="Only the workspace owner can see backups"
            body="A backup holds every table in the workspace, including salaries and connected-account tokens. Ask an owner to open this page." />
        </Card>
      ) : listState.kind === "error" ? (
        <LoadError what="Backups" onRetry={() => { void q.refetch(); }} />
      ) : listState.kind === "empty" ? (
        <Card className="py-2">
          <EmptyState icon="download" title="No backups yet"
            body="Take your first backup — it downloads a copy of all your data and keeps one inside the app too."
            action={<Button variant="primary" icon="download" loading={create.isPending} onClick={takeBackup}>Take backup now</Button>} />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((b) => (
            <li key={b.id}>
              <BackupRow label={b.label || "Backup"} kind={b.kind}
                meta={`${whenLabel(b.created_at)} · ${b.table_count} tables · ${humanSize(b.bytes)}`}
                actions={<>
                  <Button variant="primary" className={BACKUP_ROW_BUTTON} icon="refresh"
                    loading={restore.isPending} disabled={restore.isPending}
                    onClick={async () => {
                      if (await confirm({
                        title: "Restore to this point?",
                        body: `Tumhara data is point (${whenLabel(b.created_at)}) par wapas aa jayega — iske baad ke saare changes hat jayenge. Ghabrao mat: abhi ka data pehle ek "Before restore" point me apne aap save ho jayega, to ye undo ho sakta hai.`,
                        danger: true, confirmLabel: "Restore now",
                      })) restore.mutate(b.id);
                    }}>
                    Restore
                  </Button>
                  <Button variant="default" className={BACKUP_ROW_BUTTON} icon="download"
                    loading={downloadingId === b.id} onClick={() => onDownload(b.id, b.created_at)}>
                    Download
                  </Button>
                  <Button variant="ghost" className={BACKUP_ROW_BUTTON}
                    onClick={async () => { if (await confirm({ title: "Delete this backup?", body: "Sirf ye stored copy hategi. Pehle download ki hui file tumhare paas rahegi.", danger: true, confirmLabel: "Delete" })) del.mutate(b.id); }}>
                    Delete
                  </Button>
                </>} />
            </li>
          ))}
        </ul>
      )}

      {/* Reset lives BELOW the restore points, deliberately: an owner reads what
          can be undone before they read what can be deleted. Owner-only, and it
          renders nothing for anyone else rather than showing a button that 403s. */}
      <div className="mt-6">
        <ResetDataCard isOwner={me?.role === "owner"} />
      </div>
    </div>
  );
}
