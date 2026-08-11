/**
 * UploadDocumentDialog — add a document to the vault.
 * File + title + category + optional expiry date + notes.
 */
"use client";

import * as React from "react";

import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useUploadDocument, DOCUMENT_CATEGORIES, type DocumentCategory } from "@/lib/queries/documents";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UploadDocumentDialog({ open, onOpenChange }: Props) {
  const upload = useUploadDocument();
  const [file, setFile]         = React.useState<File | null>(null);
  const [title, setTitle]       = React.useState("");
  const [category, setCategory] = React.useState<DocumentCategory>("legal");
  const [expiry, setExpiry]     = React.useState("");
  const [notes, setNotes]       = React.useState("");

  React.useEffect(() => {
    if (!open) { setFile(null); setTitle(""); setCategory("legal"); setExpiry(""); setNotes(""); }
  }, [open]);

  const onPick = (f: File | null) => {
    setFile(f);
    if (f && !title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ""));
  };

  const canSubmit = !!file && title.trim().length >= 2 && !upload.isPending;

  const handleSubmit = async () => {
    if (!canSubmit || !file) return;
    try {
      await upload.mutateAsync({
        file, title, category,
        expiryDate: expiry || null,
        notes: notes || null,
      });
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[480px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Upload document</SheetTitle>
          <SheetDescription>
            Store a business document securely. PDF, image, Word/Excel — up to 20 MB. Set an expiry date for licenses/certificates.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          <FormField label="File" required htmlFor="doc_file">
            <input
              id="doc_file" type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.txt,.zip"
              onChange={(e) => onPick(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-amber file:px-3 file:py-1.5 file:text-paper file:font-medium hover:file:bg-amber/90"
            />
            {file && <p className="text-[11px] text-ink-3 mt-1">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</p>}
          </FormField>

          <FormField label="Title" required htmlFor="doc_title">
            <Input id="doc_title" placeholder="e.g. GST registration certificate" value={title} onChange={(e) => setTitle(e.target.value)} />
          </FormField>

          <FormField label="Category" htmlFor="doc_cat">
            <select
              id="doc_cat" value={category} onChange={(e) => setCategory(e.target.value as DocumentCategory)}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
            >
              {DOCUMENT_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </FormField>

          <FormField label="Expiry date (optional)" htmlFor="doc_expiry">
            <Input id="doc_expiry" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            <p className="text-[10px] text-ink-3 mt-1">Set for licenses/registrations that renew — you&apos;ll get an expiring-soon reminder.</p>
          </FormField>

          <FormField label="Notes" htmlFor="doc_notes">
            <textarea
              id="doc_notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional note (reference no., who to contact, …)"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber resize-y"
            />
          </FormField>
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" icon="upload" loading={upload.isPending} disabled={!canSubmit} onClick={handleSubmit}>
            Upload
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
