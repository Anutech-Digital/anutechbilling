/**
 * Team chat slot — R-2301 (TC-08) attach files — the attach button, the files bar with progress, and the files under a message.
 *
 * R-2299 left this as `null`; the card that builds it replaces this file with its
 * ChatExtension (see ../composer-slots.ts for the props each part receives). Nothing else in
 * the page needs editing: ../extensions.ts already includes this export.
 */
import type { ChatExtension } from "../composer-slots";

export const attachmentsExtension: ChatExtension | null = null;
