import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { botIdOfDirectory } from "../shared/chat";
import { bucketLabel, botsBadge } from "../shared/sidebar";
import { useApprovals } from "./approvals";
import { useBotHost, useHostWorkspaces } from "./data";
import { useT } from "./i18n/use-t";

/**
 * The Aydo row of the sidebar: it opens the Aydo screen and carries one dot for all assistants together (they wait for you,
 * failed, or are working). It names no host: the host shows one row for the plugin, and the screen has its own host picker.
 */
export function BotsNav({ theme, host, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { t } = useT();
  const local = useBotHost(null, { id: host.id, label: host.label });
  const workspaces = useHostWorkspaces(local);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const botWorkspaces = (workspaces.data ?? []).filter((workspace) => botIdOfDirectory(workspace.directory) !== null);
  const waitingApprovals = useApprovals().data?.pending ?? 0;
  // An approval waiting for the user counts like a bot waiting for input.
  const badge = waitingApprovals > 0 ? "needs_input" : botsBadge(botWorkspaces.map((workspace) => statuses[workspace.id] ?? "done"));
  const { colors } = theme;
  const color = badge === "needs_input" ? colors.statusWarning : badge === "failed" ? colors.statusDanger : badge === "running" ? colors.accent : badge === "attention" ? colors.statusSuccess : null;
  const report = (id: string, status: string | null) => setStatuses((current) => (current[id] === (status ?? "done") ? current : { ...current, [id]: status ?? "done" }));

  return (
    <View>
      <SidebarRow
        icon="Bot"
        onPress={() => openScreen({ screenId: "bots" })}
        active={currentScreen?.screenId === "bots"}
        trailing={color ? <View accessibilityLabel={waitingApprovals > 0 ? t("sidebar.approvalsWaiting", { count: waitingApprovals }) : t("sidebar.statusLabel", { status: badge ? bucketLabel(badge, t) : "" })} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} /> : null}
      />
      {botWorkspaces.map((workspace) => (
        <StatusProbe key={workspace.id} workspaceId={workspace.id} report={report} />
      ))}
    </View>
  );
}

/** Reads one bot workspace's status (a hook per workspace) and hands it up. */
function StatusProbe({ workspaceId, report }: { workspaceId: string; report(id: string, status: string | null): void }) {
  const status = useWorkspace(workspaceId, (workspace) => workspace.status);
  useEffect(() => {
    report(workspaceId, status);
    return () => report(workspaceId, null);
    // `report` only sets state.
  }, [workspaceId, status]);
  return null;
}
