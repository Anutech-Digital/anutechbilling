/**
 * POST /api/team-chat/upload   (signed-in staff)   — R-2297, G-TEAMCHAT TC-04
 *
 * Stores ONE file for a team chat message and returns its path. The message itself (and its
 * chat_attachments row) is written afterwards by chat_post_message (R-2295) with this path.
 *
 * Body: multipart/form-data — channelId (uuid), file.
 * Answer: { ok, path, fileName, mime, sizeBytes }.
 *
 * Checks, all BEFORE anything is stored:
 *   - staff only (partner_agent / personal have no team chat);
 *   - the body is read with a 10 MB cap (never the whole body first);
 *   - the caller is a member of the channel (is_chat_member);
 *   - type from the Company Documents list, by extension; markup never (storage-safety);
 *   - the first bytes must be what the type says (a fake PDF is refused).
 * The upload goes through the CALLER's own session, so the storage rule
 * (public.storage_object_allowed, chat branch) checks membership again and records the caller
 * as the file's owner — which is what lets the uploader delete it later.
 * R-2332: the service role is used for ONE thing — a single-use upload ticket for the exact path
 * (public.chat_upload_ticket_open / _close), opened only after every check above. The storage rule
 * refuses a chat-folder upload without it, so these checks cannot be skipped by uploading
 * straight to storage. The bytes themselves still go up with the caller's session.
 * Files are opened through 5-minute signed URLs (chat-files.ts), never a public URL.
 */
import { withRoute, RouteError } from "@/lib/api/with-route";
import { createAdminClient } from "@/lib/supabase/server";
import { logDbError } from "@/lib/errors/db-error";
import { BodyTooLargeError, readBytesCapped } from "@/server/postgrest/body-limit";
import type { UserRole } from "@/lib/auth/roles";
import {
  CHAT_FILE_BUCKET,
  CHAT_FILE_MAX_BYTES,
  CHAT_FILE_TOO_LARGE,
  chatFilePath,
  checkChatFile,
} from "./chat-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every staff role. partner_agent (external) and personal (free personal workspace) are out. */
const CHAT_ROLES: readonly UserRole[] = [
  "owner", "manager", "sales_senior", "sales", "billing", "delivery", "accountant", "support", "marketing",
];
/** Room for the multipart boundaries and the channelId field around the file. */
const MULTIPART_SLACK_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const POST = withRoute(
  {
    route: "api/team-chat/upload",
    roles: CHAT_ROLES,
    roleHint: "Team chat is only for staff logins of this workspace.",
  },
  async ({ req, supabase, tenantId, user }) => {
    let form: FormData;
    try {
      const raw = await readBytesCapped(req, CHAT_FILE_MAX_BYTES + MULTIPART_SLACK_BYTES);
      form = await new Response(raw, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
    } catch (e) {
      if (e instanceof BodyTooLargeError) throw new RouteError(413, CHAT_FILE_TOO_LARGE);
      throw new RouteError(400, "Could not read the upload — refresh the page and try again.");
    }

    const channelId = String(form.get("channelId") ?? "").trim().toLowerCase();
    if (!UUID.test(channelId)) throw new RouteError(400, "Open a conversation first, then attach the file.");
    const file = form.get("file");
    if (!file || typeof file === "string") throw new RouteError(400, "Choose a file to share.");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkChatFile(file.name, file.type, bytes);
    if (!check.ok) throw new RouteError(check.status, check.error);

    const { data: member, error: memberErr } = await supabase.rpc("is_chat_member", { p_channel_id: channelId });
    if (memberErr) {
      logDbError("team-chat:upload:member", memberErr);
      throw new RouteError(500, "Could not check this conversation. Try again.");
    }
    if (member !== true) {
      throw new RouteError(403, "You are not a member of this conversation, so you cannot share a file here. Ask its admin to add you.");
    }

    const path = chatFilePath(tenantId, channelId, file.name);

    /* R-2332: the storage rule takes a chat upload only with a ticket for its exact path, and only
       this route (service role) can open one — so a browser cannot push other bytes, or a bigger
       file, straight into a chat folder. Single-use: closed as soon as the upload is over. */
    const admin = createAdminClient();
    const { error: ticketErr } = await admin.rpc("chat_upload_ticket_open", { p_user_id: user.id, p_path: path });
    if (ticketErr) {
      logDbError("team-chat:upload:ticket", ticketErr);
      throw new RouteError(500, "Could not store the file. Try again.");
    }
    let upErr: unknown = null;
    try {
      ({ error: upErr } = await supabase.storage
        .from(CHAT_FILE_BUCKET)
        .upload(path, Buffer.from(bytes), { upsert: false, contentType: check.mime }));
    } finally {
      const { error: closeErr } = await admin.rpc("chat_upload_ticket_close", { p_path: path });
      if (closeErr) logDbError("team-chat:upload:ticket-close", closeErr);
    }
    if (upErr) {
      /* Storage's own text names the bucket and the tenant-foldered path — log only (R-880). */
      logDbError("team-chat:upload", upErr);
      throw new RouteError(500, "Could not store the file. Try again.");
    }

    return {
      path,
      fileName: file.name.slice(0, 255) || "file",
      mime: check.mime,
      sizeBytes: bytes.length,
    };
  },
);
