/**
 * Documents — Company Document Vault.
 *
 * One secure place for business documents (GST cert, PAN, agreements,
 * licenses, HR). Category filter + search + expiry reminders. Files are
 * private (tenant-foldered storage); view/download via short-lived signed URLs.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FAB } from "@/components/ui/fab";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  useDocuments, useDeleteDocument, getDocumentSignedUrl,
  DOCUMENT_CATEGORIES, categoryLabel, expiryState,
  type DocumentRow,
} from "@/lib/queries/documents";
import { formatDate } from "@/lib/utils";
import { UploadDocumentDialog } from "@/components/features/documents/upload-document-dialog";
import { DocViewerDialog } from "@/components/features/documents/doc-viewer-dialog";
import { useConfirm } from "@/components/providers/confirm-provider";

export default function DocumentsPage() {
  const { data: docs, isLoading, error, refetch } = useDocuments();
  const del = useDeleteDocument();
  const confirm = useConfirm();
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [cat, setCat] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [viewing, setViewing] = React.useState<DocumentRow | null>(null);

  const filtered = (docs ?? []).filter((d) => {
    if (cat !== "all" && d.category !== cat) return false;
    if (search.trim()) {
      const s = search.toLowerCase();
      if (!d.title.toLowerCase().includes(s) && !(d.notes ?? "").toLowerCase().includes(s)) return false;
    }
    return true;
  });

  const expiringCount = (docs ?? []).filter((d) => ["expired", "soon"].includes(expiryState(d.expiry_date))).length;

  const catCounts: Record<string, number> = { all: docs?.length ?? 0 };
  for (const d of docs ?? []) catCounts[d.category] = (catCounts[d.category] ?? 0) + 1;
  const tabs: TabBarItem[] = [
    { id: "all", label: "All", count: docs?.length ?? 0 },
    ...DOCUMENT_CATEGORIES.filter((c) => (catCounts[c.key] ?? 0) > 0).map((c) => ({ id: c.key, label: c.label, count: catCounts[c.key] })),
  ];

  // Preview the file inside the app (modal viewer) — no popup / new tab / browser
  // "download PDFs" setting involved.
  const openDoc = (d: DocumentRow) => setViewing(d);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Catalog</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Documents</h1>
          <p className="text-sm text-ink-3 mt-1">Your company&apos;s document vault — secure, one place, with expiry reminders.</p>
        </div>
        <div className="flex gap-2 items-center">
          <div className="w-52 hidden sm:block">
            <Input aria-label="Search documents" prefix={<Icon name="search" size={14} />} placeholder="Search documents…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button variant="primary" icon="upload" onClick={() => setUploadOpen(true)} className="hidden md:inline-flex">Upload</Button>
        </div>
      </div>

      {expiringCount > 0 && (
        <Card className="mb-4 border-amber/40 bg-amber-soft/25">
          <div className="flex items-center gap-2 text-sm text-ink">
            <Icon name="alert" size={16} className="text-amber-ink" />
            <b>{expiringCount}</b> document{expiringCount === 1 ? "" : "s"} expired or expiring within 30 days — review below.
          </div>
        </Card>
      )}

      {!isLoading && (docs?.length ?? 0) > 0 && (
        <div className="mb-4"><TabBar value={cat} onChange={setCat} items={tabs} /></div>
      )}

      {isLoading ? (
        <div className="space-y-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : error ? (
        <Card>
          <EmptyState
            icon="alert"
            title="Couldn't load your documents"
            body="Something went wrong reaching the document vault. Check your connection and try again."
            action={<Button variant="primary" icon="refresh" onClick={() => void refetch()}>Retry</Button>}
          />
        </Card>
      ) : !docs || docs.length === 0 ? (
        <Card>
          <EmptyState
            icon="file"
            title="No documents yet"
            body="Upload your company's documents — GST certificate, PAN, incorporation, agreements, licenses, HR files. Everything secure in one place, with expiry reminders."
            action={<Button variant="primary" icon="upload" onClick={() => setUploadOpen(true)}>Upload first document</Button>}
          />
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState icon="search" title="No documents match" body="Try a different category or search." />
      ) : (
        <div className="space-y-2">
          {filtered.map((d) => (
            <DocRow key={d.id} doc={d} onOpen={() => openDoc(d)} onDelete={async () => { if (await confirm({ title: `Delete "${d.title}"?`, body: "This removes the file permanently.", danger: true, confirmLabel: "Delete" })) del.mutate({ id: d.id, file_path: d.file_path }); }} />
          ))}
        </div>
      )}

      <UploadDocumentDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      {viewing && (
        <DocViewerDialog
          open={!!viewing}
          onOpenChange={(o) => { if (!o) setViewing(null); }}
          title={viewing.title}
          mimeType={viewing.mime_type}
          fileName={viewing.file_name}
          filePath={viewing.file_path}
          signer={getDocumentSignedUrl}
        />
      )}
      <FAB icon="upload" label="Upload" onClick={() => setUploadOpen(true)} />
    </div>
  );
}

function DocRow({ doc, onOpen, onDelete }: { doc: DocumentRow; onOpen: () => void; onDelete: () => void }) {
  const exp = expiryState(doc.expiry_date);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-hairline bg-paper hover:border-hairline-strong transition-colors p-3">
      <button type="button" onClick={onOpen} className="flex items-center gap-3 min-w-0 flex-1 text-left">
        <div className="h-9 w-9 rounded-md bg-paper-2 flex items-center justify-center shrink-0">
          <Icon name="file" size={16} className="text-ink-3" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink truncate">{doc.title}</p>
          <p className="text-2xs text-ink-3 truncate">
            {categoryLabel(doc.category)}
            {doc.file_name ? ` · ${doc.file_name}` : ""}
            {doc.expiry_date ? ` · expires ${formatDate(doc.expiry_date)}` : ""}
          </p>
        </div>
      </button>
      {exp === "expired" && <Badge kind="danger" size="sm" dot>Expired</Badge>}
      {exp === "soon"    && <Badge kind="warning" size="sm" dot>Expiring soon</Badge>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Actions" className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2">
            <Icon name="more_h" size={18} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[10rem]">
          <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onOpen}><Icon name="eye" size={15} /> View / download</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={onDelete}><Icon name="trash" size={15} /> Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
