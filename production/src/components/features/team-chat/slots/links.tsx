/**
 * Team chat slot — R-2302 (TC-09) record links — link chips under the box and live record previews under a message.
 *
 * R-2299 left this as `null`; the card that builds it replaces this file with its
 * ChatExtension (see ../composer-slots.ts for the props each part receives). Nothing else in
 * the page needs editing: ../extensions.ts already includes this export.
 */
import type { ChatExtension } from "../composer-slots";

export const linksExtension: ChatExtension | null = null;
