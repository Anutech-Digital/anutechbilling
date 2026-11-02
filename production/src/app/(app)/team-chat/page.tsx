/**
 * Team chat — channels, direct messages and files between teammates (R-2299, G-TEAMCHAT TC-06).
 * The screen lives in components/features/team-chat; data in lib/queries/team-chat (R-2298).
 * Reached by URL for now; the sidebar row and the topbar badge are R-2300.
 */
import { TeamChatView } from "@/components/features/team-chat/team-chat-view";

export const metadata = { title: "Team chat" };

export default function TeamChatPage() {
  return <TeamChatView />;
}
