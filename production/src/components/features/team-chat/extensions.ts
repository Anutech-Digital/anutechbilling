/**
 * R-2299 (G-TEAMCHAT TC-06) — every Team chat plug-in, in the order their parts are drawn.
 * Each card edits ONLY its own file in ./slots — this list already names all four.
 */
import type { ChatExtension } from "./composer-slots";
import { attachmentsExtension } from "./slots/attachments";
import { linksExtension } from "./slots/links";
import { mentionsExtension } from "./slots/mentions";
import { postTypeExtension } from "./slots/post-type";

export const CHAT_EXTENSIONS: readonly ChatExtension[] = [
  postTypeExtension,
  attachmentsExtension,
  linksExtension,
  mentionsExtension,
].filter((e): e is ChatExtension => e !== null);
