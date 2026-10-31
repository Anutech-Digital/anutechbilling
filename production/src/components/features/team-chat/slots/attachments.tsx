/**
 * Team chat slot — R-2301 (G-TEAMCHAT TC-08): attach files.
 *
 * - Toolbar: the "Attach files" button (opens the file picker; several at once).
 * - onFiles: files dragged or pasted into the message box.
 * - AboveInput: the files bar — each file as a chip with a preview (photos) or a file icon, its
 *   name and size, a progress bar while it uploads, the reason when it is refused, and a remove
 *   button. While anything uploads, Send is held with "Uploading N files…".
 * - MessageBelow: the files under a sent message — name + size, photo thumbnails; opening one
 *   asks for a FRESH 5-minute signed link every time (the bucket is private, R-2297).
 *
 * At most CHAT_MAX_ATTACHMENTS (5) per message. Each file is checked in the browser with the
 * same rules and words as POST /api/team-chat/upload (checkChatFile) before it is sent, so a
 * refused file says why at once; the server checks again. An uploaded file goes into
 * draft.attachments — the composer sends it with the message and clears it.
 *
 * Files that are still being checked or uploaded live in a small store per conversation (the
 * draft only holds finished uploads), shared by onFiles, the Toolbar and the files bar.
 */
"use client";

import * as React from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { useUploadChatFile } from "@/lib/queries/team-chat";
import { createClient } from "@/lib/supabase/client";
import { CHAT_MAX_ATTACHMENTS } from "@/lib/team-chat/types";
import {
  CHAT_FILE_MAX_BYTES,
  CHAT_FILE_TOO_LARGE,
  checkChatFile,
  chatFileSignedUrl,
} from "@/app/api/team-chat/upload/chat-files";
import { cn } from "@/lib/utils";
import type { ChatExtension, ComposerSlotProps, MessageSlotProps } from "../composer-slots";

/** What the file picker offers — the same list checkChatFile accepts. */
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.txt,.zip";

export const CHAT_TOO_MANY_FILES = `A message can carry up to ${CHAT_MAX_ATTACHMENTS} files. Send these first, then attach the rest.`;

/** "1.5 KB", "3.0 MB". */
export function chatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const isImage = (mime: string) => /^image\/(png|jpeg|webp)$/i.test(mime);

// ── files not yet in the draft (being checked / uploading / refused) ─────────────────────

type PendingStatus = "checking" | "queued" | "uploading" | "error";
interface PendingFile {
  id: string;
  file: File;
  status: PendingStatus;
  error?: string;
  preview?: string;
}

const pendingByChannel = new Map<string, PendingFile[]>();
const listeners = new Set<() => void>();
const EMPTY: PendingFile[] = [];
/** Photo previews of finished uploads, by stored path. */
const previews = new Map<string, string>();
let seq = 0;

