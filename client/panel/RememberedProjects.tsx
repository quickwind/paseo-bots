import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { projectGrantListRpc, projectGrantRevokeRpc } from "../../shared/rpc";
import { errorText } from "../native";
import { useT } from "../i18n/use-t";
import { CardNote } from "./controls";

/** The projects a team (or a bot with no team) may create workspaces in without asking, each with a Remove. */
export function RememberedProjects({ colors, scope, title }: { colors: PluginTheme["colors"]; scope: { teamId: string } | { botId: string }; title: string }) {
  const { t } = useT();
  const list = useRpc(projectGrantListRpc);
  const revoke = useRpc(projectGrantRevokeRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["aydo", "projects", "teamId" in scope ? scope.teamId : scope.botId];
  const projects = useQuery({ queryKey: key, queryFn: () => list(scope) });
  const items = projects.data?.projects ?? [];
  return (
    <SettingsSection title={title} info={t("panel.projectsInfo")}>
      <SettingsCard>
        {projects.isLoading ? <CardNote colors={colors} text={t("settings.loading")} /> : null}
        {!projects.isLoading && items.length === 0 ? <CardNote colors={colors} text={t("panel.noneYetDot")} /> : null}
        {items.map((project) => (
          <SettingsAction
            key={project.projectId}
            label={project.projectName}
            hint={t("panel.allowedOn", { date: new Date(project.grantedAt).toLocaleDateString() })}
            actionLabel={t("attachment.remove")}
            onPress={() =>
              void revoke({ ...scope, projectId: project.projectId })
                .then(() => queryClient.invalidateQueries({ queryKey: key }))
                .catch((error: unknown) => toast.error(errorText(error)))
            }
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