function getPending(channelId: string): PendingFile[] {
  return pendingByChannel.get(channelId) ?? EMPTY;
}
function setPending(channelId: string, update: (list: PendingFile[]) => PendingFile[]) {
  const next = update(getPending(channelId));
  if (next.length === 0) pendingByChannel.delete(channelId);
  else pendingByChannel.set(channelId, next);
  listeners.forEach((l) => l());
}
function patchPending(channelId: string, id: string, patch: Partial<PendingFile>) {
  setPending(channelId, (list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
}
const isPending = (channelId: string, id: string) => getPending(channelId).some((p) => p.id === id);
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
function objectUrl(file: File): string | undefined {
  try {
    return typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
  } catch {
    return undefined;
  }
}
function revoke(url: string | undefined) {
  if (url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

async function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

/** The same check as the upload route, before anything is sent. Returns the mime or the reason. */
async function checkInBrowser(file: File): Promise<{ ok: true; mime: string } | { ok: false; error: string }> {
  if (file.size > CHAT_FILE_MAX_BYTES) return { ok: false, error: CHAT_FILE_TOO_LARGE };
  try {
    const res = checkChatFile(file.name, file.type, await readBytes(file));
    return res.ok ? { ok: true, mime: res.mime } : { ok: false, error: res.error };
  } catch {
    return { ok: false, error: "This file could not be read — pick it again." };
  }
}

/** Add picked / dropped / pasted files: refuse past the cap, check each, queue the good ones. */
function addFiles(files: File[], { channelId, draft }: Pick<ComposerSlotProps, "channelId" | "draft">) {
  let count = draft.attachments.length + getPending(channelId).filter((p) => p.status !== "error").length;
  const added: PendingFile[] = files.map((file) => {
    const id = `f${++seq}`;
    if (count >= CHAT_MAX_ATTACHMENTS) return { id, file, status: "error", error: CHAT_TOO_MANY_FILES };
    count += 1;
    return { id, file, status: "checking" };
  });
  setPending(channelId, (list) => [...list, ...added]);
  for (const p of added) {
    if (p.status !== "checking") continue;
    void checkInBrowser(p.file).then((res) => {
      if (!isPending(channelId, p.id)) return; // removed meanwhile
      if (res.ok) patchPending(channelId, p.id, { status: "queued", preview: isImage(res.mime) ? objectUrl(p.file) : undefined });
      else patchPending(channelId, p.id, { status: "error", error: res.error });
    });
  }
}

function usePending(channelId: string): PendingFile[] {
  return React.useSyncExternalStore(subscribe, () => getPending(channelId), () => EMPTY);
}

// ── composer parts ────────────────────────────────────────────────────────────────────────

function AttachButton(props: ComposerSlotProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-label="Attach files"
        title="Attach files (up to 5, 10 MB each)"
        disabled={props.sending}
        onClick={() => inputRef.current?.click()}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-2 hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/40 disabled:opacity-50"
      >
        <Paperclip size={16} aria-hidden="true" />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) addFiles(files, props);
          e.target.value = "";
        }}
      />
    </>
  );
}

function FilesBar({ channelId, draft, setDraft, setBlocking }: ComposerSlotProps) {
  const upload = useUploadChatFile();
  const pending = usePending(channelId);

  /* Start each queued upload once. */
  React.useEffect(() => {
    for (const p of pending) {
      if (p.status !== "queued") continue;
      patchPending(channelId, p.id, { status: "uploading" });
      upload
        .mutateAsync({ channelId, file: p.file })
        .then((att) => {
          if (!isPending(channelId, p.id)) { revoke(p.preview); return; } // removed while uploading
          if (p.preview) previews.set(att.path, p.preview);
          setPending(channelId, (list) => list.filter((x) => x.id !== p.id));
          setDraft((d) => ({ ...d, attachments: [...d.attachments, att] }));
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error && e.message ? e.message : "Could not upload the file — try again.";
          if (isPending(channelId, p.id)) patchPending(channelId, p.id, { status: "error", error: msg });
        });
    }
  }, [pending, channelId, upload, setDraft]);

  /* Hold Send while anything is still being checked or uploaded. */
  const busy = pending.filter((p) => p.status !== "error").length;
  React.useEffect(() => {
    setBlocking(busy > 0 ? `Uploading ${busy} file${busy === 1 ? "" : "s"}…` : null);
  }, [busy, setBlocking]);
  React.useEffect(() => () => setBlocking(null), [setBlocking]);

  /* Leaving a conversation drops its unfinished files. */
  React.useEffect(() => () => {
    getPending(channelId).forEach((p) => revoke(p.preview));
    setPending(channelId, () => []);
  }, [channelId]);

  if (draft.attachments.length === 0 && pending.length === 0) return null;

  const removeDone = (path: string) => {
    revoke(previews.get(path));
    previews.delete(path);
    setDraft((d) => ({ ...d, attachments: d.attachments.filter((a) => a.path !== path) }));
  };
  const removePending = (p: PendingFile) => {
    revoke(p.preview);
    setPending(channelId, (list) => list.filter((x) => x.id !== p.id));
  };

  return (
    <ul className="mb-2 flex flex-wrap gap-2" aria-label="Files to send">
      {draft.attachments.map((a) => (
        <FileChip key={a.path} name={a.name} size={a.size} preview={previews.get(a.path)} onRemove={() => removeDone(a.path)} />
      ))}
      {pending.map((p) => (
        <FileChip
          key={p.id}
          name={p.file.name}
          size={p.file.size}
          preview={p.preview}
          uploading={p.status !== "error"}
          error={p.status === "error" ? p.error : undefined}
          onRemove={() => removePending(p)}
        />
      ))}
    </ul>
  );
}

function FileChip({
  name, size, preview, uploading, error, onRemove,
}: { name: string; size: number; preview?: string; uploading?: boolean; error?: string; onRemove: () => void }) {
  return (
    <li
      className={cn(
        "flex w-60 max-w-full items-start gap-2 rounded-md border bg-paper-2/60 p-2",
        error ? "border-rose/50" : "border-hairline",
      )}
    >
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview, not a page image
        <img src={preview} alt={name} className="h-10 w-10 shrink-0 rounded object-cover" />
      ) : (
        <FileText size={20} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-ink" title={name}>{name}</p>
        {error ? (
          <p className="text-xs text-rose">{error}</p>
        ) : (
          <p className="text-xs text-ink-3">{chatFileSize(size)}</p>
        )}
        {uploading && !error && (
          <div role="progressbar" aria-label={`Uploading ${name}`} className="mt-1 h-1 overflow-hidden rounded bg-hairline">
            <div className="h-full w-1/2 animate-pulse rounded bg-amber" />
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
        className="shrink-0 rounded p-0.5 text-ink-3 hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/40"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

// ── under a message ───────────────────────────────────────────────────────────────────────

type SignsUrls = Parameters<typeof chatFileSignedUrl>[0];
const signedUrl = (path: string) => chatFileSignedUrl(createClient() as unknown as SignsUrls, path);

function MessageFiles({ message }: MessageSlotProps) {
  const files = message.attachments ?? [];
  if (files.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-2" aria-label="Files">
      {files.map((f) => (
        <MessageFile key={f.id} path={f.file_path} name={f.file_name} mime={f.mime} size={Number(f.size_bytes)} />
      ))}
    </ul>
  );
}

function MessageFile({ path, name, mime, size }: { path: string; name: string; mime: string; size: number }) {
  const image = isImage(mime);
  const [thumb, setThumb] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!image) return;
    let live = true;
    void signedUrl(path).then((url) => { if (live) setThumb(url); });
    return () => { live = false; };
  }, [image, path]);

  /* A fresh 5-minute link on every open. The tab opens first (inside the click) so the browser
     does not block it, then goes to the link. */
  const open = async () => {
    setError(null);
    const win = window.open("", "_blank");
    if (win) win.opener = null;
    const url = await signedUrl(path);
    if (!url) {
      win?.close();
      setError(`Could not open ${name} — try again.`);
      return;
    }
    if (win) win.location.href = url;
    else window.location.assign(url);
  };

  return (
    <li className="max-w-full">
      <button
        type="button"
        aria-label={`Open ${name} (${chatFileSize(size)})`}
        onClick={() => void open()}
        className="flex w-60 max-w-full items-center gap-2 rounded-md border border-hairline bg-paper-2/60 p-2 text-left hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/40"
      >
        {image && thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- a private signed link, not optimisable
          <img src={thumb} alt={name} className="h-12 w-12 shrink-0 rounded object-cover" />
        ) : (
          <FileText size={20} className="shrink-0 text-ink-3" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-ink" title={name}>{name}</span>
          <span className="block text-xs text-ink-3">{chatFileSize(size)}</span>
        </span>
      </button>
      {error && <p role="alert" className="mt-1 text-xs text-rose">{error}</p>}
    </li>
  );
}

export const attachmentsExtension: ChatExtension | null = {
  id: "attachments",
  Toolbar: AttachButton,
  AboveInput: FilesBar,
  MessageBelow: MessageFiles,
  onFiles: (files, props) => {
    if (files.length === 0) return false;
    addFiles(files, props);
    return true;
  },
};
